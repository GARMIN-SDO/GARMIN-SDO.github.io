# Garmin Run｜高併發改善與部署後回歸交接

更新日期：2026-11-28 UTC。已重新核對同步後工作樹：後端改善保留，前端及工具草稿由 stash 選擇性整合，原 stash 保留。狀態：本機實作與離線驗證；尚未部署，也沒有發送本次新測試請求。既有最終測試報告保留於 `../test-results/FINAL_REPORT.md`，本文件不是新的實測成績。

## 1. 基準與驗收

來源：`../test-results/data/jitter/summary.csv`、`runners.csv`、`per-second.csv`。以下均為 Flow、seed 20261127、每情境三輪。不可混用 clustered20 的數值。

| 情境 | 原請求成功 | 復原後確認 | P50 / P95 秒 | Timeout | UNKNOWN（測試當時） | After |
|---|---:|---:|---:|---:|---:|---|
| 10 人／10 秒 | 30/30（100%） | 30/30（100%） | 12.37 / 21.87 | 0 | 0 | 待部署測試 |
| 20 人／20 秒 | 58/60（96.7%） | 60/60（100%） | 11.19 / 27.30 | 2 | 0 | 待部署測試 |
| 20 人／10 秒 | 37/60（61.7%） | 43/60（71.7%） | 27.90 / 31.31 | 23 | 17 | 待部署測試 |

20 人／10 秒三輪合計至少 **51/60（85%）** 才達標，**54/60（90%）** 為目標。復原不回填原成功率。較晚的 DemoRequests 匯出仍缺此情境 17 筆；其他情境一筆 UNKNOWN 由匯出確認，不能改寫原始 HTTP 基準。

POST 保持 30 秒、GET 保持 15 秒。Flow 包括 GET→POST，並非整段共用一個 30 秒期限；P95 含客戶端逾時截尾，不是後端完整完成分布。實測前後須記錄版本、時間、歷史資料列數、庫存及其他使用者流量，不能將所有差異歸因於程式。

## 2. 後端實際路徑

| 區段 | 原本與保留的操作 | 本次調整 |
|---|---|---|
| Lock 前 | 解析 JSON、Demo 路由、白名單/答案/資格驗證、fingerprint 純運算、可選診斷開關、取得 ScriptLock | 保持驗證與 fingerprint 在鎖外 |
| Lock 內 | 取得五表、檢查 Participants/Requests 表頭、最終 requestId/session/fingerprint 去重；正式模式讀 allocationEnabled；單次 Prizes 快照、資格與加權抽獎、stock 檢查與扣除、參與者與分配/異動紀錄 | Requests 改搜尋 A 欄的完整、區分大小寫、非正規表示式 ID，命中才讀該列九欄 |
| Lock 後 | 原本 finally 釋放鎖後記錄計時 | 回應序列化與 ContentService 改到釋放鎖後；可選診斷快取亦在鎖外 |

原本 `return jsonResponse(result)` 會先求值才執行 finally，因此建立 JSON/TextOutput 仍在 Lock 內；現在先傳回一般物件，外層才建立 HTTP 回應。

正常新分配維持六次寫入：Requests processing → Prizes F:G 一次扣/加 → Participants → Allocations → InventoryLog → Requests D:G allocated。目前後端另有兩次 flush：先確保依賴資料完成，再公布終態，最後在解鎖前 flush；本次整合保留這項較新保護。沒有分離庫存讀取與扣除，沒有移除最終去重，也沒有取消 Lock。paused 路徑亦先記 processing、完成 Participants 後才公布 paused。

前一版已經把 Prizes 從重複讀取降為一次，並合併庫存兩格及 Requests 完成狀態寫入。這些是本次 Before 已存在的改善，不能重複算成本次收益。這次不把不同工作表的寫入假稱為一次原子交易；未引入 Advanced Sheets API/batchUpdate 或新授權。

