'use strict';

const {
  SHEET_ID,
  MEMBER_SHEET, POINTS_SHEET, COUPON_SHEET, REFERRAL_SHEET, FOLLOW_SHEET, ORDER_SHEET,
  lineClient,
} = require('./config');

const ANOMALY_SHEET = '異常紀錄';

// ── 會員制度常數 ──────────────────────────────────────────────────────────────
const TIER_THRESHOLDS = [
  { name: '白金', min: 12000 },
  { name: '金卡', min: 6000 },
  { name: '銀卡', min: 3000 },
  { name: '一般', min: 0 },
];
const POINTS_DIVISOR = { '一般': 300, '銀卡': 200, '金卡': 100, '白金': 50 };
const BIRTHDAY_GIFTS = {
  '一般': [{ amount: 30, qty: 1 }],
  '銀卡': [{ amount: 50, qty: 1 }],
  '金卡': [{ amount: 50, qty: 2 }],
  '白金': [{ amount: 50, qty: 4 }],
};

// ── 純計算函式 ────────────────────────────────────────────────────────────────
function calcTier(yearlySpend) {
  for (const t of TIER_THRESHOLDS) if (yearlySpend >= t.min) return t.name;
  return '一般';
}
function calcPoints(tier, amount) {
  const div = POINTS_DIVISOR[tier] || 300;
  return Math.floor(amount / div);
}
function calcPointsExpiry(earnDate) {
  const m = new Date(earnDate).getMonth() + 1;
  const y = new Date(earnDate).getFullYear();
  return m <= 6 ? `${y}-12-31` : `${y + 1}-06-30`;
}
function generateCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function generateCouponCode() { return 'C' + generateCode(7); }
function generateReferralCode() { return generateCode(6); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

// ── Sheet 初始化 ──────────────────────────────────────────────────────────────
async function ensureMemberSheet(sheets) {
  const headers = ['userId','displayName','joinDate','birthday','referralCode','referredByCode','referralCodeSetDate','currentYear','yearlySpend','tier','points','lastUpdated','name','phone'];
  try { await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A1` }); }
  catch {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, resource: { requests: [{ addSheet: { properties: { title: MEMBER_SHEET } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A1`, valueInputOption: 'RAW', resource: { values: [headers] } });
  }
}
async function ensurePointsSheet(sheets) {
  const headers = ['pointId','date','userId','displayName','orderId','points','expiryDate','status'];
  try { await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${POINTS_SHEET}!A1` }); }
  catch {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, resource: { requests: [{ addSheet: { properties: { title: POINTS_SHEET } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${POINTS_SHEET}!A1`, valueInputOption: 'RAW', resource: { values: [headers] } });
  }
}
async function ensureCouponSheet(sheets) {
  const headers = ['couponCode','userId','displayName','type','amount','issueDate','expiryDate','status','usedOrderId'];
  try { await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!A1` }); }
  catch {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, resource: { requests: [{ addSheet: { properties: { title: COUPON_SHEET } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!A1`, valueInputOption: 'RAW', resource: { values: [headers] } });
  }
}
async function ensureFollowSheet(sheets) {
  const headers = ['userId', 'displayName', '加入日'];
  try { await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${FOLLOW_SHEET}!A1` }); }
  catch {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, resource: { requests: [{ addSheet: { properties: { title: FOLLOW_SHEET } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${FOLLOW_SHEET}!A1`, valueInputOption: 'RAW', resource: { values: [headers] } });
  }
}
async function ensureReferralSheet(sheets) {
  const headers = ['inviterUserId','inviteeUserId','inviteCode','bindDate','orderDeadline','qualifyingOrderId','status'];
  try { await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!A1` }); }
  catch {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, resource: { requests: [{ addSheet: { properties: { title: REFERRAL_SHEET } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!A1`, valueInputOption: 'RAW', resource: { values: [headers] } });
  }
}

async function recordFollowEvent(sheets, userId, displayName) {
  await ensureFollowSheet(sheets);
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${FOLLOW_SHEET}!A:A` });
  const rows = resp.data.values || [];
  if (rows.some((r, i) => i > 0 && r[0] === userId)) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${FOLLOW_SHEET}!A1`,
    valueInputOption: 'RAW', resource: { values: [[userId, displayName, todayStr()]] },
  });
}

