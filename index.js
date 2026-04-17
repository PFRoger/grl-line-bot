'use strict';

const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const { google } = require('googleapis');

const app = express();

const ADMIN_USER_ID = 'U9fa329e70b89f4ce19089928a824bd29';
const SHEET_ID = '148eFUK3xm0ITsVpueqtnwjK-lcKeemoiRbQgcFWbGug';
const LIFF_ID = '2009823505-mhQivhxd';
const CART_SHEET = '購物車';
const ORDER_SHEET = '訂單';

// ── Google Sheets 驗證 ────────────────────────────────────────────────────────
function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ── 顏色對照表（複合詞排前面，避免被單字提前匹配）────────────────────────────
const COLOR_MAP_OBJ = {
  'オフホワイト': '灰白色', 'オフベージュ': '杏色',  'ライトブルー': '淺藍色',
  'ライトグレー': '淺灰色', 'グレージュ':  '藕色',   'ワインレッド': '酒紅色',
  'ミントグリーン': '薄荷綠色', 'キャメル': '駝色',  'オートミール': '燕麥色',
  'ブラック': '黑色',  'ピンク': '粉色',    'グレー': '灰色',    'アイボリー': '象牙白',
  'チャコール': '炭灰色', 'ホワイト': '米白色', 'ブルー': '藍色',  'ベージュ': '淺褐色',
  'グリーン': '綠色',  'レッド': '紅色',    'イエロー': '黃色', 'パープル': '紫色',
  'ブラウン': '咖啡色', 'モカ': '摩卡色',   'ボルドー': '酒紅色', 'カーキ': '卡其色',
  'ネイビー': '藏青色', 'オレンジ': '橘色', 'ミント': '薄荷綠', 'ラベンダー': '薰衣草紫',
  'マスタード': '芥末黃',
};
const COLOR_KEYS = Object.keys(COLOR_MAP_OBJ);

function hasColorKeyword(text) {
  return COLOR_KEYS.some((k) => text.includes(k));
}

function translateColorWithJp(text) {
  for (const jp of COLOR_KEYS) {
    if (text.includes(jp)) return `${COLOR_MAP_OBJ[jp]}(${jp})`;
  }
  return text;
}

// ── 到貨日期翻譯：「4月下旬入荷予定」→「預計4月下旬到貨」────────────────────
function translateArrival(text) {
  return text.replace('入荷予定', '到貨');
}

// ── 建議售價計算 ──────────────────────────────────────────────────────────────
// PROFIT = 每單固定利潤（NT$），如需改為從 Google Sheet 讀取可後續調整
const PROFIT = 120;

function calcSuggestedPrice(rate, jpy, lbs = 1) {
  const cost = rate * jpy * 1.075 + (150 * Math.ceil(lbs) + 20 + 10);
  const base = Math.round(cost + PROFIT);
  const last = base % 10;
  if (last <= 4) return base - last + 5;
  if (last >= 6) return base - last + 9;
  return base;
}

// ── 格式化日幣（加千位符） ────────────────────────────────────────────────────
function fmtJPY(n) {
  return n.toLocaleString('ja-JP');
}

// ── 抓取即時匯率 JPY → TWD ────────────────────────────────────────────────────
async function fetchRate() {
  const PRIMARY = 'https://api.exchangerate-api.com/v4/latest/JPY';
  const FALLBACK = 'https://open.er-api.com/v6/latest/JPY';

  async function tryFetch(url) {
    const { data } = await axios.get(url, { timeout: 8000 });
    const rate = (data.rates && data.rates.TWD) ||
                 (data.conversion_rates && data.conversion_rates.TWD);
    if (!rate) throw new Error('回應中找不到 TWD 欄位');
    return rate;
  }

  let rate;
  try {
    rate = await tryFetch(PRIMARY);
  } catch (err) {
    console.warn('[fetchRate] 主要端點失敗，切換備援:', err.message);
    rate = await tryFetch(FALLBACK);
  }

  return rate + 0.015;
}

// ── 從網址擷取商品 ID（去掉最後 4 碼數字後綴，例如 ru14381119→ru1438）────────
function extractProductId(url) {
  const m = url.match(/\/item\/([a-z]{2}\d+)/i);
  if (!m) return null;
  return m[1].replace(/\d{4}$/, '');
}

// ── 解析庫存（參考 GAS parseStockForBot 邏輯）────────────────────────────────
// 直接對原始 HTML 用 regex 找 <li>，strip tags，過濾有顏色關鍵字的列，
// 再用 size/status 兩段式 regex 取出每個尺寸庫存。
function parseStockFromHtml(html) {
  const stockLines = [];
  const seen = new Set();
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch;

  while ((liMatch = liRegex.exec(html)) !== null) {
    // strip all tags, collapse whitespace
    const liText = liMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    const hasStock   = liText.includes('在庫あり');
    const hasNone    = liText.includes('在庫なし') || liText.includes('在庫無し');
    const hasLimited = liText.includes('残りわずか') ||
                       (liText.includes('残り') && !liText.includes('残りわずか'));
    const hasReserve = liText.includes('予約販売');

    if (!hasStock && !hasNone && !hasLimited && !hasReserve) continue;
    // 排除雜訊列
    if (liText.includes('アイテム') && !hasColorKeyword(liText)) continue;
    if (liText.includes('日新着'))   continue;
    if (liText.includes('日再入荷')) continue;
    if (liText.includes('日予約'))   continue;
    if (liText.includes('すべて') && !hasColorKeyword(liText)) continue;
    if (!hasColorKeyword(liText)) continue;
    if (seen.has(liText)) continue;
    seen.add(liText);

    // 找顏色名稱
    let colorName = '';
    for (const k of COLOR_KEYS) {
      if (liText.includes(k)) { colorName = k; break; }
    }
    const displayColor = colorName
      ? `${COLOR_MAP_OBJ[colorName]}(${colorName})`
      : '';

    // 抓出 SIZE/STATUS 對
    // 支援：S/M/L/XL/FREE 等字母尺寸，以及 22.5cm / 23.0cm 等數字尺寸
    // 支援：在庫なし / 在庫無し（含後接 予約販売《...》 的複合狀態）
    const sizeStockRegex =
      /([\d.]+cm|[A-Z][A-Z0-9]*)\/(在庫あり|在庫なし|在庫無し(?:\s*予約販売(?:《([^》]*)》)?)?|残りわずか|残り\d*|予約販売(?:《([^》]*)》)?)/g;
    let sizeMatch;
    const sizeResults = [];

    while ((sizeMatch = sizeStockRegex.exec(liText)) !== null) {
      const size       = sizeMatch[1];
      const st         = sizeMatch[2];
      const arrivalRaw = sizeMatch[3] || sizeMatch[4] || '';
      let status;
      if (st === '在庫あり') {
        status = '✅ 有庫存';
      } else if (st.startsWith('在庫無し') && st.includes('予約販売')) {
        status = '📅 預約販售' + (arrivalRaw ? `（${translateArrival(arrivalRaw)}）` : '');
      } else if (st === '在庫なし' || st === '在庫無し') {
        status = '❌ 缺貨';
      } else if (st.includes('残り')) {
        status = '⚠️ 剩餘少量';
      } else if (st.includes('予約販売')) {
        status = '📅 預約販售' + (arrivalRaw ? `（${translateArrival(arrivalRaw)}）` : '');
      } else {
        status = '❌ 缺貨';
      }
      sizeResults.push(`${displayColor} ${size}: ${status}`);
    }

    if (sizeResults.length > 0) {
      for (const s of sizeResults) {
        if (!seen.has(s)) { stockLines.push(s); seen.add(s); }
      }
    } else {
      // fallback：整行沒有 SIZE/ 格式，用顏色整體狀態
      let colorPart = '', sizePart = '';
      const slashIdx = liText.indexOf('/');
      if (slashIdx !== -1) {
        const beforeSlash = liText.substring(0, slashIdx).trim();
        const spaceIdx = beforeSlash.lastIndexOf(' ');
        if (spaceIdx !== -1) {
          colorPart = beforeSlash.substring(0, spaceIdx).trim();
          sizePart  = beforeSlash.substring(spaceIdx + 1).trim();
        } else {
          colorPart = beforeSlash;
        }
      } else {
        colorPart = liText.split(' ')[0];
      }
      const dc    = translateColorWithJp(colorPart);
      const label = sizePart ? `${dc} ${sizePart}` : dc;
      let status;
      if (hasStock)        status = '✅ 有庫存';
      else if (hasLimited) status = '⚠️ 剩餘少量';
      else if (hasReserve) {
        const dm = liText.match(/《([^》]+)》/);
        status = dm ? `📅 預約販售（${translateArrival(dm[1])}）` : '📅 預約販售';
      } else               status = '❌ 缺貨';
      stockLines.push(`${label}: ${status}`);
    }
  }

  return stockLines;
}

