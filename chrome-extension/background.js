const ADMIN_KEY = 'grl-admin-2026';
const API_BASE = 'https://pfroger-linebot-2.vercel.app';
const POLL_MINUTES = 10 / 60;

chrome.alarms.create('pollZOZO', { delayInMinutes: POLL_MINUTES, periodInMinutes: POLL_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollZOZO') pollAndProcess();
});

async function pollAndProcess() {
  let task;
  try {
    const res = await fetch(`${API_BASE}/api/zozo-queue?key=${ADMIN_KEY}`);
    if (!res.ok) return;
    task = await res.json();
  } catch (e) {
    console.warn('[ZOZO] poll error:', e.message);
    return;
  }

  if (!task || !task.taskId) return;
  console.log('[ZOZO] 處理任務:', task.taskId, task.url);

  let html;
  try {
    html = await fetchViaTab(task.url);
  } catch (e) {
    console.error('[ZOZO] Tab fetch 失敗:', e.message);
    await submitResult(task.taskId, null, e.message);
    return;
  }

  const result = parseZOZO(html, task.url);
  if (!result) {
    console.warn('[ZOZO] 無法解析商品資料');
    await submitResult(task.taskId, null, '無法解析商品資料（頁面結構可能改變）');
    return;
  }

  console.log('[ZOZO] 解析成功:', result.name, result.price);
  await submitResult(task.taskId, result, null);
}

