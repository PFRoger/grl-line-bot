'use strict';

const { MEMBER_LIFF_ID } = require('./config');
const { fmtJPY } = require('./pricing');

// ── 查詢紀錄 Flex Message ─────────────────────────────────────────────────────
function buildHistoryFlexMessage(history) {
  if (history.length === 0) {
    return {
      type: 'text',
      text: '您還沒有查詢紀錄。\n\n請傳入 GRL 商品網址開始查詢！\n範例：https://www.grail.bz/item/xxx/',
    };
  }

  const bubbles = history.map((row) => {
    const date      = row[0] || '';
    const prodName  = row[4] || '商品名稱不明';
    const jpyText   = row[5] ? `¥${Number(row[5]).toLocaleString('ja-JP')}` : '-';
    const prodId    = row[3] || '';
    const imgUrl      = row[10] || '';
    const suggested   = row[11] ? `NT$${Number(row[11]).toLocaleString()}` : '';
    const storedUrl   = row[12] || '';
    const canonicalUrl = storedUrl || (prodId ? `https://www.grail.bz/item/${prodId}/` : '');
    const itemUrl     = canonicalUrl || 'https://www.grail.bz';
    const requeryUrl  = canonicalUrl;

    const priceContents = [
      { type: 'text', text: jpyText, size: 'sm', color: '#888888' },
      ...(suggested ? [{ type: 'text', text: suggested, size: 'md', weight: 'bold', color: '#E53935' }] : []),
      { type: 'text', text: date, size: 'xs', color: '#aaaaaa', margin: 'sm' },
    ];

    const bubble = {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: '12px',
        contents: [
          { type: 'text', text: prodName, size: 'sm', weight: 'bold', wrap: true, maxLines: 2, color: '#222222' },
          ...(prodId ? [{ type: 'text', text: prodId.toUpperCase(), size: 'xxs', color: '#aaaaaa' }] : []),
          ...priceContents,
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '8px',
        spacing: 'xs',
        contents: [
          ...(requeryUrl ? [{
            type: 'button',
            style: 'primary',
            color: '#b8895a',
            height: 'sm',
            action: {
              type: 'message',
              label: '🔄 重新查詢報價',
              text: requeryUrl,
            },
          }] : []),
          {
            type: 'button',
            style: 'link',
            color: '#aaaaaa',
            height: 'sm',
            action: { type: 'uri', label: '查看商品頁', uri: itemUrl },
          },
        ],
      },
    };

    if (imgUrl) {
      bubble.hero = {
        type: 'image',
        url: imgUrl,
        size: 'full',
        aspectRatio: '3:4',
        aspectMode: 'cover',
      };
    }

    return bubble;
  });

  return {
    type: 'flex',
    altText: `您的查詢紀錄（${history.length} 件商品）`,
    contents: { type: 'carousel', contents: bubbles },
  };
}