// ── 計算 Q 欄備註狀態 ─────────────────────────────────────────────────────────
function calcQStatus(stockLines) {
  if (stockLines.length === 0) return '已下架';
  if (stockLines.every((s) => s.includes('❌'))) return '缺貨';
  if (stockLines.every((s) => s.includes('📅'))) return '預約';
  return ''; // 正常有庫存，留空
}

// ── 商品重量估算 ──────────────────────────────────────────────────────────────
// 依商品名稱關鍵字判斷品類，回傳估算重量範圍與信心程度
function estimateWeight(productName) {
  const name = productName;

  let category, label, minG, maxG, confidence, packagingNote;

  if (/サンダル|スニーカー|ブーツ|パンプス|シューズ|ミュール|ローファー|スリッポン|ウェッジ|フラット|ヒール/.test(name)) {
    category = 'shoes';
    label = '鞋類';
    minG = 500; maxG = 820;
    packagingNote = '含鞋盒紙箱（約200~280g）';
    confidence = 'medium';
  } else if (/バッグ|トートバッグ|ショルダー|ハンドバッグ|リュック|クラッチ|ポーチ/.test(name)) {
    category = 'bag';
    label = '包包';
    minG = 250; maxG = 620;
    packagingNote = '含塑膠包裝袋（約20g）';
    confidence = 'medium';
  } else if (/ピアス|ネックレス|リング|ブレスレット|ヘアアクセ|ヘアクリップ|バレッタ|アクセサリー/.test(name)) {
    category = 'accessory';
    label = '配件';
    minG = 60; maxG = 180;
    packagingNote = '含小紙盒或塑膠袋（約20~50g）';
    confidence = 'low';
  } else if (/コート|アウター|ダウン|ブルゾン|ムートン/.test(name)) {
    category = 'outerwear';
    label = '外套';
    minG = 450; maxG = 950;
    packagingNote = '含塑膠包裝袋（約20g）';
    confidence = 'medium';
  } else if (/ジャケット|カーディガン|ボレロ/.test(name)) {
    category = 'jacket';
    label = '外罩衫';
    minG = 280; maxG = 580;
    packagingNote = '含塑膠包裝袋（約20g）';
    confidence = 'high';
  } else if (/ワンピース|ドレス/.test(name)) {
    category = 'dress';
    label = '洋裝';
    minG = 200; maxG = 480;
    packagingNote = '含塑膠包裝袋（約20g）';
    confidence = 'high';
  } else if (/スカート/.test(name)) {
    category = 'skirt';
    label = '裙子';
    minG = 170; maxG = 400;
    packagingNote = '含塑膠包裝袋（約20g）';
    confidence = 'high';
  } else if (/デニム|ジーンズ/.test(name)) {
    category = 'denim';
    label = '牛仔褲';
    minG = 500; maxG = 850;
    packagingNote = '含塑膠包裝袋（約20g）';
    confidence = 'high';
  } else if (/パンツ|スラックス|ショートパンツ|レギンス/.test(name)) {
    category = 'pants';
    label = '褲子';
    minG = 220; maxG = 520;
    packagingNote = '含塑膠包裝袋（約20g）';
    confidence = 'high';
  } else if (/ニット|セーター/.test(name)) {
    category = 'knit';
    label = '針織上衣';
    minG = 180; maxG = 400;
    packagingNote = '含塑膠包裝袋（約20g）';
    confidence = 'high';
  } else if (/トップス|シャツ|ブラウス|カットソー|Tシャツ|タンク|ノースリーブ/.test(name)) {
    category = 'top';
    label = '上衣';
    minG = 120; maxG = 300;
    packagingNote = '含塑膠包裝袋（約20g）';
    confidence = 'high';
  } else {
    category = 'clothing';
    label = '服飾';
    minG = 150; maxG = 450;
    packagingNote = '含塑膠包裝袋（約20g）';
    confidence = 'medium';
  }

  const midG    = Math.round((minG + maxG) / 2);
  const midKg   = parseFloat((midG / 1000).toFixed(2));
  const midLbs  = parseFloat((midKg * 2.20462).toFixed(2));
  const minLbs  = parseFloat((minG / 1000 * 2.20462).toFixed(2));
  const maxLbs  = parseFloat((maxG / 1000 * 2.20462).toFixed(2));
  const minKg   = parseFloat((minG / 1000).toFixed(2));
  const maxKg   = parseFloat((maxG / 1000).toFixed(2));

  const confidenceLabel = confidence === 'high' ? '高' : confidence === 'medium' ? '中' : '低';
  const detail = `品類：${label}｜${packagingNote}｜估算範圍：${minG}~${maxG}g（${minLbs}~${maxLbs} lbs）`;

  return { category, label, midG, midKg, midLbs, minG, maxG, minLbs, maxLbs, minKg, maxKg, confidence, confidenceLabel, detail };
}

