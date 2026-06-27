'use strict';

const line = require('@line/bot-sdk');
const { google } = require('googleapis');

// ── 環境變數 ──────────────────────────────────────────────────────────────────
const ADMIN_KEY      = process.env.ADMIN_KEY;
const ZOZO_QUEUE_KEY = process.env.ZOZO_QUEUE_KEY;

// ── 系統常數 ──────────────────────────────────────────────────────────────────
const ADMIN_USER_ID  = 'U9fa329e70b89f4ce19089928a824bd29';
const SHEET_ID       = '148eFUK3xm0ITsVpueqtnwjK-lcKeemoiRbQgcFWbGug';
const LIFF_ID        = '2009823505-mhQivhxd';
const MEMBER_LIFF_ID = '2009823505-bwMBpOjU';

// ── Google Sheets 工作表名稱 ──────────────────────────────────────────────────
const CART_SHEET     = '購物車';
const ORDER_SHEET    = '訂單';
const ZOZO_SHEET     = 'ZOZO任務';
const SETTINGS_SHEET = '設定';
const BOT_LOG_SHEET  = 'Bot紀錄';
const MEMBER_SHEET   = '會員';
const POINTS_SHEET   = '點數紀錄';
const COUPON_SHEET   = '優惠券';
const REFERRAL_SHEET = '邀請紀錄';
const FOLLOW_SHEET   = '加入紀錄';

// ── LINE Bot 單一客戶端實例 ───────────────────────────────────────────────────
const lineClient = new line.Client({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });

// ── Google Sheets 驗證（快取 client，避免每次重建 GoogleAuth）────────────────
let _sheetsClient = null;
function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

module.exports = {
  ADMIN_KEY, ZOZO_QUEUE_KEY,
  ADMIN_USER_ID, SHEET_ID, LIFF_ID, MEMBER_LIFF_ID,
  CART_SHEET, ORDER_SHEET, ZOZO_SHEET, SETTINGS_SHEET, BOT_LOG_SHEET,
  MEMBER_SHEET, POINTS_SHEET, COUPON_SHEET, REFERRAL_SHEET, FOLLOW_SHEET,
  lineClient, getSheetsClient,
};
