# CLAUDE.md — Bijin 日本正品代購 LINE Bot

> 這份文件讓 Claude 在每次對話開始時立刻掌握專案全貌，避免重複推導已知資訊。

---

## 專案概述

**商業用途**：Bijin日本正品代購（代購業者）的 LINE Bot，主要功能：
1. 用戶傳入 GRL (grail.bz) 商品網址 → 回傳商品報價 + 庫存 Flex Message
2. 用戶傳入 ZOZO 商品網址 → Chrome Extension 抓頁面 → 回傳報價 Flex Message
3. 加入購物車 → Flex Carousel（一個顏色一張卡片），GRL/ZOZO 均支援
4. LIFF 購物車頁面：查看購物車、選擇 7-11 門市、提交訂單
5. LIFF 會員中心：查看等級、點數、優惠券、進行中訂單進度
6. Rich Menu：查詢紀錄、開始購物（postback→Flex 3卡carousel）、購物車、購物指南、穿搭靈感、會員中心

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
| LIFF 購物車 | LINE Login Channel，LIFF ID: `2009823505-mhQivhxd` |
| LIFF 會員中心 | LINE Login Channel，LIFF ID: `2009823505-bwMBpOjU` |
| 資料庫 | Google Sheets（服務帳號認證） |
| 原始碼 | `index.js`（單一檔案，所有邏輯） |
| GitHub Repo | `PFRoger/grl-line-bot` (main branch) |

---

## 部署方式

### ⚠️ 重要：Windows 使用者名稱含中文「太豐」，`vercel login` 會因 HTTP header 錯誤失敗

**推薦：透過 GitHub 自動部署**
```bash
git add .
git commit -m "..."
git push origin main
# Vercel 會自動偵測 push 並部署到 pfroger-linebot-2.vercel.app
```

**備用（使用 Token）：**
```bash
VERCEL_TOKEN=<token> npx vercel --prod --yes --scope pfrogers-projects
```
- Token 從 https://vercel.com/account/tokens 建立（Full Account，No Expiration）
- `.vercel/project.json` 必須指向正確專案（projectId: prj_FSCfR5beQzSIe4qijBeizeInScP2）

---

## 環境變數（Vercel 設定）

| 變數 | 說明 |
|------|------|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Channel Access Token（主 Bot） |
| `LINE_CHANNEL_SECRET` | LINE Channel Secret |
| `ADMIN_KEY` | 管理員 API 金鑰（必填，沒設則後台無法登入） |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google 服務帳號 JSON |

⚠️ `ADMIN_KEY` 無預設值，必須在 Vercel 環境變數設定。

---

## Google Sheets 結構

| 工作表 | 用途 |
|--------|------|
| `查詢紀錄` | 每次商品查詢記錄（userId、商品ID、名稱、日幣、TWD等） |
| `購物車` | 臨時購物車（**48小時**後過期，J欄標記 deleted/ordered） |
| `訂單` | 已成立訂單（A~Q 欄：訂單ID、時間、userId、商品明細、總金額、買家資訊、狀態、點數、優惠券、折扣、實付、LINE顯示名稱、內部備註(Q)、倉庫(R)） |
| `會員` | 會員資料（userId、displayName、加入日、生日、邀請碼、等級、點數、年度消費等，共14欄） |
| `點數紀錄` | 每筆點數明細（A~H欄：pointId、date、userId、displayName、orderId、points、expiryDate、status） |
| `優惠券` | 優惠券（couponCode、userId、displayName、type、amount、issueDate、expiryDate、status、usedOrderId） |
| `邀請紀錄` | 邀請關係（inviterUserId、inviteeUserId、inviteCode、bindDate、orderDeadline、qualifyingOrderId、status） |

---

## 點數系統重要說明

