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

// ── 顏色對照表（複合詞排前面，避免單字先被替換） ──────────────────────────
const COLOR_MAP = [
  ['オフホワイト', '灰白色'],
  ['オフベージュ', '杏色'],
  ['ライトブルー', '淺藍色'],
  ['ライトグレー', '淺灰色'],
  ['グレージュ', '藕色'],
  ['ワインレッド', '酒紅色'],
  ['ブラック', '黑色'],
  ['ピンク', '粉色'],
  ['グレー', '灰色'],
  ['ホワイト', '米白色'],
  ['ブルー', '藍色'],
  ['ベージュ', '淺褐色'],
  ['ネイビー', '藏青色'],
  ['ブラウン', '咖啡色'],
];

// ── 翻譯顏色 ─────────────────────────────────────────────────────────────────
function translateColor(text) {
  let result = text;
  for (const [ja, zh] of COLOR_MAP) {
    result = result.split(ja).join(zh);
  }
  return result;
}

// ── 翻譯庫存狀態 ──────────────────────────────────────────────────────────────
function translateStatus(status) {
  if (status === '在庫あり') return '✅ 有庫存';
  if (status === '在庫なし') return '❌ 缺貨';
  if (status === '残りわずか') return '⚠️ 剩餘少量';
  if (status.startsWith('予約販売')) {
    const m = status.match(/《(.+?)入荷予定》/);
    return m
      ? `📅 預約販售（預計${m[1]}到貨）`
      : '📅 預約販售';
  }
  return status;
}

// ── 翻譯單筆庫存項目 ──────────────────────────────────────────────────────────
function translateStockItem(raw) {
  const slash = raw.lastIndexOf('/');
  if (slash === -1) return raw;

  const colorSize = raw.substring(0, slash).trim();
  const status = raw.substring(slash + 1).trim();

  const translatedColorSize = translateColor(colorSize);
  const translatedStatus = translateStatus(status);

  return `${translatedColorSize}: ${translatedStatus}`;
}

// ── 建議售價計算 ──────────────────────────────────────────────────────────────
// PROFIT = 每單固定利潤（NT$），如需改為從 Google Sheet 讀取可後續調整
const PROFIT = 120;