// ── 使用教學 Flex Message ─────────────────────────────────────────────────────
function buildTutorialFlexMessage() {
  const steps = [
    {
      step: '01',
      title: '查詢商品報價',
      icon: '🔍',
      headerBg: '#e8c4bc',
      accentColor: '#c4847a',
      lines: [
        { text: '支援 GRL・ZOZO 兩大平台', bold: true },
        { text: '前往官網找到喜歡的商品', bold: false },
        { text: '複製商品網址，貼到這個對話框', bold: false },
        { text: ' ', bold: false },
        { text: 'Bot 立即回傳', bold: true },
        { text: '・台幣報價（含代購費 + 國際運費）', bold: false },
        { text: '・各顏色 / 尺寸庫存狀態', bold: false },
        { text: ' ', bold: false },
        { text: '✅ 有庫存　❌ 缺貨', bold: false },
        { text: '※ ZOZO 需 30～60 秒解析', bold: false },
      ],
    },
    {
      step: '02',
      title: '選色加入購物車',
      icon: '🛒',
      headerBg: '#d4a8a0',
      accentColor: '#b08070',
      lines: [
        { text: '報價卡片左右滑動選擇顏色', bold: false },
        { text: '點按想要的尺寸按鈕加入購物車', bold: false },
        { text: ' ', bold: false },
        { text: '想要多件？繼續貼網址選款即可', bold: true },
        { text: ' ', bold: false },
        { text: '⚠️ 購物車 6 小時後自動清空', bold: false },
        { text: '請盡早完成結帳！', bold: false },
      ],
    },
    {
      step: '03',
      title: '填資料・送出訂單',
      icon: '📋',
      headerBg: '#c49488',
      accentColor: '#8b5a50',
      lines: [
        { text: '點主選單「購物車」開啟結帳頁', bold: false },
        { text: ' ', bold: false },
        { text: '① 確認購物車商品', bold: false },
        { text: '② 填寫姓名、電話、備註', bold: false },
        { text: '③ 點「送出訂單」', bold: false },
        { text: ' ', bold: false },
        { text: '送出後靜候賣家確認 🌸', bold: false },
      ],
    },
    {
      step: '04',
      title: '收賣貨便連結',
      icon: '📩',
      headerBg: '#b08880',
      accentColor: '#7a4a40',
      lines: [
        { text: '賣家核對訂單後', bold: false },
        { text: '會透過 LINE 傳送賣貨便連結', bold: false },
        { text: ' ', bold: false },
        { text: '點連結完成賣貨便正式下單', bold: true },
        { text: '（此步驟才算訂單成立）', bold: false },
        { text: ' ', bold: false },
        { text: '⚠️ 請務必透過我們傳的連結下單', bold: false },
      ],
    },
    {
      step: '05',
      title: '7-11 到店取件',
      icon: '📦',
      headerBg: '#9a7c78',
      accentColor: '#5c3a38',
      lines: [
        { text: '商品到台灣後我們主動通知您', bold: false },
        { text: ' ', bold: false },
        { text: '收到通知後前往您選擇的', bold: false },
        { text: '7-11 門市取件即可 ✨', bold: false },
        { text: ' ', bold: false },
        { text: '有任何問題隨時留言給我們 🌸', bold: true },
      ],
    },
  ];

  const bubbles = steps.map((s) => ({
    type: 'bubble',
    size: 'kilo',
    styles: {
      body: { backgroundColor: '#fdf8f6' },
    },
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: s.headerBg,
      paddingTop: '16px',
      paddingBottom: '14px',
      paddingStart: '16px',
      paddingEnd: '16px',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'text',
              text: `STEP ${s.step}`,
              color: '#ffffff',
              size: 'xxs',
              weight: 'bold',
              flex: 1,
              gravity: 'center',
            },
            {
              type: 'text',
              text: s.icon,
              size: 'lg',
              align: 'end',
            },
          ],
        },
        {
          type: 'text',
          text: s.title,
          color: '#ffffff',
          size: 'md',
          weight: 'bold',
          wrap: true,
          margin: 'sm',
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      paddingAll: '16px',
      contents: s.lines.map((l) => ({
        type: 'text',
        text: l.text,
        size: 'sm',
        color: l.bold ? '#5c3d35' : '#8a6558',
        weight: l.bold ? 'bold' : 'regular',
        wrap: true,
      })),
    },
  }));

  return {
    type: 'flex',
    altText: '購物指南｜查詢報價→加購物車→送訂單→賣貨便→7-11取件',
    contents: { type: 'carousel', contents: bubbles },
  };
}

