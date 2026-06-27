'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');

const { COLOR_KEYS, COLOR_MAP_OBJ, hasColorKeyword, translateColorWithJp } = require('./colors');

// URL → 已解析真實 URL 快取（Serverless 冷啟動後清空，屬可接受行為）
const resolvedUrlCache = new Map();

// ── 到貨日期翻譯：「4月下旬入荷予定」→「預計4月下旬到貨」────────────────────
function translateArrival(text) {
  return text.replace('入荷予定', '到貨');
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
function parseStockFromHtml(html) {
  const stockLines = [];
  const seen = new Set();
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch;

  while ((liMatch = liRegex.exec(html)) !== null) {
    const liText = liMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    const hasStock   = liText.includes('在庫あり');
    const hasNone    = liText.includes('在庫なし') || liText.includes('在庫無し');
    const hasLimited = liText.includes('残りわずか') ||
                       (liText.includes('残り') && !liText.includes('残りわずか'));
    const hasReserve = liText.includes('予約販売');

    if (!hasStock && !hasNone && !hasLimited && !hasReserve) continue;
    if (liText.includes('アイテム') && !hasColorKeyword(liText)) continue;
    if (liText.includes('日新着'))   continue;
    if (liText.includes('日再入荷')) continue;
    if (liText.includes('日予約'))   continue;
    if (liText.includes('すべて') && !hasColorKeyword(liText)) continue;
    if (!hasColorKeyword(liText)) continue;
    if (seen.has(liText)) continue;
    seen.add(liText);

    let colorName = '';
    for (const k of COLOR_KEYS) {
      if (liText.includes(k)) { colorName = k; break; }
    }
    const displayColor = colorName ? `${COLOR_MAP_OBJ[colorName]}(${colorName})` : '';

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
  return '';
}

// ── 爬取 GRL 商品資訊 ─────────────────────────────────────────────────────────
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
    const resp = await axios.get(url, { timeout: 8000, headers });
    html = resp.data;
    const finalUrl = resp.request?.res?.responseUrl;
    if (finalUrl && finalUrl !== url) {
      resolvedUrl = finalUrl;
      resolvedUrlCache.set(inputUrl, resolvedUrl);
    }
  } catch (err) {
    if (err.response && err.response.status === 404) {
      const dispUrl = url.replace(/\/(item\/)/, '/disp/item/');
      try {
        if (dispUrl !== url) {
          const resp2 = await axios.get(dispUrl, { timeout: 8000, headers });
          html = resp2.data;
          const finalUrl2 = resp2.request?.res?.responseUrl;
          if (finalUrl2 && finalUrl2 !== dispUrl) {
            resolvedUrl = finalUrl2;
            resolvedUrlCache.set(inputUrl, resolvedUrl);
          }
        } else throw err;
      } catch (err2) {
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

  const canonRaw = $('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content');
  if (canonRaw && /\/(?:disp\/)?item\/[a-z]/i.test(canonRaw)) {
    const canon = (canonRaw.startsWith('http') ? canonRaw : `https://www.grail.bz${canonRaw}`)
      .replace(/\?.*$/, '').replace(/([^/])$/, '$1/');
    if (canon !== resolvedUrl) {
      resolvedUrl = canon;
      resolvedUrlCache.set(inputUrl, resolvedUrl);
    }
  }

  const rawName = $('h1').first().text().trim();
  const productName = rawName.replace(/[\[【][^\]】]*[\]】]\s*$/, '').trim();

  const priceText = $('.txt-price').first().text();
  const priceMatch = priceText.match(/¥([\d,]+)/);
  if (!priceMatch) throw new Error('無法解析價格');
  const jpy = parseInt(priceMatch[1].replace(/,/g, ''), 10);

  const imageUrl = $('meta[property="og:image"]').attr('content') || null;

  const stockLines = parseStockFromHtml(html);

  let materialText = '';
  $('div.tab-content').each((_, el) => {
    const text = $(el).text().trim();
    if (text.includes('素材は') || (text.includes('%') && /ウール|アクリル|コットン|綿|レーヨン|ポリエステル|ナイロン|カシミア/.test(text))) {
      materialText = text;
      return false;
    }
  });
  console.log('[scrapeGRL] materialText:', materialText.slice(0, 100) || '(empty)');

  const colorImages = {};
  $('img[alt]').each((_, el) => {
    const alt = $(el).attr('alt') || '';
    const src = $(el).attr('data-src') || $(el).attr('data-lazy') || $(el).attr('src') || '';
    if (!src) return;
    for (const colorJp of COLOR_KEYS) {
      if (colorImages[colorJp]) continue;
      if (!alt.includes(colorJp)) continue;
      const fullUrl = src
        .replace('/images/goods/t/', '/images/goods/d/')
        .replace(/^\/\//, 'https://')
        .replace(/^\//, 'https://cdn.grail.bz/');
      colorImages[colorJp] = fullUrl.startsWith('http') ? fullUrl : `https://cdn.grail.bz${fullUrl}`;
    }
  });

  return { productName, jpy, stockLines, imageUrl, colorImages, resolvedUrl, materialText };
}

module.exports = { translateArrival, extractProductId, parseStockFromHtml, calcQStatus, scrapeGRL };