function calcSuggestedPrice(rate, jpy) {
  const cost = rate * jpy * 1.075 + (150 * 1 + 20 + 10);
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

// ── 從網址擷取商品 ID（去掉最後 4 碼數字後綴，例如 ru14381119→ru1438、ai541119→ai54）
function extractProductId(url) {
  // 取出 item slug（2字母 + 數字）
  const m = url.match(/\/item\/([a-z]{2}\d+)/i);
  if (!m) return null;
  const slug = m[1]; // e.g. "ru14381119"
  // 去掉最後 4 碼數字後綴
  return slug.replace(/\d{4}$/, '');
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

  // 庫存列表：取 li 全部文字（含子元素），逐行過濾出 色/尺寸/庫存 格式
  // 用逐行比對而非 directText，避免庫存文字放在 <span> 等子元素時取不到
  const stockItems = [];
  const seenLines = new Set();
  $('li').each((_, el) => {
    const lines = $(el).text().split(/[\n\r]+/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (
        /[^\s\/]+\/[^\s\/]+\/(在庫あり|在庫なし|残りわずか|予約販売)/.test(line) &&
        !seenLines.has(line)
      ) {
        seenLines.add(line);
        stockItems.push(line);
      }
    }
  });

  return { productName, jpy, stockItems };
}

// ── 新增商品到 Google Sheet（管理員功能）─────────────────────────────────────
async function appendProductToSheet(productId, productName, jpy, stockItems) {
  const sheets = getSheetsClient();
  const stockSummary = stockItems.map(translateStockItem).join(' | ');

  // 讀取現有資料以確認最後一列
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'A:A',
  });
  const nextRow = ((res.data.values || []).length) + 1;

  // 組成完整 A~P 的列（空欄以空字串填充）
  const row = new Array(16).fill('');
  row[0] = productId;    // A
  row[12] = productName; // M
  row[14] = jpy;         // O
  row[15] = stockSummary; // P

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `A${nextRow}:P${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] },
  });
}

// ── 記錄查詢到「查詢紀錄」分頁 ──────────────────────────────────────────────
async function logQueryToSheet(userId, displayName, productId, productName, jpy) {
  const sheets = getSheetsClient();
  const date = new Date().toISOString().slice(0, 10);

  // 嘗試寫入；若分頁不存在則先建立
  async function doAppend() {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: '查詢紀錄!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[date, displayName, userId, productId, productName, jpy]] },
    });
  }

  try {
    await doAppend();
  } catch (err) {
    if (err.message && err.message.includes('Unable to parse range')) {
      // 分頁不存在，先建立並加標題
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        resource: {
          requests: [{ addSheet: { properties: { title: '查詢紀錄' } } }],
        },
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: '查詢紀錄!A:F',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [
            ['日期', 'LINE 顯示名稱', 'LINE User ID', '商品 ID', '商品名稱', '日幣價格'],
            [date, displayName, userId, productId, productName, jpy],
          ],
        },
      });
    } else {
      throw err;
    }
  }
}

// ── 建立 Flex Message ─────────────────────────────────────────────────────────
function buildFlexMessage(url, productName, jpy, suggested, stockItems) {
  const productId = extractProductId(url) || '';

  const stockContents = stockItems.length > 0
    ? stockItems.map((raw) => ({
        type: 'text',
        text: translateStockItem(raw),
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

  return {
    type: 'flex',
    altText: `GRL 商品報價｜${productName}`,
    contents: {
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
          {
            type: 'separator',
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: '💴 日幣',
                size: 'sm',
                color: '#888888',
                flex: 2,
              },
              {
                type: 'text',
                text: `¥${fmtJPY(jpy)}`,
                size: 'sm',
                color: '#222222',
                flex: 3,
                align: 'end',
              },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: '💵 建議售價',
                size: 'sm',
                color: '#888888',
                flex: 2,
              },
              {
                type: 'text',
                text: `NT$${suggested}`,
                size: 'sm',
                weight: 'bold',
                color: '#E53935',
                flex: 3,
                align: 'end',
              },
            ],
          },
          {
            type: 'separator',
          },
          {
            type: 'text',
            text: '📦 庫存',
            size: 'sm',
            weight: 'bold',
            color: '#444444',
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: stockContents,
          },
          {
            type: 'text',
            text: '⚠️ 以上報價以 1 磅計算',
            size: 'xs',
            color: '#aaaaaa',
            wrap: true,
          },
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
    },
  };
}

// ── 處理單一 LINE 事件 ────────────────────────────────────────────────────────
async function handleEvent(event, client) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  console.log('userId:', event.source.userId);

  const userId = event.source.userId;
  const userText = event.message.text.trim();
  const replyToken = event.replyToken;

  // 判斷是否為 GRL 網址
  const isGRL = /https?:\/\/(www\.)?grail\.bz\//i.test(userText);

  if (!isGRL) {
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '請傳入 GRL 商品網址',
    });
    return;
  }

  let productData;
  let rate;
  try {
    [productData, rate] = await Promise.all([scrapeGRL(userText), fetchRate()]);
  } catch (err) {
    console.error('[scrape error]', err.message);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '無法取得商品資訊，請確認網址是否正確',
    });
    return;
  }

  const { productName, jpy, stockItems } = productData;
  const suggested = calcSuggestedPrice(rate, jpy);
  const productId = extractProductId(userText) || '';

  // 取得用戶顯示名稱（LINE displayName，如 "bingfung"）
  let displayName = userId;
  try {
    const profile = await client.getProfile(userId);
    displayName = profile.displayName;
  } catch (e) {
    console.warn('[getProfile error]', e.message);
  }

  // 回覆 Flex Message
  const flexMsg = buildFlexMessage(userText, productName, jpy, suggested, stockItems);
  await client.replyMessage(replyToken, flexMsg);

  // 背景作業：不影響回覆速度
  const bgTasks = [];

  // 管理員：新增商品到追蹤表
  if (userId === ADMIN_USER_ID) {
    bgTasks.push(
      appendProductToSheet(productId, productName, jpy, stockItems).catch((e) =>
        console.error('[sheets append error]', e.message)
      )
    );
  }

  // 所有用戶：記錄查詢紀錄
  bgTasks.push(
    logQueryToSheet(userId, displayName, productId, productName, jpy).catch((e) =>
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
    !line.validateSignature(
      req.body,
      process.env.LINE_CHANNEL_SECRET,
      signature
    )
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

// ── 本地開發啟動 ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

module.exports = app;
