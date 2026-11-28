# Garmin Run 2026 測驗與抽獎交接

工作區快照日期為 2026-11-28。這是一個雙語跑者風格與補水互動測驗，完成後可下載分享圖、匿名提交答案，並取得現場兌獎結果。把本檔交給 ChatGPT 即可了解現況。需要實作時，再依任務附上對應原始碼。

本次高併發任務已將前端確認流程及必要壓測工具從 stash 選擇性整合至本機工作樹，stash 本身保留；未部署、commit、push 或送出新 Demo 請求。更新步驟、計時定義及 170 筆 POST 分階段計畫見 [高併發改善交接](../tests/HIGH_CONCURRENCY_OPTIMIZATION.md)。新版效能及五表一致性仍待使用者確認部署後驗證。

## 給接手的 ChatGPT

> 請以本交接和附上的現行原始碼為準。先確認任務操作的是 GitHub Pages 前端、本機 Apps Script、Mock 或 Demo。保留題目 ID、分類、Q4、獎品資格和匿名資料契約。把 stash 中的草稿視為尚未整合的工作。只改本次相關檔案，驗證使用離線 fixture、Mock 或經授權的 Demo。Git 提交、推送與後端部署請依使用者明確指示。

## 使用者流程

首頁 → 作答 Q1–Q5 → 顯示跑者結果卡及補水建議 → 完成永續選擇 → 匿名提交 → 兌獎頁或獎品發完畫面。

- 網站支援繁體中文與英文，題目、選項、結果、CTA 和介面文字由 `content.csv` 提供。附錄收錄完整 CSV 文案。
- 結果卡可輸出 1080 × 1920 PNG，分享圖沿用網站結果卡 DOM。兌獎畫面另含現場分享活動文字，匿名提交不接受抽獎登記或聯絡資料。
- Q4 為 `precision` 或 `rest` 時，先選擇加入或考慮永續補水，才可提交。Q4 為 `pioneer` 時直接繼續。
- `allocated` 顯示獎品及兌獎內容。只有 Q4 選 `pioneer` 且成功優先取得購物袋時顯示「先鋒隊專屬」。`paused` 顯示發完提示並隱藏獎品。

## 分類與獎品規則

測驗版本為 2，匿名提交版本為 1。Q1、Q2、Q3、Q5 各對選項所屬類型加一分，最高分勝出。四題平手時由 Q2 的類型決勝。Q4 獨立產生補水風格，跑者類型與補水風格交叉對應九組推薦。

| 跑者 ID | 中文名稱 |
|---|---|
| `experience` | 賽事收藏家 |
| `lifestyle` | 自在巡航員 |
| `performance` | 配速計算機 |

| Q4 與選擇 | 承諾值 | 永續資格 | 優先獎品資格 |
|---|---|---|---|
| `q4_pioneer`，原已自備 | `existing` | 有 | 有 |
| `q4_precision` 或 `q4_rest`，選擇加入 | `joined` | 有 | 無 |
| `q4_precision` 或 `q4_rest`，仍在考慮 | `considering` | 無 | 無 |

有優先資格且啟用的購物袋仍有庫存時，分配 `shopping_bag`，方式為 `premium_priority`。購物袋無法分配時進入一般池，方式為 `premium_fallback`。其他人走 `general_weighted`。一般池包含 `cap`、`soft_cup`、`socks`、`arm_sleeves`，以各啟用獎品的剩餘庫存為權重。無可分配獎品或正式分配暫停時，回傳 `paused`。初始化程式中的庫存是空白工作簿種子值，實際庫存以對應工作表為準。

## 架構與原始碼入口

```text
GitHub Pages → index.html + style.css + content.csv
                       ↓
                   js/appV2.js
                       ↓
         分類、資格、結果、分享圖、暫存
                       ↓
             environment.js + apiClient.js
              ↙                         ↘
    本機 localStorage Mock          Apps Script Web App
                                       ↓
                                 Google Sheets
```

