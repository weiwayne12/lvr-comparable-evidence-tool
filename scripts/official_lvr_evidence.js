const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const configPath = path.resolve(ROOT, process.argv[2] || "案件設定.json");

const CITY_ALIASES = new Map([
  ["台北市", "臺北市"],
  ["台中市", "臺中市"],
  ["台南市", "臺南市"],
  ["台東縣", "臺東縣"]
]);

// 首頁「交易標的」實際 DOM：name=ptype。房地為單一選項 value="1,2"（含純房地與房地車），
// 首頁無法在查詢階段把「房地(車)」分出來，故「排除房地車」改於擷取後依結果表車位數濾除。
const PTYPE_CHECKBOXES = {
  "房地": "#customCheck1", // value 1,2
  "土地": "#customCheck2", // value 3
  "建物": "#customCheck3", // value 4
  "車位": "#customCheck4"  // value 5
};

// 進階條件內的建物型態：name=f_type
const BUILDING_TYPE_VALUES = {
  "公寓": "01",
  "公寓(無電梯)": "01",
  "透天厝": "02",
  "店面": "03",
  "店面(店鋪)": "03",
  "商辦大樓": "04",
  "辦公大樓": "04",
  "住宅大樓": "05",
  "華廈": "06",
  "套房": "07",
  "工廠": "08",
  "廠辦": "09",
  "農舍": "10",
  "倉庫": "11",
  "其他": "12"
};