// ── 爬取 GRL 商品資訊 ─────────────────────────────────────────────────────────
async function scrapeGRL(url) {
  const { data: html } = await axios.get(url, {
    timeout: 12000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'ja,zh-TW;q=0.9,zh;q=0.8,en-US;q=0.7',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  });

  const $ = cheerio.load(html);

  // 商品名稱：去除結尾 [id] 或 【id】
  const rawName = $('h1').first().text().trim();
  const productName = rawName
    .replace(/[\[【][^\]】]*[\]】]\s*$/, '')
    .trim();

  // 日幣售價
  const priceText = $('.txt-price').first().text();
  const priceMatch = priceText.match(/¥([\d,]+)/);
  if (!priceMatch) throw new Error('無法解析價格');
  const jpy = parseInt(priceMatch[1].replace(/,/g, ''), 10);

  // 商品圖片：從 og:image 取得
  const imageUrl = $('meta[property="og:image"]').attr('content') || null;

  // 庫存：使用 GAS 相同的 raw HTML regex 解析法
  const stockLines = parseStockFromHtml(html);

  return { productName, jpy, stockLines, imageUrl };
}

// ── 新增商品到 Google Sheet（管理員功能）─────────────────────────────────────
// 欄位配置（插入新 J 欄後，共 A~R = 18 欄）：
//   A: 商品ID  D:=P  E:成本  F:利潤  G:建議售價  H:售價  I:預估獲利
//   J:估算磅數(估算值)  K:磅數raw(手填)  L:=CEILING(K,1)
//   N:商品名稱  O:確認日期  P:日幣  Q:庫存狀態  R:備註
//   V$3: 匯率（原 U$3，因新增 J 欄後 U→V）
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
  row[0]  = productId;                                           // A: 商品 ID
  row[3]  = `=P${r}`;                                           // D: 日幣（同 P）
  row[4]  = `=((V$3*P${r})*(1+0.06+0.015))+(150*L${r}+20+10)`; // E: 成本價（匯率 V$3，磅數 L）
  row[6]  = `=IF(MOD(ROUND(E${r},0),10)<=4,INT(ROUND(E${r},0)/10)*10+5,IF(MOD(ROUND(E${r},0),10)>=6,INT(ROUND(E${r},0)/10)*10+9,ROUND(E${r},0)))+F${r}`; // G: 建議售價
  row[8]  = `=H${r}-E${r}`;                                     // I: 預估獲利
  row[9]  = weightInfo ? weightInfo.midLbs : '';                 // J: 估算磅數（估算值）← 新增
  // row[10] = K: 磅數 raw（留空，手動填入）
  row[11] = `=CEILING(K${r},1)`;                                // L: 磅數（CEILING）
  // row[12] = M: 空欄
  row[13] = productName;                                         // N: 商品名稱
  row[14] = today;                                               // O: 確認日期
  row[15] = jpy;                                                 // P: 日幣
  row[16] = stockSummary;                                        // Q: 庫存狀態
  row[17] = qStatus;                                             // R: 備註

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `A${r}:R${r}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] },
  });
}

// ── 記錄查詢到「查詢紀錄」分頁 ──────────────────────────────────────────────
// 欄位：A日期 B顯示名稱 C UserID D商品ID E商品名稱 F日幣
//       G估算磅數(lbs) H估算公斤(kg) I信心程度 J說明
async function logQueryToSheet(userId, displayName, productId, productName, jpy, weightInfo) {
  const sheets = getSheetsClient();
  const date = new Date().toISOString().slice(0, 10);

  const dataRow = [
    date, displayName, userId, productId, productName, jpy,
    weightInfo ? weightInfo.midLbs : '',
    weightInfo ? weightInfo.midKg  : '',
    weightInfo ? weightInfo.confidenceLabel : '',
    weightInfo ? weightInfo.detail : '',
  ];

  async function doAppend() {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: '查詢紀錄!A:J',
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
        range: '查詢紀錄!A:J',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [
            ['日期', 'LINE 顯示名稱', 'LINE User ID', '商品 ID', '商品名稱', '日幣價格',
             '估算磅數(lbs)', '估算公斤(kg)', '信心程度', '說明'],
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
// 欄位：A=userId B=productId C=productName D=color(JP) E=size
//        F=jpy G=suggestedPrice H=productUrl I=addedAt J=status
const CART_HEADERS = ['userId','productId','productName','color','size','jpy','suggestedPrice','productUrl','addedAt','status'];

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
      resource: { values: [['訂單ID','下單時間','userId','商品明細','總金額(NT$)','買家姓名','手機','7-11門市','匯款末5碼','備註','狀態']] },
    });
  }
}

async function addToCartSheet(userId, productId, productName, colorJp, size, jpy, suggestedPrice, productUrl) {
  const sheets = getSheetsClient();
  await ensureCartSheet(sheets);
  const addedAt = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${CART_SHEET}!A:J`,
    valueInputOption: 'RAW',
    resource: { values: [[userId, productId, productName, colorJp, size, jpy, suggestedPrice, productUrl, addedAt, 'active']] },
  });
}

async function getCartItems(userId) {
  const sheets = getSheetsClient();
  await ensureCartSheet(sheets);
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${CART_SHEET}!A:J` });
  const rows = resp.data.values || [];
  const now = Date.now();
  const EXPIRE_MS = 12 * 60 * 60 * 1000; // 12 hours
  const items = [];
  rows.forEach((row, idx) => {
    if (idx === 0) return; // header
    if (row[0] !== userId) return;
    if (row[9] !== 'active') return;
    const addedAt = new Date(row[8]).getTime();
    if (now - addedAt > EXPIRE_MS) return; // expired
    items.push({
      rowIndex: idx + 1, // 1-based sheet row
      productId: row[1] || '',
      productName: row[2] || '',
      color: row[3] || '',
      size: row[4] || '',
      jpy: parseInt(row[5]) || 0,
      suggestedPrice: parseInt(row[6]) || 0,
      productUrl: row[7] || '',
      addedAt: row[8] || '',
    });
  });
  return items;
}

async function clearCartItem(rowIndex) {
  const sheets = getSheetsClient();
  // Mark as deleted by updating status column (J = index 9, col 10)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${CART_SHEET}!J${rowIndex}`,
    valueInputOption: 'RAW',
    resource: { values: [['deleted']] },
  });
}

