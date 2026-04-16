'use strict';

const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const { google } = require('googleapis');

const app = express();

const ADMIN_USER_ID = 'U9fa329e70b89f4ce19089928a824bd29';
const SHEET_ID = '148eFUK3xm0ITsVpueqtnwjK-lcKeemoiRbQgcFWbGug';

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
    const hasNone    = liText.includes('在庫なし');
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
    const sizeStockRegex =
      /([A-Z0-9XL]+)\/(在庫あり|在庫なし|残りわずか|残り\d*|予約販売(?:《([^》]*)》)?)/g;
    let sizeMatch;
    const sizeResults = [];

    while ((sizeMatch = sizeStockRegex.exec(liText)) !== null) {
      const size = sizeMatch[1];
      const st   = sizeMatch[2];
      const arrivalRaw = sizeMatch[3] || '';
      let status;
      if (st === '在庫あり')            status = '✅ 有庫存';
      else if (st.includes('残り'))     status = '⚠️ 剩餘少量';
      else if (st.includes('予約販売')) status = '📅 預約販售' + (arrivalRaw ? `（${translateArrival(arrivalRaw)}）` : '');
      else                              status = '❌ 缺貨';
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
  const detail = `品類：${label}｜${packagingNote}｜估算範圍：${minG}~${maxG}g（${minLbs}~${maxLbs} lbs）｜信心：${confidenceLabel}`;

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
  await client.replyMessage(replyToken, flexMsg);

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

// ── 本地開發啟動 ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

module.exports = app;