- **餘額欄位**：`會員` 工作表 K 欄（r[10]）= 即時點數餘額，由 `deductMemberPoints()` 直接更新
- **明細欄位**：`點數紀錄` 工作表 = 歷史記錄，只有正向記錄（無扣除行）
- **顯示邏輯**：`/api/member` 和會員中心前端都用 `member.points`（K欄），**不從點數紀錄加總**
- 這個設計決策很重要：若改回從點數紀錄加總，扣點後點數顯示會出錯

---

## 訂單狀態流程（7階段）

| 狀態 | 說明 |
|------|------|
| 待確認 | 訂單剛建立 |
| 待買家完成下單 | 已傳賣貨便網址，等買家操作 |
| 處理中(待處理或完成官網下單) | 處理中 |
| 已發貨(官網出貨) | GRL 已出貨 |
| 已發貨(已達台灣海關作業) | 台灣海關作業中 |
| 已發貨(賣貨便出貨) | 我方已出貨 |
| 待買家取貨 | 到門市 |
| 已完成 | 完成（自動計點） |
| 已取消 | 取消 |
| 退單 | 退單：扣回點數、退還折抵點數、取消邀請獎勵優惠券 |

---

## index.js 重要函式索引

| 函式 | 說明 |
|------|------|
| `scrapeGRL()` | 爬 GRL 商品頁面，回傳 `{ productName, jpy, stockLines, imageUrl, colorImages, resolvedUrl, materialText }` |
| `buildFlexMessage()` | 建立 GRL 商品報價 Flex Message |
| `buildZOZOFlexMessage(data, url, rate)` | 建立 ZOZO 商品報價 Flex Message（含 NT$ 報價、加入購物車按鈕） |
| `buildAddToCartFlex()` | 建立加入購物車 Flex Carousel（一色一卡片） |
| `calcSuggestedPrice(rate, jpy, lbs)` | GRL 報價計算（195 JPY 國內運費） |
| `calcZOZOSuggestedPrice(rate, jpy, lbs)` | ZOZO 報價計算（330 JPY 國內運費，公式同 GRL） |
| `getCartItems()` | 讀取用戶購物車（過濾48小時過期 + deleted/ordered） |
| `submitOrder()` | 寫入訂單工作表 + 回傳 orderId（items 帶【GRL】/【ZOZO】標記） |
| `deductMemberPoints()` | 扣除點數，直接更新會員表 K 欄 |
| `processOrderCompletion()` | 訂單完成：計點、升等、邀請獎勵、通知買家 |
| `processOrderReturn()` | 退單：扣回本次計點、退還結帳折抵點數（L欄）、取消邀請獎勵優惠券、通知買家 |
| `getMember()` | 讀取會員資料（找不到回傳 null） |
| `buildCartHtml()` | 產生 LIFF 購物車 HTML |
| `estimateWeight(name, materialText, sleeveCm)` | 估算商品重量，回傳 `{ minG, maxG, midG, midLbs, label, confidence }`；sleeveCm 為 ZOZO 限定的實測袖長 |
| `handlePostback()` | 處理所有 postback 事件（含 add_to_cart_zozo、start_shopping） |

---

## API 路由

| 路由 | 方法 | 說明 |
|------|------|------|
| `/webhook` | POST | LINE Webhook 進入點 |
| `/cart` | GET | LIFF 購物車頁面（HTML） |
| `/member` | GET | LIFF 會員中心頁面（HTML） |
| `/api/cart` | GET | 取得購物車（?userId=...） |
| `/api/cart/add` | POST | 新增購物車項目 |
| `/api/cart/item` | DELETE | 刪除購物車單項 |
| `/api/order` | POST | 提交訂單 |
| `/api/member` | GET | 取得會員資料（?userId=...） |
| `/api/member/orders` | GET | 取得會員進行中訂單（?userId=...） |
| `/api/member/register` | POST | 會員註冊 |
| `/api/stores` | GET | 7-11 門市查詢代理 |
| `/admin` | GET | 管理員後台（?key=...） |
| `/api/admin/orders` | GET | 取得所有訂單 |
| `/api/admin/order-status` | POST | 更新訂單狀態 |
| `/api/admin/order-note` | POST | 更新內部備註（Q欄，不通知買家） |
| `/api/admin/order-warehouse` | POST | 更新倉庫分類（R欄：茨城倉/千葉倉） |
| `/api/admin/notify-progress` | POST | 通知買家進度 |
| `/admin/notify-buyer` | GET | 傳送賣貨便網址給買家 |
| `/api/debug/notify` | GET | 測試 LINE push 是否正常（?key=...） |
| `/api/cron/birthday` | POST | 生日禮 Cron（每月1日） |
| `/api/zozo-queue` | GET | Chrome Extension 輪詢取任務（?key=ADMIN_KEY） |
| `/api/zozo-queue` | POST | Chrome Extension 回傳 ZOZO 解析結果 |
| `/admin/setup-rich-menu` | GET | 重建 Rich Menu（?key=ADMIN_KEY，會刪除舊 menu） |

