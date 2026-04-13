# GRL LINE Bot

當用戶傳入 [GRL（grail.bz）](https://grail.bz) 商品網址時，自動回覆商品名稱、日幣售價、建議售價（TWD）及各顏色尺寸庫存狀態。

---

## 功能

- 抓取 GRL 商品名稱、日幣價格、庫存狀態
- 顏色自動翻譯（日文 → 繁體中文）
- 庫存狀態翻譯（在庫あり / 在庫なし / 残りわずか / 予約販売）
- 即時 JPY → TWD 匯率（exchangerate-api.com）
- 自動計算含關稅運費的建議售價
- LINE Webhook 簽名驗證

---

## 前置需求

| 工具 | 說明 |
|------|------|
| Node.js ≥ 18 | 本地開發 |
| [LINE Developers 帳號](https://developers.line.biz/) | 取得 Channel Access Token & Channel Secret |
| 網路連線 | 匯率自動從免費公開端點取得，無需 API Key |
| [Vercel 帳號](https://vercel.com/) | 部署平台 |

---

## 本地開發

### 1. 安裝依賴

```bash
npm install
```

### 2. 設定環境變數

```bash
cp .env.example .env
```

編輯 `.env` 填入：

```env
LINE_CHANNEL_ACCESS_TOKEN=<你的 Access Token>
LINE_CHANNEL_SECRET=<你的 Channel Secret>
```

### 3. 啟動伺服器

```bash
npm start
# 或使用 --watch 自動重載
npm run dev
```

### 4. 使用 ngrok 測試 Webhook（選用）

```bash
ngrok http 3000
```

將 ngrok 產生的 URL 加上 `/webhook` 填入 LINE Developers Console 的 Webhook URL。

---

## 部署到 Vercel

### 方法一：Vercel CLI

```bash
# 安裝 CLI
npm i -g vercel

# 登入
vercel login

# 部署（首次會引導設定）
vercel

# 正式部署
vercel --prod
```

### 方法二：GitHub 自動部署

1. 將專案推送到 GitHub Repository
2. 前往 [vercel.com](https://vercel.com) → **Add New Project**
3. 匯入 GitHub Repo
4. 在 **Environment Variables** 頁籤填入以下兩個變數：

   | 變數名稱 | 說明 |
   |----------|------|
   | `LINE_CHANNEL_ACCESS_TOKEN` | LINE Channel Access Token |
   | `LINE_CHANNEL_SECRET` | LINE Channel Secret |

5. 點擊 **Deploy**

部署完成後，Webhook URL 為：

```
https://<your-project>.vercel.app/webhook
```

---

## 設定 LINE Webhook

1. 前往 [LINE Developers Console](https://developers.line.biz/console/)
2. 選擇你的 Messaging API Channel
3. **Messaging API** → **Webhook settings**
4. 填入 Webhook URL：`https://<your-project>.vercel.app/webhook`
5. 開啟 **Use webhook**
6. 點擊 **Verify** 確認連線正常（應回傳 200）

---

## 回覆格式範例

```
🌸 GRL 商品報價

フレアスリーブニット
💴 日幣：¥2,990
💵 建議售價：NT$479

📦 庫存：
  黑色 S: ✅ 有庫存
  黑色 M: ✅ 有庫存
  黑色 L: ❌ 缺貨
  米白色 S: ⚠️ 剩餘少量
  米白色 M: 📅 預約販售（預計5月下旬到貨）

⚠️ 以上報價以 1 磅計算
實際重量若超過 1 磅，運費將增加，售價會有所調整。
```

---

## 建議售價計算邏輯

```
匯率 = JPY→TWD 即時匯率 + 0.015
成本 = 匯率 × 日幣價格 × 1.075 + 180
建議售價：個位數 ≤4 → 調整為 5；個位數 ≥6 → 調整為 9
```

---

## 專案結構

```
.
├── index.js          # 主程式（Express + LINE Bot Webhook）
├── package.json
├── vercel.json       # Vercel 部署設定
├── .env.example      # 環境變數範例
└── README.md
```