// ── 取得會員資料（找不到回傳 null）────────────────────────────────────────────
async function getMember(sheets, userId) {
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A:N` });
  const rows = resp.data.values || [];
  const idx = rows.findIndex((r, i) => i > 0 && r[0] === userId);
  if (idx === -1) return null;
  const r = rows[idx];
  return {
    rowIndex: idx + 1,
    userId: r[0], displayName: r[1], joinDate: r[2], birthday: r[3],
    referralCode: r[4], referredByCode: r[5], referralCodeSetDate: r[6],
    currentYear: parseInt(r[7]) || new Date().getFullYear(),
    yearlySpend: parseFloat(r[8]) || 0,
    tier: r[9] || '一般', points: parseInt(r[10]) || 0, lastUpdated: r[11],
    name: r[12] || '', phone: r[13] || '',
  };
}

// ── 建立新會員 ────────────────────────────────────────────────────────────────
async function createMember(sheets, userId, displayName, { name = '', phone = '', birthday = '', referredByCode = '' } = {}) {
  await ensureMemberSheet(sheets);
  const refCode = generateReferralCode();
  const today = todayStr();
  const year = new Date().getFullYear();
  const row = [userId, displayName, today, birthday, refCode, referredByCode, referredByCode ? today : '', year, 0, '一般', 0, today, name, phone];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A1`,
    valueInputOption: 'RAW', resource: { values: [row] },
  });
  return { userId, displayName, joinDate: today, birthday, referralCode: refCode, referredByCode, referralCodeSetDate: referredByCode ? today : '', currentYear: year, yearlySpend: 0, tier: '一般', points: 0, name, phone };
}

// ── 取得或建立會員 ─────────────────────────────────────────────────────────────
async function getOrCreateMember(sheets, userId, displayName) {
  await ensureMemberSheet(sheets);
  let member = await getMember(sheets, userId);
  if (!member) member = await createMember(sheets, userId, displayName || '');
  const thisYear = new Date().getFullYear();
  if (member.currentYear !== thisYear) {
    member = await resetMemberYear(sheets, member, thisYear);
  }
  return member;
}

// ── 跨年重置 ──────────────────────────────────────────────────────────────────
async function resetMemberYear(sheets, member, year) {
  const newTier = '一般';
  const today = todayStr();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${MEMBER_SHEET}!H${member.rowIndex}:L${member.rowIndex}`,
    valueInputOption: 'RAW',
    resource: { values: [[year, 0, newTier, member.points, today]] },
  });
  return { ...member, currentYear: year, yearlySpend: 0, tier: newTier };
}

// ── 更新會員欄位 ──────────────────────────────────────────────────────────────
async function updateMemberFields(sheets, rowIndex, fields) {
  for (const f of fields) {
    const col = String.fromCharCode(64 + f.col);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${MEMBER_SHEET}!${col}${rowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [[f.value]] },
    });
  }
}

// ── 發行優惠券 ────────────────────────────────────────────────────────────────
async function issueCoupons(sheets, userId, displayName, type, amount, qty, expiryDate) {
  await ensureCouponSheet(sheets);
  const today = todayStr();
  const rows = [];
  for (let i = 0; i < qty; i++) {
    const code = generateCouponCode();
    rows.push([code, userId, displayName || '', type, amount, today, expiryDate, 'unused', '']);
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!A1`,
    valueInputOption: 'RAW', resource: { values: rows },
  });
  return rows.map(r => r[0]);
}

// ── 取得可用優惠券（未使用且未過期）─────────────────────────────────────────
async function getActiveCoupons(sheets, userId) {
  await ensureCouponSheet(sheets);
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!A:I` });
  const rows = resp.data.values || [];
  const today = todayStr();
  return rows.slice(1)
    .map((r, i) => ({ rowIndex: i + 2, couponCode: r[0], userId: r[1], displayName: r[2], type: r[3], amount: parseInt(r[4]) || 0, issueDate: r[5], expiryDate: r[6], status: r[7], usedOrderId: r[8] }))
    .filter(c => c.userId === userId && c.status === 'unused' && c.expiryDate >= today);
}

// ── 核銷優惠券 ────────────────────────────────────────────────────────────────
async function markCouponUsed(sheets, couponCode, orderId) {
  if (process.env.SIMULATE_FAIL === 'coupon') throw new Error('[TEST] 模擬券核銷失敗');
  if (!couponCode) return;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!A:I` });
  const rows = resp.data.values || [];
  const rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === couponCode);
  if (rowIdx < 1) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${COUPON_SHEET}!H${rowIdx + 1}:I${rowIdx + 1}`,
    valueInputOption: 'RAW',
    resource: { values: [['used', orderId]] },
  });
}

// ── 取得會員點數明細（有效點數）──────────────────────────────────────────────
async function getActivePoints(sheets, userId) {
  await ensurePointsSheet(sheets);
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${POINTS_SHEET}!A:H` });
  const rows = resp.data.values || [];
  const today = todayStr();
  return rows.slice(1)
    .map((r, i) => ({ rowIndex: i + 2, pointId: r[0], date: r[1], userId: r[2], displayName: r[3], orderId: r[4], points: parseInt(r[5]) || 0, expiryDate: r[6], status: r[7] }))
    .filter(p => p.userId === userId && p.status === 'active' && p.expiryDate >= today);
}

