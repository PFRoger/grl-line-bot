'use strict';

const axios = require('axios');

// ── 建議售價計算 ──────────────────────────────────────────────────────────────
const JP_SHIPPING_GRL  = 195;  // GRL 日本國內運費(每件固定,日圓)
const JP_SHIPPING_ZOZO = 330;  // ZOZO 日本國內運費(每件固定,日圓)
const FEE_RATE         = 1.075; // Buy&Ship 手續費 6% + 銀行刷卡費 1.5%
const SHIPPING_PER_LB  = 150;  // 國際運費(台幣/磅)
const PACKAGING_COST   = 20;   // 包材(台幣/件)
const TRANSFER_FEE     = 10;   // 跨行提領(台幣/件)
const PROFIT           = 120;  // 每單固定利潤(台幣)

// jpShipping：GRL 傳 JP_SHIPPING_GRL，ZOZO 傳 JP_SHIPPING_ZOZO
function calcSuggestedPrice(rate, jpy, lbs = 1, jpShipping = JP_SHIPPING_GRL) {
  const cost = rate * (jpy + jpShipping) * FEE_RATE
             + (SHIPPING_PER_LB * Math.ceil(lbs) + PACKAGING_COST + TRANSFER_FEE);
  const base = Math.round(cost + PROFIT);
  const last = base % 10;
  if (last <= 4) return base - last + 5;
  if (last >= 6) return base - last + 9;
  return base;
}

// ── 格式化日幣（加千位符） ────────────────────────────────────────────────────
function fmtJPY(n) {
  return n.toLocaleString('ja-JP');
}

// ── 抓取即時匯率 JPY → TWD ────────────────────────────────────────────────────
let _cachedRate = null;
let _rateExpiry = 0;

async function fetchRate() {
  const now = Date.now();
  if (_cachedRate && now < _rateExpiry) return _cachedRate;

  const PRIMARY = 'https://api.exchangerate-api.com/v4/latest/JPY';
  const FALLBACK = 'https://open.er-api.com/v6/latest/JPY';

  async function tryFetch(url) {
    const { data } = await axios.get(url, { timeout: 8000 });
    const rate = (data.rates && data.rates.TWD) ||
                 (data.conversion_rates && data.conversion_rates.TWD);
    if (!rate) throw new Error('回應中找不到 TWD 欄位');
    return rate;
  }

  let rate;
  try {
    rate = await tryFetch(PRIMARY);
  } catch (err) {
    console.warn('[fetchRate] 主要端點失敗，切換備援:', err.message);
    rate = await tryFetch(FALLBACK);
  }

  _cachedRate = rate + 0.015;
  _rateExpiry = now + 30 * 60 * 1000;
  return _cachedRate;
}

module.exports = {
  JP_SHIPPING_GRL, JP_SHIPPING_ZOZO,
  FEE_RATE, SHIPPING_PER_LB, PACKAGING_COST, TRANSFER_FEE, PROFIT,
  calcSuggestedPrice, fmtJPY, fetchRate,
};