---

## LINE push 通知彙整

每筆訂單消耗約 10~12 則 push（免費方案 200則/月）：

| 時機 | 對象 | 則數 |
|------|------|------|
| 買家送出訂單 | 賣家+買家 | 2 |
| 賣家傳賣貨便網址 | 買家 | 1 |
| 賣家更新進度（每次）| 買家 | 1×次數 |
| 訂單已完成 | 買家 | 1 |
| 退單 | 買家 | 1 |
| 邀請獎勵 | 邀請人+被邀請人 | 2 |
| 生日禮（Cron） | 各有生日的會員 | N |

---

## Chrome Extension — ZOZO 查詢代理

- **目錄**：`chrome-extension/`（`background.js`, `manifest.json`, `popup.js`, `popup.html`）
- **功能**：Chrome Extension 安裝後，背景每 10 秒輪詢 `/api/zozo-queue`，有任務就開 Tab 抓 ZOZO 頁面（繞過 Akamai bot 偵測），解析後回傳
- **權限**：`alarms`, `tabs`, `scripting`；host_permissions: `*.zozo.jp/*`, `pfroger-linebot-2.vercel.app/*`
- **ADMIN_KEY**：`grl-admin-2026`（與 Vercel 環境變數一致）
- **Akamai 處理**：Tab 必須用 `active: true`（前景分頁），否則 Akamai 偵測為 bot；等頁面 complete 再等 1.5 秒，HTML < 10000 bytes 視為 challenge 頁再等 2 秒；全域 timeout 60 秒
- **三種解析器**：`parseZOZO(html, url)` 為 dispatcher，依頁面類型選擇：
  - `parseZOZOLegacy(html, url)`：舊版頁面（含 `data-goods-id` 屬性）
  - `parseZOZONextData(html, url)`：新版 goods-sale 頁面（`__NEXT_DATA__` JSON）
- **解析結果欄位**：`name, brand, price, isOnSale, originalPrice, goodsId, goodsCode, hasStock, colors, sizeEquivMap, url, materialText, sleeveCm`
- **sizeEquivMap**：解析 `<span class="sizeZ"><span>XS</span></span>サイズ相当` 結構，將 ZOZO 數字尺碼（2/3/4...）對應為「XSサイズ相当」等標示；只對純數字尺碼套用，M/L 等字母尺碼不受影響
- **materialText**：`extractZOZOMaterial(html)` 從 `<dt>素材</dt><dd>...</dd>` 結構抓取，對應 ZOZO 規格表（`p-goods-information-spec-horizontal-list`）。抓到的值存入 JSON result，`buildZOZOFlexMessage` 傳給 `estimateWeight()`
- **sleeveCm**：`extractSleeveLength(html)` 從說明文字「そで丈 18」格式抓取袖長 cm，作為針織估重的袖丈判斷依據
- **ZOZO Sheet**（`ZOZO任務`）：存 taskId, url, userId, status, result（JSON）, error 等（replyToken 已移除，改為 user-initiated）
- **流程**：用戶傳 ZOZO 網址 → 寫入 ZOZO Sheet（status=pending）→ 立即回傳「報價解析中」小卡（含「查看報價」postback 按鈕）→ Extension 抓頁面解析 → 存結果至 Sheet → 用戶點「查看報價」→ zozo_check postback → Bot reply 報價卡（或提示仍解析中/失敗/逾時）

