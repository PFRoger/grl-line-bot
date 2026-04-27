importScripts('config.js');

chrome.alarms.create('pollZOZO', {
  delayInMinutes: 0,
  periodInMinutes: CONFIG.pollIntervalSeconds / 60,
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollZOZO') pollAndProcess();
});

async function pollAndProcess() {
  let task;
  try {
    const res = await fetch(`${CONFIG.apiBase}/api/zozo-queue?key=${CONFIG.adminKey}`);
    task = await res.json();
  } catch (e) {
    console.warn('[ZOZO ext] poll error:', e.message);
    return;
  }

  if (!task || !task.taskId) return; // 沒有待處理任務

  console.log('[ZOZO ext] 處理任務:', task.taskId, task.url);

  let html;
  try {
    const zozoRes = await fetch(task.url, {
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8',
        'Cache-Control': 'no-cache',
      },
    });
    if (!zozoRes.ok) {
      await submitResult(task.taskId, null, `HTTP ${zozoRes.status}`);
      return;
    }
    html = await zozoRes.text();
  } catch (e) {
    await submitResult(task.taskId, null, e.message);
    return;
  }

  const result = parseZOZO(html, task.url);
  if (!result) {
    await submitResult(task.taskId, null, '無法解析商品資料（可能需要登入或頁面結構改變）');
    return;
  }

  await submitResult(task.taskId, result, null);
}

async function submitResult(taskId, result, error) {
  try {
    await fetch(`${CONFIG.apiBase}/api/zozo-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: CONFIG.adminKey, taskId, result, error }),
    });
    console.log('[ZOZO ext] 任務完成:', taskId, error ? `錯誤: ${error}` : '成功');
  } catch (e) {
    console.error('[ZOZO ext] 回傳失敗:', e.message);
  }
}

function parseZOZO(html, url) {
  if (!html.includes('data-goods-id') && !html.includes('data-item-price')) return null;

  const titleRaw = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
  const titleParts = titleRaw.split('|').map(s => s.trim()).filter(Boolean);
  const brand = titleParts.length >= 3 ? titleParts[0] : null;
  const name  = titleParts.length >= 2 ? titleParts.slice(0, -1).join(' ').trim() : titleRaw;

  const price    = parseInt((html.match(/data-item-price="(\d+)"/) || [])[1]) || null;
  const isOnSale = /data-has-double-price="true"/.test(html);
  const origPrice= isOnSale ? parseInt((html.match(/data-proper-price="(\d+)"/) || [])[1]) || null : null;
  const goodsId  = (html.match(/data-goods-id="(\d+)"/) || [])[1] || null;
  const goodsCode= (html.match(/data-goods-code="(\d+)"/) || [])[1] || null;

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
