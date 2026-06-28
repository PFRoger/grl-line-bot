'use strict';

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use('/public', express.static(require('path').join(__dirname, 'public')));

const {
  line,
  ADMIN_KEY, ZOZO_QUEUE_KEY,
  ADMIN_USER_ID, SHEET_ID, LIFF_ID, MEMBER_LIFF_ID,
  CART_SHEET, ORDER_SHEET, ZOZO_SHEET, SETTINGS_SHEET, BOT_LOG_SHEET,
  MEMBER_SHEET, POINTS_SHEET, COUPON_SHEET, REFERRAL_SHEET, FOLLOW_SHEET,
  lineClient, getSheetsClient,
} = require('./lib/config');

const { COLOR_MAP_OBJ, COLOR_KEYS, hasColorKeyword, translateColorWithJp } = require('./lib/colors');

const { JP_SHIPPING_GRL, JP_SHIPPING_ZOZO, FEE_RATE, SHIPPING_PER_LB, PACKAGING_COST, TRANSFER_FEE, PROFIT, calcSuggestedPrice, fmtJPY, fetchRate } = require('./lib/pricing');
const { estimateWeight } = require('./lib/weight');
const { translateArrival, extractProductId, parseStockFromHtml, calcQStatus, scrapeGRL } = require('./lib/grl');

const {
  getTodayTW, checkAndSetBotReply, getZOZOEnabled, getGasNotifyEnabled,
  addZOZOTask, lookupProductKWeight, appendProductToSheet, logQueryToSheet,
  CART_HEADERS, ensureCartSheet, ensureOrderSheet,
  addToCartSheet, getCartItems, clearCartItem, markCartItemsOrdered,
  submitOrder, getUserQueryHistory,
} = require('./lib/sheets');

const {
  buildHistoryFlexMessage, buildTutorialFlexMessage, buildAddToCartFlex,
  buildFlexMessage, buildWelcomeFlexMessage,
} = require('./lib/flex');

const { ZOZO_COLOR_MAP, ZOZO_SIZE_ABBR, zozoColorLabel, zozoSizeName, buildZOZOFlexMessage } = require('./lib/zozo');

const {
  BIRTHDAY_GIFTS,
  todayStr, calcTier,
  ensureMemberSheet, ensurePointsSheet, ensureCouponSheet, ensureFollowSheet, ensureReferralSheet,
  recordFollowEvent,
  getMember, createMember, getOrCreateMember, resetMemberYear, updateMemberFields,
  issueCoupons, getActiveCoupons, markCouponUsed,
  getActivePoints, deductMemberPoints,
  processOrderCompletion, processOrderReturn, processReferralReward, bindReferralCode,
  logDiscountAnomaly,
} = require('./lib/member');

// ── 建立 ZOZO Flex Message ────────────────────────────────────────────────────
// ── Rich Menu 設定 ────────────────────────────────────────────────────────────
async function setupRichMenu(imageUrl) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // 1. 建立 Rich Menu 定義
  const def = {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: 'Bijin主選單',
    chatBarText: '主選單',
    areas: [
      { bounds: { x: 0,    y: 0,   width: 833, height: 843 }, action: { type: 'postback', label: '查詢紀錄', data: 'action=query_history', displayText: '查詢紀錄' } },
      { bounds: { x: 833,  y: 0,   width: 833, height: 843 }, action: { type: 'postback', label: '開始購物', data: 'action=start_shopping', displayText: '開始購物' } },
      { bounds: { x: 1666, y: 0,   width: 834, height: 843 }, action: { type: 'uri',      label: '購物車',   uri: `https://liff.line.me/${LIFF_ID}` } },
      { bounds: { x: 0,    y: 843, width: 833, height: 843 }, action: { type: 'uri',      label: '購物指南', uri: 'https://pfroger-linebot-2.vercel.app/guide' } },
      { bounds: { x: 833,  y: 843, width: 833, height: 843 }, action: { type: 'uri',      label: 'IG連結',   uri: 'https://www.instagram.com/bijin.jp.2024?igsh=MXZxY2wzc2tsdWxzeQ%3D%3D&utm_source=qr' } },
      { bounds: { x: 1666, y: 843, width: 834, height: 843 }, action: { type: 'uri',      label: '會員中心', uri: `https://liff.line.me/${MEMBER_LIFF_ID}` } },
    ],
  };

  const createRes = await axios.post('https://api.line.me/v2/bot/richmenu', def, { headers });
  const richMenuId = createRes.data.richMenuId;
  return richMenuId;
}

// ── 處理 Rich Menu Postback 事件 ──────────────────────────────────────────────
async function handlePostback(event, client) {
  const userId     = event.source.userId;
  const replyToken = event.replyToken;
  const params     = new URLSearchParams(event.postback.data);
  const action     = params.get('action');

  if (action === 'query_history') {
    let history = [];
    try { history = await getUserQueryHistory(userId); } catch (e) { console.error('[history error]', e.message); }
    await client.replyMessage(replyToken, buildHistoryFlexMessage(history));

  } else if (action === 'tutorial') {
    await client.replyMessage(replyToken, buildTutorialFlexMessage());

  } else if (action === 'cart') {
    await client.replyMessage(replyToken, {
      type: 'text',
      text: `🛒 前往購物車結帳：\nhttps://liff.line.me/${LIFF_ID}`,
    });

  } else if (action === 'member') {
    await client.replyMessage(replyToken, {
      type: 'text',
      text: `👤 會員中心\n\n請點選連結查看您的點數、優惠券與邀請碼：\nhttps://liff.line.me/${MEMBER_LIFF_ID}`,
    });

  } else if (action === 'out_of_stock') {
    const size = params.get('s') || '';
    await client.replyMessage(replyToken, {
      type: 'text',
      text: `😔 ${size} 目前缺貨，請選擇其他尺寸。`,
    });

  } else if (action === 'add_to_cart') {
    const ts = parseInt(params.get('ts')) || 0;
    if (!ts || (Math.floor(Date.now()/1000) - ts) > 6 * 3600) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '⚠️ 此報價已超過 6 小時，價格可能有變動。\n\n請重新傳送商品網址取得最新報價，再加入購物車 😊',
      });
      return;
    }
    const productId    = params.get('id') || '';
    const colorJp      = params.get('c') || '';
    const size         = params.get('s') || '';
    const jpy          = parseInt(params.get('jpy')) || 0;
    const suggested    = parseInt(params.get('p')) || 0;
    const productUrl   = params.get('url') || `https://www.grail.bz/item/${productId}/`;
    const imgUrl       = params.get('img') || '';
    const isPreorder   = params.get('pre') === '1';

    // 從查詢紀錄找商品名稱
    let productName = productId;
    try {
      const sheets = getSheetsClient();
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: '查詢紀錄!A:E' });
      const rows = (resp.data.values || []).reverse();
      const found = rows.find(r => r[3] === productId);
      if (found) productName = found[4] || productId;
    } catch (e) { console.warn('[lookup name error]', e.message); }

    let lineDisplayName = '';
    try { const p = await client.getProfile(userId); lineDisplayName = p.displayName || ''; } catch(e) {}
    await addToCartSheet(userId, lineDisplayName, productId, productName, colorJp, size, jpy, suggested, productUrl, imgUrl, isPreorder);
    const colorDisplay = translateColorWithJp(colorJp);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: `✅ 已加入購物車\n商品：${isPreorder ? '【預購】' : ''}${productName || productId}\n貨號：${productId.toUpperCase()}\n\n顏色：${colorDisplay}\n尺寸：${size}\n\n售價：NT$${suggested}\n\n請按下方主選單「購物車」查看內容\n════════════\n購物車每 6 小時自動清空`,
    });

  } else if (action === 'add_to_cart_zozo') {
    const ts = parseInt(params.get('ts')) || 0;
    if (!ts || (Math.floor(Date.now()/1000) - ts) > 6 * 3600) {
      await client.replyMessage(replyToken, {
        type: 'text',
        text: '⚠️ 此報價已超過 6 小時，價格可能有變動。\n\n請重新傳送商品網址取得最新報價，再加入購物車 😊',
      });
      return;
    }
    const goodsId    = params.get('gid') || '';
    const colorId    = params.get('cid') || '';
    const colorJp    = params.get('cn') || '';
    const size       = params.get('sz') || '';
    const jpy        = parseInt(params.get('jpy')) || 0;
    const suggested  = parseInt(params.get('p')) || 0;
    const imgUrl     = params.get('img') || '';
    const productUrl = `https://zozo.jp/goods/${goodsId}/`;

    let productName = goodsId;
    try {
      const sheets = getSheetsClient();
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: '查詢紀錄!A:E' });
      const rows = (resp.data.values || []).reverse();
      const found = rows.find(r => r[3] === goodsId);
      if (found) productName = found[4] || goodsId;
    } catch (e) { console.warn('[zozo cart lookup name]', e.message); }

    let lineDisplayName = '';
    try { const p = await client.getProfile(userId); lineDisplayName = p.displayName || ''; } catch(e) {}
    await addToCartSheet(userId, lineDisplayName, goodsId, productName, colorJp, size, jpy, suggested, productUrl, imgUrl, false);
    const colorDisplay = zozoColorLabel(colorJp);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: `✅ 已加入購物車\n商品：${productName}\n\n顏色：${colorDisplay}\n尺寸：${size}\n\n售價：NT$${suggested}\n\n請按下方主選單「購物車」查看內容\n════════════\n購物車每 6 小時自動清空`,
    });

  } else if (action === 'start_shopping') {
    await client.replyMessage(replyToken, {
      type: 'flex',
      altText: '選擇購物平台：GRL 或 ZOZO',
      contents: {
        type: 'carousel',
        contents: [
          // ── 說明卡 ──
          {
            type: 'bubble', size: 'kilo',
            hero: {
              type: 'image',
              url: 'https://raw.githubusercontent.com/PFRoger/grl-line-bot/main/assets/how-to-quote-v7.jpg',
              size: 'full', aspectRatio: '3:4', aspectMode: 'cover',
            },
            body: {
              type: 'box', layout: 'vertical', paddingAll: '0px', backgroundColor: '#F7E5D8',
              contents: [{ type: 'filler' }],
            },
          },
          // ── GRL 卡 ──
          {
            type: 'bubble', size: 'kilo',
            hero: {
              type: 'image',
              url: 'https://raw.githubusercontent.com/PFRoger/grl-line-bot/main/assets/GRL.png',
              size: 'full', aspectRatio: '4:3', aspectMode: 'cover',
            },
            body: {
              type: 'box', layout: 'vertical', paddingAll: '14px',
              contents: [
                { type: 'text', text: '日本超人氣平價女裝\n每週上新・平價高質感\n傳入網址或貨號即可報價',
                  size: 'xs', color: '#666666', wrap: true, align: 'center' },
              ],
            },
            footer: {
              type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: '#ffffff',
              contents: [{ type: 'button', style: 'primary', color: '#c9a98a', height: 'sm',
                action: { type: 'uri', label: '前往 GRL 網站逛逛', uri: 'https://www.grail.bz' } }],
            },
          },
          // ── ZOZO 卡 ──
          {
            type: 'bubble', size: 'kilo',
            hero: {
              type: 'image',
              url: 'https://raw.githubusercontent.com/PFRoger/grl-line-bot/main/assets/ZOZO.png',
              size: 'full', aspectRatio: '4:3', aspectMode: 'cover',
            },
            body: {
              type: 'box', layout: 'vertical', paddingAll: '14px',
              contents: [
                { type: 'text', text: '日本最大時尚購物平台\n集結數百品牌・款式多元\n傳入商品網址即可報價',
                  size: 'xs', color: '#666666', wrap: true, align: 'center' },
              ],
            },
            footer: {
              type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: '#ffffff',
              contents: [{ type: 'button', style: 'primary', color: '#c9a98a', height: 'sm',
                action: { type: 'uri', label: '前往 ZOZO 網站逛逛', uri: 'https://zozo.jp' } }],
            },
          },
        ],
      },
    });

  } else if (action === 'view_cart') {
    await client.replyMessage(replyToken, {
      type: 'text',
      text: `🛒 前往購物車結帳：\nhttps://liff.line.me/${LIFF_ID}`,
    });

  } else if (action === 'zozo_check') {
    const taskId = params.get('taskId');
    if (!taskId) return;
    try {
      const sheets = getSheetsClient();
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ZOZO_SHEET}!A:G` });
      const rows = res.data.values || [];
      const rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === taskId);
      if (rowIdx < 0) {
        await client.replyMessage(replyToken, { type: 'text', text: '查詢紀錄已不存在，請重新傳送商品網址 🙏' });
        return;
      }
      const row = rows[rowIdx];
      const status    = row[3] || '';
      const resultStr = row[4] || '';
      const url       = row[2] || '';
      const createdAt = new Date(row[5] || 0).getTime();
      const ageMs     = Date.now() - createdAt;

      if (status === 'done' && resultStr) {
        let result;
        try { result = JSON.parse(resultStr); } catch (_) {
          await client.replyMessage(replyToken, { type: 'text', text: 'ZOZO 商品資料讀取異常，請重新傳送網址 🙏' });
          return;
        }
        let rate = null;
        try { rate = await fetchRate(); } catch (_) {}
        let msg;
        try { msg = buildZOZOFlexMessage(result, url, rate); } catch (e) {
          console.error('[zozo_check buildFlex]', e.message);
          await client.replyMessage(replyToken, { type: 'text', text: 'ZOZO 報價卡片建立失敗，請重新傳送網址 🙏' });
          return;
        }
        await client.replyMessage(replyToken, msg);
      } else if (status === 'error') {
        await client.replyMessage(replyToken, { type: 'text', text: 'ZOZO 商品查詢失敗，請重新傳送網址，或聯絡我們人工報價 🙏' });
      } else if (ageMs > 2 * 60 * 1000) {
        // 超過 2 分鐘仍未完成 → Extension 可能當機或未啟動
        await client.replyMessage(replyToken, { type: 'text', text: 'ZOZO 解析好像遇到了一點小狀況 🥺\n\n請重新傳送商品網址再試一次，或稍後再查詢。如持續有問題請聯絡我們 🌸' });
      } else {
        // pending / processing，仍在解析中
        await client.replyMessage(replyToken, { type: 'text', text: '報價還在努力生成中 🐢💨\n\n通常需要 30～60 秒，請再稍候片刻後點擊「查看報價」，感謝您的耐心等待 🌸' });
      }
    } catch (err) {
      console.error('[zozo_check error]', err.message);
      await client.replyMessage(replyToken, { type: 'text', text: 'ZOZO 查詢暫時無法使用，請稍後再試。' });
    }
  }
}

// ── LIFF 購物車 HTML ──────────────────────────────────────────────────────────
function buildCartHtml() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Bijin 購物車</title>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#faf8f6;color:#333;padding-bottom:40px}
.header{background:#c9a98a;color:#fff;padding:16px;text-align:center;font-size:18px;font-weight:bold;letter-spacing:1px}
.section{background:#fff;margin:12px;border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.section-title{font-size:15px;font-weight:bold;color:#7a5c3e;margin-bottom:12px;border-bottom:1px solid #f0e8de;padding-bottom:8px}
.cart-item{border:1px solid #eee;border-radius:8px;padding:12px;margin-bottom:10px;display:flex;gap:10px;position:relative}
.item-img{width:64px;height:85px;object-fit:cover;border-radius:6px;background:#f5f0ec;flex-shrink:0}
.item-info{flex:1;min-width:0}
.item-name{font-size:13px;color:#888;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item-detail{font-size:14px;font-weight:600;color:#333}
.item-price{font-size:14px;font-weight:bold;color:#c9a98a;margin-top:4px}
.qty-ctrl{display:flex;align-items:center;gap:10px;margin-top:8px}
.qty-btn{width:30px;height:30px;border:1px solid #c9a98a;border-radius:6px;background:#fff;color:#c9a98a;font-size:20px;font-weight:bold;cursor:pointer;line-height:1;padding:0}
.qty-btn:active{background:#f5ede4}
.qty-num{font-size:16px;font-weight:bold;color:#333;min-width:20px;text-align:center}
.empty{text-align:center;color:#aaa;padding:30px 0;font-size:14px}
.total-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:14px}
.total-amount{font-size:18px;font-weight:bold;color:#c9a98a}
label{display:block;font-size:13px;color:#888;margin-bottom:4px;margin-top:12px}
input,select,textarea{width:100%;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;outline:none}
input[type="radio"]{width:auto;border:none;padding:0;margin:0;border-radius:0;box-shadow:none}
input:focus,select:focus,textarea:focus{border-color:#c9a98a}
.hist-wrap{position:relative}
.hist-drop{position:absolute;left:0;right:0;top:calc(100% + 2px);background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.12);z-index:999;overflow:hidden}
.hist-item{padding:10px 12px;font-size:14px;color:#333;cursor:pointer;border-bottom:1px solid #f5f5f5}
.hist-item:last-child{border-bottom:none}
.hist-item:active{background:#fff8f0}
.radio-group{display:flex;flex-direction:row;gap:16px;margin-top:6px;margin-bottom:8px}
.radio-item{display:flex;align-items:center;gap:6px;font-size:14px;color:#333;font-weight:normal;margin:0;cursor:pointer}
.submit-btn{width:100%;background:#c9a98a;color:#fff;border:none;border-radius:10px;padding:14px;font-size:16px;font-weight:bold;cursor:pointer;margin-top:16px;letter-spacing:1px}
.submit-btn:disabled{background:#ccc}
.submit-btn:active{background:#b8906e}
.note-box{background:#fff8f0;border-radius:8px;padding:10px;font-size:12px;color:#888;margin-top:8px;line-height:1.6}
.item-jpy{font-size:12px;color:#aaa;margin-top:2px}
#loading{text-align:center;padding:40px;color:#aaa}
#success{display:none;text-align:center;padding:30px}
#confirm-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:999;align-items:center;justify-content:center}
#confirm-box{background:#fff;border-radius:14px;padding:24px 20px;margin:24px;text-align:center;max-width:280px;width:100%}
#confirm-msg{font-size:15px;color:#333;margin-bottom:20px;line-height:1.5}
.confirm-btns{display:flex;gap:12px}
.confirm-btn-cancel{flex:1;padding:12px;border:1px solid #ddd;border-radius:8px;background:#fff;font-size:15px;color:#666;cursor:pointer}
.confirm-btn-ok{flex:1;padding:12px;border:none;border-radius:8px;background:#c9a98a;color:#fff;font-size:15px;font-weight:bold;cursor:pointer}
.success-icon{font-size:48px;margin-bottom:12px}
.success-title{font-size:18px;font-weight:bold;color:#c9a98a;margin-bottom:8px}
.success-text{font-size:13px;color:#888;line-height:1.6}
#alert-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:1000;align-items:center;justify-content:center}
#alert-box{background:#fff;border-radius:14px;padding:24px 20px;margin:24px;text-align:center;max-width:280px;width:100%}
#alert-msg{font-size:15px;color:#333;margin-bottom:20px;line-height:1.5}
.alert-btn-ok{width:100%;padding:12px;border:none;border-radius:8px;background:#c9a98a;color:#fff;font-size:15px;font-weight:bold;cursor:pointer}
.summary-row{display:flex;justify-content:space-between;font-size:13px;color:#888;padding:3px 0}
.summary-save{color:#e07070}
.final-row{display:flex;justify-content:space-between;align-items:center;padding-top:8px;border-top:1px solid #f0e8de;margin-top:6px}
.final-label{font-size:15px;font-weight:bold;color:#333}
.final-price{font-size:20px;font-weight:bold;color:#c9a98a}
.disc-box{background:#fff9f5;border:1px solid #f0ddd0;border-radius:10px;padding:12px;margin-top:10px}
.disc-label{font-size:13px;font-weight:bold;color:#9a6a50;margin-bottom:8px}
.pts-row{display:flex;align-items:center;gap:6px;font-size:13px;color:#666;flex-wrap:wrap}
.pts-row input[type=number]{width:72px;padding:6px 8px;text-align:center;font-size:14px;border:1px solid #ddd;border-radius:6px;-moz-appearance:textfield}
.pts-row input[type=number]::-webkit-inner-spin-button,.pts-row input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none}
.cpn-item{display:flex;align-items:center;gap:8px;padding:9px 10px;border:1px solid #eee;border-radius:8px;cursor:pointer;margin-top:6px;font-size:13px}
.cpn-item.selected{border-color:#c9a98a;background:#fff5ee}
.cpn-tag{background:#c9a98a;color:#fff;font-size:11px;font-weight:bold;padding:2px 7px;border-radius:4px;white-space:nowrap}
</style>
</head>
<body>
<div class="header">🛒 Bijin 購物車</div>
<div id="loading">載入中...</div>
<div id="main" style="display:none">
  <div class="section">
    <div class="section-title">商品資訊</div>
    <div id="cart-items"></div>
    <div id="cart-empty" class="empty" style="display:none">購物車是空的<br><small>請先查詢商品並加入購物車</small></div>
  </div>
  <div id="order-section" class="section" style="display:none">
    <div class="section-title">訂單資訊</div>
    <div class="summary-row"><span>商品小計</span><span id="subtotal-amount">NT$0</span></div>
    <div id="pts-disc-row" class="summary-row" style="display:none"><span>點數折抵</span><span class="summary-save" id="pts-disc-val">-NT$0</span></div>
    <div id="cpn-disc-row" class="summary-row" style="display:none"><span>優惠券折抵</span><span class="summary-save" id="cpn-disc-val">-NT$0</span></div>
    <div class="final-row"><span class="final-label">實付金額</span><span class="final-price" id="total-amount">NT$0</span></div>
    <div class="note-box" style="margin-top:8px">送出後，我們將盡快提供賣貨便下單連結</div>

    <div id="discount-section" style="display:none">
      <div class="disc-box">
        <div class="disc-label">🪙 點數折抵</div>
        <div style="font-size:12px;color:#aaa;margin-bottom:8px">可用 <strong id="avail-pts" style="color:#c9a98a">0</strong> 點（1點折抵 NT$1）</div>
        <div class="pts-row">使用 <input type="number" id="pts-input" placeholder="0" min="0" max="0" step="1" oninput="onPtsChange()"> 點 <button onclick="useAllPts()" style="margin-left:8px;padding:4px 10px;background:#c9a98a;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer">全部折抵</button></div>
      </div>
      <div class="disc-box" style="margin-top:8px">
        <div class="disc-label">🎟 優惠券</div>
        <div id="cpn-list"></div>
      </div>
    </div>
  </div>
  <div id="buyer-section" class="section" style="display:none">
    <div class="section-title">訂貨人資訊</div>
    <label>姓名 *</label>
    <div class="hist-wrap"><input id="f-name" type="text" placeholder="請輸入真實姓名" autocomplete="off" onfocus="showHist(this,'name')" onblur="hideHist()"></div>
    <label>手機號碼 *</label>
    <div class="hist-wrap"><input id="f-phone" type="tel" placeholder="09xxxxxxxx" autocomplete="off" onfocus="showHist(this,'phone')" onblur="hideHist()"></div>
    <label>聯繫方式 *</label>
    <div class="radio-group" style="margin-bottom:6px">
      <label class="radio-item"><input type="radio" name="contact-method" value="IG"> IG</label>
      <label class="radio-item"><input type="radio" name="contact-method" value="LINE"> LINE</label>
    </div>
    <div class="hist-wrap"><input id="f-contact-account" type="text" placeholder="請輸入帳號" autocomplete="off" onfocus="showHist(this,'contactAccount')" onblur="hideHist()"></div>
    <label>備註（選填）</label>
    <div class="hist-wrap"><textarea id="f-note" rows="2" placeholder="特殊需求或備註" autocomplete="off" onfocus="showHist(this,'note')" onblur="hideHist()"></textarea></div>
    <p style="font-size:11px;color:#aaa;text-align:center;margin:14px 0 4px;line-height:1.6">購物車內報價為查詢當時的台幣報價金額，<br>實際金額依下單時 GRL 官網現價為主。</p>
    <button class="submit-btn" id="submit-btn" onclick="submitOrder()">訂單送出</button>
  </div>
</div>
<div id="success">
  <div class="success-icon">🎉</div>
  <div class="success-title">下單成功！</div>
  <div class="success-text" id="success-text"></div>
</div>
<div id="confirm-overlay" style="display:none">
  <div id="confirm-box">
    <div id="confirm-msg"></div>
    <div class="confirm-btns">
      <button class="confirm-btn-cancel" onclick="onConfirmBtn(false)">取消</button>
      <button class="confirm-btn-ok" onclick="onConfirmBtn(true)">確定</button>
    </div>
  </div>
</div>
<div id="alert-overlay" style="display:none">
  <div id="alert-box">
    <div id="alert-msg"></div>
    <button class="alert-btn-ok" onclick="closeAlert()">確定</button>
  </div>
</div>
<script>
let userId = '';
let displayName = '';
let cartItems = [];
let groupedItems = [];
const imageCache = {}; // key: productId|color → imageUrl
let _confirmCb = null;
let memberPoints = 0;
let activeCoupons = [];
let selectedCouponCode = '';
let isMember = false;
let subtotal = 0;
// ── 欄位歷史記錄（autocomplete）──
function getHist(key) {
  try { return JSON.parse(localStorage.getItem('bijin_h_' + key) || '[]'); } catch(e) { return []; }
}
function saveHist(key, val) {
  if (!val) return;
  let arr = getHist(key).filter(x => x !== val);
  arr.unshift(val);
  arr = arr.slice(0, 3);
  localStorage.setItem('bijin_h_' + key, JSON.stringify(arr));
}
let _hideHistTimer = null;
function showHist(input, key) {
  clearTimeout(_hideHistTimer);
  // remove any existing dropdown
  const old = input.parentNode.querySelector('.hist-drop');
  if (old) old.remove();
  const arr = getHist(key);
  if (!arr.length) return;
  const drop = document.createElement('div');
  drop.className = 'hist-drop';
  arr.forEach(v => {
    const item = document.createElement('div');
    item.className = 'hist-item';
    item.textContent = v;
    item.addEventListener('mousedown', e => {
      e.preventDefault(); // prevent blur before click
      input.value = v;
      drop.remove();
    });
    drop.appendChild(item);
  });
  input.parentNode.appendChild(drop);
}
function hideHist() {
  _hideHistTimer = setTimeout(() => {
    document.querySelectorAll('.hist-drop').forEach(d => d.remove());
  }, 150);
}
function showAlert(msg) {
  document.getElementById('alert-msg').innerHTML = msg;
  document.getElementById('alert-overlay').style.display = 'flex';
}
function closeAlert() {
  document.getElementById('alert-overlay').style.display = 'none';
}
function showConfirm(group) {
  return new Promise(resolve => {
    _confirmCb = resolve;
    const imgKey = group.productId + '|' + group.color;
    const imgUrl = imageCache[imgKey] || group.imageUrl || '';
    document.getElementById('confirm-msg').innerHTML =
      (imgUrl ? \`<img src="\${imgUrl}" style="width:72px;height:96px;object-fit:cover;border-radius:8px;margin-bottom:10px"><br>\` : '') +
      \`<strong style="font-size:14px;color:#333">\${group.productName ? group.productName.substring(0,28) : group.productId}</strong><br>\` +
      \`<span style="font-size:13px;color:#888">\${group.colorDisplay || group.color}　\${group.size}</span><br><br>\` +
      \`<span style="font-size:14px;color:#555">確定要移除此商品嗎？</span>\`;
    document.getElementById('confirm-overlay').style.display = 'flex';
  });
}
function onConfirmBtn(result) {
  document.getElementById('confirm-overlay').style.display = 'none';
  if (_confirmCb) { _confirmCb(result); _confirmCb = null; }
}

async function init() {
  try {
    await liff.init({ liffId: '${LIFF_ID}' });
    if (!liff.isLoggedIn()) { liff.login(); return; }
    const profile = await liff.getProfile();
    userId = profile.userId;
    displayName = profile.displayName || '';
    const [cartData, memberData] = await Promise.all([
      fetch('/api/cart?userId=' + userId).then(r => r.json()).catch(() => ({ items: [] })),
      fetch('/api/member?userId=' + userId).then(r => r.json()).catch(() => ({ ok: false })),
    ]);
    cartItems = cartData.items || [];
    if (memberData.ok && memberData.registered) {
      isMember = true;
      memberPoints = memberData.member.points || 0;
      activeCoupons = memberData.coupons || [];
    }
    render();
  } catch(e) {
    document.getElementById('loading').textContent = '載入失敗，請重新開啟';
  }
}

async function loadCart() {
  const resp = await fetch('/api/cart?userId=' + userId);
  const data = await resp.json();
  cartItems = data.items || [];
  render();
}

function groupCartItems(items) {
  const groups = {};
  const order = [];
  items.forEach(item => {
    const key = item.productId + '|' + item.color + '|' + item.size;
    if (!groups[key]) {
      groups[key] = Object.assign({}, item, { quantity: 0, rowIndexes: [] });
      order.push(key);
    }
    groups[key].quantity++;
    groups[key].rowIndexes.push(item.rowIndex);
  });
  return order.map(k => groups[k]);
}

function render() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('main').style.display = 'block';
  const el = document.getElementById('cart-items');
  el.innerHTML = '';
  groupedItems = groupCartItems(cartItems);
  if (groupedItems.length === 0) {
    document.getElementById('cart-empty').style.display = 'block';
    document.getElementById('order-section').style.display = 'none';
    document.getElementById('buyer-section').style.display = 'none';
    return;
  }
  document.getElementById('cart-empty').style.display = 'none';
  document.getElementById('order-section').style.display = 'block';
  document.getElementById('buyer-section').style.display = 'block';
  let total = 0;
  groupedItems.forEach((group, idx) => {
    const subtotal = (group.suggestedPrice || 0) * group.quantity;
    total += subtotal;
    const priceText = group.quantity > 1
      ? \`NT$\${group.suggestedPrice} × \${group.quantity} = NT$\${subtotal}\`
      : \`NT$\${group.suggestedPrice}\`;
    el.innerHTML += \`<div class="cart-item" id="item-\${idx}">
      <img class="item-img" id="img-\${idx}" src="" alt="">
      <div class="item-info">
        <div class="item-name">\${(group.productId||'').toUpperCase()}　\${group.productName ? group.productName.substring(0,20) : ''}</div>
        <div class="item-detail">\${group.colorDisplay || group.color}　\${group.size}</div>
        <div class="item-jpy">¥\${(group.jpy||0).toLocaleString()}</div>
        <div class="item-price">\${priceText}</div>
        <div class="qty-ctrl">
          <button class="qty-btn" onclick="changeQty(\${idx},-1)">−</button>
          <span class="qty-num">\${group.quantity}</span>
          <button class="qty-btn" onclick="changeQty(\${idx},+1)">＋</button>
        </div>
      </div>
    </div>\`;
  });
  subtotal = total;
  const ptsInput = document.getElementById('pts-input');
  if (ptsInput) {
    const newMax = Math.min(memberPoints, subtotal);
    ptsInput.max = newMax;
    if (parseInt(ptsInput.value) > newMax) ptsInput.value = newMax;
  }
  updateTotals();
  loadItemImages();
}

async function loadCartSilent() {
  try {
    const resp = await fetch('/api/cart?userId=' + userId);
    const data = await resp.json();
    cartItems = data.items || [];
    groupedItems = groupCartItems(cartItems); // 更新 rowIndexes，但不重繪
  } catch(e) {}
}

let syncTimer = null;
function scheduleSilentSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(loadCartSilent, 1000); // 停止按壓 1 秒後才同步
}

async function changeQty(idx, delta) {
  const group = groupedItems[idx];
  if (delta === -1) {
    if (group.quantity === 1) {
      const ok = await showConfirm(group);
      if (!ok) return;
    }
    let removeIdx = -1;
    for (let i = cartItems.length - 1; i >= 0; i--) {
      if (cartItems[i].productId === group.productId && cartItems[i].color === group.color && cartItems[i].size === group.size) {
        removeIdx = i; break;
      }
    }
    if (removeIdx === -1) return;
    const rowIndex = group.rowIndexes[group.rowIndexes.length - 1];
    cartItems.splice(removeIdx, 1);
    render();
    fetch('/api/cart/item', { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({rowIndex}) })
      .catch(() => {});
  } else {
    cartItems.push({ rowIndex: -1, productId: group.productId, productName: group.productName,
      color: group.color, colorDisplay: group.colorDisplay, size: group.size,
      jpy: group.jpy, suggestedPrice: group.suggestedPrice, productUrl: group.productUrl,
      imageUrl: group.imageUrl, isPreorder: group.isPreorder || false, addedAt: new Date().toISOString() });
    render();
    fetch('/api/cart/add', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ userId, displayName, productId: group.productId, productName: group.productName,
        color: group.color, size: group.size, jpy: group.jpy,
        suggestedPrice: group.suggestedPrice, productUrl: group.productUrl, imageUrl: group.imageUrl }) })
      .catch(() => {});
  }
  scheduleSilentSync(); // 每次按壓後重置計時器，停止後才同步一次
}

async function loadItemImages() {
  // 先把 sheet 中已存的 imageUrl 填入 cache
  groupedItems.forEach((item) => {
    const key = item.productId + '|' + item.color;
    if (!imageCache[key] && item.imageUrl) imageCache[key] = item.imageUrl;
  });
  // 套用 cache（含剛填入的）
  groupedItems.forEach((item, idx) => {
    const key = item.productId + '|' + item.color;
    if (imageCache[key]) {
      const imgEl = document.getElementById('img-' + idx);
      if (imgEl) imgEl.src = imageCache[key];
    }
  });
  // 只有 cache 沒有的才呼叫 API（舊資料沒存 imageUrl 的 fallback）
  const toFetch = {};
  groupedItems.forEach((item) => {
    const key = item.productId + '|' + item.color;
    if (!imageCache[key] && !toFetch[key]) {
      toFetch[key] = item.productUrl
        ? '/api/item-image?url=' + encodeURIComponent(item.productUrl) + '&c=' + encodeURIComponent(item.color)
        : '/api/item-image?id=' + encodeURIComponent(item.productId) + '&c=' + encodeURIComponent(item.color);
    }
  });
  if (Object.keys(toFetch).length === 0) return;
  await Promise.all(Object.entries(toFetch).map(async ([key, apiUrl]) => {
    try {
      const resp = await fetch(apiUrl);
      const data = await resp.json();
      imageCache[key] = data.imageUrl || '';
    } catch(e) { imageCache[key] = ''; }
  }));
  groupedItems.forEach((item, idx) => {
    const key = item.productId + '|' + item.color;
    if (imageCache[key]) {
      const imgEl = document.getElementById('img-' + idx);
      if (imgEl) imgEl.src = imageCache[key];
    }
  });
}

function updateTotals() {
  const ptsUsed = parseInt(document.getElementById('pts-input')?.value) || 0;
  const coupon = activeCoupons.find(c => c.couponCode === selectedCouponCode);
  const couponAmt = coupon ? (coupon.amount || 0) : 0;
  const finalAmt = Math.max(subtotal - ptsUsed - couponAmt, 0);

  document.getElementById('subtotal-amount').textContent = 'NT$' + subtotal;
  if (ptsUsed > 0) {
    document.getElementById('pts-disc-row').style.display = 'flex';
    document.getElementById('pts-disc-val').textContent = '-NT$' + ptsUsed;
  } else {
    document.getElementById('pts-disc-row').style.display = 'none';
  }
  if (couponAmt > 0) {
    document.getElementById('cpn-disc-row').style.display = 'flex';
    document.getElementById('cpn-disc-val').textContent = '-NT$' + couponAmt;
  } else {
    document.getElementById('cpn-disc-row').style.display = 'none';
  }
  document.getElementById('total-amount').textContent = 'NT$' + finalAmt;

  // show/hide discount section
  const discSection = document.getElementById('discount-section');
  if (discSection) {
    if (subtotal > 0) {
      discSection.style.display = 'block';
      document.getElementById('avail-pts').textContent = memberPoints - ptsUsed;
      const ptsInput = document.getElementById('pts-input');
      ptsInput.max = Math.min(memberPoints, subtotal);
      // render coupon list
      const cpnList = document.getElementById('cpn-list');
      if (activeCoupons.length === 0) {
        cpnList.innerHTML = '<div style="font-size:13px;color:#bbb;padding:4px 0">目前無可用優惠券</div>';
      } else {
        cpnList.innerHTML = '';
        activeCoupons.forEach(c => {
          const el = document.createElement('div');
          el.className = 'cpn-item' + (selectedCouponCode === c.couponCode ? ' selected' : '');
          el.innerHTML = \`<span class="cpn-tag">折扣</span><span style="flex:1;color:#333">NT\$\${c.amount}\${c.type ? '　' + c.type : ' 折扣券'}</span><span style="font-size:11px;color:#aaa">到期：\${c.expiryDate}</span>\`;
          el.onclick = () => { selectedCouponCode = (selectedCouponCode === c.couponCode ? '' : c.couponCode); updateTotals(); };
          cpnList.appendChild(el);
        });
      }
    } else {
      discSection.style.display = 'none';
    }
  }
}

function onPtsChange() {
  const input = document.getElementById('pts-input');
  let val = parseInt(input.value) || 0;
  val = Math.max(0, Math.min(val, memberPoints, subtotal));
  input.value = val;
  updateTotals();
}

function useAllPts() {
  const input = document.getElementById('pts-input');
  const max = Math.min(memberPoints, subtotal);
  input.value = max > 0 ? max : '';
  updateTotals();
}

async function submitOrder() {
  if (!isMember) {
    showAlert('請先加入會員才能下單 🌸<br><br>請點選下方主選單「會員中心」完成會員註冊後再返回下單');
    return;
  }
  const name = document.getElementById('f-name').value.trim();
  const phone = document.getElementById('f-phone').value.trim();
  const contactMethodEl = document.querySelector('input[name="contact-method"]:checked');
  const contactMethod = contactMethodEl ? contactMethodEl.value : '';
  const contactAccount = document.getElementById('f-contact-account').value.trim();
  const note = document.getElementById('f-note').value.trim();
  if (!name || !phone || !contactMethod || !contactAccount) { showAlert('請填寫所有必填欄位 (*)'); return; }
  if (!/^09\\d{8}$/.test(phone)) { showAlert('手機號碼格式不正確'); return; }
  const btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = '送出中...';
  try {
    // 儲存各欄位歷史記錄到 localStorage
    saveHist('name', name);
    saveHist('phone', phone);
    saveHist('contactAccount', contactAccount);
    saveHist('note', note);
    const ptsUsed = parseInt(document.getElementById('pts-input')?.value) || 0;
    const coupon = activeCoupons.find(c => c.couponCode === selectedCouponCode);
    const discountInfo = { pointsUsed: ptsUsed, couponCode: coupon ? coupon.couponCode : '', couponAmount: coupon ? (coupon.amount || 0) : 0 };
    const resp = await fetch('/api/order', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ userId, displayName, cartItems, buyerInfo:{ name, phone, contactMethod, contactAccount, note }, discountInfo })
    });
    const data = await resp.json();
    if (data.orderId) {
      document.getElementById('main').style.display = 'none';
      document.getElementById('success').style.display = 'block';
      document.getElementById('success-text').innerHTML =
        '訂單編號：' + data.orderId + '<br><br>我們將盡快確認您的訂單並提供賣貨便連結<br><br>如有問題請至官方 IG <span onclick="copyIG()" style="text-decoration:underline;cursor:pointer;color:#7a8fb5">bijin.jp.2024</span> 傳訊息給我們 🌸';
    } else {
      showAlert('下單失敗，請稍後再試');
      btn.disabled = false; btn.textContent = '訂單送出';
    }
  } catch(e) {
    showAlert('下單失敗，請稍後再試');
    btn.disabled = false; btn.textContent = '訂單送出';
  }
}

init();

function copyIG() {
  navigator.clipboard.writeText('bijin.jp.2024').then(() => {
    showAlert('已複製！<br><b>bijin.jp.2024</b>');
  }).catch(() => {
    showAlert('請手動複製 IG 帳號：<br><b>bijin.jp.2024</b>');
  });
}
</script>
</body>
</html>`;
}