| 路徑 | 職責 |
|---|---|
| `index.html`、`style.css` | 主站畫面、語言切換、結果與兌獎版面。入口 JS 使用版本查詢參數 |
| `content.csv`、`js/contentData.js` | 雙語文案與解析。選項 ID、畫面文案和顯示順序可獨立處理 |
| `js/appV2.js` | 問答狀態、畫面切換、永續選擇、提交、復原和下載 |
| `js/classificationEngine.js`、`js/classificationRules.js` | V2 計分、Q2 平手與 Q4 補水規則 |
| `js/prizeEligibility.js`、`js/participationValidation.js` | 永續及優先資格、匿名資料驗證 |
| `js/environment.js`、`js/apiClient.js`、`js/sessionRecovery.js` | 環境路由、Mock/API、同 ID 復原與 sessionStorage |
| `js/redemptionView.js`、`js/shareCard.js` | 兌獎狀態與結果 PNG |
| `js/hydrationEquipment.js`、`js/projectAssets.js`、`assets/` | 補水裝備、資產路徑、圖片 |
| `apps-script/Code.gs`、`Validation.gs` | HTTP 入口、模式、診斷、伺服器端分類和驗證 |
| `apps-script/Allocation.gs`、`Inventory.gs`、`Setup.gs` | 冪等與分配、庫存管理、資料表及 migration |

本機以 `python3 -m http.server 8000` 啟動，在 `http://localhost:8000/` 使用 Mock。一般 Codespaces 開發入口也使用 Mock。加 `?mode=apps-script-demo` 走共用 Apps Script Web App 的 Demo 路由，寫入 `Demo*` 表。公開網站一般入口走正式表。Demo 模式只負責路由，正式 API 失敗時前端會顯示錯誤。壓測使用經核准的 Demo 環境。

## 匿名 API 與 Google Sheets

- GET `getPublicCampaignStatus` 回傳模式、測驗與提交版本及分配狀態。GET `getExistingAllocation` 使用原 `requestId` 和 `sessionId` 查詢終態。Demo 的 `getDemoRequestTiming` 只在本機後端版本的特定診斷條件下可用。
- POST 傳入 `submissionVersion`、`quizVersion`、`requestId`、`sessionId`、`answers.q1–q5`、`runnerType`、`hydrationStyle`、`q4Answer`、`existingSelfHydration`、`hydrationCommitment`、`sustainabilityRewardEligible`、`premiumPrizeEligible`。伺服器重新計算並比對。姓名、Email、電話、地址、抽獎與隱私同意欄位不屬於匿名契約。
- 成功回傳 `allocationStatus`、參與者及請求的技術 ID、獎品、模式等資料。暫停時獎品為空。同 ID、同 session、同 fingerprint 回放既有結果。ID 衝突會拒絕。處理中的請求回 `REQUEST_PENDING_RETRY`，重試沿用原 ID。冪等以提交為單位。
- `Requests` 和 `DemoRequests` 為九欄，依序是 requestId、sessionId、participantId、status、resultJson、createdAt、updatedAt、submissionVersion、submissionFingerprint。
- 正式 `Participants` 可用 13 欄摘要，包含參與者代碼、建立時間、跑者類型、三個自備或資格欄、補水風格、五題答案和獎品中文名稱。也支援舊版 26 欄完整版。Demo 使用 26 欄。新匿名列的 legacy 個資欄留空。
- `Prizes` 記啟用與庫存，`Allocations` 記獎品分配，`InventoryLog` 記扣減，`Settings` 記正式分配開關，`AdminAudit` 記管理操作。Demo 的五張業務表具有 `Demo` 前綴。
- `migrateStagingAnonymousSchema` 與 `migrateProductionAnonymousSchema` 用於相容結構更新。正式摘要 migration 會覆寫和刪除欄位。既有工作簿的 migration 先用副本驗證，`setupActivitySheets()` 僅用於新工作簿。

## 版本與目前工作狀態

| 位置 | 狀態 |
|---|---|
| `main` 與本機 `origin/main` 追蹤引用 | 交接時同為 `a859d43`。其中包含 `c2bdec2` 的忽略規則及後端離線測試更新 |
| `local/history-before-sync` | 本機保存的舊歷史含舊 Apps Script 提交。維持本機保存 |
| `apps-script/`、`test-results/`、`_archive/` | 由根目錄 `.gitignore` 排除新增追蹤。後端或報告需另外從本機取用 |
| `stash@{0}` | 保留原始草稿快照；相關前端與必要測試已選擇性整合至本機工作樹，主站 appV2 現在載入 allocationConfirmation.js；尚未發布 |
| 正式網站與 Apps Script | Git 追蹤引用的狀態已查核，GitHub Pages 佈署結果及 Apps Script 生效版本仍需從各自的部署介面查核 |

