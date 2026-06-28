'use strict';

const { estimateWeight } = require('./weight');
const { calcSuggestedPrice, JP_SHIPPING_ZOZO } = require('./pricing');

// ── ZOZO 顏色對照表 ───────────────────────────────────────────────────────────
const ZOZO_COLOR_MAP = {
  'ブラック': '黒色', 'ホワイト': '白色', 'ネイビー': '深藍', 'ベージュ': '米色',
  'グレー': '灰色', 'ライトグレー': '淺灰', 'ダークグレー': '深灰',
  'ブラウン': '棕色', 'ダークブラウン': '深棕', 'モカ': '摩卡', 'モカブラウン': '摩卡棕',
  'ピンク': '粉色', 'レッド': '紅色', 'グリーン': '綠色', 'カーキ': '卡其色',
  'パープル': '紫色', 'ラベンダー': '薰衣草', 'イエロー': '黃色', 'オレンジ': '橘色',
  'ブルー': '藍色', 'ライトブルー': '淺藍', 'ダークブルー': '深藍',
  'アイボリー': '象牙色', 'オフホワイト': '米白', 'テラコッタ': '磚紅',
  'ミント': '薄荷', 'ミントグリーン': '薄荷綠', 'オリーブ': '橄欖綠',
  'レオパード': '豹紋', 'チェック': '格紋', 'ストライプ': '條紋', 'カモフラージュ': '迷彩',
  'シルバー': '銀色', 'ゴールド': '金色',
};

// ── ZOZO 尺寸縮寫對照表 ──────────────────────────────────────────────────────
const ZOZO_SIZE_ABBR = {
  'X-SMALL': 'XS', 'XSMALL': 'XS', 'X SMALL': 'XS',
  'SMALL': 'S',
  'MEDIUM': 'M',
  'LARGE': 'L',
  'X-LARGE': 'XL', 'XLARGE': 'XL', 'X LARGE': 'XL',
  'XX-LARGE': 'XXL', 'XXLARGE': 'XXL', 'XX LARGE': 'XXL',
  'FREE': 'F', 'FREESIZE': 'F', 'FREE SIZE': 'F',
};

function zozoColorLabel(jpName) {
  if (!jpName) return jpName;
  const zh = ZOZO_COLOR_MAP[jpName] || Object.entries(ZOZO_COLOR_MAP).find(([jp]) => jpName.includes(jp))?.[1] || '';
  return zh ? `${zh}（${jpName}）` : jpName;
}

function zozoSizeName(s) {
  return ZOZO_SIZE_ABBR[s.trim().toUpperCase()] || s;
}

// ── ZOZO 商品報價 Flex Message ────────────────────────────────────────────────
function buildZOZOFlexMessage(data, url, rate = null) {
  const { name, brand, price, isOnSale, originalPrice, colors, goodsId, sizeEquivMap = {}, materialText = '', sleeveCm = null } = data;

  const jpyLine = isOnSale && originalPrice
    ? `¥${originalPrice.toLocaleString('ja-JP')} → ¥${price.toLocaleString('ja-JP')} 🔥`
    : price ? `¥${price.toLocaleString('ja-JP')}` : '—';

  const weightInfo = estimateWeight(name || '', materialText, sleeveCm);
  const lbs = weightInfo ? weightInfo.midLbs : 1;
  const suggested = (rate && price) ? calcSuggestedPrice(rate, price, lbs, JP_SHIPPING_ZOZO) : null;
  const ntdLine = suggested ? `NT$${suggested}` : null;

  const nameShort = (name || '').substring(0, 30);

  const bubbles = colors.slice(0, 10).map(c => {
    const colorLabel = zozoColorLabel(c.name);
    const sizeRows = c.sizes.length > 0
      ? c.sizes.map(s => {
          const sizeName = (/^\d+$/.test(s.name) && sizeEquivMap[s.name]) ? sizeEquivMap[s.name] : zozoSizeName(s.name);
          const label = s.inStock
            ? Array.from(`🛒 加入購物車｜${sizeName} 有庫存`).slice(0, 20).join('')
            : Array.from(`❌ ${sizeName} 缺貨`).slice(0, 20).join('');
          let action;
          if (s.inStock && goodsId) {
            const pbData = `action=add_to_cart_zozo&gid=${goodsId}&cid=${encodeURIComponent(c.id)}&cn=${encodeURIComponent(c.name)}&sz=${encodeURIComponent(sizeName)}&jpy=${price || 0}&p=${suggested || 0}&img=${encodeURIComponent(c.imageUrl || '')}&ts=${Math.floor(Date.now()/1000)}`;
            action = { type: 'postback', label, data: pbData };
          } else {
            action = { type: 'uri', label, uri: url };
          }
          return {
            type: 'button',
            height: 'sm',
            style: 'primary',
            color: s.inStock ? '#b8895a' : '#c8bbb0',
            margin: 'xs',
            action,
          };
        })
      : [{ type: 'button', height: 'sm', style: 'primary', color: '#c8bbb0', margin: 'xs',
           action: { type: 'uri', label: '❌ 缺貨', uri: url } }];

    const priceTxt = ntdLine ? `${jpyLine}  報價金額 ${ntdLine}` : jpyLine;
    const priceContents = [{ type: 'text', text: priceTxt, size: 'xs', color: '#a08060', margin: 'xs', wrap: true }];

    const bubble = {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        paddingBottom: '8px',
        spacing: 'none',
        backgroundColor: '#f5ede0',
        contents: [
          ...(brand ? [{ type: 'text', text: brand, size: 'xxs', color: '#b8a090' }] : []),
          { type: 'text', text: nameShort, size: 'xs', color: '#a08060', wrap: true, margin: 'xs' },
          { type: 'text', text: colorLabel, weight: 'bold', size: 'md', color: '#3d2c1e', wrap: true, margin: 'xs' },
          ...priceContents,
          { type: 'separator', margin: 'md', color: '#ddd0bc' },
          { type: 'box', layout: 'vertical', margin: 'md', spacing: 'none', contents: sizeRows },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '8px',
        backgroundColor: '#f5ede0',
        contents: [{
          type: 'button',
          height: 'sm',
          style: 'link',
          color: '#a08060',
          action: { type: 'uri', label: '回官方商品頁', uri: url },
        }],
      },
    };

    if (c.imageUrl) {
      bubble.hero = { type: 'image', url: c.imageUrl, size: 'full', aspectRatio: '3:4', aspectMode: 'cover' };
    }

    return bubble;
  });

  if (bubbles.length === 0) {
    bubbles.push({
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '14px',
        contents: [
          { type: 'text', text: nameShort || '（未知商品名）', weight: 'bold', size: 'md', wrap: true },
          { type: 'text', text: jpyLine, size: 'sm', color: '#a08060' },
          { type: 'text', text: '（無庫存資訊）', size: 'sm', color: '#aaaaaa' },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '8px',
        contents: [{ type: 'button', height: 'sm', style: 'link', color: '#a08060',
          action: { type: 'uri', label: '回官方商品頁', uri: url } }],
      },
    });
  }

  const contents = bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles };
  return { type: 'flex', altText: `ZOZO 商品報價｜${name}`, contents };
}

module.exports = { ZOZO_COLOR_MAP, ZOZO_SIZE_ABBR, zozoColorLabel, zozoSizeName, buildZOZOFlexMessage };