---

## GAS 庫存監控系統（獨立於 LINE Bot）

- **檔案**：`gas_program_V7.6.txt`（v7.6.0，最新版）
- **功能**：定時爬 GRL 商品頁面，偵測價格/庫存變動，推送通知給賣家
- **觸發**：每6小時（GAS 時間型觸發器）
- **通知對象**：只有賣家（LINE_USER_ID = `U9fa329e70b89f4ce19089928a824bd29`）
- **通知內容**：有庫存變動時補貨/售完通知、下架通知、執行摘要（商品數/缺貨數/耗時/匯率）
- **Bot B**（@033vkbny）：GAS 通知專用，與主 Bot 各有獨立 200則/月額度
- **素材抓取**：`parseMaterialText(html)` 從 GRL 頁面 `div.tab-content` 抓含「素材は」的區塊，傳入 `estimateWeightLbs()` 做針織加成

### GAS v7.6.0 重量估算品類（index.js 一致，判斷順序優先）

| 品類 | 關鍵字 | 範圍 | 包裝加成 |
|------|--------|------|---------|
| 鞋類 | サンダル/スニーカー/ブーツ/パンプス/シューズ/ミュール/ローファー/スリッポン/ウェッジ/ヒール | 700~1020g | +200g |
| 包包 | バッグ/トートバッグ/ショルダーバッグ/ハンドバッグ/リュック/クラッチ/ポーチ | 450~820g | +150g |
| 配件 | ピアス/ネックレス/リング/ブレスレット/ヘアアクセ/ヘアクリップ/バレッタ/アクセサリー | 60~180g | +30g |
| 外套 | コート/アウター/ダウン/ブルゾン/ムートン | 650~1150g | +150g |
| 外罩衫 | ジャケット/カーディガン/ボレロ | 280~580g | +80g |
| 衛衣/帽T | スウェット/パーカー | 300~550g | +80g |
| 牛仔短褲 | ショートデニム/デニムショーツ/デニムショート（優先於牛仔褲） | 200~380g | +80g |
| 牛仔褲 | デニム/ジーンズ（優先於洋裝） | 500~850g | +80g |
| 洋裝 | ワンピース/ドレス | 200~480g | +80g |
| 裙子 | スカート | 170~400g | +80g |
| 內搭褲 | レギンス/スパッツ（優先於褲子） | 50~150g | +80g |
| 短褲 | ショートパンツ/ハーフパンツ（優先於褲子） | 120~300g | +80g |
| 褲子 | パンツ/スラックス | 220~520g | +80g |
| 針織上衣 | ニット/セーター | 180~400g | +80g |
| 上衣 | トップス/シャツ/ブラウス/カットソー/Tシャツ/タンク/ノースリーブ | 120~300g | +80g |
| 其他 | （以上均不符合） | 150~450g | +80g |

### 針織重量加成（優先順序）

1. **商品名袖丈關鍵字**：ノースリーブ/袖なし → +0g；半袖/半そで/ショートスリーブ/ポロシャツ → +45g；七分袖/五分袖 → +136g
2. **實測袖長 sleeveCm**（ZOZO 限定，index.js only）：< 30cm → +45g；30~44cm → +136g；≥ 45cm → 繼續素材判斷
3. **素材判斷**（袖丈未知時）：ウール/カシミア → +227g；アクリル → +180g；コットン/綿 → +136g；レーヨン/ポリエステル/ナイロン → +45g；未知 → +136g（保守預設）
4. 詳細規則見 `weight_rules.txt`

---

## Rich Menu