本機 `appV2.js` 重用原 payload 和 ID，不確定結果最多以原 ID 退避查三次，驗證模式、身分和終態。`sessionRecovery.js` 一併保存 demoMode 與明確的 mock/demo/production environment，防止 Mock 與 Demo 都標 true 時誤送。舊版缺環境標記的 pending 保留原 ID 查詢，未命中時不重送，提示返回原入口或請工作人員核對；已知跨環境 pending 不查詢/重送。不能單獨拿舊 stash 的兩個前端檔覆蓋目前儲存契約。

## 本機後端優化與驗證

本機 Apps Script 已合併正式狀態設定讀取、減少重複的 schema 欄寬讀取。提交在 Script Lock 下寫入，Requests 先記 `processing`。分配成功與 paused 兩條路徑都先 flush 相關寫入，再標記終態並在解鎖前 flush。Demo 診斷新增 `sheetFlushMs`，此耗時包含在 `sheetWriteMs`。診斷預設關閉，需設定 `GARMIN_RUN_DEMO_DIAGNOSTICS=true`，且僅用於 Demo 的合成 `load-*` ID。多表寫入仍可能中斷，留下需對帳的 `processing`。

- 本次 `node tests/v2.backend.test.mjs` 的 15 項記憶體後端測試通過，覆蓋冪等、庫存、Demo/Production、遷移、模擬 flush 失敗後同 ID 不重扣，另驗證診斷降級與 recovery 無鎖/不讀全表 JSON。
- 新增前端確認及提交整合測試（含舊 pending 與 Mock/Demo 隔離），及 Node 分段計時/Before-After 工具。本機離線驗證不代表真實 Apps Script 效能。先前全套已知 `mainRunnerNames.test.mjs` 入口正規表示式不接受 `?v=...`；本次未改此無關測試。
- `test-results/FINAL_REPORT.md` 記錄 840 筆 Jitter 觀察，原請求成功 684、逾時後恢復 33、當時 UNKNOWN 123。後續 DemoRequests 匯出確認其中 1 筆完成，122 筆仍缺已完成證據。五表對帳和本機新版程式的實際延遲尚待驗證。
- 交接時沒有執行瀏覽器流程測試、遠端壓測或正式庫存操作。前端復原已在本機整合；瀏覽器驗收、部署確認、Demo 五表對帳、尖峰 P95 與後端實際分段耗時仍是未結事項。

若要交給另一個對話，優先附本檔。內容或版面任務附 `content.csv`、`index.html` 和相關模組。API 或庫存任務附本機 `apps-script/` 的相關原始碼及 `tests/v2.backend.test.mjs`。需要效能背景時附 `FINAL_REPORT.md`。附件使用公開文案、程式碼、匿名統計和合成測試資料。

## 附錄完整雙語文案

以下是 `content.csv` 的內容快照。每列保留原始 ID 及有值的欄位。空白欄位省略。實作與文案更新以 CSV 為準。

### 版本

| ID | 欄位與內容 |
|---|---|
| `quizVersion` | `zh` 2<br>`en` 2 |

### Q1

| ID | 欄位與內容 |
|---|---|
| `q1` | `zh` 我參加 Garmin Run 是因為...<br>`en` I'm joining Garmin Run because… |
| `q1_subtitle` | `parent_id` q1 |
| `q1_experience` | `parent_id` q1<br>`zh` 跑者大拜拜之一，必須搶！<br>`en` One of the biggest runner meetups of the year—I had to sign up!<br>`traits` experience<br>`sustainability` false<br>`is_meme` false |
| `q1_lifestyle` | `parent_id` q1<br>`zh` 有好玩賽事都報！<br>`en` I sign up for any race that looks fun!<br>`traits` lifestyle<br>`sustainability` false<br>`is_meme` false |
| `q1_performance` | `parent_id` q1<br>`zh` 目標賽事之一，11月底是突破PB的好時機！<br>`en` It's one of my goal races—late November is the perfect time to set a new PB!<br>`traits` performance<br>`sustainability` false<br>`is_meme` false |