// ── 處理加入好友事件 ──────────────────────────────────────────────────────────
async function handleFollow(event, client) {
  const userId = event.source.userId;

  // 最先送歡迎小卡（replyToken 有時效，不能等其他 async 完成）
  try {
    await client.replyMessage(event.replyToken, buildWelcomeFlexMessage());
  } catch (e) {
    console.error('[handleFollow] replyMessage error:', e.statusCode, JSON.stringify(e.originalError?.response?.data ?? null));
  }

  // 背景記錄加入紀錄（不影響訊息送出）
  try {
    const profile = await client.getProfile(userId).catch(() => null);
    const displayName = profile?.displayName || '';
    const sheets = getSheetsClient();
    await recordFollowEvent(sheets, userId, displayName);
  } catch (e) {
    console.error('[handleFollow] record error:', e.message);
  }
}

// ── 處理單一 LINE 事件 ────────────────────────────────────────────────────────
async function handleEvent(event, client) {
  if (event.type === 'follow') {
    return handleFollow(event, client);
  }
  if (event.type === 'postback') {
    return handlePostback(event, client);
  }
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const src = event.source || {};
  console.log('source:', JSON.stringify(src));

  const userId    = event.source.userId;
  const userText  = event.message.text.trim();
  const replyToken = event.replyToken;

  const isGRL = /https?:\/\/(www\.)?grail\.bz\//i.test(userText);
  const isZOZO = /https?:\/\/(?:www\.)?zozo\.jp\//i.test(userText);
  const isProductCode = /^[a-z]{1,2}[a-z0-9]{2,8}$/i.test(userText);

  if (!isGRL && !isZOZO && !isProductCode) {
    const sheets = getSheetsClient();
    const shouldReply = await checkAndSetBotReply(sheets, userId);
    if (shouldReply) {
      await client.replyMessage(replyToken, { type: 'text', text: '您好✨ 這裡是自動報價服務。\n請輸入 GRL / ZOZO 網址或 GRL 貨號（例：RU1197）即可自動報價。\n\n💭 欲購其他服飾或有任何疑問，請直接留言，真人客服稍後會立刻過來為您服務.ᐟ( ⁎ᵕᴗᵕ⁎ )🌷' });
    }
    return;
  }

  // ── ZOZO 查詢（佇列模式：由 Chrome Extension 在背景爬蟲，完成後 push 回覆）──
  if (isZOZO) {
    let taskId;
    try {
      const sheets = getSheetsClient();
      if (!await getZOZOEnabled(sheets)) {
        await client.replyMessage(replyToken, { type: 'text', text: 'ZOZO爬蟲伺服器維護中，如造成不便還請見諒.ᐟ' });
        return;
      }
      taskId = await addZOZOTask(sheets, userId, userText);
    } catch (err) {
      console.error('[zozo queue error]', err.message);
      await client.replyMessage(replyToken, { type: 'text', text: 'ZOZO 查詢暫時無法使用，請稍後再試' });
      return;
    }
    // 立即回「解析中」卡片，taskId 放進「查看報價」按鈕
    await client.replyMessage(replyToken, {
      type: 'flex',
      altText: 'ZOZO 報價解析中，請稍後點「查看報價」',
      contents: {
        type: 'bubble',
        size: 'kilo',
        header: {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#f5ede4',
          paddingAll: '14px',
          contents: [
            { type: 'text', text: '報價解析中', color: '#7a5c3e', size: 'xl', weight: 'bold', align: 'center' },
            { type: 'text', text: '平台：ZOZO', color: '#c9a98a', size: 'sm', align: 'center' },
          ],
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          paddingAll: '16px',
          contents: [
            { type: 'text', text: '正在為您抓取 ZOZO 商品資訊 ✨', weight: 'bold', size: 'sm', color: '#3d2c1e', wrap: true },
            { type: 'text', text: '解析通常需要 30～60 秒\n稍後請點下方「查看報價」取得結果 🌸', size: 'sm', color: '#888888', wrap: true },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          paddingAll: '10px',
          contents: [{
            type: 'button',
            style: 'primary',
            color: '#c9a98a',
            height: 'sm',
            action: { type: 'postback', label: '📋 查看報價', data: `action=zozo_check&taskId=${taskId}`, displayText: '查看 ZOZO 報價結果' },
          }],
        },
      },
    });
    return;
  }

  const queryUrl = isProductCode
    ? `https://www.grail.bz/item/${userText.toLowerCase()}/`
    : userText;
  const productId = extractProductId(queryUrl) || '';

  let productData, rate, kWeight;
  try {
    [productData, rate, kWeight] = await Promise.all([scrapeGRL(queryUrl), fetchRate(), lookupProductKWeight(productId)]);
  } catch (err) {
    console.error('[scrape error]', err.message);
    await client.replyMessage(replyToken, {
      type: 'text',
      text: '無法取得商品資訊，請確認網址是否正確',
    });
    if (userId === ADMIN_USER_ID) {
      const qStatus = productId ? `錯誤: ${err.message}` : '警告: 請確認 ID';
      appendProductToSheet(productId, '', 0, [], qStatus).catch((e) =>
        console.error('[sheets error-row write]', e.message)
      );
    }
    return;
  }

  const { productName, jpy, stockLines, imageUrl, colorImages, resolvedUrl, materialText = '' } = productData;
  const effectiveUrl = resolvedUrl || queryUrl;
  const weightInfo  = estimateWeight(productName, materialText);
  const lbsForPrice = kWeight || (weightInfo ? weightInfo.midLbs : 1);
  const suggested   = calcSuggestedPrice(rate, jpy, lbsForPrice);
  const qStatus     = calcQStatus(stockLines);

  // 先回覆，不等 getProfile（省 200~500ms）
  const flexMsg = buildFlexMessage(effectiveUrl, productName, jpy, suggested, stockLines, imageUrl, null);
  const cartFlex = buildAddToCartFlex(stockLines, productId, jpy, suggested, effectiveUrl, imageUrl, productName, colorImages);
  await client.replyMessage(replyToken, cartFlex ? [cartFlex] : [flexMsg]);

  // 背景任務：getProfile + 寫 Sheet（不阻塞回覆）
  const bgTasks = [];

  if (userId === ADMIN_USER_ID) {
    bgTasks.push(
      appendProductToSheet(productId, productName, jpy, stockLines, qStatus, weightInfo).catch((e) =>
        console.error('[sheets append error]', e.message)
      )
    );
  }

  bgTasks.push(
    client.getProfile(userId)
      .then((profile) => profile.displayName)
      .catch(() => userId)
      .then((displayName) =>
        logQueryToSheet(userId, displayName, productId, productName, jpy, weightInfo, imageUrl, suggested, queryUrl)
      )
      .catch((e) => console.error('[sheets log error]', e.message))
  );

  await Promise.all(bgTasks);
}

// ── Webhook 路由 ──────────────────────────────────────────────────────────────
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-line-signature'];

  if (
    !signature ||
    !line.validateSignature(req.body, process.env.LINE_CHANNEL_SECRET, signature)
  ) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  try {
    await Promise.all(
      (body.events || []).map((event) => handleEvent(event, lineClient))
    );
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[webhook error]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 健康檢查 ──────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'GRL LINE Bot is running' });
});

// ── 購物指南頁面 ─────────────────────────────────────────────────────────────
app.get('/guide', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildGuideHtml());
});


