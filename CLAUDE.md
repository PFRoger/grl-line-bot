# CLAUDE.md — Bijin 日本正品代購 LINE Bot

> 這份文件讓 Claude 在每次對話開始時立刻掌握專案全貌，避免重複推導已知資訊。

---

## 專案概述

**商業用途**：Bijin日本正品代購（代購業者）的 LINE Bot，主要功能：
1. 用戶傳入 GRL (grail.bz) 商品網址 → 回傳商品報價 + 庫存 Flex Message
2. 加入購物車 → Flex Carousel（一個顏色一張卡片）
3. LIFF 購物車頁面：查看購物車、選擇 7-11 門市、提交訂單
4. Rich Menu：查詢紀錄、開始購物、購物車、購物指南、穿搭靈感、會員中心

---

## 技術架構

| 項目 | 說明 |
|------|------|
| Runtime | Node.js (Express) |
| 部署平台 | Vercel (Serverless) |
| **Vercel 專案名稱** | `pfroger-linebot-2` |
| **Production URL** | `https://pfroger-linebot-2.vercel.app` |
| **Webhook URL** | `https://pfroger-linebot-2.vercel.app/webhook` |
| LINE Bot 類型 | Messaging API Channel |
| LIFF | LINE Login Channel，LIFF ID: `2009823505-mhQivhxd` |
| 資料庫 | Google Sheets（服務帳號認證） |
| 原始碼 | `index.js`（單一檔案，所有邏輯） |
| GitHub Repo | `PFRoger/grl-line-bot` (main branch) |

---

## 部署方式

### ⚠️ 重要：Windows 使用者名稱含中文「太豐」，`vercel login` 會因 HTTP header 錯誤失敗

**正確的部署流程（使用 Token）：**

```bash
# .vercel/project.json 必須指向正確的專案
# projectId: prj_FSCfR5beQzSIe4qijBeizeInScP2
# orgId: team_AJDKmiGg4qWX6gXrWwdeWPmv

VERCEL_TOKEN=<token> npx vercel --prod --yes --scope pfrogers-projects
```

- Token 從 https://vercel.com/account/tokens 建立
- Scope 選 Full Account，No Expiration
- `.vercel/project.json` 若連結到錯誤專案（如 `claudecode`），需手動修正

**替代方案（推薦）：透過 GitHub 自動部署**
```bash
git add .
git commit -m "..."
git push origin main
# Vercel 會自動偵測 push 並部署到 pfroger-linebot-2.vercel.app
```

---

## 環境變數（`.env`）

```
LINE_CHANNEL_ACCESS_TOKEN=...
LINE_CHANNEL_SECRET=...
ADMIN_KEY=grl-admin-2026
GOOGLE_SERVICE_ACCOUNT_JSON=...  # 在 Vercel 設定，本地不需要
```

---

## Google Sheets 結構

| 工作表 | 用途 |
|--------|------|
| `查詢紀錄` | 每次商品查詢記錄（userId、商品ID、名稱、日幣、TWD等） |
| `購物車` | 臨時購物車（12小時後過期，J欄標記 deleted/ordered） |
| `訂單` | 已成立訂單（含買家資訊、7-11門市、銀行轉帳末5碼） |

---

## index.js 重要函式索引

| 函式 | 說明 |
|------|------|
| `buildFlexMessage()` | 建立商品報價 Flex Message（有庫存/無庫存版本） |
| `buildAddToCartFlex()` | 建立加入購物車 Flex Carousel（一色一卡片） |
| `addToCartSheet()` | 寫入購物車工作表 |
| `getCartItems()` | 讀取用戶購物車（過濾12小時過期 + deleted） |
| `submitOrder()` | 寫入訂單工作表 + 回傳 orderId |
| `handlePostback()` | 處理所有 postback：`add_to_cart`, `query_history`, `tutorial`, `member` |
| `buildCartHtml()` | 產生 LIFF 購物車 HTML（單一函式，回傳完整 HTML 字串） |
| `ensureCartSheet()` | 確保購物車工作表存在並有正確標頭 |
| `ensureOrderSheet()` | 確保訂單工作表存在並有正確標頭 |

---

## API 路由

| 路由 | 方法 | 說明 |
|------|------|------|
| `/webhook` | POST | LINE Webhook 進入點 |
| `/cart` | GET | LIFF 購物車頁面（HTML） |
| `/api/cart` | GET | 取得購物車（?userId=...） |
| `/api/cart/item` | DELETE | 刪除購物車單項 |
| `/api/order` | POST | 提交訂單 |
| `/api/stores` | GET | 7-11 門市查詢代理（?cityName=&areaName=） |

---

## 7-11 門市資料來源

競品逆向工程發現的 API（不需認證）：
```
https://www.emacloz.com/fetch_area_data_from_django?cityName=台北市&areaName=中正區
```
回傳 `{ stores_data: [{storeNum, storeName, storeAddress}] }`

購物車目前實作：2 層選擇（城市下拉 + 門市名稱文字輸入）

---

## Rich Menu

**目前使用的 Rich Menu ID**: `richmenu-5f78e8bccf8aebb4f3201064da3f01ec`

| 按鈕 | 動作 |
|------|------|
| 查詢紀錄 | postback: `action=query_history` |
| 開始購物 | URI: `https://www.grail.bz` |
| 購物車 | URI: `https://liff.line.me/2009823505-mhQivhxd` |
| 購物指南 | postback: `action=tutorial` |
| 穿搭靈感 | URI: Instagram |
| 會員中心 | postback: `action=member` |

> Rich Menu 圖片無法直接替換，必須刪除舊 menu 再建立新 menu。

---

## GRL 圖片結構（已確認）

GRL 使用 `alt` 屬性關聯顏色與圖片：
```html
<img alt="ブラック" src="https://cdn.grail.bz/images/goods/t/ru1197/ru1197_col_11.jpg">
<img alt="ブルー"   src="https://cdn.grail.bz/images/goods/t/ru1197/ru1197_col_15.jpg">
```
- **縮圖路徑**：`/images/goods/t/`
- **全尺寸路徑**：`/images/goods/d/`（把 `/t/` 換成 `/d/` 即可）
- `scrapeGRL()` 用 `$('img[alt]')` 搜尋，匹配 `COLOR_KEYS`，自動升級為全尺寸 URL
- `colorImages` map 回傳給 `buildAddToCartFlex()`，每張顏色卡片用各自的圖

---

## 已知問題與決策記錄

- **`vercel login` 在此機器失效**：Windows 使用者名稱「太豐」含中文，造成 HTTP header 錯誤。改用 Token 或 GitHub 自動部署。
- **3層 7-11 門市選擇器未完成**：大型 JS 生成時 content filter 阻擋，目前維持 2 層（城市 + 文字輸入門市名）。
- **LIFF 不能建在 Messaging API Channel**：LINE 2024 年政策變更，LIFF 需另建 LINE Login Channel。
- **建議售價計算**：`匯率 = JPY→TWD + 0.015`，`成本 = 匯率 × JPY × 1.075 + 180`，個位數 ≤4 → 5，≥6 → 9。