### Q2

| ID | 欄位與內容 |
|---|---|
| `q2` | `zh` 從5月報名到今天比賽前…<br>`en` From signing up in May to race day… |
| `q2_subtitle` | `parent_id` q2 |
| `q2_experience` | `parent_id` q2<br>`zh` 蛤? 訓練是什麼?<br>`en` Huh? What's training?<br>`traits` experience<br>`sustainability` false<br>`is_meme` false |
| `q2_lifestyle` | `parent_id` q2<br>`zh` 不分賽季，平常都一直在跑啦<br>`en` I run year-round, whether it's race season or not.<br>`traits` lifestyle<br>`sustainability` false<br>`is_meme` false |
| `q2_performance` | `parent_id` q2<br>`zh` 每天課表吃到飽<br>`en` A full serving of training, every day!<br>`traits` performance<br>`sustainability` false<br>`is_meme` false |

### Q3

| ID | 欄位與內容 |
|---|---|
| `q3` | `zh` 賽前一晚收拾裝備<br>`en` Packing my gear the night before the race |
| `q3_subtitle` | `parent_id` q3 |
| `q3_experience` | `parent_id` q3<br>`zh` 儀式感要有，裝備排好來張大合照！<br>`en` A race-day ritual: lay out my gear and take a big group photo!<br>`traits` experience<br>`sustainability` false<br>`is_meme` false |
| `q3_lifestyle` | `parent_id` q3<br>`zh` 該帶的塞進衣保袋、晶片綁好，睡飽比較重要啦<br>`en` Pack what I need in the gear-check bag, secure my timing chip, and get a good night's sleep—that's what matters.<br>`traits` lifestyle<br>`sustainability` false<br>`is_meme` false |
| `q3_performance` | `parent_id` q3<br>`zh` 鞋子、手錶、果膠…必須萬無一失！<br>`en` Shoes, watch, gels… everything has to be dialed in!<br>`traits` performance<br>`sustainability` false<br>`is_meme` false |

### Q4

| ID | 欄位與內容 |
|---|---|
| `q4` | `zh` 跑到補給站前<br>`en` Before I reach the aid station |
| `q4_subtitle` | `parent_id` q4 |
| `q4_precision` | `parent_id` q4<br>`zh` 看準空檔，精準進站！遠離人群！<br>`en` Spot the opening, make a precise stop, and stay clear of the crowd!<br>`sustainability` false<br>`is_meme` false<br>`hydration_style` precision |
| `q4_rest` | `parent_id` q4<br>`zh` 終於可以休息！ 看看有什麼好吃的?<br>`en` Finally, a break! Let's see what snacks are on offer.<br>`sustainability` false<br>`is_meme` false<br>`hydration_style` rest |
| `q4_pioneer` | `parent_id` q4<br>`zh` 優雅地拿出自己的軟水杯／軟水壺裝水<br>`en` I gracefully pull out my own soft cup or flask and fill it up.<br>`sustainability` true<br>`is_meme` false<br>`hydration_style` pioneer |

### Q5

| ID | 欄位與內容 |
|---|---|
| `q5` | `zh` 剩下最後 2K<br>`en` With just 2K to go |
| `q5_subtitle` | `parent_id` q5 |
| `q5_experience` | `parent_id` q5<br>`zh` 準備好！我要漂亮進站<br>`en` Ready! Time to make a stylish stop at the aid station.<br>`traits` experience<br>`sustainability` false<br>`is_meme` false |
| `q5_lifestyle` | `parent_id` q5<br>`zh` 這2km好漫長~~~~<br>`en` These last 2K feel endless~~~~<br>`traits` lifestyle<br>`sustainability` false<br>`is_meme` false |
| `q5_performance` | `parent_id` q5<br>`zh` All in了！現在不衝什麼時候衝！<br>`en` All in! If not now, when?<br>`traits` performance<br>`sustainability` false<br>`is_meme` false |

### 跑者結果