`findRequest()` 原本每次讀完整 Requests，包含每列 resultJson/fingerprint；現在只在 ID 欄搜尋，不傳回整表資料。**TextFinder 仍可能在服務端掃描欄位，不是索引，也不保證比短表快**；命中需再讀一列，實際收益以 requestLookupMs/lockHeldMs 判斷。若歷史 ID 已重複，保留最前列語意，不自動清理資料。

`getExistingAllocation` 沒有取得 ScriptLock；它也使用同一個縮小後的查詢。讀到 processing 或尚未找到列均為 found:false，不能判為抽獎失敗。它雖不等鎖，仍消耗 Sheets 呼叫與 Web App 執行資源。

Demo、Production 及庫存管理寫入使用同一個 ScriptLock。故跨模式會互相競爭，但目前沒有混合流量/實際 lockWaitMs 證據，無法量化額外影響。本次不拆鎖，保留既有管理寫入互斥。

GET→POST 的 Demo public status 不讀 Settings；其成本主要是另一趟 Web App/HTTP 啟動。保留首次環境/版本檢查以維持 Flow 前後比較。未知結果的手動重試會先 GET 原 ID，找到結果就不再 POST。表頭仍逐次驗證，沒有改為可能過期的 schema 快取。

## 3. 可實際取得的計時

Script Property `GARMIN_RUN_DEMO_DIAGNOSTICS=true`，且 mode=apps-script-demo、requestId 符合 `load-*` 合成 ID 白名單時才啟用。一般跑者與 Production 不回傳診斷。

- 新 POST 的 JSON 多一個可選 `diagnostics`，不寫入 Requests 的 resultJson。
- 包含版本 2、requestId、attemptId、measuredAt、lockWaitMs、lockHeldMs、totalMs、requestLookupMs、sheetReadMs、sheetWriteMs，以及原有 validation/schema/prize/settings 分段。
- `lockHeldMs` 包含 releaseLock 呼叫；`totalMs` 是 doPost 入口至釋放鎖及 catch 完成的時間，不含後面的 console、CacheService、HTTP 序列化、Google redirect 與網路傳輸；不是使用者等待時間。
- sheetReadMs 是 lookup/schema/prize/settings 包裹段落加總，含其中的處理與 Sheets 呼叫；sheetWriteMs 含六次寫入、兩次 flush 與其中 getLastRow/少量處理。另保留 sheetFlushMs，已包含在 sheetWriteMs，不能再加一次。它們是應用段落時間，不能當成精確 Google RPC/CPU 分析器。
- 逾時後使用同一 Demo URL，GET `action=getDemoRequestTiming&requestId=原ID&sessionId=原ID`。每次啟用診斷的有效 POST 最多一次 Cache put，TTL 600 秒；快取鍵使用兩 ID 的 SHA-256，內容不含 session、答案、個資或兌獎碼。無新增 Sheets 計時表/逐段日誌。
- 這是原兩 ID 綁定的最佳努力查詢，路由不是帳號驗證。知道兩 ID 者可查該診斷；勿公開原始測試 ID 清單。Production/關閉開關均拒絕查詢。快取可能提早被清除，缺項應標「未量測」。
- 相同 ID 重試會有不同 attemptId，快取只保留最近完成的一次；回歸不自動重送 POST，以免混淆原次與重播。hard kill/執行配額拒絕可能不留下紀錄。console 仍保留單筆摘要但不再是唯一取數途徑。
- 診斷關閉/Properties 或 Cache 或 console 異常不能改變獎品分配結果；快取不能用於去重或庫存決策。少量觀測開銷仍須在報告揭露；Before 未啟用可讀診斷，不能虛構 Before Lock 數字。

Node 工具已儲存六個必要數值及可選 sheetFlushMs 到 http.csv/run.json，產生 backend.csv 及 summary.csv 的 Lock/Sheets/flush 平均。加 `--collect-timing` 時，會在當輪復原結束後，針對缺 POST 計時的已提交樣本逐筆查一次 timing GET，不在原請求計時路徑中。缺快取不升級為抽獎失敗。

