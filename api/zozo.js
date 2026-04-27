export const runtime = 'edge';

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const productUrl = searchParams.get('url');

  if (!productUrl || !/zozo\.jp/i.test(productUrl)) {
    return json({ error: 'Valid ZOZO URL required' }, 400);
  }

  let html;
  try {
    const res = await fetch(productUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      return json({ error: `ZOZO HTTP ${res.status}`, blocked: res.status === 403 });
    }

    html = await res.text();
  } catch (e) {
    return json({ error: e.message });
  }

  // Sanity check: is this actually a ZOZO product page?
  if (!html.includes('data-goods-id') && !html.includes('data-item-price')) {
    return json({ error: 'Not a ZOZO product page (may be blocked or redirected)' });
  }

  // Product name + brand from <title>: "ブランド | 商品名 | ZOZOTOWN"
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  const titleParts = titleMatch ? titleMatch[1].split('|').map(s => s.trim()).filter(Boolean) : [];
  const brand = titleParts.length >= 3 ? titleParts[0] : null;
  const productName = titleParts.length >= 2
    ? titleParts.slice(0, titleParts.length - 1).join(' ').trim()
    : (titleParts[0] || '');

  // Price (JPY, tax included)
  const priceMatch = html.match(/data-item-price="(\d+)"/);
  const price = priceMatch ? parseInt(priceMatch[1]) : null;

  // Sale
  const isOnSale = /data-has-double-price="true"/.test(html);
  const origMatch = html.match(/data-proper-price="(\d+)"/);
  const originalPrice = isOnSale && origMatch ? parseInt(origMatch[1]) : null;

  // Goods identifiers
  const goodsIdMatch = html.match(/data-goods-id="(\d+)"/);
  const goodsId = goodsIdMatch ? goodsIdMatch[1] : null;

  const goodsCodeMatch = html.match(/data-goods-code="(\d+)"/);
  const goodsCode = goodsCodeMatch ? goodsCodeMatch[1] : null;

  // Parse shelf items: find every HTML tag that carries data-shelf-color-id
  // ZOZO's shelf items embed color + size + stock in a single element tag
  const shelfItems = [];
  const tagRegex = /<[^>]+data-shelf-color-id="[^"]*"[^>]*>/g;
  let m;
  while ((m = tagRegex.exec(html)) !== null) {
    const tag = m[0];
    const colorId   = (tag.match(/data-shelf-color-id="([^"]+)"/)   || [])[1] || '';
    const colorName = (tag.match(/data-shelf-color-name="([^"]+)"/) || [])[1] || '';
    const sizeName  = (tag.match(/data-shelf-size-name="([^"]+)"/)  || [])[1] || '';
    const stockQty  = (tag.match(/data-shelf-stock-quantity="([^"]+)"/) || [])[1] || '0';
    if (colorId) {
      shelfItems.push({ colorId, colorName, sizeName, inStock: parseInt(stockQty) > 0 });
    }
  }

  // Group shelf items by color
  const colorsMap = {};
  for (const item of shelfItems) {
    if (!colorsMap[item.colorId]) {
      colorsMap[item.colorId] = { id: item.colorId, name: item.colorName || item.colorId, sizes: [] };
    }
    if (item.sizeName) {
      colorsMap[item.colorId].sizes.push({ name: item.sizeName, inStock: item.inStock });
    }
  }

  // Build image URLs: https://o.imgz.jp/{last3}/{goodsCode}/{goodsCode}_{colorId}_d.jpg
  const imgSuffix = goodsCode ? goodsCode.slice(-3) : '';
  const colors = Object.values(colorsMap).map(c => ({
    ...c,
    imageUrl: goodsCode
      ? `https://o.imgz.jp/${imgSuffix}/${goodsCode}/${goodsCode}_${c.id}_d.jpg`
      : null,
  }));

  const hasStock = colors.some(c => c.sizes.some(s => s.inStock));

  return json({ name: productName, brand, price, isOnSale, originalPrice, goodsId, goodsCode, hasStock, colors, url: productUrl });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
