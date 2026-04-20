# Bijin 日本正品代購 LINE Bot

LINE Bot 服務，主要功能為 GRL (grail.bz) 商品報價查詢、購物車管理與訂單追蹤。

---

## 功能總覽

### 用戶功能
- 傳入 GRL 商品網址 → 自動回覆商品名稱、日幣售價、台幣報價（含代購費＋國際運費）及各顏色庫存狀態
- 加入購物車（Flex Carousel，米色系設計，一色一卡片）
- LIFF 購物車頁面：查看購物車、點數折抵、優惠券使用、提交訂單
- 購物車表單自動記憶上次填寫的姓名、電話、聯繫帳號、備註（各欄位最多 3 筆歷史）
- 購物指南（/guide）：精美網頁版 5 步驟說明，含實物照片
- Rich Menu：查詢紀錄、開始購物、購物車、購物指南、穿搭靈感、會員中心

### 會員系統
- 明確點擊「立即加入會員」才建立帳號（不自動建立）
- 註冊填寫：姓名、手機（每支手機只能綁一個帳號）、生日（登錄後無法修改）、邀請碼（選填）
- 四級制度：一般 / 銀卡 / 金卡 / 白金，依年度消費門檻升等
- 點數回饋：依等級比例，1 點 = NT$1
- 邀請制度：被邀請人首單完成後，雙方各獲 NT$50 折扣碼 × 2 張
- 生日禮：每年生日當月自動發送禮券（Cron 每月 1 日執行）
- LIFF 會員中心：查看等級、點數明細、優惠券、邀請碼、會員福利表（可收合）

### 管理員功能（後台網頁）
- 查看所有訂單（4 欄格線），顯示買家姓名及 LINE 顯示名稱
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
| LIFF 購物車 | LINE Login Channel，LIFF ID: `2009823505-mhQivhxd` |
| LIFF 會員中心 | LINE Login Channel，LIFF ID: `2009823505-bwMBpOjU` |
| 原始碼 | `index.js`（單一檔案） |
| 靜態資源 | `public/guide/step1~5.jpg`（購物指南圖片） |

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
| `購物車` | 臨時購物車（48 小時後過期，J 欄標記 deleted/ordered，L 欄 LINE 顯示名稱） |
| `訂單` | 已成立訂單（A~O 欄原有資料，P 欄 LINE 顯示名稱） |
| `會員` | 會員資料（userId、displayName、生日、推薦碼、等級、點數等，共 14 欄） |
| `點數紀錄` | 每筆點數明細（D 欄 displayName） |
| `優惠券` | 優惠券（C 欄 displayName） |
| `邀請紀錄` | 邀請關係與獎勵狀態 |

---

## API 路由

| 路由 | 方法 | 說明 |
|------|------|------|
| `/webhook` | POST | LINE Webhook 進入點 |
| `/guide` | GET | 購物指南 LIFF 網頁 |
| `/cart` | GET | LIFF 購物車頁面（HTML） |
| `/api/cart` | GET | 取得購物車（?userId=...） |
| `/api/cart/add` | POST | 新增購物車項目 |
| `/api/cart/item` | DELETE | 刪除購物車單項 |
| `/api/order` | POST | 提交訂單 |
| `/admin` | GET | 管理員訂單後台（?key=...） |
| `/api/admin/orders` | GET | 取得所有訂單 |
| `/api/admin/order-status` | POST | 更新訂單狀態 |
| `/api/admin/notify-progress` | POST | 通知買家進度（含 LINE 推播） |
| `/admin/notify-buyer` | GET | 通知買家賣貨便網址 |
| `/api/member` | GET | 取得會員資料（LIFF 用） |
| `/api/member/register` | POST | 會員註冊 |
| `/api/member/birthday` | POST | 更新生日（已停用，生日改為唯讀） |
| `/api/cron/birthday` | POST | 生日禮 Cron（每月 1 日） |

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
| 已完成 | 訂單完成（自動計點） | — |
| 已取消 | 訂單取消 | — |

---

## 建議售價計算邏輯

```
匯率 = JPY→TWD 即時匯率 + 0.015
成本 = 匯率 × 日幣價格 × 1.075 + 180
個位數 ≤4 → 調整為 5；個位數 ≥6 → 調整為 9（或進位）
```

---

## 會員等級制度

| 等級 | 年度消費門檻 | 點數回饋率 | 生日禮 |
|------|------------|-----------|------|
| 一般 | — | 1% | NT$100 × 1 張 |
| 銀卡 | NT$3,000 | 2% | NT$150 × 1 張 |
| 金卡 | NT$8,000 | 3% | NT$200 × 1 張 |
| 白金 | NT$15,000 | 5% | NT$300 × 1 張 |

- 點數有效期：獲得後 1 年
- 邀請獎勵：被邀請人首單完成後，雙方各獲 NT$50 折扣碼 × 2 張

---

## Rich Menu

**Rich Menu ID**：`richmenu-5f78e8bccf8aebb4f3201064da3f01ec`

| 按鈕 | 動作 |
|------|------|
| 查詢紀錄 | postback: `action=query_history` |
| 開始購物 | URI: `https://www.grail.bz` |
| 購物車 | URI: `https://liff.line.me/2009823505-mhQivhxd` |
| 購物指南 | URI: `https://pfroger-linebot-2.vercel.app/guide` |
| 穿搭靈感 | URI: Instagram |
| 會員中心 | URI: `https://liff.line.me/2009823505-bwMBpOjU` |

---

## 專案結構

```
.
├── index.js              # 主程式（Express + LINE Bot + LIFF + 管理後台）
├── package.json
├── vercel.json           # Vercel 部署設定（含 Cron）
├── .env.example          # 環境變數範例
├── public/
│   └── guide/
│       ├── step1.jpg     # 購物指南步驟圖片
│       ├── step2.jpg
│       ├── step3.jpg
│       ├── step4.jpg
│       └── step5.jpg
└── README.md
```

---

## 已知限制

- `vercel login` 在此機器失效（Windows 使用者名稱含中文），改用 Token 或 GitHub 自動部署
- LIFF 需建在 LINE Login Channel（非 Messaging API Channel）
- 管理後台 URL 輸入欄位目前沒有輸入格式驗證
- Google Sheets 欄位順序固定，新增欄位只能加在末尾以保持相容性