## 4. 前端結果確認

新增 `js/allocationConfirmation.js`，`appV2.js` 使用它：

1. 提交前保留原 sessionId/requestId/payload，並把 Demo 標記與明確的 mock/demo/production environment 存於本機 pending 中，**不放入 POST body**；避免 Mock 與 Demo 都標 true 時誤重送。
2. 網路/逾時或不確定伺服器錯誤先顯示「正在確認抽獎結果」，最多三次 GET；等待 1.5、3.5、7 秒，各加 ±20% 隨機退避；每次 GET 仍最多 15 秒。因此確認階段最壞可能再等約 59.4 秒，不代表原請求已準時成功。
3. 只有環境、requestId、sessionId、participantId 與完成狀態都正確才清 pending/顯示結果（Mock 舊契約可缺 sessionId）。
4. 未確認顯示待確認訊息，保留 payload，手動重試先 GET，仍需 POST 時沿用完全相同資料；不自動重送 POST。pending 存在時不允許開始另一測驗來換 ID。
5. 重新整理後查詢原 ID；重載只有一次 GET，不無限輪詢；原資料仍留於 sessionStorage。已知 environment 不同則阻止查詢/重送；舊版 pending 缺環境標記可用原 ID 查結果、命中可完成，但未命中不推定來源、不 POST，明確提示返回原入口或找工作人員。沿用 payload/ID，不能為解除 pending 而重新抽獎。

確認失敗不等同沒扣庫存。不要清除瀏覽器資料/關閉分頁後用新 ID 重抽。跨裝置、手動清除 sessionStorage 不在這個最小改動的持久化保證內。

## 5. Apps Script 手動更新步驟

1. 在 Apps Script 保留目前部署版本供回退，確認本機五個 gs 檔與遠端相符。**此代理未讀取遠端編輯器；無法證明本機與遠端完全相同。**
2. 請比對並同步現行 `Code.gs`、`Inventory.gs`、`Allocation.gs`、`Setup.gs`，並確認 `Validation.gs` 一致；相依的終態 flush、schema 回傳值與設定合併讀取必須一起保留。這些本機後端改善已存在，本次未覆寫，不可只貼舊 stash 版本或單一入口函式。
3. 確認 Script Property `GARMIN_RUN_DEMO_DIAGNOSTICS=true`；不需要新增表、清資料、執行 setup/migrate/reset/admin restock 函式。
4. 由你手動建立 Web App 新版本、更新既有部署，保留相同 exec URL 與存取權；本次不替你部署。
5. 前端修改包含 appV2/sessionRecovery/新確認模組；由你選擇何時發布網站。Node Flow 回歸模擬 GET→POST 並沿用原復原工具，**不等同已在正式瀏覽器驗收新確認 UI**。
6. 你確認部署版本及非尖峰後，再做 Demo read-only status 預檢、單筆 POST 與分段計時能力驗證。若仍讀不到診斷先保留「未量測」，不要假定 LOCK 是主因。

本機 apps-script 與 test-results 已被 gitignore 排除，不要為交接將私有後端或 CSV/兌獎碼加入公開 GitHub。

## 6. 待授權部署後的測試計畫（現在不執行）

沿用 `tests/demo-performance-test.mjs` 與 `demo-traffic.mjs`，seed **20261127**、start-round=1，保留 schedule.csv 實際到達偏差與 per-second.csv；不改原始到達分布/POST30s/GET15s，不混入 clustered20。最多排定 20 人，不執行 30/40/50 人。

| 階段順序 | scenario / workflow | 輪數 | 正常新提交數 |
|---|---|---:|---:|
| A | post-single / post | 10 | 10 |
| B | flow-single / flow | 10 | 10 |
| C | uniform10-10 / flow | 3 | 30 |
| D | uniform20-20 / flow | 3 | 60 |
| E | uniform20-10 / flow | 至少 3 | 60 |

