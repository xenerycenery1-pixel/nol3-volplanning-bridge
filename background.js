// ============================================================
// NOL3 VOLPLANNING BRIDGE v1.0.0 - service worker
// Same pipeline SPX's own Export button uses (adapted from the BAUKO SPX BRIDGE):
//   1) send the export request      -> task_id
//   2) poll list_for_portal         -> export_status 2 (done)
//   3) get_signed_download_url      -> download the CSV
//   4) send the CSV text to the NOL3 VolPlanning page (the page does all filtering)
// The fetches run here in the service worker; host_permissions attach your SPX login
// cookies. The station is whatever SPX account you are logged in to.
// ============================================================

const SPX_ORIGIN = "https://spx.shopee.ph";
const VERSION = "1.0.0";

const FORWARD_EXPORT_PATH = "/api/admin/tracking/am_hub/forward/export";
const TO_EXPORT_PATH = "/api/in-station/receive/to/export";
const TASK_LIST_PATH = "/spxdata/api/export_platform/export_task/list_for_portal";
const SIGNED_URL_PATH = "/spxdata/api/export_platform/export_task/get_signed_download_url";
const FORWARD_EXPORT_NAME = "export_forward_order";
const FORWARD_BIZ_NAME = "fleet_order";

const POLL_MS = 3000;
const MAX_WAIT_MS = 25 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30000;
const TASK_APPEAR_MS = 90 * 1000;      // a created task must show up in the task list within this time
const LOOKBACK_DAYS = 14;              // Created Date window, same as the SPX UI default
const PH_OFFSET_SEC = 8 * 3600;        // Asia/Manila, no DST

// kind -> request shape + the messages the dashboard listens for
const JOBS = {
  inbound: {
    label: "Inbound", forward: true, steps: true,
    ids: [50, 49, 1, 36, 15],
    names: ["LMHub_Assigned", "LMHub_Assigning", "LMHub_Received", "SOC_LHTransported", "SOC_LHTransporting"],
    progressType: "VOLPLAN_SPX_PARCEL_INBOUND_PROGRESS", csvType: "VOLPLAN_SPX_PARCEL_CSV", errKind: "parcel-inbound"
  },
  delivery: {
    label: "Delivery", forward: true, steps: true,
    ids: [4, 2, 5],
    names: ["Delivered", "Delivering", "OnHold"],
    assignedToday: true,                // Assigned Time (pick_up_time) = today 00:00:00 - 23:59:59
    progressType: "VOLPLAN_SPX_PARCEL_DELIVERY_PROGRESS", csvType: "VOLPLAN_SPX_PARCEL_DELIVERY_CSV", errKind: "parcel-delivery"
  },
  linehaul: {
    label: "TO List", steps: false,     // the dashboard adds its own "Step 2/3" for this one
    progressType: "VOLPLAN_SPX_PROGRESS", csvType: "VOLPLAN_SPX_CSV", errKind: "linehaul"
  }
};
const START_TYPES = {
  VOLPLAN_START_PARCEL_INBOUND_SYNC: "inbound",
  VOLPLAN_START_PARCEL_DELIVERY_SYNC: "delivery",
  VOLPLAN_START_LINEHAUL_SYNC: "linehaul"
};

// Every connected VolPlanning page. One running sync per page AND per kind
// (the dashboard lets you start Inbound, Delivery and TO List back to back).
const ports = new Set();
const jobs = new Map();          // tabKey:kind -> run
let portSeq = 0;
let keepAliveTimer = null;

// MV3 service workers are stopped by Chrome after ~30s without extension activity,
// and fetch()/setTimeout waits do not count. While a sync runs, ping an extension API
// and push a message down the port every 20s so the worker (and the port) stay alive.
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; }); } catch (_) {}
    sendToPage("VOLPLAN_BRIDGE_PING", { t: Date.now() });
  }, 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// run given -> only the page (tab) that started it; no run -> every connected page.
function sendToPage(type, data = {}, run = null) {
  let sent = false;
  for (const p of Array.from(ports)) {
    if (run && p.__tabKey !== run.tabKey) continue;
    try { p.postMessage({ type, ...data }); sent = true; } catch (_) { ports.delete(p); }
  }
  return sent;
}
function progress(run, step, message) {
  const job = JOBS[run.kind];
  sendToPage(job.progressType, { message: job.steps ? "Step " + step + "/3 · " + message : message }, run);
}