function buildGuideHtml() {
  const steps = [
    { num: '01', title: '查詢商品報價', icon: '🔍',
      grad: 'linear-gradient(135deg,#f0ddd5 0%,#e4c8bc 50%,#d4b0a8 100%)',
      desc: '瀏覽 GRL 或 ZOZO 官網尋找您的心頭好，將商品網址貼給機器人。我們將即時為您計算包含代購費與國際運費的台幣總額。',
      note: { type: 'quote', text: '※ ZOZO 商品需 30～60 秒解析，稍候點「查看報價」即可取得結果。' } },
    { num: '02', title: '選色加入購物車', icon: '🛒',
      grad: 'linear-gradient(135deg,#e8d5c4 0%,#d8c0aa 50%,#c8a890 100%)',
      desc: '報價卡片可左右滑動選擇顏色，點選尺寸按鈕即可加入購物車。如需多件商品，可繼續貼上其他網址逐一加入。',
      note: { type: 'quote', text: '注意：購物車內商品將於 6 小時後自動清除，請儘速完成下單。' } },
    { num: '03', title: '填資料・送出訂單', icon: '📋',
      grad: 'linear-gradient(135deg,#d8e0d4 0%,#c4d0be 50%,#b0c0a8 100%)',
      desc: '確認購物清單後，填寫基本聯絡資料。我們會細心核對每一筆訂單，確保您的商品正確無誤。',
      note: null },
    { num: '04', title: '收賣貨便連結', icon: '📩',
      grad: 'linear-gradient(135deg,#d4d8e8 0%,#bec4d8 50%,#a8b0c8 100%)',
      desc: '核對完成後，我們將透過官方 LINE 傳送賣貨便付款連結，請依照連結完成正式下單。',
      note: { type: 'alert', text: '為確保交易安全，請務必透過我們官方 LINE 傳送的連結進行結帳，勿自行前往。' } },
    { num: '05', title: '7-11 到店取件', icon: '📦',
      grad: 'linear-gradient(135deg,#ddd4e8 0%,#c8bcd8 50%,#b4a8c8 100%)',
      desc: '商品抵台後，我們將主動通知您前往指定的 7-11 門市取件。',
      note: { type: 'check', text: '如有任何疑問，歡迎隨時透過 LINE 聯繫我們。' } },
  ];

  const stepCards = steps.map((s, i) => {
    const isReversed = i % 2 !== 0;
    const noteHtml = s.note
      ? s.note.type === 'quote'
        ? `<div style="margin-top:20px;padding:14px 16px;background:#fcf7f3;border-left:3px solid #cba29b;font-size:13px;font-style:italic;color:#8c8279;line-height:1.7">${s.note.text}</div>`
        : s.note.type === 'alert'
        ? `<div style="margin-top:20px;display:flex;gap:10px;padding:14px;background:#f6f5f2;border-radius:8px;font-size:13px;color:#8c8279;line-height:1.6"><span style="flex-shrink:0;margin-top:2px">⚠️</span><span>${s.note.text}</span></div>`
        : `<div style="margin-top:20px;display:flex;align-items:center;gap:8px;color:#cba29b;font-size:14px;font-weight:500"><span>✅</span><span>${s.note.text}</span></div>`
      : '';

    return `
<div class="step-row${isReversed ? ' rev' : ''}">
  <div class="step-img-wrap">
    <div class="step-art">
      <img src="/public/guide/step${i + 1}.jpg" alt="${s.title}" style="width:100%;height:100%;object-fit:cover">
      <div class="art-overlay"></div>
    </div>
  </div>
  <div class="step-content">
    <div class="step-header">
      <span class="step-num-sm">${s.num}</span>
      <div class="step-line"></div>
      <span class="step-icon-sm">${s.icon}</span>
    </div>
    <h2 class="step-title">${s.title}</h2>
    <p class="step-desc">${s.desc}</p>
    ${noteHtml}
  </div>
</div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>代購流程指南 | Bijin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@300;400;700&family=Noto+Sans+TC:wght@300;400;500&display=swap">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Noto Sans TC',sans-serif;background:#faf9f6;color:#4a423e;padding-bottom:60px}
.step-row{display:flex;flex-direction:column;gap:32px;margin-bottom:64px;align-items:center}
.step-img-wrap{width:100%;flex-shrink:0}
.step-art{position:relative;width:100%;aspect-ratio:4/3;border-radius:6px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.12)}
.art-overlay{position:absolute;inset:0;background:linear-gradient(to bottom right,rgba(255,255,255,.04),rgba(0,0,0,.06));pointer-events:none}
.step-content{width:100%;padding:0 4px}
.step-header{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.step-num-sm{font-family:'Noto Serif TC',serif;font-size:52px;color:#e5e1da;line-height:1}
.step-line{height:1px;flex:1;background:#e5e1da}
.step-icon-sm{font-size:22px}
.step-title{font-size:22px;font-weight:700;color:#2d2723;margin-bottom:12px;letter-spacing:-.5px}
.step-desc{color:#6b625a;line-height:1.9;font-size:14px;font-weight:300}
@media(min-width:768px){
  .step-row{flex-direction:row;gap:64px}
  .step-row.rev{flex-direction:row-reverse}
  .step-img-wrap{width:60%}
  .step-content{width:40%;flex-shrink:0}
}
</style>
</head>
<body>
<div style="max-width:900px;margin:0 auto;padding:40px 20px">

  <header style="text-align:center;margin-bottom:72px">
    <div style="display:inline-flex;align-items:center;gap:8px;margin-bottom:20px;padding:6px 16px;border:1px solid #e5e1da;border-radius:999px;font-size:11px;letter-spacing:2px;color:#8c8279;text-transform:uppercase">
      ✦ Premium Shopping Experience
    </div>
    <h1 style="font-family:'Noto Serif TC',serif;font-size:clamp(28px,6vw,40px);font-weight:700;color:#2d2723;margin-bottom:16px;line-height:1.2">代購流程指南</h1>
    <p style="color:#8c8279;font-size:14px;max-width:480px;margin:0 auto;font-weight:300;line-height:1.9">
      我們致力於為您帶來最優質的日系穿搭體驗。<br>跟著以下五個簡潔步驟，輕鬆完成您的跨國購物。
    </p>
  </header>

  ${stepCards}

  <footer style="text-align:center;border-top:1px solid #e5e1da;padding-top:40px;margin-top:20px">
    <p style="font-size:11px;letter-spacing:2px;color:#8c8279;text-transform:uppercase;margin-bottom:12px">Bijin 日本正品代購</p>
    <p style="font-family:'Noto Serif TC',serif;font-style:italic;color:#cba29b;font-size:17px">讓優雅，成為您的日常。</p>
  </footer>
</div>
</body>
</html>`;
}

// ── LIFF 購物車頁面 ───────────────────────────────────────────────────────────
app.get('/cart', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(buildCartHtml());
});

// ── 購物車 API ────────────────────────────────────────────────────────────────
// ── 7-11 門市 Proxy ───────────────────────────────────────────────────────────
// 回傳指定商品 + 顏色的全尺寸圖片 URL（供 LIFF 購物車 lazy load 使用）
app.get('/api/item-image', async (req, res) => {
  const { id: productId, c: colorJp, url: directUrl } = req.query;
  if (!colorJp) return res.status(400).json({ error: 'c required' });
  if (!productId && !directUrl) return res.status(400).json({ error: 'id or url required' });
  if (directUrl) {
    try {
      const u = new URL(directUrl);
      if (!['www.grail.bz', 'grail.bz', 'zozo.jp', 'www.zozo.jp'].includes(u.hostname)) {
        return res.status(400).json({ error: 'invalid url' });
      }
    } catch { return res.status(400).json({ error: 'invalid url' }); }
  }
  try {
    const productUrl = directUrl || `https://www.grail.bz/item/${productId}/`;
    const { data: html } = await axios.get(productUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'ja,zh-TW;q=0.9',
      },
    });
    const $ = cheerio.load(html);
    let imageUrl = null;
    $('img[alt]').each((_, el) => {
      if (imageUrl) return;
      const alt = $(el).attr('alt') || '';
      if (!alt.includes(colorJp)) return;
      const src = $(el).attr('data-src') || $(el).attr('data-lazy') || $(el).attr('src') || '';
      if (!src) return;
      const full = src.replace('/images/goods/t/', '/images/goods/d/');
      imageUrl = full.startsWith('http') ? full : `https://cdn.grail.bz${full}`;
    });
    // fallback to og:image
    if (!imageUrl) imageUrl = $('meta[property="og:image"]').attr('content') || null;
    res.json({ imageUrl });
  } catch (e) {
    res.json({ imageUrl: null });
  }
});