// ── 扣除點數（直接更新會員表 K 欄）──────────────────────────────────────────
async function deductMemberPoints(sheets, userId, pointsToDeduct) {
  if (process.env.SIMULATE_FAIL === 'points') throw new Error('[TEST] 模擬扣點失敗');
  if (!pointsToDeduct || pointsToDeduct <= 0) return;
  const member = await getMember(sheets, userId);
  if (!member) return;
  const newPoints = Math.max(0, (member.points || 0) - pointsToDeduct);
  const today = todayStr();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${MEMBER_SHEET}!K${member.rowIndex}:L${member.rowIndex}`,
    valueInputOption: 'RAW',
    resource: { values: [[newPoints, today]] },
  });
}

// ── 訂單完成：計算點數 + 更新年度消費 + 等級 ───────────────────────────────────
async function processOrderCompletion(sheets, userId, displayName, orderId, orderAmountTwd) {
  const member = await getMember(sheets, userId);
  if (!member) return;

  try {
    const pCheck = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${POINTS_SHEET}!A:E` });
    const pRows = pCheck.data.values || [];
    const alreadyRecorded = pRows.slice(1).some(r => r[4] === orderId);
    if (alreadyRecorded) {
      console.warn('[processOrderCompletion] orderId already processed, skipping:', orderId);
      return;
    }
  } catch (e) { console.warn('[processOrderCompletion] dup check error:', e.message); }

  const pts = calcPoints(member.tier, orderAmountTwd);
  const today = todayStr();
  const expiry = calcPointsExpiry(today);
  const newSpend = member.yearlySpend + orderAmountTwd;
  const newTier = calcTier(newSpend);
  const newPoints = member.points + pts;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${MEMBER_SHEET}!I${member.rowIndex}:L${member.rowIndex}`,
    valueInputOption: 'RAW',
    resource: { values: [[newSpend, newTier, newPoints, today]] },
  });

  if (pts > 0) {
    await ensurePointsSheet(sheets);
    const pointId = 'P' + Date.now().toString(36).toUpperCase();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${POINTS_SHEET}!A1`,
      valueInputOption: 'RAW',
      resource: { values: [[pointId, today, userId, displayName || '', orderId, pts, expiry, 'active']] },
    });
  }

  const tierChanged = newTier !== member.tier;
  const TIER_RATE = { '一般': '每NT$300得1點', '銀卡': '每NT$200得1點', '金卡': '每NT$100得1點', '白金': '每NT$50得1點' };
  const TIER_BDAY = { '一般': 'NT$30×1張', '銀卡': 'NT$50×1張', '金卡': 'NT$50×2張', '白金': 'NT$50×4張' };
  let notifyText = `🌸 訂單已完成，感謝您的購買！\n`;
  if (pts > 0) {
    notifyText += `\n💎 本次獲得 ${pts} 點\n   有效至：${expiry}\n   點數將於7天內正式入帳\n`;
  }
  notifyText += `\n📊 目前累積：${newPoints} 點 ｜ ${newTier}`;
  if (tierChanged) {
    notifyText += `\n\n🎉 恭喜升等為【${newTier}】！\n✨ 新等級專屬權益：\n・點數回饋：${TIER_RATE[newTier] || ''}\n・生日禮：${TIER_BDAY[newTier] || ''}`;
  }

  try {
    await lineClient.pushMessage(userId, { type: 'text', text: notifyText });
  } catch(e) { console.error('[member notify error]', e.message); }

  await processReferralReward(sheets, userId, orderId).catch(e => console.error('[referral error]', e.message));

  return { pts, newTier, newPoints, tierChanged };
}