// ---------- dates (Philippine calendar) ----------
function todayManila() {
  return new Date(Date.now() + PH_OFFSET_SEC * 1000).toISOString().slice(0, 10);
}
function dayStartSec(date) {
  return Math.floor(Date.parse(date + "T00:00:00Z") / 1000) - PH_OFFSET_SEC;
}
function shiftDate(date, days) {
  const d = new Date(Date.parse(date + "T00:00:00Z"));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- export requests (shapes captured from the SPX portal) ----------
function buildForwardBody(job, date) {
  const start = dayStartSec(date);
  const endSec = start + 86400 - 1;                       // 23:59:59 of the dispatch date
  const fromDate = shiftDate(date, -LOOKBACK_DAYS);
  const fromSec = start - LOOKBACK_DAYS * 86400;
  const body = {
    tracking_status: job.ids.join(","),
    bulky_type: "1,0,2",
    ctime: fromSec + "," + endSec
  };
  let assigned = "";
  if (job.assignedToday) {
    body.pick_up_time = start + "," + endSec;             // Assigned Time = today, to 23:59:59
    assigned = "Assigned Time= " + date + " 00:00:00," + date + " 23:59:59; ";
  }
  body.format_condition =
    "Status Log= " + job.names.join(",") + "; " +
    "Bulky Type= Bulky,N/A,Non-Bulky; " +
    "Created Date= " + fromDate + " 00:00:00," + date + " 23:59:59; " +
    assigned + "Driver= All";
  return body;
}

function buildRequest(kind, date) {
  const job = JOBS[kind];
  if (job.forward) {
    return { url: SPX_ORIGIN + FORWARD_EXPORT_PATH, method: "POST", body: JSON.stringify(buildForwardBody(job, date)) };
  }
  // TO List: Pending Receive. The page matches its SPX TN to the Order ID of the
  // SOC_LHTransporting / SOC_LHTransported incoming orders to get the Line Haul Task ID.
  const q = new URLSearchParams({ status: "0", format_condition: "Status= Pending Receive; Operator= All" });
  return { url: SPX_ORIGIN + TO_EXPORT_PATH + "?" + q.toString(), method: "GET", body: null };
}

// ---------- network helpers ----------
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out after " + Math.round(ms / 1000) + " seconds.")), ms);
      })
    ]);
  } finally { clearTimeout(timer); }
}

async function spxFetch(url, init = {}) {
  const response = await withTimeout(
    fetch(url, {
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      ...init,
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        ...(init.headers || {})
      }
    }),
    FETCH_TIMEOUT_MS,
    "SPX request"
  );
  const text = await response.text();
  return { status: response.status, ok: response.ok, contentType: response.headers.get("content-type") || "", text };
}

function parseJson(label, response) {
  const raw = String(response.text || "");
  try { return JSON.parse(raw); } catch (_) {
    const preview = raw.replace(/\s+/g, " ").slice(0, 200);
    if (/<!doctype|<html/i.test(preview)) {
      throw new Error(label + ": SPX returned the web page instead of JSON (HTTP " + response.status + "). Log in to SPX and try again.");
    }
    throw new Error(label + ": SPX returned non-JSON data (HTTP " + response.status + "): " + preview);
  }
}

// An export call either queues a task (JSON with task_id) or answers with the file itself.
function looksLikeCsv(res) {
  if (/json|html/i.test(res.contentType)) return false;
  const t = String(res.text || "").replace(/^\uFEFF/, "").trimStart();
  return t.length > 0 && t[0] !== "{" && t[0] !== "[" && t[0] !== "<" && t.includes(",") && t.includes("\n");
}

async function submitExport(run) {
  const job = JOBS[run.kind];
  const rq = buildRequest(run.kind, run.date);
  progress(run, 2, job.label + ": submitting SPX export...");
  const res = await spxFetch(rq.url, rq.method === "POST"
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: rq.body }
    : { method: "GET" });
  if (looksLikeCsv(res)) return { direct: res.text };
  const json = parseJson(job.label + " export", res);
  if (!res.ok || Number(json && json.retcode) !== 0) {
    throw new Error((json && json.message) || (job.label + " export request failed (HTTP " + res.status + ")."));
  }
  const d = json.data;
  const taskId = Number((d && typeof d === "object" && (d.task_id ?? d.id)) || json.task_id || 0);
  if (!taskId) throw new Error(job.label + ": SPX accepted the export but returned no task ID.");
  progress(run, 2, job.label + ": export task " + taskId + " created.");
  return { taskId };
}

