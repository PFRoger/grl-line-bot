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
            // tab 還在跳轉，再等一下
            stableTimer = setTimeout(tryExtract, 1500);
            return;
          }
          const html = results && results[0] && results[0].result;
          if (!html || html.length < 10000) {
            // 太小 → Akamai challenge 頁，等 JS 執行完再試
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
  console.log('[ZOZO] HTML大小:', html.length, '| goods-id:', html.includes('data-goods-id'), '| item-price:', html.includes('data-item-price'), '| goodsCode:', (html.match(/data-goods-code="([^"]+)"/)||[])[1]||'null', '| title:', (html.match(/<title[^>]*>([^<]{0,80})/i)||[])[1]||'');
  // debug: 尋找尺寸對應標籤
  const sizeEquivMatches = html.match(/サイズ相当[^<"]{0,30}/g) || [];
  const sizeJsonMatch = html.match(/"size(?:Label|Name|Equiv|Chart|Guide)[^"]*"\s*:\s*"([^"]{1,50})"/g) || [];
  console.log('[ZOZO DEBUG 尺寸相当]', sizeEquivMatches.slice(0,5), '| sizeJSON:', sizeJsonMatch.slice(0,5));
  if (!html.includes('data-goods-id') && !html.includes('data-item-price')) return null;

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

  // OG image 作為 fallback（全商品都有，但不分顏色）
  const ogImage = (html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i) ||
                   html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i) ||
                   html.match(/og:image.*?content="([^"]+)"/i) || [])[1] || null;

  // 從 <img alt="..." src="...imgz.jp..."> 建立兩個對照表：
  // swatchByName: 顏色名 → URL，swatchById: 顏色ID（從URL提取）→ URL
  const swatchByName = {};
  const swatchById   = {};
  const swatchRegex  = /<img[^>]+src="(https?:\/\/[^"]*imgz\.jp[^"]+)"[^>]*alt="([^"]+)"|<img[^>]+alt="([^"]+)"[^>]+src="(https?:\/\/[^"]*imgz\.jp[^"]+)"/g;
  let sw;
  while ((sw = swatchRegex.exec(html)) !== null) {
    const imgUrl  = sw[1] || sw[4];
    const altText = sw[2] || sw[3];
    if (!imgUrl || !altText) continue;
    // 全 alt 文字索引（e.g. "商品名 | ブラック"）
    if (!swatchByName[altText]) swatchByName[altText] = imgUrl;
    // alt 含「|」時，取 | 後的顏色部分（e.g. " ブラック"）
    if (altText.includes('|')) {
      const colorPart = altText.split('|').pop().trim();
      if (colorPart && !swatchByName[colorPart]) swatchByName[colorPart] = imgUrl;
    }
    // 從 URL 抽出 colorId (pattern: goodsCode_colorId_d_size 或 goodsCodeb_colorId_d_size)
    const idM = imgUrl.match(/\/\w+b?_(\d+)_d_\d+/);
    if (idM && !swatchById[idM[1]]) swatchById[idM[1]] = imgUrl;
  }
  console.log('[ZOZO] swatch 顏色數:', Object.keys(swatchByName).length, '| byId:', Object.keys(swatchById).length, Object.entries(swatchById).slice(0, 2).map(([k,v]) => `id${k}:${v.substring(0,50)}`).join(', '));

  const imgSuffix = goodsCode ? goodsCode.slice(-3) : '';
  const colors = Object.values(colorsMap).map(c => {
    // 優先：頁面抓到的真實 URL（顏色名 or ID 索引）→ shelf tag 直帶圖 → CDN 公式 → ogImage
    const swatchUrl  = swatchByName[c.name] || swatchById[c.id] || null;
    const cdnUrl     = goodsCode ? `https://c.imgz.jp/${imgSuffix}/${goodsCode}/${goodsCode}_${c.id}_d_500.jpg` : null;
    const shelfImg   = c.colorImage || null;
    const imageUrl   = swatchUrl || shelfImg || cdnUrl || ogImage || null;
    const { colorImage, ...rest } = c;
    return { ...rest, imageUrl };
  });

  console.log('[ZOZO] goodsCode:', goodsCode, '| colors:', colors.length, '| firstImg:', colors[0]?.imageUrl?.substring(0, 70) || 'null');

  return {
    name, brand, price, isOnSale, originalPrice: origPrice,
    goodsId, goodsCode, hasStock: colors.some(c => c.sizes.some(s => s.inStock)),
    colors, url,
  };
}
