@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================================
echo   內政部實價查詢：官方網頁截圖與表格擷取工具
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 Node.js，請先安裝 Node.js 後再執行。
  echo 下載頁：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\playwright" (
  echo 第一次執行：安裝 Playwright，需要網路，請稍候...
  call npm install
  if errorlevel 1 (
    echo npm install 失敗，請確認網路或 Node.js/npm 是否正常。
    pause
    exit /b 1
  )
  call npx.cmd playwright install chromium
)

node "scripts\official_lvr_evidence.js" "案件設定.json"

echo.
echo ============================================================
echo   已結束。請按任意鍵關閉視窗。
echo ============================================================
pause >nul
