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

// 開啟背景 Tab → 等頁面載入完成 → 取 HTML → 關閉 Tab
function fetchViaTab(url) {
  return new Promise((resolve, reject) => {
    let tabId;

    const cleanup = (fn) => {
      if (tabId) chrome.tabs.remove(tabId, () => {});
      fn();
    };

    const timer = setTimeout(() => cleanup(() => reject(new Error('Timeout（30秒）'))), 30000);

    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        return reject(new Error(chrome.runtime.lastError.message));
      }
      tabId = tab.id;

      function onUpdated(id, info) {
        if (id !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);

        chrome.scripting.executeScript(
          { target: { tabId }, func: () => document.documentElement.outerHTML },
          (results) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              cleanup(() => reject(new Error(chrome.runtime.lastError.message)));
              return;
            }
            const html = results && results[0] && results[0].result;
            cleanup(() => html ? resolve(html) : reject(new Error('空白頁面')));
          }
        );
      }

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
  if (!html.includes('data-goods-id') && !html.includes('data-item-price')) return null;

  const titleRaw = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
  const titleParts = titleRaw.split(/[|｜]/).map(s => s.trim()).filter(Boolean);
  const brand = titleParts.length >= 3 ? titleParts[0] : null;
  const name  = titleParts.length >= 2 ? titleParts.slice(0, -1).join(' ').trim() : titleRaw;

  const price     = parseInt((html.match(/data-item-price="(\d+)"/)    || [])[1]) || null;
  const isOnSale  = /data-has-double-price="true"/.test(html);
  const origPrice = isOnSale ? parseInt((html.match(/data-proper-price="(\d+)"/) || [])[1]) || null : null;
  const goodsId   = (html.match(/data-goods-id="(\d+)"/)   || [])[1] || null;
  const goodsCode = (html.match(/data-goods-code="(\d+)"/) || [])[1] || null;

  const shelfItems = [];
  const tagRegex = /<[^>]+data-shelf-color-id="[^"]*"[^>]*>/g;
  let m;
  while ((m = tagRegex.exec(html)) !== null) {
    const tag = m[0];
    const colorId   = (tag.match(/data-shelf-color-id="([^"]+)"/)   || [])[1] || '';
    const colorName = (tag.match(/data-shelf-color-name="([^"]+)"/) || [])[1] || '';
    const sizeName  = (tag.match(/data-shelf-size-name="([^"]+)"/)  || [])[1] || '';
    const stockQty  = (tag.match(/data-shelf-stock-quantity="([^"]+)"/) || [])[1] || '0';
    if (colorId) shelfItems.push({ colorId, colorName, sizeName, inStock: parseInt(stockQty) > 0 });
  }

  const colorsMap = {};
  for (const item of shelfItems) {
    if (!colorsMap[item.colorId]) {
      colorsMap[item.colorId] = { id: item.colorId, name: item.colorName || item.colorId, sizes: [] };
    }
    if (item.sizeName) colorsMap[item.colorId].sizes.push({ name: item.sizeName, inStock: item.inStock });
  }

  const imgSuffix = goodsCode ? goodsCode.slice(-3) : '';
  const colors = Object.values(colorsMap).map(c => ({
    ...c,
    imageUrl: goodsCode ? `https://o.imgz.jp/${imgSuffix}/${goodsCode}/${goodsCode}_${c.id}_d.jpg` : null,
  }));

  return {
    name, brand, price, isOnSale, originalPrice: origPrice,
    goodsId, goodsCode, hasStock: colors.some(c => c.sizes.some(s => s.inStock)),
    colors, url,
  };
}