| ID | 欄位與內容 |
|---|---|
| `experience` | `zh` 賽事收藏家<br>`en` Race Collector<br>`image_src` ./assets/result/賽事收藏家.webp<br>`image_alt_zh` 賽事收藏家跑者插畫<br>`image_alt_en` Illustration of the Race Collector runner<br>`slogan_zh` 跑的是賽事，收的是回憶！<br>`slogan_en` I run for the races and collect the memories!<br>`tag1_zh` 儀式感不能少<br>`tag1_en` Rituals are a must<br>`tag2_zh` 氣分組<br>`tag2_en` Here for the vibes<br>`tag3_zh` 跑一場玩一場<br>`tag3_en` A race, an adventure |
| `lifestyle` | `zh` 自在巡航員<br>`en` Easygoing Cruiser<br>`image_src` ./assets/result/自在巡航員.webp<br>`image_alt_zh` 自在巡航員跑者插畫<br>`image_alt_en` Illustration of the Easygoing Cruiser runner<br>`slogan_zh` 跑步是生活，比賽是日常！<br>`slogan_en` Running is part of life; races are part of my routine!<br>`tag1_zh` 舒服最重要<br>`tag1_en` Comfort comes first<br>`tag2_zh` 以賽代訓<br>`tag2_en` Racing as training<br>`tag3_zh` 我有我的節奏<br>`tag3_en` My own rhythm |
| `performance` | `zh` 配速計算機<br>`en` Pace Calculator<br>`image_src` ./assets/result/配速計算機.webp<br>`image_alt_zh` 配速計算機跑者插畫<br>`image_alt_en` Illustration of the Pace Calculator runner<br>`slogan_zh` 追逐PB是我跑下去的動力！<br>`slogan_en` Chasing a PB keeps me going!<br>`tag1_zh` 設定目標<br>`tag1_en` Set a goal<br>`tag3_zh` 差一秒就破PB<br>`tag3_en` One second from a PB<br>`tag4_zh` 抓水杯也要練習<br>`tag4_en` Practice picking up cups at aid stations |

### 補水推薦

| ID | 欄位與內容 |
|---|---|
| `experience_precision` | `parent_id` experience<br>`zh` 水袋背心<br>`en` Hydration vest<br>`description_zh` 不用跟人擠，想喝就喝，還能外帶點食物<br>`description_en` Skip the crowd: sip whenever you like, and even bring along a snack.<br>`hydration_style` precision |
| `experience_rest` | `parent_id` experience<br>`zh` 軟水杯<br>`en` Soft cup<br>`description_zh` 用自己的杯子，慢慢休我就Chill~~<br>`description_en` Bring your own cup, take your time, and chill~~<br>`hydration_style` rest |
| `experience_pioneer` | `parent_id` experience<br>`zh` 懂玩! 你已經帶上自己補水裝備<br>`en` You know how to enjoy race day—you've brought your own hydration gear!<br>`description_zh` 也邀請身邊的跑友一起試試不同的補水方式<br>`description_en` Invite your running friends to try a different way to hydrate, too.<br>`hydration_style` pioneer |
| `lifestyle_precision` | `parent_id` lifestyle<br>`zh` 軟水壺／水袋背心<br>`en` Soft flask / hydration vest<br>`description_zh` 不用跟人擠，想補就補維持自己節奏<br>`description_en` Skip the crowd and stay in your own rhythm—refill whenever you need.<br>`hydration_style` precision |
| `lifestyle_rest` | `parent_id` lifestyle<br>`zh` 軟水杯<br>`en` Soft cup<br>`description_zh` 輕到沒有存在感，還能在水站休一下<br>`description_en` So light you barely notice it, and perfect for taking a breather at the aid station.<br>`hydration_style` rest |
| `lifestyle_pioneer` | `parent_id` lifestyle<br>`zh` 不愧是專業跑者，不忘帶上自己補水裝備<br>`en` That's what we call a pro—you remembered your own hydration gear!<br>`description_zh` 也邀請身邊的跑友一起試試不同的補水方式<br>`description_en` Invite your running friends to try a different way to hydrate, too.<br>`hydration_style` pioneer |
| `performance_precision` | `parent_id` performance<br>`zh` 軟水杯<br>`en` Soft cup<br>`description_zh` 偶爾也可以喘口氣，以不同的方式體驗賽道<br>`description_en` Take a breather once in a while and experience the course another way.<br>`hydration_style` precision |
| `performance_rest` | `parent_id` performance<br>`zh` 軟水杯<br>`en` Soft cup<br>`description_zh` 該休還是要休一下，帶著輕到沒有存在感<br>`description_en` Even the focused need a break—bring a cup so light you'll barely notice it.<br>`hydration_style` rest |
| `performance_pioneer` | `parent_id` performance<br>`zh` 神人級! 這樣速還帶上自己補水裝備!<br>`en` Incredible! You're moving this fast and still brought your own hydration gear!<br>`description_zh` 也邀請身邊的跑友一起試試不同的補水方式<br>`description_en` Invite your running friends to try a different way to hydrate, too.<br>`hydration_style` pioneer |