// 進階條件內的屋齡：name=avg_var（單選）
const AGE_SELECTORS = {
  "不拘": "#avg_var_0",
  "0-5": "#avg_var_1",
  "5-10": "#avg_var_2",
  "10-20": "#avg_var_3",
  "20-30": "#avg_var_4",
  "30-40": "#avg_var_5",
  "40以上": "#avg_var_6"
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeCity(name) {
  const trimmed = String(name || "").trim();
  return CITY_ALIASES.get(trimmed) || trimmed;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function timestamp() {
  const d = new Date();
  return [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join("") +
    "_" + [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join("");
}

function safeName(name) {
  return String(name || "未命名案件")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeCsv(filePath, rows) {
  if (!rows.length) {
    fs.writeFileSync(filePath, "﻿", "utf8");
    return;
  }
  const headers = Object.keys(rows[0]).filter((h) => !h.startsWith("_"));
  const escape = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    headers.map(escape).join(","),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(","))
  ];
  fs.writeFileSync(filePath, "﻿" + lines.join("\r\n"), "utf8");
}

async function getMainFrame(page) {
  await page.waitForTimeout(1200);
  let frame = page.frames().find((f) => /\/jsp\/index\.jsp/i.test(f.url()));
  if (!frame) {
    const frameElement = await page.locator("frame").first().elementHandle().catch(() => null);
    if (frameElement) frame = await frameElement.contentFrame();
  }
  if (!frame) throw new Error("找不到官方查詢頁面的主 frame。");
  return frame;
}

async function setSelectIfExists(frame, selector, value) {
  const locator = frame.locator(selector);
  if (!(await locator.count())) return false;
  await locator.first().selectOption(String(value)).catch(async () => {
    await locator.first().evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, String(value));
  });
  return true;
}

async function setCheckbox(frame, selector, checked) {
  const locator = frame.locator(selector);
  if (!(await locator.count())) return false;
  const current = await locator.first().isChecked().catch(() => false);
  if (current !== checked) {
    await locator.first().click({ force: true }).catch(async () => {
      await locator.first().evaluate((el, nextChecked) => {
        el.checked = nextChecked;
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        el.checked = nextChecked;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, checked);
    });
  }
  return true;
}

async function selectByLabel(frame, selector, label) {
  const locator = frame.locator(selector);
  if (!(await locator.count())) return false;
  await locator.first().selectOption({ label }).catch(async () => {
    await locator.first().evaluate((el, text) => {
      const option = [...el.options].find((o) => o.text.trim() === text);
      if (!option) throw new Error(`找不到選項：${text}`);
      el.value = option.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, label);
  });
  return true;
}

async function chooseCityAndTown(frame, cfg) {
  const city = normalizeCity(cfg["縣市"]);
  const town = String(cfg["行政區"] || "").trim();
  if (city) await selectByLabel(frame, "#p_city", city);

  // 行政區選項是選縣市後才動態載入
  if (town) {
    await frame.waitForFunction(() => {
      const el = document.querySelector("#p_town");
      return el && el.options.length > 1;
    }, null, { timeout: 8000 }).catch(() => {});
    await selectByLabel(frame, "#p_town", town);
  }
}

async function fillKeyword(frame, cfg) {
  const kw = String(cfg["門牌社區關鍵字"] || "").trim();
  if (!kw) return;
  const locator = frame.locator("#p_build");
  if (!(await locator.count())) return;
  await locator.first().fill(kw).catch(async () => {
    await locator.first().evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, kw);
  });
}

async function setDateRange(frame, cfg) {
  const range = cfg["交易期間"] || {};
  const pairs = [
    ["#p_startY", range["起年"]],
    ["#p_startM", range["起月"]],
    ["#p_endY", range["迄年"]],
    ["#p_endM", range["迄月"]]
  ];
  for (const [selector, value] of pairs) {
    if (value != null) await setSelectIfExists(frame, selector, value);
  }
}

async function setTransactionTargets(frame, cfg) {
  // 「房地(車)」於首頁併入「房地」，無法分離；排除動作改在擷取後處理。
  const desired = new Set(cfg["交易標的"] || ["房地"]);
  for (const [label, selector] of Object.entries(PTYPE_CHECKBOXES)) {
    await setCheckbox(frame, selector, desired.has(label));
  }
}

async function openAdvancedIfNeeded(frame, cfg) {
  const needBuilding = (cfg["建物型態"] || []).length > 0;
  const needAge = cfg["屋齡"] && String(cfg["屋齡"]).replace(/\s/g, "") !== "不拘";
  if (!needBuilding && !needAge) return;
  const btn = frame.locator("#QryFilter");
  if (await btn.count()) {
    await btn.first().click({ force: true }).catch(() => {});
    await frame.waitForTimeout(800);
  }
}

async function setBuildingTypes(frame, cfg) {
  const wanted = cfg["建物型態"] || [];
  const wantedValues = new Set(wanted.map((name) => BUILDING_TYPE_VALUES[name]).filter(Boolean));
  if (!wantedValues.size) return;

  const checks = await frame.locator("input[name='f_type']").elementHandles();
  for (const handle of checks) {
    const value = await handle.getAttribute("value");
    const checked = await handle.evaluate((el) => el.checked);
    const shouldCheck = wantedValues.has(value);
    if (checked !== shouldCheck) {
      await handle.evaluate((el, nextChecked) => {
        el.checked = nextChecked;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, shouldCheck);
    }
  }
}

async function setAge(frame, cfg) {
  const age = String(cfg["屋齡"] || "不拘").replace(/\s/g, "");
  if (age === "不拘") return;
  const selector = AGE_SELECTORS[age];
  if (selector) await setCheckbox(frame, selector, true);
}

async function setUnits(frame, cfg) {
  if (cfg["單價單位"] === "元") await setCheckbox(frame, "#tmoney_unit_2", true);
  else await setCheckbox(frame, "#tmoney_unit_1", true);

  if (cfg["面積單位"] === "M2" || cfg["面積單位"] === "㎡") await setCheckbox(frame, "#unit_1", true);
  else await setCheckbox(frame, "#unit_2", true);
}

async function applyConfig(frame, cfg) {
  await chooseCityAndTown(frame, cfg);
  await fillKeyword(frame, cfg);
  await setDateRange(frame, cfg);
  await setTransactionTargets(frame, cfg);
  await setUnits(frame, cfg);
  await openAdvancedIfNeeded(frame, cfg);
  await setBuildingTypes(frame, cfg);
  await setAge(frame, cfg);
  await frame.waitForTimeout(cfg["慢速操作毫秒"] || 250);
}

async function getTopSearchBox(frame) {
  const handles = await frame.locator("a,button").filter({ hasText: /^搜尋$/ }).elementHandles();
  const boxes = [];
  for (const handle of handles) {
    const box = await handle.boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) boxes.push(box);
  }
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  return boxes[0] || null;
}

async function screenshotConditions(page, frame, outPath) {
  const box = await getTopSearchBox(frame);
  const vp = page.viewportSize();
  const height = box ? Math.min(vp.height, Math.ceil(box.y + box.height + 18)) : 280;
  await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: vp.width, height } });
}

async function clickSearch(page, frame) {
  const box = await getTopSearchBox(frame);
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 150 });
    return;
  }
  await frame.evaluate(() => {
    const candidates = [...document.querySelectorAll("a,button")]
      .filter((el) => (el.innerText || "").trim() === "搜尋" && el.offsetParent !== null)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.y - br.y || ar.x - br.x;
      });
    if (!candidates.length) throw new Error("找不到可見的搜尋按鈕。");
    candidates[0].click();
  });
}