**目前使用的 Rich Menu ID**: 已透過 `/admin/setup-rich-menu` 重建（舊 ID `richmenu-5f78e8bccf8aebb4f3201064da3f01ec` 已廢棄）

| 按鈕 | 動作 |
|------|------|
| 查詢紀錄 | postback: `action=query_history` |
| 開始購物 | postback: `action=start_shopping`（回傳 3 張 Flex carousel） |
| 購物車 | URI: `https://liff.line.me/2009823505-mhQivhxd` |
| 購物指南 | postback: `action=tutorial` |
| 穿搭靈感 | URI: Instagram |
| 會員中心 | postback: `action=member` |

> Rich Menu 圖片無法直接替換，必須刪除舊 menu 再建立新 menu（GET `/admin/setup-rich-menu?key=...`）。

### start_shopping Flex Carousel（3 張卡片）

| 卡片 | 說明 |
|------|------|
| 說明卡 | hero 圖 `assets/how-to-quote-v7.jpg`（960×1280，3:4）；body 背景 `#F7E5D8` 蓋底部白條 |
| GRL 卡 | hero 圖 `assets/GRL.png`（1983×793，4:3）；白色 body；米色按鈕 `#c9a98a`；URI: grail.bz |
| ZOZO 卡 | hero 圖 `assets/ZOZO.png`（1983×793，4:3）；白色 body；米色按鈕 `#c9a98a`；URI: zozo.jp |

> 品牌 logo 圖片透過 GitHub raw URL 供 LINE 載入。圖片尺寸 4:3 由 `aspectRatio: '4:3'` 設定，`aspectMode: 'cover'`。

---

## GRL 圖片結構（已確認）

GRL 使用 `alt` 屬性關聯顏色與圖片：
```html
<img alt="ブラック" src="https://cdn.grail.bz/images/goods/t/ru1197/ru1197_col_11.jpg">
```
- **縮圖路徑**：`/images/goods/t/`
- **全尺寸路徑**：`/images/goods/d/`（把 `/t/` 換成 `/d/` 即可）

---

## 已知問題與決策記錄