// ── 退單：撤銷點數 + 退還折抵點數 + 回扣年度消費 + 重算等級 + 收回邀請獎勵 ──
async function processOrderReturn(sheets, orderId) {
  const oResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:P` });
  const oRows = oResp.data.values || [];
  const oRow = oRows.find((r, i) => i > 0 && r[0] === orderId);
  const returnUserId       = oRow ? (oRow[2]  || '') : '';
  const returnAmount       = oRow ? (parseFloat(oRow[14]) || parseFloat(oRow[4]) || 0) : 0;
  const pointsUsedAtOrder  = oRow ? (parseInt(oRow[11])  || 0) : 0;

  const pResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${POINTS_SHEET}!A:H` });
  const pRows = pResp.data.values || [];
  const pIdx = pRows.findIndex((r, i) => i > 0 && r[4] === orderId && r[7] === 'active');
  const ptsEarned  = pIdx > 0 ? (parseInt(pRows[pIdx][5]) || 0) : 0;
  const pointUserId = pIdx > 0 ? (pRows[pIdx][2] || '') : '';
  const userId = returnUserId || pointUserId;

  if (pIdx > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${POINTS_SHEET}!H${pIdx + 1}`,
      valueInputOption: 'RAW', resource: { values: [['cancelled']] },
    });
  }

  let newPoints = 0, newTier = '', tierChanged = false;
  if (userId) {
    const member = await getMember(sheets, userId);
    if (member) {
      newPoints  = Math.max(0, (member.points || 0) - ptsEarned + pointsUsedAtOrder);
      const newSpend = Math.max(0, (member.yearlySpend || 0) - returnAmount);
      newTier    = calcTier(newSpend);
      tierChanged = newTier !== member.tier;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${MEMBER_SHEET}!I${member.rowIndex}:L${member.rowIndex}`,
        valueInputOption: 'RAW',
        resource: { values: [[newSpend, newTier, newPoints, todayStr()]] },
      });
    }
  }

  let referralRevoked = false;
  try {
    await ensureReferralSheet(sheets);
    const refResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!A:G` });
    const refRows = refResp.data.values || [];
    for (let i = 1; i < refRows.length; i++) {
      const r = refRows[i];
      if (r[5] !== orderId || r[6] !== 'completed') continue;
      const inviterUserId = r[0], inviteeUserId = r[1];
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!G${i + 1}`,
        valueInputOption: 'RAW', resource: { values: [['returned']] },
      });
      const cResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!A:I` });
      const cRows = cResp.data.values || [];
      for (let j = 1; j < cRows.length; j++) {
        const c = cRows[j];
        if ((c[1] === inviterUserId || c[1] === inviteeUserId) && c[3] === '邀請獎勵' && c[7] === 'unused') {
          await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!H${j + 1}`,
            valueInputOption: 'RAW', resource: { values: [['cancelled']] },
          });
          referralRevoked = true;
        }
      }
      break;
    }
  } catch(e) { console.error('[return referral revoke]', e.message); }

  if (userId) {
    try {
      let msg = `📦 訂單 ${orderId} 已辦理退單。\n`;
      if (ptsEarned > 0)         msg += `\n💎 已撤銷本次獲得的 ${ptsEarned} 點`;
      if (pointsUsedAtOrder > 0) msg += `\n💎 已退還結帳折抵的 ${pointsUsedAtOrder} 點`;
      msg += `\n📊 目前剩餘點數：${newPoints} 點`;
      msg += `\n🏅 會員等級：${newTier}`;
      if (tierChanged)      msg += `\n（等級調整為 ${newTier}）`;
      if (referralRevoked)  msg += `\n\n⚠️ 邀請獎勵優惠券已一併收回`;
      msg += `\n\n如有疑問請聯繫客服 🌸`;
      await lineClient.pushMessage(userId, { type: 'text', text: msg });
    } catch(e) { console.error('[return notify error]', e.message); }
  }
  return { ptsEarned, pointsUsedAtOrder, referralRevoked };
}