async function waitForResults(frame, timeoutMs) {
  // 有資料 → 出現表頭；無資料 → 出現查無訊息。兩者皆視為查詢完成。
  await frame.waitForFunction(() => {
    const text = document.body.innerText || "";
    const hasTable = text.includes("地段位置或門牌");
    const empty = /查無|無符合|沒有.*資料|查詢結果：?\s*0\s*筆/.test(text);
    return hasTable || empty;
  }, null, { timeout: timeoutMs || 30000 });
}

async function extractRows(frame) {
  return frame.evaluate(() => {
    const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const tables = [...document.querySelectorAll("table")];
    const candidates = tables
      .map((table) => {
        const rect = table.getBoundingClientRect();
        const text = clean(table.innerText);
        const rows = [...table.querySelectorAll("tbody tr, tr")];
        const isNoData = (t) => !t || t.includes("地段位置或門牌") ||
          /查無|無資料|請確認查詢條件/.test(t);
        const dataRowCount = rows.filter((tr) => !isNoData(clean(tr.innerText))).length;
        return { table, rect, text, dataRowCount };
      })
      .filter(({ rect, text, dataRowCount }) => {
        return rect.width > 300 && rect.height > 40
          && text.includes("地段位置或門牌") && text.includes("交易日期")
          && dataRowCount > 0;
      })
      .sort((a, b) => b.dataRowCount - a.dataRowCount || a.rect.y - b.rect.y);
    const table = candidates[0]?.table;
    if (!table) return [];

    const headerCells = [...table.querySelectorAll("thead th")];
    const fallbackHeaderCells = [...table.querySelectorAll("tr:first-child th, tr:first-child td")];
    const headers = (headerCells.length ? headerCells : fallbackHeaderCells)
      .map((cell) => clean(cell.innerText))
      .filter(Boolean);

    const bodyRows = [...table.querySelectorAll("tbody tr")];
    const rows = bodyRows.length ? bodyRows : [...table.querySelectorAll("tr")].slice(1);
    return rows.map((tr) => {
      const cells = [...tr.querySelectorAll("td")].map((td) => clean(td.innerText));
      const row = {};
      headers.forEach((header, index) => {
        row[header || `欄位${index + 1}`] = cells[index] || "";
      });
      return row;
    }).filter((row) => {
      const joined = Object.values(row).join(" ");
      if (/查無|無資料|請確認查詢條件/.test(joined)) return false;
      return Object.values(row).some(Boolean);
    });
  });
}

// 目前可見結果頁第一列的指紋（判斷翻頁是否生效）
function rowSig(row) {
  return row ? Object.values(row).join("|") : "";
}

// 點「下一頁」(DataTables ›：.page-link[data-dt-idx=2])。
// 此站對 Playwright 的 .click() 判定常為「不可見」，故改用座標點擊（與搜尋鈕相同作法）。
async function clickNextPage(page, frame, beforeSig) {
  const btns = frame.locator('.page-link[data-dt-idx="2"]');
  const n = await btns.count();
  if (!n) return false;
  // 逐個候選用座標點，點完看可見表第一列有沒有變
  for (let i = 0; i < n; i++) {
    const box = await btns.nth(i).boundingBox().catch(() => null);
    if (!box || box.width <= 0) continue;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 120 });
    for (let t = 0; t < 16; t++) {
      await frame.waitForTimeout(250);
      const rows = await extractRows(frame);
      if (rows.length && rowSig(rows[0]) !== beforeSig) return true;
    }
  }
  return false;
}

// 逐頁擷取全部結果
async function extractAllPages(page, frame, totalExpected, hooks = {}) {
  const { onProgress, onPage } = hooks;
  const seen = new Set();
  const all = [];
  for (let pageNo = 1; pageNo <= 60; pageNo++) {
    const rows = await extractRows(frame);
    for (const r of rows) {
      const key = rowSig(r);
      if (!seen.has(key)) { seen.add(key); all.push(r); }
    }
    if (onPage) await onPage(pageNo);
    if (onProgress) onProgress(pageNo, rows.length, all.length);
    if (totalExpected && all.length >= totalExpected) break;
    if (!rows.length) break;
    const advanced = await clickNextPage(page, frame, rowSig(rows[0]));
    if (!advanced) break;
  }
  return all;
}

function totalFromSummary(summary) {
  const m = normalizeDigits(summary).match(/查詢結果\s*[：:]\s*(\d+)\s*筆/);
  return m ? Number(m[1]) : null;
}

