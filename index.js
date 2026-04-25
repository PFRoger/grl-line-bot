'use strict';

const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const { google } = require('googleapis');

const resolvedUrlCache = new Map();

const app = express();
app.use('/public', express.static(require('path').join(__dirname, 'public')));

const ADMIN_USER_ID = 'U9fa329e70b89f4ce19089928a824bd29';
const SHEET_ID = '148eFUK3xm0ITsVpueqtnwjK-lcKeemoiRbQgcFWbGug';
const LIFF_ID = '2009823505-mhQivhxd';
const MEMBER_LIFF_ID = '2009823505-bwMBpOjU';
const CART_SHEET = '購物車';
const ORDER_SHEET = '訂單';
const ADMIN_KEY = process.env.ADMIN_KEY;

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
  const cost = rate * (jpy + 195) * 1.075 + (150 * Math.ceil(lbs) + 20 + 10);
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

// ── 從網址擷取商品 ID（去掉顏色後綴 4 碼，例如 ru14381119→ru1438、pm870a1119→pm870a）
// 支援 ID 中間夾字母的格式（如 pm870a）
function extractProductId(url) {
  const m = url.match(/\/item\/([a-z]{1,2}[a-z0-9]+)/i);
  if (!m) return null;
  const raw = m[1];
  const stripped = raw.replace(/\d{4}$/, '');
  const result = /^[a-z]{1,2}[a-z0-9]+$/i.test(stripped) && stripped.length >= 3 ? stripped : raw;
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

  // フラット 不納入：GRL 平底鞋名稱一定會有其他鞋類關鍵字；フラット 單獨出現在「フラットシルエット洋裝」等服飾名稱，會誤判為鞋
  if (/サンダル|スニーカー|ブーツ|パンプス|シューズ|ミュール|ローファー|スリッポン|ウェッジ|ヒール/.test(name)) {
    category = 'shoes';
    label = '鞋類';
    minG = 700; maxG = 1020;
    packagingNote = '含鞋盒紙箱（約200~280g）';
    confidence = 'medium';
  // ショルダー 不納入：「ショルダーオープン/ショルダーリボン」等服飾設計名稱很常見，需用 ショルダーバッグ 才精確
  } else if (/バッグ|トートバッグ|ショルダーバッグ|ハンドバッグ|リュック|クラッチ|ポーチ/.test(name)) {
    category = 'bag';
    label = '包包';
    minG = 450; maxG = 820;
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
    minG = 650; maxG = 1150;
    packagingNote = '含塑膠包裝袋（約20g）';
    confidence = 'medium';
  } else if (/ジャケット|カーディガン|ボレロ/.test(name)) {
    category = 'jacket';
    label = '外罩衫';
    minG = 280; maxG = 580;
    packagingNote = '含塑膠包裝袋（約20g）';
    confidence = 'high';
  // デニム 先於 ワンピース/スカート：牛仔布料偏重，需用牛仔範圍而非洋裝範圍
  } else if (/デニム|ジーンズ/.test(name)) {
    category = 'denim';
    label = '牛仔褲';
    minG = 500; maxG = 850;
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

  // 多件式套裝乘數（セットアップ × 1.8，セット / アンサンブル × 1.6）
  if (/セットアップ/.test(name)) {
    minG = Math.round(minG * 1.8); maxG = Math.round(maxG * 1.8);
  } else if (/セット|アンサンブル/.test(name)) {
    minG = Math.round(minG * 1.6); maxG = Math.round(maxG * 1.6);
  }

  // 包裝重量納入估算
  const pkgG = category === 'shoes' ? 200 : category === 'accessory' ? 30
    : (category === 'outerwear' || category === 'bag') ? 150 : 80;
  minG += pkgG; maxG += pkgG;
  packagingNote = `含包裝約${pkgG}g`;

  // ニット/セーター 材質偏重，額外加 0.5 磅（約227g）
  if (/ニット|セーター/.test(name)) { minG += 227; maxG += 227; }

  // 布料材質加成/減輕（+0.3磅=136g；-0.2磅=91g）
  if (/ベロア|ツイード|ファー|レザー|PUレザー/.test(name)) {
    minG += 136; maxG += 136;
  } else if (/シフォン|レース/.test(name)) {
    minG = Math.max(50, minG - 91); maxG = Math.max(150, maxG - 91);
  }

  // 版型大小調整
  if (/オーバーサイズ|ルーズ/.test(name)) { minG = Math.round(minG * 1.1); maxG = Math.round(maxG * 1.1); }
  if (/ロング/.test(name) && /ワンピース|スカート|コート|アウター|カーディガン|パンツ|ジャケット/.test(name)) {
    minG = Math.round(minG * 1.15); maxG = Math.round(maxG * 1.15);
  }
  if (/ミニ/.test(name) && /ワンピース|スカート/.test(name)) {
    minG = Math.round(minG * 0.9); maxG = Math.round(maxG * 0.9);
  }

  // 附贈配件加成
  if (/ティペット付き|ファー付き/.test(name)) { minG += 136; maxG += 136; }
  else if (/スカーフ付き|ストール付き/.test(name)) { minG += 68; maxG += 68; }
  else if (/ベルト付き/.test(name)) { minG += 45; maxG += 45; }

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
async function scrapeGRL(inputUrl) {
  const url = resolvedUrlCache.get(inputUrl) || inputUrl;
  let resolvedUrl = url;
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
    ({ data: html } = await axios.get(url, { timeout: 8000, headers }));
  } catch (err) {
    if (err.response && err.response.status === 404) {
      const dispUrl = url.replace(/\/(item\/)/, '/disp/item/');
      try {
        if (dispUrl !== url) {
          ({ data: html } = await axios.get(dispUrl, { timeout: 8000, headers }));
        } else throw err;
      } catch (err2) {
        // 搜尋頁 fallback：適用於 k9086d 等需帶色號後綴才有效的商品
        if (err2.response && err2.response.status === 404) {
          const idMatch = url.match(/\/(?:disp\/)?item\/([a-z]{1,2}[a-z0-9]+)/i);
          if (!idMatch) throw err2;
          const searchId = idMatch[1].replace(/\d{4}$/, '').toLowerCase();
          const { data: searchHtml } = await axios.get(
            `https://www.grail.bz/disp/itemlist/?q=${searchId}`,
            { timeout: 8000, headers }
          );
          const relRegex = /href="(\/(?:disp\/)?item\/[a-z]{1,2}[a-z0-9]+\/)"/gi;
          const allHrefs = [];
          let m2;
          while ((m2 = relRegex.exec(searchHtml)) !== null) {
            if (m2[1].toLowerCase().includes(searchId)) allHrefs.push(m2[1]);
          }
          if (allHrefs.length === 0) throw err2;
          allHrefs.sort((a, b) => a.length - b.length);
          resolvedUrl = `https://www.grail.bz${allHrefs[0]}`;
          resolvedUrlCache.set(inputUrl, resolvedUrl);
          ({ data: html } = await axios.get(resolvedUrl, { timeout: 8000, headers }));
        } else throw err2;
      }
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

  return { productName, jpy, stockLines, imageUrl, colorImages, resolvedUrl };
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
  row[4]  = `=((V$3*(P${r}+195))*(1+0.06+0.015))+(150*L${r}+20+10)`;// E: 成本價（匯率 V$3，磅數 L）
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
      isPreorder: row[12] === '1',
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
    .map(i => `${i.isPreorder ? '【預購】' : ''}${(i.productId||'').toUpperCase()} ${translateColorWithJp(i.color)} ${i.size} NT$${i.suggestedPrice}${i.qty > 1 ? ` ×${i.qty}` : ''}`)
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
      step: '01',
      title: '查詢商品報價',
      icon: '🔍',
      headerBg: '#e8c4bc',
      accentColor: '#c4847a',
      lines: [
        { text: '前往 GRL 官網找到喜歡的商品', bold: false },
        { text: '複製商品網址，貼到這個對話框', bold: false },
        { text: ' ', bold: false },
        { text: 'Bot 立即回傳', bold: true },
        { text: '・台幣報價（含代購費 + 國際運費）', bold: false },
        { text: '・各顏色 / 尺寸庫存狀態', bold: false },
        { text: ' ', bold: false },
        { text: '✅ 有庫存　⚠️ 剩餘少量', bold: false },
        { text: '📅 預約販售　❌ 缺貨', bold: false },
      ],
    },
    {
      step: '02',
      title: '選色加入購物車',
      icon: '🛒',
      headerBg: '#d4a8a0',
      accentColor: '#b08070',
      lines: [
        { text: '報價卡片左右滑動選擇顏色', bold: false },
        { text: '點按想要的尺寸按鈕加入購物車', bold: false },
        { text: ' ', bold: false },
        { text: '想要多件？繼續貼網址選款即可', bold: true },
        { text: ' ', bold: false },
        { text: '⚠️ 購物車 48 小時後自動清空', bold: false },
        { text: '請盡早完成結帳！', bold: false },
      ],
    },
    {
      step: '03',
      title: '填資料・送出訂單',
      icon: '📋',
      headerBg: '#c49488',
      accentColor: '#8b5a50',
      lines: [
        { text: '點主選單「購物車」開啟結帳頁', bold: false },
        { text: ' ', bold: false },
        { text: '① 確認購物車商品', bold: false },
        { text: '② 填寫姓名、電話、備註', bold: false },
        { text: '③ 點「送出訂單」', bold: false },
        { text: ' ', bold: false },
        { text: '送出後靜候賣家確認 🌸', bold: false },
      ],
    },
    {
      step: '04',
      title: '收賣貨便連結',
      icon: '📩',
      headerBg: '#b08880',
      accentColor: '#7a4a40',
      lines: [
        { text: '賣家核對訂單後', bold: false },
        { text: '會透過 LINE 傳送賣貨便連結', bold: false },
        { text: ' ', bold: false },
        { text: '點連結完成賣貨便正式下單', bold: true },
        { text: '（此步驟才算訂單成立）', bold: false },
        { text: ' ', bold: false },
        { text: '⚠️ 請務必透過我們傳的連結下單', bold: false },
      ],
    },
    {
      step: '05',
      title: '7-11 到店取件',
      icon: '📦',
      headerBg: '#9a7c78',
      accentColor: '#5c3a38',
      lines: [
        { text: '商品到台灣後我們主動通知您', bold: false },
        { text: ' ', bold: false },
        { text: '收到通知後前往您選擇的', bold: false },
        { text: '7-11 門市取件即可 ✨', bold: false },
        { text: ' ', bold: false },
        { text: '有任何問題隨時留言給我們 🌸', bold: true },
      ],
    },
  ];

  const bubbles = steps.map((s) => ({
    type: 'bubble',
    size: 'kilo',
    styles: {
      body: { backgroundColor: '#fdf8f6' },
    },
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: s.headerBg,
      paddingTop: '16px',
      paddingBottom: '14px',
      paddingStart: '16px',
      paddingEnd: '16px',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'text',
              text: `STEP ${s.step}`,
              color: '#ffffff',
              size: 'xxs',
              weight: 'bold',
              flex: 1,
              gravity: 'center',
            },
            {
              type: 'text',
              text: s.icon,
              size: 'lg',
              align: 'end',
            },
          ],
        },
        {
          type: 'text',
          text: s.title,
          color: '#ffffff',
          size: 'md',
          weight: 'bold',
          wrap: true,
          margin: 'sm',
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      paddingAll: '16px',
      contents: s.lines.map((l) => ({
        type: 'text',
        text: l.text,
        size: 'sm',
        color: l.bold ? '#5c3d35' : '#8a6558',
        weight: l.bold ? 'bold' : 'regular',
        wrap: true,
      })),
    },
  }));

  return {
    type: 'flex',
    altText: '購物指南｜查詢報價→加購物車→送訂單→賣貨便→7-11取件',
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
      { bounds: { x: 1666, y: 0,   width: 834, height: 843 }, action: { type: 'uri',      label: '購物車',   uri: `https://liff.line.me/${LIFF_ID}` } },
      { bounds: { x: 0,    y: 843, width: 833, height: 843 }, action: { type: 'uri',      label: '購物指南', uri: 'https://pfroger-linebot-2.vercel.app/guide' } },
      { bounds: { x: 833,  y: 843, width: 833, height: 843 }, action: { type: 'uri',      label: 'IG連結',   uri: 'https://www.instagram.com/bijin.jp.2024?igsh=MXZxY2wzc2tsdWxzeQ%3D%3D&utm_source=qr' } },
      { bounds: { x: 1666, y: 843, width: 834, height: 843 }, action: { type: 'uri',      label: '會員中心', uri: `https://liff.line.me/${MEMBER_LIFF_ID}` } },
    ],
  };

  const createRes = await axios.post('https://api.line.me/v2/bot/richmenu', def, { headers });
  const richMenuId = createRes.data.richMenuId;
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
      text: `👤 會員中心\n\n請點選連結查看您的點數、優惠券與邀請碼：\nhttps://liff.line.me/${MEMBER_LIFF_ID}`,
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
    const isPreorder   = params.get('pre') === '1';

    // 從查詢紀錄找商品名稱
    let productName = productId;
    try {
      const sheets = getSheetsClient();
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: '查詢紀錄!A:E' });
      const rows = (resp.data.values || []).reverse();
      const found = rows.find(r => r[3] === productId);
      if (found) productName = found[4] || productId;
    } catch (e) { console.warn('[lookup name error]', e.message); }

    let lineDisplayName = '';
    try { const p = await client.getProfile(userId); lineDisplayName = p.displayName || ''; } catch(e) {}
    await addToCartSheet(userId, lineDisplayName, productId, productName, colorJp, size, jpy, suggested, productUrl, imgUrl, isPreorder);
    const colorDisplay = translateColorWithJp(colorJp);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: `✅ 已加入購物車\n商品：${isPreorder ? '【預購】' : ''}${productName || productId}\n\n顏色：${colorDisplay}\n尺寸：${size}\n\n售價：NT$${suggested}\n\n請按下方主選單「購物車」查看內容\n════════════\n購物車每 48 小時自動清空`,
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
.summary-row{display:flex;justify-content:space-between;font-size:13px;color:#888;padding:3px 0}
.summary-save{color:#e07070}
.final-row{display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid #f0e8de;margin-top:6px}
.final-label{font-size:15px;font-weight:bold;color:#333}
.final-price{font-size:20px;font-weight:bold;color:#c9a98a}
.disc-box{background:#fff9f5;border:1px solid #f0ddd0;border-radius:10px;padding:12px;margin-top:10px}
.disc-label{font-size:13px;font-weight:bold;color:#9a6a50;margin-bottom:8px}
.pts-row{display:flex;align-items:center;gap:6px;font-size:13px;color:#666;flex-wrap:wrap}
.pts-row input[type=number]{width:72px;padding:6px 8px;text-align:center;font-size:14px;border:1px solid #ddd;border-radius:6px;-moz-appearance:textfield}
.pts-row input[type=number]::-webkit-inner-spin-button,.pts-row input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none}
.cpn-item{display:flex;align-items:center;gap:8px;padding:9px 10px;border:1px solid #eee;border-radius:8px;cursor:pointer;margin-top:6px;font-size:13px}
.cpn-item.selected{border-color:#c9a98a;background:#fff5ee}
.cpn-tag{background:#c9a98a;color:#fff;font-size:11px;font-weight:bold;padding:2px 7px;border-radius:4px;white-space:nowrap}
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
    <div class="summary-row"><span>商品小計</span><span id="subtotal-amount">NT$0</span></div>
    <div id="pts-disc-row" class="summary-row" style="display:none"><span>點數折抵</span><span class="summary-save" id="pts-disc-val">-NT$0</span></div>
    <div id="cpn-disc-row" class="summary-row" style="display:none"><span>優惠券折抵</span><span class="summary-save" id="cpn-disc-val">-NT$0</span></div>
    <div class="final-row"><span class="final-label">實付金額</span><span class="final-price" id="total-amount">NT$0</span></div>
    <div class="note-box" style="margin-top:8px">送出後，我們將盡快提供賣貨便下單連結</div>

    <div id="discount-section" style="display:none">
      <div class="disc-box">
        <div class="disc-label">🪙 點數折抵</div>
        <div style="font-size:12px;color:#aaa;margin-bottom:8px">可用 <strong id="avail-pts" style="color:#c9a98a">0</strong> 點（1點折抵 NT$1）</div>
        <div class="pts-row">使用 <input type="number" id="pts-input" placeholder="0" min="0" max="0" step="1" oninput="onPtsChange()"> 點 <button onclick="useAllPts()" style="margin-left:8px;padding:4px 10px;background:#c9a98a;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer">全部折抵</button></div>
      </div>
      <div class="disc-box" style="margin-top:8px">
        <div class="disc-label">🎟 優惠券</div>
        <div id="cpn-list"></div>
      </div>
    </div>
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
    <p style="font-size:11px;color:#aaa;text-align:center;margin:14px 0 4px;line-height:1.6">購物車內報價為查詢當時的台幣報價金額，<br>實際金額依下單時 GRL 官網現價為主。</p>
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
let displayName = '';
let cartItems = [];
let groupedItems = [];
const imageCache = {}; // key: productId|color → imageUrl
let _confirmCb = null;
let memberPoints = 0;
let activeCoupons = [];
let selectedCouponCode = '';
let subtotal = 0;
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
    displayName = profile.displayName || '';
    const [cartData, memberData] = await Promise.all([
      fetch('/api/cart?userId=' + userId).then(r => r.json()).catch(() => ({ items: [] })),
      fetch('/api/member?userId=' + userId).then(r => r.json()).catch(() => ({ ok: false })),
    ]);
    cartItems = cartData.items || [];
    if (memberData.ok && memberData.registered) {
      memberPoints = memberData.member.points || 0;
      activeCoupons = memberData.coupons || [];
    }
    render();
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
  subtotal = total;
  const ptsInput = document.getElementById('pts-input');
  if (ptsInput) {
    const newMax = Math.min(memberPoints, subtotal);
    ptsInput.max = newMax;
    if (parseInt(ptsInput.value) > newMax) ptsInput.value = newMax;
  }
  updateTotals();
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
      imageUrl: group.imageUrl, isPreorder: group.isPreorder || false, addedAt: new Date().toISOString() });
    render();
    fetch('/api/cart/add', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ userId, displayName, productId: group.productId, productName: group.productName,
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

function updateTotals() {
  const ptsUsed = parseInt(document.getElementById('pts-input')?.value) || 0;
  const coupon = activeCoupons.find(c => c.couponCode === selectedCouponCode);
  const couponAmt = coupon ? (coupon.amount || 0) : 0;
  const finalAmt = Math.max(subtotal - ptsUsed - couponAmt, 0);

  document.getElementById('subtotal-amount').textContent = 'NT$' + subtotal;
  if (ptsUsed > 0) {
    document.getElementById('pts-disc-row').style.display = 'flex';
    document.getElementById('pts-disc-val').textContent = '-NT$' + ptsUsed;
  } else {
    document.getElementById('pts-disc-row').style.display = 'none';
  }
  if (couponAmt > 0) {
    document.getElementById('cpn-disc-row').style.display = 'flex';
    document.getElementById('cpn-disc-val').textContent = '-NT$' + couponAmt;
  } else {
    document.getElementById('cpn-disc-row').style.display = 'none';
  }
  document.getElementById('total-amount').textContent = 'NT$' + finalAmt;

  // show/hide discount section
  const discSection = document.getElementById('discount-section');
  if (discSection) {
    if (subtotal > 0) {
      discSection.style.display = 'block';
      document.getElementById('avail-pts').textContent = memberPoints - ptsUsed;
      const ptsInput = document.getElementById('pts-input');
      ptsInput.max = Math.min(memberPoints, subtotal);
      // render coupon list
      const cpnList = document.getElementById('cpn-list');
      if (activeCoupons.length === 0) {
        cpnList.innerHTML = '<div style="font-size:13px;color:#bbb;padding:4px 0">目前無可用優惠券</div>';
      } else {
        cpnList.innerHTML = '';
        activeCoupons.forEach(c => {
          const el = document.createElement('div');
          el.className = 'cpn-item' + (selectedCouponCode === c.couponCode ? ' selected' : '');
          el.innerHTML = \`<span class="cpn-tag">折扣</span><span style="flex:1;color:#333">NT\$\${c.amount} 折扣券</span><span style="font-size:11px;color:#aaa">到期：\${c.expiryDate}</span>\`;
          el.onclick = () => { selectedCouponCode = (selectedCouponCode === c.couponCode ? '' : c.couponCode); updateTotals(); };
          cpnList.appendChild(el);
        });
      }
    } else {
      discSection.style.display = 'none';
    }
  }
}

function onPtsChange() {
  const input = document.getElementById('pts-input');
  let val = parseInt(input.value) || 0;
  val = Math.max(0, Math.min(val, memberPoints, subtotal));
  input.value = val;
  updateTotals();
}

function useAllPts() {
  const input = document.getElementById('pts-input');
  const max = Math.min(memberPoints, subtotal);
  input.value = max > 0 ? max : '';
  updateTotals();
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
    const ptsUsed = parseInt(document.getElementById('pts-input')?.value) || 0;
    const coupon = activeCoupons.find(c => c.couponCode === selectedCouponCode);
    const discountInfo = { pointsUsed: ptsUsed, couponCode: coupon ? coupon.couponCode : '', couponAmount: coupon ? (coupon.amount || 0) : 0 };
    const resp = await fetch('/api/order', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ userId, displayName, cartItems, buyerInfo:{ name, phone, contactMethod, contactAccount, note }, discountInfo })
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
      const data = `action=add_to_cart&id=${productId}&c=${encodeURIComponent(colorJp)}&s=${encodeURIComponent(item.size)}&jpy=${jpy}&p=${suggested}&url=${encodeURIComponent(productUrl)}&img=${encodeURIComponent(imgUrl)}${item.isPreorder ? '&pre=1' : ''}`;
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

  const src = event.source || {};
  console.log('source:', JSON.stringify(src));

  const userId    = event.source.userId;
  const userText  = event.message.text.trim();
  const replyToken = event.replyToken;

  const isGRL = /https?:\/\/(www\.)?grail\.bz\//i.test(userText);
  const isProductCode = /^[a-z]{1,2}[a-z0-9]{2,8}$/i.test(userText);

  if (!isGRL && !isProductCode) {
    await client.replyMessage(replyToken, { type: 'text', text: '請傳入 GRL 商品網址或貨號（例：RU1197）' });
    return;
  }

  const queryUrl = isProductCode
    ? `https://www.grail.bz/item/${userText.toLowerCase()}/`
    : userText;
  const productId = extractProductId(queryUrl) || '';

  let productData, rate;
  try {
    [productData, rate] = await Promise.all([scrapeGRL(queryUrl), fetchRate()]);
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

  const { productName, jpy, stockLines, imageUrl, colorImages, resolvedUrl } = productData;
  const effectiveUrl = resolvedUrl || queryUrl;
  const weightInfo  = estimateWeight(productName);
  const suggested   = calcSuggestedPrice(rate, jpy, weightInfo ? weightInfo.midLbs : 1);
  const qStatus     = calcQStatus(stockLines);

  // 先回覆，不等 getProfile（省 200~500ms）
  const flexMsg = buildFlexMessage(effectiveUrl, productName, jpy, suggested, stockLines, imageUrl, weightInfo);
  const cartFlex = buildAddToCartFlex(stockLines, productId, jpy, suggested, effectiveUrl, imageUrl, productName, colorImages);
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
      .then((profile) => profile.displayName)
      .catch(() => userId)
      .then((displayName) =>
        logQueryToSheet(userId, displayName, productId, productName, jpy, weightInfo, imageUrl, suggested, queryUrl)
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

// ── 購物指南頁面 ─────────────────────────────────────────────────────────────
app.get('/guide', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildGuideHtml());
});


function buildGuideHtml() {
  const steps = [
    { num: '01', title: '查詢商品報價', icon: '🔍',
      grad: 'linear-gradient(135deg,#f0ddd5 0%,#e4c8bc 50%,#d4b0a8 100%)',
      desc: '瀏覽 GRL 官網尋找您的心頭好，將網址貼給機器人。我們將即時為您計算包含代購費與國際運費的台幣總額。',
      note: null },
    { num: '02', title: '選色加入購物車', icon: '🛒',
      grad: 'linear-gradient(135deg,#e8d5c4 0%,#d8c0aa 50%,#c8a890 100%)',
      desc: '在報價卡片上優雅地挑選顏色與尺寸。您可以連續貼上多個網址，一次滿足所有購物願望。',
      note: { type: 'quote', text: '溫馨提示：您的購物車具有 48 小時的短暫記憶，請及時完成結帳。' } },
    { num: '03', title: '填資料・送出訂單', icon: '📋',
      grad: 'linear-gradient(135deg,#d8e0d4 0%,#c4d0be 50%,#b0c0a8 100%)',
      desc: '確認購物清單後，填寫基本聯絡資料。我們會細心核對每一筆訂單，確保您的商品正確無誤。',
      note: null },
    { num: '04', title: '收賣貨便連結', icon: '📩',
      grad: 'linear-gradient(135deg,#d4d8e8 0%,#bec4d8 50%,#a8b0c8 100%)',
      desc: '核對完成後，專屬的賣貨便連結將透過 LINE 傳送給您。這是一份正式的保障，讓您的交易更安心。',
      note: { type: 'alert', text: '為確保交易安全，請務必透過我們官方 LINE 傳送的連結進行結帳，勿自行前往。' } },
    { num: '05', title: '7-11 到店取件', icon: '📦',
      grad: 'linear-gradient(135deg,#ddd4e8 0%,#c8bcd8 50%,#b4a8c8 100%)',
      desc: '商品跨海抵達台灣後，我們會第一時間通知您。並請期待當商品送往您指定的 7-11 門市，開啟您的開箱驚喜。',
      note: { type: 'check', text: '期待與您的商品相見 🌸' } },
  ];

  const stepCards = steps.map((s, i) => {
    const isReversed = i % 2 !== 0;
    const noteHtml = s.note
      ? s.note.type === 'quote'
        ? `<div style="margin-top:20px;padding:14px 16px;background:#fcf7f3;border-left:3px solid #cba29b;font-size:13px;font-style:italic;color:#8c8279;line-height:1.7">${s.note.text}</div>`
        : s.note.type === 'alert'
        ? `<div style="margin-top:20px;display:flex;gap:10px;padding:14px;background:#f6f5f2;border-radius:8px;font-size:13px;color:#8c8279;line-height:1.6"><span style="flex-shrink:0;margin-top:2px">⚠️</span><span>${s.note.text}</span></div>`
        : `<div style="margin-top:20px;display:flex;align-items:center;gap:8px;color:#cba29b;font-size:14px;font-weight:500"><span>✅</span><span>${s.note.text}</span></div>`
      : '';

    return `
<div class="step-row${isReversed ? ' rev' : ''}">
  <div class="step-img-wrap">
    <div class="step-art">
      <img src="/public/guide/step${i + 1}.jpg" alt="${s.title}" style="width:100%;height:100%;object-fit:cover">
      <div class="art-overlay"></div>
    </div>
  </div>
  <div class="step-content">
    <div class="step-header">
      <span class="step-num-sm">${s.num}</span>
      <div class="step-line"></div>
      <span class="step-icon-sm">${s.icon}</span>
    </div>
    <h2 class="step-title">${s.title}</h2>
    <p class="step-desc">${s.desc}</p>
    ${noteHtml}
  </div>
</div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>GRL 代購流程指南 | Bijin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@300;400;700&family=Noto+Sans+TC:wght@300;400;500&display=swap">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Noto Sans TC',sans-serif;background:#faf9f6;color:#4a423e;padding-bottom:60px}
.step-row{display:flex;flex-direction:column;gap:32px;margin-bottom:64px;align-items:center}
.step-img-wrap{width:100%;flex-shrink:0}
.step-art{position:relative;width:100%;aspect-ratio:4/3;border-radius:6px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.12)}
.art-overlay{position:absolute;inset:0;background:linear-gradient(to bottom right,rgba(255,255,255,.04),rgba(0,0,0,.06));pointer-events:none}
.step-content{width:100%;padding:0 4px}
.step-header{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.step-num-sm{font-family:'Noto Serif TC',serif;font-size:52px;color:#e5e1da;line-height:1}
.step-line{height:1px;flex:1;background:#e5e1da}
.step-icon-sm{font-size:22px}
.step-title{font-size:22px;font-weight:700;color:#2d2723;margin-bottom:12px;letter-spacing:-.5px}
.step-desc{color:#6b625a;line-height:1.9;font-size:14px;font-weight:300}
@media(min-width:768px){
  .step-row{flex-direction:row;gap:64px}
  .step-row.rev{flex-direction:row-reverse}
  .step-img-wrap{width:60%}
  .step-content{width:40%;flex-shrink:0}
}
</style>
</head>
<body>
<div style="max-width:900px;margin:0 auto;padding:40px 20px">

  <header style="text-align:center;margin-bottom:72px">
    <div style="display:inline-flex;align-items:center;gap:8px;margin-bottom:20px;padding:6px 16px;border:1px solid #e5e1da;border-radius:999px;font-size:11px;letter-spacing:2px;color:#8c8279;text-transform:uppercase">
      ✦ Premium Shopping Experience
    </div>
    <h1 style="font-family:'Noto Serif TC',serif;font-size:clamp(28px,6vw,40px);font-weight:700;color:#2d2723;margin-bottom:16px;line-height:1.2">GRL 代購流程指南</h1>
    <p style="color:#8c8279;font-size:14px;max-width:480px;margin:0 auto;font-weight:300;line-height:1.9">
      我們致力於為您帶來最優質的日系穿搭體驗。<br>跟著以下五個簡潔步驟，輕鬆完成您的跨國購物。
    </p>
  </header>

  ${stepCards}

  <footer style="text-align:center;border-top:1px solid #e5e1da;padding-top:40px;margin-top:20px">
    <p style="font-size:11px;letter-spacing:2px;color:#8c8279;text-transform:uppercase;margin-bottom:12px">Bijin 日本正品代購</p>
    <p style="font-family:'Noto Serif TC',serif;font-style:italic;color:#cba29b;font-size:17px">讓優雅，成為您的日常。</p>
  </footer>
</div>
</body>
</html>`;
}

// ── LIFF 購物車頁面 ───────────────────────────────────────────────────────────
app.get('/cart', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
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
  const { userId, displayName, productId, productName, color, size, jpy, suggestedPrice, productUrl, imageUrl, isPreorder } = req.body;
  if (!userId || !productId || !color || !size) return res.status(400).json({ error: 'missing fields' });
  try {
    await addToCartSheet(userId, displayName || '', productId, productName || productId, color, size, jpy || 0, suggestedPrice || 0, productUrl || '', imageUrl || '', !!isPreorder);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function deductMemberPoints(sheets, userId, pointsToDeduct) {
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

async function markCouponUsed(sheets, couponCode, orderId) {
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

app.post('/api/order', express.json(), async (req, res) => {
  const { userId, displayName, cartItems, buyerInfo, discountInfo = {} } = req.body;
  if (!userId || !cartItems || !buyerInfo) return res.status(400).json({ error: 'missing fields' });
  try {
    const sheets = getSheetsClient();
    const { pointsUsed = 0, couponCode = '', couponAmount = 0 } = discountInfo;

    // 驗證點數
    if (pointsUsed > 0) {
      const member = await getMember(sheets, userId);
      if (!member || pointsUsed > (member.points || 0)) return res.status(400).json({ error: '點數不足' });
    }
    // 驗證優惠券
    if (couponCode) {
      const coupons = await getActiveCoupons(sheets, userId);
      if (!coupons.find(c => c.couponCode === couponCode)) return res.status(400).json({ error: '優惠券無效或已使用' });
    }

    const result = await submitOrder(userId, displayName || '', cartItems, buyerInfo, { pointsUsed, couponCode, couponAmount });

    // 套用折扣
    if (pointsUsed > 0) await deductMemberPoints(sheets, userId, pointsUsed).catch(e => console.error('[deductPoints error]', e.message));
    if (couponCode) await markCouponUsed(sheets, couponCode, result.orderId).catch(e => console.error('[markCoupon error]', e.message));

    const client = new line.Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
    // 合併相同規格，顯示數量
    const _iMap = {};
    for (const i of cartItems) {
      const k = `${i.productId}|${i.color}|${i.size}`;
      if (!_iMap[k]) _iMap[k] = { ...i, qty: 0 };
      _iMap[k].qty++;
    }
    const _iList = Object.values(_iMap);
    const itemsText = _iList.map(i => `${i.isPreorder ? '【預購】' : '・'}${(i.productId||'').toUpperCase()} ${translateColorWithJp(i.color)} ${i.size} NT$${i.suggestedPrice}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join('\n')
      + `\n共 ${cartItems.length} 件`;

    // 折扣文字（賣家用）
    let adminDiscText = '';
    if (result.discountTotal > 0) {
      adminDiscText += `\n━━━━━━━━━━`;
      if (pointsUsed > 0) adminDiscText += `\n💎 點數折抵：-NT$${pointsUsed}（${pointsUsed}點）`;
      if (couponCode) adminDiscText += `\n🎟 優惠券：${couponCode}（-NT$${couponAmount}）`;
      adminDiscText += `\n✅ 實付金額：NT$${result.finalAmount}`;
    }
    // 折扣文字（買家用）
    let buyerDiscText = '';
    if (result.discountTotal > 0) {
      if (pointsUsed > 0) buyerDiscText += `\n💎 點數折抵：-NT$${pointsUsed}（${pointsUsed}點）`;
      if (couponCode && couponAmount > 0) buyerDiscText += `\n🎟 優惠券折抵：-NT$${couponAmount}`;
      buyerDiscText += `\n✅ 實付金額：NT$${result.finalAmount}`;
    } else {
      buyerDiscText = `\n合計：NT$${result.totalTwd}`;
    }

    const [adminR, buyerR] = await Promise.allSettled([
      client.pushMessage(ADMIN_USER_ID, {
        type: 'text',
        text: `🛍 新訂單！\n訂單ID: ${result.orderId}\n時間: ${result.orderTime}\n━━━━━━━━━━\n${itemsText}\n━━━━━━━━━━\n商品小計: NT$${result.totalTwd}${adminDiscText || ('\n合計: NT$' + result.totalTwd)}\n\n買家: ${buyerInfo.name}\n手機: ${buyerInfo.phone}\n聯繫方式: ${buyerInfo.contactMethod} @${buyerInfo.contactAccount}${buyerInfo.note ? '\n備註: ' + buyerInfo.note : ''}`,
      }),
      client.pushMessage(userId, {
        type: 'text',
        text: `🎉 訂單已收到！\n\n訂單編號：${result.orderId}\n下單時間：${result.orderTime}\n━━━━━━━━━━\n${itemsText}\n━━━━━━━━━━\n商品小計：NT$${result.totalTwd}${buyerDiscText}\n\n我們確認後會盡快提供賣貨便下單連結，請耐心等候 🌸`,
      }),
    ]);
    if (adminR.status === 'rejected') console.error('[notify admin error]', adminR.reason?.message);
    if (buyerR.status === 'rejected') console.error('[notify buyer error]', buyerR.reason?.message);
    res.json({ status: 'ok', orderId: result.orderId });
  } catch (err) {
    console.error('[api/order error]', err.message);
    res.status(500).json({ error: err.message });
  }
});




// ── Debug：測試 LINE push 通知 ────────────────────────────────────────────────
app.get('/api/debug/notify', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const client = new line.Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
    await client.pushMessage(ADMIN_USER_ID, { type: 'text', text: '🔧 通知測試 - 如果收到這訊息代表 LINE push 正常' });
    res.json({ ok: true, message: '推播成功' });
  } catch(e) {
    res.json({ ok: false, error: e.message, statusCode: e.statusCode });
  }
});

// ── 一次性：建立並啟用 Rich Menu ──────────────────────────────────────────────
app.get('/admin/setup-rich-menu', async (req, res) => {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const authHeader = { Authorization: `Bearer ${token}` };
  const jsonHeader = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    // 1. 找出現有 Rich Menu 並先把圖片存起來
    const listRes = await axios.get('https://api.line.me/v2/bot/richmenu/list', { headers: authHeader });
    const existingMenus = listRes.data.richmenus || [];
    let savedImg = null, savedContentType = 'image/jpeg';
    for (const m of existingMenus) {
      try {
        const imgRes = await axios.get(
          `https://api-data.line.me/v2/bot/richmenu/${m.richMenuId}/content`,
          { headers: authHeader, responseType: 'arraybuffer', timeout: 15000 }
        );
        savedImg = imgRes.data;
        savedContentType = imgRes.headers['content-type'] || 'image/jpeg';
        break; // 只需要一張
      } catch { continue; }
    }

    // 2. 刪除所有舊 Rich Menu
    for (const m of existingMenus) {
      await axios.delete(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { headers: authHeader }).catch(() => {});
    }

    // 3. 建立新 Rich Menu
    const richMenuId = await setupRichMenu('');

    // 4. 上傳圖片（若有找到）
    if (savedImg) {
      await axios.post(
        `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
        savedImg,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': savedContentType } }
      );
    }

    // 5. 設為所有用戶預設選單
    await axios.post(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {}, { headers: jsonHeader });

    res.json({ status: 'ok', richMenuId, hadImage: !!savedImg, message: 'Rich Menu 已建立並設為預設選單' });
  } catch (err) {
    console.error('[setup-rich-menu error]', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 強制更新特定用戶的 Rich Menu ─────────────────────────────────────────────
app.get('/admin/link-rich-menu', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    // 取得目前預設 Rich Menu ID
    const defaultRes = await axios.get('https://api.line.me/v2/bot/user/all/richmenu', { headers });
    const richMenuId = defaultRes.data.richMenuId;
    if (!richMenuId) return res.status(404).json({ error: '找不到預設 Rich Menu' });
    // 強制綁定給指定用戶
    await axios.post(`https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`, {}, { headers });
    res.json({ ok: true, userId, richMenuId });
  } catch (e) { res.status(500).json({ error: e.message, detail: e.response?.data }); }
});

// ── 除錯：查看目前 Rich Menu 定義 ────────────────────────────────────────────
app.get('/admin/check-rich-menu', async (req, res) => {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const list = await axios.get('https://api.line.me/v2/bot/richmenu/list', { headers });
    const defaultRes = await axios.get('https://api.line.me/v2/bot/user/all/richmenu', { headers }).catch(() => ({ data: {} }));
    res.json({ menus: list.data.richmenus, defaultId: defaultRes.data.richMenuId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員：會員管理頁面 ────────────────────────────────────────────────────
app.get('/admin/members', async (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_KEY) return res.status(401).send('Unauthorized');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  let members = [], loadError = '';
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A:N` });
    const rows = resp.data.values || [];
    members = rows.slice(1).map((r, i) => ({
      rowIndex: i + 2,
      userId: r[0] || '', displayName: r[1] || '', joinDate: r[2] || '',
      birthday: r[3] || '', referralCode: r[4] || '', referredByCode: r[5] || '',
      currentYear: parseInt(r[7]) || new Date().getFullYear(),
      yearlySpend: parseFloat(r[8]) || 0, tier: r[9] || '一般',
      points: parseInt(r[10]) || 0, lastUpdated: r[11] || '',
      name: r[12] || '', phone: r[13] || '',
    })).filter(m => m.userId);
  } catch(e) { loadError = e.message; }

  const membersJson = JSON.stringify(members).replace(/<\/script>/gi, '<\\/script>');
  const adminKey = key;

  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bijin 會員管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f3f0;min-height:100vh;color:#2d2218}
header{background:#fff;border-bottom:2px solid #e8ddd4;padding:0 24px;position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;height:56px}
.hdr-logo{font-size:18px;font-weight:700;color:#7a5c3e}
.btn{background:#7a5c3e;color:#fff;border:none;border-radius:8px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
.btn:hover{background:#5e4530}
.btn-sm{padding:4px 10px;font-size:12px;border-radius:6px}
.btn-gold{background:#c9a98a}
.btn-danger{background:#e53935}
.toolbar{display:flex;gap:10px;align-items:center;padding:14px 24px;background:#fff;border-bottom:1px solid #eee;flex-wrap:wrap}
.search-box{border:1px solid #ddd;border-radius:8px;padding:7px 12px;font-size:13px;outline:none;min-width:220px}
.search-box:focus{border-color:#c9a98a}
.summary{padding:10px 24px;font-size:13px;color:#888}
table{width:100%;border-collapse:collapse;background:#fff}
thead{background:#f5ede0}
th{padding:10px 12px;text-align:left;font-size:12px;color:#7a5c3e;font-weight:700;white-space:nowrap}
td{padding:10px 12px;font-size:13px;color:#333;border-bottom:1px solid #f0e8de;vertical-align:middle}
tr:hover td{background:#fffaf5}
.tier-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700}
.tier-一般{background:#f5ede0;color:#a08060}
.tier-銀卡{background:#e8e8e8;color:#666}
.tier-金卡{background:#fff3cd;color:#a07800}
.tier-白金{background:#e8f0fe;color:#3949ab}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;align-items:center;justify-content:center}
.modal.show{display:flex}
.modal-box{background:#fff;border-radius:14px;padding:24px;width:340px;max-width:95vw}
.modal-title{font-size:16px;font-weight:700;color:#7a5c3e;margin-bottom:16px}
.form-row{margin-bottom:12px}
.form-row label{display:block;font-size:12px;color:#888;margin-bottom:4px}
.form-row input, .form-row select{width:100%;border:1px solid #ddd;border-radius:8px;padding:8px 10px;font-size:14px;outline:none}
.form-row input:focus, .form-row select:focus{border-color:#c9a98a}
.modal-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:200;white-space:nowrap}
.toast.show{opacity:1}
</style>
</head>
<body>
<header>
  <div class="hdr-logo">👥 Bijin 會員管理</div>
  <a href="/admin?key=${adminKey}" class="btn">← 回訂單後台</a>
</header>
<div class="toolbar">
  <input class="search-box" id="search-box" placeholder="搜尋姓名 / 手機 / LINE名稱…" oninput="render()">
  <select id="filter-tier" onchange="render()" style="border:1px solid #ddd;border-radius:8px;padding:7px 10px;font-size:13px;outline:none;background:#fff">
    <option value="">全部等級</option>
    <option value="一般">一般</option>
    <option value="銀卡">銀卡</option>
    <option value="金卡">金卡</option>
    <option value="白金">白金</option>
  </select>
</div>
<div class="summary" id="summary"></div>
${loadError ? `<div style="padding:20px;color:#c0392b;font-weight:600">載入失敗：${loadError}</div>` : ''}
<div style="overflow-x:auto">
<table>
  <thead>
    <tr>
      <th>姓名</th><th>LINE 名稱</th><th>手機</th><th>等級</th>
      <th>年度消費</th><th>可用點數</th><th>生日</th><th>加入日期</th><th>操作</th>
    </tr>
  </thead>
  <tbody id="tbody"></tbody>
</table>
</div>

<!-- 優惠券 Modal -->
<div class="modal" id="coupon-modal">
  <div class="modal-box" style="width:420px">
    <div class="modal-title">🎟 優惠券管理 — <span id="coupon-member-name"></span></div>
    <div id="coupon-list-area" style="margin-bottom:16px;max-height:200px;overflow-y:auto"></div>
    <div style="border-top:1px solid #f0e8de;padding-top:14px">
      <div style="font-size:13px;font-weight:700;color:#7a5c3e;margin-bottom:10px">＋ 新增優惠券</div>
      <div class="form-row">
        <label>說明 / 類型（例：生日禮、客服補發、首單優惠）</label>
        <input id="cpn-type" type="text" placeholder="輸入說明">
      </div>
      <div style="display:flex;gap:8px">
        <div class="form-row" style="flex:1">
          <label>金額（NT$）</label>
          <input id="cpn-amount" type="number" min="1" placeholder="50">
        </div>
        <div class="form-row" style="flex:1">
          <label>張數</label>
          <input id="cpn-qty" type="number" min="1" max="10" value="1">
        </div>
      </div>
      <div class="form-row">
        <label>到期日</label>
        <input id="cpn-expiry" type="date">
      </div>
    </div>
    <div class="modal-btns">
      <button class="btn" style="background:#aaa" onclick="closeCouponModal()">關閉</button>
      <button class="btn btn-gold" onclick="addCoupon()">發行優惠券</button>
    </div>
  </div>
</div>

<!-- 編輯 Modal -->
<div class="modal" id="edit-modal">
  <div class="modal-box">
    <div class="modal-title">✏️ 調整會員資料</div>
    <input type="hidden" id="edit-row">
    <div class="form-row">
      <label>姓名</label>
      <input id="edit-name" type="text" readonly style="background:#f5f5f5;color:#aaa">
    </div>
    <div class="form-row">
      <label>等級</label>
      <select id="edit-tier">
        <option>一般</option><option>銀卡</option><option>金卡</option><option>白金</option>
      </select>
    </div>
    <div class="form-row">
      <label>可用點數</label>
      <input id="edit-points" type="number" min="0">
    </div>
    <div class="form-row">
      <label>年度消費（NT$）</label>
      <input id="edit-spend" type="number" min="0">
    </div>
    <div class="modal-btns">
      <button class="btn" style="background:#aaa" onclick="closeModal()">取消</button>
      <button class="btn btn-gold" onclick="saveEdit()">儲存</button>
    </div>
  </div>
</div>
<div id="toast" class="toast"></div>

<script>
var allMembers = ${membersJson};
var KEY = '${adminKey}';

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function render() {
  var kw = (document.getElementById('search-box').value||'').trim().toLowerCase();
  var tier = document.getElementById('filter-tier').value;
  var list = allMembers.filter(function(m){
    if (tier && m.tier !== tier) return false;
    if (!kw) return true;
    return (m.name||'').toLowerCase().indexOf(kw)>=0
      || (m.displayName||'').toLowerCase().indexOf(kw)>=0
      || (m.phone||'').indexOf(kw)>=0;
  });
  document.getElementById('summary').textContent = '共 ' + list.length + ' 位會員（總計 ' + allMembers.length + ' 位）';
  var rows = list.map(function(m){
    return '<tr>'
      + '<td><strong>' + esc(m.name) + '</strong></td>'
      + '<td style="color:#888">' + esc(m.displayName) + '</td>'
      + '<td style="font-family:monospace">' + esc(m.phone) + '</td>'
      + '<td><span class="tier-badge tier-' + esc(m.tier) + '">' + esc(m.tier) + '</span></td>'
      + '<td>NT$' + (m.yearlySpend||0).toLocaleString() + '</td>'
      + '<td><strong style="color:#c9a98a">' + (m.points||0) + ' 點</strong></td>'
      + '<td>' + esc(m.birthday||'—') + '</td>'
      + '<td style="color:#aaa;font-size:12px">' + esc(m.joinDate||'—') + '</td>'
      + '<td><button class="btn btn-sm btn-gold" onclick="openEdit(' + m.rowIndex + ')" style="margin-right:4px">調整</button><button class="btn btn-sm" style="background:#c9a98a" data-uid="' + esc(m.userId) + '" data-name="' + esc(m.name||m.displayName) + '" onclick="openCoupons(this.dataset.uid,this.dataset.name)">優惠券</button></td>'
      + '</tr>';
  }).join('');
  document.getElementById('tbody').innerHTML = rows || '<tr><td colspan="9" style="text-align:center;color:#ccc;padding:20px">找不到符合條件的會員</td></tr>';
}

function openEdit(rowIndex) {
  var m = allMembers.find(function(x){ return x.rowIndex === rowIndex; });
  if (!m) return;
  document.getElementById('edit-row').value = rowIndex;
  document.getElementById('edit-name').value = m.name + '（' + m.displayName + '）';
  document.getElementById('edit-tier').value = m.tier;
  document.getElementById('edit-points').value = m.points || 0;
  document.getElementById('edit-spend').value = m.yearlySpend || 0;
  document.getElementById('edit-modal').classList.add('show');
}

function closeModal() {
  document.getElementById('edit-modal').classList.remove('show');
}

async function saveEdit() {
  var rowIndex = parseInt(document.getElementById('edit-row').value);
  var tier = document.getElementById('edit-tier').value;
  var points = parseInt(document.getElementById('edit-points').value) || 0;
  var yearlySpend = parseFloat(document.getElementById('edit-spend').value) || 0;
  try {
    var r = await fetch('/api/admin/member-adjust', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, rowIndex, tier, points, yearlySpend })
    });
    var d = await r.json();
    if (!d.ok) { showToast('❌ ' + d.error); return; }
    var m = allMembers.find(function(x){ return x.rowIndex === rowIndex; });
    if (m) { m.tier = tier; m.points = points; m.yearlySpend = yearlySpend; }
    closeModal();
    render();
    showToast('✅ 已更新');
  } catch(e) { showToast('❌ 網路錯誤'); }
}

function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, 2500);
}

var currentCouponUserId = '', currentCouponDisplayName = '';

async function openCoupons(userId, memberName) {
  currentCouponUserId = userId;
  currentCouponDisplayName = memberName;
  document.getElementById('coupon-member-name').textContent = memberName;
  document.getElementById('coupon-list-area').innerHTML = '<div style="color:#aaa;font-size:13px">載入中…</div>';
  // 預設到期日 3 個月後
  var d = new Date(); d.setMonth(d.getMonth()+3);
  document.getElementById('cpn-expiry').value = d.toISOString().slice(0,10);
  document.getElementById('cpn-type').value = '';
  document.getElementById('cpn-amount').value = '';
  document.getElementById('cpn-qty').value = '1';
  document.getElementById('coupon-modal').classList.add('show');
  try {
    var r = await fetch('/api/admin/member-coupons?key=' + KEY + '&userId=' + encodeURIComponent(userId));
    var d2 = await r.json();
    renderCouponList(d2.coupons || []);
  } catch(e) { document.getElementById('coupon-list-area').innerHTML = '<div style="color:#e53935;font-size:13px">載入失敗</div>'; }
}

function renderCouponList(coupons) {
  if (!coupons.length) {
    document.getElementById('coupon-list-area').innerHTML = '<div style="color:#aaa;font-size:13px">目前無優惠券</div>';
    return;
  }
  var statusLabel = {'unused':'未使用','used':'已使用','voided':'已作廢','expired':'已過期'};
  var statusColor = {'unused':'#4caf50','used':'#aaa','voided':'#e53935','expired':'#aaa'};
  document.getElementById('coupon-list-area').innerHTML = coupons.map(function(c){
    var st = c.status || 'unused';
    var canVoid = st === 'unused';
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #f5ede0;font-size:13px">'
      + '<div><div style="font-weight:bold;color:#7a5c3e">' + esc(c.type) + '　NT$' + c.amount + '</div>'
      + '<div style="font-size:11px;color:#aaa">' + esc(c.couponCode||'') + '　到期：' + esc(c.expiryDate) + '</div></div>'
      + '<div style="display:flex;align-items:center;gap:6px">'
      + '<span style="font-size:11px;color:' + statusColor[st] + ';font-weight:700">' + (statusLabel[st]||st) + '</span>'
      + (canVoid ? '<button class="btn btn-sm btn-danger" style="padding:2px 8px;font-size:11px" onclick="voidCoupon(' + c.rowIndex + ',this)">作廢</button>' : '')
      + '</div></div>';
  }).join('');
}

function closeCouponModal() {
  document.getElementById('coupon-modal').classList.remove('show');
}

async function addCoupon() {
  var type = document.getElementById('cpn-type').value.trim();
  var amount = parseInt(document.getElementById('cpn-amount').value);
  var qty = parseInt(document.getElementById('cpn-qty').value) || 1;
  var expiry = document.getElementById('cpn-expiry').value;
  if (!type || !amount || !expiry) { showToast('請填寫所有欄位'); return; }
  try {
    var r = await fetch('/api/admin/member-coupon-add', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ key:KEY, userId:currentCouponUserId, displayName:currentCouponDisplayName, type, amount, expiryDate:expiry, qty })
    });
    var d = await r.json();
    if (!d.ok) { showToast('❌ ' + d.error); return; }
    showToast('✅ 已發行 ' + d.codes.length + ' 張優惠券');
    // 重新載入優惠券列表
    var r2 = await fetch('/api/admin/member-coupons?key=' + KEY + '&userId=' + encodeURIComponent(currentCouponUserId));
    var d2 = await r2.json();
    renderCouponList(d2.coupons || []);
  } catch(e) { showToast('❌ 網路錯誤'); }
}

async function voidCoupon(rowIndex, btn) {
  btn.disabled = true;
  try {
    var r = await fetch('/api/admin/member-coupon-void', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ key:KEY, rowIndex })
    });
    var d = await r.json();
    if (!d.ok) { showToast('❌ ' + d.error); btn.disabled=false; return; }
    showToast('✅ 已作廢');
    var r2 = await fetch('/api/admin/member-coupons?key=' + KEY + '&userId=' + encodeURIComponent(currentCouponUserId));
    var d2 = await r2.json();
    renderCouponList(d2.coupons || []);
  } catch(e) { showToast('❌ 網路錯誤'); btn.disabled=false; }
}

render();
</script>
</body>
</html>`);
});

// ── 管理員 API：調整會員資料 ──────────────────────────────────────────────────
app.post('/api/admin/member-adjust', express.json(), async (req, res) => {
  const { key, rowIndex, tier, points, yearlySpend } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!rowIndex || !tier) return res.status(400).json({ error: 'missing fields' });
  const VALID_TIERS = ['一般', '銀卡', '金卡', '白金'];
  if (!VALID_TIERS.includes(tier)) return res.status(400).json({ error: '等級無效' });
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${MEMBER_SHEET}!I${rowIndex}:L${rowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [[parseFloat(yearlySpend)||0, tier, parseInt(points)||0, todayStr()]] },
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員 API：取得會員優惠券 ────────────────────────────────────────────────
app.get('/api/admin/member-coupons', async (req, res) => {
  const { key, userId } = req.query;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!A:I` });
    const rows = resp.data.values || [];
    const coupons = rows.slice(1)
      .map((r, i) => ({ rowIndex: i + 2, couponCode: r[0], userId: r[1], type: r[3], amount: parseInt(r[4])||0, issueDate: r[5], expiryDate: r[6], status: r[7]||'unused' }))
      .filter(c => c.userId === userId);
    res.json({ ok: true, coupons });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員 API：新增優惠券給會員 ──────────────────────────────────────────────
app.post('/api/admin/member-coupon-add', express.json(), async (req, res) => {
  const { key, userId, displayName, type, amount, expiryDate, qty } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!userId || !type || !amount || !expiryDate) return res.status(400).json({ error: 'missing fields' });
  try {
    const sheets = getSheetsClient();
    const codes = await issueCoupons(sheets, userId, displayName || '', type, parseInt(amount), parseInt(qty)||1, expiryDate);
    res.json({ ok: true, codes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員 API：作廢優惠券 ────────────────────────────────────────────────────
app.post('/api/admin/member-coupon-void', express.json(), async (req, res) => {
  const { key, rowIndex } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!rowIndex) return res.status(400).json({ error: 'rowIndex required' });
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!H${rowIndex}`,
      valueInputOption: 'RAW', resource: { values: [['voided']] },
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員 API：取得所有訂單 ──────────────────────────────────────────────────
app.get('/api/admin/orders', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache');
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sheets = getSheetsClient();
    const resp = await Promise.race([
      sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:R` }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Sheets API timeout')), 8000)),
    ]);
    const rows = (resp.data.values || []).slice(1);
    const orders = rows.map((row, i) => ({
      rowIndex:        i + 2,
      orderId:         row[0] || '',
      orderTime:       row[1] || '',
      userId:          row[2] || '',
      items:           row[3] || '',
      total:           row[4] || '',
      buyerName:       row[5] || '',
      phone:           row[6] || '',
      contact:         row[7] || '',
      contactId:       row[8] || '',
      note:            row[9] || '',
      status:          row[10] || '待確認',
      pointsUsed:      parseInt(row[11]) || 0,
      couponCode:      row[12] || '',
      discountTotal:   parseInt(row[13]) || 0,
      finalAmount:     parseInt(row[14]) || parseInt(row[4]) || 0,
      lineDisplayName: row[15] || '',
      adminNote:       row[16] || '',
      warehouse:       row[17] || '',
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
    // 訂單轉已完成時，觸發點數與邀請獎勵
    if (status === '已完成') {
      const orderResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A${rowIndex}:P${rowIndex}` });
      const orderRow = (orderResp.data.values || [])[0] || [];
      const buyerUserId = orderRow[2] || '';
      const displayName = orderRow[15] || '';
      const totalTwd = parseFloat(orderRow[4]) || 0;
      if (buyerUserId) {
        await processOrderCompletion(sheets, buyerUserId, displayName, orderRow[0], totalTwd)
          .catch(e => console.error('[processOrderCompletion error]', e.message));
      }
    }
    // 訂單退單時，撤銷點數
    if (status === '退單') {
      const orderResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A${rowIndex}:A${rowIndex}` });
      const returnOrderId = ((orderResp.data.values || [])[0] || [])[0] || '';
      if (returnOrderId) {
        await processOrderReturn(sheets, returnOrderId)
          .catch(e => console.error('[processOrderReturn error]', e.message));
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 管理員 API：儲存內部備註（Q欄，不通知買家） ───────────────────────────────
app.post('/api/admin/order-note', express.json(), async (req, res) => {
  const { key, rowIndex, adminNote } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!rowIndex) return res.status(400).json({ error: 'rowIndex required' });
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${ORDER_SHEET}!Q${rowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [[adminNote || '']] },
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員 API：更新倉庫分類（R欄） ───────────────────────────────────────────
app.post('/api/admin/order-warehouse', express.json(), async (req, res) => {
  const { key, rowIndex, warehouse } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!rowIndex) return res.status(400).json({ error: 'rowIndex required' });
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${ORDER_SHEET}!R${rowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [[warehouse || '']] },
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員頁面 ────────────────────────────────────────────────────────────────
app.get('/admin', async (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_KEY) return res.status(401).send('Unauthorized');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  const adminKey = ADMIN_KEY;
  const BUILD_VERSION = 'v2.7';
  // ── 伺服器端直接讀取訂單，嵌入頁面 ──
  let ssrOrders = [];
  let ssrError = '';
  try {
    const sheets = getSheetsClient();
    const resp = await Promise.race([
      sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:R` }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Sheets timeout')), 25000)),
    ]);
    const rows = (resp.data.values || []).slice(1);
    ssrOrders = rows.map((row, i) => ({
      rowIndex:        i + 2,
      orderId:         row[0] || '',
      orderTime:       row[1] || '',
      userId:          row[2] || '',
      items:           row[3] || '',
      total:           row[4] || '',
      buyerName:       row[5] || '',
      phone:           row[6] || '',
      contact:         row[7] || '',
      contactId:       row[8] || '',
      note:            row[9] || '',
      status:          row[10] || '待確認',
      pointsUsed:      parseInt(row[11]) || 0,
      couponCode:      row[12] || '',
      discountTotal:   parseInt(row[13]) || 0,
      finalAmount:     parseInt(row[14]) || parseInt(row[4]) || 0,
      lineDisplayName: row[15] || '',
      adminNote:       row[16] || '',
      warehouse:       row[17] || '',
    })).reverse();
  } catch (e) {
    ssrError = e.message;
  }
  // 取會員總數
  let ssrMemberCount = 0;
  try {
    const sheets2 = getSheetsClient();
    const mResp = await sheets2.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A:A` });
    ssrMemberCount = Math.max(0, ((mResp.data.values || []).length - 1));
  } catch(e) { /* ignore */ }
  const ssrOrdersJson = JSON.stringify(ssrOrders).replace(/<\/script>/gi, '<\\/script>');
  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bijin 管理後台</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f3f0;min-height:100vh;color:#2d2218}
/* ── Header ── */
header{background:#fff;border-bottom:2px solid #e8ddd4;padding:0 24px;position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;height:56px}
.hdr-left{display:flex;align-items:center;gap:12px}
.hdr-logo{font-size:20px;font-weight:700;color:#7a5c3e;letter-spacing:.5px}
.hdr-counts{display:flex;gap:10px;flex-wrap:wrap}
.hdr-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
.pill-active{background:#fff3e0;color:#c75c00}
.pill-done{background:#f3e5f5;color:#6a1b9a}
.pill-return{background:#fbe9e7;color:#bf360c}
.pill-cancel{background:#fafafa;color:#999;border:1px solid #eee}
/* ── Toolbar ── */
.toolbar{padding:12px 24px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#fff;border-bottom:1px solid #ede8e2}
.toolbar select{border:1px solid #ddd;border-radius:8px;padding:7px 12px;font-size:13px;background:#fff;color:#555;cursor:pointer;outline:none}
.toolbar select:focus{border-color:#c9a98a}
.btn-refresh{background:#7a5c3e;color:#fff;border:none;border-radius:8px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px}
.btn-refresh:hover{background:#5e4530}
.search-box{border:1px solid #ddd;border-radius:8px;padding:7px 12px;font-size:13px;outline:none;min-width:160px}
.search-box:focus{border-color:#c9a98a}
#err-bar{display:none;background:#fde8e4;color:#c0392b;padding:10px 24px;font-size:13px;font-weight:600;border-bottom:1px solid #f5c6c0}
#err-bar button{margin-left:12px;background:#c0392b;color:#fff;border:none;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
/* ── Grid ── */
#orders{padding:16px 24px 80px;display:grid;grid-template-columns:repeat(4,1fr);gap:14px;align-items:start}
@media(max-width:1300px){#orders{grid-template-columns:repeat(3,1fr)}}
@media(max-width:900px){#orders{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){#orders{grid-template-columns:1fr;padding:12px 12px 80px}}
/* ── Card ── */
.order-card{background:#fff;border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,.07);overflow:hidden;transition:box-shadow .2s}
.order-card:hover{box-shadow:0 4px 16px rgba(0,0,0,.1)}
.card-top{display:flex;justify-content:space-between;align-items:flex-start;padding:12px 16px 0}
.card-id{font-size:11px;color:#bbb;font-family:monospace;letter-spacing:.3px}
.card-time{font-size:11px;color:#ccc;text-align:right;line-height:1.4}
.card-status{padding:6px 16px 10px}
.card-body{padding:0 16px 12px}
.buyer-name{font-size:15px;font-weight:700;color:#2d2218;margin-bottom:2px}
.line-name{font-size:12px;color:#bbb;font-weight:400;margin-bottom:8px}
.order-items{font-size:12px;color:#777;line-height:1.9;margin-bottom:8px;border-left:3px solid #ede8e2;padding-left:10px}
.price-row{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.price-final{font-size:17px;font-weight:700;color:#7a5c3e}
.price-orig{font-size:12px;color:#bbb;text-decoration:line-through}
.price-disc{font-size:12px;color:#a55;background:#fff0f0;border-radius:4px;padding:1px 6px}
.info-row{font-size:12px;color:#999;margin-top:3px;display:flex;align-items:center;gap:6px}
.info-label{background:#f0ebe4;color:#7a5c3e;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:600;white-space:nowrap}
.card-divider{border:none;border-top:1px solid #f0ebe4;margin:0}
/* ── Card footer ── */
.card-footer{padding:10px 12px;display:flex;gap:8px;align-items:center;background:#fcfaf8}
.status-select{border:1px solid #ddd;border-radius:8px;padding:7px 10px;font-size:13px;background:#fff;flex:1;min-width:120px;outline:none;cursor:pointer}
.status-select:focus{border-color:#c9a98a}
.btn-save{background:#c9a98a;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap}
.btn-save:hover{background:#b0885e}
.btn-save:disabled{opacity:.5;cursor:default}
/* ── Notify (賣貨便) row ── */
.notify-row{display:none;padding:10px 12px;border-top:1px solid #f0ebe4;gap:8px;align-items:center}
.notify-row input{flex:1;border:1px solid #ddd;border-radius:8px;padding:7px 10px;font-size:13px;outline:none}
.notify-row input:focus{border-color:#7a8fb5}
.btn-send{background:#7a8fb5;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap}
.btn-send:hover{background:#5e7399}
/* ── Status badge ── */
.sbadge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700}
/* ── Closed sections ── */
.sec-closed{margin:0 24px 14px;border-radius:14px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.06);overflow:hidden}
@media(max-width:560px){.sec-closed{margin:0 12px 12px}}
.sec-summary{padding:14px 20px;font-size:14px;font-weight:700;color:#888;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;user-select:none}
.sec-summary::-webkit-details-marker{display:none}
details.sec-closed[open] .sec-summary::after{content:'▾';font-size:12px}
.sec-summary::after{content:'▸';font-size:12px;color:#bbb}
.closed-row{display:flex;justify-content:space-between;align-items:center;padding:10px 20px;border-top:1px solid #f5f2ee;font-size:13px;gap:8px}
.closed-row:hover{background:#fdf9f5}
.cr-left{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cr-id{font-size:11px;color:#ccc;font-family:monospace}
.cr-name{color:#555;font-weight:600}
.cr-time{font-size:11px;color:#ccc;white-space:nowrap}
.btn-return{padding:4px 12px;font-size:12px;background:#fbe9e7;color:#bf360c;border:1px solid #ffccbc;border-radius:6px;cursor:pointer;font-weight:600}
.btn-return:hover{background:#f5c6c0}
/* ── Stats bar ── */
.stats-bar{display:flex;gap:12px;padding:12px 24px;background:#fff;border-bottom:1px solid #ede8e2;flex-wrap:wrap}
@media(max-width:560px){.stats-bar{padding:10px 12px;gap:8px}}
.stat-card{flex:1;min-width:100px;background:#fdf9f5;border-radius:10px;padding:10px 14px;border:1px solid #ede8e2}
.stat-label{font-size:11px;color:#aaa;font-weight:600;margin-bottom:4px}
.stat-value{font-size:22px;font-weight:800;color:#7a5c3e;line-height:1}
.stat-unit{font-size:11px;color:#c9a98a;font-weight:600;margin-left:2px}
/* ── Admin note ── */
.admin-note-display{margin-top:6px;background:#fffde7;border-left:3px solid #f9a825;padding:6px 10px;border-radius:4px;font-size:12px;color:#5d4037;line-height:1.5}
.note-area{display:none;border-top:1px solid #f0ebe4;padding:10px 12px;background:#fffde7}
.note-area textarea{width:100%;border:1px solid #ddd;border-radius:8px;padding:8px 10px;font-size:13px;resize:vertical;outline:none;font-family:inherit;background:#fff}
.note-area textarea:focus{border-color:#c9a98a}
.note-area-btns{display:flex;gap:6px;margin-top:6px}
.btn-note-save{background:#c9a98a;color:#fff;border:none;border-radius:7px;padding:6px 14px;font-size:13px;font-weight:700;cursor:pointer}
.btn-note-cancel{background:#f0ebe4;color:#7a5c3e;border:none;border-radius:7px;padding:6px 12px;font-size:13px;cursor:pointer}
/* ── Warehouse ── */
.wh-row{padding:6px 12px;background:#fcfaf8;border-top:1px solid #f0ebe4;display:flex;align-items:center;gap:8px}
.wh-label{font-size:11px;color:#aaa;font-weight:600;white-space:nowrap}
.wh-select{border:1px solid #ddd;border-radius:8px;padding:5px 8px;font-size:12px;background:#fff;outline:none;cursor:pointer;flex:1}
.wh-select:focus{border-color:#c9a98a}
.wh-badge-ibaraki{display:inline-block;background:#e8f5e9;color:#2e7d32;border-radius:10px;font-size:11px;font-weight:700;padding:1px 7px;margin-left:4px}
.wh-badge-chiba{display:inline-block;background:#e3f2fd;color:#1565c0;border-radius:10px;font-size:11px;font-weight:700;padding:1px 7px;margin-left:4px}
/* ── Empty state ── */
.empty-state{grid-column:1/-1;text-align:center;padding:60px 20px;color:#ccc;font-size:14px}
/* ── Toast ── */
.toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#2d2218;color:#fff;padding:11px 22px;border-radius:24px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:999;white-space:nowrap}
.toast.show{opacity:1}
/* ── Date modal ── */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;display:none;align-items:center;justify-content:center}
.modal-box{background:#fff;border-radius:16px;padding:28px 24px;width:300px;box-shadow:0 12px 40px rgba(0,0,0,.2)}
.modal-title{font-size:16px;font-weight:700;color:#2d2218;margin-bottom:4px}
.modal-sub{font-size:13px;color:#999;margin-bottom:16px}
.modal-input{width:100%;border:1.5px solid #ddd;border-radius:10px;padding:12px;font-size:18px;outline:none;text-align:center;letter-spacing:4px;font-weight:700}
.modal-input:focus{border-color:#c9a98a}
.modal-btns{display:flex;gap:10px;margin-top:20px}
.modal-cancel{flex:1;background:#f0ebe4;color:#7a5c3e;border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:600;cursor:pointer}
.modal-ok{flex:1;background:#c9a98a;color:#fff;border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:700;cursor:pointer}
.modal-ok:hover{background:#b0885e}
</style>
</head>
<body>
<header>
  <div class="hdr-left">
    <div class="hdr-logo">🌸 Bijin 管理後台 <span style="font-size:11px;color:#c9a98a;font-weight:400">${BUILD_VERSION}</span></div>
    <div class="hdr-counts" id="hdr-counts"><span style="font-size:13px;color:#ccc">載入中…</span></div>
  </div>
  <button class="btn-refresh" onclick="loadOrders()">↻ 重新整理</button>
</header>
<div id="err-bar">
  <span id="err-msg"></span>
  <button onclick="loadOrders()">重試</button>
</div>
<div class="toolbar">
  <select id="filter-status" onchange="renderOrders()">
    <option value="">全部進行中</option>
    <option value="待確認">待確認</option>
    <option value="待買家完成下單">待買家完成下單</option>
    <option value="處理中(待處理或完成官網下單)">處理中</option>
    <option value="已發貨(官網出貨)">已發貨(官網出貨)</option>
    <option value="已發貨(已達台灣海關作業)">已發貨(台灣海關)</option>
    <option value="已發貨(賣貨便出貨)">已發貨(賣貨便)</option>
    <option value="待買家取貨">待買家取貨</option>
  </select>
  <select id="filter-wh" onchange="renderOrders()">
    <option value="">全部倉庫</option>
    <option value="茨城倉">茨城倉</option>
    <option value="千葉倉">千葉倉</option>
    <option value="__none__">未分配</option>
  </select>
  <input class="search-box" id="search-box" placeholder="搜尋姓名 / 手機 / 訂單ID…" oninput="renderOrders()">
  <a href="/admin/members?key=${adminKey}" class="btn-refresh" style="text-decoration:none;background:#7a5c3e">👥 會員管理</a>
</div>
<div class="stats-bar" id="stats-bar">
  <div class="stat-card"><div class="stat-label">今日新訂單</div><div class="stat-value" id="stat-today">—</div></div>
  <div class="stat-card"><div class="stat-label">待確認</div><div class="stat-value" id="stat-pending" style="color:#e65100">—</div></div>
  <div class="stat-card"><div class="stat-label">本月營收</div><div class="stat-value" id="stat-revenue" style="font-size:18px">—<span class="stat-unit">NT$</span></div></div>
  <div class="stat-card"><div class="stat-label">總會員數</div><div class="stat-value" id="stat-members">—</div></div>
</div>
<div id="orders"></div>
<details class="sec-closed">
  <summary class="sec-summary">✅ 已完成訂單 <span id="cnt-done" style="margin-left:4px;font-size:12px;font-weight:400;color:#c9a98a"></span></summary>
  <div id="done-orders"></div>
</details>
<details class="sec-closed">
  <summary class="sec-summary">🔄 退單訂單 <span id="cnt-return" style="margin-left:4px;font-size:12px;font-weight:400;color:#bf360c"></span></summary>
  <div id="return-orders"></div>
</details>
<details class="sec-closed">
  <summary class="sec-summary">❌ 已取消訂單 <span id="cnt-cancel" style="margin-left:4px;font-size:12px;font-weight:400;color:#aaa"></span></summary>
  <div id="cancel-orders"></div>
</details>
<div class="toast" id="toast"></div>

<script>
var STATUSES =['待確認','待買家完成下單','處理中(待處理或完成官網下單)','已發貨(官網出貨)','已發貨(已達台灣海關作業)','已發貨(賣貨便出貨)','待買家取貨','已完成','已取消','退單'];
var NOTIFY_STATUSES = {'處理中(待處理或完成官網下單)':1,'已發貨(官網出貨)':1,'已發貨(已達台灣海關作業)':1,'已發貨(賣貨便出貨)':1,'待買家取貨':1};
var CLOSED = {'已完成':1,'已取消':1,'退單':1};
var STATUS_STYLE = {
  '待確認':'background:#fff3e0;color:#e65100',
  '待買家完成下單':'background:#e3f2fd;color:#1565c0',
  '處理中(待處理或完成官網下單)':'background:#ede7f6;color:#4527a0',
  '已發貨(官網出貨)':'background:#e8f5e9;color:#2e7d32',
  '已發貨(已達台灣海關作業)':'background:#e0f2f1;color:#004d40',
  '已發貨(賣貨便出貨)':'background:#f1f8e9;color:#33691e',
  '待買家取貨':'background:#fce4ec;color:#880e4f',
  '已完成':'background:#f3e5f5;color:#6a1b9a',
  '已取消':'background:#fafafa;color:#aaa;border:1px solid #eee',
  '退單':'background:#fbe9e7;color:#bf360c',
};
function sbadge(s) {
  var st = STATUS_STYLE[s] || 'background:#eee;color:#666';
  return '<span class="sbadge" style="' + st + '">' + (s||'待確認') + '</span>';
}
var allOrders = ${ssrOrdersJson};
var SSR_ERROR = '${ssrError.replace(/'/g, "\\'")}';
var KEY = '${adminKey}';
var MEMBER_COUNT = ${ssrMemberCount};

function showErr(msg) {
  var bar = document.getElementById('err-bar');
  document.getElementById('err-msg').textContent = msg;
  bar.style.display = 'block';
}
function hideErr() {
  document.getElementById('err-bar').style.display = 'none';
}

function onLoadError(msg) {
  console.error('[Admin] loadOrders error:', msg);
  document.getElementById('hdr-counts').innerHTML = '<span style="font-size:13px;color:#c0392b">載入失敗</span>';
  showErr('載入失敗：' + msg + '　請按右上角重新整理');
}
function loadOrders() {
  hideErr();
  document.getElementById('hdr-counts').innerHTML = '<span style="font-size:13px;color:#ccc">載入中…</span>';
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/admin/orders?key=' + KEY + '&_=' + Date.now(), true);
  xhr.timeout = 8000;
  xhr.onload = function() {
    if (xhr.status === 200) {
      try {
        var d = JSON.parse(xhr.responseText);
        allOrders = d.orders || [];
        renderOrders();
      } catch(e) {
        onLoadError('JSON解析失敗：' + e.message);
      }
    } else {
      onLoadError('HTTP ' + xhr.status);
    }
  };
  xhr.onerror = function() { onLoadError('網路連線錯誤'); };
  xhr.ontimeout = function() { onLoadError('逾時 8 秒，請重新整理'); };
  xhr.send();
}

function renderOrders() {
  var keyword = (document.getElementById('search-box').value || '').trim().toLowerCase();
  var filter = document.getElementById('filter-status').value;
  var active = allOrders.filter(function(o){ return !CLOSED[o.status]; });
  var done = allOrders.filter(function(o){ return o.status === '已完成'; });
  var returns = allOrders.filter(function(o){ return o.status === '退單'; });
  var cancelled = allOrders.filter(function(o){ return o.status === '已取消'; });

  var filterWh = document.getElementById('filter-wh').value;
  var list = active;
  if (filter) list = list.filter(function(o){ return o.status === filter; });
  if (filterWh === '__none__') list = list.filter(function(o){ return !(o.warehouse||''); });
  else if (filterWh) list = list.filter(function(o){ return o.warehouse === filterWh; });
  if (keyword) list = list.filter(function(o){ return (o.buyerName||'').toLowerCase().indexOf(keyword) >= 0 || (o.lineDisplayName||'').toLowerCase().indexOf(keyword) >= 0 || (o.orderId||'').toLowerCase().indexOf(keyword) >= 0 || (o.phone||'').indexOf(keyword) >= 0; });

  // header counts
  var pills = '<span class="hdr-pill pill-active">' + active.length + ' 進行中</span>';
  if (done.length) pills += '<span class="hdr-pill pill-done">' + done.length + ' 已完成</span>';
  if (returns.length) pills += '<span class="hdr-pill pill-return">' + returns.length + ' 退單</span>';
  if (cancelled.length) pills += '<span class="hdr-pill pill-cancel">' + cancelled.length + ' 已取消</span>';
  document.getElementById('hdr-counts').innerHTML = pills;

  // section counts
  document.getElementById('cnt-done').textContent = done.length ? done.length + ' 筆' : '';
  document.getElementById('cnt-return').textContent = returns.length ? returns.length + ' 筆' : '';
  document.getElementById('cnt-cancel').textContent = cancelled.length ? cancelled.length + ' 筆' : '';

  // active orders grid
  var container = document.getElementById('orders');
  if (list.length === 0) {
    container.innerHTML = '<div class="empty-state">沒有符合條件的訂單</div>';
  } else {
    var html = '';
    for (var i = 0; i < list.length; i++) html += createCard(list[i]);
    container.innerHTML = html;
  }

  // closed sections
  var emptyMsg = '<div style="color:#ccc;padding:14px 20px;font-size:13px">';
  document.getElementById('done-orders').innerHTML = done.length ? done.map(function(o){ return closedRow(o, true); }).join('') : emptyMsg + '無已完成訂單</div>';
  document.getElementById('return-orders').innerHTML = returns.length ? returns.map(function(o){ return closedRow(o, false); }).join('') : emptyMsg + '無退單訂單</div>';
  document.getElementById('cancel-orders').innerHTML = cancelled.length ? cancelled.map(function(o){ return closedRow(o, false); }).join('') : emptyMsg + '無已取消訂單</div>';

  renderStats();
}

function renderStats() {
  var now = new Date();
  var todayStr = now.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }); // e.g. "2026/4/24"
  var thisMonthStr = todayStr.slice(0, todayStr.lastIndexOf('/')); // e.g. "2026/4"
  var todayNew = allOrders.filter(function(o){ return (o.orderTime||'').startsWith(todayStr); }).length;
  var pending = allOrders.filter(function(o){ return o.status === '待確認'; }).length;
  var revenue = allOrders
    .filter(function(o){ return o.status === '已完成' && (o.orderTime||'').startsWith(thisMonthStr); })
    .reduce(function(s, o){ return s + (o.finalAmount || 0); }, 0);
  document.getElementById('stat-today').textContent = todayNew;
  var pEl = document.getElementById('stat-pending');
  pEl.textContent = pending;
  pEl.style.color = pending > 0 ? '#e65100' : '#7a5c3e';
  document.getElementById('stat-revenue').innerHTML = revenue.toLocaleString() + '<span class="stat-unit"> NT$</span>';
  document.getElementById('stat-members').textContent = MEMBER_COUNT;
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function whBorderStyle(wh) {
  if (wh === '茨城倉') return 'border-top:3px solid #66bb6a';
  if (wh === '千葉倉') return 'border-top:3px solid #42a5f5';
  return '';
}
function whBadgeHtml(wh) {
  if (wh === '茨城倉') return '<span class="wh-badge-ibaraki">★茨城倉</span>';
  if (wh === '千葉倉') return '<span class="wh-badge-chiba">★千葉倉</span>';
  return '';
}
function createCard(o) {
  var ri = o.rowIndex;
  var wh = o.warehouse || '';
  var opts = STATUSES.map(function(s){
    return '<option value="' + esc(s) + '"' + (o.status === s ? ' selected' : '') + '>' + esc(s) + '</option>';
  }).join('');
  var whOpts = ['', '茨城倉', '千葉倉'].map(function(w){
    return '<option value="' + w + '"' + (wh === w ? ' selected' : '') + '>' + (w || '未分配') + '</option>';
  }).join('');

  var itemsHtml = (o.items||'').split('\\n').map(function(l){
    if (l.indexOf('【預購】')===0) return '<div><span style="background:#fff3e0;color:#e65100;font-size:10px;font-weight:700;border-radius:3px;padding:1px 5px;margin-right:4px;border:1px solid #ffcc80">預購</span>' + esc(l.replace('【預購】','')) + '</div>';
    return '<div>' + esc(l) + '</div>';
  }).join('');

  var priceHtml = '<div class="price-row"><span class="price-final">NT$' + (o.discountTotal > 0 ? o.finalAmount : o.total) + '</span>';
  if (o.discountTotal > 0) {
    priceHtml += '<span class="price-orig">NT$' + o.total + '</span>';
    var discParts = [];
    if (o.pointsUsed > 0) discParts.push('點數 -' + o.pointsUsed);
    if (o.couponCode) discParts.push('券 -' + (o.discountTotal - o.pointsUsed));
    if (discParts.length) priceHtml += '<span class="price-disc">' + discParts.join(' / ') + '</span>';
  }
  priceHtml += '</div>';

  var contactHtml = '';
  if (o.contact) contactHtml += '<div class="info-row"><span class="info-label">聯繫</span>' + esc(o.contact) + (o.contactId ? '　' + esc(o.contactId) : '') + '</div>';
  if (o.phone) contactHtml += '<div class="info-row"><span class="info-label">手機</span>' + esc(o.phone) + '</div>';
  if (o.note) contactHtml += '<div class="info-row"><span class="info-label">客備</span>' + esc(o.note) + '</div>';
  if (o.adminNote) contactHtml += '<div class="admin-note-display">📝 ' + esc(o.adminNote) + '</div>';

  var notifyRowHtml = '';
  if ((o.status||'待確認') === '待確認') {
    notifyRowHtml = '<div class="notify-row" id="nrow-' + ri + '" style="display:flex">'
      + '<input type="url" id="nurl-' + ri + '" placeholder="貼上賣貨便網址…">'
      + '<button class="btn-send" onclick="sendNotify(\\'' + esc(o.orderId) + '\\',' + ri + ')">傳送網址</button>'
      + '</div>';
  }

  return '<div class="order-card" id="card-' + ri + '" style="' + whBorderStyle(wh) + '">'
    + '<div class="card-top">'
    + '<div class="card-id">' + esc(o.orderId) + whBadgeHtml(wh) + '</div>'
    + '<div class="card-time">' + esc(o.orderTime) + '</div>'
    + '</div>'
    + '<div class="card-status">' + sbadge(o.status||'待確認') + '</div>'
    + '<div class="card-body">'
    + '<div class="buyer-name">' + esc(o.buyerName||'（未填姓名）') + '</div>'
    + (o.lineDisplayName ? '<div class="line-name">LINE：' + esc(o.lineDisplayName) + '</div>' : '')
    + '<div class="order-items">' + itemsHtml + '</div>'
    + priceHtml
    + contactHtml
    + '</div>'
    + '<hr class="card-divider">'
    + '<div class="wh-row"><span class="wh-label">🏭 倉庫</span><select class="wh-select" id="wsel-' + ri + '" onchange="saveWarehouse(' + ri + ')">' + whOpts + '</select></div>'
    + '<div class="card-footer">'
    + '<select class="status-select" id="sel-' + ri + '">' + opts + '</select>'
    + '<button class="btn-save" onclick="saveStatus(' + ri + ',\\'' + esc(o.orderId) + '\\')">儲存</button>'
    + '<button class="btn-save" style="background:#f5c97a;color:#5d4037;padding:7px 10px" title="內部備註" onclick="toggleNote(' + ri + ')">📝</button>'
    + '</div>'
    + notifyRowHtml
    + '<div class="note-area" id="note-area-' + ri + '">'
    + '<textarea id="note-input-' + ri + '" rows="2" placeholder="輸入內部備註（不會通知買家）">' + esc(o.adminNote||'') + '</textarea>'
    + '<div class="note-area-btns">'
    + '<button class="btn-note-save" onclick="saveNote(' + ri + ')">儲存備註</button>'
    + '<button class="btn-note-cancel" onclick="toggleNote(' + ri + ')">取消</button>'
    + '</div>'
    + '</div>'
    + '</div>';
}

function closedRow(o, showReturn) {
  var returnBtn = showReturn
    ? '<button class="btn-return" onclick="doReturn(' + o.rowIndex + ',\\'' + esc(o.orderId) + '\\')">退單</button>'
    : '';
  return '<div class="closed-row">'
    + '<div class="cr-left">'
    + '<span class="cr-id">' + esc(o.orderId) + '</span>'
    + sbadge(o.status)
    + '<span class="cr-name">' + esc(o.buyerName||'—') + '</span>'
    + returnBtn
    + '</div>'
    + '<div class="cr-time">' + esc(o.orderTime) + '</div>'
    + '</div>';
}

async function saveStatus(rowIndex, orderId) {
  var status = document.getElementById('sel-' + rowIndex).value;
  if (NOTIFY_STATUSES[status]) {
    showDateModal(rowIndex, orderId, status);
    return;
  }
  try {
    var r = await fetch('/api/admin/order-status', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, rowIndex: rowIndex, status: status }),
    });
    if (r.ok) {
      var o = allOrders.find(function(x){ return x.rowIndex === rowIndex; });
      if (o) o.status = status;
      toast('✅ 狀態已更新');
      renderOrders();
    } else {
      var d = await r.json();
      toast('❌ ' + (d.error || '更新失敗'));
    }
  } catch(e) { toast('❌ 網路錯誤'); }
}

async function saveWarehouse(rowIndex) {
  var wh = document.getElementById('wsel-' + rowIndex).value;
  try {
    var r = await fetch('/api/admin/order-warehouse', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, rowIndex: rowIndex, warehouse: wh }),
    });
    if (r.ok) {
      var o = allOrders.find(function(x){ return x.rowIndex === rowIndex; });
      if (o) o.warehouse = wh;
      var card = document.getElementById('card-' + rowIndex);
      if (card) {
        card.style.borderTop = wh === '茨城倉' ? '3px solid #66bb6a' : wh === '千葉倉' ? '3px solid #42a5f5' : '';
        var badge = card.querySelector('.card-id');
        if (badge) {
          badge.innerHTML = badge.innerHTML.replace(/<span class="wh-badge[^"]*"[^>]*>.*?<\\/span>/g, '') + whBadgeHtml(wh);
        }
      }
      toast('✅ 倉庫：' + (wh || '未分配'));
    } else { toast('❌ 儲存失敗'); }
  } catch(e) { toast('❌ 網路錯誤'); }
}

async function sendNotify(orderId, rowIndex) {
  var url = document.getElementById('nurl-' + rowIndex).value.trim();
  if (!url) { toast('請貼上賣貨便網址'); return; }
  try {
    var r = await fetch('/admin/notify-buyer?key=' + KEY + '&orderId=' + encodeURIComponent(orderId) + '&url=' + encodeURIComponent(url));
    var d = await r.json();
    if (r.ok) {
      var o = allOrders.find(function(x){ return x.rowIndex === rowIndex; });
      if (o) o.status = '待買家完成下單';
      toast('✅ ' + (d.message || '已傳送'));
      renderOrders();
    } else toast('❌ ' + (d.error || '失敗'));
  } catch(e) { toast('❌ 網路錯誤'); }
}

async function doReturn(rowIndex, orderId) {
  if (!confirm('確定要將此訂單標記為退單？\\n將自動扣除買家點數、回扣年度消費並重算等級。')) return;
  try {
    var r = await fetch('/api/admin/order-status', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, rowIndex: rowIndex, status: '退單' }),
    });
    if (r.ok) {
      var o = allOrders.find(function(x){ return x.rowIndex === rowIndex; });
      if (o) o.status = '退單';
      toast('✅ 已標記退單，點數已扣除');
      renderOrders();
    } else {
      var d = await r.json();
      toast('❌ ' + (d.error || '失敗'));
    }
  } catch(e) { toast('❌ 網路錯誤'); }
}

var _dateCtx = null;
function showDateModal(rowIndex, orderId, status) {
  _dateCtx = { rowIndex: rowIndex, orderId: orderId, status: status };
  document.getElementById('dm-status').textContent = status;
  var now = new Date();
  var mm = String(now.getMonth()+1).padStart(2,'0');
  var dd = String(now.getDate()).padStart(2,'0');
  document.getElementById('dm-input').value = mm + '/' + dd;
  document.getElementById('date-modal').style.display = 'flex';
  setTimeout(function(){ document.getElementById('dm-input').select(); }, 50);
}
function closeDateModal() {
  document.getElementById('date-modal').style.display = 'none';
  _dateCtx = null;
}
async function confirmDateModal() {
  var date = document.getElementById('dm-input').value.trim();
  if (!date) { toast('請輸入日期'); return; }
  var ctx = _dateCtx;
  document.getElementById('date-modal').style.display = 'none';
  try {
    var r = await fetch('/api/admin/notify-progress', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, orderId: ctx.orderId, rowIndex: ctx.rowIndex, status: ctx.status, date: date }),
    });
    var d = await r.json();
    if (r.ok) {
      var o = allOrders.find(function(x){ return x.rowIndex === ctx.rowIndex; });
      if (o) o.status = ctx.status;
      toast('✅ 狀態已更新並通知買家');
      renderOrders();
    } else toast('❌ ' + (d.error || '失敗'));
  } catch(e) { toast('❌ 網路錯誤'); }
}

function toggleNote(rowIndex) {
  var area = document.getElementById('note-area-' + rowIndex);
  if (!area) return;
  var isOpen = area.style.display === 'block';
  area.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    var inp = document.getElementById('note-input-' + rowIndex);
    if (inp) inp.focus();
  }
}

async function saveNote(rowIndex) {
  var inp = document.getElementById('note-input-' + rowIndex);
  if (!inp) return;
  var noteText = inp.value;
  try {
    var r = await fetch('/api/admin/order-note', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, rowIndex: rowIndex, adminNote: noteText }),
    });
    var d = await r.json();
    if (!r.ok) { toast('❌ ' + (d.error || '儲存失敗')); return; }
    var o = allOrders.find(function(x){ return x.rowIndex === rowIndex; });
    if (o) o.adminNote = noteText;
    document.getElementById('note-area-' + rowIndex).style.display = 'none';
    renderOrders();
    toast('✅ 備註已儲存');
  } catch(e) { toast('❌ 網路錯誤'); }
}

function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, 2800);
}

// 初始渲染：資料已由伺服器端嵌入，直接呈現
if (SSR_ERROR) {
  showErr('伺服器載入失敗：' + SSR_ERROR + '　請按右上角重新整理');
  document.getElementById('hdr-counts').innerHTML = '<span style="font-size:13px;color:#c0392b">載入失敗</span>';
} else {
  renderOrders();
}
</script>

<div id="date-modal" class="modal-overlay" onclick="if(event.target===this)closeDateModal()">
  <div class="modal-box">
    <div class="modal-title">輸入進度日期</div>
    <div class="modal-sub">狀態：<strong id="dm-status" style="color:#7a5c3e"></strong></div>
    <input id="dm-input" class="modal-input" type="text" placeholder="MM/DD" maxlength="5"
      onkeydown="if(event.key==='Enter')confirmDateModal()">
    <div class="modal-btns">
      <button class="modal-cancel" onclick="closeDateModal()">取消</button>
      <button class="modal-ok" onclick="confirmDateModal()">確定並通知買家</button>
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
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:P` });
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
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:P` });
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

// ══════════════════════════════════════════════════════════════════════════════
// 會員制度
// ══════════════════════════════════════════════════════════════════════════════

const MEMBER_SHEET   = '會員';
const POINTS_SHEET   = '點數紀錄';
const COUPON_SHEET   = '優惠券';
const REFERRAL_SHEET = '邀請紀錄';

const TIER_THRESHOLDS = [
  { name: '白金', min: 12000 },
  { name: '金卡', min: 6000 },
  { name: '銀卡', min: 3000 },
  { name: '一般', min: 0 },
];
// 每 NT$X 得 1 點
const POINTS_DIVISOR = { '一般': 300, '銀卡': 200, '金卡': 100, '白金': 50 }; // 白金=100元2點→50元1點
const BIRTHDAY_GIFTS = {
  '一般': [{ amount: 30, qty: 1 }],
  '銀卡': [{ amount: 50, qty: 1 }],
  '金卡': [{ amount: 50, qty: 2 }],
  '白金': [{ amount: 50, qty: 4 }],
};

function calcTier(yearlySpend) {
  for (const t of TIER_THRESHOLDS) if (yearlySpend >= t.min) return t.name;
  return '一般';
}
function calcPoints(tier, amount) {
  const div = POINTS_DIVISOR[tier] || 300;
  return Math.floor(amount / div);
}
function calcPointsExpiry(earnDate) {
  const m = new Date(earnDate).getMonth() + 1; // 1-12
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
async function ensureReferralSheet(sheets) {
  const headers = ['inviterUserId','inviteeUserId','inviteCode','bindDate','orderDeadline','qualifyingOrderId','status'];
  try { await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!A1` }); }
  catch {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, resource: { requests: [{ addSheet: { properties: { title: REFERRAL_SHEET } } }] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!A1`, valueInputOption: 'RAW', resource: { values: [headers] } });
  }
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
  // 若跨年，重置年度消費
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
  // fields: { col (A=1), value }[]
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
  return rows.map(r => r[0]); // coupon codes
}

// ── 訂單完成：計算點數 + 更新年度消費 + 等級 ───────────────────────────────────
async function processOrderCompletion(sheets, userId, displayName, orderId, orderAmountTwd) {
  const member = await getMember(sheets, userId);
  if (!member) return; // 未註冊會員，不計點數
  const pts = calcPoints(member.tier, orderAmountTwd);
  const today = todayStr();
  const expiry = calcPointsExpiry(today);
  const newSpend = member.yearlySpend + orderAmountTwd;
  const newTier = calcTier(newSpend);
  const newPoints = member.points + pts;

  // 更新 yearlySpend / tier / points / lastUpdated (cols H=8, I=9, J=10, K=11, L=12)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${MEMBER_SHEET}!I${member.rowIndex}:L${member.rowIndex}`,
    valueInputOption: 'RAW',
    resource: { values: [[newSpend, newTier, newPoints, today]] },
  });

  // 寫入點數紀錄
  if (pts > 0) {
    await ensurePointsSheet(sheets);
    const pointId = 'P' + Date.now().toString(36).toUpperCase();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${POINTS_SHEET}!A1`,
      valueInputOption: 'RAW',
      resource: { values: [[pointId, today, userId, displayName || '', orderId, pts, expiry, 'active']] },
    });
  }

  // 通知買家（升等 or 點數）
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
    const client = new line.Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
    await client.pushMessage(userId, { type: 'text', text: notifyText });
  } catch(e) { console.error('[member notify error]', e.message); }

  // 處理邀請獎勵
  await processReferralReward(sheets, userId, orderId).catch(e => console.error('[referral error]', e.message));

  return { pts, newTier, newPoints, tierChanged };
}

// ── 退單：撤銷點數 + 回扣年度消費 + 重新計算等級 ─────────────────────────────
async function processOrderReturn(sheets, orderId) {
  // 取訂單資料（找實付金額）
  const oResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:P` });
  const oRows = oResp.data.values || [];
  const oRow = oRows.find((r, i) => i > 0 && r[0] === orderId);
  const returnUserId = oRow ? (oRow[2] || '') : '';
  const returnAmount = oRow ? (parseFloat(oRow[14]) || parseFloat(oRow[4]) || 0) : 0; // 實付金額(O) 或 總金額(E)

  // 找點數紀錄中此訂單的點數
  const pResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${POINTS_SHEET}!A:H` });
  const pRows = pResp.data.values || [];
  const pIdx = pRows.findIndex((r, i) => i > 0 && r[4] === orderId && r[7] === 'active');
  const pts = pIdx > 0 ? (parseInt(pRows[pIdx][5]) || 0) : 0;
  const pointUserId = pIdx > 0 ? (pRows[pIdx][2] || '') : '';
  const userId = returnUserId || pointUserId;

  // 標記點數已撤銷
  if (pIdx > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${POINTS_SHEET}!H${pIdx + 1}`,
      valueInputOption: 'RAW', resource: { values: [['cancelled']] },
    });
  }

  // 更新會員：扣點 + 回扣年度消費 + 重算等級
  if (userId) {
    const member = await getMember(sheets, userId);
    if (member) {
      const newPoints = Math.max(0, (member.points || 0) - pts);
      const newSpend  = Math.max(0, (member.yearlySpend || 0) - returnAmount);
      const newTier   = calcTier(newSpend);
      const tierChanged = newTier !== member.tier;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${MEMBER_SHEET}!I${member.rowIndex}:L${member.rowIndex}`,
        valueInputOption: 'RAW',
        resource: { values: [[newSpend, newTier, newPoints, todayStr()]] },
      });
      // 通知買家
      try {
        const client = new line.Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
        let msg = `📦 訂單 ${orderId} 已辦理退單。\n`;
        if (pts > 0) msg += `\n💎 已扣除本次獲得的 ${pts} 點`;
        msg += `\n📊 目前剩餘點數：${newPoints} 點`;
        msg += `\n🏅 會員等級：${newTier}`;
        if (tierChanged) msg += `\n（等級調整為 ${newTier}）`;
        msg += `\n\n如有疑問請聯繫客服 🌸`;
        await client.pushMessage(userId, { type: 'text', text: msg });
      } catch(e) { console.error('[return notify error]', e.message); }
    }
  }
  return { ptsDeducted: pts, amountDeducted: returnAmount };
}

// ── 邀請獎勵處理（訂單完成時呼叫）────────────────────────────────────────────
async function processReferralReward(sheets, inviteeUserId, orderId) {
  await ensureReferralSheet(sheets);
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!A:G` });
  const rows = resp.data.values || [];
  const today = todayStr();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const [inviterUserId, inviteeId, inviteCode, bindDate, orderDeadline, qualifyingOrderId, status] = r;
    if (inviteeId !== inviteeUserId) continue;
    if (status !== 'pending') continue;
    // 確認訂單在截止日前
    if (today > orderDeadline) {
      // 過期
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!G${i + 1}`,
        valueInputOption: 'RAW', resource: { values: [['expired']] },
      });
      continue;
    }
    // 發獎勵：雙方各 NT$50 × 2 張，效期 3 個月
    const expiry = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    const inviteeMember = await getMember(sheets, inviteeUserId);
    const inviterMember = await getMember(sheets, inviterUserId);
    await issueCoupons(sheets, inviteeUserId, inviteeMember ? inviteeMember.displayName : '', '邀請獎勵', 50, 2, expiry);
    await issueCoupons(sheets, inviterUserId, inviterMember ? inviterMember.displayName : '', '邀請獎勵', 50, 2, expiry);

    // 更新邀請紀錄
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!F${i + 1}:G${i + 1}`,
      valueInputOption: 'RAW', resource: { values: [[orderId, 'rewarded']] },
    });

    // 通知雙方
    const client = new line.Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
    const msg = `🎁 邀請獎勵！\n好友訂單已完成，雙方各獲得 NT$50 折扣碼 × 2 張！\n請至會員中心查看。`;
    await client.pushMessage(inviteeUserId, { type: 'text', text: msg }).catch(() => {});
    await client.pushMessage(inviterUserId, { type: 'text', text: msg }).catch(() => {});
  }
}

// ── 綁定邀請碼 ────────────────────────────────────────────────────────────────
async function bindReferralCode(sheets, inviteeUserId, inviteCode) {
  // 找邀請者
  const memberResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A:F` });
  const mRows = memberResp.data.values || [];
  const inviterRow = mRows.find((r, i) => i > 0 && r[4] === inviteCode);
  if (!inviterRow) return { ok: false, error: '無效的邀請碼' };
  if (inviterRow[0] === inviteeUserId) return { ok: false, error: '不能使用自己的邀請碼' };

  // 確認被邀請者入會不超過1個月
  const inviteeMember = await getMember(sheets, inviteeUserId);
  if (!inviteeMember) return { ok: false, error: '找不到會員資料' };
  const joinDate = new Date(inviteeMember.joinDate);
  const monthAgo = new Date(Date.now() - 30 * 86400000);
  if (joinDate < monthAgo) return { ok: false, error: '入會超過 1 個月，無法補填邀請碼' };
  if (inviteeMember.referredByCode) return { ok: false, error: '已綁定邀請碼' };

  const today = todayStr();
  const orderDeadline = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  // 更新會員的 referredByCode / referralCodeSetDate
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${MEMBER_SHEET}!F${inviteeMember.rowIndex}:G${inviteeMember.rowIndex}`,
    valueInputOption: 'RAW',
    resource: { values: [[inviteCode, today]] },
  });

  // 新增邀請紀錄
  await ensureReferralSheet(sheets);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!A1`,
    valueInputOption: 'RAW',
    resource: { values: [[inviterRow[0], inviteeUserId, inviteCode, today, orderDeadline, '', 'pending']] },
  });

  return { ok: true, inviterName: inviterRow[1] };
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

// ── API：取得會員資料（LIFF 用，不自動建立）─────────────────────────────────
app.get('/api/member', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const sheets = getSheetsClient();
    const member = await getMember(sheets, userId);
    if (!member) return res.json({ ok: true, registered: false });
    const coupons = await getActiveCoupons(sheets, userId);
    const pointsRows = await getActivePoints(sheets, userId);
    // 餘額以會員表 K 欄為準（deductMemberPoints 直接更新此欄），點數紀錄只用於明細展示
    res.json({ ok: true, registered: true, member, coupons, pointsRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API：取得會員進行中訂單 ──────────────────────────────────────────────────
app.get('/api/member/orders', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:P` });
    const rows = resp.data.values || [];
    const DONE = ['已完成', '已取消'];
    const orders = rows.slice(1)
      .filter(r => r[2] === userId && !DONE.includes(r[10] || ''))
      .map(r => ({
        orderId: r[0] || '',
        orderTime: r[1] || '',
        items: r[3] || '',
        totalTwd: parseFloat(r[4]) || 0,
        finalAmount: parseFloat(r[14]) || parseFloat(r[4]) || 0,
        pointsUsed: parseInt(r[11]) || 0,
        couponCode: r[12] || '',
        discountAmount: parseFloat(r[13]) || 0,
        status: r[10] || '待確認',
      }))
      .reverse();
    res.json({ ok: true, orders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API：會員註冊 ────────────────────────────────────────────────────────────
app.post('/api/member/register', express.json(), async (req, res) => {
  const { userId, displayName, name, phone, birthday, inviteCode } = req.body;
  if (!userId || !name || !phone || !birthday) return res.status(400).json({ error: '請填寫所有必填欄位' });
  if (!/^09\d{8}$/.test(phone)) return res.status(400).json({ error: '手機號碼格式不正確' });
  if (!/^\d{2}-\d{2}$/.test(birthday)) return res.status(400).json({ error: '生日格式應為 MM-DD' });
  try {
    const sheets = getSheetsClient();
    // 已是會員
    const existing = await getMember(sheets, userId);
    if (existing) return res.status(400).json({ error: '您已是會員' });
    // 手機防重複（掃描 N 欄）
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!N:N` }).catch(() => ({ data: { values: [] } }));
    const phones = (resp.data.values || []).flat();
    if (phones.includes(phone)) return res.status(400).json({ error: '此手機號碼已被註冊' });
    // 驗證邀請碼（若有填）
    let referredByCode = '';
    if (inviteCode) {
      const allMembers = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A:E` });
      const rows = allMembers.data.values || [];
      const inviter = rows.find((r, i) => i > 0 && r[4] === inviteCode.toUpperCase());
      if (!inviter) return res.status(400).json({ error: '邀請碼無效' });
      if (inviter[0] === userId) return res.status(400).json({ error: '不能使用自己的邀請碼' });
      referredByCode = inviteCode.toUpperCase();
    }
    const member = await createMember(sheets, userId, displayName || '', { name, phone, birthday, referredByCode });
    // 邀請紀錄
    if (referredByCode) {
      await ensureReferralSheet(sheets);
      const inviterResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A:E` });
      const inviterRow = (inviterResp.data.values || []).find((r, i) => i > 0 && r[4] === referredByCode);
      const inviterUserId = inviterRow ? inviterRow[0] : '';
      if (inviterUserId) {
        const deadline = new Date(); deadline.setMonth(deadline.getMonth() + 1);
        const deadlineStr = deadline.toISOString().split('T')[0];
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!A1`, valueInputOption: 'RAW',
          resource: { values: [[inviterUserId, userId, referredByCode, todayStr(), deadlineStr, '', 'pending']] },
        });
      }
    }
    res.json({ ok: true, member });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API：更新生日 ─────────────────────────────────────────────────────────────
app.post('/api/member/birthday', express.json(), async (req, res) => {
  const { userId, birthday } = req.body; // birthday: "MM-DD"
  if (!userId || !birthday) return res.status(400).json({ error: 'Missing fields' });
  if (!/^\d{2}-\d{2}$/.test(birthday)) return res.status(400).json({ error: '格式應為 MM-DD' });
  try {
    const sheets = getSheetsClient();
    const member = await getMember(sheets, userId);
    if (!member) return res.status(404).json({ error: '找不到會員' });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!D${member.rowIndex}`,
      valueInputOption: 'RAW', resource: { values: [[birthday]] },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API：綁定邀請碼 ───────────────────────────────────────────────────────────
app.post('/api/member/referral', express.json(), async (req, res) => {
  const { userId, inviteCode } = req.body;
  if (!userId || !inviteCode) return res.status(400).json({ error: 'Missing fields' });
  try {
    const sheets = getSheetsClient();
    const result = await bindReferralCode(sheets, userId, inviteCode.toUpperCase().trim());
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, message: `已成功綁定邀請碼！` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 會員中心 LIFF 頁面 ────────────────────────────────────────────────────────
app.get('/member', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>會員中心 | Bijin</title>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#fdf8f3;min-height:100vh;padding-bottom:40px}
header{background:#c9a98a;color:#fff;padding:20px 16px 16px;text-align:center}
.header-name{font-size:18px;font-weight:bold;margin-bottom:2px}
.header-sub{font-size:12px;opacity:.85}
.tier-badge{display:inline-block;padding:3px 14px;border-radius:20px;font-size:13px;font-weight:bold;margin-top:8px}
.tier-一般{background:#f5ede0;color:#a08060}
.tier-銀卡{background:#e8e8e8;color:#666}
.tier-金卡{background:#fff3cd;color:#a07800}
.tier-白金{background:#e8f0fe;color:#3949ab}
.card{background:#fff;margin:12px;border-radius:14px;padding:16px;box-shadow:0 1px 6px rgba(0,0,0,.07)}
.card-title{font-size:13px;font-weight:bold;color:#c9a98a;margin-bottom:12px;border-bottom:1px solid #f5ede0;padding-bottom:8px}
.stat-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:14px;color:#444;border-bottom:1px solid #faf5ef}
.stat-row:last-child{border-bottom:none}
.stat-val{font-weight:bold;color:#333}
.progress-wrap{margin-top:10px}
.progress-label{font-size:12px;color:#aaa;margin-bottom:4px;display:flex;justify-content:space-between}
.progress-bar{height:6px;background:#f0e8de;border-radius:4px;overflow:hidden}
.progress-fill{height:100%;background:#c9a98a;border-radius:4px;transition:width .4s}
.coupon-item{background:#fff8f0;border:1px dashed #e8c9a0;border-radius:10px;padding:10px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
.coupon-amount{font-size:20px;font-weight:bold;color:#c9a98a}
.coupon-info{font-size:11px;color:#aaa;margin-top:2px}
.coupon-code{font-family:monospace;font-size:11px;color:#bbb}
.ref-code-box{background:#f5ede0;border-radius:10px;padding:14px;text-align:center}
.ref-code{font-size:26px;font-weight:bold;letter-spacing:4px;color:#7a5c3e;margin:6px 0}
.ref-copy-btn{background:#c9a98a;color:#fff;border:none;border-radius:8px;padding:8px 20px;font-size:13px;font-weight:bold;cursor:pointer;margin-top:6px}
.input-row{display:flex;gap:8px;margin-top:10px}
.input-row input{flex:1;border:1px solid #ddd;border-radius:8px;padding:9px 10px;font-size:14px;outline:none;text-transform:uppercase}
.input-row input:focus{border-color:#c9a98a}
.input-row button{background:#c9a98a;color:#fff;border:none;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:bold;cursor:pointer;white-space:nowrap}
.bday-row{display:flex;gap:8px;margin-top:10px;align-items:center}
.bday-row input{flex:1;border:1px solid #ddd;border-radius:8px;padding:9px 10px;font-size:14px;outline:none}
.bday-row input:focus{border-color:#c9a98a}
.bday-row button{background:#c9a98a;color:#fff;border:none;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:bold;cursor:pointer}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:100;white-space:nowrap}
.toast.show{opacity:1}
.empty{text-align:center;color:#ccc;font-size:13px;padding:16px 0}
</style>
</head>
<body>

<!-- ── 未註冊：會員福利 + 加入表單 ── -->
<div id="register-view" style="display:none;padding-bottom:40px">
  <header style="background:#c9a98a;color:#fff;padding:20px 16px;text-align:center">
    <div style="font-size:18px;font-weight:bold">👑 Bijin 會員計畫</div>
    <div style="font-size:12px;opacity:.85;margin-top:4px">加入會員，享受專屬優惠</div>
  </header>

  <!-- 會員福利 -->
  <div style="margin:12px;background:#fff;border-radius:14px;padding:16px;box-shadow:0 1px 6px rgba(0,0,0,.07)">
    <div style="font-size:13px;font-weight:bold;color:#c9a98a;margin-bottom:12px;border-bottom:1px solid #f5ede0;padding-bottom:8px">會員福利一覽</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr style="background:#f5ede0;color:#7a5c3e">
        <th style="padding:8px 6px;text-align:left;border-radius:6px 0 0 6px">等級</th>
        <th style="padding:8px 4px;text-align:center">年消費門檻</th>
        <th style="padding:8px 4px;text-align:center">點數回饋</th>
        <th style="padding:8px 6px;text-align:center;border-radius:0 6px 6px 0">生日禮</th>
      </tr>
      <tr style="border-bottom:1px solid #faf5ef">
        <td style="padding:8px 6px;color:#a08060;font-weight:bold">一般</td>
        <td style="padding:8px 4px;text-align:center;color:#888">免門檻</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$300 / 1點</td>
        <td style="padding:8px 6px;text-align:center;color:#888">NT$30券×1</td>
      </tr>
      <tr style="border-bottom:1px solid #faf5ef">
        <td style="padding:8px 6px;color:#888;font-weight:bold">銀卡</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$3,000</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$200 / 1點</td>
        <td style="padding:8px 6px;text-align:center;color:#888">NT$50券×1</td>
      </tr>
      <tr style="border-bottom:1px solid #faf5ef">
        <td style="padding:8px 6px;color:#a07800;font-weight:bold">金卡</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$6,000</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$100 / 1點</td>
        <td style="padding:8px 6px;text-align:center;color:#888">NT$50券×2</td>
      </tr>
      <tr>
        <td style="padding:8px 6px;color:#3949ab;font-weight:bold">白金</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$12,000</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$50 / 1點</td>
        <td style="padding:8px 6px;text-align:center;color:#888">NT$50券×4</td>
      </tr>
    </table>
    <div style="margin-top:12px;padding:10px;background:#fff8f0;border-radius:8px;font-size:12px;color:#888;line-height:1.6">
      🎟 <strong style="color:#c9a98a">邀請好友</strong>：好友完成首筆訂單，雙方各獲 NT$50 折扣券 × 2 張<br>
      🪙 <strong style="color:#c9a98a">1點 = NT$1</strong>：結帳時直接折抵
    </div>
  </div>

  <!-- 加入會員表單 -->
  <div style="margin:12px;background:#fff;border-radius:14px;padding:16px;box-shadow:0 1px 6px rgba(0,0,0,.07)">
    <div style="font-size:13px;font-weight:bold;color:#c9a98a;margin-bottom:14px;border-bottom:1px solid #f5ede0;padding-bottom:8px">加入會員</div>
    <label style="display:block;font-size:12px;color:#888;margin-bottom:4px">姓名 *</label>
    <input id="reg-name" type="text" placeholder="請輸入真實姓名" style="width:100%;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;margin-bottom:12px;outline:none">
    <label style="display:block;font-size:12px;color:#888;margin-bottom:4px">手機號碼 * <span style="font-size:11px;color:#bbb">（每支手機只能綁一個帳號）</span></label>
    <input id="reg-phone" type="tel" placeholder="09xxxxxxxx" style="width:100%;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;margin-bottom:12px;outline:none">
    <label style="display:block;font-size:12px;color:#888;margin-bottom:4px">生日 * <span style="font-size:11px;color:#c97a7a">（登錄後無法修改，請確認正確）</span></label>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <select id="reg-bday-m" style="flex:1;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;outline:none;background:#fff;color:#333">
        <option value="">月份</option>
        ${Array.from({length:12},(_,i)=>{const m=String(i+1).padStart(2,'0');return `<option value="${m}">${i+1}月</option>`;}).join('')}
      </select>
      <select id="reg-bday-d" style="flex:1;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;outline:none;background:#fff;color:#333">
        <option value="">日期</option>
        ${Array.from({length:31},(_,i)=>{const d=String(i+1).padStart(2,'0');return `<option value="${d}">${i+1}日</option>`;}).join('')}
      </select>
    </div>
    <label style="display:block;font-size:12px;color:#888;margin-bottom:4px">邀請碼（選填）</label>
    <input id="reg-invite" type="text" placeholder="輸入好友邀請碼" maxlength="6" style="width:100%;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;text-transform:uppercase;margin-bottom:16px;outline:none">
    <button onclick="register()" style="width:100%;background:#c9a98a;color:#fff;border:none;border-radius:10px;padding:14px;font-size:16px;font-weight:bold;cursor:pointer;letter-spacing:1px">立即加入會員</button>
    <div id="reg-error" style="margin-top:10px;font-size:13px;color:#e07070;text-align:center;display:none"></div>
  </div>
</div>

<div id="app" style="display:none">
  <header>
    <div class="header-name" id="hdr-name">載入中…</div>
    <div class="header-sub" id="hdr-sub"></div>
    <div id="tier-badge" class="tier-badge"></div>
  </header>

  <!-- 會員福利（可收合） -->
  <div class="card">
    <div class="card-title" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center" onclick="toggleBenefits()">
      <span>會員福利一覽</span><span id="benefits-arrow" style="font-size:12px;color:#bbb">▼ 展開</span>
    </div>
    <div id="benefits-panel" style="display:none;margin-top:4px">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <tr style="background:#f5ede0;color:#7a5c3e">
          <th style="padding:7px 5px;text-align:left">等級</th>
          <th style="padding:7px 4px;text-align:center">年消費門檻</th>
          <th style="padding:7px 4px;text-align:center">點數回饋</th>
          <th style="padding:7px 5px;text-align:center">生日禮</th>
        </tr>
        <tr style="border-bottom:1px solid #faf5ef"><td style="padding:7px 5px;color:#a08060;font-weight:bold">一般</td><td style="padding:7px 4px;text-align:center;color:#888">免門檻</td><td style="padding:7px 4px;text-align:center;color:#888">NT$300/1點</td><td style="padding:7px 5px;text-align:center;color:#888">NT$30×1</td></tr>
        <tr style="border-bottom:1px solid #faf5ef"><td style="padding:7px 5px;color:#888;font-weight:bold">銀卡</td><td style="padding:7px 4px;text-align:center;color:#888">NT$3,000</td><td style="padding:7px 4px;text-align:center;color:#888">NT$200/1點</td><td style="padding:7px 5px;text-align:center;color:#888">NT$50×1</td></tr>
        <tr style="border-bottom:1px solid #faf5ef"><td style="padding:7px 5px;color:#a07800;font-weight:bold">金卡</td><td style="padding:7px 4px;text-align:center;color:#888">NT$6,000</td><td style="padding:7px 4px;text-align:center;color:#888">NT$100/1點</td><td style="padding:7px 5px;text-align:center;color:#888">NT$50×2</td></tr>
        <tr><td style="padding:7px 5px;color:#3949ab;font-weight:bold">白金</td><td style="padding:7px 4px;text-align:center;color:#888">NT$12,000</td><td style="padding:7px 4px;text-align:center;color:#888">NT$50/1點</td><td style="padding:7px 5px;text-align:center;color:#888">NT$50×4</td></tr>
      </table>
      <div style="margin-top:10px;padding:10px;background:#fff8f0;border-radius:8px;font-size:12px;color:#888;line-height:1.6">
        🎟 <strong style="color:#c9a98a">邀請好友</strong>：好友完成首筆訂單，雙方各獲 NT$50 折扣券 × 2 張<br>
        🪙 <strong style="color:#c9a98a">1點 = NT$1</strong>：結帳時直接折抵
      </div>
    </div>
  </div>

  <!-- 消費進度 -->
  <div class="card">
    <div class="card-title">年度消費進度</div>
    <div class="stat-row"><span>今年累積消費</span><span class="stat-val" id="yearly-spend">—</span></div>
    <div class="stat-row"><span>下一等級門檻</span><span class="stat-val" id="next-tier-threshold">—</span></div>
    <div class="progress-wrap">
      <div class="progress-label"><span id="cur-tier-label">—</span><span id="next-tier-label">—</span></div>
      <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
    </div>
  </div>

  <!-- 點數 -->
  <div class="card">
    <div class="card-title">點數</div>
    <div class="stat-row"><span>可用點數</span><span class="stat-val" id="total-pts">—</span></div>
    <div class="stat-row"><span>折抵方式</span><span class="stat-val">1點 = NT$1</span></div>
    <div id="pts-list" style="margin-top:8px;font-size:12px;color:#aaa"></div>
  </div>

  <!-- 進行中訂單 -->
  <div class="card">
    <div class="card-title">📦 我的訂單進度</div>
    <div id="order-list"><div class="empty">載入中…</div></div>
  </div>

  <!-- 優惠券 -->
  <div class="card">
    <div class="card-title">優惠券</div>
    <div id="coupon-list"><div class="empty">目前沒有可用優惠券</div></div>
  </div>

  <!-- 生日（唯讀） -->
  <div class="card">
    <div class="card-title">生日</div>
    <div style="font-size:13px;color:#888;margin-bottom:8px">每年生日當月自動發送禮券</div>
    <div id="bday-input" style="font-size:20px;font-weight:bold;color:#c9a98a;letter-spacing:2px">——</div>
    <div style="font-size:11px;color:#bbb;margin-top:6px">生日登錄後無法修改，如有疑問請聯繫客服</div>
  </div>

  <!-- 邀請碼 -->
  <div class="card">
    <div class="card-title">我的邀請碼</div>
    <div class="ref-code-box">
      <div style="font-size:12px;color:#aaa">分享給好友，好友首單完成後雙方各獲 NT$50 × 2 張</div>
      <div class="ref-code" id="my-ref-code">——</div>
      <button class="ref-copy-btn" onclick="copyRefCode()">複製邀請碼</button>
    </div>
    <div style="margin-top:14px;font-size:13px;color:#888">填入好友邀請碼（入會 1 個月內可填）</div>
    <div class="input-row" id="referral-input-row">
      <input id="ref-input" type="text" placeholder="輸入邀請碼" maxlength="6">
      <button onclick="bindReferral()">確認</button>
    </div>
    <div id="ref-bound-msg" style="display:none;font-size:13px;color:#c9a98a;margin-top:8px"></div>
  </div>
</div>

<div id="loading" style="text-align:center;padding:80px 20px;color:#ccc;font-size:14px">載入中…</div>
<div id="toast" class="toast"></div>

<script>
let userId = '', displayName = '', memberData = null;

async function init() {
  await liff.init({ liffId: '${MEMBER_LIFF_ID}' });
  if (!liff.isLoggedIn()) { liff.login(); return; }
  const profile = await liff.getProfile();
  userId = profile.userId;
  displayName = profile.displayName || '';

  const r = await fetch('/api/member?userId=' + userId);
  const d = await r.json();
  document.getElementById('loading').style.display = 'none';
  if (!d.ok) { document.getElementById('loading').textContent = '載入失敗'; return; }

  if (!d.registered) {
    document.getElementById('register-view').style.display = 'block';
  } else {
    memberData = d;
    render(d);
    document.getElementById('app').style.display = 'block';
  }
}

function toggleBenefits() {
  const panel = document.getElementById('benefits-panel');
  const arrow = document.getElementById('benefits-arrow');
  if (panel.style.display === 'none') {
    panel.style.display = 'block';
    arrow.textContent = '▲ 收合';
  } else {
    panel.style.display = 'none';
    arrow.textContent = '▼ 展開';
  }
}

async function register() {
  const name = document.getElementById('reg-name').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  const bm = document.getElementById('reg-bday-m').value;
  const bd = document.getElementById('reg-bday-d').value;
  const birthday = (bm && bd) ? bm + '-' + bd : '';
  const inviteCode = document.getElementById('reg-invite').value.trim().toUpperCase();
  const errEl = document.getElementById('reg-error');
  errEl.style.display = 'none';

  if (!name || !phone || !birthday) { errEl.textContent = '請填寫所有必填欄位'; errEl.style.display = 'block'; return; }
  if (!/^09\\d{8}$/.test(phone)) { errEl.textContent = '手機號碼格式不正確（例：0912345678）'; errEl.style.display = 'block'; return; }

  const btn = document.querySelector('#register-view button');
  btn.disabled = true; btn.textContent = '處理中…';
  try {
    const resp = await fetch('/api/member/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, displayName, name, phone, birthday, inviteCode }),
    });
    const d = await resp.json();
    if (!d.ok) {
      errEl.textContent = d.error || '註冊失敗，請稍後再試';
      errEl.style.display = 'block';
      btn.disabled = false; btn.textContent = '立即加入會員';
      return;
    }
    // 成功：重新載入會員資料
    document.getElementById('register-view').style.display = 'none';
    const mr = await fetch('/api/member?userId=' + userId);
    const md = await mr.json();
    if (md.ok && md.registered) { memberData = md; render(md); }
    document.getElementById('app').style.display = 'block';
    showToast('🎉 歡迎加入 Bijin 會員！');
  } catch(e) {
    errEl.textContent = '網路錯誤，請稍後再試';
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = '立即加入會員';
  }
}

function render(d) {
  const m = d.member;
  document.getElementById('hdr-name').textContent = m.displayName || '會員';
  document.getElementById('hdr-sub').textContent = '加入日期：' + m.joinDate;
  const badge = document.getElementById('tier-badge');
  badge.textContent = m.tier;
  badge.className = 'tier-badge tier-' + m.tier;

  // 消費進度
  const tiers = [{name:'一般',min:0},{name:'銀卡',min:3000},{name:'金卡',min:6000},{name:'白金',min:12000}];
  const curIdx = tiers.findIndex(t => t.name === m.tier);
  const nextTier = tiers[curIdx + 1];
  document.getElementById('yearly-spend').textContent = 'NT$' + (m.yearlySpend||0).toLocaleString();
  if (nextTier) {
    const curMin = tiers[curIdx].min;
    const pct = Math.min(100, Math.round(((m.yearlySpend - curMin) / (nextTier.min - curMin)) * 100));
    document.getElementById('next-tier-threshold').textContent = 'NT$' + nextTier.min.toLocaleString() + '（' + nextTier.name + '）';
    document.getElementById('cur-tier-label').textContent = m.tier;
    document.getElementById('next-tier-label').textContent = nextTier.name;
    document.getElementById('progress-fill').style.width = pct + '%';
  } else {
    document.getElementById('next-tier-threshold').textContent = '已達最高等級 🏆';
    document.getElementById('progress-fill').style.width = '100%';
  }

  // 點數（以會員表餘額為準，pointsRows 只用於明細展示）
  document.getElementById('total-pts').textContent = (m.points || 0) + ' 點';
  if (d.pointsRows.length) {
    document.getElementById('pts-list').innerHTML = d.pointsRows
      .map(p => \`<div style="display:flex;justify-content:space-between;padding:3px 0"><span>+\${p.points}點（\${p.orderId.substring(0,8)}…）</span><span>到期：\${p.expiryDate}</span></div>\`)
      .join('');
  }

  // 優惠券
  const cl = document.getElementById('coupon-list');
  if (d.coupons.length) {
    cl.innerHTML = d.coupons.map(c => \`
      <div class="coupon-item">
        <div>
          <div class="coupon-amount">NT$\${c.amount}</div>
          <div class="coupon-info">\${c.type}｜到期：\${c.expiryDate}</div>
          <div class="coupon-code">\${c.couponCode}</div>
        </div>
      </div>\`).join('');
  } else {
    cl.innerHTML = '<div class="empty">目前沒有可用優惠券</div>';
  }

  // 生日（唯讀顯示）
  document.getElementById('bday-input').textContent = m.birthday || '——';

  // 邀請碼
  document.getElementById('my-ref-code').textContent = m.referralCode || '——';
  if (m.referredByCode) {
    document.getElementById('referral-input-row').style.display = 'none';
    document.getElementById('ref-bound-msg').style.display = 'block';
    document.getElementById('ref-bound-msg').textContent = '✅ 已綁定邀請碼：' + m.referredByCode;
  }

  // 訂單進度（非同步載入）
  loadOrders();
}

const ORDER_STEPS = [
  { key: '待確認', label: '訂單確認中', icon: '🕐' },
  { key: '待買家完成下單', label: '等待您完成下單', icon: '⏳' },
  { key: '處理中(待處理或完成官網下單)', label: '官網下單處理中', icon: '🛍' },
  { key: '已發貨(官網出貨)', label: 'GRL 已出貨', icon: '📦' },
  { key: '已發貨(已達台灣海關作業)', label: '台灣海關作業中', icon: '🛃' },
  { key: '已發貨(賣貨便出貨)', label: '賣貨便已出貨', icon: '🚚' },
  { key: '待買家取貨', label: '商品已到門市，請取貨', icon: '🏪' },
];

function renderOrderCard(o) {
  const stepIdx = ORDER_STEPS.findIndex(s => s.key === o.status);
  const curStep = stepIdx >= 0 ? ORDER_STEPS[stepIdx] : { label: o.status, icon: '📋' };
  const totalSteps = ORDER_STEPS.length;
  const pct = stepIdx >= 0 ? Math.round((stepIdx / (totalSteps - 1)) * 100) : 0;

  const items = o.items.split('\\n').map(function(l) {
    if (!l.trim()) return '';
    const isPreorder = l.indexOf('【預購】') === 0;
    const text = isPreorder ? l.replace('【預購】','') : l;
    return '<div style="font-size:12px;color:#666;padding:2px 0">'
      + (isPreorder ? '<span style="background:#fff3e0;color:#e65100;font-size:10px;font-weight:700;border-radius:3px;padding:1px 4px;margin-right:3px;border:1px solid #ffcc80">預購</span>' : '')
      + escHtml(text) + '</div>';
  }).join('');

  let priceHtml = '<span style="font-weight:bold;color:#333">NT$' + o.finalAmount.toLocaleString() + '</span>';
  if (o.discountAmount > 0) {
    priceHtml = '<span style="text-decoration:line-through;color:#bbb;font-size:11px">NT$' + o.totalTwd.toLocaleString() + '</span> '
      + '<span style="font-weight:bold;color:#c9a98a">NT$' + o.finalAmount.toLocaleString() + '</span>';
  }

  const stepsHtml = ORDER_STEPS.map(function(s, i) {
    const done = i < stepIdx;
    const active = i === stepIdx;
    const col = active ? '#c9a98a' : done ? '#c9a98a' : '#ddd';
    const textCol = active ? '#7a5c3e' : done ? '#aaa' : '#ccc';
    const weight = active ? 'bold' : 'normal';
    return '<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px">'
      + '<div style="width:20px;height:20px;border-radius:50%;background:' + col + ';display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;margin-top:1px">'
      + (done ? '<span style="color:#fff">✓</span>' : active ? '<span style="color:#fff">●</span>' : '<span style="color:#bbb">○</span>')
      + '</div>'
      + '<div style="font-size:12px;color:' + textCol + ';font-weight:' + weight + ';line-height:1.4">' + s.icon + ' ' + s.label + '</div>'
      + '</div>';
  }).join('');

  return '<div style="border:1px solid #f0e8de;border-radius:10px;padding:12px;margin-bottom:10px;background:#fffaf6">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
    + '<div style="font-size:11px;color:#bbb">' + o.orderTime.substring(0,10) + '</div>'
    + '<div>' + priceHtml + '</div>'
    + '</div>'
    + '<div style="margin-bottom:8px">' + items + '</div>'
    + '<div style="background:#f5ede0;border-radius:8px;padding:8px 10px;margin-bottom:10px">'
    + '<div style="font-size:12px;font-weight:bold;color:#c9a98a;margin-bottom:2px">' + curStep.icon + ' 目前狀態</div>'
    + '<div style="font-size:13px;color:#7a5c3e;font-weight:bold">' + curStep.label + '</div>'
    + '</div>'
    + '<div style="font-size:11px;color:#bbb;margin-bottom:6px;cursor:pointer;text-align:right" onclick="toggleSteps(this)">▼ 查看完整進度</div>'
    + '<div style="display:none;border-top:1px solid #f0e8de;padding-top:8px">' + stepsHtml + '</div>'
    + '</div>';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toggleSteps(el) {
  const panel = el.nextElementSibling;
  if (panel.style.display === 'none') {
    panel.style.display = 'block';
    el.textContent = '▲ 收合進度';
  } else {
    panel.style.display = 'none';
    el.textContent = '▼ 查看完整進度';
  }
}

async function loadOrders() {
  const ol = document.getElementById('order-list');
  try {
    const r = await fetch('/api/member/orders?userId=' + userId);
    const d = await r.json();
    if (!d.ok) { ol.innerHTML = '<div class="empty">載入失敗</div>'; return; }
    if (!d.orders.length) { ol.innerHTML = '<div class="empty">目前沒有進行中的訂單</div>'; return; }
    ol.innerHTML = d.orders.map(renderOrderCard).join('');
  } catch(e) {
    ol.innerHTML = '<div class="empty">載入失敗，請稍後再試</div>';
  }
}

async function saveBirthday() {
  const val = document.getElementById('bday-input').value.trim();
  if (!/^\\d{2}-\\d{2}$/.test(val)) { showToast('格式應為 MM-DD，例：03-15'); return; }
  const r = await fetch('/api/member/birthday', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId, birthday: val }) });
  const d = await r.json();
  showToast(d.ok ? '✅ 生日已儲存' : '❌ ' + d.error);
}

async function bindReferral() {
  const code = document.getElementById('ref-input').value.trim().toUpperCase();
  if (!code) { showToast('請輸入邀請碼'); return; }
  const r = await fetch('/api/member/referral', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId, inviteCode: code }) });
  const d = await r.json();
  if (d.ok) {
    showToast('✅ ' + d.message);
    document.getElementById('referral-input-row').style.display = 'none';
    document.getElementById('ref-bound-msg').style.display = 'block';
    document.getElementById('ref-bound-msg').textContent = '✅ 已綁定邀請碼：' + code;
  } else showToast('❌ ' + d.error);
}

function copyRefCode() {
  const code = document.getElementById('my-ref-code').textContent;
  navigator.clipboard.writeText(code).then(() => showToast('✅ 已複製邀請碼：' + code)).catch(() => showToast('請手動複製：' + code));
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

init().catch(e => { document.getElementById('loading').textContent = '載入失敗：' + e.message; });
</script>
</body>
</html>`);
});

// ── 管理員 API：手動觸發訂單完成點數（補發）────────────────────────────────────
app.post('/api/admin/complete-order-points', express.json(), async (req, res) => {
  const { key, orderId } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:P` });
    const rows = resp.data.values || [];
    const row = rows.find(r => r[0] === orderId);
    if (!row) return res.status(404).json({ error: '找不到訂單' });
    const userId = row[2], displayName = row[15] || '', totalTwd = parseFloat(row[4]) || 0;
    const result = await processOrderCompletion(sheets, userId, displayName, orderId, totalTwd);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cron：每月1號自動發送生日禮 ──────────────────────────────────────────────
// Vercel Cron 每月1日 00:00 UTC（台灣時間 08:00）呼叫
app.post('/api/cron/birthday', async (req, res) => {
  // 驗證來自 Vercel Cron 或管理員
  const auth = req.headers['authorization'] || '';
  const cronSecret = process.env.CRON_SECRET || ADMIN_KEY;
  if (auth !== `Bearer ${cronSecret}` && auth !== `Bearer ${ADMIN_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const thisMonth = String(now.getMonth() + 1).padStart(2, '0'); // '01'~'12'
  const thisYear = now.getFullYear();
  const thisYearStr = String(thisYear);

  try {
    const sheets = getSheetsClient();

    // 取所有會員
    const mResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A:L` });
    const mRows = mResp.data.values || [];

    // 取今年已發過生日禮的 userId
    await ensureCouponSheet(sheets);
    const cResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!A:I` });
    const cRows = cResp.data.values || [];
    const alreadyGifted = new Set(
      cRows.slice(1)
        .filter(r => r[3] === '生日禮' && (r[5] || '').startsWith(thisYearStr))
        .map(r => r[1])
    );

    const client = new line.Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
    let count = 0;

    for (let i = 1; i < mRows.length; i++) {
      const r = mRows[i];
      const userId    = r[0] || '';
      const birthday  = r[3] || ''; // MM-DD
      const tier      = r[9] || '一般';

      const lineDisplayName = r[1] || '';
      if (!userId || !birthday) continue;
      const bMonth = birthday.split('-')[0]; // 'MM'
      if (bMonth !== thisMonth) continue;
      if (alreadyGifted.has(userId)) continue;

      // 發優惠券
      const gifts = BIRTHDAY_GIFTS[tier] || BIRTHDAY_GIFTS['一般'];
      const expiry = `${thisYear}-${thisMonth}-${new Date(thisYear, parseInt(thisMonth), 0).getDate().toString().padStart(2,'0')}`; // 當月最後一天
      const codes = [];
      for (const g of gifts) {
        const issued = await issueCoupons(sheets, userId, lineDisplayName, '生日禮', g.amount, g.qty, expiry);
        codes.push(...issued);
      }

      // 發 LINE 通知
      const totalQty = gifts.reduce((s, g) => s + g.qty, 0);
      const totalAmt = gifts.reduce((s, g) => s + g.amount * g.qty, 0);
      const msg = `🎂 生日快樂！\n\n感謝您是 Bijin 的 ${tier}會員 🌸\n\n生日禮券已發送：\nNT$${gifts[0].amount} 折扣碼 × ${totalQty} 張（共 NT$${totalAmt}）\n有效至本月底 ${expiry}\n\n請至會員中心查看並使用 💝`;
      await client.pushMessage(userId, { type: 'text', text: msg }).catch(() => {});
      count++;
    }

    res.json({ ok: true, sent: count, month: thisMonth });
  } catch (e) {
    console.error('[birthday cron error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 本地開發啟動 ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

module.exports = app;
