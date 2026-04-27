// ZOZO product scraper — uses got-scraping for TLS spoofing + ZOZO_COOKIE for session auth
module.exports = async (req, res) => {
  const productUrl = req.query && req.query.url;

  if (!productUrl || !/zozo\.jp/i.test(productUrl)) {
    return res.status(400).json({ error: 'Valid ZOZO URL required' });
  }

  const zozoCookie = process.env.ZOZO_COOKIE || '';

  let html;
  try {
    const { gotScraping } = await import('got-scraping');
    const response = await gotScraping({
      url: productUrl,
      timeout: { request: 12000 },
      headers: zozoCookie ? { cookie: zozoCookie } : {},
      headerGeneratorOptions: {
        browsers: [{ name: 'chrome', minVersion: 120 }],
        devices: ['desktop'],
        locales: ['ja-JP', 'en-US'],
        operatingSystems: ['windows'],
      },
    });
    html = response.body;
  } catch (e) {
    if (e.response) {
      return res.json({ error: `ZOZO HTTP ${e.response.statusCode}`, blocked: e.response.statusCode === 403 });
    }
    return res.json({ error: e.message });
  }

  if (!html.includes('data-goods-id') && !html.includes('data-item-price')) {
    const titleMatch2 = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return res.json({
      error: 'Not a ZOZO product page (may be blocked or redirected)',
      pageTitle: titleMatch2 ? titleMatch2[1].trim() : null,
    });
  }

  // Product name + brand: "<title>ブランド | 商品名 | ZOZOTOWN</title>"
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const titleParts = titleMatch ? titleMatch[1].split('|').map(s => s.trim()).filter(Boolean) : [];
  const brand = titleParts.length >= 3 ? titleParts[0] : null;
  const productName = titleParts.length >= 2
    ? titleParts.slice(0, titleParts.length - 1).join(' ').trim()
    : (titleParts[0] || '');

  const priceMatch = html.match(/data-item-price="(\d+)"/);
  const price = priceMatch ? parseInt(priceMatch[1]) : null;

  const isOnSale = /data-has-double-price="true"/.test(html);
  const origMatch = html.match(/data-proper-price="(\d+)"/);
  const originalPrice = isOnSale && origMatch ? parseInt(origMatch[1]) : null;

  const goodsIdMatch = html.match(/data-goods-id="(\d+)"/);
  const goodsId = goodsIdMatch ? goodsIdMatch[1] : null;

  const goodsCodeMatch = html.match(/data-goods-code="(\d+)"/);
  const goodsCode = goodsCodeMatch ? goodsCodeMatch[1] : null;

  // Parse shelf items: every HTML tag that carries data-shelf-color-id
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

  // Group by color
  const colorsMap = {};
  for (const item of shelfItems) {
    if (!colorsMap[item.colorId]) {
      colorsMap[item.colorId] = { id: item.colorId, name: item.colorName || item.colorId, sizes: [] };
    }
    if (item.sizeName) {
      colorsMap[item.colorId].sizes.push({ name: item.sizeName, inStock: item.inStock });
    }
  }

  const imgSuffix = goodsCode ? goodsCode.slice(-3) : '';
  const colors = Object.values(colorsMap).map(c => ({
    ...c,
    imageUrl: goodsCode ? `https://o.imgz.jp/${imgSuffix}/${goodsCode}/${goodsCode}_${c.id}_d.jpg` : null,
  }));

  const hasStock = colors.some(c => c.sizes.some(s => s.inStock));

  return res.json({ name: productName, brand, price, isOnSale, originalPrice, goodsId, goodsCode, hasStock, colors, url: productUrl });
};