app.get('/api/stores', async (req, res) => {
  const { city, area } = req.query;
  if (!city || !area) return res.status(400).json({ error: 'city and area required' });
  try {
    const url = `https://emacloz.com/posts/fetch_area_data_from_django?cityName=${encodeURIComponent(city)}&areaName=${encodeURIComponent(area)}`;
    const r = await axios.get(url, { headers: { 'Referer': 'https://emacloz.com', 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    res.json(r.data);
  } catch (err) {
    console.error('[api/stores error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cart', express.json(), async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const items = await getCartItems(userId);
    res.json({ items });
  } catch (err) {
    console.error('[api/cart error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cart/item', express.json(), async (req, res) => {
  const { rowIndex } = req.body;
  if (!rowIndex) return res.status(400).json({ error: 'rowIndex required' });
  try {
    await clearCartItem(rowIndex);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cart/add', express.json(), async (req, res) => {
  const { userId, displayName, productId, productName, color, size, jpy, suggestedPrice, productUrl, imageUrl, isPreorder } = req.body;
  if (!userId || !productId || !color || !size) return res.status(400).json({ error: 'missing fields' });
  try {
    await addToCartSheet(userId, displayName || '', productId, productName || productId, color, size, jpy || 0, suggestedPrice || 0, productUrl || '', imageUrl || '', !!isPreorder);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/order', express.json(), async (req, res) => {
  const { userId, displayName, cartItems, buyerInfo, discountInfo = {} } = req.body;
  if (!userId || !cartItems || !buyerInfo) return res.status(400).json({ error: 'missing fields' });
  try {
    const sheets = getSheetsClient();
    const { pointsUsed = 0, couponCode = '', couponAmount = 0 } = discountInfo;

    // 強制會員才能下單
    const member = await getMember(sheets, userId);
    if (!member) return res.status(400).json({ error: '請先加入會員才能下單' });

    // 驗證點數
    if (pointsUsed > 0) {
      if (pointsUsed > (member.points || 0)) return res.status(400).json({ error: '點數不足' });
    }
    // 驗證優惠券
    if (couponCode) {
      const coupons = await getActiveCoupons(sheets, userId);
      if (!coupons.find(c => c.couponCode === couponCode)) return res.status(400).json({ error: '優惠券無效或已使用' });
    }

    const result = await submitOrder(userId, displayName || '', cartItems, buyerInfo, { pointsUsed, couponCode, couponAmount });

    // 套用折扣（順序：先核銷券 → 後扣點；半完成時券已鎖、人工補扣點即可）
    let couponDone = false;
    let pointsDone = false;
    try {
      if (couponCode) {
        // 即時重驗：擋並發重複核銷（兩個請求同時通過初驗時的最後防線）
        const freshCoupons = await getActiveCoupons(sheets, userId);
        if (!freshCoupons.find(c => c.couponCode === couponCode)) {
          const e = new Error('優惠券已被使用，請聯繫客服確認');
          e.step = 'couponRevalidate';
          throw e;
        }
        await markCouponUsed(sheets, couponCode, result.orderId);
        couponDone = true;
      }
      if (pointsUsed > 0) {
        await deductMemberPoints(sheets, userId, pointsUsed);
        pointsDone = true;
      }
    } catch (discountErr) {
      const step = discountErr.step || (!couponDone && couponCode ? 'markCouponUsed' : 'deductMemberPoints');
      const couponStatus = couponCode
        ? (couponDone ? `✅已核銷(${couponCode})` : `❌失敗(${couponCode})`)
        : '無';
      const pointsStatus = pointsUsed > 0
        ? (pointsDone ? `✅已扣${pointsUsed}點` : `❌失敗(應扣${pointsUsed}點)`)
        : '無';

      logDiscountAnomaly(sheets, {
        userId, orderId: result.orderId,
        couponStatus, pointsStatus,
        failedStep: step, errorMessage: discountErr.message,
      }).catch(e => console.error('[logAnomaly]', e.message));

      const needsAction = [];
      if (!couponDone && couponCode) needsAction.push(`手動核銷券 ${couponCode}`);
      if (!pointsDone && pointsUsed > 0) needsAction.push(`手動扣除 ${pointsUsed} 點`);
      lineClient.pushMessage(ADMIN_USER_ID, {
        type: 'text',
        text: `⚠️ 結算異常 — 需人工處理\n\n訂單：${result.orderId}\n買家：${userId}\n失敗步驟：${step}\n錯誤：${discountErr.message}\n\n📋 各步驟狀態：\n  ✅ 訂單已寫入\n  ${couponStatus}\n  ${pointsStatus}\n\n👉 ${needsAction.join('\n👉 ')}`,
      }).catch(e => console.error('[anomaly admin notify]', e.message));
      lineClient.pushMessage(userId, {
        type: 'text',
        text: `⚠️ 訂單已成立（${result.orderId}），但折扣套用發生異常，請聯繫客服，我們將協助您處理 🌸`,
      }).catch(() => {});

      return res.status(500).json({
        error: `結算異常，請聯繫客服（訂單號：${result.orderId}）`,
        orderId: result.orderId,
      });
    }

    // 合併相同規格，顯示數量
    const _iMap = {};
    for (const i of cartItems) {
      const k = `${i.productId}|${i.color}|${i.size}`;
      if (!_iMap[k]) _iMap[k] = { ...i, qty: 0 };
      _iMap[k].qty++;
    }
    const _iList = Object.values(_iMap);
    const itemsText = _iList.map(i => {
      const srcTag = (i.productUrl || '').includes('zozo.jp') ? '[ZOZO]' : '[GRL]';
      return `${i.isPreorder ? '【預購】' : '・'}${srcTag} ${(i.productId||'').toUpperCase()} ${translateColorWithJp(i.color)} ${i.size} NT$${i.suggestedPrice}${i.qty > 1 ? ` ×${i.qty}` : ''}`;
    }).join('\n') + `\n共 ${cartItems.length} 件`;

    // 折扣文字（賣家用）
    let adminDiscText = '';
    if (result.discountTotal > 0) {
      adminDiscText += `\n━━━━━━━━━━`;
      if (pointsUsed > 0) adminDiscText += `\n💎 點數折抵：-NT$${pointsUsed}（${pointsUsed}點）`;
      if (couponCode) adminDiscText += `\n🎟 優惠券：${couponCode}（-NT$${couponAmount}）`;
      adminDiscText += `\n✅ 實付金額：NT$${result.finalAmount}`;
    }
    // 折扣文字（買家用）
    let buyerDiscText = '';
    if (result.discountTotal > 0) {
      if (pointsUsed > 0) buyerDiscText += `\n💎 點數折抵：-NT$${pointsUsed}（${pointsUsed}點）`;
      if (couponCode && couponAmount > 0) buyerDiscText += `\n🎟 優惠券折抵：-NT$${couponAmount}`;
      buyerDiscText += `\n✅ 實付金額：NT$${result.finalAmount}`;
    } else {
      buyerDiscText = `\n合計：NT$${result.totalTwd}`;
    }

    const [adminR, buyerR] = await Promise.allSettled([
      lineClient.pushMessage(ADMIN_USER_ID, {
        type: 'text',
        text: `🛍 新訂單！\n訂單ID: ${result.orderId}\n時間: ${result.orderTime}\n━━━━━━━━━━\n${itemsText}\n━━━━━━━━━━\n商品小計: NT$${result.totalTwd}${adminDiscText || ('\n合計: NT$' + result.totalTwd)}\n\n買家: ${buyerInfo.name}\n手機: ${buyerInfo.phone}\n聯繫方式: ${buyerInfo.contactMethod} @${buyerInfo.contactAccount}${buyerInfo.note ? '\n備註: ' + buyerInfo.note : ''}`,
      }),
      lineClient.pushMessage(userId, {
        type: 'text',
        text: `🎉 訂單已收到！\n\n訂單編號：${result.orderId}\n下單時間：${result.orderTime}\n━━━━━━━━━━\n${itemsText}\n━━━━━━━━━━\n商品小計：NT$${result.totalTwd}${buyerDiscText}\n\n我們確認後會盡快提供賣貨便下單連結，請耐心等候 🌸`,
      }),
    ]);
    if (adminR.status === 'rejected') console.error('[notify admin error]', adminR.reason?.message);
    if (buyerR.status === 'rejected') console.error('[notify buyer error]', buyerR.reason?.message);
    res.json({ status: 'ok', orderId: result.orderId });
  } catch (err) {
    console.error('[api/order error]', err.message);
    res.status(500).json({ error: err.message });
  }
});




// ── Debug：測試 LINE push 通知 ────────────────────────────────────────────────
app.get('/api/debug/notify', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await lineClient.pushMessage(ADMIN_USER_ID, { type: 'text', text: '🔧 通知測試 - 如果收到這訊息代表 LINE push 正常' });
    res.json({ ok: true, message: '推播成功' });
  } catch(e) {
    res.json({ ok: false, error: e.message, statusCode: e.statusCode });
  }
});

// ── 一次性：建立並啟用 Rich Menu ──────────────────────────────────────────────
app.get('/admin/setup-rich-menu', async (req, res) => {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const authHeader = { Authorization: `Bearer ${token}` };
  const jsonHeader = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    // 1. 找出現有 Rich Menu 並先把圖片存起來
    const listRes = await axios.get('https://api.line.me/v2/bot/richmenu/list', { headers: authHeader });
    const existingMenus = listRes.data.richmenus || [];
    let savedImg = null, savedContentType = 'image/jpeg';
    for (const m of existingMenus) {
      try {
        const imgRes = await axios.get(
          `https://api-data.line.me/v2/bot/richmenu/${m.richMenuId}/content`,
          { headers: authHeader, responseType: 'arraybuffer', timeout: 15000 }
        );
        savedImg = imgRes.data;
        savedContentType = imgRes.headers['content-type'] || 'image/jpeg';
        break; // 只需要一張
      } catch { continue; }
    }

    // 2. 刪除所有舊 Rich Menu
    for (const m of existingMenus) {
      await axios.delete(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { headers: authHeader }).catch(() => {});
    }

    // 3. 建立新 Rich Menu
    const richMenuId = await setupRichMenu('');

    // 4. 上傳圖片（若有找到）
    if (savedImg) {
      await axios.post(
        `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
        savedImg,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': savedContentType } }
      );
    }

    // 5. 設為所有用戶預設選單
    await axios.post(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {}, { headers: jsonHeader });

    res.json({ status: 'ok', richMenuId, hadImage: !!savedImg, message: 'Rich Menu 已建立並設為預設選單' });
  } catch (err) {
    console.error('[setup-rich-menu error]', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 強制更新特定用戶的 Rich Menu ─────────────────────────────────────────────
app.get('/admin/link-rich-menu', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    // 取得目前預設 Rich Menu ID
    const defaultRes = await axios.get('https://api.line.me/v2/bot/user/all/richmenu', { headers });
    const richMenuId = defaultRes.data.richMenuId;
    if (!richMenuId) return res.status(404).json({ error: '找不到預設 Rich Menu' });
    // 強制綁定給指定用戶
    await axios.post(`https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`, {}, { headers });
    res.json({ ok: true, userId, richMenuId });
  } catch (e) { res.status(500).json({ error: e.message, detail: e.response?.data }); }
});

// ── 除錯：查看目前 Rich Menu 定義 ────────────────────────────────────────────
app.get('/admin/check-rich-menu', async (req, res) => {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const list = await axios.get('https://api.line.me/v2/bot/richmenu/list', { headers });
    const defaultRes = await axios.get('https://api.line.me/v2/bot/user/all/richmenu', { headers }).catch(() => ({ data: {} }));
    res.json({ menus: list.data.richmenus, defaultId: defaultRes.data.richMenuId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員：會員管理頁面 ────────────────────────────────────────────────────
app.get('/admin/members', async (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_KEY) return res.status(401).send('Unauthorized');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  let members = [], loadError = '';
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A:N` });
    const rows = resp.data.values || [];
    members = rows.slice(1).map((r, i) => ({
      rowIndex: i + 2,
      userId: r[0] || '', displayName: r[1] || '', joinDate: r[2] || '',
      birthday: r[3] || '', referralCode: r[4] || '', referredByCode: r[5] || '',
      currentYear: parseInt(r[7]) || new Date().getFullYear(),
      yearlySpend: parseFloat(r[8]) || 0, tier: r[9] || '一般',
      points: parseInt(r[10]) || 0, lastUpdated: r[11] || '',
      name: r[12] || '', phone: r[13] || '',
    })).filter(m => m.userId);
  } catch(e) { loadError = e.message; }

  const membersJson = JSON.stringify(members).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const adminKey = key;

  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bijin 會員管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f3f0;min-height:100vh;color:#2d2218}
header{background:#fff;border-bottom:2px solid #e8ddd4;padding:0 24px;position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;height:56px}
.hdr-logo{font-size:18px;font-weight:700;color:#7a5c3e}
.btn{background:#7a5c3e;color:#fff;border:none;border-radius:8px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
.btn:hover{background:#5e4530}
.btn-sm{padding:4px 10px;font-size:12px;border-radius:6px}
.btn-gold{background:#c9a98a}
.btn-danger{background:#e53935}
.toolbar{display:flex;gap:10px;align-items:center;padding:14px 24px;background:#fff;border-bottom:1px solid #eee;flex-wrap:wrap}
.search-box{border:1px solid #ddd;border-radius:8px;padding:7px 12px;font-size:13px;outline:none;min-width:220px}
.search-box:focus{border-color:#c9a98a}
.summary{padding:10px 24px;font-size:13px;color:#888}
table{width:100%;border-collapse:collapse;background:#fff}
thead{background:#f5ede0}
th{padding:10px 12px;text-align:left;font-size:12px;color:#7a5c3e;font-weight:700;white-space:nowrap}
td{padding:10px 12px;font-size:13px;color:#333;border-bottom:1px solid #f0e8de;vertical-align:middle}
tr:hover td{background:#fffaf5}
.tier-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700}
.tier-一般{background:#f5ede0;color:#a08060}
.tier-銀卡{background:#e8e8e8;color:#666}
.tier-金卡{background:#fff3cd;color:#a07800}
.tier-白金{background:#e8f0fe;color:#3949ab}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;align-items:center;justify-content:center}
.modal.show{display:flex}
.modal-box{background:#fff;border-radius:14px;padding:24px;width:340px;max-width:95vw}
.modal-title{font-size:16px;font-weight:700;color:#7a5c3e;margin-bottom:16px}
.form-row{margin-bottom:12px}
.form-row label{display:block;font-size:12px;color:#888;margin-bottom:4px}
.form-row input, .form-row select{width:100%;border:1px solid #ddd;border-radius:8px;padding:8px 10px;font-size:14px;outline:none}
.form-row input:focus, .form-row select:focus{border-color:#c9a98a}
.modal-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:200;white-space:nowrap}
.toast.show{opacity:1}
</style>
</head>
<body>
<header>
  <div class="hdr-logo">👥 Bijin 會員管理</div>
  <a href="/admin?key=${adminKey}" class="btn">← 回訂單後台</a>
</header>
<div class="toolbar">
  <input class="search-box" id="search-box" placeholder="搜尋姓名 / 手機 / LINE名稱…" oninput="render()">
  <select id="filter-tier" onchange="render()" style="border:1px solid #ddd;border-radius:8px;padding:7px 10px;font-size:13px;outline:none;background:#fff">
    <option value="">全部等級</option>
    <option value="一般">一般</option>
    <option value="銀卡">銀卡</option>
    <option value="金卡">金卡</option>
    <option value="白金">白金</option>
  </select>
</div>
<div class="summary" id="summary"></div>
${loadError ? `<div style="padding:20px;color:#c0392b;font-weight:600">載入失敗：${loadError}</div>` : ''}
<div style="overflow-x:auto">
<table>
  <thead>
    <tr>
      <th>姓名</th><th>LINE 名稱</th><th>手機</th><th>等級</th>
      <th>年度消費</th><th>可用點數</th><th>生日</th><th>加入日期</th><th>操作</th>
    </tr>
  </thead>
  <tbody id="tbody"></tbody>
</table>
</div>

<!-- 優惠券 Modal -->
<div class="modal" id="coupon-modal">
  <div class="modal-box" style="width:420px">
    <div class="modal-title">🎟 優惠券管理 — <span id="coupon-member-name"></span></div>
    <div id="coupon-list-area" style="margin-bottom:16px;max-height:200px;overflow-y:auto"></div>
    <div style="border-top:1px solid #f0e8de;padding-top:14px">
      <div style="font-size:13px;font-weight:700;color:#7a5c3e;margin-bottom:10px">＋ 新增優惠券</div>
      <div class="form-row">
        <label>說明 / 類型（例：生日禮、客服補發、首單優惠）</label>
        <input id="cpn-type" type="text" placeholder="輸入說明">
      </div>
      <div style="display:flex;gap:8px">
        <div class="form-row" style="flex:1">
          <label>金額（NT$）</label>
          <input id="cpn-amount" type="number" min="1" placeholder="50">
        </div>
        <div class="form-row" style="flex:1">
          <label>張數</label>
          <input id="cpn-qty" type="number" min="1" max="10" value="1">
        </div>
      </div>
      <div class="form-row">
        <label>到期日</label>
        <input id="cpn-expiry" type="date">
      </div>
    </div>
    <div class="modal-btns">
      <button class="btn" style="background:#aaa" onclick="closeCouponModal()">關閉</button>
      <button class="btn btn-gold" onclick="addCoupon()">發行優惠券</button>
    </div>
  </div>
</div>

<!-- 編輯 Modal -->
<div class="modal" id="edit-modal">
  <div class="modal-box">
    <div class="modal-title">✏️ 調整會員資料</div>
    <input type="hidden" id="edit-row">
    <div class="form-row">
      <label>姓名</label>
      <input id="edit-name" type="text" readonly style="background:#f5f5f5;color:#aaa">
    </div>
    <div class="form-row">
      <label>等級</label>
      <select id="edit-tier">
        <option>一般</option><option>銀卡</option><option>金卡</option><option>白金</option>
      </select>
    </div>
    <div class="form-row">
      <label>可用點數</label>
      <input id="edit-points" type="number" min="0">
    </div>
    <div class="form-row">
      <label>年度消費（NT$）</label>
      <input id="edit-spend" type="number" min="0">
    </div>
    <div class="modal-btns">
      <button class="btn" style="background:#aaa" onclick="closeModal()">取消</button>
      <button class="btn btn-gold" onclick="saveEdit()">儲存</button>
    </div>
  </div>
</div>
<div id="toast" class="toast"></div>

<script>
var allMembers = ${membersJson};
var KEY = '${adminKey}';

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function render() {
  var kw = (document.getElementById('search-box').value||'').trim().toLowerCase();
  var tier = document.getElementById('filter-tier').value;
  var list = allMembers.filter(function(m){
    if (tier && m.tier !== tier) return false;
    if (!kw) return true;
    return (m.name||'').toLowerCase().indexOf(kw)>=0
      || (m.displayName||'').toLowerCase().indexOf(kw)>=0
      || (m.phone||'').indexOf(kw)>=0;
  });
  document.getElementById('summary').textContent = '共 ' + list.length + ' 位會員（總計 ' + allMembers.length + ' 位）';
  var rows = list.map(function(m){
    return '<tr>'
      + '<td><strong>' + esc(m.name) + '</strong></td>'
      + '<td style="color:#888">' + esc(m.displayName) + '</td>'
      + '<td style="font-family:monospace">' + esc(m.phone) + '</td>'
      + '<td><span class="tier-badge tier-' + esc(m.tier) + '">' + esc(m.tier) + '</span></td>'
      + '<td>NT$' + (m.yearlySpend||0).toLocaleString() + '</td>'
      + '<td><strong style="color:#c9a98a">' + (m.points||0) + ' 點</strong></td>'
      + '<td>' + esc(m.birthday||'—') + '</td>'
      + '<td style="color:#aaa;font-size:12px">' + esc(m.joinDate||'—') + '</td>'
      + '<td><button class="btn btn-sm btn-gold" onclick="openEdit(' + m.rowIndex + ')" style="margin-right:4px">調整</button><button class="btn btn-sm" style="background:#c9a98a" data-uid="' + esc(m.userId) + '" data-name="' + esc(m.name||m.displayName) + '" onclick="openCoupons(this.dataset.uid,this.dataset.name)">優惠券</button></td>'
      + '</tr>';
  }).join('');
  document.getElementById('tbody').innerHTML = rows || '<tr><td colspan="9" style="text-align:center;color:#ccc;padding:20px">找不到符合條件的會員</td></tr>';
}

function openEdit(rowIndex) {
  var m = allMembers.find(function(x){ return x.rowIndex === rowIndex; });
  if (!m) return;
  document.getElementById('edit-row').value = rowIndex;
  document.getElementById('edit-name').value = m.name + '（' + m.displayName + '）';
  document.getElementById('edit-tier').value = m.tier;
  document.getElementById('edit-points').value = m.points || 0;
  document.getElementById('edit-spend').value = m.yearlySpend || 0;
  document.getElementById('edit-modal').classList.add('show');
}

function closeModal() {
  document.getElementById('edit-modal').classList.remove('show');
}

async function saveEdit() {
  var rowIndex = parseInt(document.getElementById('edit-row').value);
  var tier = document.getElementById('edit-tier').value;
  var points = parseInt(document.getElementById('edit-points').value) || 0;
  var yearlySpend = parseFloat(document.getElementById('edit-spend').value) || 0;
  try {
    var r = await fetch('/api/admin/member-adjust', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, rowIndex, tier, points, yearlySpend })
    });
    var d = await r.json();
    if (!d.ok) { showToast('❌ ' + d.error); return; }
    var m = allMembers.find(function(x){ return x.rowIndex === rowIndex; });
    if (m) { m.tier = tier; m.points = points; m.yearlySpend = yearlySpend; }
    closeModal();
    render();
    showToast('✅ 已更新');
  } catch(e) { showToast('❌ 網路錯誤'); }
}

function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, 2500);
}

var currentCouponUserId = '', currentCouponDisplayName = '';

async function openCoupons(userId, memberName) {
  currentCouponUserId = userId;
  currentCouponDisplayName = memberName;
  document.getElementById('coupon-member-name').textContent = memberName;
  document.getElementById('coupon-list-area').innerHTML = '<div style="color:#aaa;font-size:13px">載入中…</div>';
  // 預設到期日 3 個月後
  var d = new Date(); d.setMonth(d.getMonth()+3);
  document.getElementById('cpn-expiry').value = d.toISOString().slice(0,10);
  document.getElementById('cpn-type').value = '';
  document.getElementById('cpn-amount').value = '';
  document.getElementById('cpn-qty').value = '1';
  document.getElementById('coupon-modal').classList.add('show');
  try {
    var r = await fetch('/api/admin/member-coupons?key=' + KEY + '&userId=' + encodeURIComponent(userId));
    var d2 = await r.json();
    renderCouponList(d2.coupons || []);
  } catch(e) { document.getElementById('coupon-list-area').innerHTML = '<div style="color:#e53935;font-size:13px">載入失敗</div>'; }
}

function renderCouponList(coupons) {
  if (!coupons.length) {
    document.getElementById('coupon-list-area').innerHTML = '<div style="color:#aaa;font-size:13px">目前無優惠券</div>';
    return;
  }
  var statusLabel = {'unused':'未使用','used':'已使用','voided':'已作廢','expired':'已過期'};
  var statusColor = {'unused':'#4caf50','used':'#aaa','voided':'#e53935','expired':'#aaa'};
  document.getElementById('coupon-list-area').innerHTML = coupons.map(function(c){
    var st = c.status || 'unused';
    var canVoid = st === 'unused';
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #f5ede0;font-size:13px">'
      + '<div><div style="font-weight:bold;color:#7a5c3e">' + esc(c.type) + '　NT$' + c.amount + '</div>'
      + '<div style="font-size:11px;color:#aaa">' + esc(c.couponCode||'') + '　到期：' + esc(c.expiryDate) + '</div></div>'
      + '<div style="display:flex;align-items:center;gap:6px">'
      + '<span style="font-size:11px;color:' + statusColor[st] + ';font-weight:700">' + (statusLabel[st]||st) + '</span>'
      + (canVoid ? '<button class="btn btn-sm btn-danger" style="padding:2px 8px;font-size:11px" onclick="voidCoupon(' + c.rowIndex + ',this)">作廢</button>' : '')
      + '</div></div>';
  }).join('');
}

function closeCouponModal() {
  document.getElementById('coupon-modal').classList.remove('show');
}

async function addCoupon() {
  var type = document.getElementById('cpn-type').value.trim();
  var amount = parseInt(document.getElementById('cpn-amount').value);
  var qty = parseInt(document.getElementById('cpn-qty').value) || 1;
  var expiry = document.getElementById('cpn-expiry').value;
  if (!type || !amount || !expiry) { showToast('請填寫所有欄位'); return; }
  try {
    var r = await fetch('/api/admin/member-coupon-add', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ key:KEY, userId:currentCouponUserId, displayName:currentCouponDisplayName, type, amount, expiryDate:expiry, qty })
    });
    var d = await r.json();
    if (!d.ok) { showToast('❌ ' + d.error); return; }
    showToast('✅ 已發行 ' + d.codes.length + ' 張優惠券');
    // 重新載入優惠券列表
    var r2 = await fetch('/api/admin/member-coupons?key=' + KEY + '&userId=' + encodeURIComponent(currentCouponUserId));
    var d2 = await r2.json();
    renderCouponList(d2.coupons || []);
  } catch(e) { showToast('❌ 網路錯誤'); }
}

async function voidCoupon(rowIndex, btn) {
  btn.disabled = true;
  try {
    var r = await fetch('/api/admin/member-coupon-void', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ key:KEY, rowIndex })
    });
    var d = await r.json();
    if (!d.ok) { showToast('❌ ' + d.error); btn.disabled=false; return; }
    showToast('✅ 已作廢');
    var r2 = await fetch('/api/admin/member-coupons?key=' + KEY + '&userId=' + encodeURIComponent(currentCouponUserId));
    var d2 = await r2.json();
    renderCouponList(d2.coupons || []);
  } catch(e) { showToast('❌ 網路錯誤'); btn.disabled=false; }
}

render();
</script>
</body>
</html>`);
});

// ── 管理員 API：系統設定（ZOZO 開關等）────────────────────────────────────────
app.post('/api/admin/settings', express.json(), async (req, res) => {
  const { key, setting, value } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!setting) return res.status(400).json({ error: 'setting required' });
  try {
    const sheets = getSheetsClient();

    // 若「設定」工作表不存在，自動建立並加入標題列
    let rows = [];
    try {
      const existing = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SETTINGS_SHEET}!A:B` });
      rows = existing.data.values || [];
    } catch (e) {
      if (e.message && e.message.includes('Unable to parse range')) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          resource: { requests: [{ addSheet: { properties: { title: SETTINGS_SHEET } } }] },
        });
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID, range: `${SETTINGS_SHEET}!A:B`,
          valueInputOption: 'RAW', resource: { values: [['key', 'value']] },
        });
      } else throw e;
    }

    const rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === setting);
    if (rowIdx >= 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${SETTINGS_SHEET}!B${rowIdx + 1}`,
        valueInputOption: 'RAW', resource: { values: [[value]] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${SETTINGS_SHEET}!A:B`,
        valueInputOption: 'RAW', resource: { values: [[setting, value]] },
      });
    }
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── 管理員 API：調整會員資料 ──────────────────────────────────────────────────
app.post('/api/admin/member-adjust', express.json(), async (req, res) => {
  const { key, rowIndex, tier, points, yearlySpend } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!rowIndex || !tier) return res.status(400).json({ error: 'missing fields' });
  const VALID_TIERS = ['一般', '銀卡', '金卡', '白金'];
  if (!VALID_TIERS.includes(tier)) return res.status(400).json({ error: '等級無效' });
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${MEMBER_SHEET}!I${rowIndex}:L${rowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [[parseFloat(yearlySpend)||0, tier, parseInt(points)||0, todayStr()]] },
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員 API：取得會員優惠券 ────────────────────────────────────────────────
app.get('/api/admin/member-coupons', async (req, res) => {
  const { key, userId } = req.query;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!A:I` });
    const rows = resp.data.values || [];
    const coupons = rows.slice(1)
      .map((r, i) => ({ rowIndex: i + 2, couponCode: r[0], userId: r[1], type: r[3], amount: parseInt(r[4])||0, issueDate: r[5], expiryDate: r[6], status: r[7]||'unused' }))
      .filter(c => c.userId === userId);
    res.json({ ok: true, coupons });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員 API：新增優惠券給會員 ──────────────────────────────────────────────
app.post('/api/admin/member-coupon-add', express.json(), async (req, res) => {
  const { key, userId, displayName, type, amount, expiryDate, qty } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!userId || !type || !amount || !expiryDate) return res.status(400).json({ error: 'missing fields' });
  try {
    const sheets = getSheetsClient();
    const codes = await issueCoupons(sheets, userId, displayName || '', type, parseInt(amount), parseInt(qty)||1, expiryDate);
    res.json({ ok: true, codes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員 API：作廢優惠券 ────────────────────────────────────────────────────
app.post('/api/admin/member-coupon-void', express.json(), async (req, res) => {
  const { key, rowIndex } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!rowIndex) return res.status(400).json({ error: 'rowIndex required' });
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!H${rowIndex}`,
      valueInputOption: 'RAW', resource: { values: [['voided']] },
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員 API：取得所有訂單 ──────────────────────────────────────────────────
app.get('/api/admin/orders', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache');
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sheets = getSheetsClient();
    const resp = await Promise.race([
      sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:R` }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Sheets API timeout')), 8000)),
    ]);
    const rows = (resp.data.values || []).slice(1);
    const orders = rows.map((row, i) => ({
      rowIndex:        i + 2,
      orderId:         row[0] || '',
      orderTime:       row[1] || '',
      userId:          row[2] || '',
      items:           row[3] || '',
      total:           row[4] || '',
      buyerName:       row[5] || '',
      phone:           row[6] || '',
      contact:         row[7] || '',
      contactId:       row[8] || '',
      note:            row[9] || '',
      status:          row[10] || '待確認',
      pointsUsed:      parseInt(row[11]) || 0,
      couponCode:      row[12] || '',
      discountTotal:   parseInt(row[13]) || 0,
      finalAmount:     parseInt(row[14]) || parseInt(row[4]) || 0,
      lineDisplayName: row[15] || '',
      adminNote:       row[16] || '',
      warehouse:       row[17] || '',
    })).reverse();
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 管理員 API：更新訂單狀態 ──────────────────────────────────────────────────
app.post('/api/admin/order-status', express.json(), async (req, res) => {
  const { key, rowIndex, status } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!rowIndex || !status) return res.status(400).json({ error: 'rowIndex and status required' });
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${ORDER_SHEET}!K${rowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [[status]] },
    });
    // 訂單轉已完成時，觸發點數與邀請獎勵
    if (status === '已完成') {
      const orderResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A${rowIndex}:P${rowIndex}` });
      const orderRow = (orderResp.data.values || [])[0] || [];
      const buyerUserId = orderRow[2] || '';
      const displayName = orderRow[15] || '';
      const totalTwd = parseFloat(orderRow[4]) || 0;
      if (buyerUserId) {
        await processOrderCompletion(sheets, buyerUserId, displayName, orderRow[0], totalTwd)
          .catch(e => console.error('[processOrderCompletion error]', e.message));
      }
    }
    // 訂單退單時，撤銷點數
    if (status === '退單') {
      const orderResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A${rowIndex}:A${rowIndex}` });
      const returnOrderId = ((orderResp.data.values || [])[0] || [])[0] || '';
      if (returnOrderId) {
        await processOrderReturn(sheets, returnOrderId)
          .catch(e => console.error('[processOrderReturn error]', e.message));
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 管理員 API：儲存內部備註（Q欄，不通知買家） ───────────────────────────────
app.post('/api/admin/order-note', express.json(), async (req, res) => {
  const { key, rowIndex, adminNote } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!rowIndex) return res.status(400).json({ error: 'rowIndex required' });
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${ORDER_SHEET}!Q${rowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [[adminNote || '']] },
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員 API：更新倉庫分類（R欄） ───────────────────────────────────────────
app.post('/api/admin/order-warehouse', express.json(), async (req, res) => {
  const { key, rowIndex, warehouse } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!rowIndex) return res.status(400).json({ error: 'rowIndex required' });
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${ORDER_SHEET}!R${rowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [[warehouse || '']] },
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員 API：修改訂單商品 ──────────────────────────────────────────────────
app.post('/api/admin/order-edit', express.json(), async (req, res) => {
  const { key, rowIndex, items, totalTwd } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!rowIndex || !items || totalTwd === undefined) return res.status(400).json({ error: 'missing fields' });
  try {
    const sheets = getSheetsClient();
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!N${rowIndex}:N${rowIndex}`,
    });
    const discountTotal = parseInt(((existing.data.values || [[]])[0] || [])[0]) || 0;
    const finalAmount = Math.max(totalTwd - discountTotal, 0);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        valueInputOption: 'RAW',
        data: [
          { range: `${ORDER_SHEET}!D${rowIndex}`, values: [[items]] },
          { range: `${ORDER_SHEET}!E${rowIndex}`, values: [[totalTwd]] },
          { range: `${ORDER_SHEET}!O${rowIndex}`, values: [[finalAmount]] },
        ],
      },
    });
    res.json({ ok: true, totalTwd, discountTotal, finalAmount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 管理員頁面 ────────────────────────────────────────────────────────────────
app.get('/admin', async (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_KEY) return res.status(401).send('Unauthorized');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  const adminKey = ADMIN_KEY;
  const BUILD_VERSION = 'v2.7';
  // ── 伺服器端直接讀取訂單，嵌入頁面 ──
  let ssrOrders = [];
  let ssrError = '';
  try {
    const sheets = getSheetsClient();
    const resp = await Promise.race([
      sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:R` }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Sheets timeout')), 25000)),
    ]);
    const rows = (resp.data.values || []).slice(1);
    ssrOrders = rows.map((row, i) => ({
      rowIndex:        i + 2,
      orderId:         row[0] || '',
      orderTime:       row[1] || '',
      userId:          row[2] || '',
      items:           row[3] || '',
      total:           row[4] || '',
      buyerName:       row[5] || '',
      phone:           row[6] || '',
      contact:         row[7] || '',
      contactId:       row[8] || '',
      note:            row[9] || '',
      status:          row[10] || '待確認',
      pointsUsed:      parseInt(row[11]) || 0,
      couponCode:      row[12] || '',
      discountTotal:   parseInt(row[13]) || 0,
      finalAmount:     parseInt(row[14]) || parseInt(row[4]) || 0,
      lineDisplayName: row[15] || '',
      adminNote:       row[16] || '',
      warehouse:       row[17] || '',
    })).reverse();
  } catch (e) {
    ssrError = e.message;
  }
  // 取會員總數
  let ssrMemberCount = 0;
  try {
    const sheets2 = getSheetsClient();
    const mResp = await sheets2.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A:A` });
    ssrMemberCount = Math.max(0, ((mResp.data.values || []).length - 1));
  } catch(e) { /* ignore */ }
  // 取 ZOZO 開關狀態
  let zozoEnabled = true;
  try {
    const sheets3 = getSheetsClient();
    zozoEnabled = await getZOZOEnabled(sheets3);
  } catch(e) { /* ignore */ }
  let gasNotifyEnabled = true;
  try {
    const sheets4 = getSheetsClient();
    gasNotifyEnabled = await getGasNotifyEnabled(sheets4);
  } catch(e) { /* ignore */ }
  const ssrOrdersJson = JSON.stringify(ssrOrders).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bijin 管理後台</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#faf6f1;min-height:100vh;color:#2d2218}
/* ── Header ── */
header{background:#fff;border-bottom:2px solid #e8ddd4;padding:0 24px;position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;height:56px;box-shadow:0 2px 8px rgba(0,0,0,.04)}
.hdr-left{display:flex;align-items:center;gap:12px}
.hdr-logo{font-size:20px;font-weight:700;color:#7a5c3e;letter-spacing:.5px}
.hdr-counts{display:flex;gap:10px;flex-wrap:wrap}
.hdr-pill{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
.pill-active{background:#fff3e0;color:#c75c00}
.pill-done{background:#f3e5f5;color:#6a1b9a}
.pill-return{background:#fbe9e7;color:#bf360c}
.pill-cancel{background:#fafafa;color:#999;border:1px solid #eee}
/* ── Toolbar ── */
.toolbar{padding:10px 24px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#fff;border-bottom:1px solid #ede8e2}
.toolbar select{border:1px solid #e0d8d0;border-radius:20px;padding:7px 14px;font-size:13px;background:#faf6f1;color:#7a5c3e;cursor:pointer;outline:none;font-weight:600;transition:border-color .18s,background .18s;-webkit-appearance:none;appearance:none;padding-right:28px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23c9a98a'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
.toolbar select:focus{border-color:#c9a98a;background-color:#fff}
.btn-refresh{background:#7a5c3e;color:#fff;border:none;border-radius:20px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;transition:background .18s,transform .15s}
.btn-refresh:hover{background:#5e4530;transform:translateY(-1px)}
.search-wrap{position:relative;display:flex;align-items:center}
.search-icon{position:absolute;left:11px;font-size:14px;color:#c9a98a;pointer-events:none}
.search-box{border:1px solid #e0d8d0;border-radius:20px;padding:7px 12px 7px 32px;font-size:13px;outline:none;min-width:180px;background:#faf6f1;transition:border-color .18s,box-shadow .18s}
.search-box:focus{border-color:#c9a98a;background:#fff;box-shadow:0 0 0 3px rgba(201,169,138,.15)}
#err-bar{display:none;background:#fde8e4;color:#c0392b;padding:10px 24px;font-size:13px;font-weight:600;border-bottom:1px solid #f5c6c0}
#err-bar button{margin-left:12px;background:#c0392b;color:#fff;border:none;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
/* ── Grid ── */
#orders{padding:16px 24px 80px;display:grid;grid-template-columns:repeat(4,1fr);gap:16px;align-items:start}
@media(max-width:1300px){#orders{grid-template-columns:repeat(3,1fr)}}
@media(max-width:900px){#orders{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){#orders{grid-template-columns:1fr;padding:12px 12px 80px;gap:12px}}
/* ── Card ── */
.order-card{background:#fff;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.07);overflow:hidden;transition:box-shadow .2s,transform .2s}
.order-card:hover{box-shadow:0 8px 28px rgba(0,0,0,.12);transform:translateY(-3px)}
.card-top{display:flex;justify-content:space-between;align-items:flex-start;padding:12px 16px 0}
.card-id{font-size:11px;color:#bbb;font-family:monospace;letter-spacing:.3px}
.card-time{font-size:11px;color:#ccc;text-align:right;line-height:1.4}
.card-status{padding:6px 16px 4px;display:flex;align-items:center;gap:8px}
.card-body{padding:0 16px 12px}
.buyer-name{font-size:16px;font-weight:800;color:#2d2218;margin-bottom:2px;letter-spacing:.2px}
.line-name{font-size:12px;color:#bbb;font-weight:400;margin-bottom:8px}
.order-items{font-size:12px;color:#777;line-height:2;margin-bottom:8px;border-left:3px solid #f0e6da;padding-left:10px;background:#fdf9f5;border-radius:0 6px 6px 0;padding-top:4px;padding-bottom:4px}
.price-row{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.price-final{font-size:20px;font-weight:800;color:#7a5c3e;letter-spacing:-.3px}
.price-orig{font-size:12px;color:#bbb;text-decoration:line-through}
.price-disc{font-size:12px;color:#a55;background:#fff0f0;border-radius:6px;padding:2px 8px;font-weight:600}
.info-row{font-size:12px;color:#999;margin-top:3px;display:flex;align-items:center;gap:6px}
.info-label{background:#f0ebe4;color:#7a5c3e;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:600;white-space:nowrap}
.card-divider{border:none;border-top:1px solid #f0ebe4;margin:0}
/* ── Progress bar ── */
.pb-wrap{padding:8px 16px 2px}
.pb-track{height:4px;background:#f0ebe4;border-radius:2px;position:relative;overflow:visible;margin-bottom:6px}
.pb-fill{height:100%;background:linear-gradient(90deg,#c9a98a,#e8c49a);border-radius:2px;transition:width .4s}
.pb-row{display:flex;justify-content:space-between}
.pb-step{display:flex;flex-direction:column;align-items:center;flex:1;position:relative}
.pb-dot{width:9px;height:9px;border-radius:50%;background:#e8ddd4;margin-top:-13px;position:relative;z-index:1;border:2px solid #f0ebe4}
.pb-dot.pb-done{background:#c9a98a;border-color:#c9a98a}
.pb-dot.pb-curr{background:#fff;border:2.5px solid #c9a98a;width:12px;height:12px;margin-top:-15px;box-shadow:0 0 0 3px rgba(201,169,138,.2)}
.pb-lbl{font-size:9px;color:#ccc;margin-top:3px;white-space:nowrap;line-height:1}
.pb-lbl.pb-lbl-curr{color:#c9a98a;font-weight:700}
/* ── Card footer ── */
.card-footer{padding:10px 12px;display:flex;gap:6px;align-items:center;background:#fcfaf8}
.status-select{border:1px solid #e0d8d0;border-radius:10px;padding:8px 10px;font-size:13px;background:#fff;flex:1;min-width:120px;outline:none;cursor:pointer;transition:border-color .18s}
.status-select:focus{border-color:#c9a98a}
.btn-save{background:#c9a98a;color:#fff;border:none;border-radius:10px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;transition:background .18s,transform .15s}
.btn-save:hover{background:#b0885e;transform:translateY(-1px)}
.btn-save:disabled{opacity:.5;cursor:default;transform:none}
/* ── Notify (賣貨便) row ── */
.notify-row{display:none;padding:10px 12px;border-top:1px solid #f0ebe4;gap:8px;align-items:center}
.notify-row input{flex:1;border:1px solid #e0d8d0;border-radius:10px;padding:8px 10px;font-size:13px;outline:none;transition:border-color .18s}
.notify-row input:focus{border-color:#7a8fb5}
.btn-send{background:#7a8fb5;color:#fff;border:none;border-radius:10px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;transition:background .18s}
.btn-send:hover{background:#5e7399}
/* ── Status badge ── */
.sbadge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;letter-spacing:.2px}
/* ── Closed sections ── */
.sec-closed{margin:0 24px 14px;border-radius:16px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.06);overflow:hidden}
@media(max-width:560px){.sec-closed{margin:0 12px 12px}}
.sec-summary{padding:14px 20px;font-size:14px;font-weight:700;color:#888;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;user-select:none;transition:background .15s}
.sec-summary:hover{background:#fdf9f5}
.sec-summary::-webkit-details-marker{display:none}
details.sec-closed[open] .sec-summary::after{content:'▾';font-size:12px}
.sec-summary::after{content:'▸';font-size:12px;color:#bbb}
.closed-row{display:flex;justify-content:space-between;align-items:center;padding:10px 20px;border-top:1px solid #f5f2ee;font-size:13px;gap:8px;transition:background .15s}
.closed-row:hover{background:#fdf9f5}
.cr-left{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cr-id{font-size:11px;color:#ccc;font-family:monospace}
.cr-name{color:#555;font-weight:600}
.cr-time{font-size:11px;color:#ccc;white-space:nowrap}
.btn-return{padding:5px 14px;font-size:12px;background:#fbe9e7;color:#bf360c;border:1px solid #ffccbc;border-radius:20px;cursor:pointer;font-weight:600;transition:background .18s}
.btn-return:hover{background:#f5c6c0}
/* ── Stats bar ── */
.stats-bar{display:flex;gap:12px;padding:12px 24px;background:#fff;border-bottom:1px solid #ede8e2;flex-wrap:wrap}
@media(max-width:560px){.stats-bar{padding:10px 12px;gap:8px}}
.stat-card{flex:1;min-width:100px;background:#fdf9f5;border-radius:14px;padding:12px 16px;border:1px solid #ede8e2;display:flex;align-items:center;gap:12px;transition:box-shadow .2s}
.stat-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.06)}
.stat-icon{font-size:24px;line-height:1}
.stat-info{flex:1;min-width:0}
.stat-label{font-size:11px;color:#aaa;font-weight:600;margin-bottom:2px}
.stat-value{font-size:24px;font-weight:800;color:#7a5c3e;line-height:1}
.stat-unit{font-size:11px;color:#c9a98a;font-weight:600;margin-left:2px}
/* ── Revenue period picker ── */
.rp-btn{font-size:10px;padding:2px 8px;border-radius:8px;border:1px solid #ddd;background:#fff;color:#888;cursor:pointer;transition:all .15s;line-height:1.6}
.rp-btn.rp-active{background:#c9a98a;color:#fff;border-color:#c9a98a;font-weight:600}
.rp-btn:hover:not(.rp-active){background:#f5ede0;border-color:#c9a98a;color:#7a5c3e}
/* ── Admin note ── */
.admin-note-display{margin-top:6px;background:#fffde7;border-left:3px solid #f9a825;padding:6px 10px;border-radius:4px;font-size:12px;color:#5d4037;line-height:1.5}
.note-area{display:none;border-top:1px solid #f0ebe4;padding:10px 12px;background:#fffde7}
.note-area textarea{width:100%;border:1px solid #ddd;border-radius:10px;padding:8px 10px;font-size:13px;resize:vertical;outline:none;font-family:inherit;background:#fff;transition:border-color .18s}
.note-area textarea:focus{border-color:#c9a98a}
.note-area-btns{display:flex;gap:6px;margin-top:6px}
.btn-note-save{background:#c9a98a;color:#fff;border:none;border-radius:10px;padding:7px 16px;font-size:13px;font-weight:700;cursor:pointer;transition:background .18s}
.btn-note-save:hover{background:#b0885e}
.btn-note-cancel{background:#f0ebe4;color:#7a5c3e;border:none;border-radius:10px;padding:7px 14px;font-size:13px;cursor:pointer;transition:background .18s}
.btn-note-cancel:hover{background:#e8dcd0}
/* ── Warehouse ── */
.wh-row{padding:6px 12px;background:#fcfaf8;border-top:1px solid #f0ebe4;display:flex;align-items:center;gap:8px}
.wh-label{font-size:11px;color:#aaa;font-weight:600;white-space:nowrap}
.wh-select{border:1px solid #e0d8d0;border-radius:8px;padding:5px 8px;font-size:12px;background:#fff;outline:none;cursor:pointer;flex:1;transition:border-color .18s}
.wh-select:focus{border-color:#c9a98a}
.wh-badge-ibaraki{display:inline-block;background:#e8f5e9;color:#2e7d32;border-radius:10px;font-size:11px;font-weight:700;padding:1px 7px;margin-left:4px}
.wh-badge-chiba{display:inline-block;background:#e3f2fd;color:#1565c0;border-radius:10px;font-size:11px;font-weight:700;padding:1px 7px;margin-left:4px}
/* ── Empty state ── */
.empty-state{grid-column:1/-1;text-align:center;padding:60px 20px}
.empty-icon{font-size:56px;margin-bottom:16px}
.empty-title{font-size:17px;font-weight:700;color:#bbb;margin-bottom:6px}
.empty-sub{font-size:13px;color:#d0cbc5}
/* ── Toast ── */
.toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#2d2218;color:#fff;padding:11px 22px;border-radius:24px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:999;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.2)}
.toast.show{opacity:1}
/* ── Date modal ── */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;display:none;align-items:center;justify-content:center;backdrop-filter:blur(2px)}
.modal-box{background:#fff;border-radius:20px;padding:28px 24px;width:300px;box-shadow:0 16px 48px rgba(0,0,0,.2)}
.modal-title{font-size:16px;font-weight:700;color:#2d2218;margin-bottom:4px}
.modal-sub{font-size:13px;color:#999;margin-bottom:16px}
.modal-input{width:100%;border:1.5px solid #ddd;border-radius:12px;padding:12px;font-size:18px;outline:none;text-align:center;letter-spacing:4px;font-weight:700;transition:border-color .18s}
.modal-input:focus{border-color:#c9a98a}
.modal-btns{display:flex;gap:10px;margin-top:20px}
.modal-cancel{flex:1;background:#f0ebe4;color:#7a5c3e;border:none;border-radius:12px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;transition:background .18s}
.modal-cancel:hover{background:#e8dcd0}
.modal-ok{flex:1;background:#c9a98a;color:#fff;border:none;border-radius:12px;padding:12px;font-size:14px;font-weight:700;cursor:pointer;transition:background .18s}
.modal-ok:hover{background:#b0885e}
/* ── 訂單商品表格 ── */
.oe-table{width:100%;border-collapse:collapse;font-size:13px}
.oe-table th{background:#f9f3ed;color:#7a5c3e;padding:6px 8px;text-align:center;white-space:nowrap;border-bottom:2px solid #e8dcd0}
.oe-table td{padding:5px 4px;text-align:center;border-bottom:1px solid #f5ede4;vertical-align:middle}
.oe-num{border:1px solid #ddd;border-radius:6px;padding:3px 5px;font-size:13px;text-align:center;outline:none;transition:border-color .18s}
.oe-num:focus{border-color:#c9a98a}
.oe-txt{border:1px solid #ddd;border-radius:6px;padding:3px 5px;font-size:12px;outline:none;transition:border-color .18s}
.oe-txt:focus{border-color:#c9a98a}
.oe-del{background:none;border:none;color:#ccc;font-size:15px;cursor:pointer;padding:2px 6px;border-radius:4px;line-height:1;transition:color .15s,background .15s}
.oe-del:hover{color:#e74c3c;background:#fff0f0}
.oe-add{width:100%;margin-top:8px;background:#f0ebe4;color:#7a5c3e;border:none;border-radius:10px;padding:9px;font-size:13px;font-weight:600;cursor:pointer;transition:background .18s}
.oe-add:hover{background:#e8dcd0}
.src-grl{background:#ff6b9d;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700}
.src-zozo{background:#1a1a2e;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700}
/* ── Mobile ── */
@media(max-width:560px){
  header{padding:0 14px}
  .hdr-logo{font-size:17px}
  .toolbar{padding:8px 12px;gap:6px}
  .toolbar select,.search-box,.btn-refresh{font-size:14px;padding:9px 12px}
  .search-box{min-width:0;flex:1}
  .btn-save{padding:10px 12px;font-size:14px}
  .status-select{font-size:14px;padding:10px 8px}
  .buyer-name{font-size:17px}
  .price-final{font-size:22px}
}
</style>
</head>
<body>
<header>
  <div class="hdr-left">
    <div class="hdr-logo">🌸 Bijin 管理後台 <span style="font-size:11px;color:#c9a98a;font-weight:400">${BUILD_VERSION}</span></div>
    <div class="hdr-counts" id="hdr-counts"><span style="font-size:13px;color:#ccc">載入中…</span></div>
  </div>
  <button class="btn-refresh" onclick="loadOrders()">↻ 重新整理</button>
</header>
<div id="err-bar">
  <span id="err-msg"></span>
  <button onclick="loadOrders()">重試</button>
</div>
<div class="toolbar">
  <select id="filter-status" onchange="renderOrders()">
    <option value="">全部進行中</option>
    <option value="待確認">待確認</option>
    <option value="待買家完成下單">待買家完成下單</option>
    <option value="處理中(待處理或完成官網下單)">處理中</option>
    <option value="已發貨(官網出貨)">已發貨(官網出貨)</option>
    <option value="已發貨(已達台灣海關作業)">已發貨(台灣海關)</option>
    <option value="已發貨(賣貨便出貨)">已發貨(賣貨便)</option>
    <option value="待買家取貨">待買家取貨</option>
  </select>
  <select id="filter-wh" onchange="renderOrders()">
    <option value="">全部倉庫</option>
    <option value="茨城倉">茨城倉</option>
    <option value="千葉倉">千葉倉</option>
    <option value="__none__">未分配</option>
  </select>
  <div class="search-wrap"><span class="search-icon">🔍</span><input class="search-box" id="search-box" placeholder="搜尋姓名 / 手機 / 訂單ID…" oninput="renderOrders()"></div>
  <a href="/admin/members?key=${adminKey}" class="btn-refresh" style="text-decoration:none;background:#7a5c3e">👥 會員管理</a>
</div>
<div class="stats-bar" id="stats-bar">
  <div class="stat-card"><div class="stat-icon">📦</div><div class="stat-info"><div class="stat-label">今日新訂單</div><div class="stat-value" id="stat-today">—</div></div></div>
  <div class="stat-card"><div class="stat-icon">⏳</div><div class="stat-info"><div class="stat-label">待確認</div><div class="stat-value" id="stat-pending" style="color:#e65100">—</div></div></div>
  <div class="stat-card" style="flex-direction:column;align-items:flex-start;gap:6px;min-width:180px">
    <div style="display:flex;align-items:center;gap:12px;width:100%">
      <div class="stat-icon">💰</div>
      <div class="stat-info">
        <div class="stat-label" id="stat-revenue-label">本月營收</div>
        <div class="stat-value" id="stat-revenue" style="font-size:18px">—<span class="stat-unit">NT$</span></div>
        <div style="font-size:10px;color:#bbb;margin-top:1px" id="stat-revenue-count"></div>
      </div>
    </div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;padding-left:36px">
      <button onclick="setRevenuePeriod('month')" id="rpbtn-month" class="rp-btn rp-active">本月</button>
      <button onclick="setRevenuePeriod('year')" id="rpbtn-year" class="rp-btn">本年</button>
      <button onclick="setRevenuePeriod('pick-month')" id="rpbtn-pick-month" class="rp-btn">指定月</button>
      <button onclick="setRevenuePeriod('pick-year')" id="rpbtn-pick-year" class="rp-btn">指定年</button>
    </div>
    <div id="rp-pickers" style="display:none;gap:4px;align-items:center;padding-left:36px;flex-wrap:wrap">
      <select id="rp-year" onchange="renderStats()" style="font-size:11px;padding:2px 6px;border:1px solid #ddd;border-radius:6px;color:#555"></select>
      <select id="rp-month" onchange="renderStats()" style="font-size:11px;padding:2px 6px;border:1px solid #ddd;border-radius:6px;color:#555;display:none"></select>
    </div>
  </div>
  <div class="stat-card"><div class="stat-icon">👥</div><div class="stat-info"><div class="stat-label">總會員數</div><div class="stat-value" id="stat-members">—</div></div></div>
</div>
<div style="background:#fff;border-bottom:1px solid #ede8e2;padding:10px 24px;display:flex;align-items:center;gap:16px;font-size:13px">
  <span style="font-weight:600;color:#555">⚙️ 系統設定</span>
  <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
    <span style="color:#555">🤖 ZOZO 爬蟲</span>
    <input type="checkbox" id="zozo-toggle" ${zozoEnabled ? 'checked' : ''} onchange="toggleZOZO(this)" style="width:36px;height:20px;cursor:pointer;accent-color:#FF6B9D">
    <span id="zozo-status" style="font-weight:600;color:${zozoEnabled ? '#2e7d32' : '#c62828'}">${zozoEnabled ? '開啟 ✅' : '關閉 ❌'}</span>
  </label>
  <span style="color:#ddd">|</span>
  <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
    <span style="color:#555">📣 GAS 庫存推播</span>
    <input type="checkbox" id="gas-notify-toggle" ${gasNotifyEnabled ? 'checked' : ''} onchange="toggleGasNotify(this)" style="width:36px;height:20px;cursor:pointer;accent-color:#7a5c3e">
    <span id="gas-notify-status" style="font-weight:600;color:${gasNotifyEnabled ? '#2e7d32' : '#c62828'}">${gasNotifyEnabled ? '開啟 ✅' : '關閉 ❌'}</span>
  </label>
</div>
<div id="orders"></div>
<details class="sec-closed">
  <summary class="sec-summary">✅ 已完成訂單 <span id="cnt-done" style="margin-left:4px;font-size:12px;font-weight:400;color:#c9a98a"></span></summary>
  <div id="done-orders"></div>
</details>
<details class="sec-closed">
  <summary class="sec-summary">🔄 退單訂單 <span id="cnt-return" style="margin-left:4px;font-size:12px;font-weight:400;color:#bf360c"></span></summary>
  <div id="return-orders"></div>
</details>
<details class="sec-closed">
  <summary class="sec-summary">❌ 已取消訂單 <span id="cnt-cancel" style="margin-left:4px;font-size:12px;font-weight:400;color:#aaa"></span></summary>
  <div id="cancel-orders"></div>
</details>
<div class="toast" id="toast"></div>

<script>
var STATUSES =['待確認','待買家完成下單','處理中(待處理或完成官網下單)','已發貨(官網出貨)','已發貨(已達台灣海關作業)','已發貨(賣貨便出貨)','待買家取貨','已完成','已取消','退單'];
var NOTIFY_STATUSES = {'待買家取貨':1};
var CLOSED = {'已完成':1,'已取消':1,'退單':1};
var STATUS_STYLE = {
  '待確認':'background:#fff3e0;color:#e65100',
  '待買家完成下單':'background:#e3f2fd;color:#1565c0',
  '處理中(待處理或完成官網下單)':'background:#ede7f6;color:#4527a0',
  '已發貨(官網出貨)':'background:#e8f5e9;color:#2e7d32',
  '已發貨(已達台灣海關作業)':'background:#e0f2f1;color:#004d40',
  '已發貨(賣貨便出貨)':'background:#f1f8e9;color:#33691e',
  '待買家取貨':'background:#fce4ec;color:#880e4f',
  '已完成':'background:#f3e5f5;color:#6a1b9a',
  '已取消':'background:#fafafa;color:#aaa;border:1px solid #eee',
  '退單':'background:#fbe9e7;color:#bf360c',
};
function sbadge(s) {
  var st = STATUS_STYLE[s] || 'background:#eee;color:#666';
  return '<span class="sbadge" style="' + st + '">' + (s||'待確認') + '</span>';
}
var allOrders = ${ssrOrdersJson};
var SSR_ERROR = '${ssrError.replace(/'/g, "\\'")}';
var KEY = '${adminKey}';
var MEMBER_COUNT = ${ssrMemberCount};
var revenuePeriod = 'month';

function toggleZOZO(cb) {
  var val = cb.checked ? 'true' : 'false';
  fetch('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, setting: 'zozo_enabled', value: val }),
  }).then(function(r) { return r.json(); }).then(function(d) {
    var el = document.getElementById('zozo-status');
    if (d.ok) {
      el.textContent = cb.checked ? '開啟 ✅' : '關閉 ❌';
      el.style.color  = cb.checked ? '#2e7d32' : '#c62828';
    } else {
      cb.checked = !cb.checked;
      showErr('設定更新失敗: ' + (d.error || ''));
    }
  }).catch(function() { cb.checked = !cb.checked; showErr('網路錯誤'); });
}

function toggleGasNotify(cb) {
  var val = cb.checked ? 'true' : 'false';
  fetch('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY, setting: 'gas_notify_enabled', value: val }),
  }).then(function(r) { return r.json(); }).then(function(d) {
    var el = document.getElementById('gas-notify-status');
    if (d.ok) {
      el.textContent = cb.checked ? '開啟 ✅' : '關閉 ❌';
      el.style.color  = cb.checked ? '#2e7d32' : '#c62828';
    } else {
      cb.checked = !cb.checked;
      showErr('設定更新失敗: ' + (d.error || ''));
    }
  }).catch(function() { cb.checked = !cb.checked; showErr('網路錯誤'); });
}

function showErr(msg) {
  var bar = document.getElementById('err-bar');
  document.getElementById('err-msg').textContent = msg;
  bar.style.display = 'block';
}
function hideErr() {
  document.getElementById('err-bar').style.display = 'none';
}

function onLoadError(msg) {
  console.error('[Admin] loadOrders error:', msg);
  document.getElementById('hdr-counts').innerHTML = '<span style="font-size:13px;color:#c0392b">載入失敗</span>';
  showErr('載入失敗：' + msg + '　請按右上角重新整理');
}
function loadOrders() {
  hideErr();
  document.getElementById('hdr-counts').innerHTML = '<span style="font-size:13px;color:#ccc">載入中…</span>';
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/admin/orders?key=' + KEY + '&_=' + Date.now(), true);
  xhr.timeout = 8000;
  xhr.onload = function() {
    if (xhr.status === 200) {
      try {
        var d = JSON.parse(xhr.responseText);
        allOrders = d.orders || [];
        renderOrders();
      } catch(e) {
        onLoadError('JSON解析失敗：' + e.message);
      }
    } else {
      onLoadError('HTTP ' + xhr.status);
    }
  };
  xhr.onerror = function() { onLoadError('網路連線錯誤'); };
  xhr.ontimeout = function() { onLoadError('逾時 8 秒，請重新整理'); };
  xhr.send();
}

function renderOrders() {
  var keyword = (document.getElementById('search-box').value || '').trim().toLowerCase();
  var filter = document.getElementById('filter-status').value;
  var active = allOrders.filter(function(o){ return !CLOSED[o.status]; });
  var done = allOrders.filter(function(o){ return o.status === '已完成'; });
  var returns = allOrders.filter(function(o){ return o.status === '退單'; });
  var cancelled = allOrders.filter(function(o){ return o.status === '已取消'; });

  var filterWh = document.getElementById('filter-wh').value;
  var list = active;
  if (filter) list = list.filter(function(o){ return o.status === filter; });
  if (filterWh === '__none__') list = list.filter(function(o){ return !(o.warehouse||''); });
  else if (filterWh) list = list.filter(function(o){ return o.warehouse === filterWh; });
  if (keyword) list = list.filter(function(o){ return (o.buyerName||'').toLowerCase().indexOf(keyword) >= 0 || (o.lineDisplayName||'').toLowerCase().indexOf(keyword) >= 0 || (o.orderId||'').toLowerCase().indexOf(keyword) >= 0 || (o.phone||'').indexOf(keyword) >= 0; });

  // header counts
  var pills = '<span class="hdr-pill pill-active">' + active.length + ' 進行中</span>';
  if (done.length) pills += '<span class="hdr-pill pill-done">' + done.length + ' 已完成</span>';
  if (returns.length) pills += '<span class="hdr-pill pill-return">' + returns.length + ' 退單</span>';
  if (cancelled.length) pills += '<span class="hdr-pill pill-cancel">' + cancelled.length + ' 已取消</span>';
  document.getElementById('hdr-counts').innerHTML = pills;

  // section counts
  document.getElementById('cnt-done').textContent = done.length ? done.length + ' 筆' : '';
  document.getElementById('cnt-return').textContent = returns.length ? returns.length + ' 筆' : '';
  document.getElementById('cnt-cancel').textContent = cancelled.length ? cancelled.length + ' 筆' : '';

  // active orders grid
  var container = document.getElementById('orders');
  if (list.length === 0) {
    var emptyIcon = keyword || filter || filterWh ? '🔍' : '🎉';
    var emptyTitle = keyword || filter || filterWh ? '沒有符合條件的訂單' : '目前沒有進行中的訂單';
    var emptySub = keyword || filter || filterWh ? '試試其他搜尋條件' : '新訂單會在這裡顯示';
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">' + emptyIcon + '</div><div class="empty-title">' + emptyTitle + '</div><div class="empty-sub">' + emptySub + '</div></div>';
  } else {
    var html = '';
    for (var i = 0; i < list.length; i++) html += createCard(list[i]);
    container.innerHTML = html;
  }

  // closed sections
  var emptyMsg = '<div style="color:#ccc;padding:14px 20px;font-size:13px">';
  document.getElementById('done-orders').innerHTML = done.length ? done.map(function(o){ return closedRow(o, true); }).join('') : emptyMsg + '無已完成訂單</div>';
  document.getElementById('return-orders').innerHTML = returns.length ? returns.map(function(o){ return closedRow(o, false); }).join('') : emptyMsg + '無退單訂單</div>';
  document.getElementById('cancel-orders').innerHTML = cancelled.length ? cancelled.map(function(o){ return closedRow(o, false); }).join('') : emptyMsg + '無已取消訂單</div>';

  renderStats();
}

function setRevenuePeriod(p) {
  revenuePeriod = p;
  ['month','year','pick-month','pick-year'].forEach(function(id) {
    var btn = document.getElementById('rpbtn-' + id);
    if (btn) btn.className = 'rp-btn' + (id === p ? ' rp-active' : '');
  });
  var pickers = document.getElementById('rp-pickers');
  var monthSel = document.getElementById('rp-month');
  if (p === 'pick-month' || p === 'pick-year') {
    pickers.style.display = 'flex';
    monthSel.style.display = p === 'pick-month' ? '' : 'none';
  } else {
    pickers.style.display = 'none';
  }
  renderStats();
}

function initRevenuePickers() {
  var now = new Date();
  var twStr = now.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  var parts = twStr.split('/');
  var currentYear = parseInt(parts[0]);
  var currentMonth = parseInt(parts[1]);
  var years = {};
  allOrders.forEach(function(o) {
    var y = (o.orderTime||'').split('/')[0];
    if (y && /^\d{4}$/.test(y)) years[parseInt(y)] = 1;
  });
  years[currentYear] = 1;
  var sortedYears = Object.keys(years).map(Number).sort(function(a,b){return b-a;});
  var yearSel = document.getElementById('rp-year');
  sortedYears.forEach(function(y) {
    var opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y + '年';
    if (y === currentYear) opt.selected = true;
    yearSel.appendChild(opt);
  });
  var monthSel = document.getElementById('rp-month');
  for (var m = 1; m <= 12; m++) {
    var opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m + '月';
    if (m === currentMonth) opt.selected = true;
    monthSel.appendChild(opt);
  }
}

function renderStats() {
  var now = new Date();
  var todayStr = now.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  var parts = todayStr.split('/');
  var thisYearStr = parts[0];
  var thisMonthStr = parts[0] + '/' + parts[1];
  var todayNew = allOrders.filter(function(o){ return (o.orderTime||'').startsWith(todayStr); }).length;
  var pending = allOrders.filter(function(o){ return o.status === '待確認'; }).length;

  var filterStr, label;
  if (revenuePeriod === 'year') {
    filterStr = thisYearStr;
    label = thisYearStr + ' 年度營收';
  } else if (revenuePeriod === 'pick-month') {
    var pyEl = document.getElementById('rp-year');
    var pmEl = document.getElementById('rp-month');
    filterStr = (pyEl ? pyEl.value : thisYearStr) + '/' + (pmEl ? pmEl.value : parts[1]);
    label = filterStr + ' 營收';
  } else if (revenuePeriod === 'pick-year') {
    var pyEl2 = document.getElementById('rp-year');
    filterStr = pyEl2 ? pyEl2.value : thisYearStr;
    label = filterStr + ' 年度營收';
  } else {
    filterStr = thisMonthStr;
    label = '本月營收';
  }

  var completedFiltered = allOrders.filter(function(o){ return o.status === '已完成' && (o.orderTime||'').startsWith(filterStr); });
  var revenue = completedFiltered.reduce(function(s, o){ return s + (o.finalAmount || 0); }, 0);

  document.getElementById('stat-today').textContent = todayNew;
  var pEl = document.getElementById('stat-pending');
  pEl.textContent = pending;
  pEl.style.color = pending > 0 ? '#e65100' : '#7a5c3e';
  document.getElementById('stat-revenue').innerHTML = revenue.toLocaleString() + '<span class="stat-unit"> NT$</span>';
  var labelEl = document.getElementById('stat-revenue-label');
  if (labelEl) labelEl.textContent = label;
  var countEl = document.getElementById('stat-revenue-count');
  if (countEl) countEl.textContent = completedFiltered.length + ' 筆已完成';
  document.getElementById('stat-members').textContent = MEMBER_COUNT;
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

var PB_MAP = {'待確認':0,'待買家完成下單':1,'處理中(待處理或完成官網下單)':2,'已發貨(官網出貨)':3,'已發貨(已達台灣海關作業)':4,'已發貨(賣貨便出貨)':5,'待買家取貨':6};
var PB_LABELS = ['確認','下單','處理','官出','海關','賣貨','取貨'];
function progressBar(status) {
  var step = PB_MAP[status];
  if (step === undefined) return '';
  var pct = Math.round(step / 6 * 100);
  var dots = PB_LABELS.map(function(l, i) {
    var cls = i < step ? 'pb-dot pb-done' : i === step ? 'pb-dot pb-curr' : 'pb-dot';
    var lCls = i === step ? 'pb-lbl pb-lbl-curr' : 'pb-lbl';
    return '<div class="pb-step"><div class="' + cls + '"></div><div class="' + lCls + '">' + l + '</div></div>';
  }).join('');
  return '<div class="pb-wrap"><div class="pb-track"><div class="pb-fill" style="width:' + pct + '%"></div></div><div class="pb-row">' + dots + '</div></div>';
}

function whBorderStyle(wh) {
  if (wh === '茨城倉') return 'border-top:3px solid #66bb6a';
  if (wh === '千葉倉') return 'border-top:3px solid #42a5f5';
  return '';
}
function whBadgeHtml(wh) {
  if (wh === '茨城倉') return '<span class="wh-badge-ibaraki">★茨城倉</span>';
  if (wh === '千葉倉') return '<span class="wh-badge-chiba">★千葉倉</span>';
  return '';
}
function createCard(o) {
  var ri = o.rowIndex;
  var wh = o.warehouse || '';
  var opts = STATUSES.map(function(s){
    return '<option value="' + esc(s) + '"' + (o.status === s ? ' selected' : '') + '>' + esc(s) + '</option>';
  }).join('');
  var whOpts = ['', '茨城倉', '千葉倉'].map(function(w){
    return '<option value="' + w + '"' + (wh === w ? ' selected' : '') + '>' + (w || '未分配') + '</option>';
  }).join('');

  var itemsHtml = (o.items||'').split('\\n').map(function(l){
    var badges = '';
    var text = l;
    if (text.indexOf('【預購】') >= 0) {
      badges += '<span style="background:#fff3e0;color:#e65100;font-size:10px;font-weight:700;border-radius:3px;padding:1px 5px;margin-right:4px;border:1px solid #ffcc80">預購</span>';
      text = text.replace('【預購】', '');
    }
    if (text.indexOf('【ZOZO】') >= 0) {
      badges += '<span style="background:#1a1a2e;color:#fff;font-size:10px;font-weight:700;border-radius:3px;padding:1px 5px;margin-right:4px">ZOZO</span>';
      text = text.replace('【ZOZO】', '');
    } else if (text.indexOf('【GRL】') >= 0) {
      badges += '<span style="background:#ff6b9d;color:#fff;font-size:10px;font-weight:700;border-radius:3px;padding:1px 5px;margin-right:4px">GRL</span>';
      text = text.replace('【GRL】', '');
    }
    return '<div>' + badges + esc(text) + '</div>';
  }).join('');

  var priceHtml = '<div class="price-row"><span class="price-final">NT$' + (o.discountTotal > 0 ? o.finalAmount : o.total) + '</span>';
  if (o.discountTotal > 0) {
    priceHtml += '<span class="price-orig">NT$' + o.total + '</span>';
    var discParts = [];
    if (o.pointsUsed > 0) discParts.push('點數 -' + o.pointsUsed);
    if (o.couponCode) discParts.push('券 -' + (o.discountTotal - o.pointsUsed));
    if (discParts.length) priceHtml += '<span class="price-disc">' + discParts.join(' / ') + '</span>';
  }
  priceHtml += '</div>';

  var contactHtml = '';
  if (o.contact) contactHtml += '<div class="info-row"><span class="info-label">聯繫</span>' + esc(o.contact) + (o.contactId ? '　' + esc(o.contactId) : '') + '</div>';
  if (o.phone) contactHtml += '<div class="info-row"><span class="info-label">手機</span>' + esc(o.phone) + '</div>';
  if (o.note) contactHtml += '<div class="info-row"><span class="info-label">客備</span>' + esc(o.note) + '</div>';
  if (o.adminNote) contactHtml += '<div class="admin-note-display">📝 ' + esc(o.adminNote) + '</div>';

  var notifyRowHtml = '';
  if ((o.status||'待確認') === '待確認') {
    notifyRowHtml = '<div class="notify-row" id="nrow-' + ri + '" style="display:flex">'
      + '<input type="url" id="nurl-' + ri + '" placeholder="貼上賣貨便網址…">'
      + '<button class="btn-send" onclick="sendNotify(\\'' + esc(o.orderId) + '\\',' + ri + ')">傳送網址</button>'
      + '</div>';
  }

  return '<div class="order-card" id="card-' + ri + '" style="' + whBorderStyle(wh) + '">'
    + '<div class="card-top">'
    + '<div class="card-id">' + esc(o.orderId) + whBadgeHtml(wh) + '</div>'
    + '<div class="card-time">' + esc(o.orderTime) + '</div>'
    + '</div>'
    + '<div class="card-status">' + sbadge(o.status||'待確認') + '</div>'
    + progressBar(o.status||'待確認')
    + '<div class="card-body">'
    + '<div class="buyer-name">' + esc(o.buyerName||'（未填姓名）') + '</div>'
    + (o.lineDisplayName ? '<div class="line-name">LINE：' + esc(o.lineDisplayName) + '</div>' : '')
    + '<div class="order-items">' + itemsHtml + '</div>'
    + priceHtml
    + contactHtml
    + '</div>'
    + '<hr class="card-divider">'
    + '<div class="wh-row"><span class="wh-label">🏭 倉庫</span><select class="wh-select" id="wsel-' + ri + '" onchange="saveWarehouse(' + ri + ')">' + whOpts + '</select></div>'
    + '<div class="card-footer">'
    + '<select class="status-select" id="sel-' + ri + '">' + opts + '</select>'
    + '<button class="btn-save" onclick="saveStatus(' + ri + ',\\'' + esc(o.orderId) + '\\')">儲存</button>'
    + '<button class="btn-save" style="background:#f5c97a;color:#5d4037;padding:7px 10px" title="內部備註" onclick="toggleNote(' + ri + ')">📝</button>'
    + '<button class="btn-save" style="background:#7ab8f5;color:#fff;padding:7px 10px" title="修改訂單商品" onclick="openOrderEdit(' + ri + ')">✏️</button>'
    + '</div>'
    + notifyRowHtml
    + '<div class="note-area" id="note-area-' + ri + '">'
    + '<textarea id="note-input-' + ri + '" rows="2" placeholder="輸入內部備註（不會通知買家）">' + esc(o.adminNote||'') + '</textarea>'
    + '<div class="note-area-btns">'
    + '<button class="btn-note-save" onclick="saveNote(' + ri + ')">儲存備註</button>'
    + '<button class="btn-note-cancel" onclick="toggleNote(' + ri + ')">取消</button>'
    + '</div>'
    + '</div>'
    + '</div>';
}

function closedRow(o, showReturn) {
  var returnBtn = showReturn
    ? '<button class="btn-return" onclick="doReturn(' + o.rowIndex + ',\\'' + esc(o.orderId) + '\\')">退單</button>'
    : '';
  return '<div class="closed-row">'
    + '<div class="cr-left">'
    + '<span class="cr-id">' + esc(o.orderId) + '</span>'
    + sbadge(o.status)
    + '<span class="cr-name">' + esc(o.buyerName||'—') + '</span>'
    + returnBtn
    + '</div>'
    + '<div class="cr-time">' + esc(o.orderTime) + '</div>'
    + '</div>';
}

async function saveStatus(rowIndex, orderId) {
  var status = document.getElementById('sel-' + rowIndex).value;
  if (NOTIFY_STATUSES[status]) {
    showDateModal(rowIndex, orderId, status);
    return;
  }
  try {
    var r = await fetch('/api/admin/order-status', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, rowIndex: rowIndex, status: status }),
    });
    if (r.ok) {
      var o = allOrders.find(function(x){ return x.rowIndex === rowIndex; });
      if (o) o.status = status;
      toast('✅ 狀態已更新');
      renderOrders();
    } else {
      var d = await r.json();
      toast('❌ ' + (d.error || '更新失敗'));
    }
  } catch(e) { toast('❌ 網路錯誤'); }
}

async function saveWarehouse(rowIndex) {
  var wh = document.getElementById('wsel-' + rowIndex).value;
  try {
    var r = await fetch('/api/admin/order-warehouse', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, rowIndex: rowIndex, warehouse: wh }),
    });
    if (r.ok) {
      var o = allOrders.find(function(x){ return x.rowIndex === rowIndex; });
      if (o) o.warehouse = wh;
      var card = document.getElementById('card-' + rowIndex);
      if (card) {
        card.style.borderTop = wh === '茨城倉' ? '3px solid #66bb6a' : wh === '千葉倉' ? '3px solid #42a5f5' : '';
        var badge = card.querySelector('.card-id');
        if (badge) {
          badge.innerHTML = badge.innerHTML.replace(/<span class="wh-badge[^"]*"[^>]*>.*?<\\/span>/g, '') + whBadgeHtml(wh);
        }
      }
      toast('✅ 倉庫：' + (wh || '未分配'));
    } else { toast('❌ 儲存失敗'); }
  } catch(e) { toast('❌ 網路錯誤'); }
}

async function sendNotify(orderId, rowIndex) {
  var url = document.getElementById('nurl-' + rowIndex).value.trim();
  if (!url) { toast('請貼上賣貨便網址'); return; }
  try {
    var r = await fetch('/admin/notify-buyer?key=' + KEY + '&orderId=' + encodeURIComponent(orderId) + '&url=' + encodeURIComponent(url));
    var d = await r.json();
    if (r.ok) {
      var o = allOrders.find(function(x){ return x.rowIndex === rowIndex; });
      if (o) o.status = '待買家完成下單';
      toast('✅ ' + (d.message || '已傳送'));
      renderOrders();
    } else toast('❌ ' + (d.error || '失敗'));
  } catch(e) { toast('❌ 網路錯誤'); }
}

async function doReturn(rowIndex, orderId) {
  if (!confirm('確定要將此訂單標記為退單？\\n將自動執行：\\n・撤銷本單計得點數\\n・退還結帳折抵的點數\\n・回扣年度消費並重算等級\\n・收回邀請獎勵優惠券（若有）')) return;
  try {
    var r = await fetch('/api/admin/order-status', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, rowIndex: rowIndex, status: '退單' }),
    });
    if (r.ok) {
      var o = allOrders.find(function(x){ return x.rowIndex === rowIndex; });
      if (o) o.status = '退單';
      toast('✅ 已標記退單，點數已扣除');
      renderOrders();
    } else {
      var d = await r.json();
      toast('❌ ' + (d.error || '失敗'));
    }
  } catch(e) { toast('❌ 網路錯誤'); }
}

var _dateCtx = null;
function showDateModal(rowIndex, orderId, status) {
  _dateCtx = { rowIndex: rowIndex, orderId: orderId, status: status };
  document.getElementById('dm-status').textContent = status;
  var now = new Date();
  var mm = String(now.getMonth()+1).padStart(2,'0');
  var dd = String(now.getDate()).padStart(2,'0');
  document.getElementById('dm-input').value = mm + '/' + dd;
  document.getElementById('date-modal').style.display = 'flex';
  setTimeout(function(){ document.getElementById('dm-input').select(); }, 50);
}
function closeDateModal() {
  document.getElementById('date-modal').style.display = 'none';
  _dateCtx = null;
}
async function confirmDateModal() {
  var date = document.getElementById('dm-input').value.trim();
  if (!date) { toast('請輸入日期'); return; }
  var ctx = _dateCtx;
  document.getElementById('date-modal').style.display = 'none';
  try {
    var r = await fetch('/api/admin/notify-progress', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, orderId: ctx.orderId, rowIndex: ctx.rowIndex, status: ctx.status, date: date }),
    });
    var d = await r.json();
    if (r.ok) {
      var o = allOrders.find(function(x){ return x.rowIndex === ctx.rowIndex; });
      if (o) o.status = ctx.status;
      toast('✅ 狀態已更新並通知買家');
      renderOrders();
    } else toast('❌ ' + (d.error || '失敗'));
  } catch(e) { toast('❌ 網路錯誤'); }
}

function toggleNote(rowIndex) {
  var area = document.getElementById('note-area-' + rowIndex);
  if (!area) return;
  var isOpen = area.style.display === 'block';
  area.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    var inp = document.getElementById('note-input-' + rowIndex);
    if (inp) inp.focus();
  }
}

async function saveNote(rowIndex) {
  var inp = document.getElementById('note-input-' + rowIndex);
  if (!inp) return;
  var noteText = inp.value;
  try {
    var r = await fetch('/api/admin/order-note', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ key: KEY, rowIndex: rowIndex, adminNote: noteText }),
    });
    var d = await r.json();
    if (!r.ok) { toast('❌ ' + (d.error || '儲存失敗')); return; }
    var o = allOrders.find(function(x){ return x.rowIndex === rowIndex; });
    if (o) o.adminNote = noteText;
    document.getElementById('note-area-' + rowIndex).style.display = 'none';
    renderOrders();
    toast('✅ 備註已儲存');
  } catch(e) { toast('❌ 網路錯誤'); }
}

function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, 2800);
}

// 初始渲染：資料已由伺服器端嵌入，直接呈現
if (SSR_ERROR) {
  showErr('伺服器載入失敗：' + SSR_ERROR + '　請按右上角重新整理');
  document.getElementById('hdr-counts').innerHTML = '<span style="font-size:13px;color:#c0392b">載入失敗</span>';
} else {
  initRevenuePickers();
  renderOrders();
}

// ── 訂單編輯 ──
var oeOrder = null;
function parseItemLine(line) {
  var stripped = line.replace(/^【預購】/, '').trim(); // 去掉預購前綴
  var sm = stripped.match(/^【(GRL|ZOZO)】/);
  var source = sm ? sm[1] : 'GRL';
  var rest = sm ? stripped.slice(sm[0].length).trim() : stripped;
  var pm = rest.match(/NT[$](\\d+)/);
  var qm = rest.match(/×(\\d+)/);
  if (!pm) return null; // 完全無法解析的行（如「共 N 件」已被 filter 掉，但保留這道防線）
  var price = parseInt(pm[1]);
  var qty = qm ? parseInt(qm[1]) : 1;
  var beforePrice = rest.slice(0, rest.indexOf('NT$')).trim();
  var spIdx = beforePrice.indexOf(' ');
  var productId = spIdx >= 0 ? beforePrice.slice(0, spIdx) : beforePrice;
  var colorSize = spIdx >= 0 ? beforePrice.slice(spIdx + 1).trim() : '';
  return { source: source, productId: productId, colorSize: colorSize, price: price, qty: qty };
}
function srcBadge(s) {
  return s === 'GRL' ? '<span class="src-grl">GRL</span>' : '<span class="src-zozo">ZOZO</span>';
}
function renderItemRow(item) {
  var ds = (item.source||'').replace(/"/g,'&quot;');
  var dp = (item.productId||'').replace(/"/g,'&quot;');
  var dc = (item.colorSize||'').replace(/"/g,'&quot;');
  return '<tr data-source="' + ds + '" data-pid="' + dp + '" data-cs="' + dc + '">'
    + '<td>' + srcBadge(item.source) + '</td>'
    + '<td style="font-size:12px">' + esc(item.productId) + '</td>'
    + '<td style="font-size:12px;text-align:left">' + esc(item.colorSize) + '</td>'
    + '<td>NT$<input type="number" class="oe-num oe-price" value="' + item.price + '" min="0" step="1" style="width:68px" oninput="calcOrderTotal()"></td>'
    + '<td>\xd7<input type="number" class="oe-num oe-qty" value="' + item.qty + '" min="1" max="99" style="width:44px" oninput="calcOrderTotal()"></td>'
    + '<td><button class="oe-del" onclick="removeItemRow(this)" title="刪除">✕</button></td>'
    + '</tr>';
}
function renderNewRow() {
  return '<tr data-new="1">'
    + '<td><select class="nr-src" style="font-size:12px;border:1px solid #ddd;border-radius:6px;padding:2px 3px"><option>GRL</option><option>ZOZO</option></select></td>'
    + '<td><input type="text" class="oe-txt nr-pid" placeholder="商品ID" style="width:65px"></td>'
    + '<td><input type="text" class="oe-txt nr-cs" placeholder="顏色 尺寸" style="width:90px"></td>'
    + '<td>NT$<input type="number" class="oe-num oe-price" value="" min="0" step="1" style="width:68px" oninput="calcOrderTotal()"></td>'
    + '<td>\xd7<input type="number" class="oe-num oe-qty" value="1" min="1" max="99" style="width:44px" oninput="calcOrderTotal()"></td>'
    + '<td><button class="oe-del" onclick="removeItemRow(this)" title="刪除">✕</button></td>'
    + '</tr>';
}
function openOrderEdit(ri) {
  oeOrder = allOrders.find(function(x){ return x.rowIndex === ri; });
  if (!oeOrder) return;
  document.getElementById('oe-row').value = oeOrder.rowIndex;
  var raw = oeOrder.items || '';
  console.log('[openOrderEdit] items JSON:', JSON.stringify(raw.substring(0, 300)));
  var lines = raw.split('\\n').filter(function(l){ return l.trim() && !l.match(/^共\\s*\\d+/); });
  console.log('[openOrderEdit] lines:', lines);
  var tbody = document.getElementById('oe-tbody');
  tbody.innerHTML = lines.map(function(l) {
    var item = parseItemLine(l);
    console.log('[parseItemLine]', JSON.stringify(l.substring(0, 60)), '->', item);
    return item ? renderItemRow(item) : '';
  }).join('');
  calcOrderTotal();
  document.getElementById('order-edit-modal').style.display = 'flex';
}
function closeOrderEdit() {
  document.getElementById('order-edit-modal').style.display = 'none';
  oeOrder = null;
}
function addItemRow() {
  document.getElementById('oe-tbody').insertAdjacentHTML('beforeend', renderNewRow());
}
function removeItemRow(btn) {
  btn.closest('tr').remove();
  calcOrderTotal();
}
function calcOrderTotal() {
  var total = 0, qty = 0;
  document.querySelectorAll('#oe-tbody tr').forEach(function(tr) {
    var p = parseInt((tr.querySelector('.oe-price')||{}).value) || 0;
    var q = parseInt((tr.querySelector('.oe-qty')||{}).value) || 0;
    total += p * q; qty += q;
  });
  document.getElementById('oe-subtotal').textContent = 'NT$' + total;
  var disc = oeOrder ? (oeOrder.discountTotal || 0) : 0;
  if (disc > 0) {
    var fin = Math.max(total - disc, 0);
    document.getElementById('oe-discount-row').style.display = '';
    document.getElementById('oe-discount').textContent = '-NT$' + disc;
    document.getElementById('oe-final-row').style.display = '';
    document.getElementById('oe-final').textContent = 'NT$' + fin;
  } else {
    document.getElementById('oe-discount-row').style.display = 'none';
    document.getElementById('oe-final-row').style.display = 'none';
  }
  return { total: total, qty: qty };
}
async function saveOrderEdit() {
  var rowIndex = parseInt(document.getElementById('oe-row').value);
  var lines = [], totalPrice = 0, totalQty = 0, valid = true;
  document.querySelectorAll('#oe-tbody tr').forEach(function(tr) {
    var isNew = tr.getAttribute('data-new') === '1';
    var source, productId, colorSize;
    if (isNew) {
      source = (tr.querySelector('.nr-src')||{}).value || 'GRL';
      productId = ((tr.querySelector('.nr-pid')||{}).value || '').trim();
      colorSize = ((tr.querySelector('.nr-cs')||{}).value || '').trim();
      if (!productId) { valid = false; return; }
    } else {
      source = tr.getAttribute('data-source') || 'GRL';
      productId = tr.getAttribute('data-pid') || '';
      colorSize = tr.getAttribute('data-cs') || '';
    }
    var price = parseInt((tr.querySelector('.oe-price')||{}).value) || 0;
    var qty = parseInt((tr.querySelector('.oe-qty')||{}).value) || 1;
    lines.push('【' + source + '】' + productId + (colorSize ? ' ' + colorSize : '') + ' NT$' + price + ' \xd7' + qty);
    totalPrice += price * qty; totalQty += qty;
  });
  if (!valid || lines.length === 0) { toast('請填寫完整商品資料'); return; }
  var itemsText = lines.join('\\n') + '\\n共 ' + totalQty + ' 件';
  try {
    var r = await fetch('/api/admin/order-edit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: KEY, rowIndex: rowIndex, items: itemsText, totalTwd: totalPrice })
    });
    var d = await r.json();
    if (!r.ok) { toast('失敗：' + (d.error || r.status)); return; }
    oeOrder.items = itemsText;
    oeOrder.total = d.totalTwd;
    oeOrder.finalAmount = d.finalAmount;
    renderOrders();
    closeOrderEdit();
    toast('已更新訂單商品');
  } catch(e) { toast('錯誤：' + e.message); }
}
</script>

<!-- 訂單編輯 Modal -->
<div id="order-edit-modal" class="modal-overlay" onclick="if(event.target===this)closeOrderEdit()">
  <div class="modal-box" style="width:600px;max-width:96vw">
    <div class="modal-title">✏️ 修改訂單商品</div>
    <input type="hidden" id="oe-row">
    <div style="overflow-x:auto">
      <table class="oe-table">
        <thead>
          <tr><th>來源</th><th>商品ID</th><th style="text-align:left">顏色／尺寸</th><th>單價</th><th>數量</th><th></th></tr>
        </thead>
        <tbody id="oe-tbody"></tbody>
      </table>
    </div>
    <button class="oe-add" onclick="addItemRow()">＋ 新增商品</button>
    <div style="margin-top:10px;font-size:13px;color:#555;display:flex;flex-direction:column;gap:4px">
      <div>小計：<strong id="oe-subtotal" style="color:#c9a98a">NT$0</strong></div>
      <div id="oe-discount-row" style="display:none;color:#888;font-size:12px">折扣：<span id="oe-discount"></span></div>
      <div id="oe-final-row" style="display:none;font-weight:700;color:#7a5c3e">實付：<span id="oe-final"></span></div>
    </div>
    <div class="modal-btns" style="margin-top:16px">
      <button class="modal-cancel" onclick="closeOrderEdit()">取消</button>
      <button class="modal-ok" onclick="saveOrderEdit()">儲存</button>
    </div>
  </div>
</div>

<div id="date-modal" class="modal-overlay" onclick="if(event.target===this)closeDateModal()">
  <div class="modal-box">
    <div class="modal-title">輸入進度日期</div>
    <div class="modal-sub">狀態：<strong id="dm-status" style="color:#7a5c3e"></strong></div>
    <input id="dm-input" class="modal-input" type="text" placeholder="MM/DD" maxlength="5"
      onkeydown="if(event.key==='Enter')confirmDateModal()">
    <div class="modal-btns">
      <button class="modal-cancel" onclick="closeDateModal()">取消</button>
      <button class="modal-ok" onclick="confirmDateModal()">確定並通知買家</button>
    </div>
  </div>
</div>
</body>
</html>`);
});

// ── 管理員：通知買家賣場網址 ──────────────────────────────────────────────────
// 呼叫方式：GET /admin/notify-buyer?key=grl-admin-2026&orderId=XXX&url=https://...
app.get('/admin/notify-buyer', async (req, res) => {
  const { key, orderId, url: storeUrl } = req.query;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!orderId || !storeUrl) return res.status(400).json({ error: 'orderId and url required' });

  try {
    // 從訂單 sheet 找 orderId
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:P` });
    const rows = resp.data.values || [];
    const orderRow = rows.find((r) => r[0] === orderId);
    if (!orderRow) return res.status(404).json({ error: `找不到訂單 ${orderId}` });

    const orderRowIndex = rows.indexOf(orderRow) + 1; // 1-indexed (includes header)
    const buyerUserId   = orderRow[2] || '';
    const buyerName     = orderRow[5] || '';
    const itemsSummary  = orderRow[3] || '';
    const totalTwd      = parseInt(orderRow[4]) || 0;
    const discountTotal = parseInt(orderRow[13]) || 0;
    const finalAmount   = parseInt(orderRow[14]) || totalTwd;
    const displayAmount = discountTotal > 0 ? finalAmount : totalTwd;
    const amountLabel   = discountTotal > 0 ? `實付金額：NT$${displayAmount}（已折 NT$${discountTotal}）` : `合計：NT$${displayAmount}`;

    if (!buyerUserId) return res.status(400).json({ error: '訂單缺少 userId' });

    // Push LINE 訊息給買家
    await lineClient.pushMessage(buyerUserId, {
      type: 'flex',
      altText: '您的訂單賣貨便已建立，請前往下單 🛍',
      contents: {
        type: 'bubble',
        size: 'kilo',
        header: {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#c9a98a',
          paddingAll: '14px',
          contents: [{ type: 'text', text: '🛍 賣貨便已建立！', color: '#ffffff', size: 'md', weight: 'bold' }],
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          paddingAll: '14px',
          contents: [
            { type: 'text', text: `${buyerName} 您好`, size: 'sm', color: '#555555' },
            { type: 'separator', margin: 'sm' },
            { type: 'text', text: itemsSummary, size: 'xs', color: '#888888', wrap: true, margin: 'sm' },
            { type: 'text', text: amountLabel, size: 'sm', weight: 'bold', color: '#c9a98a', margin: 'sm', wrap: true },
            { type: 'separator', margin: 'sm' },
            { type: 'text', text: '請點選下方按鈕前往賣貨便完成下單 👇', size: 'sm', color: '#555555', margin: 'sm', wrap: true },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          paddingAll: '10px',
          contents: [{
            type: 'button',
            style: 'primary',
            color: '#c9a98a',
            height: 'sm',
            action: { type: 'uri', label: '前往賣貨便下單', uri: storeUrl },
          }],
        },
      },
    });

    // 自動更新訂單狀態為「待買家完成下單」
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${ORDER_SHEET}!K${orderRowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [['待買家完成下單']] },
    });

    res.json({ status: 'ok', message: `已通知買家 ${buyerName}（${buyerUserId}）` });
  } catch (err) {
    console.error('[notify-buyer error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 管理員 API：進度通知買家 ──────────────────────────────────────────────────
app.post('/api/admin/notify-progress', express.json(), async (req, res) => {
  const { key, orderId, rowIndex, status, date } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!orderId || !status || !date || !rowIndex) return res.status(400).json({ error: 'Missing fields' });

  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:P` });
    const rows = resp.data.values || [];
    const orderRow = rows.find(r => r[0] === orderId);
    if (!orderRow) return res.status(404).json({ error: `找不到訂單 ${orderId}` });

    const buyerUserId = orderRow[2] || '';
    const buyerName   = orderRow[5] || '';
    const itemsSummary = orderRow[3] || '';
    if (!buyerUserId) return res.status(400).json({ error: '訂單缺少 userId' });

    // 組合進度文字
    let progressLines = '';
    if (status === '處理中(待處理或完成官網下單)') {
      progressLines = `${date} GRL官網下單完成`;
    } else if (status === '已發貨(官網出貨)') {
      progressLines = `${date} GRL官網出貨`;
    } else if (status === '已發貨(已達台灣海關作業)') {
      progressLines = `${date} 已到台灣，過海關中`;
    } else if (status === '已發貨(賣貨便出貨)') {
      progressLines = `${date} 我們這邊已安排出貨囉❤️`;
    } else if (status === '待買家取貨') {
      progressLines = `提醒您～商品已到門市囉！\n${date} 前請記得去取貨唷☺️`;
    }

    const msgText = `您好～🚚商品\n${itemsSummary}\n進度回報：\n${progressLines}`;

    await lineClient.pushMessage(buyerUserId, { type: 'text', text: msgText });

    // 更新訂單狀態
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${ORDER_SHEET}!K${rowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [[status]] },
    });

    res.json({ status: 'ok', message: `已通知 ${buyerName}` });
  } catch (err) {
    console.error('[notify-progress error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API：取得會員資料（LIFF 用，不自動建立）─────────────────────────────────
app.get('/api/member', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const sheets = getSheetsClient();
    const member = await getMember(sheets, userId);
    if (!member) return res.json({ ok: true, registered: false });
    const coupons = await getActiveCoupons(sheets, userId);
    const pointsRows = await getActivePoints(sheets, userId);
    // 餘額以會員表 K 欄為準（deductMemberPoints 直接更新此欄），點數紀錄只用於明細展示
    res.json({ ok: true, registered: true, member, coupons, pointsRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API：取得會員進行中訂單 ──────────────────────────────────────────────────
app.get('/api/member/orders', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:P` });
    const rows = resp.data.values || [];
    const DONE = ['已完成', '已取消', '退單'];
    const orders = rows.slice(1)
      .filter(r => r[2] === userId && !DONE.includes(r[10] || ''))
      .map(r => ({
        orderId: r[0] || '',
        orderTime: r[1] || '',
        items: r[3] || '',
        totalTwd: parseFloat(r[4]) || 0,
        finalAmount: parseFloat(r[14]) || parseFloat(r[4]) || 0,
        pointsUsed: parseInt(r[11]) || 0,
        couponCode: r[12] || '',
        discountAmount: parseFloat(r[13]) || 0,
        status: r[10] || '待確認',
      }))
      .reverse();
    res.json({ ok: true, orders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API：會員註冊 ────────────────────────────────────────────────────────────
app.post('/api/member/register', express.json(), async (req, res) => {
  const { userId, displayName, name, phone, birthday, inviteCode } = req.body;
  if (!userId || !name || !phone || !birthday) return res.status(400).json({ error: '請填寫所有必填欄位' });
  if (!/^09\d{8}$/.test(phone)) return res.status(400).json({ error: '手機號碼格式不正確' });
  if (!/^\d{2}-\d{2}$/.test(birthday)) return res.status(400).json({ error: '生日格式應為 MM-DD' });
  try {
    const sheets = getSheetsClient();
    // 已是會員
    const existing = await getMember(sheets, userId);
    if (existing) return res.status(400).json({ error: '您已是會員' });
    // 手機防重複（掃描 N 欄）
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!N:N` }).catch(() => ({ data: { values: [] } }));
    const phones = (resp.data.values || []).flat();
    if (phones.includes(phone)) return res.status(400).json({ error: '此手機號碼已被註冊' });
    // 驗證邀請碼（若有填）
    let referredByCode = '';
    if (inviteCode) {
      const allMembers = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A:E` });
      const rows = allMembers.data.values || [];
      const inviter = rows.find((r, i) => i > 0 && r[4] === inviteCode.toUpperCase());
      if (!inviter) return res.status(400).json({ error: '邀請碼無效' });
      if (inviter[0] === userId) return res.status(400).json({ error: '不能使用自己的邀請碼' });
      referredByCode = inviteCode.toUpperCase();
    }
    const member = await createMember(sheets, userId, displayName || '', { name, phone, birthday, referredByCode });
    // 入會禮優惠券（防重複：同 userId + type='入會禮' 只發一次）
    const cpnResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!B:D` }).catch(() => ({ data: { values: [] } }));
    const cpnRows = (cpnResp.data.values || []).slice(1);
    const hasWelcomeCoupon = cpnRows.some(r => r[0] === userId && r[2] === '入會禮');
    if (!hasWelcomeCoupon) {
      const expiry = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
      await issueCoupons(sheets, userId, displayName || '', '入會禮', 50, 1, expiry);
    }
    // 邀請紀錄
    if (referredByCode) {
      await ensureReferralSheet(sheets);
      const inviterResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A:E` });
      const inviterRow = (inviterResp.data.values || []).find((r, i) => i > 0 && r[4] === referredByCode);
      const inviterUserId = inviterRow ? inviterRow[0] : '';
      if (inviterUserId) {
        const deadline = new Date(); deadline.setMonth(deadline.getMonth() + 1);
        const deadlineStr = deadline.toISOString().split('T')[0];
        await sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID, range: `${REFERRAL_SHEET}!A1`, valueInputOption: 'RAW',
          resource: { values: [[inviterUserId, userId, referredByCode, todayStr(), deadlineStr, '', 'pending']] },
        });
      }
    }
    res.json({ ok: true, member });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API：更新生日 ─────────────────────────────────────────────────────────────
app.post('/api/member/birthday', express.json(), async (req, res) => {
  const { userId, birthday } = req.body; // birthday: "MM-DD"
  if (!userId || !birthday) return res.status(400).json({ error: 'Missing fields' });
  if (!/^\d{2}-\d{2}$/.test(birthday)) return res.status(400).json({ error: '格式應為 MM-DD' });
  try {
    const sheets = getSheetsClient();
    const member = await getMember(sheets, userId);
    if (!member) return res.status(404).json({ error: '找不到會員' });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!D${member.rowIndex}`,
      valueInputOption: 'RAW', resource: { values: [[birthday]] },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API：綁定邀請碼 ───────────────────────────────────────────────────────────
app.post('/api/member/referral', express.json(), async (req, res) => {
  const { userId, inviteCode } = req.body;
  if (!userId || !inviteCode) return res.status(400).json({ error: 'Missing fields' });
  try {
    const sheets = getSheetsClient();
    const result = await bindReferralCode(sheets, userId, inviteCode.toUpperCase().trim());
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, message: `已成功綁定邀請碼！` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 會員中心 LIFF 頁面 ────────────────────────────────────────────────────────
app.get('/member', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>會員中心 | Bijin</title>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#fdf8f3;min-height:100vh;padding-bottom:40px}
header{background:#c9a98a;color:#fff;padding:20px 16px 16px;text-align:center}
.header-name{font-size:18px;font-weight:bold;margin-bottom:2px}
.header-sub{font-size:12px;opacity:.85}
.tier-badge{display:inline-block;padding:3px 14px;border-radius:20px;font-size:13px;font-weight:bold;margin-top:8px}
.tier-一般{background:#f5ede0;color:#a08060}
.tier-銀卡{background:#e8e8e8;color:#666}
.tier-金卡{background:#fff3cd;color:#a07800}
.tier-白金{background:#e8f0fe;color:#3949ab}
.card{background:#fff;margin:12px;border-radius:14px;padding:16px;box-shadow:0 1px 6px rgba(0,0,0,.07)}
.card-title{font-size:13px;font-weight:bold;color:#c9a98a;margin-bottom:12px;border-bottom:1px solid #f5ede0;padding-bottom:8px}
.stat-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:14px;color:#444;border-bottom:1px solid #faf5ef}
.stat-row:last-child{border-bottom:none}
.stat-val{font-weight:bold;color:#333}
.progress-wrap{margin-top:10px}
.progress-label{font-size:12px;color:#aaa;margin-bottom:4px;display:flex;justify-content:space-between}
.progress-bar{height:6px;background:#f0e8de;border-radius:4px;overflow:hidden}
.progress-fill{height:100%;background:#c9a98a;border-radius:4px;transition:width .4s}
.coupon-item{background:#fff8f0;border:1px dashed #e8c9a0;border-radius:10px;padding:10px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
.coupon-amount{font-size:20px;font-weight:bold;color:#c9a98a}
.coupon-info{font-size:11px;color:#aaa;margin-top:2px}
.coupon-code{font-family:monospace;font-size:11px;color:#bbb}
.ref-code-box{background:#f5ede0;border-radius:10px;padding:14px;text-align:center}
.ref-code{font-size:26px;font-weight:bold;letter-spacing:4px;color:#7a5c3e;margin:6px 0}
.ref-copy-btn{background:#c9a98a;color:#fff;border:none;border-radius:8px;padding:8px 20px;font-size:13px;font-weight:bold;cursor:pointer;margin-top:6px}
.input-row{display:flex;gap:8px;margin-top:10px}
.input-row input{flex:1;border:1px solid #ddd;border-radius:8px;padding:9px 10px;font-size:14px;outline:none;text-transform:uppercase}
.input-row input:focus{border-color:#c9a98a}
.input-row button{background:#c9a98a;color:#fff;border:none;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:bold;cursor:pointer;white-space:nowrap}
.bday-row{display:flex;gap:8px;margin-top:10px;align-items:center}
.bday-row input{flex:1;border:1px solid #ddd;border-radius:8px;padding:9px 10px;font-size:14px;outline:none}
.bday-row input:focus{border-color:#c9a98a}
.bday-row button{background:#c9a98a;color:#fff;border:none;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:bold;cursor:pointer}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:100;white-space:nowrap}
.toast.show{opacity:1}
.empty{text-align:center;color:#ccc;font-size:13px;padding:16px 0}
</style>
</head>
<body>

<!-- ── 未註冊：會員福利 + 加入表單 ── -->
<div id="register-view" style="display:none;padding-bottom:40px">
  <header style="background:#c9a98a;color:#fff;padding:20px 16px;text-align:center">
    <div style="font-size:18px;font-weight:bold">👑 Bijin 會員計畫</div>
    <div style="font-size:12px;opacity:.85;margin-top:4px">加入會員，享受專屬優惠</div>
  </header>

  <!-- 會員福利 -->
  <div style="margin:12px;background:#fff;border-radius:14px;padding:16px;box-shadow:0 1px 6px rgba(0,0,0,.07)">
    <div style="font-size:13px;font-weight:bold;color:#c9a98a;margin-bottom:12px;border-bottom:1px solid #f5ede0;padding-bottom:8px">會員福利一覽</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr style="background:#f5ede0;color:#7a5c3e">
        <th style="padding:8px 6px;text-align:left;border-radius:6px 0 0 6px">等級</th>
        <th style="padding:8px 4px;text-align:center">年消費門檻</th>
        <th style="padding:8px 4px;text-align:center">點數回饋</th>
        <th style="padding:8px 6px;text-align:center;border-radius:0 6px 6px 0">生日禮</th>
      </tr>
      <tr style="border-bottom:1px solid #faf5ef">
        <td style="padding:8px 6px;color:#a08060;font-weight:bold">一般</td>
        <td style="padding:8px 4px;text-align:center;color:#888">免門檻</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$300 / 1點</td>
        <td style="padding:8px 6px;text-align:center;color:#888">NT$30券×1</td>
      </tr>
      <tr style="border-bottom:1px solid #faf5ef">
        <td style="padding:8px 6px;color:#888;font-weight:bold">銀卡</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$3,000</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$200 / 1點</td>
        <td style="padding:8px 6px;text-align:center;color:#888">NT$50券×1</td>
      </tr>
      <tr style="border-bottom:1px solid #faf5ef">
        <td style="padding:8px 6px;color:#a07800;font-weight:bold">金卡</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$6,000</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$100 / 1點</td>
        <td style="padding:8px 6px;text-align:center;color:#888">NT$50券×2</td>
      </tr>
      <tr>
        <td style="padding:8px 6px;color:#3949ab;font-weight:bold">白金</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$12,000</td>
        <td style="padding:8px 4px;text-align:center;color:#888">NT$50 / 1點</td>
        <td style="padding:8px 6px;text-align:center;color:#888">NT$50券×4</td>
      </tr>
    </table>
    <div style="margin-top:12px;padding:10px;background:#fff8f0;border-radius:8px;font-size:12px;color:#888;line-height:1.6">
      🎟 <strong style="color:#c9a98a">邀請好友</strong>：好友完成首筆訂單，雙方各獲 NT$50 折扣券 × 2 張<br>
      🪙 <strong style="color:#c9a98a">1點 = NT$1</strong>：結帳時直接折抵
    </div>
  </div>

  <!-- 加入會員表單 -->
  <div style="margin:12px;background:#fff;border-radius:14px;padding:16px;box-shadow:0 1px 6px rgba(0,0,0,.07)">
    <div style="font-size:13px;font-weight:bold;color:#c9a98a;margin-bottom:14px;border-bottom:1px solid #f5ede0;padding-bottom:8px">加入會員</div>
    <label style="display:block;font-size:12px;color:#888;margin-bottom:4px">姓名 *</label>
    <input id="reg-name" type="text" placeholder="請輸入真實姓名" style="width:100%;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;margin-bottom:12px;outline:none">
    <label style="display:block;font-size:12px;color:#888;margin-bottom:4px">手機號碼 * <span style="font-size:11px;color:#bbb">（每支手機只能綁一個帳號）</span></label>
    <input id="reg-phone" type="tel" placeholder="09xxxxxxxx" style="width:100%;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;margin-bottom:12px;outline:none">
    <label style="display:block;font-size:12px;color:#888;margin-bottom:4px">生日 * <span style="font-size:11px;color:#c97a7a">（登錄後無法修改，請確認正確）</span></label>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <select id="reg-bday-m" style="flex:1;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;outline:none;background:#fff;color:#333">
        <option value="">月份</option>
        ${Array.from({length:12},(_,i)=>{const m=String(i+1).padStart(2,'0');return `<option value="${m}">${i+1}月</option>`;}).join('')}
      </select>
      <select id="reg-bday-d" style="flex:1;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;outline:none;background:#fff;color:#333">
        <option value="">日期</option>
        ${Array.from({length:31},(_,i)=>{const d=String(i+1).padStart(2,'0');return `<option value="${d}">${i+1}日</option>`;}).join('')}
      </select>
    </div>
    <label style="display:block;font-size:12px;color:#888;margin-bottom:4px">邀請碼（選填）</label>
    <input id="reg-invite" type="text" placeholder="輸入好友邀請碼" maxlength="6" style="width:100%;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;text-transform:uppercase;margin-bottom:16px;outline:none">
    <button onclick="register()" style="width:100%;background:#c9a98a;color:#fff;border:none;border-radius:10px;padding:14px;font-size:16px;font-weight:bold;cursor:pointer;letter-spacing:1px">立即加入會員</button>
    <div id="reg-error" style="margin-top:10px;font-size:13px;color:#e07070;text-align:center;display:none"></div>
  </div>
</div>

<div id="app" style="display:none">
  <header>
    <div class="header-name" id="hdr-name">載入中…</div>
    <div class="header-sub" id="hdr-sub"></div>
    <div id="tier-badge" class="tier-badge"></div>
  </header>

  <!-- 會員福利（可收合） -->
  <div class="card">
    <div class="card-title" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center" onclick="toggleBenefits()">
      <span>會員福利一覽</span><span id="benefits-arrow" style="font-size:12px;color:#bbb">▼ 展開</span>
    </div>
    <div id="benefits-panel" style="display:none;margin-top:4px">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <tr style="background:#f5ede0;color:#7a5c3e">
          <th style="padding:7px 5px;text-align:left">等級</th>
          <th style="padding:7px 4px;text-align:center">年消費門檻</th>
          <th style="padding:7px 4px;text-align:center">點數回饋</th>
          <th style="padding:7px 5px;text-align:center">生日禮</th>
        </tr>
        <tr style="border-bottom:1px solid #faf5ef"><td style="padding:7px 5px;color:#a08060;font-weight:bold">一般</td><td style="padding:7px 4px;text-align:center;color:#888">免門檻</td><td style="padding:7px 4px;text-align:center;color:#888">NT$300/1點</td><td style="padding:7px 5px;text-align:center;color:#888">NT$30×1</td></tr>
        <tr style="border-bottom:1px solid #faf5ef"><td style="padding:7px 5px;color:#888;font-weight:bold">銀卡</td><td style="padding:7px 4px;text-align:center;color:#888">NT$3,000</td><td style="padding:7px 4px;text-align:center;color:#888">NT$200/1點</td><td style="padding:7px 5px;text-align:center;color:#888">NT$50×1</td></tr>
        <tr style="border-bottom:1px solid #faf5ef"><td style="padding:7px 5px;color:#a07800;font-weight:bold">金卡</td><td style="padding:7px 4px;text-align:center;color:#888">NT$6,000</td><td style="padding:7px 4px;text-align:center;color:#888">NT$100/1點</td><td style="padding:7px 5px;text-align:center;color:#888">NT$50×2</td></tr>
        <tr><td style="padding:7px 5px;color:#3949ab;font-weight:bold">白金</td><td style="padding:7px 4px;text-align:center;color:#888">NT$12,000</td><td style="padding:7px 4px;text-align:center;color:#888">NT$50/1點</td><td style="padding:7px 5px;text-align:center;color:#888">NT$50×4</td></tr>
      </table>
      <div style="margin-top:10px;padding:10px;background:#fff8f0;border-radius:8px;font-size:12px;color:#888;line-height:1.6">
        🎟 <strong style="color:#c9a98a">邀請好友</strong>：好友完成首筆訂單，雙方各獲 NT$50 折扣券 × 2 張<br>
        🪙 <strong style="color:#c9a98a">1點 = NT$1</strong>：結帳時直接折抵
      </div>
    </div>
  </div>

  <!-- 消費進度 -->
  <div class="card">
    <div class="card-title">年度消費進度</div>
    <div class="stat-row"><span>今年累積消費</span><span class="stat-val" id="yearly-spend">—</span></div>
    <div class="stat-row"><span>下一等級門檻</span><span class="stat-val" id="next-tier-threshold">—</span></div>
    <div class="progress-wrap">
      <div class="progress-label"><span id="cur-tier-label">—</span><span id="next-tier-label">—</span></div>
      <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
    </div>
  </div>

  <!-- 點數 -->
  <div class="card">
    <div class="card-title">點數</div>
    <div class="stat-row"><span>可用點數</span><span class="stat-val" id="total-pts">—</span></div>
    <div class="stat-row"><span>折抵方式</span><span class="stat-val">1點 = NT$1</span></div>
    <div id="pts-list" style="margin-top:8px;font-size:12px;color:#aaa"></div>
  </div>

  <!-- 進行中訂單 -->
  <div class="card">
    <div class="card-title">📦 我的訂單進度</div>
    <div id="order-list"><div class="empty">載入中…</div></div>
  </div>

  <!-- 優惠券 -->
  <div class="card">
    <div class="card-title">優惠券</div>
    <div id="coupon-list"><div class="empty">目前沒有可用優惠券</div></div>
  </div>

  <!-- 生日（唯讀） -->
  <div class="card">
    <div class="card-title">生日</div>
    <div style="font-size:13px;color:#888;margin-bottom:8px">每年生日當月自動發送禮券</div>
    <div id="bday-input" style="font-size:20px;font-weight:bold;color:#c9a98a;letter-spacing:2px">——</div>
    <div style="font-size:11px;color:#bbb;margin-top:6px">生日登錄後無法修改，如有疑問請聯繫客服</div>
  </div>

  <!-- 邀請碼 -->
  <div class="card">
    <div class="card-title">我的邀請碼</div>
    <div class="ref-code-box">
      <div style="font-size:12px;color:#aaa">分享給好友，好友首單完成後雙方各獲 NT$50 × 2 張</div>
      <div class="ref-code" id="my-ref-code">——</div>
      <button class="ref-copy-btn" onclick="copyRefCode()">複製邀請碼</button>
    </div>
    <div style="margin-top:14px;font-size:13px;color:#888">填入好友邀請碼（入會 1 個月內可填）</div>
    <div class="input-row" id="referral-input-row">
      <input id="ref-input" type="text" placeholder="輸入邀請碼" maxlength="6">
      <button onclick="bindReferral()">確認</button>
    </div>
    <div id="ref-bound-msg" style="display:none;font-size:13px;color:#c9a98a;margin-top:8px"></div>
  </div>
</div>

<div id="loading" style="text-align:center;padding:80px 20px;color:#ccc;font-size:14px">載入中…</div>
<div id="toast" class="toast"></div>

<script>
let userId = '', displayName = '', memberData = null;

async function init() {
  await liff.init({ liffId: '${MEMBER_LIFF_ID}' });
  if (!liff.isLoggedIn()) { liff.login(); return; }
  const profile = await liff.getProfile();
  userId = profile.userId;
  displayName = profile.displayName || '';

  const r = await fetch('/api/member?userId=' + userId);
  const d = await r.json();
  document.getElementById('loading').style.display = 'none';
  if (!d.ok) { document.getElementById('loading').textContent = '載入失敗'; return; }

  if (!d.registered) {
    document.getElementById('register-view').style.display = 'block';
  } else {
    memberData = d;
    render(d);
    document.getElementById('app').style.display = 'block';
  }
}

function toggleBenefits() {
  const panel = document.getElementById('benefits-panel');
  const arrow = document.getElementById('benefits-arrow');
  if (panel.style.display === 'none') {
    panel.style.display = 'block';
    arrow.textContent = '▲ 收合';
  } else {
    panel.style.display = 'none';
    arrow.textContent = '▼ 展開';
  }
}

async function register() {
  const name = document.getElementById('reg-name').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  const bm = document.getElementById('reg-bday-m').value;
  const bd = document.getElementById('reg-bday-d').value;
  const birthday = (bm && bd) ? bm + '-' + bd : '';
  const inviteCode = document.getElementById('reg-invite').value.trim().toUpperCase();
  const errEl = document.getElementById('reg-error');
  errEl.style.display = 'none';

  if (!name || !phone || !birthday) { errEl.textContent = '請填寫所有必填欄位'; errEl.style.display = 'block'; return; }
  if (!/^09\\d{8}$/.test(phone)) { errEl.textContent = '手機號碼格式不正確（例：0912345678）'; errEl.style.display = 'block'; return; }

  const btn = document.querySelector('#register-view button');
  btn.disabled = true; btn.textContent = '處理中…';
  try {
    const resp = await fetch('/api/member/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, displayName, name, phone, birthday, inviteCode }),
    });
    const d = await resp.json();
    if (!d.ok) {
      errEl.textContent = d.error || '註冊失敗，請稍後再試';
      errEl.style.display = 'block';
      btn.disabled = false; btn.textContent = '立即加入會員';
      return;
    }
    // 成功：重新載入會員資料
    document.getElementById('register-view').style.display = 'none';
    const mr = await fetch('/api/member?userId=' + userId);
    const md = await mr.json();
    if (md.ok && md.registered) { memberData = md; render(md); }
    document.getElementById('app').style.display = 'block';
    showToast('🎉 歡迎加入 Bijin 會員！');
  } catch(e) {
    errEl.textContent = '網路錯誤，請稍後再試';
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = '立即加入會員';
  }
}

function render(d) {
  const m = d.member;
  document.getElementById('hdr-name').textContent = m.displayName || '會員';
  document.getElementById('hdr-sub').textContent = '加入日期：' + m.joinDate;
  const badge = document.getElementById('tier-badge');
  badge.textContent = m.tier;
  badge.className = 'tier-badge tier-' + m.tier;

  // 消費進度
  const tiers = [{name:'一般',min:0},{name:'銀卡',min:3000},{name:'金卡',min:6000},{name:'白金',min:12000}];
  const curIdx = tiers.findIndex(t => t.name === m.tier);
  const nextTier = tiers[curIdx + 1];
  document.getElementById('yearly-spend').textContent = 'NT$' + (m.yearlySpend||0).toLocaleString();
  if (nextTier) {
    const curMin = tiers[curIdx].min;
    const pct = Math.min(100, Math.round(((m.yearlySpend - curMin) / (nextTier.min - curMin)) * 100));
    document.getElementById('next-tier-threshold').textContent = 'NT$' + nextTier.min.toLocaleString() + '（' + nextTier.name + '）';
    document.getElementById('cur-tier-label').textContent = m.tier;
    document.getElementById('next-tier-label').textContent = nextTier.name;
    document.getElementById('progress-fill').style.width = pct + '%';
  } else {
    document.getElementById('next-tier-threshold').textContent = '已達最高等級 🏆';
    document.getElementById('progress-fill').style.width = '100%';
  }

  // 點數（以會員表餘額為準，pointsRows 只用於明細展示）
  document.getElementById('total-pts').textContent = (m.points || 0) + ' 點';
  if (d.pointsRows.length) {
    document.getElementById('pts-list').innerHTML = d.pointsRows
      .map(p => \`<div style="display:flex;justify-content:space-between;padding:3px 0"><span>+\${p.points}點（\${p.orderId.substring(0,8)}…）</span><span>到期：\${p.expiryDate}</span></div>\`)
      .join('');
  }

  // 優惠券
  const cl = document.getElementById('coupon-list');
  if (d.coupons.length) {
    cl.innerHTML = d.coupons.map(c => \`
      <div class="coupon-item">
        <div>
          <div class="coupon-amount">NT$\${c.amount}</div>
          <div class="coupon-info">\${c.type}｜到期：\${c.expiryDate}</div>
          <div class="coupon-code">\${c.couponCode}</div>
        </div>
      </div>\`).join('');
  } else {
    cl.innerHTML = '<div class="empty">目前沒有可用優惠券</div>';
  }

  // 生日（唯讀顯示）
  document.getElementById('bday-input').textContent = m.birthday || '——';

  // 邀請碼
  document.getElementById('my-ref-code').textContent = m.referralCode || '——';
  if (m.referredByCode) {
    document.getElementById('referral-input-row').style.display = 'none';
    document.getElementById('ref-bound-msg').style.display = 'block';
    document.getElementById('ref-bound-msg').textContent = '✅ 已綁定邀請碼：' + m.referredByCode;
  }

  // 訂單進度（非同步載入）
  loadOrders();
}

const ORDER_STEPS = [
  { key: '待確認', label: '訂單確認中', icon: '🕐' },
  { key: '待買家完成下單', label: '等待您完成下單', icon: '⏳' },
  { key: '處理中(待處理或完成官網下單)', label: '官網下單處理中', icon: '🛍' },
  { key: '已發貨(官網出貨)', label: 'GRL 已出貨', icon: '📦' },
  { key: '已發貨(已達台灣海關作業)', label: '台灣海關作業中', icon: '🛃' },
  { key: '已發貨(賣貨便出貨)', label: '賣貨便已出貨', icon: '🚚' },
  { key: '待買家取貨', label: '商品已到門市，請取貨', icon: '🏪' },
];

function renderOrderCard(o) {
  const stepIdx = ORDER_STEPS.findIndex(s => s.key === o.status);
  const curStep = stepIdx >= 0 ? ORDER_STEPS[stepIdx] : { label: o.status, icon: '📋' };
  const totalSteps = ORDER_STEPS.length;
  const pct = stepIdx >= 0 ? Math.round((stepIdx / (totalSteps - 1)) * 100) : 0;

  const items = o.items.split('\\n').map(function(l) {
    if (!l.trim()) return '';
    const isPreorder = l.indexOf('【預購】') === 0;
    const text = isPreorder ? l.replace('【預購】','') : l;
    return '<div style="font-size:12px;color:#666;padding:2px 0">'
      + (isPreorder ? '<span style="background:#fff3e0;color:#e65100;font-size:10px;font-weight:700;border-radius:3px;padding:1px 4px;margin-right:3px;border:1px solid #ffcc80">預購</span>' : '')
      + escHtml(text) + '</div>';
  }).join('');

  let priceHtml = '<span style="font-weight:bold;color:#333">NT$' + o.finalAmount.toLocaleString() + '</span>';
  if (o.discountAmount > 0) {
    priceHtml = '<span style="text-decoration:line-through;color:#bbb;font-size:11px">NT$' + o.totalTwd.toLocaleString() + '</span> '
      + '<span style="font-weight:bold;color:#c9a98a">NT$' + o.finalAmount.toLocaleString() + '</span>';
  }

  const stepsHtml = ORDER_STEPS.map(function(s, i) {
    const done = i < stepIdx;
    const active = i === stepIdx;
    const col = active ? '#c9a98a' : done ? '#c9a98a' : '#ddd';
    const textCol = active ? '#7a5c3e' : done ? '#aaa' : '#ccc';
    const weight = active ? 'bold' : 'normal';
    return '<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px">'
      + '<div style="width:20px;height:20px;border-radius:50%;background:' + col + ';display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;margin-top:1px">'
      + (done ? '<span style="color:#fff">✓</span>' : active ? '<span style="color:#fff">●</span>' : '<span style="color:#bbb">○</span>')
      + '</div>'
      + '<div style="font-size:12px;color:' + textCol + ';font-weight:' + weight + ';line-height:1.4">' + s.icon + ' ' + s.label + '</div>'
      + '</div>';
  }).join('');

  return '<div style="border:1px solid #f0e8de;border-radius:10px;padding:12px;margin-bottom:10px;background:#fffaf6">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
    + '<div style="font-size:11px;color:#bbb">' + o.orderTime.substring(0,10) + '</div>'
    + '<div>' + priceHtml + '</div>'
    + '</div>'
    + '<div style="margin-bottom:8px">' + items + '</div>'
    + '<div style="background:#f5ede0;border-radius:8px;padding:8px 10px;margin-bottom:10px">'
    + '<div style="font-size:12px;font-weight:bold;color:#c9a98a;margin-bottom:2px">' + curStep.icon + ' 目前狀態</div>'
    + '<div style="font-size:13px;color:#7a5c3e;font-weight:bold">' + curStep.label + '</div>'
    + '</div>'
    + '<div style="font-size:11px;color:#bbb;margin-bottom:6px;cursor:pointer;text-align:right" onclick="toggleSteps(this)">▼ 查看完整進度</div>'
    + '<div style="display:none;border-top:1px solid #f0e8de;padding-top:8px">' + stepsHtml + '</div>'
    + '</div>';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toggleSteps(el) {
  const panel = el.nextElementSibling;
  if (panel.style.display === 'none') {
    panel.style.display = 'block';
    el.textContent = '▲ 收合進度';
  } else {
    panel.style.display = 'none';
    el.textContent = '▼ 查看完整進度';
  }
}

async function loadOrders() {
  const ol = document.getElementById('order-list');
  try {
    const r = await fetch('/api/member/orders?userId=' + userId);
    const d = await r.json();
    if (!d.ok) { ol.innerHTML = '<div class="empty">載入失敗</div>'; return; }
    if (!d.orders.length) { ol.innerHTML = '<div class="empty">目前沒有進行中的訂單</div>'; return; }
    ol.innerHTML = d.orders.map(renderOrderCard).join('');
  } catch(e) {
    ol.innerHTML = '<div class="empty">載入失敗，請稍後再試</div>';
  }
}

async function saveBirthday() {
  const val = document.getElementById('bday-input').value.trim();
  if (!/^\\d{2}-\\d{2}$/.test(val)) { showToast('格式應為 MM-DD，例：03-15'); return; }
  const r = await fetch('/api/member/birthday', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId, birthday: val }) });
  const d = await r.json();
  showToast(d.ok ? '✅ 生日已儲存' : '❌ ' + d.error);
}

async function bindReferral() {
  const code = document.getElementById('ref-input').value.trim().toUpperCase();
  if (!code) { showToast('請輸入邀請碼'); return; }
  const r = await fetch('/api/member/referral', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId, inviteCode: code }) });
  const d = await r.json();
  if (d.ok) {
    showToast('✅ ' + d.message);
    document.getElementById('referral-input-row').style.display = 'none';
    document.getElementById('ref-bound-msg').style.display = 'block';
    document.getElementById('ref-bound-msg').textContent = '✅ 已綁定邀請碼：' + code;
  } else showToast('❌ ' + d.error);
}

function copyRefCode() {
  const code = document.getElementById('my-ref-code').textContent;
  navigator.clipboard.writeText(code).then(() => showToast('✅ 已複製邀請碼：' + code)).catch(() => showToast('請手動複製：' + code));
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

init().catch(e => { document.getElementById('loading').textContent = '載入失敗：' + e.message; });
</script>
</body>
</html>`);
});

// ── 管理員 API：手動觸發訂單完成點數（補發）────────────────────────────────────
app.post('/api/admin/complete-order-points', express.json(), async (req, res) => {
  const { key, orderId } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${ORDER_SHEET}!A:P` });
    const rows = resp.data.values || [];
    const row = rows.find(r => r[0] === orderId);
    if (!row) return res.status(404).json({ error: '找不到訂單' });
    const userId = row[2], displayName = row[15] || '', totalTwd = parseFloat(row[4]) || 0;
    const result = await processOrderCompletion(sheets, userId, displayName, orderId, totalTwd);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ZOZO 任務佇列 API（供 Chrome Extension 使用）────────────────────────────

// GET /api/zozo-queue — Extension 輪詢：取得最舊的 pending 任務
app.get('/api/zozo-queue', async (req, res) => {
  if (req.query.key !== ZOZO_QUEUE_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sheets = getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${ZOZO_SHEET}!A:G`,
    });
    const rows = result.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][3] === 'pending') {
        // 標記為 processing
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${ZOZO_SHEET}!D${i + 1}`,
          valueInputOption: 'RAW',
          resource: { values: [['processing']] },
        });
        return res.json({ taskId: rows[i][0], userId: rows[i][1], url: rows[i][2] });
      }
    }
    return res.json({ taskId: null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/zozo-queue — Extension 回傳結果，更新 Sheet（買家主動點「查看報價」取結果）
app.post('/api/zozo-queue', express.json(), async (req, res) => {
  if (req.body.key !== ZOZO_QUEUE_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { taskId, result, error } = req.body;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });

  try {
    const sheets = getSheetsClient();
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${ZOZO_SHEET}!A:G`,
    });
    const rows = existing.data.values || [];
    const rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === taskId);
    if (rowIdx < 0) return res.status(404).json({ error: 'Task not found' });

    const userId = rows[rowIdx][1];
    const url    = rows[rowIdx][2];
    const now    = new Date().toISOString();

    // 更新狀態與結果（E欄=result JSON，G欄=完成時間）
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${ZOZO_SHEET}!D${rowIdx + 1}:G${rowIdx + 1}`,
      valueInputOption: 'RAW',
      resource: { values: [[error ? 'error' : 'done', JSON.stringify(result || { error }), '', now]] },
    });

    // 記錄查詢到「查詢紀錄」分頁（供 add_to_cart_zozo 查商品名用）
    if (result && !error) {
      const weightInfo = estimateWeight(result.name || '');
      const lbs = weightInfo ? weightInfo.midLbs : 1;
      let rateForLog = null;
      try { rateForLog = await fetchRate(); } catch (_) {}
      const suggestedForLog = (rateForLog && result.price) ? calcSuggestedPrice(rateForLog, result.price, lbs, JP_SHIPPING_ZOZO) : 0;
      const imageForLog = result.colors && result.colors[0] ? (result.colors[0].imageUrl || '') : '';
      logQueryToSheet(userId, '', result.goodsId || url, result.name || '', result.price || 0, weightInfo, imageForLog, suggestedForLog, url).catch(e => console.warn('[zozo-queue] logQueryToSheet 失敗:', e.message));
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[zozo-queue POST]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── Cron：每月1號自動發送生日禮 ──────────────────────────────────────────────
// Vercel Cron 每月1日 00:00 UTC（台灣時間 08:00）呼叫
app.post('/api/cron/birthday', async (req, res) => {
  // 驗證來自 Vercel Cron 或管理員
  const auth = req.headers['authorization'] || '';
  const cronSecret = process.env.CRON_SECRET || ADMIN_KEY;
  if (auth !== `Bearer ${cronSecret}` && auth !== `Bearer ${ADMIN_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const thisMonth = String(now.getMonth() + 1).padStart(2, '0'); // '01'~'12'
  const thisYear = now.getFullYear();
  const thisYearStr = String(thisYear);

  try {
    const sheets = getSheetsClient();

    // 取所有會員
    const mResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${MEMBER_SHEET}!A:L` });
    const mRows = mResp.data.values || [];

    // 取今年已發過生日禮的 userId
    await ensureCouponSheet(sheets);
    const cResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${COUPON_SHEET}!A:I` });
    const cRows = cResp.data.values || [];
    const alreadyGifted = new Set(
      cRows.slice(1)
        .filter(r => r[3] === '生日禮' && (r[5] || '').startsWith(thisYearStr))
        .map(r => r[1])
    );

    let count = 0;

    for (let i = 1; i < mRows.length; i++) {
      const r = mRows[i];
      const userId    = r[0] || '';
      const birthday  = r[3] || ''; // MM-DD
      const tier      = r[9] || '一般';

      const lineDisplayName = r[1] || '';
      if (!userId || !birthday) continue;
      const bMonth = birthday.split('-')[0]; // 'MM'
      if (bMonth !== thisMonth) continue;
      if (alreadyGifted.has(userId)) continue;

      // 發優惠券
      const gifts = BIRTHDAY_GIFTS[tier] || BIRTHDAY_GIFTS['一般'];
      const expiry = `${thisYear}-${thisMonth}-${new Date(thisYear, parseInt(thisMonth), 0).getDate().toString().padStart(2,'0')}`; // 當月最後一天
      const codes = [];
      for (const g of gifts) {
        const issued = await issueCoupons(sheets, userId, lineDisplayName, '生日禮', g.amount, g.qty, expiry);
        codes.push(...issued);
      }

      // 發 LINE 通知
      const totalQty = gifts.reduce((s, g) => s + g.qty, 0);
      const totalAmt = gifts.reduce((s, g) => s + g.amount * g.qty, 0);
      const msg = `🎂 生日快樂！\n\n感謝您是 Bijin 的 ${tier}會員 🌸\n\n生日禮券已發送：\nNT$${gifts[0].amount} 折扣碼 × ${totalQty} 張（共 NT$${totalAmt}）\n有效至本月底 ${expiry}\n\n請至會員中心查看並使用 💝`;
      await lineClient.pushMessage(userId, { type: 'text', text: msg }).catch(() => {});
      count++;
    }

    res.json({ ok: true, sent: count, month: thisMonth });
  } catch (e) {
    console.error('[birthday cron error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 本地開發啟動 ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

module.exports = app;
