'use strict';

const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

const app = express();

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

  return `  ${translatedColorSize}: ${translatedStatus}`;
}

// ── 建議售價計算 ──────────────────────────────────────────────────────────────
function calcSuggestedPrice(rate, jpy) {
  const cost = rate * jpy * 1.075 + (150 * 1 + 20 + 10);
  const base = Math.round(cost);
  const last = base % 10;
  if (last <= 4) return base - last + 5;
  if (last >= 6) return base - last + 9;
  return base; // last === 5 已符合
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
    // v4 格式：data.rates.TWD；v6 格式：data.conversion_rates.TWD
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

  // 庫存列表：找含 /在庫 /残り /予約販売 的 <li>
  const stockItems = [];
  $('li').each((_, el) => {
    const text = $(el).text().trim();
    if (/\/(在庫|残りわずか|予約販売)/.test(text)) {
      stockItems.push(text);
    }
  });

  return { productName, jpy, stockItems };
}

// ── 組合回覆訊息 ──────────────────────────────────────────────────────────────
async function buildReplyText(url) {
  const [{ productName, jpy, stockItems }, rate] = await Promise.all([
    scrapeGRL(url),
    fetchRate(),
  ]);

  const suggested = calcSuggestedPrice(rate, jpy);

  const stockLines =
    stockItems.length > 0
      ? stockItems.map(translateStockItem).join('\n')
      : '  （無庫存資訊）';

  return (
    `🌸 GRL 商品報價\n\n` +
    `${productName}\n` +
    `💴 日幣：¥${fmtJPY(jpy)}\n` +
    `💵 建議售價：NT$${suggested}\n\n` +
    `📦 庫存：\n${stockLines}\n\n` +
    `⚠️ 以上報價以 1 磅計算\n` +
    `實際重量若超過 1 磅，運費將增加，售價會有所調整。`
  );
}

// ── 處理單一 LINE 事件 ────────────────────────────────────────────────────────
async function handleEvent(event, client) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userText = event.message.text.trim();
  const replyToken = event.replyToken;

  // 判斷是否為 GRL 網址
  const isGRL = /https?:\/\/(www\.)?grail\.bz\//i.test(userText);

  let replyText;

  if (!isGRL) {
    replyText = '請傳入 GRL 商品網址';
  } else {
    try {
      replyText = await buildReplyText(userText);
    } catch (err) {
      console.error('[scrape error]', err.message);
      replyText = '無法取得商品資訊，請確認網址是否正確';
    }
  }

  await client.replyMessage(replyToken, {
    type: 'text',
    text: replyText,
  });
}

// ── Webhook 路由 ──────────────────────────────────────────────────────────────
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-line-signature'];

  // 驗證簽名
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