async function markCartItemsOrdered(userId, rowIndexes) {
  const sheets = getSheetsClient();
  for (const idx of rowIndexes) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${CART_SHEET}!J${idx}`,
      valueInputOption: 'RAW',
      resource: { values: [['ordered']] },
    });
  }
}

async function submitOrder(userId, cartItems, buyerInfo) {
  const sheets = getSheetsClient();
  await ensureOrderSheet(sheets);
  const orderId = `${Date.now()}-${userId.slice(-6)}`;
  const orderTime = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const itemsSummary = cartItems.map(i => `${i.productId} ${i.color} ${i.size} NT$${i.suggestedPrice}`).join(' | ');
  const totalTwd = cartItems.reduce((sum, i) => sum + (i.suggestedPrice || 0), 0);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${ORDER_SHEET}!A:K`,
    valueInputOption: 'RAW',
    resource: { values: [[
      orderId, orderTime, userId,
      itemsSummary, totalTwd,
      buyerInfo.name, buyerInfo.phone, buyerInfo.store711,
      buyerInfo.bankLast5, buyerInfo.note || '', '待確認',
    ]] },
  });
  await markCartItemsOrdered(userId, cartItems.map(i => i.rowIndex));
  return { orderId, orderTime, totalTwd };
}

// ── 查詢用戶查詢紀錄 ──────────────────────────────────────────────────────────
async function getUserQueryHistory(userId) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: '查詢紀錄!A:F',
  });
  const rows = (res.data.values || []).slice(1); // 跳過 header
  const userRows = rows.filter((r) => r[2] === userId);
  return userRows.slice(-10).reverse(); // 最近 10 筆，最新在前
}

// ── 查詢紀錄 Flex Message ─────────────────────────────────────────────────────
function buildHistoryFlexMessage(history) {
  if (history.length === 0) {
    return {
      type: 'text',
      text: '您還沒有查詢紀錄。\n\n請傳入 GRL 商品網址開始查詢！\n範例：https://www.grail.bz/item/xxx/',
    };
  }

  const bubbles = history.map((row) => {
    const date     = row[0] || '';
    const prodName = row[4] || '商品名稱不明';
    const jpy      = row[5] ? `¥${Number(row[5]).toLocaleString('ja-JP')}` : '-';
    const prodId   = row[3] || '';
    const itemUrl  = prodId ? `https://www.grail.bz/disp/item/${prodId}/` : 'https://www.grail.bz';

    return {
      type: 'bubble',
      size: 'micro',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          { type: 'text', text: prodName, size: 'sm', weight: 'bold', wrap: true, maxLines: 2, color: '#222222' },
          { type: 'text', text: jpy,       size: 'sm', color: '#E53935' },
          { type: 'text', text: date,      size: 'xs', color: '#aaaaaa' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '8px',
        contents: [{
          type: 'button',
          style: 'primary',
          color: '#FF6B9D',
          height: 'sm',
          action: { type: 'uri', label: '查看商品', uri: itemUrl },
        }],
      },
    };
  });

  return {
    type: 'flex',
    altText: `您的查詢紀錄（最近 ${history.length} 筆）`,
    contents: { type: 'carousel', contents: bubbles },
  };
}

// ── 使用教學 Flex Message ─────────────────────────────────────────────────────
function buildTutorialFlexMessage() {
  const steps = [
    {
      title: 'Step 1｜查詢商品報價',
      icon: '🔍',
      lines: [
        '複製 GRL 官網的商品網址',
        '直接貼到這個 LINE Bot',
        'Bot 會自動回傳：',
        '• 日幣售價',
        '• 台幣報價（含運費）',
        '• 每個尺寸庫存狀態',
        '• 估算重量',
      ],
    },
    {
      title: 'Step 2｜了解報價內容',
      icon: '💵',
      lines: [
        '報價金額 = 日幣 × 匯率',
        '+ 手續費 6%',
        '+ 銀行手續費 1.5%',
        '+ 運費（依磅數計算）',
        '+ 包材 NT$20',
        '',
        '✅ 有庫存 → 可直接下單',
        '⚠️ 剩餘少量 → 盡早下單',
        '📅 預約販售 → 顯示到貨日',
      ],
    },
    {
      title: 'Step 3｜下單方式',
      icon: '🛒',
      lines: [
        '1. 確認商品、尺寸、顏色',
        '2. 截圖傳給我們',
        '    或直接傳商品連結 + 尺寸',
        '3. 確認報價後付款',
        '4. 我們幫您向日本下單',
        '5. 到貨後通知取件',
        '',
        '有問題歡迎直接發訊息！🌸',
      ],
    },
  ];

  const bubbles = steps.map((s) => ({
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#FF6B9D',
      paddingAll: '14px',
      contents: [{
        type: 'text',
        text: `${s.icon} ${s.title}`,
        color: '#ffffff',
        size: 'sm',
        weight: 'bold',
        wrap: true,
      }],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      paddingAll: '14px',
      contents: s.lines.map((l) => ({
        type: 'text',
        text: l || ' ',
        size: 'sm',
        color: l.startsWith('•') || l.startsWith('✅') || l.startsWith('⚠️') || l.startsWith('📅') ? '#555555' : '#333333',
        wrap: true,
      })),
    },
  }));

  return {
    type: 'flex',
    altText: '使用教學｜如何查詢與下單',
    contents: { type: 'carousel', contents: bubbles },
  };
}

