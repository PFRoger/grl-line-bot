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
const ADMIN_KEY = process.env.ADMIN_KEY || 'grl-admin-2026';

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

// ── 從網址擷取商品 ID（去掉顏色後綴 4 碼，例如 ru14381119→ru1438）────────────
// 只有去掉後仍保有數字（即 ru\d+）才執行截短，避免把 ru1197 截成 ru
function extractProductId(url) {
  const m = url.match(/\/item\/([a-z]{2}\d+)/i);
  if (!m) return null;
  const raw = m[1];
  const stripped = raw.replace(/\d{4}$/, '');
  const result = /^[a-z]{2}\d+$/i.test(stripped) ? stripped : raw;
  return result.toUpperCase();
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
// GRL 部分商品只有 /disp/item/ 路徑，/item/ 會 404；自動 fallback
async function scrapeGRL(url) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'ja,zh-TW;q=0.9,zh;q=0.8,en-US;q=0.7',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  };
  let html;
  try {
    ({ data: html } = await axios.get(url, { timeout: 12000, headers }));
  } catch (err) {
    // 若 /item/ 路徑 404，改用 /disp/item/ 重試
    if (err.response && err.response.status === 404) {
      const dispUrl = url.replace(/\/(item\/)/, '/disp/item/');
      if (dispUrl !== url) {
        ({ data: html } = await axios.get(dispUrl, { timeout: 12000, headers }));
      } else throw err;
    } else throw err;
  }

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

  // 商品主圖：從 og:image 取得
  const imageUrl = $('meta[property="og:image"]').attr('content') || null;

  // 庫存：使用 GAS 相同的 raw HTML regex 解析法
  const stockLines = parseStockFromHtml(html);

  // 每個顏色的對應圖片：GRL 用 <img alt="ブラック" src="...col_11.jpg"> 方式關聯顏色
  // 縮圖路徑 /images/goods/t/ → 全尺寸改為 /images/goods/d/
  const colorImages = {};
  $('img[alt]').each((_, el) => {
    const alt = $(el).attr('alt') || '';
    const src = $(el).attr('data-src') || $(el).attr('data-lazy') || $(el).attr('src') || '';
    if (!src) return;
    for (const colorJp of COLOR_KEYS) {
      if (colorImages[colorJp]) continue;
      if (!alt.includes(colorJp)) continue;
      // 縮圖 /t/ 換成全圖 /d/
      const fullUrl = src
        .replace('/images/goods/t/', '/images/goods/d/')
        .replace(/^\/\//, 'https://')
        .replace(/^\//, 'https://cdn.grail.bz/');
      colorImages[colorJp] = fullUrl.startsWith('http') ? fullUrl : `https://cdn.grail.bz${fullUrl}`;
    }
  });

  return { productName, jpy, stockLines, imageUrl, colorImages };
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
//       G估算磅數(lbs) H估算公斤(kg) I信心程度 J說明 K圖片URL L報價 M商品URL
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
// 欄位：A=userId B=productId C=productName D=color(JP) E=size
//        F=jpy G=suggestedPrice H=productUrl I=addedAt J=status K=imageUrl
const CART_HEADERS = ['userId','productId','productName','color','size','jpy','suggestedPrice','productUrl','addedAt','status','imageUrl'];

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
      resource: { values: [['訂單ID','下單時間','userId','商品明細','總金額(NT$)','買家姓名','手機','聯繫方式','聯繫帳號','備註','狀態']] },
    });
  }
}

