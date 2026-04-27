document.getElementById('btn').addEventListener('click', async () => {
  const url = document.getElementById('url').value.trim();
  const result = document.getElementById('result');

  if (!url || !url.includes('zozo.jp')) {
    result.textContent = '⚠️ 請貼入 ZOZO 商品網址';
    result.className = 'err';
    return;
  }

  result.textContent = '查詢中...';
  result.className = 'loading';

  let html;
  try {
    const res = await fetch(url, {
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8',
        'Cache-Control': 'no-cache',
      },
    });

    if (!res.ok) {
      result.textContent = `❌ HTTP ${res.status} — 被擋了（需要先登入 ZOZO？）`;
      result.className = 'err';
      return;
    }

    html = await res.text();
  } catch (e) {
    result.textContent = `❌ 錯誤: ${e.message}`;
    result.className = 'err';
    return;
  }

  // 確認是否為商品頁
  const titleRaw = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
  const priceMatch = html.match(/data-item-price="(\d+)"/);
  const goodsIdMatch = html.match(/data-goods-id="(\d+)"/);

  if (!priceMatch && !goodsIdMatch) {
    result.textContent = `❌ 拿到頁面但不是商品頁\n頁面標題: ${titleRaw || '（無）'}\nHTML 大小: ${html.length} 字元`;
    result.className = 'err';
    return;
  }

  // 解析商品資料
  const titleParts = titleRaw.split('|').map(s => s.trim()).filter(Boolean);
  const brand = titleParts.length >= 3 ? titleParts[0] : null;
  const name  = titleParts.length >= 2 ? titleParts.slice(0, -1).join(' ') : titleRaw;
  const price = priceMatch ? parseInt(priceMatch[1]) : null;
  const goodsId = goodsIdMatch ? goodsIdMatch[1] : null;

  const isOnSale = /data-has-double-price="true"/.test(html);
  const origPrice = (html.match(/data-proper-price="(\d+)"/) || [])[1];

  // 顏色庫存（簡化版）
  const colorSet = new Set();
  const colorRegex = /data-shelf-color-name="([^"]+)"/g;
  let cm;
  while ((cm = colorRegex.exec(html)) !== null) colorSet.add(cm[1]);

  let lines = [`✅ 成功！`];
  if (brand) lines.push(`品牌: ${brand}`);
  lines.push(`商品: ${name}`);
  lines.push(`ID: ${goodsId || '—'}`);
  if (isOnSale && origPrice) {
    lines.push(`原價: ¥${parseInt(origPrice).toLocaleString()}`);
    lines.push(`特價: ¥${price?.toLocaleString()} 🔥`);
  } else {
    lines.push(`日幣: ¥${price?.toLocaleString() || '—'}`);
  }
  if (colorSet.size > 0) lines.push(`顏色: ${[...colorSet].join('、')}`);

  result.textContent = lines.join('\n');
  result.className = 'ok';
});