正常計畫合計 **170 筆 POST**，另有 status/health/recovery/diagnostics GET。冪等重播功能驗證另列為驗證請求，不充當新跑者樣本；不任意刪除舊資料/重置庫存。

目前工具預設只印計畫，不加 --execute 不送請求。例如離線檢視：

```sh
node tests/demo-performance-test.mjs --scenario=uniform20-10 --workflow=flow --seed=20261127 --collect-timing
```

執行時仍需部署與非尖峰旗標、前階段驗收旗標。舊 continue-jitter/http-only/retain-unknown 是前次測試授權，不自動繼承至新版本；此次預設嚴格停止。若想在部分 timeout 下完整完成三輪，部署後先確認一份「當輪完成、停止升載」的具體方案，再決定是否使用工具的既有 continuation 旗標。

配額/契約不符/重複 participant/庫存異常立即停止未送出排程；已送出請求保留原 ID 做有限確認。未取得資料一致性證據或大量 UNKNOWN/timeout 時停止增加負載，盤點當輪，不能為湊滿 60 筆忽略異常。使用者可決定問題盤點後是否同密度續測；不自動提高負載或 timeout。

每階段留下去敏的 Demo 五表前後快照，用既有 auditSnapshots 核對 request/session/participant/allocation/log 連結、每個 ID 單次扣除與五獎庫存差；只有 DemoRequests CSV 不足以證明庫存一致性。不要求提供姓名、Email、完整 resultJson 或兌獎碼。

Before/After 報告需列原成功率、最終確認率、P50/P95、timeout、UNKNOWN、計時樣本數與缺失數、Lock Wait/Held、每秒到達/完成數。summary.csv 已另列 originalSuccessRate、finalConfirmationRate、unknownCount。恢復後時間另列，不把延長確認等待當成原請求加速。

## 7. 預期效果與尚未驗證風險

- 縮小 Requests 讀取可減少歷史資料傳輸；收益待測，不預估省幾秒。
- 鎖外序列化理論上減少 Lock Held，但回應小，可能不是主要改善。
- 前端有限退避能降低密集輪詢並釐清未知結果，**不能直接提高原請求準時成功率**。
- 共享鎖仍會排隊；Apps Script 啟動/並行額度、Sheets RPC、寫入同步、GET 額外往返均可能是剩餘瓶頸。需以 total-vs-HTTP、wait-vs-held、lookup/read/write 分段判斷，再決定下一個最小改動。
- 六次跨表寫入仍非原子交易：processing 屏障後中斷會保留待盤點狀態而不再扣第二次；paused 亦需完成依賴列後才公布終態，沒有自動回滾。離線覆蓋依賴 flush 失敗的保護，未宣稱完整交易保證。
- 保留較新的兩次 flush，不以移除 flush 換取數字；真實 Sheets 寫入可見性與同時重播須由部署後回歸及五表核對確認，VM 測試不能證明 Google 服務效能與實際執行隔離。

## 8. 本機驗證

本次已重新驗證後端 VM、原 ID 重播、Demo/Production 隔離、診斷/快取降級、無整表 JSON 讀取、無鎖 recovery、前端提交整合。後端測試 15/15、前端提交整合 5/5，含舊版無環境 pending 與 Mock→Demo 防誤送。報告測試另涵蓋復原不回填原成功率及拒絕跨情境/seed 比較。完整相關離線檔案檢查結果見交付回報，不把歷史通過數當成本次實測。

尚未做 Web App 新版本 HTTP 壓測、真實五表前後核對、正式瀏覽器 UI 驗收；故 After 與 ≥85% 驗收保持待驗證。沒有 commit、push、部署或修改 Google 資料。

參考官方 API：[TextFinder](https://developers.google.com/apps-script/reference/spreadsheet/text-finder)、[Lock](https://developers.google.com/apps-script/reference/lock/lock)。