### 介面文案

| ID | 欄位與內容 |
|---|---|
| `result.eyebrow` | `zh` YOUR RUNNER STYLE<br>`en` YOUR RUNNER STYLE |
| `result.label` | `zh` 跑者身分<br>`en` Runner type |
| `result.hydrationLabel` | `zh` 下一次可以試試<br>`en` Try this next time |
| `result.note` | `zh` 補水裝備推薦<br>`en` Hydration gear recommendation |
| `result.retry` | `zh` 重新測驗<br>`en` Retake the quiz |
| `navigation.back` | `zh` 返回<br>`en` Back |
| `navigation.next` | `zh` 下一題<br>`en` Next question |
| `quiz.seeResult` | `zh` 看結果<br>`en` See my result |
| `result.continue` | `zh` 下一步｜領取活動獎品<br>`en` Continue to claim your event prize |
| `redemption.eyebrow` | `zh` 現場兌換<br>`en` ON-SITE REDEMPTION |
| `redemption.placeholder` | `zh` 獎品圖片尚未提供<br>`en` Prize image unavailable |
| `redemption.instruction` | `zh` 請至攤位找工作人員領取 Garmin 周邊<br>`en` Please visit the booth and ask a staff member to claim your Garmin merchandise. |
| `redemption.codeLabel` | `zh` 兌換編號<br>`en` Redemption code |
| `redemption.restart` | `zh` 再測一次<br>`en` Take the quiz again |
| `v2.startLabel` | `zh` GARMIN RUN 跑者風格測驗<br>`en` GARMIN RUNNER STYLE QUIZ |
| `v2.shareCardHeaderSuffix` | `zh` 跑者風格測驗<br>`en` Runner Style Quiz |
| `v2.startTitle` | `zh` 跑出你的風格<br>`en` Find your running style |
| `v2.startManifestoRun` | `zh` You Run<br>`en` You Run |
| `v2.startManifestoChoose` | `zh` You Choose<br>`en` You Choose |
| `v2.startManifestoChange` | `zh` We Change<br>`en` We Change |
| `v2.startFooter` | `zh` Ready, Set, Change<br>`en` Ready, Set, Change |
| `v2.shareCardFooter` | `zh` Ready, Set, Change!<br>`en` Ready, Set, Change! |
| `v2.startDescription` | `zh` 重溫Garmin Run找到你的跑者風格！<br>`en` Rediscover Garmin Run and discover your running style! |
| `v2.startButton` | `zh` 開始測驗<br>`en` Start the quiz |
| `v2.youAre` | `zh` 你是<br>`en` You are |
| `v2.recommendation` | `zh` 下一場，可以試試……<br>`en` Next time, try… |
| `v2.invitation` | `zh` 你願意試試「自己帶水」嗎?<br>`en` Would you like to try bringing your own hydration gear? |
| `v2.invitationNote` | `zh` 一起加入永續先鋒隊！<br>`en` Join the Sustainability Pioneers! |
| `v2.joined` | `zh` 願意！<br>`en` I'm in! |
| `v2.considering` | `zh` 我會好好考慮的~<br>`en` I'll give it some thought! |
| `v2.continue` | `zh` 前往領獎<br>`en` Continue to claim your prize |
| `v2.pioneerThanks` | `zh` 謝謝你已經開始自帶補水！<br>`en` Thank you for already bringing your own hydration gear! |
| `v2.chooseError` | `zh` 請先選擇加入或考慮，再繼續領獎。<br>`en` Please choose whether to join or consider the action before continuing. |
| `v2.submitError` | `zh` 提交失敗，請保留本頁並重試；同一提交不會重複扣庫存。<br>`en` Submission failed. Please stay on this page and retry; the same request won't deduct inventory twice. |
| `v2.backendOld` | `zh` 獎項服務版本不相容，請稍後再試或聯繫現場工作人員。<br>`en` The prize service version is incompatible. Please try again later or contact event staff. |
| `v2.retry` | `zh` 重新測驗<br>`en` Retake the quiz |
| `v2.home` | `zh` 回首頁<br>`en` Return to the home page |
| `meta.title` | `zh` Garmin Run｜跑者風格測驗<br>`en` Garmin Run \| Runner Style Quiz |
| `meta.description` | `zh` Garmin Run 跑者風格與補水方式互動測驗<br>`en` An interactive Garmin Run quiz about running styles and hydration habits. |
| `brand.home` | `zh` 2026 Garmin Run 回到首頁<br>`en` Return to the 2026 Garmin Run home page |
| `brand.headerPrefix` | `zh` 2026 Garmin<br>`en` 2026 Garmin |
| `brand.headerRun` | `zh` Run<br>`en` Run |
| `language.toggle` | `zh` 切換語言<br>`en` Switch language |
| `footer.brand` | `zh` GARMIN RUN<br>`en` GARMIN RUN |
| `footer.tagline` | `zh` MOVE WITH PURPOSE<br>`en` MOVE WITH PURPOSE |
| `quiz.total` | `zh` / 05<br>`en` / 05 |
| `v2.mockBadge` | `zh` MOCK MODE<br>`en` MOCK MODE |
| `v2.mockTools` | `zh` 測試工具<br>`en` Test tools |
| `v2.mockPanelLabel` | `zh` Mock Mode 測試工具<br>`en` Mock Mode test tools |
| `v2.mockEyebrow` | `zh` MOCK TEST ENVIRONMENT<br>`en` MOCK TEST ENVIRONMENT |
| `v2.mockTitle` | `zh` 活動驗收工具<br>`en` Event test tools |
| `v2.close` | `zh` 關閉<br>`en` Close |
| `v2.mockNote` | `zh` 僅使用瀏覽器本機測試資料，不會連接或修改 Google Sheets。<br>`en` Uses browser-local test data only. It does not connect to or modify Google Sheets. |
| `v2.mockPremiumAvailable` | `zh` 購物袋有庫存<br>`en` Shopping bags in stock |
| `v2.mockPremiumEmpty` | `zh` 購物袋耗盡<br>`en` Shopping bags out of stock |
| `v2.mockGeneralEmpty` | `zh` 一般獎品耗盡<br>`en` General prizes out of stock |
| `v2.mockReset` | `zh` 重置初始庫存<br>`en` Restore starting inventory |
| `v2.mockClear` | `zh` 清除測試資料<br>`en` Clear test data |
| `v2.mockPrizes` | `zh` 獎品庫存<br>`en` Prize inventory |
| `v2.mockParticipants` | `zh` 參加者<br>`en` Submissions |
| `v2.mockAllocations` | `zh` 獎品分配<br>`en` Prize allocations |
| `v2.mockInventoryLog` | `zh` 庫存紀錄<br>`en` Inventory log |
| `v2.visualMark` | `zh` RUN<br>`en` RUN |
| `v2.equipmentImages` | `zh` 補水裝備圖片<br>`en` Hydration gear images |
| `v2.mockApplyStock` | `zh` 套用庫存數量<br>`en` Apply inventory values |
| `v2.mockClearConfirm` | `zh` 清除本機 Mock 測試資料？<br>`en` Clear local Mock test data? |
| `v2.mockInvalidStock` | `zh` 庫存需為非負整數<br>`en` Inventory must be a non-negative whole number. |
| `v2.startLoadError` | `zh` 無法載入測驗內容，請重新整理。<br>`en` Unable to load quiz content. Please refresh the page. |
| `v2.redemptionRunnerPrefix` | `zh` 跑者風格｜<br>`en` Runner type \|  |
| `v2.prizeDetailsUnavailable` | `zh` 獎品資料尚未確認<br>`en` Prize details are not available yet. |
| `v2.redemptionTitle` | `zh` 恭喜你抽中！<br>`en` Congratulations! You won! |
| `v2.sustainabilityRedemptionTitle` | `zh` 永續先鋒隊專屬<br>`en` Pioneer Team Exclusive |
| `v2.sustainabilityMessage` | `zh` 謝謝你一起響應自帶補水行動｜另可領取永續行動貼紙與飄帶<br>`en` Thank you for joining the reusable hydration initiative! You can also pick up a sustainability sticker and ribbon. |
| `v2.redemptionInstruction` | `zh` 請至攤位找工作人員領取 Garmin 周邊<br>`en` Please visit the booth and ask a staff member to claim your Garmin merchandise. |
| `v2.shareDownload` | `zh` 儲存我的跑者結果<br>`en` Save my runner result |
| `v2.shareFormat` | `zh` 9:16 PNG・點擊即可下載<br>`en` 9:16 PNG · Tap to save |
| `v2.sharePreparing` | `zh` 結果圖準備中…<br>`en` Preparing your result image… |
| `v2.shareReady` | `zh` 結果圖已就緒<br>`en` Your result image is ready |
| `v2.shareError` | `zh` 結果圖無法產生，請重新測驗<br>`en` Could not create the result image. Please retake the quiz. |
| `v2.igTitle` | `zh` 更多永續故事<br>`en` More sustainability stories |
| `v2.igPlaceholder` | `zh` 查看 Instagram 貼文<br>`en` View the Instagram post |
| `v2.shareRaffleTitle` | `zh` 分享結果再抽Forerunner 70<br>`en` Share your result for a chance to win a Forerunner 70 |
| `v2.shareSaveStep` | `zh` Step 1. 長按儲存結果圖<br>`en` Step 1. Press and hold to save |
| `v2.igStoryStep` | `zh` Step 2. 閱讀Garmin永續故事<br>`en` Step 2. Read Garmin’s sustainability story |
| `v2.shareCommentStep` | `zh` Step 3. 在貼文底下留言分享你的跑者風格！參加抽獎<br>`en` Step 3. Comment with your runner style to enter the draw |
| `v2.demoBadge` | `zh` STAGING · 測試資料<br>`en` STAGING · TEST DATA |
| `v2.pausedPrizes` | `zh` 獎品已發放完畢<br>`en` All prizes have been distributed. |
| `v2.pausedThanks` | `zh` 謝謝你的參與~<br>`en` Thank you for participating. |
| `prize.cap` | `zh` Garmin 漁夫帽<br>`en` Garmin Bucket Hat |
| `prize.soft_cup` | `zh` Garmin 軟水杯<br>`en` Garmin Soft Cup |
| `prize.socks` | `zh` Garmin 襪子<br>`en` Garmin Socks |
| `prize.arm_sleeves` | `zh` Garmin 袖套<br>`en` Garmin Arm Sleeves |
| `prize.shopping_bag` | `zh` Garmin 購物袋<br>`en` Garmin Shopping Bag |
| `language.toEnglish` | `zh` EN<br>`en` EN |
| `language.toChinese` | `zh` 中<br>`en` 中 |
| `v2.visualKickerTop` | `zh` YOUR<br>`en` YOUR |
| `v2.visualKickerBottom` | `zh` PACE<br>`en` PACE |
| `quiz.progress` | `zh` 測驗進度<br>`en` Quiz progress |
| `brand.garmin` | `zh` GARMIN<br>`en` GARMIN |
| `brand.run` | `zh` RUN<br>`en` RUN |
| `equipment.hydrationVest` | `zh` Garmin 水袋背心<br>`en` Garmin Hydration Vest |
| `equipment.softFlask` | `zh` Garmin 軟水壺<br>`en` Garmin Soft Flask |
| `equipment.softCup` | `zh` Garmin 軟水杯<br>`en` Garmin Soft Cup |
| `v2.retrySubmit` | `zh` 重試提交<br>`en` Retry submission |
| `v2.serviceUnavailable` | `zh` 獎項服務目前未設定或暫時無法使用，請稍後再試。<br>`en` Prize service is not configured or is temporarily unavailable. Please try again later. |
| `v2.footerLead` | `zh` Ready, Set,<br>`en` Ready, Set, |
| `v2.startFooterChange` | `zh` Change<br>`en` Change |
| `v2.shareFooterChange` | `zh` Change!<br>`en` Change! |
| `v2.processing` | `zh` 抽獎中，請稍後<br>`en` Drawing your prize—please wait… |

