# MCP server：taiwan-lvr-evidence（v1 + v2）

把現有的官方實價查詢截圖流程（`scripts/official_lvr_evidence.js`）與
內政部 Open Data 預覽功能包成 MCP 工具，
讓 AI 可以直接觸發查詢截圖、預覽篩選比較標的、列出歷次輸出、讀取結果摘要。

## 設計重點

- **不污染 stdout**：STDIO server 自身不 `console.log`；子程序輸出全導向各 run 資料夾的 `_執行log.txt`。
- **強制 headless、不保留視窗**：以 `LVR_HEADLESS_FORCE=1` 覆蓋設定檔的 `完成後保留視窗`／`顯示瀏覽器`，
  避免 tool call 等人工關窗而卡死。
- **fire-and-return**：`run_official_capture` 注入 `LVR_RUN_ID` 後在背景啟動子程序，**立刻回傳 runId**，
  不同步等查詢跑完。「狀態」就是 `output/evidence/<runId>/` 資料夾本身，由 `read_evidence_summary` 判讀，
  不另設 job queue。
- **preview 不打官網**：`preview_comparables` 僅讀本地快取的內政部 Open Data CSV，
  不連官方查詢網站，避免觸發反爬蟲或節流。

## 工具

### v1 — 官網截圖流程

| 工具 | 用途 |
| --- | --- |
| `run_official_capture(configFile)` | 依案件設定檔（預設 `案件設定.json`）背景執行官網查詢截圖，回傳 runId |
| `list_evidence_runs()` | 列出 `output/evidence` 歷次輸出，標示 完成／執行中／查詢未成功 |
| `read_evidence_summary(runId)` | 完成→回 `操作紀錄.txt`（含 SHA-256、最接近比較標的）；未完成→回狀態與 log 尾段 |

### v2 — Open Data 預覽

| 工具 | 用途 |
| --- | --- |
| `refresh_lvr_open_data()` | 從內政部 Open Data 下載最新整批買賣 CSV ZIP，解壓至 `cache/open-data/`，記錄 SHA-256 |
| `preview_comparables(...)` | 從本機快取 CSV 篩選比較標的（不打官網），回傳筆數、前幾筆、門牌彙總 |

## 典型流程（v2）

1. 呼叫 `refresh_lvr_open_data` 下載或更新 Open Data 快取。
2. 呼叫 `preview_comparables` 帶入縣市、行政區、門牌關鍵字等條件，預覽篩選。
3. AI 與使用者討論條件、調整篩選。
4. 條件定稿後，（AI 或人工備好）`案件設定_xxx.json`。
5. 呼叫 `run_official_capture` 正式進官網截圖**（只打一次）**。
6. 用 `read_evidence_summary` 查結果。

> ⚠️ 預覽結果與官網查詢不會逐筆完全相同（資料更新時點不同），預覽僅供「篩選與討論」，最終佐證以官網截圖為準。

## preview_comparables 參數

| 參數 | 必填 | 說明 |
| --- | --- | --- |
| `縣市` | 是 | 縣市名稱（台→臺自動轉換） |
| `行政區` | 否 | 行政區 |
| `門牌關鍵字` | 否 | 門牌地址關鍵字（勿用社區名） |
| `交易期間` | 否 | `{ 起年, 起月?, 迄年, 迄月? }`（民國年月） |
| `交易標的` | 否 | 例如 `["房地(含車位)", "房地"]` |
| `排除房地車` | 否 | 預設 false |
| `建物型態` | 否 | 例如 `["住宅大樓", "華廈"]` |
| `maxResults` | 否 | 最多回傳幾筆（預設 100） |

## 連接設定

### Claude Code
專案根目錄已附 `.mcp.json`（絕對路徑）。首次啟用時 Claude Code 會提示核准此 MCP server。
> 註：`.mcp.json` 內為本機絕對路徑，換機器需自行調整；若不想提交可加入 `.gitignore`。

### 其他 MCP client（通用）
```json
{
  "mcpServers": {
    "taiwan-lvr-evidence": {
      "command": "node",
      "args": ["C:\\Users\\user\\Documents\\實價登錄核定訴訟標的價額工具\\mcp\\lvr-mcp-server.mjs"]
    }
  }
}
```

也可用 `npm run mcp` 直接以 STDIO 啟動 server（供除錯）。

## 已知限制

- `run_official_capture` 仍會實際打官網一次；官網對短時間重複查詢會節流，請勿連續猛打。
- `list/read` 目前僅看 `output/evidence`（預設輸出夾）；若設定檔自訂了 `輸出資料夾`，需另行對應。
- Open Data 為整縣市整期的整批資料，更新頻率約每季一次，與官網即時查詢結果可能有時間差。
- Open Data CSV 的欄位名稱、格式偶有異動，若解析失敗需檢查欄位是否變更。
