# Bijin 日本正品代購 LINE Bot

LINE Bot 服務，主要功能為 GRL (grail.bz) 商品報價查詢、購物車管理與訂單追蹤。

---

## 功能總覽

### 用戶功能
- 傳入 GRL 商品網址 → 自動回覆商品名稱、日幣售價、建議售價（TWD）及各顏色庫存狀態
- 加入購物車（Flex Carousel，米色系設計，一色一卡片）
- LIFF 購物車頁面：查看購物車、填寫訂貨人資訊、提交訂單
- 表單自動記憶上次填寫的姓名、電話、聯繫帳號、備註（各欄位最多 3 筆歷史）
- Rich Menu：查詢紀錄、開始購物、購物車、購物指南、穿搭靈感、會員中心

### 管理員功能（後台網頁）
- 查看所有訂單（4 欄格線）
- 訂單狀態管理 + 自動通知買家
- 待確認訂單可直接傳送賣貨便網址給買家
- 已完成 / 已取消訂單折疊顯示

---

## 技術架構

| 項目 | 說明 |
|------|------|
| Runtime | Node.js (Express) |
| 部署平台 | Vercel (Serverless) |
| Vercel 專案 | `pfroger-linebot-2` |
| Production URL | `https://pfroger-linebot-2.vercel.app` |
| Webhook URL | `https://pfroger-linebot-2.vercel.app/webhook` |
| 資料庫 | Google Sheets（服務帳號認證） |
| LIFF | LINE Login Channel，LIFF ID: `2009823505-mhQivhxd` |
| 原始碼 | `index.js`（單一檔案） |

---

## 部署方式

### 推薦：GitHub 自動部署

```bash
git add .
git commit -m "..."
git push origin main
# Vercel 自動偵測 push 並部署
```

### 使用 Vercel Token（備用）

> Windows 使用者名稱含中文，`vercel login` 會失敗，改用 Token。

```bash
VERCEL_TOKEN=<token> npx vercel --prod --yes --scope pfrogers-projects
```

Token 建立：https://vercel.com/account/tokens（Full Account，No Expiration）

---

## 環境變數

| 變數 | 說明 |
|------|------|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Channel Access Token |
| `LINE_CHANNEL_SECRET` | LINE Channel Secret |
| `ADMIN_KEY` | 管理員 API 金鑰（預設 `grl-admin-2026`） |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google 服務帳號 JSON（Vercel 設定，本地不需要） |

---

## Google Sheets 結構

| 工作表 | 用途 |
|--------|------|
| `查詢紀錄` | 每次商品查詢記錄（userId、商品 ID、名稱、日幣、TWD、圖片、商品網址等） |
| `購物車` | 臨時購物車（48 小時後過期，J 欄標記 deleted/ordered） |
| `訂單` | 已成立訂單（含買家資訊、商品、金額、狀態） |

---

## API 路由

| 路由 | 方法 | 說明 |
|------|------|------|
| `/webhook` | POST | LINE Webhook 進入點 |
| `/cart` | GET | LIFF 購物車頁面（HTML） |
| `/api/cart` | GET | 取得購物車（?userId=...） |
| `/api/cart/item` | DELETE | 刪除購物車單項 |
| `/api/order` | POST | 提交訂單 |
| `/api/stores` | GET | 7-11 門市查詢代理 |
| `/admin` | GET | 管理員訂單後台（?key=...） |
| `/api/admin/orders` | GET | 取得所有訂單 |
| `/api/admin/order-status` | POST | 更新訂單狀態 |
| `/api/admin/notify-progress` | POST | 通知買家進度（含 LINE 推播） |
| `/admin/notify-buyer` | GET | 通知買家賣貨便網址 |

---

## 訂單狀態流程

| 狀態 | 說明 | 通知買家 |
|------|------|----------|
| 待確認 | 訂單剛建立 | 可傳賣貨便網址 |
| 待買家完成下單 | 已傳網址，等待買家完成 | — |
| 處理中(待處理或完成官網下單) | 處理中 | ✅ 需輸入日期 |
| 已發貨(官網出貨) | GRL 已出貨 | ✅ 需輸入日期 |
| 已發貨(已達台灣海關作業) | 已到台灣過海關 | ✅ 需輸入日期 |
| 已發貨(賣貨便出貨) | 我方已安排出貨 | ✅ 需輸入日期 |
| 待買家取貨 | 商品已到門市 | ✅ 需輸入日期 |
| 已完成 | 訂單完成 | — |
| 已取消 | 訂單取消 | — |

---

## 建議售價計算邏輯

```
匯率 = JPY→TWD 即時匯率 + 0.015
成本 = 匯率 × 日幣價格 × 1.075 + 180
個位數 ≤4 → 調整為 5；個位數 ≥6 → 調整為 9（或進位）
```

---

## Rich Menu

**Rich Menu ID**：`richmenu-5f78e8bccf8aebb4f3201064da3f01ec`

| 按鈕 | 動作 |
|------|------|
| 查詢紀錄 | postback: `action=query_history` |
| 開始購物 | URI: `https://www.grail.bz` |
| 購物車 | URI: `https://liff.line.me/2009823505-mhQivhxd` |
| 購物指南 | postback: `action=tutorial` |
| 穿搭靈感 | URI: Instagram |
| 會員中心 | postback: `action=member` |

---

## 專案結構

```
.
├── index.js          # 主程式（Express + LINE Bot + LIFF + 管理後台）
├── package.json
├── vercel.json       # Vercel 部署設定
├── .env.example      # 環境變數範例
└── README.md
```

---

## 已知限制

- `vercel login` 在此機器失效（Windows 使用者名稱含中文），改用 Token 或 GitHub 自動部署
- LIFF 需建在 LINE Login Channel（非 Messaging API Channel）
- 管理後台 URL 輸入欄位目前沒有輸入格式驗證