// 回到第一頁（DataTables 首筆：data-dt-idx=0），座標點擊
async function clickFirstPage(page, frame, beforeSig) {
  const btns = frame.locator('.page-link[data-dt-idx="0"]');
  const n = await btns.count();
  if (!n) return false;
  for (let i = 0; i < n; i++) {
    const box = await btns.nth(i).boundingBox().catch(() => null);
    if (!box || box.width <= 0) continue;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 120 });
    for (let t = 0; t < 16; t++) {
      await frame.waitForTimeout(250);
      const rows = await extractRows(frame);
      if (rows.length && rowSig(rows[0]) !== beforeSig) return true;
    }
  }
  return false;
}

// 在可見結果表中找出某筆（門牌|交易日期 指紋），只把該列框紅並回傳是否找到
async function highlightRow(frame, sig) {
  return frame.evaluate((target) => {
    const norm = (s) => String(s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\s/g, "");
    const tables = [...document.querySelectorAll("table")].filter((t) => {
      const r = t.getBoundingClientRect();
      return r.width > 300 && r.height > 40 && (t.innerText || "").includes("地段位置或門牌") && (t.innerText || "").includes("交易日期");
    }).sort((a, b) => b.querySelectorAll("tbody tr").length - a.querySelectorAll("tbody tr").length);
    const t = tables[0];
    if (!t) return false;
    const heads = [...t.querySelectorAll("thead th, tr:first-child th")].map((x) => norm(x.innerText));
    const addrIdx = heads.findIndex((h) => h.includes("門牌"));
    const dateIdx = heads.findIndex((h) => h.includes("交易日期"));
    let found = false;
    for (const tr of t.querySelectorAll("tbody tr")) {
      const tds = [...tr.querySelectorAll("td")];
      const sig = norm(tds[addrIdx] ? tds[addrIdx].innerText : "") + "|" + norm(tds[dateIdx] ? tds[dateIdx].innerText : "");
      if (!found && sig === target) {
        tr.style.outline = "3px solid #d00";
        tr.style.background = "#fff3f3";
        found = true;
      } else {
        tr.style.outline = "";
        tr.style.background = "";
      }
    }
    return found;
  }, sig);
}

// 本頁有哪些 targets（回傳其指紋清單）
async function sigsOnPage(frame, sigs) {
  return frame.evaluate((wanted) => {
    const norm = (s) => String(s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\s/g, "");
    const tables = [...document.querySelectorAll("table")].filter((t) => {
      const r = t.getBoundingClientRect();
      return r.width > 300 && r.height > 40 && (t.innerText || "").includes("地段位置或門牌") && (t.innerText || "").includes("交易日期");
    }).sort((a, b) => b.querySelectorAll("tbody tr").length - a.querySelectorAll("tbody tr").length);
    const t = tables[0];
    if (!t) return [];
    const heads = [...t.querySelectorAll("thead th, tr:first-child th")].map((x) => norm(x.innerText));
    const addrIdx = heads.findIndex((h) => h.includes("門牌"));
    const dateIdx = heads.findIndex((h) => h.includes("交易日期"));
    const set = new Set(wanted);
    const here = [];
    for (const tr of t.querySelectorAll("tbody tr")) {
      const tds = [...tr.querySelectorAll("td")];
      const sig = norm(tds[addrIdx] ? tds[addrIdx].innerText : "") + "|" + norm(tds[dateIdx] ? tds[dateIdx].innerText : "");
      if (set.has(sig)) here.push(sig);
    }
    return here;
  }, sigs);
}

// 逐頁找出最接近的幾筆，各框紅截一張官方畫面
async function captureComparables(page, frame, outDir, targets, onShot) {
  const want = new Map(targets.map((t) => [t.match, t]));
  const captured = [];
  for (let pageNo = 1; pageNo <= 60 && want.size; pageNo++) {
    const present = await sigsOnPage(frame, [...want.keys()]);
    for (const sig of present) {
      const t = want.get(sig);
      if (!t) continue;
      const ok = await highlightRow(frame, sig);
      if (ok) {
        const fn = `比較標的_排名${String(t.rank).padStart(2, "0")}.png`;
        await page.screenshot({ path: path.join(outDir, fn), fullPage: false });
        captured.push({ rank: t.rank, file: fn, addr: t.addr, date: t.date, price: t.price });
        if (onShot) onShot(t.rank, t.addr);
      }
      want.delete(sig);
    }
    if (!want.size) break;
    const rows = await extractRows(frame);
    if (!rows.length) break;
    if (!(await clickNextPage(page, frame, rowSig(rows[0])))) break;
  }
  await frame.evaluate(() => {
    document.querySelectorAll("tbody tr").forEach((tr) => { tr.style.outline = ""; tr.style.background = ""; });
  }).catch(() => {});
  return captured.sort((a, b) => a.rank - b.rank);
}