// ── 邀請獎勵處理（訂單完成時呼叫）────────────────────────────────────────────
async function processReferralReward(sheets, inviteeUserId, orderId) {
  await ensureReferralSheet(sheets);
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!A:G` });
  const rows = resp.data.values || [];
  const today = todayStr();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const [inviterUserId, inviteeId, , , orderDeadline] = r;
    const status = r[6];
    if (inviteeId !== inviteeUserId) continue;
    if (status !== 'pending') continue;
    if (today > orderDeadline) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!G${i + 1}`,
        valueInputOption: 'RAW', resource: { values: [['expired']] },
      });
      continue;
    }
    const expiry = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    const inviteeMember = await getMember(sheets, inviteeUserId);
    const inviterMember = await getMember(sheets, inviterUserId);
    await issueCoupons(sheets, inviteeUserId, inviteeMember ? inviteeMember.displayName : '', '邀請獎勵', 50, 2, expiry);
    await issueCoupons(sheets, inviterUserId, inviterMember ? inviterMember.displayName : '', '邀請獎勵', 50, 2, expiry);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!F${i + 1}:G${i + 1}`,
      valueInputOption: 'RAW', resource: { values: [[orderId, 'rewarded']] },
    });

    const msg = `🎁 邀請獎勵！\n好友訂單已完成，雙方各獲得 NT$50 折扣碼 × 2 張！\n請至會員中心查看。`;
    await lineClient.pushMessage(inviteeUserId, { type: 'text', text: msg }).catch(() => {});
    await lineClient.pushMessage(inviterUserId, { type: 'text', text: msg }).catch(() => {});
  }
}

// ── 綁定邀請碼 ────────────────────────────────────────────────────────────────
async function bindReferralCode(sheets, inviteeUserId, inviteCode) {
  const memberResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A:F` });
  const mRows = memberResp.data.values || [];
  const inviterRow = mRows.find((r, i) => i > 0 && r[4] === inviteCode);
  if (!inviterRow) return { ok: false, error: '無效的邀請碼' };
  if (inviterRow[0] === inviteeUserId) return { ok: false, error: '不能使用自己的邀請碼' };

  const inviteeMember = await getMember(sheets, inviteeUserId);
  if (!inviteeMember) return { ok: false, error: '找不到會員資料' };
  const joinDate = new Date(inviteeMember.joinDate);
  const monthAgo = new Date(Date.now() - 30 * 86400000);
  if (joinDate < monthAgo) return { ok: false, error: '入會超過 1 個月，無法補填邀請碼' };
  if (inviteeMember.referredByCode) return { ok: false, error: '已綁定邀請碼' };

  const today = todayStr();
  const orderDeadline = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${MEMBER_SHEET}!F${inviteeMember.rowIndex}:G${inviteeMember.rowIndex}`,
    valueInputOption: 'RAW',
    resource: { values: [[inviteCode, today]] },
  });

  await ensureReferralSheet(sheets);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!A1`,
    valueInputOption: 'RAW',
    resource: { values: [[inviterRow[0], inviteeUserId, inviteCode, today, orderDeadline, '', 'pending']] },
  });

  return { ok: true, inviterName: inviterRow[1] };
}

// ── 訂單異常標記（A）與金額回原價（B）────────────────────────────────────────
async function markOrderAnomaly(sheets, rowNum) {
  if (!rowNum) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${ORDER_SHEET}!K${rowNum}`,
    valueInputOption: 'RAW',
    resource: { values: [['⚠️折扣異常-待確認']] },
  });
}

async function revertOrderAmount(sheets, rowNum, totalTwd) {
  if (!rowNum) return;
  // L=pointsUsed→0, M=couponCode→'', N=discountTotal→0, O=finalAmount→totalTwd（原價）
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${ORDER_SHEET}!L${rowNum}:O${rowNum}`,
    valueInputOption: 'RAW',
    resource: { values: [[0, '', 0, totalTwd]] },
  });
}

// ── 異常紀錄 Sheet ────────────────────────────────────────────────────────────
async function ensureAnomalySheet(sheets) {
  const headers = ['時間戳', 'userId', 'orderId', '訂單已寫入', '券核銷狀態', '扣點狀態', '失敗步驟', '錯誤訊息'];
  try { await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ANOMALY_SHEET}!A1` }); }
  catch {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, resource: { requests: [{ addSheet: { properties: { title: ANOMALY_SHEET } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${ANOMALY_SHEET}!A1`, valueInputOption: 'RAW', resource: { values: [headers] } });
  }
}

async function logDiscountAnomaly(sheets, { userId, orderId, couponStatus, pointsStatus, failedStep, errorMessage }) {
  await ensureAnomalySheet(sheets);
  const ts = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${ANOMALY_SHEET}!A1`,
    valueInputOption: 'RAW',
    resource: { values: [[ts, userId, orderId, '✅已寫入', couponStatus, pointsStatus, failedStep, errorMessage]] },
  });
}

module.exports = {
  BIRTHDAY_GIFTS,
  todayStr, calcTier,
  ensureMemberSheet, ensurePointsSheet, ensureCouponSheet, ensureFollowSheet, ensureReferralSheet,
  recordFollowEvent,
  getMember, createMember, getOrCreateMember, resetMemberYear, updateMemberFields,
  issueCoupons, getActiveCoupons, markCouponUsed,
  getActivePoints, deductMemberPoints,
  processOrderCompletion, processOrderReturn, processReferralReward, bindReferralCode,
  markOrderAnomaly, revertOrderAmount, logDiscountAnomaly,
};