// 開啟背景 Tab → 等頁面穩定（處理 Akamai redirect）→ 取 HTML → 關閉 Tab
function fetchViaTab(url) {
  return new Promise((resolve, reject) => {
    let tabId;
    let settled = false;
    let stableTimer = null;

    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(globalTimer);
      clearTimeout(stableTimer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (tabId) chrome.tabs.remove(tabId, () => {});
      fn();
    };

    const globalTimer = setTimeout(() => done(() => reject(new Error('Timeout（60秒）'))), 60000);

    const tryExtract = () => {
      chrome.scripting.executeScript(
        { target: { tabId }, func: () => document.documentElement.outerHTML },
        (results) => {
          if (settled) return;
          if (chrome.runtime.lastError) {
            stableTimer = setTimeout(tryExtract, 1500);
            return;
          }
          const html = results && results[0] && results[0].result;
          if (!html || html.length < 10000) {
            console.log('[ZOZO] 小頁面', html ? html.length : 0, 'bytes，等待...');
            stableTimer = setTimeout(tryExtract, 2000);
            return;
          }
          done(() => resolve(html));
        }
      );
    };

    function onUpdated(id, info) {
      if (id !== tabId) return;
      if (info.status === 'complete') {
        clearTimeout(stableTimer);
        stableTimer = setTimeout(tryExtract, 1500);
      }
    }

    chrome.tabs.create({ url, active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        done(() => reject(new Error(chrome.runtime.lastError.message)));
        return;
      }
      tabId = tab.id;
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

async function submitResult(taskId, result, error) {
  try {
    const res = await fetch(`${API_BASE}/api/zozo-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: ADMIN_KEY, taskId, result, error }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.pushError) {
      console.error('[ZOZO] 伺服器錯誤:', res.status, JSON.stringify(body));
    } else {
      console.log('[ZOZO] 完成:', taskId, error ? `錯誤: ${error}` : 'OK');
    }
  } catch (e) {
    console.error('[ZOZO] 回傳失敗:', e.message);
  }
}

function parseZOZO(html, url) {
  // 舊版頁面（data-* attributes）
  if (html.includes('data-goods-id') || html.includes('data-item-price')) {
    return parseZOZOLegacy(html, url);
  }
  // Next.js 頁面（goods-sale 等，資料在 __NEXT_DATA__）
  return parseZOZONextData(html, url);
}

// ── 舊版解析（data-shelf-color-id 等 attributes）────────────────────────────
function parseZOZOLegacy(html, url) {
  const titleRaw = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
  const titleParts = titleRaw.split(/[|｜]/).map(s => s.trim()).filter(Boolean);
  const brand = titleParts.length >= 3 ? titleParts[0] : null;
  const name  = titleParts.length >= 2 ? titleParts.slice(0, -1).join(' ').trim() : titleRaw;

  const price     = parseInt((html.match(/data-item-price="(\d+)"/)    || [])[1]) || null;
  const isOnSale  = /data-has-double-price="true"/.test(html);
  const origPrice = isOnSale ? parseInt((html.match(/data-proper-price="(\d+)"/) || [])[1]) || null : null;
  const goodsId   = (html.match(/data-goods-id="(\d+)"/)     || [])[1] || null;
  const goodsCode = (html.match(/data-goods-code="([^"]+)"/) || [])[1] || null;

  const shelfItems = [];
  const tagRegex = /<[^>]+data-shelf-color-id="[^"]*"[^>]*>/g;
  let m;
  let firstTagLogged = false;
  while ((m = tagRegex.exec(html)) !== null) {
    const tag = m[0];
    if (!firstTagLogged) { console.log('[ZOZO] 第一個shelf tag:', tag.substring(0, 300)); firstTagLogged = true; }
    const colorId    = (tag.match(/data-shelf-color-id="([^"]+)"/)    || [])[1] || '';
    const colorName  = (tag.match(/data-shelf-color-name="([^"]+)"/)  || [])[1] || '';
    const sizeName   = (tag.match(/data-shelf-size-name="([^"]+)"/)   || [])[1] || '';
    const stockQty   = (tag.match(/data-shelf-stock-quantity="([^"]+)"/) || [])[1] || '0';
    const colorImage = (tag.match(/data-shelf-color-image-url="([^"]+)"/) || tag.match(/data-color-image="([^"]+)"/) || [])[1] || '';
    if (colorId) shelfItems.push({ colorId, colorName, sizeName, inStock: parseInt(stockQty) > 0, colorImage });
  }

  const colorsMap = {};
  for (const item of shelfItems) {
    if (!colorsMap[item.colorId]) {
      colorsMap[item.colorId] = { id: item.colorId, name: item.colorName || item.colorId, sizes: [], colorImage: item.colorImage || '' };
    }
    if (item.colorImage && !colorsMap[item.colorId].colorImage) colorsMap[item.colorId].colorImage = item.colorImage;
    if (item.sizeName) colorsMap[item.colorId].sizes.push({ name: item.sizeName, inStock: item.inStock });
  }

  const seenSizes = new Set();
  const orderedSizeNames = [];
  for (const m of html.matchAll(/data-shelf-size-name="([^"]+)"/g)) {
    if (!seenSizes.has(m[1])) { seenSizes.add(m[1]); orderedSizeNames.push(m[1]); }
  }
  const sizeZSpans = [...html.matchAll(/<span[^>]*class="sizeZ"[^>]*><span>([^<]+)<\/span><\/span>サイズ相当/g)].map(m => m[1].trim());
  const sizeEquivMap = {};
  orderedSizeNames.forEach((name, i) => { if (sizeZSpans[i]) sizeEquivMap[name] = sizeZSpans[i]; });

  const ogImage = (html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i) ||
                   html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i) ||
                   html.match(/og:image.*?content="([^"]+)"/i) || [])[1] || null;

  const swatchByName = {};
  const swatchById   = {};
  const swatchRegex  = /<img[^>]+src="(https?:\/\/[^"]*imgz\.jp[^"]+)"[^>]*alt="([^"]+)"|<img[^>]+alt="([^"]+)"[^>]+src="(https?:\/\/[^"]*imgz\.jp[^"]+)"/g;
  let sw;
  while ((sw = swatchRegex.exec(html)) !== null) {
    const imgUrl  = sw[1] || sw[4];
    const altText = sw[2] || sw[3];
    if (!imgUrl || !altText) continue;
    if (!swatchByName[altText]) swatchByName[altText] = imgUrl;
    if (altText.includes('|')) {
      const colorPart = altText.split('|').pop().trim();
      if (colorPart && !swatchByName[colorPart]) swatchByName[colorPart] = imgUrl;
    }
    const idM = imgUrl.match(/\/\w+b?_(\d+)_d_\d+/);
    if (idM && !swatchById[idM[1]]) swatchById[idM[1]] = imgUrl;
  }
  console.log('[ZOZO] swatch 顏色數:', Object.keys(swatchByName).length, '| byId:', Object.keys(swatchById).length, Object.entries(swatchById).slice(0, 2).map(([k,v]) => `id${k}:${v.substring(0,50)}`).join(', '));

  const imgSuffix = goodsCode ? goodsCode.slice(-3) : '';
  const colors = Object.values(colorsMap).map(c => {
    const swatchUrl = swatchByName[c.name] || swatchById[c.id] || null;
    const cdnUrl    = goodsCode ? `https://c.imgz.jp/${imgSuffix}/${goodsCode}/${goodsCode}_${c.id}_d_500.jpg` : null;
    const shelfImg  = c.colorImage || null;
    const imageUrl  = swatchUrl || shelfImg || cdnUrl || ogImage || null;
    const { colorImage, ...rest } = c;
    return { ...rest, imageUrl };
  });

  console.log('[ZOZO] goodsCode:', goodsCode, '| colors:', colors.length, '| firstImg:', colors[0]?.imageUrl?.substring(0, 70) || 'null');

  return {
    name, brand, price, isOnSale, originalPrice: origPrice,
    goodsId, goodsCode, hasStock: colors.some(c => c.sizes.some(s => s.inStock)),
    colors, sizeEquivMap, url,
  };
}

// ── Next.js 頁面解析（__NEXT_DATA__ JSON）────────────────────────────────────
// 不依賴固定的 key 路徑，改用 regex 直接搜尋 JSON 字串裡的欄位值，
// 以及遞迴搜尋 colorStocks array，避免欄位名/嵌套結構改變就失效。
function parseZOZONextData(html, url) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) { console.log('[ZOZO] __NEXT_DATA__ not found'); return null; }

  const raw = m[1];
  let nd;
  try { nd = JSON.parse(raw); } catch(e) { console.log('[ZOZO] __NEXT_DATA__ JSON error:', e.message); return null; }

  // ── Scalar fields: 直接 regex 搜尋，不管嵌套多深 ──────────────────────────
  const cdnId   = (html.match(/c\.imgz\.jp\/\d+\/(\d+)\/\1b?_\d+_d_\d+/) || [])[1] || null;
  const goodsId = cdnId || (raw.match(/"goodsId"\s*:\s*(\d+)/)?.[1]) || null;
  const goodsCode = raw.match(/"goodsCode"\s*:\s*"([A-Za-z0-9_-]+)"/)?.[1] || null;

  // 含稅售價優先（ZOZO 日本站顯示含稅）；"price" 為最後 fallback 以免誤抓無關數字
  const price = parseInt(
    raw.match(/"salePriceInTax"\s*:\s*(\d+)/)?.[1] ||
    raw.match(/"salePrice"\s*:\s*(\d+)/)?.[1] ||
    raw.match(/"discountPrice"\s*:\s*(\d+)/)?.[1] ||
    raw.match(/"taxIncludedPrice"\s*:\s*(\d+)/)?.[1] ||
    raw.match(/"displayPrice"\s*:\s*(\d+)/)?.[1] ||
    raw.match(/"unitPrice"\s*:\s*(\d+)/)?.[1] ||
    raw.match(/"itemPrice"\s*:\s*(\d+)/)?.[1] ||
    raw.match(/"price"\s*:\s*(\d+)/)?.[1] || '0') || null;
  const origPrice = parseInt(
    raw.match(/"regularPriceInTax"\s*:\s*(\d+)/)?.[1] ||
    raw.match(/"regularPrice"\s*:\s*(\d+)/)?.[1] ||
    raw.match(/"originalPrice"\s*:\s*(\d+)/)?.[1] ||
    raw.match(/"listPrice"\s*:\s*(\d+)/)?.[1] ||
    raw.match(/"basePrice"\s*:\s*(\d+)/)?.[1] || '0') || null;
  const isOnSale = !!(origPrice && price && origPrice > price);

  // 商品名：先找 JSON，再從 HTML title 解析
  let name = raw.match(/"goodsName"\s*:\s*"([^"]+)"/)?.[1] || '';
  if (!name) {
    const titleRaw = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
    name = titleRaw.replace(/^【[^】]*】/, '').split(/[|｜]/)[0].trim();
  }
  const brand = raw.match(/"brandName"\s*:\s*"([^"]+)"/)?.[1] || null;

  console.log('[ZOZO] __NEXT_DATA__ basic:', { goodsId, name: (name || '').substring(0, 40), price, origPrice });

  const ogImage = (html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i) ||
                   html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i) || [])[1] || null;

  // ── Colors: 遞迴搜尋 colorStocks/colors/colorGroups array ─────────────────
  const colorList = findColorStocksArray(nd) || [];
  console.log('[ZOZO] __NEXT_DATA__ colorList:', colorList.length);

  // 判斷 colorList 是嵌套結構（每色含 sizes array）還是扁平結構（每色每尺一筆）
  const firstItem = colorList[0] || {};
  const isGrouped = Array.isArray(firstItem.sizeStocks) || Array.isArray(firstItem.sizes) ||
                    Array.isArray(firstItem.stocks) || Array.isArray(firstItem.sizeGroups);

  let colors;
  if (isGrouped) {
    colors = colorList.map(c => {
      const cid   = String(c.colorId || c.id || '');
      const cname = c.colorName || c.name || cid;
      const sizeList = c.sizeStocks || c.sizes || c.stocks || c.sizeGroups || [];
      const sizes = sizeList.map(s => ({
        name:    s.sizeName || s.name || s.sizeId || String(s.id || ''),
        inStock: (s.stockQuantity || s.stock || s.quantity || 0) > 0,
      }));
      return { id: cid, name: cname, sizes, imageUrl: c.imageUrl || c.colorImageUrl || c.image || ogImage || null };
    });
  } else {
    // 扁平結構：每筆可能是「一色」或「一色一尺」
    // goods-sale 頁面用 goodsDetailId 作為顏色識別符（無 colorId）
    const grouped = new Map();
    for (const item of colorList) {
      const cid   = String(item.colorId || item.goodsDetailId || item.id || '');
      const cname = item.colorName || item.name || cid;
      if (!grouped.has(cid)) {
        // colorImageUrl 是 35px 縮圖（_d_35.jpg），統一換成 500px
        const rawImg = item.colorImageUrl || item.imageUrl || item.image || null;
        const imageUrl = rawImg ? rawImg.replace(/_d_\d+\.jpg$/, '_d_500.jpg') : (ogImage || null);
        grouped.set(cid, { id: cid, name: cname, sizes: [], imageUrl });
      }
      const sizeName = item.sizeName || item.sizeId || item.sizeCode || String(item.sizeNumber || '');
      if (sizeName) {
        // captionType 是最可靠的庫存指標（stockQuantity 可能為 null 但仍有貨）
        const inStock = item.captionType
          ? item.captionType === 'INSTOCK'
          : (item.stockQuantity || 0) > 0;
        grouped.get(cid).sizes.push({ name: sizeName, inStock });
      } else if (grouped.get(cid).sizes.length === 0) {
        const avail = item.goodsAvailability;
        const inStock = avail !== undefined && avail !== false && avail !== null &&
                        avail !== 'OUT_OF_STOCK' && avail !== 'UNAVAILABLE' && avail !== 0;
        grouped.get(cid).sizes.push({ name: 'F', inStock });
      }
    }
    colors = [...grouped.values()];
  }

  if (!name && !price) { console.log('[ZOZO] __NEXT_DATA__ no name/price, giving up'); return null; }

  return {
    name, brand, price, isOnSale, originalPrice: origPrice,
    goodsId, goodsCode,
    hasStock: colors.some(c => c.sizes.some(s => s.inStock)),
    colors, sizeEquivMap: {}, url,
  };
}

// 遞迴搜尋第一個長得像貨架庫存的 array
// 條件：有顏色欄位（colorId/colorName）且有尺碼或庫存欄位（sizeName/stockQuantity）
// 這樣可以跳過 merchantCenter.items（只有 colorName，無 sizeName/stockQuantity）
// 正確找到 goodsShelfInfo.shelves（同時有 colorId、colorName、sizeName、stockQuantity）
function findColorStocksArray(obj, depth) {
  if (depth === undefined) depth = 0;
  if (!obj || typeof obj !== 'object' || depth > 7) return null;

  const isShelfLike = (item) =>
    item && (item.colorId !== undefined || item.colorName !== undefined) &&
    (item.sizeName !== undefined || item.stockQuantity !== undefined);

  if (Array.isArray(obj)) {
    if (obj.length > 0 && isShelfLike(obj[0])) return obj;
    return null;
  }
  for (const key of ['shelves', 'colorStocks', 'colors', 'colorGroups']) {
    if (Array.isArray(obj[key]) && obj[key].length > 0 && isShelfLike(obj[key][0])) return obj[key];
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = findColorStocksArray(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