// ── Rich Menu 設定 ────────────────────────────────────────────────────────────
async function setupRichMenu(imageUrl) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 1. 建立 Rich Menu 定義
  const def = {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: 'Bijin主選單',
    chatBarText: '主選單',
    areas: [
      { bounds: { x: 0,    y: 0,   width: 833, height: 843 }, action: { type: 'postback', label: '查詢紀錄', data: 'action=query_history', displayText: '查詢紀錄' } },
      { bounds: { x: 833,  y: 0,   width: 833, height: 843 }, action: { type: 'uri',      label: '開始購物', uri: 'https://www.grail.bz' } },
      { bounds: { x: 1666, y: 0,   width: 834, height: 843 }, action: { type: 'postback', label: '購物車',   data: 'action=cart',          displayText: '購物車' } },
      { bounds: { x: 0,    y: 843, width: 833, height: 843 }, action: { type: 'postback', label: '使用教學', data: 'action=tutorial',       displayText: '使用教學' } },
      { bounds: { x: 833,  y: 843, width: 833, height: 843 }, action: { type: 'uri',      label: 'IG連結',   uri: 'https://www.instagram.com/bijin.jp.2024?igsh=MXZxY2wzc2tsdWxzeQ%3D%3D&utm_source=qr' } },
      { bounds: { x: 1666, y: 843, width: 834, height: 843 }, action: { type: 'postback', label: '會員中心', data: 'action=member',         displayText: '會員中心' } },
    ],
  };

  const createRes = await axios.post('https://api.line.me/v2/bot/richmenu', def, { headers });
  const richMenuId = createRes.data.richMenuId;

  // 2. 上傳圖片（若有提供 URL）
  if (imageUrl) {
    const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    await axios.post(
      `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
      imgRes.data,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' } }
    );
  }

  // 3. 設為所有用戶預設選單
  await axios.post(
    `https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`,
    {},
    { headers }
  );

  return richMenuId;
}

// ── 處理 Rich Menu Postback 事件 ──────────────────────────────────────────────
async function handlePostback(event, client) {
  const userId     = event.source.userId;
  const replyToken = event.replyToken;
  const params     = new URLSearchParams(event.postback.data);
  const action     = params.get('action');

  if (action === 'query_history') {
    let history = [];
    try { history = await getUserQueryHistory(userId); } catch (e) { console.error('[history error]', e.message); }
    await client.replyMessage(replyToken, buildHistoryFlexMessage(history));

  } else if (action === 'tutorial') {
    await client.replyMessage(replyToken, buildTutorialFlexMessage());

  } else if (action === 'cart') {
    await client.replyMessage(replyToken, {
      type: 'text',
      text: `🛒 前往購物車結帳：\nhttps://liff.line.me/${LIFF_ID}`,
    });

  } else if (action === 'member') {
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '👤 會員中心即將上線！\n\n我們正在努力開發中，敬請期待 🌸',
    });

  } else if (action === 'add_to_cart') {
    const productId    = params.get('id') || '';
    const colorJp      = params.get('c') || '';
    const size         = params.get('s') || '';
    const jpy          = parseInt(params.get('jpy')) || 0;
    const suggested    = parseInt(params.get('p')) || 0;
    const productUrl   = `https://www.grail.bz/item/${productId}/`;

    // 從查詢紀錄找商品名稱
    let productName = productId;
    try {
      const sheets = getSheetsClient();
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: '查詢紀錄!A:E' });
      const rows = (resp.data.values || []).reverse();
      const found = rows.find(r => r[3] === productId);
      if (found) productName = found[4] || productId;
    } catch (e) { console.warn('[lookup name error]', e.message); }

    await addToCartSheet(userId, productId, productName, colorJp, size, jpy, suggested, productUrl);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: `✅ ${productId} 已加入購物車\n色：${colorJp} 碼：${size}\nNT$${suggested}\n\n請按下方主選單「購物車」查看內容\n════════════\n購物車每 12 小時自動清空`,
    });

  } else if (action === 'view_cart') {
    await client.replyMessage(replyToken, {
      type: 'text',
      text: `🛒 前往購物車結帳：\nhttps://liff.line.me/${LIFF_ID}`,
    });
  }
}

