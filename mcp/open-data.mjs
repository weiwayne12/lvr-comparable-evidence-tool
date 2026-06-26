// 內政部 Open Data 下載與本地快取（v2 preview_comparables 的資料來源）
//
// 資料來源：https://plvr.land.moi.gov.tw/Download?type=zip&fileName=lvr_landcsv.zip
// 該 ZIP 為整縣市整期的買賣資料（CSV / UTF-8），無反爬蟲，可自由下載。
// 預覽結果僅供「篩選與討論」，最終佐證仍以官網截圖為準。

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CACHE_DIR = path.join(ROOT, "cache", "open-data");
const META_FILE = path.join(CACHE_DIR, "_meta.json");

const OPEN_DATA_URL =
  "https://plvr.land.moi.gov.tw/Download?type=zip&fileName=lvr_landcsv.zip";

// 內政部 Open Data 的 CSV 欄位名稱（買賣 a_ 檔）。各縣市檔名為 a_lvr_land_a.csv 等。
// 第一列為中文欄位名，第二列為英文欄位名（我們用中文匹配）。
const COUNTY_CODES = {
  臺北市: "a", 新北市: "f", 桃園市: "h", 臺中市: "b", 臺南市: "d", 高雄市: "e",
  基隆市: "c", 新竹市: "o", 新竹縣: "j", 苗栗縣: "k", 彰化縣: "n",
  南投縣: "m", 雲林縣: "p", 嘉義市: "i", 嘉義縣: "q",
  屏東縣: "t", 宜蘭縣: "g", 花蓮縣: "u", 臺東縣: "v",
  澎湖縣: "x", 金門縣: "w", 連江縣: "z",
};

// 台→臺 正規化
const CITY_ALIASES = new Map([
  ["台北市", "臺北市"], ["台中市", "臺中市"], ["台南市", "臺南市"], ["台東縣", "臺東縣"],
]);
function normalizeCity(name) {
  const t = String(name || "").trim();
  return CITY_ALIASES.get(t) || t;
}

// ─── 下載與解壓 ───

async function fileSha256(filePath) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

export async function refreshOpenData() {
  await mkdir(CACHE_DIR, { recursive: true });
  const zipPath = path.join(CACHE_DIR, "lvr_landcsv.zip");

  // 用 Node 原生 fetch 下載（Node 18+）
  const res = await fetch(OPEN_DATA_URL);
  if (!res.ok) throw new Error(`下載失敗：HTTP ${res.status} ${res.statusText}`);

  const arrayBuf = await res.arrayBuffer();
  await writeFile(zipPath, Buffer.from(arrayBuf));

  const sha256 = await fileSha256(zipPath);

  // 解壓到 CACHE_DIR（使用 PowerShell Expand-Archive，Windows 內建）
  const extractDir = path.join(CACHE_DIR, "csv");
  await mkdir(extractDir, { recursive: true });
  await execFileAsync("powershell.exe", [
    "-NoProfile", "-Command",
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
  ], { timeout: 120_000 });

  const meta = {
    downloadedAt: new Date().toISOString(),
    sourceUrl: OPEN_DATA_URL,
    sha256,
    zipSizeBytes: arrayBuf.byteLength,
  };
  await writeFile(META_FILE, JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

export async function readMeta() {
  try {
    return JSON.parse(await readFile(META_FILE, "utf8"));
  } catch {
    return null;
  }
}

// ─── CSV 解析（買賣資料 a_lvr_land_a.csv） ───

function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  // 第二列可能是英文欄位名（若首格為 "the villages..." 之類），跳過
  let start = 1;
  if (lines.length > 2 && /^[a-z_]/i.test(parseCsvLine(lines[1])[0])) {
    start = 2;
  }
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    if (vals.length < headers.length) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = vals[j]?.trim() ?? "";
    }
    rows.push(row);
  }
  return rows;
}

// ─── 載入某縣市買賣 CSV ───

