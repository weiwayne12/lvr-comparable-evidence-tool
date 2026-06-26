# MCP server（v1）：taiwan-lvr-evidence

把現有的官方實價查詢截圖流程（`scripts/official_lvr_evidence.js`）包成 MCP 工具，
讓 AI 可以直接觸發查詢截圖、列出歷次輸出、讀取結果摘要。

> 本版定位為 **MCP-safe v1**：只負責「條件定稿後、實際進官網正式截圖」這一段。
> 「AI 先用 Open Data 預覽／篩選」(`preview_comparables`) 屬 v2，尚未實作。

## 設計重點

- **不污染 stdout**：STDIO server 自身不 `console.log`；子程序輸出全導向各 run 資料夾的 `_執行log.txt`。
- **強制 headless、不保留視窗**：以 `LVR_HEADLESS_FORCE=1` 覆蓋設定檔的 `完成後保留視窗`／`顯示瀏覽器`，
  避免 tool call 等人工關窗而卡死。
- **fire-and-return**：`run_official_capture` 注入 `LVR_RUN_ID` 後在背景啟動子程序，**立刻回傳 runId**，
  不同步等查詢跑完。「狀態」就是 `output/evidence/<runId>/` 資料夾本身，由 `read_evidence_summary` 判讀，
  不另設 job queue。

## 工具

| 工具 | 用途 |
| --- | --- |
| `run_official_capture(configFile)` | 依案件設定檔（預設 `案件設定.json`）背景執行官網查詢截圖，回傳 runId |
| `list_evidence_runs()` | 列出 `output/evidence` 歷次輸出，標示 完成／執行中／查詢未成功 |
| `read_evidence_summary(runId)` | 完成→回 `操作紀錄.txt`（含 SHA-256、最接近比較標的）；未完成→回狀態與 log 尾段 |

## 典型流程

1. （AI 直接寫，或人工備好）`案件設定_xxx.json`。
2. 呼叫 `run_official_capture` 帶該設定檔 → 取得 runId。
3. 隔一會兒呼叫 `read_evidence_summary` 帶 runId 查進度；出現「完成」即可看摘要與截圖檔。

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

## 已知限制（v1）

- `run_official_capture` 仍會實際打官網一次；官網對短時間重複查詢會節流，請勿連續猛打。
- `list/read` 目前僅看 `output/evidence`（預設輸出夾）；若設定檔自訂了 `輸出資料夾`，需另行對應。
- 尚無 `preview_comparables`：AI 的篩選目前只能在 `run` 之後對產出的 CSV/最接近比較標的進行。
