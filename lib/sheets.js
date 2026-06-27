'use strict';

const {
  getSheetsClient, SHEET_ID,
  CART_SHEET, ORDER_SHEET, ZOZO_SHEET, SETTINGS_SHEET, BOT_LOG_SHEET,
} = require('./config');
const { translateColorWithJp } = require('./colors');

// ── 台灣時區今日日期字串（YYYY-MM-DD） ───────────────────────────────────────
function getTodayTW() {
  return new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
}

// ── Bot 紀錄：每日只自動回覆一次 ─────────────────────────────────────────────
async function checkAndSetBotReply(sheets, userId) {
  const today = getTodayTW();
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${BOT_LOG_SHEET}!A:B` });
    const rows = res.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === userId) {
        if (rows[i][1] === today) return false;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${BOT_LOG_SHEET}!B${i + 1}`,
          valueInputOption: 'RAW',
          resource: { values: [[today]] },
        });
        return true;
      }
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${BOT_LOG_SHEET}!A:B`,
      valueInputOption: 'RAW',
      resource: { values: [[userId, today]] },
    });
    return true;
  } catch (e) {
    console.error('[bot-log error]', e.message);
    return true;
  }
}

// ── 設定工作表：ZOZO 功能開關 ─────────────────────────────────────────────────
async function getZOZOEnabled(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SETTINGS_SHEET}!A:B` });
    const rows = res.data.values || [];
    for (const row of rows.slice(1)) {
      if (row[0] === 'zozo_enabled') return row[1] !== 'false';
    }
    return true;
  } catch (e) { return true; }
}

// ── 設定工作表：GAS 通知開關 ─────────────────────────────────────────────────
async function getGasNotifyEnabled(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SETTINGS_SHEET}!A:B` });
    const rows = res.data.values || [];
    for (const row of rows.slice(1)) {
      if (row[0] === 'gas_notify_enabled') return row[1] !== 'false';
    }
    return true;
  } catch (e) { return true; }
}

// ── ZOZO 任務佇列：新增任務 ───────────────────────────────────────────────────
async function addZOZOTask(sheets, userId, url) {
  const taskId = Date.now().toString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${ZOZO_SHEET}!A:H`,
    valueInputOption: 'RAW',
    resource: { values: [[taskId, userId, url, 'pending', '', new Date().toISOString(), '', '']] },
  });
  return taskId;
}

// ── 商品管理表：查手填磅數（K 欄） ───────────────────────────────────────────
async function lookupProductKWeight(productId) {
  if (!productId) return null;
  try {
    const sheets = getSheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'A:K' });
    const rows = res.data.values || [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if ((rows[i][0] || '').toUpperCase() === productId.toUpperCase()) {
        const k = parseFloat(rows[i][10]);
        if (k > 0) return k;
      }
    }
    return null;
  } catch (e) {
    console.warn('[lookupProductKWeight]', e.message);
    return null;
  }
}