// ── LIFF 購物車 HTML ──────────────────────────────────────────────────────────
function buildCartHtml() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Bijin 購物車</title>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#faf8f6;color:#333;padding-bottom:40px}
.header{background:#c9a98a;color:#fff;padding:16px;text-align:center;font-size:18px;font-weight:bold;letter-spacing:1px}
.section{background:#fff;margin:12px;border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.section-title{font-size:15px;font-weight:bold;color:#7a5c3e;margin-bottom:12px;border-bottom:1px solid #f0e8de;padding-bottom:8px}
.cart-item{border:1px solid #eee;border-radius:8px;padding:12px;margin-bottom:10px;position:relative}
.item-name{font-size:13px;color:#888;margin-bottom:4px}
.item-detail{font-size:14px;font-weight:600;color:#333}
.item-price{font-size:15px;font-weight:bold;color:#c9a98a;margin-top:4px}
.item-delete{position:absolute;top:10px;right:10px;background:none;border:1px solid #ddd;border-radius:6px;padding:4px 10px;font-size:12px;color:#999;cursor:pointer}
.item-delete:active{background:#fee}
.empty{text-align:center;color:#aaa;padding:30px 0;font-size:14px}
.total-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:14px}
.total-amount{font-size:18px;font-weight:bold;color:#c9a98a}
label{display:block;font-size:13px;color:#888;margin-bottom:4px;margin-top:12px}
input,select,textarea{width:100%;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;outline:none}
input:focus,select:focus,textarea:focus{border-color:#c9a98a}
.radio-group{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.radio-item{display:flex;align-items:center;gap:8px;font-size:14px}
.submit-btn{width:100%;background:#c9a98a;color:#fff;border:none;border-radius:10px;padding:14px;font-size:16px;font-weight:bold;cursor:pointer;margin-top:16px;letter-spacing:1px}
.submit-btn:disabled{background:#ccc}
.submit-btn:active{background:#b8906e}
.note-box{background:#fff8f0;border-radius:8px;padding:10px;font-size:12px;color:#888;margin-top:8px;line-height:1.6}
#loading{text-align:center;padding:40px;color:#aaa}
#success{display:none;text-align:center;padding:30px}
.success-icon{font-size:48px;margin-bottom:12px}
.success-title{font-size:18px;font-weight:bold;color:#c9a98a;margin-bottom:8px}
.success-text{font-size:13px;color:#888;line-height:1.6}
</style>
</head>
<body>
<div class="header">🛒 Bijin 購物車</div>
<div id="loading">載入中...</div>
<div id="main" style="display:none">
  <div class="section">
    <div class="section-title">商品資訊</div>
    <div id="cart-items"></div>
    <div id="cart-empty" class="empty" style="display:none">購物車是空的<br><small>請先查詢商品並加入購物車</small></div>
  </div>
  <div id="order-section" class="section" style="display:none">
    <div class="section-title">訂單資訊</div>
    <div class="total-row"><span>合計</span><span class="total-amount" id="total-amount">NT$0</span></div>
    <div class="note-box">付款方式：銀行轉帳<br>確認後將提供帳號資訊，請在 3 天內完成匯款</div>
  </div>
  <div id="buyer-section" class="section" style="display:none">
    <div class="section-title">訂貨人資訊</div>
    <label>姓名 *</label>
    <input id="f-name" type="text" placeholder="請輸入真實姓名">
    <label>手機號碼 *</label>
    <input id="f-phone" type="tel" placeholder="09xxxxxxxx">
    <label>收件縣市 *</label>
    <select id="f-city">
      <option value="">請選擇縣市</option>
      <option>臺北市</option><option>新北市</option><option>桃園市</option><option>臺中市</option>
      <option>臺南市</option><option>高雄市</option><option>基隆市</option><option>新竹市</option>
      <option>嘉義市</option><option>新竹縣</option><option>苗栗縣</option><option>彰化縣</option>
      <option>南投縣</option><option>雲林縣</option><option>嘉義縣</option><option>屏東縣</option>
      <option>宜蘭縣</option><option>花蓮縣</option><option>臺東縣</option><option>澎湖縣</option>
      <option>金門縣</option><option>連江縣</option>
    </select>
    <label>收件 7-11 門市名稱 *</label>
    <input id="f-store" type="text" placeholder="例：忠孝門市">
    <label>匯款帳號末 5 碼（對帳用）*</label>
    <input id="f-bank" type="text" placeholder="例：12345" maxlength="5">
    <label>備註（選填）</label>
    <textarea id="f-note" rows="2" placeholder="特殊需求或備注"></textarea>
    <button class="submit-btn" id="submit-btn" onclick="submitOrder()">確認下單</button>
  </div>
</div>
<div id="success">
  <div class="success-icon">🎉</div>
  <div class="success-title">下單成功！</div>
  <div class="success-text" id="success-text"></div>
</div>
<script>
let userId = '';
let cartItems = [];

async function init() {
  try {
    await liff.init({ liffId: '${LIFF_ID}' });
    if (!liff.isLoggedIn()) { liff.login(); return; }
    const profile = await liff.getProfile();
    userId = profile.userId;
    await loadCart();
  } catch(e) {
    document.getElementById('loading').textContent = '載入失敗，請重新開啟';
  }
}

async function loadCart() {
  const resp = await fetch('/api/cart?userId=' + userId);
  const data = await resp.json();
  cartItems = data.items || [];
  render();
}

function render() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('main').style.display = 'block';
  const el = document.getElementById('cart-items');
  el.innerHTML = '';
  if (cartItems.length === 0) {
    document.getElementById('cart-empty').style.display = 'block';
    document.getElementById('order-section').style.display = 'none';
    document.getElementById('buyer-section').style.display = 'none';
    return;
  }
  document.getElementById('cart-empty').style.display = 'none';
  document.getElementById('order-section').style.display = 'block';
  document.getElementById('buyer-section').style.display = 'block';
  let total = 0;
  cartItems.forEach((item, idx) => {
    total += item.suggestedPrice || 0;
    el.innerHTML += \`<div class="cart-item" id="item-\${idx}">
      <div class="item-name">\${item.productId}</div>
      <div class="item-detail">\${item.color} \${item.size}</div>
      <div class="item-detail" style="font-size:12px;color:#aaa;margin-top:2px">\${item.productName.substring(0,30)}</div>
      <div class="item-price">NT$\${item.suggestedPrice}</div>
      <button class="item-delete" onclick="deleteItem(\${idx},\${item.rowIndex})">刪除</button>
    </div>\`;
  });
  document.getElementById('total-amount').textContent = 'NT$' + total;
}

async function deleteItem(idx, rowIndex) {
  if (!confirm('確定要移除這個商品嗎？')) return;
  await fetch('/api/cart/item', { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({rowIndex}) });
  cartItems.splice(idx, 1);
  render();
}

async function submitOrder() {
  const name = document.getElementById('f-name').value.trim();
  const phone = document.getElementById('f-phone').value.trim();
  const city = document.getElementById('f-city').value;
  const store = document.getElementById('f-store').value.trim();
  const bank = document.getElementById('f-bank').value.trim();
  const note = document.getElementById('f-note').value.trim();
  if (!name || !phone || !city || !store || !bank) { alert('請填寫所有必填欄位 (*)'); return; }
  if (!/^09\\d{8}$/.test(phone)) { alert('手機號碼格式不正確'); return; }
  if (bank.length !== 5) { alert('請輸入匯款帳號末 5 碼'); return; }
  const btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = '送出中...';
  try {
    const resp = await fetch('/api/order', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ userId, cartItems, buyerInfo:{ name, phone, store711: city + ' ' + store, bankLast5:bank, note } })
    });
    const data = await resp.json();
    if (data.orderId) {
      document.getElementById('main').style.display = 'none';
      document.getElementById('success').style.display = 'block';
      document.getElementById('success-text').innerHTML =
        '訂單編號：' + data.orderId + '<br><br>我們將盡快確認您的訂單<br>請在收到確認通知後 3 天內完成匯款<br><br>如有問題請直接傳訊息給我們 🌸';
    } else {
      alert('下單失敗，請稍後再試');
      btn.disabled = false; btn.textContent = '確認下單';
    }
  } catch(e) {
    alert('下單失敗，請稍後再試');
    btn.disabled = false; btn.textContent = '確認下單';
  }
}

init();
</script>
</body>
</html>`;
}

// ── 建立加入購物車按鈕 Flex（Carousel，每個顏色一張卡片）──────────────────────
function buildAddToCartFlex(stockLines, productId, jpy, suggested, productUrl, imageUrl, productName) {
  // 只顯示有庫存和剩餘少量的尺寸
  const available = stockLines.filter(l => l.includes('✅') || l.includes('⚠️'));
  if (available.length === 0) return null;

  // 解析每行，格式: "顏色ZH(colorJP) 尺寸: ✅/⚠️ 說明"
  const parsed = available.map((line) => {
    const colonIdx = line.lastIndexOf(':');
    const labelPart = colonIdx !== -1 ? line.substring(0, colonIdx).trim() : line;
    const statusDesc = colonIdx !== -1 ? line.substring(colonIdx + 1).trim() : '';

    const jpMatch = labelPart.match(/\(([^)]+)\)/);
    const colorJp = jpMatch ? jpMatch[1] : '';
    const colorZh = jpMatch ? labelPart.substring(0, labelPart.indexOf('(')).trim() : labelPart.split(' ')[0];
    const afterColor = jpMatch ? labelPart.substring(labelPart.indexOf(')') + 1).trim() : '';
    const size = afterColor || 'FREE';
    const inStock = line.includes('✅');
    return { colorJp, colorZh, size, inStock, statusDesc };
  });

  // 依 colorJp 分組（保持第一次出現的順序）
  const colorOrder = [];
  const colorGroups = {};
  for (const item of parsed) {
    if (!colorGroups[item.colorJp]) {
      colorGroups[item.colorJp] = { colorZh: item.colorZh, sizes: [] };
      colorOrder.push(item.colorJp);
    }
    colorGroups[item.colorJp].sizes.push(item);
  }

  // 每個顏色建立一張 bubble
  const bubbles = colorOrder.slice(0, 10).map((colorJp) => {
    const group = colorGroups[colorJp];
    const colorLabel = group.colorZh ? `${group.colorZh}（${colorJp}）` : colorJp;

    // 每個尺寸：一行顯示尺寸+庫存說明，一個加入購物車按鈕
    const sizeRows = group.sizes.map((item) => {
      // statusDesc 已含 emoji（如「✅ 有庫存」），直接使用；沒有則產生預設值
      const statusText = item.statusDesc || (item.inStock ? '✅ 有庫存' : '⚠️ 剩餘少量');
      const btnLabel = '🛒 加入購物車';
      const displayText = `加入購物車：${item.colorZh || colorJp} ${item.size}`;
      const data = `action=add_to_cart&id=${productId}&c=${encodeURIComponent(colorJp)}&s=${encodeURIComponent(item.size)}&jpy=${jpy}&p=${suggested}`;
      return {
        type: 'box',
        layout: 'horizontal',
        alignItems: 'center',
        margin: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            flex: 3,
            contents: [
              { type: 'text', text: item.size, weight: 'bold', size: 'sm', color: '#333333' },
              { type: 'text', text: statusText, size: 'xs', color: item.inStock ? '#2e7d32' : '#e65100', wrap: true },
            ],
          },
          {
            type: 'button',
            flex: 2,
            height: 'sm',
            style: 'primary',
            color: item.inStock ? '#c8a882' : '#aaaaaa',
            action: { type: 'postback', label: btnLabel, data, displayText },
          },
        ],
      };
    });

    const bubble = {
      type: 'bubble',
      size: 'kilo',
      // 商品圖片放在 hero 欄位（語義正確，渲染效果最佳）
      ...(imageUrl ? {
        hero: {
          type: 'image',
          url: imageUrl,
          size: 'full',
          aspectRatio: '4:3',
          aspectMode: 'cover',
        },
      } : {}),
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        paddingBottom: '4px',
        spacing: 'none',
        contents: [
          // 商品名稱（有才顯示）
          ...(productName ? [{
            type: 'text',
            text: productName.substring(0, 30),
            size: 'xs',
            color: '#888888',
            wrap: true,
          }] : []),
          // 顏色
          { type: 'text', text: colorLabel, weight: 'bold', size: 'md', color: '#3d2c1e', wrap: true, margin: 'xs' },
          // 價格
          { type: 'text', text: `¥${jpy.toLocaleString()}　建議售價 NT$${suggested.toLocaleString()}`, size: 'xs', color: '#999999', margin: 'xs' },
          // 分隔線
          { type: 'separator', margin: 'md' },
          // 尺寸列表
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'none',
            contents: sizeRows,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '8px',
        contents: [{
          type: 'button',
          height: 'sm',
          style: 'link',
          color: '#999999',
          action: { type: 'uri', label: '回官方商品頁', uri: productUrl },
        }],
      },
    };
    return bubble;
  });

  if (bubbles.length === 1) {
    return {
      type: 'flex',
      altText: '選擇尺寸加入購物車',
      contents: bubbles[0],
    };
  }

  return {
    type: 'flex',
    altText: '選擇顏色與尺寸加入購物車',
    contents: {
      type: 'carousel',
      contents: bubbles,
    },
  };
}

// ── 建立 Flex Message ─────────────────────────────────────────────────────────
function buildFlexMessage(url, productName, jpy, suggested, stockLines, imageUrl, weightInfo) {
  const stockContents = stockLines.length > 0
    ? stockLines.map((line) => ({
        type: 'text',
        text: line,
        size: 'sm',
        color: '#555555',
        wrap: true,
      }))
    : [{
        type: 'text',
        text: '（無庫存資訊）',
        size: 'sm',
        color: '#aaaaaa',
      }];

  const bubble = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#FF6B9D',
      paddingAll: '14px',
      contents: [
        {
          type: 'text',
          text: '🌸 GRL 商品報價',
          color: '#ffffff',
          size: 'md',
          weight: 'bold',
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '14px',
      contents: [
        {
          type: 'text',
          text: productName,
          weight: 'bold',
          size: 'md',
          wrap: true,
          color: '#222222',
        },
        { type: 'separator' },
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: '💴 日幣',     size: 'sm', color: '#888888', flex: 2 },
            { type: 'text', text: `¥${fmtJPY(jpy)}`, size: 'sm', color: '#222222', flex: 3, align: 'end' },
          ],
        },
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: '💵 報價金額', size: 'sm', color: '#888888', flex: 2 },
            { type: 'text', text: `NT$${suggested}`, size: 'sm', weight: 'bold', color: '#E53935', flex: 3, align: 'end' },
          ],
        },
        { type: 'separator' },
        { type: 'text', text: '📦 庫存', size: 'sm', weight: 'bold', color: '#444444' },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          contents: stockContents,
        },
        ...(weightInfo ? [
          { type: 'separator' },
          { type: 'text', text: '⚖️ 估算重量', size: 'sm', weight: 'bold', color: '#444444' },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '磅 (lbs)', size: 'sm', color: '#888888', flex: 3 },
              { type: 'text', text: `${weightInfo.midLbs} lbs`, size: 'sm', color: '#222222', flex: 4, align: 'end' },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '公斤 (kg)', size: 'sm', color: '#888888', flex: 3 },
              { type: 'text', text: `${weightInfo.midKg} kg`, size: 'sm', color: '#222222', flex: 4, align: 'end' },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '信心程度', size: 'sm', color: '#888888', flex: 3 },
              {
                type: 'text',
                text: weightInfo.confidenceLabel === '高' ? '🟢 高' : weightInfo.confidenceLabel === '中' ? '🟡 中' : '🔴 低',
                size: 'sm', color: '#222222', flex: 4, align: 'end',
              },
            ],
          },
          {
            type: 'text',
            text: weightInfo.detail,
            size: 'xxs',
            color: '#aaaaaa',
            wrap: true,
          },
        ] : []),
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '10px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#FF6B9D',
          height: 'sm',
          action: {
            type: 'uri',
            label: '查看商品頁面',
            uri: url,
          },
        },
      ],
    },
  };

  // 有圖片時加入 hero
  if (imageUrl) {
    bubble.hero = {
      type: 'image',
      url: imageUrl,
      size: 'full',
      aspectRatio: '1:1',
      aspectMode: 'cover',
    };
  }

  return {
    type: 'flex',
    altText: `GRL 商品報價｜${productName}`,
    contents: bubble,
  };
}

// ── 處理單一 LINE 事件 ────────────────────────────────────────────────────────
async function handleEvent(event, client) {
  if (event.type === 'postback') {
    return handlePostback(event, client);
  }
  if (event.type !== 'message' || event.message.type !== 'text') return;

  console.log('userId:', event.source.userId);

  const userId    = event.source.userId;
  const userText  = event.message.text.trim();
  const replyToken = event.replyToken;

  const isGRL = /https?:\/\/(www\.)?grail\.bz\//i.test(userText);

  if (!isGRL) {
    await client.replyMessage(replyToken, { type: 'text', text: '請傳入 GRL 商品網址' });
    return;
  }

  const productId = extractProductId(userText) || '';

  let productData, rate;
  try {
    [productData, rate] = await Promise.all([scrapeGRL(userText), fetchRate()]);
  } catch (err) {
    console.error('[scrape error]', err.message);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '無法取得商品資訊，請確認網址是否正確',
    });
    if (userId === ADMIN_USER_ID) {
      const qStatus = productId ? `錯誤: ${err.message}` : '警告: 請確認 ID';
      appendProductToSheet(productId, '', 0, [], qStatus).catch((e) =>
        console.error('[sheets error-row write]', e.message)
      );
    }
    return;
  }

  const { productName, jpy, stockLines, imageUrl } = productData;
  const weightInfo  = estimateWeight(productName);
  const suggested   = calcSuggestedPrice(rate, jpy, weightInfo ? weightInfo.midLbs : 1);
  const qStatus     = calcQStatus(stockLines);

  let displayName = userId;
  try {
    const profile = await client.getProfile(userId);
    displayName = profile.displayName;
  } catch (e) {
    console.warn('[getProfile error]', e.message);
  }

  const flexMsg = buildFlexMessage(userText, productName, jpy, suggested, stockLines, imageUrl, weightInfo);
  const cartFlex = buildAddToCartFlex(stockLines, productId, jpy, suggested, userText, imageUrl, productName);
  await client.replyMessage(replyToken, cartFlex ? [flexMsg, cartFlex] : [flexMsg]);

  const bgTasks = [];

  if (userId === ADMIN_USER_ID) {
    bgTasks.push(
      appendProductToSheet(productId, productName, jpy, stockLines, qStatus, weightInfo).catch((e) =>
        console.error('[sheets append error]', e.message)
      )
    );
  }

  bgTasks.push(
    logQueryToSheet(userId, displayName, productId, productName, jpy, weightInfo).catch((e) =>
      console.error('[sheets log error]', e.message)
    )
  );

  await Promise.all(bgTasks);
}

// ── Webhook 路由 ──────────────────────────────────────────────────────────────
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-line-signature'];

  if (
    !signature ||
    !line.validateSignature(req.body, process.env.LINE_CHANNEL_SECRET, signature)
  ) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const client = new line.Client({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  });

  try {
    await Promise.all(
      (body.events || []).map((event) => handleEvent(event, client))
    );
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[webhook error]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 健康檢查 ──────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'GRL LINE Bot is running' });
});