// ─────────────── 接近度排序模組 ───────────────

// 全形數字 → 半形
function normalizeDigits(s) {
  return String(s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

// 取欄位（表頭空白不一，用關鍵字模糊比對）
function getField(row, ...keys) {
  for (const key of Object.keys(row)) {
    const k = key.replace(/\s+/g, "");
    if (keys.some((kw) => k.includes(kw))) return row[key];
  }
  return "";
}

// 依結果表「交易標的」欄（形如「土1 建1車0」）判斷是否含車位
function carCountOf(row) {
  const v = String(getField(row, "交易標的") || "");
  const m = v.match(/車\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}

// 交易日期 114/03/24 → 民國年月數值（便於比對），回傳 {y,m,num}
function parseRocDate(row) {
  const v = normalizeDigits(getField(row, "交易日期"));
  const m = v.match(/(\d{2,3})\/(\d{1,2})(?:\/(\d{1,2}))?/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3] || 1);
  return { y, m: mo, d, months: y * 12 + mo, num: y * 10000 + mo * 100 + d };
}

const CN_NUM = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnToInt(s) {
  s = String(s || "").trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (!s) return null;
  // 處理 十一、二十、二十三、十 等
  if (s === "十") return 10;
  let total = 0;
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    const tens = a ? (CN_NUM[a] || 0) : 1;
    const ones = b ? (CN_NUM[b] || 0) : 0;
    total = tens * 10 + ones;
  } else {
    total = CN_NUM[s] || null;
  }
  return total || null;
}

// 樓別/樓高欄 → 主要樓層數字（取「N樓」「N層」的 N）
function parseFloor(row) {
  const v = normalizeDigits(getField(row, "樓別", "樓層"));
  const m = v.match(/([0-9]+|[一二三四五六七八九十]+)\s*[樓層]/);
  if (!m) return null;
  return cnToInt(m[1]);
}

// 樓別/樓高欄「N層/M層」的 M（建物總樓層）——最能區分老公寓(低)與新大樓(高)
function parseTotalFloors(row) {
  const v = normalizeDigits(getField(row, "樓別", "樓層"));
  const parts = v.split("/");
  const tail = parts.length > 1 ? parts[parts.length - 1] : "";
  const m = tail.match(/([0-9]+|[一二三四五六七八九十]+)\s*[樓層]/);
  return m ? cnToInt(m[1]) : null;
}

// 屋齡欄 → 數字
function parseAge(row) {
  const v = normalizeDigits(getField(row, "屋齡")).trim();
  if (!v) return null;
  const n = Number(v.replace(/[^\d.]/g, ""));
  return isFinite(n) ? n : null;
}

// 備註欄是否屬特殊/瑕疵交易（關係人、急買急售等，單價代表性低，應排除或審慎）
function isAbnormal(row) {
  const v = String(getField(row, "備註") || "");
  return /親友|員工|共有人|特殊關係|關係人|瑕疵|民情風俗|急買|急售|債務|拍賣/.test(v);
}

// 備註欄是否有增建（頂樓加蓋/夾層/增建），會墊高面積使單價灌水（陽台外推屬輕微，不計）
function isInflated(row) {
  const v = String(getField(row, "備註") || "");
  return /頂樓加蓋|夾層|地下增建|其他增建|增建(?!.*交易)/.test(v);
}

// 門牌正規化後是否含關鍵字（去全形、去空白）
function addrMatches(row, keyword) {
  if (!keyword) return false;
  const addr = normalizeDigits(getField(row, "地段位置或門牌", "門牌")).replace(/\s/g, "");
  const kw = normalizeDigits(keyword).replace(/\s/g, "");
  return addr.includes(kw);
}

// 取門牌中的「巷N號」做同棟分群
function buildingKey(row) {
  const addr = normalizeDigits(getField(row, "地段位置或門牌", "門牌"));
  const m = addr.match(/(\d+巷\d+號|\d+號)/);
  return m ? m[1] : (addr.split(/[0-9]/)[0] || addr).slice(0, 12);
}

function unitPriceOf(row) {
  const v = normalizeDigits(getField(row, "單價"));
  const n = Number(v.replace(/[^\d.]/g, ""));
  return isFinite(n) && n > 0 ? n : null;
}

function parseSueMonths(s) {
  const m = normalizeDigits(s).match(/(\d{2,3})\D+(\d{1,2})/);
  if (!m) return null;
  return Number(m[1]) * 12 + Number(m[2]);
}

// 主排序：產出「最接近比較標的」清單
function rankComparables(rows, subject) {
  const kw = subject["門牌關鍵字"] || "";
  const sueMonths = parseSueMonths(subject["起訴年月"]);
  const subFloor = subject["樓層"] != null ? Number(subject["樓層"]) : null;
  const subTotal = subject["建物總樓層"] != null ? Number(subject["建物總樓層"]) : null;
  const subAge = subject["屋齡"] != null ? Number(subject["屋齡"]) : null;

  // 排除房地車後的母體
  const pool = rows.filter((r) => carCountOf(r) === 0);

  const scored = pool.map((r) => {
    const sameAddr = addrMatches(r, kw);
    const date = parseRocDate(r);
    const floor = parseFloor(r);
    const totalFloors = parseTotalFloors(r);
    const age = parseAge(r);
    const abnormal = isAbnormal(r);
    const inflated = isInflated(r);
    const noPrice = unitPriceOf(r) == null; // 無單價（多為整棟/全棟交易），無法當單價基準
    const oneF = floor === 1;
    // 分層：同棟(0) → 同巷其他(1)
    const tier = sameAddr ? 0 : 1;
    // 建物型態分組：以總樓層差分粗組（最能分辨老公寓/新大樓）。同組內不再細較樓層差。
    const hDiff = subTotal != null && totalFloors != null ? Math.abs(totalFloors - subTotal) : 0;
    const heightBucket = hDiff <= 2 ? 0 : (hDiff <= 6 ? 1 : 2);
    const ageKey = subAge != null && age != null ? Math.abs(age - subAge) : 0;
    // 時間接近度：有起訴年月用差距，否則用「越新越前」
    const timeKey = sueMonths != null && date ? Math.abs(date.months - sueMonths)
      : (date ? -date.num : Number.MAX_SAFE_INTEGER);
    const floorKey = subFloor != null && floor != null ? Math.abs(floor - subFloor) : 99;
    // 品質懲罰：無單價最重(3)、特殊交易與一樓(各2)、增建灌水(1)，排到同組後段（仍保留供參）
    const penalty = (noPrice ? 3 : 0) + (abnormal ? 2 : 0) + (oneF ? 2 : 0) + (inflated ? 1 : 0);
    return { r, sameAddr, date, floor, totalFloors, age, abnormal, inflated, noPrice, oneF, tier, heightBucket, ageKey, timeKey, floorKey, penalty };
  });

  // 同棟 → 同型態組(樓高) → 排除一樓/瑕疵 → 時間最近 → 樓層接近 → 屋齡接近
  scored.sort((a, b) =>
    a.tier - b.tier ||
    a.heightBucket - b.heightBucket ||
    a.penalty - b.penalty ||
    a.timeKey - b.timeKey ||
    a.floorKey - b.floorKey ||
    a.ageKey - b.ageKey
  );

  const subTotalF = subject["建物總樓層"] != null ? Number(subject["建物總樓層"]) : null;
  return scored.map((s, i) => {
    const notes = [];
    if (s.sameAddr) notes.push("同棟"); else notes.push("同巷");
    if (subTotalF != null && s.totalFloors != null && Math.abs(s.totalFloors - subTotalF) >= 5) notes.push("樓高差異大(型態可能不同)");
    if (s.oneF) notes.push("一樓");
    if (s.noPrice) notes.push("無單價(全棟交易)");
    if (s.inflated) notes.push("有增建(單價偏高)");
    if (s.abnormal) notes.push("特殊/瑕疵交易");
    return {
      "排名": i + 1,
      "註記": notes.join("、") || "乾淨可採",
      "交易日期": getField(s.r, "交易日期"),
      "單價": getField(s.r, "單價"),
      "樓別/樓高": getField(s.r, "樓別", "樓層"),
      "總面積": getField(s.r, "總面積", "面積"),
      "屋齡": getField(s.r, "屋齡"),
      "地段位置或門牌": getField(s.r, "地段位置或門牌", "門牌"),
      "主要用途": getField(s.r, "主要用途"),
      "備註": getField(s.r, "備註"),
      // 截圖比對用：正規化門牌＋日期（不輸出到 CSV 也行，但留著供程式比對）
      "_match": normalizeDigits(getField(s.r, "地段位置或門牌", "門牌")).replace(/\s/g, "") + "|" + normalizeDigits(getField(s.r, "交易日期"))
    };
  });
}

// 依門牌彙總（同棟各幾筆），供判斷哪些門牌屬同社區
function summarizeByBuilding(rows) {
  const map = new Map();
  for (const r of rows.filter((x) => carCountOf(x) === 0)) {
    const k = buildingKey(r);
    map.set(k, (map.get(k) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

async function readResultSummary(frame) {
  return frame.evaluate(() => {
    const text = document.body.innerText || "";
    const match = text.match(/顯示\s*\d+\s*至\s*\d+\s*筆\s*[（(]\s*查詢結果\s*[：:]\s*\d+\s*筆\s*[）)]/);
    return match ? match[0].replace(/\s+/g, "") : "";
  });
}

async function sha256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function main() {
  const cfg = readJson(configPath);
  const runId = `${timestamp()}_${safeName(cfg["案件名稱"])}`;
  const outputRoot = path.resolve(ROOT, cfg["輸出資料夾"] || "output/evidence");
  const outDir = path.join(outputRoot, runId);
  ensureDir(outDir);

  const browser = await chromium.launch({
    headless: !cfg["顯示瀏覽器"],
    slowMo: Number(cfg["慢速操作毫秒"] || 0)
  });

  const page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  const url = cfg["官方網址"] || "https://lvr.land.moi.gov.tw/";
  const startedAt = new Date();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const frame = await getMainFrame(page);

    await applyConfig(frame, cfg);

    const conditionShot = path.join(outDir, "001_官方查詢條件畫面.png");
    await screenshotConditions(page, frame, conditionShot);

    await clickSearch(page, frame);
    await page.waitForTimeout(Number(cfg["查詢後等待毫秒"] || 8000));
    await waitForResults(frame, 30000).catch(async (err) => {
      await page.screenshot({ path: path.join(outDir, "搜尋後未出結果畫面.png"), fullPage: false });
      throw err;
    });

    const resultShot = path.join(outDir, "002_官方查詢結果第1頁.png");
    await page.screenshot({ path: resultShot, fullPage: false });
    const summary = await readResultSummary(frame);
    const total = totalFromSummary(summary);

    // 逐頁擷取全部結果（結果表分頁渲染，DataTables ›）
    const fetchAll = String(cfg["擷取頁數"] || "").includes("全部") || cfg["擷取頁數"] === 0;
    const perPageShot = !!cfg["每頁截圖"];
    let rows;
    if (fetchAll) {
      console.log("逐頁擷取中…");
      rows = await extractAllPages(page, frame, total, {
        onProgress: (p, pr, acc) => console.log(`  第 ${p} 頁：本頁 ${pr} 筆，累計 ${acc}${total ? "/" + total : ""}`),
        onPage: perPageShot ? async (p) => {
          await page.screenshot({ path: path.join(outDir, `頁面_第${String(p).padStart(2, "0")}頁.png`), fullPage: false });
        } : null
      });
    } else {
      rows = await extractRows(frame);
    }

    // 原始全部（與官方畫面一致）
    const csvPath = path.join(outDir, "官方查詢結果_全部.csv");
    const jsonPath = path.join(outDir, "官方查詢結果_全部.json");
    writeCsv(csvPath, rows);
    fs.writeFileSync(jsonPath, JSON.stringify(rows, null, 2), "utf8");

    // 排除房地車後的篩選版（供單價分析用）
    let excludeCount = 0;
    if (cfg["排除房地車"]) {
      const filtered = rows.filter((r) => carCountOf(r) === 0);
      excludeCount = rows.length - filtered.length;
      writeCsv(path.join(outDir, "篩選後_排除房地車.csv"), filtered);
    }

    // 接近度排序：最接近系爭房屋的比較標的
    const subject = cfg["系爭房屋"] || {};
    let ranked = [];
    let buildingSummary = [];
    if (subject["門牌關鍵字"] || subject["樓層"] != null) {
      ranked = rankComparables(rows, subject);
      buildingSummary = summarizeByBuilding(rows);
      writeCsv(path.join(outDir, "最接近比較標的.csv"), ranked);
    }

    // 對最接近的前 N 筆，各框紅截一張官方畫面（本階段核心產出）
    let comparableShots = [];
    const shotN = Number(cfg["截圖最接近筆數"] || 0);
    if (ranked.length && shotN > 0 && fetchAll) {
      const targets = ranked.slice(0, shotN).map((r) => ({
        match: r._match, rank: r["排名"], addr: r["地段位置或門牌"],
        date: r["交易日期"], price: r["單價"]
      }));
      console.log(`截取最接近 ${targets.length} 筆的官方畫面…`);
      const cur = await extractRows(frame);
      await clickFirstPage(page, frame, cur.length ? rowSig(cur[0]) : "");
      comparableShots = await captureComparables(page, frame, outDir, targets,
        (rank, addr) => console.log(`  排名 ${rank}：${addr}`));
    }

    const conditionHash = await sha256(conditionShot);
    const resultHash = await sha256(resultShot);
    const top = ranked.slice(0, 5);
    const log = [
      "內政部實價查詢官方網頁截圖與表格擷取紀錄",
      "",
      `執行時間：${startedAt.toLocaleString("zh-TW", { hour12: false })}`,
      `官方網址：${url}`,
      `案件名稱：${cfg["案件名稱"] || ""}`,
      `縣市：${normalizeCity(cfg["縣市"])}`,
      `行政區：${cfg["行政區"] || ""}`,
      `門牌/社區關鍵字：${cfg["門牌社區關鍵字"] || "（未設定）"}`,
      `交易期間：${cfg["交易期間"]?.["起年"]}/${cfg["交易期間"]?.["起月"]} 至 ${cfg["交易期間"]?.["迄年"]}/${cfg["交易期間"]?.["迄月"]}`,
      `交易標的：${(cfg["交易標的"] || []).join("、")}`,
      `官方頁面摘要：${summary}`,
      `擷取表格列數：${rows.length}${total ? "／官方共 " + total + " 筆" : ""}${fetchAll ? "（已逐頁擷取全部）" : "（僅第1頁）"}`,
      cfg["排除房地車"] ? `其中含車位(房地車)：${excludeCount} 筆，排除後 ${rows.length - excludeCount} 筆` : "",
      "",
      "── 系爭房屋 ──",
      `門牌關鍵字：${subject["門牌關鍵字"] || "（未設定）"}`,
      `樓層：${subject["樓層"] != null ? subject["樓層"] : "（未設定）"}　起訴年月：${subject["起訴年月"] || "（未設定，暫以最近交易排序）"}`,
      "",
      "── 門牌彙總（排除房地車後，依筆數）──",
      ...buildingSummary.map(([k, n]) => `${k}：${n} 筆`),
      "",
      "── 最接近比較標的（前 5）──",
      ...top.map((r) => `${r["排名"]}. [${r["註記"]}] ${r["交易日期"]}　單價 ${r["單價"]}　${r["樓別/樓高"]}　${r["地段位置或門牌"]}`),
      "",
      ...(comparableShots.length ? [
        "── 最接近比較標的官方截圖（各框紅一筆）──",
        ...comparableShots.map((s) => `${s.file}　排名${s.rank}　${s.date}　單價${s.price}　${s.addr}`),
        ""
      ] : []),
      "產出檔案：",
      `001_官方查詢條件畫面.png SHA-256 ${conditionHash}`,
      `002_官方查詢結果第1頁.png SHA-256 ${resultHash}`,
      "官方查詢結果_全部.csv（與官方畫面一致）",
      "官方查詢結果_全部.json",
      cfg["排除房地車"] ? "篩選後_排除房地車.csv（供單價分析）" : "",
      ranked.length ? "最接近比較標的.csv（依接近度排序）" : "",
      ...comparableShots.map((s) => `${s.file}（排名${s.rank}比較標的官方畫面，已框紅）`),
      "",
      "提醒：截圖為官方網頁畫面，CSV/JSON 僅係依畫面表格擷取之輔助整理。排序僅供初步篩選，最終比較標的之取捨由法院認定。"
    ].filter((line) => line !== "").join("\r\n");
    fs.writeFileSync(path.join(outDir, "操作紀錄.txt"), "﻿" + log, "utf8");

    console.log("完成。輸出資料夾：");
    console.log(outDir);
    console.log("");
    console.log(summary || `擷取表格列數：${rows.length}`);
    console.log(`實際擷取 ${rows.length} 筆${cfg["排除房地車"] ? `，含車位 ${excludeCount} 筆已排除` : ""}`);
    if (ranked.length) {
      console.log("");
      console.log("最接近比較標的（前 5）：");
      top.forEach((r) => console.log(`  ${r["排名"]}. [${r["註記"]}] ${r["交易日期"]} 單價${r["單價"]} ${r["樓別/樓高"]} ${r["地段位置或門牌"]}`));
    }
    if (comparableShots.length) {
      console.log("");
      console.log(`已截取 ${comparableShots.length} 張最接近比較標的官方畫面（檔名 比較標的_排名NN.png）`);
    }
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("");
    console.error("執行失敗：");
    console.error(err && err.stack ? err.stack : String(err));
    console.error("");
    console.error("若是第一次執行，請確認已成功安裝 Playwright 與 Chromium。");
    process.exit(1);
  });
}

module.exports = { rankComparables, summarizeByBuilding, carCountOf };