// ── 加入購物車按鈕 Flex（Carousel，每個顏色一張卡片）──────────────────────────
function buildAddToCartFlex(stockLines, productId, jpy, suggested, productUrl, imageUrl, productName, colorImages = {}) {
  if (stockLines.length === 0) return null;
  const hasAvailable = stockLines.some(l => l.includes('✅') || l.includes('⚠️') || l.includes('📅'));
  if (!hasAvailable) return null;

  const parsed = stockLines.map((line) => {
    const colonIdx = line.lastIndexOf(':');
    const labelPart = colonIdx !== -1 ? line.substring(0, colonIdx).trim() : line;
    const statusDesc = colonIdx !== -1 ? line.substring(colonIdx + 1).trim() : '';

    const jpMatch = labelPart.match(/\(([^)]+)\)/);
    const colorJp = jpMatch ? jpMatch[1] : '';
    const colorZh = jpMatch ? labelPart.substring(0, labelPart.indexOf('(')).trim() : labelPart.split(' ')[0];
    const afterColor = jpMatch ? labelPart.substring(labelPart.indexOf(')') + 1).trim() : '';
    const size = afterColor || 'FREE';
    const inStock = line.includes('✅');
    const isPreorder = line.includes('📅');
    const isLowStock = line.includes('⚠️');
    const isOutOfStock = line.includes('❌');
    return { colorJp, colorZh, size, inStock, isPreorder, isLowStock, isOutOfStock, statusDesc };
  });

  const colorOrder = [];
  const colorGroups = {};
  for (const item of parsed) {
    if (!colorGroups[item.colorJp]) {
      colorGroups[item.colorJp] = { colorZh: item.colorZh, sizes: [] };
      colorOrder.push(item.colorJp);
    }
    colorGroups[item.colorJp].sizes.push(item);
  }

  const bubbles = colorOrder.slice(0, 10).map((colorJp) => {
    const group = colorGroups[colorJp];
    const colorLabel = group.colorZh ? `${group.colorZh}（${colorJp}）` : colorJp;

    const sizeRows = group.sizes.map((item) => {
      if (item.isOutOfStock) {
        const outLabel = Array.from(`❌ ${item.size} 缺貨`).slice(0, 20).join('');
        return {
          type: 'button',
          height: 'sm',
          style: 'primary',
          color: '#c8bbb0',
          margin: 'xs',
          action: {
            type: 'postback',
            label: outLabel,
            data: `action=out_of_stock&s=${encodeURIComponent(item.size)}`,
            displayText: `${item.size} 目前缺貨`,
          },
        };
      }
      let shortDate = '';
      if (item.isPreorder && item.statusDesc) {
        const dateMatch = item.statusDesc.match(/(\d+月[^\s）()（]+)/);
        if (dateMatch) shortDate = dateMatch[1];
      }
      const shortStatus = item.inStock ? '有庫存' : item.isPreorder
        ? (shortDate ? `預約${shortDate}` : '預約販售')
        : '剩餘少量';
      const btnLabel = Array.from(`🛒 加入購物車｜${item.size} ${shortStatus}`).slice(0, 20).join('');
      const displayText = `加入購物車：${item.colorZh || colorJp} ${item.size}`;
      const imgUrl = colorImages[colorJp] || imageUrl || '';
      const data = `action=add_to_cart&id=${productId}&c=${encodeURIComponent(colorJp)}&s=${encodeURIComponent(item.size)}&jpy=${jpy}&p=${suggested}&url=${encodeURIComponent(productUrl)}&img=${encodeURIComponent(imgUrl)}${item.isPreorder ? '&pre=1' : ''}&ts=${Math.floor(Date.now()/1000)}`;
      const btnColor = item.inStock ? '#b8895a' : item.isPreorder ? '#7a8fb5' : '#c4956a';
      return {
        type: 'button',
        height: 'sm',
        style: 'primary',
        color: btnColor,
        margin: 'xs',
        action: { type: 'postback', label: btnLabel, data, displayText },
      };
    });

    const cardImage = colorImages[colorJp] || imageUrl;

    const bubble = {
      type: 'bubble',
      size: 'mega',
      ...(cardImage ? {
        hero: {
          type: 'image',
          url: cardImage,
          size: 'full',
          aspectRatio: '3:4',
          aspectMode: 'cover',
        },
      } : {}),
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        paddingBottom: '8px',
        spacing: 'none',
        backgroundColor: '#f5ede0',
        contents: [
          { type: 'text', text: productId.toUpperCase(), size: 'xxs', color: '#b8a090' },
          ...(productName ? [{
            type: 'text',
            text: productName.substring(0, 30),
            size: 'xs',
            color: '#a08060',
            wrap: true,
            margin: 'xs',
          }] : []),
          { type: 'text', text: colorLabel, weight: 'bold', size: 'md', color: '#3d2c1e', wrap: true, margin: 'xs' },
          { type: 'text', text: `¥${jpy.toLocaleString()}　報價金額 NT$${suggested.toLocaleString()}`, size: 'xs', color: '#a08060', margin: 'xs' },
          { type: 'separator', margin: 'md', color: '#ddd0bc' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'none',
            contents: sizeRows,
          },
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
          action: { type: 'uri', label: '回官方商品頁', uri: productUrl },
        }],
      },
    };
    return bubble;
  });

  if (bubbles.length === 1) {
    return {
      type: 'flex',
      altText: '選擇尺寸加入購物車',
      contents: bubbles[0],
    };
  }

  return {
    type: 'flex',
    altText: '選擇顏色與尺寸加入購物車',
    contents: { type: 'carousel', contents: bubbles },
  };
}