// ── 商品管理表：新增商品列 ────────────────────────────────────────────────────
async function appendProductToSheet(productId, productName, jpy, stockLines, qStatus, weightInfo) {
  const sheets = getSheetsClient();
  const stockSummary = stockLines.join(' | ');
  const today = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'A:A',
  });
  const r = ((res.data.values || []).length) + 1;

  // A~R = 18 欄（index 0~17）
  const row = new Array(18).fill('');
  row[0]  = productId;
  row[3]  = `=P${r}`;
  row[4]  = `=((V$3*(P${r}+195))*(1+0.06+0.015))+(150*L${r}+20+10)`;
  row[6]  = `=IF(MOD(ROUND(E${r},0),10)<=4,INT(ROUND(E${r},0)/10)*10+5,IF(MOD(ROUND(E${r},0),10)>=6,INT(ROUND(E${r},0)/10)*10+9,ROUND(E${r},0)))+F${r}`;
  row[8]  = `=H${r}-E${r}`;
  row[9]  = weightInfo ? weightInfo.midLbs : '';
  row[11] = `=CEILING(K${r},1)`;
  row[13] = productName;
  row[14] = today;
  row[15] = jpy;
  row[16] = stockSummary;
  row[17] = qStatus;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `A${r}:R${r}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] },
  });
}

// ── 查詢紀錄分頁：記錄一次查詢 ───────────────────────────────────────────────
async function logQueryToSheet(userId, displayName, productId, productName, jpy, weightInfo, imageUrl = '', suggestedPrice = 0, productUrl = '') {
  const sheets = getSheetsClient();
  const date = new Date().toISOString().slice(0, 10);

  const dataRow = [
    date, displayName, userId, productId, productName, jpy,
    weightInfo ? weightInfo.midLbs : '',
    weightInfo ? weightInfo.midKg  : '',
    weightInfo ? weightInfo.confidenceLabel : '',
    weightInfo ? weightInfo.detail : '',
    imageUrl,
    suggestedPrice,
    productUrl,
  ];

  async function doAppend() {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: '查詢紀錄!A:M',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [dataRow] },
    });
  }

  try {
    await doAppend();
  } catch (err) {
    if (err.message && err.message.includes('Unable to parse range')) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        resource: {
          requests: [{ addSheet: { properties: { title: '查詢紀錄' } } }],
        },
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: '查詢紀錄!A:M',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [
            ['日期', 'LINE 顯示名稱', 'LINE User ID', '商品 ID', '商品名稱', '日幣價格',
             '估算磅數(lbs)', '估算公斤(kg)', '信心程度', '說明', '圖片URL', '報價(NT$)', '商品URL'],
            dataRow,
          ],
        },
      });
    } else {
      throw err;
    }
  }
}

// ── 購物車 Sheet 操作 ─────────────────────────────────────────────────────────
const CART_HEADERS = ['userId','productId','productName','color','size','jpy','suggestedPrice','productUrl','addedAt','status','imageUrl','displayName','isPreorder'];

async function ensureCartSheet(sheets) {
  try {
    await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${CART_SHEET}!A1` });
  } catch {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: { requests: [{ addSheet: { properties: { title: CART_SHEET } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${CART_SHEET}!A1`,
      valueInputOption: 'RAW',
      resource: { values: [CART_HEADERS] },
    });
  }
}

async function ensureOrderSheet(sheets) {
  try {
    await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A1` });
  } catch {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: { requests: [{ addSheet: { properties: { title: ORDER_SHEET } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${ORDER_SHEET}!A1`,
      valueInputOption: 'RAW',
      resource: { values: [['訂單ID','下單時間','userId','商品明細','總金額(NT$)','買家姓名','手機','聯繫方式','聯繫帳號','備註','狀態','使用點數','優惠券','折扣金額(NT$)','實付金額(NT$)','LINE顯示名稱']] },
    });
  }
}

async function addToCartSheet(userId, displayName, productId, productName, colorJp, size, jpy, suggestedPrice, productUrl, imageUrl = '', isPreorder = false) {
  const sheets = getSheetsClient();
  await ensureCartSheet(sheets);
  const addedAt = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${CART_SHEET}!A:M`,
    valueInputOption: 'RAW',
    resource: { values: [[userId, productId, productName, colorJp, size, jpy, suggestedPrice, productUrl, addedAt, 'active', imageUrl, displayName || '', isPreorder ? '1' : '']] },
  });
}

async function getCartItems(userId) {
  const sheets = getSheetsClient();
  let resp;
  try {
    resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${CART_SHEET}!A:M` });
  } catch {
    return [];
  }
  const rows = (resp && resp.data.values) || [];
  const now = Date.now();
  const EXPIRE_MS = 6 * 60 * 60 * 1000;
  const items = [];
  rows.forEach((row, idx) => {
    if (idx === 0) return;
    if (row[0] !== userId) return;
    if (row[9] !== 'active') return;
    const addedAt = new Date(row[8]).getTime();
    if (now - addedAt > EXPIRE_MS) return;
    const colorJp = row[3] || '';
    items.push({
      rowIndex: idx + 1,
      productId: row[1] || '',
      productName: row[2] || '',
      color: colorJp,
      colorDisplay: translateColorWithJp(colorJp),
      size: row[4] || '',
      jpy: parseInt(row[5]) || 0,
      suggestedPrice: parseInt(row[6]) || 0,
      productUrl: row[7] || '',
      addedAt: row[8] || '',
      imageUrl: row[10] || '',
      isPreorder: row[12] === '1',
    });
  });
  return items;
}

async function clearCartItem(rowIndex) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${CART_SHEET}!J${rowIndex}`,
    valueInputOption: 'RAW',
    resource: { values: [['deleted']] },
  });
}

async function markCartItemsOrdered(userId, rowIndexes) {
  const sheets = getSheetsClient();
  const validIndexes = rowIndexes.filter(idx => Number.isInteger(idx) && idx > 0);
  if (!validIndexes.length) return;
  await Promise.all(validIndexes.map((idx) =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${CART_SHEET}!J${idx}`,
      valueInputOption: 'RAW',
      resource: { values: [['ordered']] },
    })
  ));
}

async function submitOrder(userId, displayName, cartItems, buyerInfo, discountInfo = {}) {
  const sheets = getSheetsClient();
  await ensureOrderSheet(sheets);
  const tsBase36 = Date.now().toString(36).padStart(9, '0');
  const randChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const randPart = Array.from({length: 12}, () => randChars[Math.floor(Math.random() * randChars.length)]).join('');
  const orderId = (tsBase36 + randPart).toUpperCase();
  const orderTime = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const itemMap = {};
  for (const i of cartItems) {
    const key = `${i.productId}|${i.color}|${i.size}`;
    if (!itemMap[key]) itemMap[key] = { ...i, qty: 0 };
    itemMap[key].qty += 1;
  }
  const totalQty = cartItems.length;
  const itemsSummary = Object.values(itemMap)
    .map(i => {
      const srcTag = (i.productUrl || '').includes('zozo.jp') ? '【ZOZO】' : '【GRL】';
      return `${i.isPreorder ? '【預購】' : ''}${srcTag}${(i.productId||'').toUpperCase()} ${translateColorWithJp(i.color)} ${i.size} NT$${i.suggestedPrice}${i.qty > 1 ? ` ×${i.qty}` : ''}`;
    })
    .join('\n') + `\n共 ${totalQty} 件`;
  const totalTwd = cartItems.reduce((sum, i) => sum + (i.suggestedPrice || 0), 0);
  const { pointsUsed = 0, couponCode = '', couponAmount = 0 } = discountInfo;
  const discountTotal = (pointsUsed || 0) + (couponAmount || 0);
  const finalAmount = Math.max(totalTwd - discountTotal, 0);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${ORDER_SHEET}!A:P`,
    valueInputOption: 'RAW',
    resource: { values: [[
      orderId, orderTime, userId,
      itemsSummary, totalTwd,
      buyerInfo.name, buyerInfo.phone, buyerInfo.contactMethod || '',
      buyerInfo.contactAccount || '', buyerInfo.note || '', '待確認',
      pointsUsed || 0, couponCode || '', discountTotal, finalAmount,
      displayName || '',
    ]] },
  });
  markCartItemsOrdered(userId, cartItems.map(i => i.rowIndex)).catch(e => console.error('[markOrdered error]', e.message));
  return { orderId, orderTime, totalTwd, discountTotal, finalAmount, pointsUsed: pointsUsed || 0, couponCode: couponCode || '', couponAmount: couponAmount || 0 };
}

// ── 查詢紀錄：取得用戶最近 12 筆（去重） ─────────────────────────────────────
async function getUserQueryHistory(userId) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: '查詢紀錄!A:M',
  });
  const rows = (res.data.values || []).slice(1);
  const userRows = rows.filter((r) => r[2] === userId);
  const seen = new Set();
  const deduped = [];
  for (let i = userRows.length - 1; i >= 0; i--) {
    const pid = userRows[i][3] || '';
    if (!seen.has(pid)) {
      seen.add(pid);
      deduped.push(userRows[i]);
      if (deduped.length >= 12) break;
    }
  }
  return deduped;
}

module.exports = {
  getTodayTW,
  checkAndSetBotReply,
  getZOZOEnabled,
  getGasNotifyEnabled,
  addZOZOTask,
  lookupProductKWeight,
  appendProductToSheet,
  logQueryToSheet,
  CART_HEADERS,
  ensureCartSheet,
  ensureOrderSheet,
  addToCartSheet,
  getCartItems,
  clearCartItem,
  markCartItemsOrdered,
  submitOrder,
  getUserQueryHistory,
};
