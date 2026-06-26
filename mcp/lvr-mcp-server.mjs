#!/usr/bin/env node
// 內政部實價登錄佐證工具 — MCP server（v1，MCP-safe / fire-and-return）
//
// 設計重點：
//   1. STDIO server 不可把任何訊息寫到 stdout（會破壞 JSON-RPC）；本檔自身一律不 console.log，
//      子程序（official_lvr_evidence.js）的輸出則導向各 run 資料夾內的 _執行log.txt，不經過本程序 stdout。
//   2. 強制 headless、不保留視窗（LVR_HEADLESS_FORCE=1），避免 tool call 等人工關窗而卡死。
//   3. fire-and-return：run_official_capture 立刻回傳 runId 後即返回，不同步等查詢跑完；
//      「狀態」就是 output/evidence/<runId>/ 這個資料夾本身，由 read_evidence_summary 判讀，不另設 job queue。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { readFile, readdir, stat, mkdir } from "node:fs/promises";
import { openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCRIPT = path.join(ROOT, "scripts", "official_lvr_evidence.js");
const EVIDENCE_ROOT = path.join(ROOT, "output", "evidence");

function pad(n) {
  return String(n).padStart(2, "0");
}

// 與 official_lvr_evidence.js 一致的 runId 慣例（注入後子程序會原樣採用，故此處僅需可讀且唯一）。
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeName(name) {
  return String(name || "未命名案件")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function textResult(text, isError = false) {
  return { isError, content: [{ type: "text", text }] };
}

const server = new McpServer({ name: "taiwan-lvr-evidence", version: "0.1.0" });

server.registerTool(
  "run_official_capture",
  {
    title: "官方實價查詢截圖（背景）",
    description:
      "依案件設定檔開啟內政部實價登錄官網查詢，輸出官方頁面截圖、CSV/JSON 與最接近比較標的（含框紅截圖與 SHA-256）。" +
      "以 headless、非互動方式執行；立即回傳 runId 後即返回，不等查詢跑完。" +
      "查詢需數十秒至數分鐘，請改用 read_evidence_summary 帶入 runId 查進度與結果。",
    inputSchema: {
      configFile: z
        .string()
        .default("案件設定.json")
        .describe("案件設定 JSON 檔名或路徑（相對於專案根目錄），慣例為 案件設定*.json")
    }
  },
  async ({ configFile }) => {
    const configPath = path.resolve(ROOT, configFile);
    let caseName = "";
    try {
      const cfg = JSON.parse(await readFile(configPath, "utf8"));
      caseName = cfg["案件名稱"] || "";
    } catch (err) {
      return textResult(`讀取設定檔失敗：${configPath}\n${err.message}`, true);
    }

    const runId = `${timestamp()}_${safeName(caseName)}`;
    const outDir = path.join(EVIDENCE_ROOT, runId);
    await mkdir(outDir, { recursive: true });

    // 子程序的 stdout/stderr 全導向 run 資料夾內的 log（絕不流向本 server 的 stdout）。
    const logFd = openSync(path.join(outDir, "_執行log.txt"), "a");
    const child = spawn(process.execPath, [SCRIPT, configFile], {
      cwd: ROOT,
      env: { ...process.env, LVR_RUN_ID: runId, LVR_HEADLESS_FORCE: "1" },
      stdio: ["ignore", logFd, logFd],
      detached: true,
      windowsHide: true
    });
    child.on("error", () => {}); // 啟動失敗會反映在 log／後續查詢狀態，不讓本 server 崩潰
    child.unref();

    return textResult(
      [
        "已於背景啟動官方查詢截圖流程（headless、不保留視窗）。",
        `runId：${runId}`,
        `設定檔：${configFile}（案件：${caseName || "未命名"}）`,
        `輸出資料夾：${outDir}`,
        "",
        "查詢約需數十秒至數分鐘。請用 read_evidence_summary 帶入上面的 runId 查進度與結果；",
        "完成後該資料夾會出現「操作紀錄.txt」（含 SHA-256 與最接近比較標的）。"
      ].join("\n")
    );
  }
);

server.registerTool(
  "list_evidence_runs",
  {
    title: "列出證據輸出資料夾",
    description: "列出 output/evidence 內歷次官方查詢證據資料夾（依時間新到舊），並標示完成／執行中／查詢未成功。",
    inputSchema: {}
  },
  async () => {
    const names = await readdir(EVIDENCE_ROOT).catch(() => []);
    const rows = [];
    for (const name of names) {
      const full = path.join(EVIDENCE_ROOT, name);
      const s = await stat(full).catch(() => null);
      if (!s?.isDirectory()) continue;
      const done = await stat(path.join(full, "操作紀錄.txt")).then(() => true).catch(() => false);
      const failed = await stat(path.join(full, "搜尋後未出結果畫面.png")).then(() => true).catch(() => false);
      rows.push({
        runId: name,
        modified: s.mtime.toISOString(),
        status: done ? "完成" : failed ? "查詢未成功" : "執行中"
      });
    }
    rows.sort((a, b) => b.modified.localeCompare(a.modified));
    return textResult(rows.length ? JSON.stringify(rows, null, 2) : "尚無任何輸出（output/evidence 為空）。");
  }
);

server.registerTool(
  "read_evidence_summary",
  {
    title: "讀取某次查詢結果摘要",
    description:
      "讀取指定 runId 的結果：完成則回「操作紀錄.txt」（含 SHA-256 與最接近比較標的）；" +
      "未完成則回目前狀態與執行 log 尾段，供判斷是執行中、失敗或查無。",
    inputSchema: {
      runId: z.string().describe("run 資料夾名稱（可由 list_evidence_runs 取得，或 run_official_capture 回傳）")
    }
  },
  async ({ runId }) => {
    const dir = path.join(EVIDENCE_ROOT, runId);
    const s = await stat(dir).catch(() => null);
    if (!s?.isDirectory()) return textResult(`找不到 run：${runId}（請先用 list_evidence_runs 確認名稱）`, true);

    const files = (await readdir(dir).catch(() => [])).filter((f) => f !== "_執行log.txt");
    const record = await readFile(path.join(dir, "操作紀錄.txt"), "utf8").catch(() => null);
    if (record) {
      return textResult(
        [`runId：${runId}（完成）`, `檔案：${files.join("、")}`, "", record.replace(/^﻿/, "")].join("\n")
      );
    }

    const failed = files.includes("搜尋後未出結果畫面.png");
    const log = await readFile(path.join(dir, "_執行log.txt"), "utf8").catch(() => "");
    const tail = log.split(/\r?\n/).filter(Boolean).slice(-25).join("\n");
    return textResult(
      [
        `runId：${runId}（${failed ? "查詢未成功載入結果" : "執行中或未完成"}）`,
        `目前檔案：${files.join("、") || "（無）"}`,
        "",
        "執行 log 尾段：",
        tail || "（尚無輸出）"
      ].join("\n")
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
