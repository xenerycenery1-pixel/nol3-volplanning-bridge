// ============================================================
// NOL3 VOLPLANNING BRIDGE v1.0.0 - page side (NOL3 VolPlanning dashboard <-> service worker)
// Runs only on the VolPlanning page (see manifest "matches" + title check), never on SPX.
// ============================================================
(() => {
  if (window.__nol3VolplanBridge) return;
  // The match list also covers localhost/file:// for testing, so only act on the VolPlanning dashboard itself.
  if (!/NOL3 Planning Dashboard/i.test(document.title || "")) return;
  window.__nol3VolplanBridge = true;

  const PAGE_SOURCE = "VOLPLAN_BRIDGE";   // extension -> page
  const CHECKER_SOURCE = "VOLPLAN_PAGE";   // page -> extension
  const VERSION = "1.0.0";
  const START = [
    "VOLPLAN_START_PARCEL_INBOUND_SYNC",
    "VOLPLAN_START_PARCEL_DELIVERY_SYNC",
    "VOLPLAN_START_LINEHAUL_SYNC"
  ];

  let port = null;
  let reconnectTimer = null;
  let retries = 0;
  let shuttingDown = false;
  let pingTimer = null;
  const isInvalidated = (m) => /context invalidated|extension context/i.test(String(m || ""));

  const emit = (type, data = {}) => window.postMessage({ ...data, source: PAGE_SOURCE, type }, "*");

  const scheduleReconnect = () => {
    if (shuttingDown || reconnectTimer) return;
    // back off 0.75s, 1.5s, 3s ... max 5s, so a failing connection never hammers the worker
    const delay = Math.min(5000, 750 * Math.pow(2, Math.min(retries++, 3)));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  };

  function connect() {
    if (shuttingDown || port) return;
    try {
      port = chrome.runtime.connect({ name: "VOLPLAN_PAGE" });
      port.onMessage.addListener((msg) => {
        if (!msg || !msg.type) return;
        if (msg.type === "VOLPLAN_BRIDGE_PING") return;     // worker keep-alive only
        if (msg.type === "VOLPLAN_BRIDGE_READY") retries = 0;
        emit(msg.type, msg);
      });
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        try { port && port.postMessage({ type: "VOLPLAN_PING" }); } catch (_) {}
      }, 20000);
      port.onDisconnect.addListener(() => {
        const reason = chrome.runtime.lastError?.message || "Bridge connection closed.";
        port = null;
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        emit("VOLPLAN_BRIDGE_DISCONNECTED", { message: reason });
        scheduleReconnect();
      });
      emit("VOLPLAN_BRIDGE_READY", { version: VERSION });
    } catch (error) {
      port = null;
      emit("VOLPLAN_BRIDGE_DISCONNECTED", { message: (error && error.message) || String(error) });
      // "Extension context invalidated" cannot recover until the page is refreshed;
      // anything else (worker still starting) is retried.
      if (!isInvalidated(error && error.message)) scheduleReconnect();
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const m = event.data;
    if (!m || m.source !== CHECKER_SOURCE) return;

    if (m.type === "VOLPLAN_BRIDGE_HELLO") {
      if (port) emit("VOLPLAN_BRIDGE_READY", { version: VERSION });
      else connect();
      return;
    }

    if (START.includes(m.type)) {
      if (!port) {
        emit("VOLPLAN_SPX_ERROR", {
          kind: m.type === "VOLPLAN_START_PARCEL_INBOUND_SYNC" ? "parcel-inbound" :
                m.type === "VOLPLAN_START_PARCEL_DELIVERY_SYNC" ? "parcel-delivery" : "linehaul",
          message: "NOL3 VolPlanning Bridge is not connected. Reload the extension, then refresh this page (F5)."
        });
        return;
      }
      try {
        port.postMessage({ type: m.type, date: m.date || null });
      } catch (error) {
        emit("VOLPLAN_SPX_ERROR", { kind: "linehaul", message: (error && error.message) || String(error) });
      }
    }
  });

  window.addEventListener("beforeunload", () => {
    shuttingDown = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { port && port.disconnect(); } catch (_) {}
  });

  connect();
})();