// ── GRL 商品報價 Flex Message ─────────────────────────────────────────────────
function buildFlexMessage(url, productName, jpy, suggested, stockLines, imageUrl, weightInfo) {
  const stockContents = stockLines.length > 0
    ? stockLines.map((line) => ({
        type: 'text',
        text: line,
        size: 'sm',
        color: '#555555',
        wrap: true,
      }))
    : [{
        type: 'text',
        text: '（無庫存資訊）',
        size: 'sm',
        color: '#aaaaaa',
      }];

  const bubble = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#c9a98a',
      paddingAll: '14px',
      contents: [
        {
          type: 'text',
          text: '🌸 GRL 商品報價',
          color: '#ffffff',
          size: 'md',
          weight: 'bold',
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '14px',
      contents: [
        {
          type: 'text',
          text: productName,
          weight: 'bold',
          size: 'md',
          wrap: true,
          color: '#222222',
        },
        { type: 'separator' },
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: '💴 日幣',     size: 'sm', color: '#888888', flex: 2 },
            { type: 'text', text: `¥${fmtJPY(jpy)}`, size: 'sm', color: '#222222', flex: 3, align: 'end' },
          ],
        },
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: '💵 報價金額', size: 'sm', color: '#888888', flex: 2 },
            { type: 'text', text: `NT$${suggested}`, size: 'sm', weight: 'bold', color: '#E53935', flex: 3, align: 'end' },
          ],
        },
        { type: 'separator' },
        { type: 'text', text: '📦 庫存', size: 'sm', weight: 'bold', color: '#444444' },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          contents: stockContents,
        },
        ...(weightInfo ? [
          { type: 'separator' },
          { type: 'text', text: '⚖️ 估算重量', size: 'sm', weight: 'bold', color: '#444444' },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '磅 (lbs)', size: 'sm', color: '#888888', flex: 3 },
              { type: 'text', text: `${weightInfo.midLbs} lbs`, size: 'sm', color: '#222222', flex: 4, align: 'end' },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '公斤 (kg)', size: 'sm', color: '#888888', flex: 3 },
              { type: 'text', text: `${weightInfo.midKg} kg`, size: 'sm', color: '#222222', flex: 4, align: 'end' },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '信心程度', size: 'sm', color: '#888888', flex: 3 },
              {
                type: 'text',
                text: weightInfo.confidenceLabel === '高' ? '🟢 高' : weightInfo.confidenceLabel === '中' ? '🟡 中' : '🔴 低',
                size: 'sm', color: '#222222', flex: 4, align: 'end',
              },
            ],
          },
          {
            type: 'text',
            text: weightInfo.detail,
            size: 'xxs',
            color: '#aaaaaa',
            wrap: true,
          },
        ] : []),
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '10px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#c9a98a',
          height: 'sm',
          action: {
            type: 'uri',
            label: '查看商品頁面',
            uri: url,
          },
        },
      ],
    },
  };

  if (imageUrl) {
    bubble.hero = {
      type: 'image',
      url: imageUrl,
      size: 'full',
      aspectRatio: '1:1',
      aspectMode: 'cover',
    };
  }

  return {
    type: 'flex',
    altText: `GRL 商品報價｜${productName}`,
    contents: bubble,
  };
}

// ── 加入好友歡迎 Flex ─────────────────────────────────────────────────────────
function buildWelcomeFlexMessage() {
  return {
    type: 'flex',
    altText: '歡迎加入 Bijin 日本正品代購！完成註冊即可獲得 NT$50 入會禮',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#F7E5D8', paddingAll: '16px',
        contents: [
          { type: 'text', text: '歡迎加入', size: 'sm', color: '#a07850' },
          { type: 'text', text: 'Bijin 日本正品代購', size: 'xl', weight: 'bold', color: '#7a5c3e' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
        contents: [
          { type: 'text', text: '提供 GRL・ZOZO 等日本品牌代購服務，讓您輕鬆購入日本正品。', wrap: true, size: 'sm', color: '#666666' },
          { type: 'separator', margin: 'lg' },
          {
            type: 'box', layout: 'vertical', margin: 'lg', paddingAll: '14px',
            backgroundColor: '#FFF8F0', spacing: 'sm',
            contents: [
              { type: 'text', text: '🎁 新會員入會禮', weight: 'bold', size: 'sm', color: '#c9a98a' },
              { type: 'text', text: 'NT$50 購物金 × 1 張', weight: 'bold', size: 'lg', color: '#222222', margin: 'sm' },
              { type: 'text', text: '有效期限：完成註冊後 2 個月', size: 'xs', color: '#aaaaaa' },
              { type: 'text', text: '完成會員中心註冊即自動發放', size: 'xs', color: '#aaaaaa', wrap: true },
            ],
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px',
        contents: [
          {
            type: 'button', style: 'primary', color: '#c9a98a', height: 'sm',
            action: { type: 'uri', label: '前往會員中心完成註冊', uri: `https://liff.line.me/${MEMBER_LIFF_ID}` },
          },
        ],
      },
    },
  };
}

module.exports = {
  buildHistoryFlexMessage,
  buildTutorialFlexMessage,
  buildAddToCartFlex,
  buildFlexMessage,
  buildWelcomeFlexMessage,
};