// ── LIFF 購物車頁面 ───────────────────────────────────────────────────────────
app.get('/cart', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildCartHtml());
});

// ── 購物車 API ────────────────────────────────────────────────────────────────
// ── 7-11 門市 Proxy ───────────────────────────────────────────────────────────
app.get('/api/stores', async (req, res) => {
  const { city, area } = req.query;
  if (!city || !area) return res.status(400).json({ error: 'city and area required' });
  try {
    const url = `https://emacloz.com/posts/fetch_area_data_from_django?cityName=${encodeURIComponent(city)}&areaName=${encodeURIComponent(area)}`;
    const r = await axios.get(url, { headers: { 'Referer': 'https://emacloz.com', 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    res.json(r.data);
  } catch (err) {
    console.error('[api/stores error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cart', express.json(), async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const items = await getCartItems(userId);
    res.json({ items });
  } catch (err) {
    console.error('[api/cart error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cart/item', express.json(), async (req, res) => {
  const { rowIndex } = req.body;
  if (!rowIndex) return res.status(400).json({ error: 'rowIndex required' });
  try {
    await clearCartItem(rowIndex);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/order', express.json(), async (req, res) => {
  const { userId, cartItems, buyerInfo } = req.body;
  if (!userId || !cartItems || !buyerInfo) return res.status(400).json({ error: 'missing fields' });
  try {
    const result = await submitOrder(userId, cartItems, buyerInfo);
    // 推播通知管理員
    const client = new line.Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
    const itemsText = cartItems.map(i => `・${i.productId} ${i.color} ${i.size} NT$${i.suggestedPrice}`).join('\n');
    await client.pushMessage(ADMIN_USER_ID, {
      type: 'text',
      text: `🛍 新訂單！\n訂單ID: ${result.orderId}\n時間: ${result.orderTime}\n━━━━━━━━━━\n${itemsText}\n━━━━━━━━━━\n合計: NT$${result.totalTwd}\n\n買家: ${buyerInfo.name}\n手機: ${buyerInfo.phone}\n7-11門市: ${buyerInfo.store711}\n匯款末5碼: ${buyerInfo.bankLast5}${buyerInfo.note ? '\n備註: ' + buyerInfo.note : ''}`,
    }).catch(e => console.error('[admin notify error]', e.message));
    res.json({ status: 'ok', orderId: result.orderId });
  } catch (err) {
    console.error('[api/order error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 一次性：在工作表1 插入新 J 欄「估算磅數（估算值）」──────────────────────
// 呼叫方式：GET /admin/insert-weight-column
// 只需執行一次，之後新增列就會自動填入 J 欄
app.get('/admin/insert-weight-column', async (req, res) => {
  try {
    const sheets = getSheetsClient();

    // 取得工作表1 的 sheetId
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheet = meta.data.sheets.find((s) => s.properties.title === '工作表1');
    if (!sheet) return res.status(404).json({ error: '找不到工作表1' });
    const sheetId = sheet.properties.sheetId;

    // 在第 9 欄（0-based = index 9 = J欄）插入 1 欄
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: 9,  // J 欄（0-based）
                endIndex: 10,
              },
              inheritFromBefore: false,
            },
          },
        ],
      },
    });

    // 在新 J1 寫入欄位標題
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: '工作表1!J1',
      valueInputOption: 'RAW',
      resource: { values: [['估算磅數（估算值）']] },
    });

    res.json({ status: 'ok', message: '已在 J 欄插入「估算磅數（估算值）」，舊有公式已自動更新' });
  } catch (err) {
    console.error('[insert-column error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 一次性：建立並啟用 Rich Menu ──────────────────────────────────────────────
// 呼叫方式：GET /admin/setup-rich-menu?imageUrl=https://...
app.get('/admin/setup-rich-menu', async (req, res) => {
  const { imageUrl } = req.query;
  try {
    const richMenuId = await setupRichMenu(imageUrl || '');
    res.json({ status: 'ok', richMenuId, message: 'Rich Menu 已建立並設為預設選單' });
  } catch (err) {
    console.error('[setup-rich-menu error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 本地開發啟動 ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

module.exports = app;