async function addToCartSheet(userId, productId, productName, colorJp, size, jpy, suggestedPrice, productUrl, imageUrl = '') {
  const sheets = getSheetsClient();
  await ensureCartSheet(sheets);
  const addedAt = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${CART_SHEET}!A:K`,
    valueInputOption: 'RAW',
    resource: { values: [[userId, productId, productName, colorJp, size, jpy, suggestedPrice, productUrl, addedAt, 'active', imageUrl]] },
  });
}

async function getCartItems(userId) {
  const sheets = getSheetsClient();
  let resp;
  try {
    resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${CART_SHEET}!A:K` });
  } catch {
    return []; // 工作表尚未建立，視為空購物車
  }
  const rows = (resp && resp.data.values) || [];
  const now = Date.now();
  const EXPIRE_MS = 48 * 60 * 60 * 1000; // 48 hours
  const items = [];
  rows.forEach((row, idx) => {
    if (idx === 0) return; // header
    if (row[0] !== userId) return;
    if (row[9] !== 'active') return;
    const addedAt = new Date(row[8]).getTime();
    if (now - addedAt > EXPIRE_MS) return; // expired
    const colorJp = row[3] || '';
    items.push({
      rowIndex: idx + 1, // 1-based sheet row
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
  await Promise.all(rowIndexes.map((idx) =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${CART_SHEET}!J${idx}`,
      valueInputOption: 'RAW',
      resource: { values: [['ordered']] },
    })
  ));
}

async function submitOrder(userId, cartItems, buyerInfo) {
  const sheets = getSheetsClient();
  await ensureOrderSheet(sheets);
  // 21碼英數字訂單號：9碼時間戳(base36) + 12碼隨機英數
  const tsBase36 = Date.now().toString(36).padStart(9, '0');
  const randChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const randPart = Array.from({length: 12}, () => randChars[Math.floor(Math.random() * randChars.length)]).join('');
  const orderId = (tsBase36 + randPart).toUpperCase();
  const orderTime = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  // 合併相同商品（productId+color+size），顯示數量
  const itemMap = {};
  for (const i of cartItems) {
    const key = `${i.productId}|${i.color}|${i.size}`;
    if (!itemMap[key]) itemMap[key] = { ...i, qty: 0 };
    itemMap[key].qty += 1;
  }
  const totalQty = cartItems.length;
  const itemsSummary = Object.values(itemMap)
    .map(i => `${(i.productId||'').toUpperCase()} ${translateColorWithJp(i.color)} ${i.size} NT$${i.suggestedPrice}${i.qty > 1 ? ` ×${i.qty}` : ''}`)
    .join('\n') + `\n共 ${totalQty} 件`;
  const totalTwd = cartItems.reduce((sum, i) => sum + (i.suggestedPrice || 0), 0);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${ORDER_SHEET}!A:K`,
    valueInputOption: 'RAW',
    resource: { values: [[
      orderId, orderTime, userId,
      itemsSummary, totalTwd,
      buyerInfo.name, buyerInfo.phone, buyerInfo.contactMethod || '',
      buyerInfo.contactAccount || '', buyerInfo.note || '', '待確認',
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
    range: '查詢紀錄!A:M',
  });
  const rows = (res.data.values || []).slice(1); // 跳過 header
  const userRows = rows.filter((r) => r[2] === userId);
  // 從最新往回掃，每個 productId 只保留最近一筆（去重），最多 12 筆
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
  return deduped; // 已是最新在前
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
    const date      = row[0] || '';
    const prodName  = row[4] || '商品名稱不明';
    const jpyText   = row[5] ? `¥${Number(row[5]).toLocaleString('ja-JP')}` : '-';
    const prodId    = row[3] || '';
    const imgUrl      = row[10] || '';
    const suggested   = row[11] ? `NT$${Number(row[11]).toLocaleString()}` : '';
    const storedUrl   = row[12] || '';
    const itemUrl     = prodId ? `https://www.grail.bz/disp/item/${prodId}/` : 'https://www.grail.bz';
    // 重新查詢用原始儲存 URL；若舊紀錄沒有，以 prodId 推算
    const requeryUrl  = storedUrl || (prodId ? `https://www.grail.bz/item/${prodId}/` : '');

    const priceContents = [
      { type: 'text', text: jpyText, size: 'sm', color: '#888888' },
      ...(suggested ? [{ type: 'text', text: suggested, size: 'md', weight: 'bold', color: '#E53935' }] : []),
      { type: 'text', text: date, size: 'xs', color: '#aaaaaa', margin: 'sm' },
    ];

    const bubble = {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: '12px',
        contents: [
          { type: 'text', text: prodName, size: 'sm', weight: 'bold', wrap: true, maxLines: 2, color: '#222222' },
          ...priceContents,
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '8px',
        spacing: 'xs',
        contents: [
          ...(requeryUrl ? [{
            type: 'button',
            style: 'primary',
            color: '#b8895a',
            height: 'sm',
            action: {
              type: 'message',
              label: '🔄 重新查詢報價',
              text: requeryUrl,
            },
          }] : []),
          {
            type: 'button',
            style: 'link',
            color: '#aaaaaa',
            height: 'sm',
            action: { type: 'uri', label: '查看商品頁', uri: itemUrl },
          },
        ],
      },
    };

    if (imgUrl) {
      bubble.hero = {
        type: 'image',
        url: imgUrl,
        size: 'full',
        aspectRatio: '3:4',
        aspectMode: 'cover',
      };
    }

    return bubble;
  });

  return {
    type: 'flex',
    altText: `您的查詢紀錄（${history.length} 件商品）`,
    contents: { type: 'carousel', contents: bubbles },
  };
}

// ── 使用教學 Flex Message ─────────────────────────────────────────────────────
function buildTutorialFlexMessage() {
  const steps = [
    {
      title: 'Step 1｜查詢商品報價',
      icon: '🔍',
      color: '#c8845a',
      lines: [
        '① 前往 GRL 官網找到喜歡的商品',
        '② 複製網址，貼到這裡',
        '③ Bot 立即回傳：',
        '   • 台幣報價（含代購費 + 運費）',
        '   • 各顏色 / 尺寸庫存狀態',
        '',
        '✅ 有庫存　⚠️ 剩餘少量',
        '📅 預約販售　❌ 缺貨',
      ],
    },
    {
      title: 'Step 2｜加入購物車',
      icon: '🛒',
      color: '#b8895a',
      lines: [
        '看到商品報價後，滑動卡片',
        '選擇喜歡的顏色',
        '',
        '點按尺寸按鈕即可加入購物車',
        '（可多件商品一起結帳）',
        '',
        '⚠️ 購物車內容 48 小時後',
        '    自動清空，請盡早結帳',
      ],
    },
    {
      title: 'Step 3｜送出訂單',
      icon: '📋',
      color: '#8b9a7a',
      lines: [
        '點主選單「購物車」開啟結帳頁',
        '',
        '① 確認商品與數量（可增減）',
        '② 點「訂單送出」',
        '',
        '送出後請稍待，',
        '我們確認後會傳送付款連結給您',
      ],
    },
    {
      title: 'Step 4｜付款 & 取件',
      icon: '💳',
      color: '#7a8fb5',
      lines: [
        '收到我們傳送的付款連結後',
        '點開連結完成付款即可',
        '',
        '確認收款後我們向日本下單',
        '商品到台灣後再通知您取件',
        '',
        '有任何問題歡迎直接留言 🌸',
      ],
    },
  ];

  const bubbles = steps.map((s) => ({
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: s.color,
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
        color: (l.startsWith('✅') || l.startsWith('⚠️') || l.startsWith('📅') || l.startsWith('❌'))
          ? '#777777' : '#333333',
        wrap: true,
      })),
    },
  }));

  return {
    type: 'flex',
    altText: '購物指南｜查詢．加購物車．下單．取件',
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

  } else if (action === 'out_of_stock') {
    const size = params.get('s') || '';
    await client.replyMessage(replyToken, {
      type: 'text',
      text: `😔 ${size} 目前缺貨，請選擇其他尺寸。`,
    });

  } else if (action === 'add_to_cart') {
    const productId    = params.get('id') || '';
    const colorJp      = params.get('c') || '';
    const size         = params.get('s') || '';
    const jpy          = parseInt(params.get('jpy')) || 0;
    const suggested    = parseInt(params.get('p')) || 0;
    const productUrl   = params.get('url') || `https://www.grail.bz/item/${productId}/`;
    const imgUrl       = params.get('img') || '';

    // 從查詢紀錄找商品名稱
    let productName = productId;
    try {
      const sheets = getSheetsClient();
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: '查詢紀錄!A:E' });
      const rows = (resp.data.values || []).reverse();
      const found = rows.find(r => r[3] === productId);
      if (found) productName = found[4] || productId;
    } catch (e) { console.warn('[lookup name error]', e.message); }

    await addToCartSheet(userId, productId, productName, colorJp, size, jpy, suggested, productUrl, imgUrl);
    const colorDisplay = translateColorWithJp(colorJp);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: `✅ 已加入購物車\n商品：${productName || productId}\n\n顏色：${colorDisplay}\n尺寸：${size}\n\n售價：NT$${suggested}\n\n請按下方主選單「購物車」查看內容\n════════════\n購物車每 48 小時自動清空`,
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
.cart-item{border:1px solid #eee;border-radius:8px;padding:12px;margin-bottom:10px;display:flex;gap:10px;position:relative}
.item-img{width:64px;height:85px;object-fit:cover;border-radius:6px;background:#f5f0ec;flex-shrink:0}
.item-info{flex:1;min-width:0}
.item-name{font-size:13px;color:#888;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item-detail{font-size:14px;font-weight:600;color:#333}
.item-price{font-size:14px;font-weight:bold;color:#c9a98a;margin-top:4px}
.qty-ctrl{display:flex;align-items:center;gap:10px;margin-top:8px}
.qty-btn{width:30px;height:30px;border:1px solid #c9a98a;border-radius:6px;background:#fff;color:#c9a98a;font-size:20px;font-weight:bold;cursor:pointer;line-height:1;padding:0}
.qty-btn:active{background:#f5ede4}
.qty-num{font-size:16px;font-weight:bold;color:#333;min-width:20px;text-align:center}
.empty{text-align:center;color:#aaa;padding:30px 0;font-size:14px}
.total-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:14px}
.total-amount{font-size:18px;font-weight:bold;color:#c9a98a}
label{display:block;font-size:13px;color:#888;margin-bottom:4px;margin-top:12px}
input,select,textarea{width:100%;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;outline:none}
input[type="radio"]{width:auto;border:none;padding:0;margin:0;border-radius:0;box-shadow:none}
input:focus,select:focus,textarea:focus{border-color:#c9a98a}
.hist-wrap{position:relative}
.hist-drop{position:absolute;left:0;right:0;top:calc(100% + 2px);background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.12);z-index:999;overflow:hidden}
.hist-item{padding:10px 12px;font-size:14px;color:#333;cursor:pointer;border-bottom:1px solid #f5f5f5}
.hist-item:last-child{border-bottom:none}
.hist-item:active{background:#fff8f0}
.radio-group{display:flex;flex-direction:row;gap:16px;margin-top:6px;margin-bottom:8px}
.radio-item{display:flex;align-items:center;gap:6px;font-size:14px;color:#333;font-weight:normal;margin:0;cursor:pointer}
.submit-btn{width:100%;background:#c9a98a;color:#fff;border:none;border-radius:10px;padding:14px;font-size:16px;font-weight:bold;cursor:pointer;margin-top:16px;letter-spacing:1px}
.submit-btn:disabled{background:#ccc}
.submit-btn:active{background:#b8906e}
.note-box{background:#fff8f0;border-radius:8px;padding:10px;font-size:12px;color:#888;margin-top:8px;line-height:1.6}
.item-jpy{font-size:12px;color:#aaa;margin-top:2px}
#loading{text-align:center;padding:40px;color:#aaa}
#success{display:none;text-align:center;padding:30px}
#confirm-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:999;align-items:center;justify-content:center}
#confirm-box{background:#fff;border-radius:14px;padding:24px 20px;margin:24px;text-align:center;max-width:280px;width:100%}
#confirm-msg{font-size:15px;color:#333;margin-bottom:20px;line-height:1.5}
.confirm-btns{display:flex;gap:12px}
.confirm-btn-cancel{flex:1;padding:12px;border:1px solid #ddd;border-radius:8px;background:#fff;font-size:15px;color:#666;cursor:pointer}
.confirm-btn-ok{flex:1;padding:12px;border:none;border-radius:8px;background:#c9a98a;color:#fff;font-size:15px;font-weight:bold;cursor:pointer}
.success-icon{font-size:48px;margin-bottom:12px}
.success-title{font-size:18px;font-weight:bold;color:#c9a98a;margin-bottom:8px}
.success-text{font-size:13px;color:#888;line-height:1.6}
#alert-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:1000;align-items:center;justify-content:center}
#alert-box{background:#fff;border-radius:14px;padding:24px 20px;margin:24px;text-align:center;max-width:280px;width:100%}
#alert-msg{font-size:15px;color:#333;margin-bottom:20px;line-height:1.5}
.alert-btn-ok{width:100%;padding:12px;border:none;border-radius:8px;background:#c9a98a;color:#fff;font-size:15px;font-weight:bold;cursor:pointer}
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
    <div class="note-box">送出後，我們將盡快提供賣貨便下單連結</div>
  </div>
  <div id="buyer-section" class="section" style="display:none">
    <div class="section-title">訂貨人資訊</div>
    <label>姓名 *</label>
    <div class="hist-wrap"><input id="f-name" type="text" placeholder="請輸入真實姓名" autocomplete="off" onfocus="showHist(this,'name')" onblur="hideHist()"></div>
    <label>手機號碼 *</label>
    <div class="hist-wrap"><input id="f-phone" type="tel" placeholder="09xxxxxxxx" autocomplete="off" onfocus="showHist(this,'phone')" onblur="hideHist()"></div>
    <label>聯繫方式 *</label>
    <div class="radio-group" style="margin-bottom:6px">
      <label class="radio-item"><input type="radio" name="contact-method" value="IG"> IG</label>
      <label class="radio-item"><input type="radio" name="contact-method" value="LINE"> LINE</label>
    </div>
    <div class="hist-wrap"><input id="f-contact-account" type="text" placeholder="請輸入帳號" autocomplete="off" onfocus="showHist(this,'contactAccount')" onblur="hideHist()"></div>
    <label>備註（選填）</label>
    <div class="hist-wrap"><textarea id="f-note" rows="2" placeholder="特殊需求或備註" autocomplete="off" onfocus="showHist(this,'note')" onblur="hideHist()"></textarea></div>
    <button class="submit-btn" id="submit-btn" onclick="submitOrder()">訂單送出</button>
  </div>
</div>
<div id="success">
  <div class="success-icon">🎉</div>
  <div class="success-title">下單成功！</div>
  <div class="success-text" id="success-text"></div>
</div>
<div id="confirm-overlay" style="display:none">
  <div id="confirm-box">
    <div id="confirm-msg"></div>
    <div class="confirm-btns">
      <button class="confirm-btn-cancel" onclick="onConfirmBtn(false)">取消</button>
      <button class="confirm-btn-ok" onclick="onConfirmBtn(true)">確定</button>
    </div>
  </div>
</div>
<div id="alert-overlay" style="display:none">
  <div id="alert-box">
    <div id="alert-msg"></div>
    <button class="alert-btn-ok" onclick="closeAlert()">確定</button>
  </div>
</div>
<script>
let userId = '';
let cartItems = [];
let groupedItems = [];
const imageCache = {}; // key: productId|color → imageUrl
let _confirmCb = null;
// ── 欄位歷史記錄（autocomplete）──
function getHist(key) {
  try { return JSON.parse(localStorage.getItem('bijin_h_' + key) || '[]'); } catch(e) { return []; }
}
function saveHist(key, val) {
  if (!val) return;
  let arr = getHist(key).filter(x => x !== val);
  arr.unshift(val);
  arr = arr.slice(0, 3);
  localStorage.setItem('bijin_h_' + key, JSON.stringify(arr));
}
let _hideHistTimer = null;
function showHist(input, key) {
  clearTimeout(_hideHistTimer);
  // remove any existing dropdown
  const old = input.parentNode.querySelector('.hist-drop');
  if (old) old.remove();
  const arr = getHist(key);
  if (!arr.length) return;
  const drop = document.createElement('div');
  drop.className = 'hist-drop';
  arr.forEach(v => {
    const item = document.createElement('div');
    item.className = 'hist-item';
    item.textContent = v;
    item.addEventListener('mousedown', e => {
      e.preventDefault(); // prevent blur before click
      input.value = v;
      drop.remove();
    });
    drop.appendChild(item);
  });
  input.parentNode.appendChild(drop);
}
function hideHist() {
  _hideHistTimer = setTimeout(() => {
    document.querySelectorAll('.hist-drop').forEach(d => d.remove());
  }, 150);
}
function showAlert(msg) {
  document.getElementById('alert-msg').innerHTML = msg;
  document.getElementById('alert-overlay').style.display = 'flex';
}
function closeAlert() {
  document.getElementById('alert-overlay').style.display = 'none';
}
function showConfirm(group) {
  return new Promise(resolve => {
    _confirmCb = resolve;
    const imgKey = group.productId + '|' + group.color;
    const imgUrl = imageCache[imgKey] || group.imageUrl || '';
    document.getElementById('confirm-msg').innerHTML =
      (imgUrl ? \`<img src="\${imgUrl}" style="width:72px;height:96px;object-fit:cover;border-radius:8px;margin-bottom:10px"><br>\` : '') +
      \`<strong style="font-size:14px;color:#333">\${group.productName ? group.productName.substring(0,28) : group.productId}</strong><br>\` +
      \`<span style="font-size:13px;color:#888">\${group.colorDisplay || group.color}　\${group.size}</span><br><br>\` +
      \`<span style="font-size:14px;color:#555">確定要移除此商品嗎？</span>\`;
    document.getElementById('confirm-overlay').style.display = 'flex';
  });
}
function onConfirmBtn(result) {
  document.getElementById('confirm-overlay').style.display = 'none';
  if (_confirmCb) { _confirmCb(result); _confirmCb = null; }
}

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

function groupCartItems(items) {
  const groups = {};
  const order = [];
  items.forEach(item => {
    const key = item.productId + '|' + item.color + '|' + item.size;
    if (!groups[key]) {
      groups[key] = Object.assign({}, item, { quantity: 0, rowIndexes: [] });
      order.push(key);
    }
    groups[key].quantity++;
    groups[key].rowIndexes.push(item.rowIndex);
  });
  return order.map(k => groups[k]);
}

function render() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('main').style.display = 'block';
  const el = document.getElementById('cart-items');
  el.innerHTML = '';
  groupedItems = groupCartItems(cartItems);
  if (groupedItems.length === 0) {
    document.getElementById('cart-empty').style.display = 'block';
    document.getElementById('order-section').style.display = 'none';
    document.getElementById('buyer-section').style.display = 'none';
    return;
  }
  document.getElementById('cart-empty').style.display = 'none';
  document.getElementById('order-section').style.display = 'block';
  document.getElementById('buyer-section').style.display = 'block';
  let total = 0;
  groupedItems.forEach((group, idx) => {
    const subtotal = (group.suggestedPrice || 0) * group.quantity;
    total += subtotal;
    const priceText = group.quantity > 1
      ? \`NT$\${group.suggestedPrice} × \${group.quantity} = NT$\${subtotal}\`
      : \`NT$\${group.suggestedPrice}\`;
    el.innerHTML += \`<div class="cart-item" id="item-\${idx}">
      <img class="item-img" id="img-\${idx}" src="" alt="">
      <div class="item-info">
        <div class="item-name">\${(group.productId||'').toUpperCase()}　\${group.productName ? group.productName.substring(0,20) : ''}</div>
        <div class="item-detail">\${group.colorDisplay || group.color}　\${group.size}</div>
        <div class="item-jpy">¥\${(group.jpy||0).toLocaleString()}</div>
        <div class="item-price">\${priceText}</div>
        <div class="qty-ctrl">
          <button class="qty-btn" onclick="changeQty(\${idx},-1)">−</button>
          <span class="qty-num">\${group.quantity}</span>
          <button class="qty-btn" onclick="changeQty(\${idx},+1)">＋</button>
        </div>
      </div>
    </div>\`;
  });
  document.getElementById('total-amount').textContent = 'NT$' + total;
  loadItemImages();
}

async function loadCartSilent() {
  try {
    const resp = await fetch('/api/cart?userId=' + userId);
    const data = await resp.json();
    cartItems = data.items || [];
    groupedItems = groupCartItems(cartItems); // 更新 rowIndexes，但不重繪
  } catch(e) {}
}

let syncTimer = null;
function scheduleSilentSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(loadCartSilent, 1000); // 停止按壓 1 秒後才同步
}

async function changeQty(idx, delta) {
  const group = groupedItems[idx];
  if (delta === -1) {
    if (group.quantity === 1) {
      const ok = await showConfirm(group);
      if (!ok) return;
    }
    let removeIdx = -1;
    for (let i = cartItems.length - 1; i >= 0; i--) {
      if (cartItems[i].productId === group.productId && cartItems[i].color === group.color && cartItems[i].size === group.size) {
        removeIdx = i; break;
      }
    }
    if (removeIdx === -1) return;
    const rowIndex = group.rowIndexes[group.rowIndexes.length - 1];
    cartItems.splice(removeIdx, 1);
    render();
    fetch('/api/cart/item', { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({rowIndex}) })
      .catch(() => {});
  } else {
    cartItems.push({ rowIndex: -1, productId: group.productId, productName: group.productName,
      color: group.color, colorDisplay: group.colorDisplay, size: group.size,
      jpy: group.jpy, suggestedPrice: group.suggestedPrice, productUrl: group.productUrl,
      imageUrl: group.imageUrl, addedAt: new Date().toISOString() });
    render();
    fetch('/api/cart/add', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ userId, productId: group.productId, productName: group.productName,
        color: group.color, size: group.size, jpy: group.jpy,
        suggestedPrice: group.suggestedPrice, productUrl: group.productUrl, imageUrl: group.imageUrl }) })
      .catch(() => {});
  }
  scheduleSilentSync(); // 每次按壓後重置計時器，停止後才同步一次
}

async function loadItemImages() {
  // 先把 sheet 中已存的 imageUrl 填入 cache
  groupedItems.forEach((item) => {
    const key = item.productId + '|' + item.color;
    if (!imageCache[key] && item.imageUrl) imageCache[key] = item.imageUrl;
  });
  // 套用 cache（含剛填入的）
  groupedItems.forEach((item, idx) => {
    const key = item.productId + '|' + item.color;
    if (imageCache[key]) {
      const imgEl = document.getElementById('img-' + idx);
      if (imgEl) imgEl.src = imageCache[key];
    }
  });
  // 只有 cache 沒有的才呼叫 API（舊資料沒存 imageUrl 的 fallback）
  const toFetch = {};
  groupedItems.forEach((item) => {
    const key = item.productId + '|' + item.color;
    if (!imageCache[key] && !toFetch[key]) {
      toFetch[key] = item.productUrl
        ? '/api/item-image?url=' + encodeURIComponent(item.productUrl) + '&c=' + encodeURIComponent(item.color)
        : '/api/item-image?id=' + encodeURIComponent(item.productId) + '&c=' + encodeURIComponent(item.color);
    }
  });
  if (Object.keys(toFetch).length === 0) return;
  await Promise.all(Object.entries(toFetch).map(async ([key, apiUrl]) => {
    try {
      const resp = await fetch(apiUrl);
      const data = await resp.json();
      imageCache[key] = data.imageUrl || '';
    } catch(e) { imageCache[key] = ''; }
  }));
  groupedItems.forEach((item, idx) => {
    const key = item.productId + '|' + item.color;
    if (imageCache[key]) {
      const imgEl = document.getElementById('img-' + idx);
      if (imgEl) imgEl.src = imageCache[key];
    }
  });
}

async function submitOrder() {
  const name = document.getElementById('f-name').value.trim();
  const phone = document.getElementById('f-phone').value.trim();
  const contactMethodEl = document.querySelector('input[name="contact-method"]:checked');
  const contactMethod = contactMethodEl ? contactMethodEl.value : '';
  const contactAccount = document.getElementById('f-contact-account').value.trim();
  const note = document.getElementById('f-note').value.trim();
  if (!name || !phone || !contactMethod || !contactAccount) { showAlert('請填寫所有必填欄位 (*)'); return; }
  if (!/^09\\d{8}$/.test(phone)) { showAlert('手機號碼格式不正確'); return; }
  const btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = '送出中...';
  try {
    // 儲存各欄位歷史記錄到 localStorage
    saveHist('name', name);
    saveHist('phone', phone);
    saveHist('contactAccount', contactAccount);
    saveHist('note', note);
    const resp = await fetch('/api/order', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ userId, cartItems, buyerInfo:{ name, phone, contactMethod, contactAccount, note } })
    });
    const data = await resp.json();
    if (data.orderId) {
      document.getElementById('main').style.display = 'none';
      document.getElementById('success').style.display = 'block';
      document.getElementById('success-text').innerHTML =
        '訂單編號：' + data.orderId + '<br><br>我們將盡快確認您的訂單並提供賣貨便連結<br><br>如有問題請至官方 IG <span onclick="copyIG()" style="text-decoration:underline;cursor:pointer;color:#7a8fb5">bijin.jp.2024</span> 傳訊息給我們 🌸';
    } else {
      showAlert('下單失敗，請稍後再試');
      btn.disabled = false; btn.textContent = '訂單送出';
    }
  } catch(e) {
    showAlert('下單失敗，請稍後再試');
    btn.disabled = false; btn.textContent = '訂單送出';
  }
}

init();

function copyIG() {
  navigator.clipboard.writeText('bijin.jp.2024').then(() => {
    showAlert('已複製！<br><b>bijin.jp.2024</b>');
  }).catch(() => {
    showAlert('請手動複製 IG 帳號：<br><b>bijin.jp.2024</b>');
  });
}
</script>
</body>
</html>`;
}

// ── 建立加入購物車按鈕 Flex（Carousel，每個顏色一張卡片）──────────────────────
function buildAddToCartFlex(stockLines, productId, jpy, suggested, productUrl, imageUrl, productName, colorImages = {}) {
  // 至少要有一行庫存資訊（含缺貨）才顯示
  if (stockLines.length === 0) return null;
  // 若全為純缺貨則不顯示
  const hasAvailable = stockLines.some(l => l.includes('✅') || l.includes('⚠️') || l.includes('📅'));
  if (!hasAvailable) return null;

  // 解析所有行（含缺貨），格式: "顏色ZH(colorJP) 尺寸: ✅/⚠️/❌ 說明"
  const parsed = stockLines.map((line) => {
    const colonIdx = line.lastIndexOf(':');
    const labelPart = colonIdx !== -1 ? line.substring(0, colonIdx).trim() : line;
    const statusDesc = colonIdx !== -1 ? line.substring(colonIdx + 1).trim() : '';

    const jpMatch = labelPart.match(/\(([^)]+)\)/);
    const colorJp = jpMatch ? jpMatch[1] : '';
    const colorZh = jpMatch ? labelPart.substring(0, labelPart.indexOf('(')).trim() : labelPart.split(' ')[0];
    const afterColor = jpMatch ? labelPart.substring(labelPart.indexOf(')') + 1).trim() : '';
    const size = afterColor || 'FREE';
    const inStock = line.includes('✅');
    const isPreorder = line.includes('📅');
    const isLowStock = line.includes('⚠️');
    const isOutOfStock = line.includes('❌');
    return { colorJp, colorZh, size, inStock, isPreorder, isLowStock, isOutOfStock, statusDesc };
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

    // 每個尺寸：缺貨顯示文字列，有庫存/預約/少量顯示按鈕
    const sizeRows = group.sizes.map((item) => {
      if (item.isOutOfStock) {
        // 缺貨：灰色按鈕，點擊後提示缺貨
        const outLabel = Array.from(`❌ ${item.size} 缺貨`).slice(0, 20).join('');
        return {
          type: 'button',
          height: 'sm',
          style: 'primary',
          color: '#c8bbb0',
          margin: 'xs',
          action: {
            type: 'postback',
            label: outLabel,
            data: `action=out_of_stock&s=${encodeURIComponent(item.size)}`,
            displayText: `${item.size} 目前缺貨`,
          },
        };
      }
      // 從 statusDesc 提取預約到貨月份（如「5月下旬」）
      let shortDate = '';
      if (item.isPreorder && item.statusDesc) {
        const dateMatch = item.statusDesc.match(/(\d+月[^\s）()（]+)/);
        if (dateMatch) shortDate = dateMatch[1];
      }
      const shortStatus = item.inStock ? '有庫存' : item.isPreorder
        ? (shortDate ? `預約${shortDate}` : '預約販售')
        : '剩餘少量';
      // Array.from 確保 emoji(🛒) 算 1 個字元，不會超過 LINE 20 字限制
      const btnLabel = Array.from(`🛒 加入購物車｜${item.size} ${shortStatus}`).slice(0, 20).join('');
      const displayText = `加入購物車：${item.colorZh || colorJp} ${item.size}`;
      const imgUrl = colorImages[colorJp] || imageUrl || '';
      const data = `action=add_to_cart&id=${productId}&c=${encodeURIComponent(colorJp)}&s=${encodeURIComponent(item.size)}&jpy=${jpy}&p=${suggested}&url=${encodeURIComponent(productUrl)}&img=${encodeURIComponent(imgUrl)}`;
      const btnColor = item.inStock ? '#b8895a' : item.isPreorder ? '#7a8fb5' : '#c4956a';
      return {
        type: 'button',
        height: 'sm',
        style: 'primary',
        color: btnColor,
        margin: 'xs',
        action: { type: 'postback', label: btnLabel, data, displayText },
      };
    });

    // 顏色對應圖片（全尺寸），沒有則用主圖
    const cardImage = colorImages[colorJp] || imageUrl;

    const bubble = {
      type: 'bubble',
      size: 'mega',
      ...(cardImage ? {
        hero: {
          type: 'image',
          url: cardImage,
          size: 'full',
          aspectRatio: '3:4',
          aspectMode: 'cover',
        },
      } : {}),
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        paddingBottom: '8px',
        spacing: 'none',
        backgroundColor: '#f5ede0',
        contents: [
          // 貨號
          { type: 'text', text: productId.toUpperCase(), size: 'xxs', color: '#b8a090' },
          // 商品名稱（有才顯示）
          ...(productName ? [{
            type: 'text',
            text: productName.substring(0, 30),
            size: 'xs',
            color: '#a08060',
            wrap: true,
            margin: 'xs',
          }] : []),
          // 顏色
          { type: 'text', text: colorLabel, weight: 'bold', size: 'md', color: '#3d2c1e', wrap: true, margin: 'xs' },
          // 價格
          { type: 'text', text: `¥${jpy.toLocaleString()}　報價金額 NT$${suggested.toLocaleString()}`, size: 'xs', color: '#a08060', margin: 'xs' },
          // 分隔線
          { type: 'separator', margin: 'md', color: '#ddd0bc' },
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
        backgroundColor: '#f5ede0',
        contents: [{
          type: 'button',
          height: 'sm',
          style: 'link',
          color: '#a08060',
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

  const { productName, jpy, stockLines, imageUrl, colorImages } = productData;
  const weightInfo  = estimateWeight(productName);
  const suggested   = calcSuggestedPrice(rate, jpy, weightInfo ? weightInfo.midLbs : 1);
  const qStatus     = calcQStatus(stockLines);

  // 先回覆，不等 getProfile（省 200~500ms）
  const flexMsg = buildFlexMessage(userText, productName, jpy, suggested, stockLines, imageUrl, weightInfo);
  const cartFlex = buildAddToCartFlex(stockLines, productId, jpy, suggested, userText, imageUrl, productName, colorImages);
  await client.replyMessage(replyToken, cartFlex ? [flexMsg, cartFlex] : [flexMsg]);

  // 背景任務：getProfile + 寫 Sheet（不阻塞回覆）
  const bgTasks = [];

  if (userId === ADMIN_USER_ID) {
    bgTasks.push(
      appendProductToSheet(productId, productName, jpy, stockLines, qStatus, weightInfo).catch((e) =>
        console.error('[sheets append error]', e.message)
      )
    );
  }

  bgTasks.push(
    client.getProfile(userId)
      .then((profile) =>
        logQueryToSheet(userId, profile.displayName, productId, productName, jpy, weightInfo, imageUrl, suggested, userText)
      )
      .catch(() =>
        logQueryToSheet(userId, userId, productId, productName, jpy, weightInfo, imageUrl, suggested, userText)
      )
      .catch((e) => console.error('[sheets log error]', e.message))
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
// 回傳指定商品 + 顏色的全尺寸圖片 URL（供 LIFF 購物車 lazy load 使用）
app.get('/api/item-image', async (req, res) => {
  const { id: productId, c: colorJp, url: directUrl } = req.query;
  if (!colorJp) return res.status(400).json({ error: 'c required' });
  if (!productId && !directUrl) return res.status(400).json({ error: 'id or url required' });
  try {
    const productUrl = directUrl || `https://www.grail.bz/item/${productId}/`;
    const { data: html } = await axios.get(productUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'ja,zh-TW;q=0.9',
      },
    });
    const $ = cheerio.load(html);
    let imageUrl = null;
    $('img[alt]').each((_, el) => {
      if (imageUrl) return;
      const alt = $(el).attr('alt') || '';
      if (!alt.includes(colorJp)) return;
      const src = $(el).attr('data-src') || $(el).attr('data-lazy') || $(el).attr('src') || '';
      if (!src) return;
      const full = src.replace('/images/goods/t/', '/images/goods/d/');
      imageUrl = full.startsWith('http') ? full : `https://cdn.grail.bz${full}`;
    });
    // fallback to og:image
    if (!imageUrl) imageUrl = $('meta[property="og:image"]').attr('content') || null;
    res.json({ imageUrl });
  } catch (e) {
    res.json({ imageUrl: null });
  }
});

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

app.post('/api/cart/add', express.json(), async (req, res) => {
  const { userId, productId, productName, color, size, jpy, suggestedPrice, productUrl, imageUrl } = req.body;
  if (!userId || !productId || !color || !size) return res.status(400).json({ error: 'missing fields' });
  try {
    await addToCartSheet(userId, productId, productName || productId, color, size, jpy || 0, suggestedPrice || 0, productUrl || '', imageUrl || '');
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
    const itemsText = cartItems.map(i => `・${i.productId} ${translateColorWithJp(i.color)} ${i.size} NT$${i.suggestedPrice}`).join('\n');
    // 並行推播：管理員通知 + 買家確認訊息
    await Promise.all([
      client.pushMessage(ADMIN_USER_ID, {
        type: 'text',
        text: `🛍 新訂單！\n訂單ID: ${result.orderId}\n時間: ${result.orderTime}\n━━━━━━━━━━\n${itemsText}\n━━━━━━━━━━\n合計: NT$${result.totalTwd}\n\n買家: ${buyerInfo.name}\n手機: ${buyerInfo.phone}\n聯繫方式: ${buyerInfo.contactMethod} @${buyerInfo.contactAccount}${buyerInfo.note ? '\n備註: ' + buyerInfo.note : ''}`,
      }).catch(e => console.error('[admin notify error]', e.message)),
      client.pushMessage(userId, {
        type: 'text',
        text: `🎉 訂單已收到！\n\n訂單編號：${result.orderId}\n下單時間：${result.orderTime}\n━━━━━━━━━━\n${itemsText}\n━━━━━━━━━━\n合計：NT$${result.totalTwd}\n🎁 優惠：免國內運費（已折抵）\n\n我們確認後會盡快提供賣貨便下單連結或與您聯繫，請您耐心等候 🌸`,
      }).catch(e => console.error('[buyer notify error]', e.message)),
    ]);
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

// ── 管理員 API：取得所有訂單 ──────────────────────────────────────────────────
app.get('/api/admin/orders', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${ORDER_SHEET}!A:K`,
    });
    const rows = (resp.data.values || []).slice(1);
    const orders = rows.map((row, i) => ({
      rowIndex: i + 2,
      orderId:   row[0] || '',
      orderTime: row[1] || '',
      userId:    row[2] || '',
      items:     row[3] || '',
      total:     row[4] || '',
      buyerName: row[5] || '',
      phone:     row[6] || '',
      contact:   row[7] || '',
      contactId: row[8] || '',
      note:      row[9] || '',
      status:    row[10] || '待確認',
    })).reverse();
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 管理員 API：更新訂單狀態 ──────────────────────────────────────────────────
app.post('/api/admin/order-status', express.json(), async (req, res) => {
  const { key, rowIndex, status } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!rowIndex || !status) return res.status(400).json({ error: 'rowIndex and status required' });
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${ORDER_SHEET}!K${rowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [[status]] },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 管理員頁面 ────────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_KEY) return res.status(401).send('Unauthorized');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bijin 管理後台</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#faf8f6;min-height:100vh;color:#333}
header{background:#fff;border-bottom:1px solid #ece8e2;padding:16px 20px;position:sticky;top:0;z-index:10}
header h1{font-size:18px;font-weight:bold;color:#7a5c3e}
header p{font-size:12px;color:#aaa;margin-top:2px}
.toolbar{padding:12px 20px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.toolbar select{border:1px solid #ddd;border-radius:8px;padding:6px 10px;font-size:13px;background:#fff;color:#555}
.toolbar button{background:#c9a98a;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:bold;cursor:pointer}
#orders{padding:0 12px 80px;display:grid;grid-template-columns:repeat(4,1fr);gap:12px;align-items:start}
@media(max-width:1200px){#orders{grid-template-columns:repeat(3,1fr)}}
@media(max-width:800px){#orders{grid-template-columns:repeat(2,1fr)}}
@media(max-width:500px){#orders{grid-template-columns:1fr}}
#empty{grid-column:1/-1}
.order-card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.07);overflow:hidden}
.order-header{padding:12px 16px;display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #f0ebe4}
.order-id{font-size:11px;color:#aaa;font-family:monospace}
.order-time{font-size:11px;color:#bbb;text-align:right}
.order-body{padding:12px 16px}
.buyer-name{font-size:15px;font-weight:bold;color:#3d2c1e;margin-bottom:4px}
.order-items{font-size:12px;color:#888;line-height:1.8;margin-bottom:8px}
.order-total{font-size:14px;font-weight:bold;color:#c9a98a}
.order-contact{font-size:12px;color:#aaa;margin-top:4px}
.order-footer{padding:10px 16px;display:flex;gap:8px;align-items:center;background:#faf8f6;flex-wrap:wrap}
.status-select{border:1px solid #ddd;border-radius:8px;padding:6px 10px;font-size:13px;background:#fff;flex:1;min-width:100px}
.btn-save{background:#c9a98a;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:bold;cursor:pointer;white-space:nowrap}
.btn-save:disabled{opacity:.5;cursor:default}
.btn-notify{background:#7a8fb5;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:bold;cursor:pointer;white-space:nowrap}
.notify-row{display:none;padding:10px 16px;border-top:1px solid #f0ebe4;gap:8px;align-items:center}
.notify-row input{flex:1;border:1px solid #ddd;border-radius:8px;padding:7px 10px;font-size:13px;outline:none}
.notify-row input:focus{border-color:#7a8fb5}
.btn-send{background:#7a8fb5;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:bold;cursor:pointer}
.status-badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:bold}
.s-待確認{background:#fff3e0;color:#e65100}
.s-待買家完成下單{background:#e3f2fd;color:#1565c0}
.s-處理中(待處理或完成官網下單){background:#ede7f6;color:#4527a0}
.s-已發貨{background:#e8f5e9;color:#2e7d32}
.s-已完成{background:#f3e5f5;color:#6a1b9a}
.s-已取消{background:#fce4ec;color:#880e4f}
/* date modal */
.date-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:none;align-items:center;justify-content:center}
.date-modal-box{background:#fff;border-radius:14px;padding:24px 20px;width:280px;box-shadow:0 8px 32px rgba(0,0,0,.18)}
.date-modal-title{font-size:15px;font-weight:bold;color:#333;margin-bottom:6px}
.date-modal-sub{font-size:12px;color:#888;margin-bottom:14px}
.date-modal-input{width:100%;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:16px;outline:none;box-sizing:border-box;text-align:center;letter-spacing:2px}
.date-modal-input:focus{border-color:#c9a98a}
.date-modal-btns{display:flex;gap:10px;margin-top:16px}
.date-modal-cancel{flex:1;background:#eee;color:#555;border:none;border-radius:8px;padding:10px;font-size:14px;cursor:pointer}
.date-modal-ok{flex:1;background:#c9a98a;color:#fff;border:none;border-radius:8px;padding:10px;font-size:14px;font-weight:bold;cursor:pointer}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:100}
.toast.show{opacity:1}
#empty{text-align:center;color:#bbb;padding:60px 20px;font-size:14px}
.closed-section{margin:12px;border-radius:12px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.07);overflow:hidden}
.closed-section summary{padding:14px 16px;font-size:14px;font-weight:bold;color:#999;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center}
.closed-section summary::-webkit-details-marker{display:none}
details.closed-section[open] summary::after{content:'▾'}
.closed-section summary::after{content:'▸';font-size:12px}
</style>
</head>
<body>
<header>
  <h1>🌸 Bijin 管理後台</h1>
  <p id="order-count">載入中…</p>
</header>
<div class="toolbar">
  <select id="filter-status" onchange="renderOrders()">
    <option value="">全部訂單</option>
    <option value="待確認">待確認</option>
    <option value="待買家完成下單">待買家完成下單</option>
    <option value="處理中(待處理或完成官網下單)">處理中(待處理或完成官網下單)</option>
    <option value="已發貨(官網出貨)">已發貨(官網出貨)</option>
    <option value="已發貨(已達台灣海關作業)">已發貨(已達台灣海關作業)</option>
    <option value="已發貨(賣貨便出貨)">已發貨(賣貨便出貨)</option>
    <option value="待買家取貨">待買家取貨</option>
    <option value="已完成">已完成</option>
    <option value="已取消">已取消</option>
  </select>
  <button onclick="loadOrders()">重新整理</button>
</div>
<div id="orders"><div id="empty" style="display:none">沒有符合條件的訂單</div></div>
<details class="closed-section">
  <summary>已完成 / 已取消訂單</summary>
  <div id="closed-orders"></div>
</details>
<div class="toast" id="toast"></div>

<script>
const KEY = '${ADMIN_KEY}';
const STATUSES = ['待確認','待買家完成下單','處理中(待處理或完成官網下單)','已發貨(官網出貨)','已發貨(已達台灣海關作業)','已發貨(賣貨便出貨)','待買家取貨','已完成','已取消'];
const NOTIFY_STATUSES = new Set(['處理中(待處理或完成官網下單)','已發貨(官網出貨)','已發貨(已達台灣海關作業)','已發貨(賣貨便出貨)','待買家取貨']);
const STATUS_STYLE = {
  '待確認':'background:#fff3e0;color:#e65100',
  '待買家完成下單':'background:#e3f2fd;color:#1565c0',
  '處理中(待處理或完成官網下單)':'background:#ede7f6;color:#4527a0',
  '已發貨(官網出貨)':'background:#e8f5e9;color:#2e7d32',
  '已發貨(已達台灣海關作業)':'background:#e0f2f1;color:#004d40',
  '已發貨(賣貨便出貨)':'background:#f1f8e9;color:#33691e',
  '待買家取貨':'background:#fce4ec;color:#880e4f',
  '已完成':'background:#f3e5f5;color:#6a1b9a',
  '已取消':'background:#fafafa;color:#aaa',
};
function statusBadge(s) {
  const st = STATUS_STYLE[s] || 'background:#eee;color:#666';
  return \`<span class="status-badge" style="\${st}">\${s||'待確認'}</span>\`;
}
let allOrders = [];

async function loadOrders() {
  try {
    const r = await fetch('/api/admin/orders?key=' + KEY);
    const d = await r.json();
    allOrders = d.orders || [];
    renderOrders();
  } catch(e) { showToast('載入失敗：' + e.message); }
}

const CLOSED_STATUSES = new Set(['已完成','已取消']);

function renderOrders() {
  const filter = document.getElementById('filter-status').value;
  const active = allOrders.filter(o => !CLOSED_STATUSES.has(o.status));
  const closed = allOrders.filter(o => CLOSED_STATUSES.has(o.status));
  const list = filter
    ? (CLOSED_STATUSES.has(filter) ? closed : active).filter(o => o.status === filter)
    : active;

  document.getElementById('order-count').textContent =
    '進行中 ' + active.length + ' 筆' + (closed.length ? '　已結束 ' + closed.length + ' 筆' : '');

  const container = document.getElementById('orders');
  const emptyHtml = '<div id="empty" style="grid-column:1/-1;text-align:center;color:#bbb;padding:40px;display:' + (list.length?'none':'block') + '">沒有符合條件的訂單</div>';
  container.innerHTML = emptyHtml + list.map(o => createCard(o)).join('');

  // Closed orders collapsible
  const closedEl = document.getElementById('closed-orders');
  const closedFiltered = filter && CLOSED_STATUSES.has(filter) ? closed.filter(o=>o.status===filter) : closed;
  closedEl.innerHTML = closedFiltered.length
    ? closedFiltered.map(o => createClosedRow(o)).join('')
    : '<div style="color:#bbb;padding:12px;font-size:13px">無已完成或已取消訂單</div>';
}

function createCard(o) {
  const statusOpts = STATUSES.map(s =>
    '<option value="' + s + '"' + (o.status === s ? ' selected' : '') + '>' + s + '</option>'
  ).join('');
  const badge = statusBadge(o.status||'待確認');
  const contact = o.contact ? o.contact + (o.contactId ? '：' + o.contactId : '') : '';
  return \`<div class="order-card" id="card-\${o.rowIndex}">
  <div class="order-header">
    <div>
      <div class="order-id">\${o.orderId}</div>
      <div style="margin-top:4px">\${badge}</div>
    </div>
    <div class="order-time">\${o.orderTime}</div>
  </div>
  <div class="order-body">
    <div class="buyer-name">\${o.buyerName || '（未填姓名）'}</div>
    <div class="order-items">\${o.items.split('\\n').map(l=>'<div>'+l+'</div>').join('')}</div>
    <div class="order-total">NT$\${o.total}</div>
    \${contact ? '<div class="order-contact">' + contact + '</div>' : ''}
    \${o.note ? '<div class="order-contact">備註：' + o.note + '</div>' : ''}
  </div>
  <div class="order-footer">
    <select class="status-select" id="sel-\${o.rowIndex}">\${statusOpts}</select>
    <button class="btn-save" onclick="saveStatus(\${o.rowIndex}, '\${o.orderId}')">儲存狀態與通知</button>
  </div>
  \${(o.status||'待確認')==='待確認' ? \`<div class="notify-row" id="notify-\${o.rowIndex}" style="display:flex">
    <input type="url" id="url-\${o.rowIndex}" placeholder="貼上賣場網址…">
    <button class="btn-send" onclick="sendNotify('\${o.orderId}', \${o.rowIndex})">傳送</button>
  </div>\` : ''}
</div>\`;
}

function createClosedRow(o) {
  const badge = statusBadge(o.status);
  return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0ebe4;font-size:13px">'
    + '<div><span style="color:#aaa;font-family:monospace;font-size:11px">' + o.orderId + '</span>'
    + ' ' + badge + ' <span style="color:#555;margin-left:8px">' + (o.buyerName||'—') + '</span></div>'
    + '<div style="color:#aaa;font-size:11px">' + o.orderTime + '</div></div>';
}

function toggleNotify(rowIndex) {
  const row = document.getElementById('notify-' + rowIndex);
  row.style.display = row.style.display === 'none' ? 'flex' : 'none';
}

async function saveStatus(rowIndex, orderId) {
  const status = document.getElementById('sel-' + rowIndex).value;
  if (NOTIFY_STATUSES.has(status)) {
    showDateModal(rowIndex, orderId, status);
    return;
  }
  try {
    const r = await fetch('/api/admin/order-status', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, rowIndex, status }),
    });
    if (r.ok) {
      const o = allOrders.find(x => x.rowIndex === rowIndex);
      if (o) o.status = status;
      showToast('✅ 狀態已更新');
      renderOrders();
    } else {
      const d = await r.json();
      showToast('❌ ' + (d.error || '失敗'));
    }
  } catch(e) { showToast('❌ 網路錯誤'); }
}

let _dateCtx = null;
function showDateModal(rowIndex, orderId, status) {
  _dateCtx = { rowIndex, orderId, status };
  document.getElementById('dm-status').textContent = status;
  const now = new Date();
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const dd = String(now.getDate()).padStart(2,'0');
  document.getElementById('dm-input').value = mm + '/' + dd;
  document.getElementById('date-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('dm-input').select(), 50);
}
function closeDateModal() {
  document.getElementById('date-modal').style.display = 'none';
  _dateCtx = null;
}
async function confirmDateModal() {
  const date = document.getElementById('dm-input').value.trim();
  if (!date) { showToast('請輸入日期'); return; }
  const { rowIndex, orderId, status } = _dateCtx;
  document.getElementById('date-modal').style.display = 'none';
  try {
    const r = await fetch('/api/admin/notify-progress', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, orderId, rowIndex, status, date }),
    });
    const d = await r.json();
    if (r.ok) {
      const o = allOrders.find(x => x.rowIndex === rowIndex);
      if (o) o.status = status;
      showToast('✅ 狀態已更新並通知買家');
      renderOrders();
    } else showToast('❌ ' + (d.error || '失敗'));
  } catch(e) { showToast('❌ 網路錯誤'); }
}

async function sendNotify(orderId, rowIndex) {
  const url = document.getElementById('url-' + rowIndex).value.trim();
  if (!url) { showToast('請填入賣場網址'); return; }
  try {
    const r = await fetch('/admin/notify-buyer?key=' + KEY + '&orderId=' + encodeURIComponent(orderId) + '&url=' + encodeURIComponent(url));
    const d = await r.json();
    if (r.ok) {
      // 自動更新本地狀態，不需重整頁面
      const o = allOrders.find(x => x.rowIndex === rowIndex);
      if (o) o.status = '待買家完成下單';
      showToast('✅ ' + d.message);
      renderOrders();
    } else showToast('❌ ' + (d.error || '失敗'));
  } catch(e) { showToast('❌ 網路錯誤'); }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

loadOrders();
</script>

<div id="date-modal" class="date-modal-overlay" onclick="if(event.target===this)closeDateModal()">
  <div class="date-modal-box">
    <div class="date-modal-title">輸入進度日期</div>
    <div class="date-modal-sub">狀態：<strong id="dm-status"></strong></div>
    <input id="dm-input" class="date-modal-input" type="text" placeholder="MM/DD" maxlength="5"
      onkeydown="if(event.key==='Enter')confirmDateModal()">
    <div class="date-modal-btns">
      <button class="date-modal-cancel" onclick="closeDateModal()">取消</button>
      <button class="date-modal-ok" onclick="confirmDateModal()">確定並通知買家</button>
    </div>
  </div>
</div>
</body>
</html>`);
});

// ── 管理員：通知買家賣場網址 ──────────────────────────────────────────────────
// 呼叫方式：GET /admin/notify-buyer?key=grl-admin-2026&orderId=XXX&url=https://...
app.get('/admin/notify-buyer', async (req, res) => {
  const { key, orderId, url: storeUrl } = req.query;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!orderId || !storeUrl) return res.status(400).json({ error: 'orderId and url required' });

  try {
    // 從訂單 sheet 找 orderId
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:K` });
    const rows = resp.data.values || [];
    const orderRow = rows.find((r) => r[0] === orderId);
    if (!orderRow) return res.status(404).json({ error: `找不到訂單 ${orderId}` });

    const orderRowIndex = rows.indexOf(orderRow) + 1; // 1-indexed (includes header)
    const buyerUserId  = orderRow[2] || '';
    const buyerName    = orderRow[5] || '';
    const itemsSummary = orderRow[3] || '';
    const totalTwd     = orderRow[4] || '';

    if (!buyerUserId) return res.status(400).json({ error: '訂單缺少 userId' });

    // Push LINE 訊息給買家
    const client = new line.Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
    await client.pushMessage(buyerUserId, {
      type: 'flex',
      altText: '您的訂單賣貨便已建立，請前往下單 🛍',
      contents: {
        type: 'bubble',
        size: 'kilo',
        header: {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#c9a98a',
          paddingAll: '14px',
          contents: [{ type: 'text', text: '🛍 賣貨便已建立！', color: '#ffffff', size: 'md', weight: 'bold' }],
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          paddingAll: '14px',
          contents: [
            { type: 'text', text: `${buyerName} 您好`, size: 'sm', color: '#555555' },
            { type: 'separator', margin: 'sm' },
            { type: 'text', text: itemsSummary, size: 'xs', color: '#888888', wrap: true, margin: 'sm' },
            { type: 'text', text: `合計：NT$${totalTwd}`, size: 'sm', weight: 'bold', color: '#c9a98a', margin: 'sm' },
            { type: 'separator', margin: 'sm' },
            { type: 'text', text: '請點選下方按鈕前往賣貨便完成下單 👇', size: 'sm', color: '#555555', margin: 'sm', wrap: true },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          paddingAll: '10px',
          contents: [{
            type: 'button',
            style: 'primary',
            color: '#c9a98a',
            height: 'sm',
            action: { type: 'uri', label: '前往賣貨便下單', uri: storeUrl },
          }],
        },
      },
    });

    // 自動更新訂單狀態為「待買家完成下單」
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${ORDER_SHEET}!K${orderRowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [['待買家完成下單']] },
    });

    res.json({ status: 'ok', message: `已通知買家 ${buyerName}（${buyerUserId}）` });
  } catch (err) {
    console.error('[notify-buyer error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 管理員 API：進度通知買家 ──────────────────────────────────────────────────
app.post('/api/admin/notify-progress', express.json(), async (req, res) => {
  const { key, orderId, rowIndex, status, date } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!orderId || !status || !date || !rowIndex) return res.status(400).json({ error: 'Missing fields' });

  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:K` });
    const rows = resp.data.values || [];
    const orderRow = rows.find(r => r[0] === orderId);
    if (!orderRow) return res.status(404).json({ error: `找不到訂單 ${orderId}` });

    const buyerUserId = orderRow[2] || '';
    const buyerName   = orderRow[5] || '';
    const itemsSummary = orderRow[3] || '';
    if (!buyerUserId) return res.status(400).json({ error: '訂單缺少 userId' });

    // 組合進度文字
    let progressLines = '';
    if (status === '處理中(待處理或完成官網下單)') {
      progressLines = `${date} GRL官網下單完成`;
    } else if (status === '已發貨(官網出貨)') {
      progressLines = `${date} GRL官網出貨`;
    } else if (status === '已發貨(已達台灣海關作業)') {
      progressLines = `${date} 已到台灣，過海關中`;
    } else if (status === '已發貨(賣貨便出貨)') {
      progressLines = `${date} 我們這邊已安排出貨囉❤️`;
    } else if (status === '待買家取貨') {
      progressLines = `提醒您～商品已到門市囉！\n${date} 前請記得去取貨唷☺️`;
    }

    const msgText = `您好～🚚商品\n${itemsSummary}\n進度回報：\n${progressLines}`;

    const client = new line.Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
    await client.pushMessage(buyerUserId, { type: 'text', text: msgText });

    // 更新訂單狀態
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${ORDER_SHEET}!K${rowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [[status]] },
    });

    res.json({ status: 'ok', message: `已通知 ${buyerName}` });
  } catch (err) {
    console.error('[notify-progress error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 本地開發啟動 ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

module.exports = app;