async function listTasks(startSec) {
  const url = SPX_ORIGIN + TASK_LIST_PATH + "?start_time=" + encodeURIComponent(startSec) + "&count=100&pageno=1";
  const res = await spxFetch(url);
  const json = parseJson("SPX export task list", res);
  if (Number(json && json.retcode) !== 0) throw new Error((json && json.message) || "SPX task list request failed.");
  return Array.isArray(json && json.data && json.data.task_list) ? json.data.task_list : [];
}

async function waitForCompletion(run, taskId, startSec) {
  const job = JOBS[run.kind];
  const began = Date.now();
  const deadline = began + MAX_WAIT_MS;
  let lastStatus = null, lastQueue = null, lastAt = 0, seen = false;
  while (Date.now() < deadline) {
    const tasks = await listTasks(startSec);
    const task = tasks.find((t) => Number(t && t.task_id || 0) === taskId);
    if (task) {
      seen = true;
      const status = Number(task.export_status ?? -1);
      const queue = String(task.queue_position || "");
      if (status === 2) return task;
      if (status === 3 || task.failed_reason) throw new Error(task.failed_reason || "SPX export failed.");
      const now = Date.now();
      if (status !== lastStatus || queue !== lastQueue || now - lastAt >= 10000) {
        const el = Math.floor((now - run.startedAt) / 1000);
        progress(run, 2, job.label + ": export processing" + (queue ? " (queue " + queue + ")" : "") + " - " +
          String(Math.floor(el / 60)).padStart(2, "0") + ":" + String(el % 60).padStart(2, "0"));
        lastStatus = status; lastQueue = queue; lastAt = now;
      }
    } else if (!seen && Date.now() - began >= TASK_APPEAR_MS) {
      throw new Error(job.label + ": SPX created export task " + taskId + " but it never appeared in the export task list.");
    }
    await sleep(POLL_MS);
  }
  throw new Error(job.label + ": SPX export still queued after 25 minutes.");
}

// The Inbound/Delivery exports use source=fms. The TO List may sit under a different
// source, so try what the finished task reports, then fms, then no source at all.
async function getSignedDownloadUrl(taskId, task) {
  const sources = [];
  for (const s of [task && task.source, "fms", ""]) {
    if (s !== undefined && s !== null && !sources.includes(String(s))) sources.push(String(s));
  }
  let lastError = "SPX did not return a signed download URL.";
  for (const source of sources) {
    const url = SPX_ORIGIN + SIGNED_URL_PATH + "?" + (source ? "source=" + encodeURIComponent(source) + "&" : "") + "task_id=" + encodeURIComponent(taskId);
    try {
      const res = await spxFetch(url);
      const json = parseJson("SPX signed download URL", res);
      if (Number(json && json.retcode) !== 0) { lastError = (json && json.message) || lastError; continue; }
      const signed = String((json.data && json.data.download_url) || "");
      if (signed) return signed;
      lastError = "SPX returned no signed download URL.";
    } catch (e) { lastError = (e && e.message) || String(e); }
  }
  throw new Error(lastError);
}

function fileNameFromSignedUrl(signedUrl, fallback) {
  try {
    const u = new URL(signedUrl);
    const disp = u.searchParams.get("response-content-disposition") || "";
    const m = disp.match(/filename(?:\*)?=(?:UTF-8''|"?)([^;\r\n"]+)/i);
    if (m && m[1]) return decodeURIComponent(m[1].trim());
  } catch (_) {}
  return fallback;
}

async function downloadCsv(signedUrl, fallbackName) {
  let res;
  try {
    res = await spxFetch(signedUrl, { headers: { "Accept": "text/csv,text/plain,*/*" } });
  } catch (e) {
    throw new Error("CSV download blocked (" + ((e && e.message) || e) + "). Check the susercontent.com host permissions in manifest.json.");
  }
  if (!res.ok) throw new Error("CSV download failed (HTTP " + res.status + ").");
  const text = String(res.text || "").replace(/^\uFEFF/, "");
  if (!text.trim()) throw new Error("SPX returned an empty CSV file.");
  return { text, fileName: fileNameFromSignedUrl(signedUrl, fallbackName) };
}

// ---------- task validation (Inbound / Delivery only: they share one export type) ----------
function setsEqual(a, b) {
  const x = new Set(a.map(String)), y = new Set(b.map(String));
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
}
function parseCondition(task) {
  const raw = task && task.condition;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch (_) { return {}; }
}
// returns "" when OK, otherwise a human-readable reason
function checkForwardTask(task, job) {
  if (String(task.export_name || "") !== FORWARD_EXPORT_NAME || String(task.biz_name || "") !== FORWARD_BIZ_NAME) {
    return "export type is " + (task.export_name || "?") + "/" + (task.biz_name || "?");
  }
  const ts = String(parseCondition(task).tracking_status || "");
  if (!ts || !setsEqual(ts.split(",").map((s) => s.trim()).filter(Boolean), job.ids)) {
    return "status filter is '" + ts + "', expected '" + job.ids.join(",") + "'";
  }
  return "";
}

