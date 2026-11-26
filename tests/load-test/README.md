# Google Apps Script Demo API 並行測試工具

此工具只接受包含 `mode=apps-script-demo` 的 HTTPS URL。預設為 dry-run，不會呼叫 API；正式執行時會先列出目標、URL、Demo 識別方式與請求數，要求輸入 `RUN-DEMO`，再進行唯讀 Demo status preflight。

## 使用方式

```bash
node tests/load-test/load-test.mjs
node tests/load-test/load-test.mjs --execute --confirm-demo
```

可用 `--api-url=https://.../exec?mode=apps-script-demo` 指定 URL；不可指定 Production URL。若要略過額外的 requestId 重播檢查，可加 `--skip-duplicate`，但預設會執行此檢查。

測試階段為並行數 1、2、5、10，每階段最多 10 筆。若出現 `LOCK_BUSY`、逾時、配額/服務錯誤或非 Demo 回應，會停止後續階段。請求採用 `redirect: "follow"`，並記錄 redirect 與最終 URL。

每次正式執行會在 `reports/` 產生 Markdown 報告，包含每筆耗時、結果、錯誤代碼、獎品、requestId，以及成功率、平均值、P95、最長耗時和 req/s。工具不清空、不重設、不調整既有 Demo 資料。

Apps Script 目前未提供庫存查詢 API，因此報告中的庫存檢查是 API 回應層級的預期扣減與去重檢查；完整 Sheets 一致性仍需在 Google Sheet 執行既有 `verifyInventoryConsistency()`，並人工確認 Production 工作表未變動。