async function loadCountyCsv(countyCode) {
  const csvDir = path.join(CACHE_DIR, "csv");
  const fileName = `${countyCode}_lvr_land_a.csv`;
  const filePath = path.join(csvDir, fileName);
  try {
    const text = await readFile(filePath, "utf8");
    return parseCsv(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

// ─── 民國年換算 ───

function rocToAD(rocYear) {
  return Number(rocYear) + 1911;
}

function parseRocDate(dateStr) {
  // 格式：1140101 或 114/01/01
  const s = String(dateStr || "").replace(/\//g, "");
  if (s.length < 7) return null;
  const y = rocToAD(s.slice(0, -4));
  const m = Number(s.slice(-4, -2));
  const d = Number(s.slice(-2));
  return { year: y, month: m, day: d, date: new Date(y, m - 1, d) };
}

// ─── preview_comparables 篩選邏輯 ───

export async function previewComparables(opts) {
  const {
    縣市,
    行政區,
    門牌關鍵字,
    交易期間,
    交易標的,
    排除房地車 = false,
    建物型態 = [],
    maxResults = 100,
  } = opts;

  const city = normalizeCity(縣市);
  const code = COUNTY_CODES[city];
  if (!code) {
    return { error: `不支援的縣市「${縣市}」，支援清單：${Object.keys(COUNTY_CODES).join("、")}` };
  }

  const meta = await readMeta();
  if (!meta) {
    return { error: "尚未下載 Open Data，請先呼叫 refresh_lvr_open_data。" };
  }

  const rows = await loadCountyCsv(code);
  if (!rows) {
    return { error: `找不到縣市「${city}」的 CSV（檔名 ${code}_lvr_land_a.csv），請確認快取是否完整。` };
  }

  // 計算資料涵蓋期間
  let earliestDate = null;
  let latestDate = null;
  for (const r of rows) {
    const d = parseRocDate(r["交易年月日"]);
    if (!d || isNaN(d.date.getTime())) continue;
    if (!earliestDate || d.date < earliestDate) earliestDate = d.date;
    if (!latestDate || d.date > latestDate) latestDate = d.date;
  }
  function formatRocYM(date) {
    if (!date) return null;
    const rocY = date.getFullYear() - 1911;
    const m = date.getMonth() + 1;
    return `${rocY}年${String(m).padStart(2, "0")}月`;
  }
  function formatISO(date) {
    if (!date || isNaN(date.getTime())) return null;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const dataCoverage = {
    earliestTradeDate: earliestDate
      ? { 民國: formatRocYM(earliestDate), 西元: formatISO(earliestDate) }
      : null,
    latestTradeDate: latestDate
      ? { 民國: formatRocYM(latestDate), 西元: formatISO(latestDate) }
      : null,
    note: "此為目前 Open Data 快取所含資料期間；若案件起訴時點不在此期間，預覽可能查無或不完整。",
  };

  // 篩選
  let filtered = rows;

  // 行政區
  if (行政區) {
    const dist = 行政區.trim();
    filtered = filtered.filter((r) => {
      const district = r["鄉鎮市區"] || "";
      const addr = r["土地位置建物門牌"] || "";
      return district.includes(dist) || addr.includes(dist);
    });
  }

  // 門牌關鍵字
  if (門牌關鍵字) {
    const kw = 門牌關鍵字.trim();
    filtered = filtered.filter((r) => {
      const addr = r["土地位置建物門牌"] || "";
      return addr.includes(kw);
    });
  }

  // 交易期間（民國年月）
  if (交易期間) {
    const { 起年, 起月 = 1, 迄年, 迄月 = 12 } = 交易期間;
    if (起年 && 迄年) {
      const startAD = rocToAD(起年);
      const endAD = rocToAD(迄年);
      const startDate = new Date(startAD, (起月 || 1) - 1, 1);
      const endDate = new Date(endAD, (迄月 || 12), 0); // 月底
      filtered = filtered.filter((r) => {
        const d = parseRocDate(r["交易年月日"]);
        if (!d) return false;
        return d.date >= startDate && d.date <= endDate;
      });
    }
  }

  // 交易標的
  if (交易標的 && 交易標的.length > 0) {
    filtered = filtered.filter((r) => {
      const t = r["交易標的"] || "";
      return 交易標的.some((target) => t.includes(target));
    });
  }

  // 排除房地車
  if (排除房地車) {
    filtered = filtered.filter((r) => {
      const t = r["交易標的"] || "";
      return !t.includes("車");
    });
  }

  // 建物型態
  if (建物型態 && 建物型態.length > 0) {
    filtered = filtered.filter((r) => {
      const bt = r["建物型態"] || "";
      return 建物型態.some((type) => bt.includes(type));
    });
  }

  // 整理輸出
  const total = filtered.length;
  const preview = filtered.slice(0, maxResults).map((r) => {
    const unitPrice = parseFloat(String(r["單價元平方公尺"] || "0").replace(/,/g, ""));
    const unitPricePing = unitPrice > 0 ? +((unitPrice * 3.305785) / 10000).toFixed(2) : null;
    const totalPrice = parseFloat(String(r["總價元"] || "0").replace(/,/g, ""));
    const totalPriceWan = totalPrice > 0 ? Math.round(totalPrice / 10000) : null;
    const area = parseFloat(String(r["建物移轉總面積平方公尺"] || "0").replace(/,/g, ""));
    const areaPing = area > 0 ? +(area * 0.3025).toFixed(2) : null;
    const mainArea = parseFloat(String(r["主建物面積"] || "0").replace(/,/g, ""));
    const mainAreaPing = mainArea > 0 ? +(mainArea * 0.3025).toFixed(2) : null;

    return {
      門牌: r["土地位置建物門牌"] || "",
      交易日期: r["交易年月日"] || "",
      總價萬元: totalPriceWan,
      單價萬元坪: unitPricePing,
      總面積坪: areaPing,
      主建物面積坪: mainAreaPing,
      建物型態: r["建物型態"] || "",
      交易標的: r["交易標的"] || "",
      樓別樓高: r["移轉層次"] ? `${r["移轉層次"]}/${r["總樓層數"]}` : "",
      屋齡: r["屋齡"] || "",
      主要用途: r["主要用途"] || "",
      建物格局: [r["建物現況格局-房"] && `${r["建物現況格局-房"]}房`,
                 r["建物現況格局-廳"] && `${r["建物現況格局-廳"]}廳`,
                 r["建物現況格局-衛"] && `${r["建物現況格局-衛"]}衛`].filter(Boolean).join("") || "",
      車位總價萬元: r["車位總價元"] ? Math.round(parseFloat(String(r["車位總價元"]).replace(/,/g, "")) / 10000) || null : null,
      備註: r["備註"] || "",
    };
  });

  // 門牌彙總（同棟出現頻率）：去除樓層部分以合併同棟
  const addrCount = {};
  for (const r of filtered) {
    const addr = (r["土地位置建物門牌"] || "")
      .replace(/[一二三四五六七八九十百]+樓.*$/, "")
      .replace(/\d+樓.*$/, "")
      .trim();
    addrCount[addr] = (addrCount[addr] || 0) + 1;
  }
  const topAddresses = Object.entries(addrCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([addr, count]) => ({ 門牌: addr, 筆數: count }));

  // 檢查查詢期間與資料涵蓋期間是否有交集
  const warnings = [];
  if (交易期間 && earliestDate && latestDate) {
    const { 起年, 起月 = 1, 迄年, 迄月 = 12 } = 交易期間;
    if (起年 && 迄年) {
      const qStart = new Date(rocToAD(起年), (起月 || 1) - 1, 1);
      const qEnd = new Date(rocToAD(迄年), (迄月 || 12), 0);
      if (qEnd < earliestDate || qStart > latestDate) {
        warnings.push(
          "查詢期間與目前 Open Data 快取涵蓋期間無交集，查無資料不代表官網或歷史資料一定沒有交易。",
          "可能只是目前快取期別不涵蓋該期間。",
          "最終仍須以官網查詢截圖或相對應歷史 Open Data 為準。"
        );
      }
    }
  }

  const result = {
    disclaimer: "此為內政部 Open Data 預覽結果，僅供篩選與討論，最終仍須以官網截圖佐證。",
    cacheInfo: {
      downloadedAt: meta.downloadedAt,
      sha256: meta.sha256,
    },
    dataCoverage,
    query: { 縣市: city, 行政區, 門牌關鍵字, 交易期間, 交易標的, 排除房地車, 建物型態 },
    totalMatches: total,
    showing: Math.min(total, maxResults),
    topAddresses,
    results: preview,
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}