// ---------- one export, start to finish ----------
async function runPipeline(run) {
  const job = JOBS[run.kind];
  const sub = await submitExport(run);
  let csv, taskId = null;
  if (sub.direct !== undefined) {
    const text = String(sub.direct).replace(/^\uFEFF/, "");
    if (!text.trim()) throw new Error("SPX returned an empty CSV file.");
    csv = { text, fileName: "nol3_" + run.kind + ".csv" };
  } else {
    taskId = sub.taskId;
    const waitStartSec = Math.max(0, Math.floor((run.startedAt - 10 * 60 * 1000) / 1000));
    const task = await waitForCompletion(run, taskId, waitStartSec);
    if (job.forward) {
      const why = checkForwardTask(task, job);
      if (why) throw new Error(job.label + ": the finished SPX task is not the expected export - " + why);
    }
    progress(run, 3, job.label + ": export ready, downloading CSV...");
    const signed = await getSignedDownloadUrl(taskId, task);
    csv = await downloadCsv(signed, "nol3_" + run.kind + ".csv");
  }
  const rowCount = Math.max(0, csv.text.split(/\r?\n/).filter(Boolean).length - 1);
  progress(run, 3, job.label + ": downloaded " + rowCount.toLocaleString() + " rows. Sending to NOL3...");
  sendToPage(job.csvType, { date: run.date, taskId, fileName: csv.fileName, rowCount, csvText: csv.text }, run);
}

async function runSync(run) {
  const job = JOBS[run.kind];
  try {
    startKeepAlive();
    run.startedAt = Date.now();
    await runPipeline(run);
  } catch (e) {
    console.error("[NOL3 BRIDGE]", run.kind, e);
    sendToPage("VOLPLAN_SPX_ERROR", { kind: job.errKind, message: String((e && e.message) || e) }, run);
  } finally {
    if (jobs.get(run.key) === run) jobs.delete(run.key);
    if (jobs.size === 0) stopKeepAlive();
  }
}

// ---------- page connection ----------
// Only the VolPlanning page may talk to this worker. localhost / file:// are allowed for testing.
function isVolplanPage(url) {
  const u = String(url || "");
  return /^file:/i.test(u) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(u) ||
    /^https:\/\/xenerycenery1-pixel\.github\.io\/nol3-volplanning(?:[/?#]|$)/i.test(u);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "VOLPLAN_PAGE") return;
  const from = String((port.sender && (port.sender.url || port.sender.origin)) || "");
  if (!isVolplanPage(from)) {
    console.warn("[NOL3 BRIDGE] rejected origin:", from);
    try { port.disconnect(); } catch (_) {}
    return;
  }

  // One key per browser tab; reconnects of the same tab keep the key, so a running sync keeps reporting to it.
  const tab = port.sender && port.sender.tab;
  const tabKey = tab && tab.id != null ? "tab" + tab.id : "p" + (++portSeq);
  port.__tabKey = tabKey;
  for (const old of Array.from(ports)) {
    if (old.__tabKey === tabKey) { ports.delete(old); try { old.disconnect(); } catch (_) {} }
  }
  ports.add(port);
  try { port.postMessage({ type: "VOLPLAN_BRIDGE_READY", version: VERSION }); } catch (_) {}

  port.onMessage.addListener((msg) => {
    if (!msg || !msg.type || msg.type === "VOLPLAN_PING") return;
    const kind = START_TYPES[msg.type];
    if (!kind) return;
    const key = tabKey + ":" + kind;
    if (jobs.has(key)) {
      sendToPage("VOLPLAN_SPX_ERROR", { kind: JOBS[kind].errKind, message: JOBS[kind].label + " sync is already running." }, { tabKey });
      return;
    }
    const date = ISO.test(msg.date || "") ? msg.date : todayManila();
    const run = { kind, key, tabKey, date, startedAt: 0 };
    jobs.set(key, run);
    void runSync(run);
  });

  port.onDisconnect.addListener(() => { ports.delete(port); void chrome.runtime.lastError; });
});

chrome.runtime.onInstalled.addListener(() => console.log("[NOL3 BRIDGE] v" + VERSION + " installed"));