- **`vercel login` 在此機器失效**：Windows 使用者名稱「太豐」含中文，造成 HTTP header 錯誤。改用 GitHub 自動部署。
- **LINE 200則/月限制**：免費方案。已建 Bot B（@033vkbny）分流 GAS 通知，主 Bot 與 GAS 各有獨立 200則額度。每筆訂單約耗 3~4 則（訂單確認+賣貨便+取貨提醒）。
- **訂單價格未伺服器端驗證**：suggestedPrice 由前端傳入，未重新計算驗證。賣家人工審核訂單通知可發現異常。
- **購物車過期**：6小時（程式內 EXPIRE_MS = 6h）
- **LIFF 不能建在 Messaging API Channel**：LINE 2024 年政策變更，LIFF 需另建 LINE Login Channel。
- **GRL 建議售價計算**：`匯率 = JPY→TWD + 0.015`，`成本 = 匯率 × (JPY + 195) × 1.075 + (150×ceil(lbs) + 20 + 10) + 120利潤`，個位數 ≤4 → 5，≥6 → 9。（195 = GRL 國內固定運費 JPY）
- **ZOZO 建議售價計算**：同 GRL 公式，但國內運費改為 **330 JPY**。`calcZOZOSuggestedPrice(rate, jpy, lbs)`
- **退單點數處理**：`processOrderReturn` 讀取 L 欄（index 11）`pointsUsed`，退款時補回折抵點數；同時找邀請紀錄中 `qualifyingOrderId===orderId && status==='completed'` 的行，改為 `returned`，並取消對應未使用的邀請獎勵優惠券。
- **會員中心訂單過濾**：DONE = `['已完成', '已取消', '退單']`，三種狀態均不顯示在會員中心進行中訂單列表。
- **後台訂單來源 badge**：`submitOrder` 在 items 前加 `【GRL】`/`【ZOZO】`；後台渲染成彩色 badge（GRL 粉紅，ZOZO 深藍白字）。
- **ZOZO 商品名稱查詢**：`add_to_cart_zozo` postback 以 goodsId 在「查詢紀錄」工作表找商品名（ZOZO 查詢同樣記錄在此）。
- **倉庫分類**：訂單 R 欄存倉庫，空白=未分配；茨城倉 NT$150/lb（約15工作天）；千葉倉 首2磅NT$250之後NT$120/lb（約10工作天）。
- **貨號格式**：支援中間夾字母，如 `PM870A`（regex 改為 `[a-z]{2}[a-z0-9]+`）。
- **訂單狀態通知政策**：狀態 1-2（待確認/待買家完成下單）、7（待買家取貨）、8（已完成）、9（退單）有 LINE 通知；狀態 3-6（處理中/已發貨系列）為靜默更新，不發通知。
- **後台訂單商品編輯**：點 ✏️ 開啟表格式編輯器，既有商品只能改價格/數量，可新增/刪除商品列。儲存後更新 D欄（items）、E欄（totalTwd）、O欄（finalAmount）。
- **Template literal 內 regex 轉義陷阱**：regex literal 中的 `\d`、`\s`、`\$` 在 Node.js template literal 裡會被吃掉（`\d`→`d`，`\$`→`$`），必須寫 `\\d`、`\\s`、`[$]`（字元類）或 `\\$`。字串 literal 中的 `\n` 也需要寫 `\\n`。
- **ZOZO 圖片抓取**：優先順序 swatchByName（顏色名對照）> swatchById（URL 抽取 colorId）> data-shelf-color-image-url > CDN 公式 URL（無 b 後綴）> og:image。goods-sale 頁面的 swatch alt 是完整商品名+顏色，需用 `|` 分割取後段或用 colorId 索引。
- **賣貨便小卡**：金額欄位加 `wrap: true` 避免長文字截斷（折扣金額顯示需要）。
- **報價小卡 6 小時過期**：`buildAddToCartFlex` 和 `buildZOZOFlexMessage` 的加入購物車 postback 帶 `&ts=<unix秒>`；`handlePostback` 中 `add_to_cart` / `add_to_cart_zozo` 均驗證 ts，超過 6 小時回覆提示重新查詢。
- **強制會員才能下單**：前端 `submitOrder()` 檢查 `isMember`（`init()` 時由 `/api/member` 回傳設定）；後端 `/api/order` 也驗證 `getMember()` 非空，否則 400。
- **ZOZO sizeEquivMap**：`background.js parseZOZO()` 回傳 `sizeEquivMap`（`{ "2": "XSサイズ相当", "3": "Sサイズ相当", ... }`）；`buildZOZOFlexMessage` 以 `/^\d+$/` 判斷純數字才查 map，字母尺碼（M/L）直接走 `zozoSizeName()`。
- **ZOZO materialText + sleeveCm**：Chrome Extension 解析結果包含 `materialText`（從 dt/dd 規格表抓素材）和 `sleeveCm`（從說明文字抓そで丈 cm）。兩者存入 Sheet JSON result，`buildZOZOFlexMessage` 讀出後傳給 `estimateWeight()`。
- **查詢紀錄「查看商品頁」URL**（2026-05-07 修正）：原本硬接 `/disp/item/{prodId}/`（路徑錯誤），ZOZO 商品的數字 goodsId 也被當 GRL prodId 拼接。改為優先用 M 欄儲存的 `canonicalUrl`（GRL/ZOZO 均有），舊紀錄無 URL 時才推算 GRL 路徑。
- **歡迎訊息 Flex 400 錯誤**（2026-05-07 修正）：`buildWelcomeFlexMessage` 使用 3 位 hex 顏色（`#666`、`#aaa`）不合 LINE 規格，改為 6 位（`#666666`、`#aaaaaa`）。LINE Flex Message 所有顏色必須為完整 6 位 hex。
