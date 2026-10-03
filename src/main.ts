import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  t,
  setLang,
  detectLang,
  isLang,
  applyStaticTranslations,
  LANGS,
  type Lang,
} from "./i18n";

// ---------- Types (match Rust serde structs; returns are snake_case) ----------
interface HdcInfo {
  path: string;
  version: string;
  server_port: string | null;
  api_version: number | null;
  explicit: boolean;
}
interface HdcCandidate {
  path: string;
  api_version: number | null;
  sdk_version: string;
  hdc_version: string;
  source: string; // "DevEco Studio" | "OpenHarmony SDK" | "PATH"
}
interface PathHdc {
  current: HdcCandidate | null;
  scope: string; // "user" | "system" | ""
  entry: string;
  best: HdcCandidate | null;
  outdated: boolean;
}
interface Device {
  connect_key: string;
  conn_type: string;
  status: string;
  raw: string;
}
interface Candidate {
  ip: string;
  port: number;
  target: string;
}
interface NetIface {
  name: string;
  ip: string;
  netmask: string;
  prefix: number;
  network: string;
  usable_hosts: number;
  is_private: boolean;
}
interface CmdOutput {
  success: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}
interface ScanProgress {
  phase: string;
  scanned: number;
  total: number;
  found: number;
}
interface DiscoverResult {
  targets: string[];
  total: number;
  needs_firewall: boolean;
  raw: string;
}
interface HostInfo {
  ip: string;
  mac: string;
  likely_mobile: boolean;
  note: string;
  hostname: string;
}
interface DeviceDetail {
  model: string;
  brand: string;
  os_version: string;
}
interface ArpEntry {
  ip: string;
  mac: string;
}
// A remembered device. Keyed by MAC for TCP (IP/port change), by serial for USB.
interface DeviceRecord {
  id: string;
  kind: string;
  mac?: string;
  lastTarget?: string; // last ip:port (for reconnect)
  lastKey?: string;
  lastPort?: number; // last port that gave a real Connected (hdc port)
  name?: string; // model from device
  note?: string; // user label
  lastConnected: number;
}

// ---------- Settings ----------
interface Settings {
  hdcPath: string;
  ports: string;
  wirelessPort: number;
  timeout: number;
  concurrency: number;
  pollInterval: number; // seconds; 0 = off
  connectTimeout: number; // hdc tconn timeout (ms)
  autoRelocate: boolean; // follow history devices to a new IP by MAC
  theme: string;
  lang: Lang;
}
const DEFAULTS: Settings = {
  hdcPath: "",
  ports: "10178",
  wirelessPort: 10178,
  timeout: 400,
  concurrency: 256,
  pollInterval: 10,
  connectTimeout: 2000,
  autoRelocate: true,
  theme: "eclipse",
  lang: "en",
};

// ---------- Themes ----------
interface ThemeDef {
  id: string;
  swatch: [string, string, string]; // [bg, surface, accent]
}
// Display name/tag come from i18n (theme.<id>.name / theme.<id>.tag).
const THEMES: ThemeDef[] = [
  { id: "eclipse", swatch: ["#0a0b10", "#191c26", "#6366f1"] },
  { id: "carbon", swatch: ["#0b0c0e", "#1a1d21", "#38bdf8"] },
  { id: "daybreak", swatch: ["#f5f6f9", "#ffffff", "#6366f1"] },
  { id: "mist", swatch: ["#f2f6f5", "#ffffff", "#0d9488"] },
];
function applyTheme(id: string) {
  const valid = THEMES.some((t) => t.id === id) ? id : DEFAULTS.theme;
  document.documentElement.setAttribute("data-theme", valid);
  settings.theme = valid;
  renderThemePickers();
}
function paintThemeGrid(el: Element | null) {
  if (!el) return;
  el.innerHTML = THEMES.map(
    (tm) => `
    <button type="button" class="theme-card${tm.id === settings.theme ? " active" : ""}" data-theme-id="${tm.id}">
      <div class="theme-swatch" style="background:${tm.swatch[0]}">
        <i style="background:${tm.swatch[1]}"></i>
        <i class="s-accent" style="background:${tm.swatch[2]}"></i>
      </div>
      <div class="theme-name">${t(`theme.${tm.id}.name`)}</div>
      <div class="theme-tag">${t(`theme.${tm.id}.tag`)}</div>
    </button>`
  ).join("");
}
function renderThemePickers() {
  paintThemeGrid(document.querySelector("#theme-grid"));
  paintThemeGrid(document.querySelector("#theme-pop-grid"));
}
const SETTINGS_KEY = "gethdc.settings";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const s: Settings = { ...DEFAULTS, ...parsed };
      // First run (no saved language) → auto-detect from the system language.
      if (!isLang(parsed.lang)) s.lang = detectLang();
      return s;
    }
  } catch (_) {
    /* ignore */
  }
  return { ...DEFAULTS, lang: detectLang() };
}
function saveSettings(s: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
let settings = loadSettings();

// ---------- DOM helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;
function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}
function hdcPathArg(): string | null {
  return settings.hdcPath.trim() || null;
}

// ---------- Debug log ----------
type LogLevel = "info" | "ok" | "err" | "cmd";
interface LogEntry {
  t: number;
  level: LogLevel;
  msg: string;
}
const LOG_MAX = 1000;
const logs: LogEntry[] = [];
let logOpen = false;

function ts(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function log(level: LogLevel, msg: string) {
  logs.push({ t: Date.now(), level, msg });
  if (logs.length > LOG_MAX) logs.shift();
  if (logOpen) renderLogs();
}
function renderLogs() {
  const box = $("#log-body");
  if (logs.length === 0) {
    box.innerHTML = `<div class="empty">${esc(t("log.empty"))}</div>`;
    return;
  }
  box.innerHTML = logs
    .map((e) => `<div class="log-line log-${e.level}"><span class="log-t">${ts(e.t)}</span>${esc(e.msg)}</div>`)
    .join("");
  box.scrollTop = box.scrollHeight;
}
function openLog() {
  logOpen = true;
  renderLogs();
  $("#log-modal").classList.remove("hidden");
}
function closeLog() {
  logOpen = false;
  $("#log-modal").classList.add("hidden");
}

// ---------- Toast ----------
function toast(msg: string, kind: "ok" | "err" | "info" = "info") {
  log(kind, msg); // every user-facing message also lands in the debug log
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="t-msg">${esc(msg)}</span>`;
  $("#toast-area").appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(20px)";
    el.style.transition = "0.25s";
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

// ---------- State ----------
let devices: Device[] = [];
let candidates: Candidate[] = [];
let hosts: HostInfo[] = [];
let scanning = false;
let scanAllRunning = false;
let scanAllAbort = false;
let stopRequested = false;

async function stopScan() {
  stopRequested = true;
  scanAllAbort = true;
  $("#scan-progress-text").textContent = t("progress.stopping");
  try {
    await invoke("cancel_scan");
  } catch (_) {
    /* ignore */
  }
  toast(t("toast.stopRequested"), "info");
}

function selectedSubnet(): { network: string; prefix: number } | null {
  const opt = $<HTMLSelectElement>("#iface-select").selectedOptions[0];
  const network = opt?.dataset.network;
  const prefix = opt?.dataset.prefix;
  if (!network || !prefix) return null;
  return { network, prefix: parseInt(prefix, 10) };
}

// ---------- Device book (notes + history, MAC-bound) ----------
const BOOK_KEY = "gethdc.book";
let book: Record<string, DeviceRecord> = {};
let arpMap: Record<string, string> = {}; // ip -> mac
let onlineTargets = new Set<string>(); // history ip:port currently reachable
let onlineMac: Record<string, string | null> = {}; // ip:port -> MAC that answered the probe
let pollTimer: ReturnType<typeof setInterval> | undefined;

function loadBook() {
  try {
    book = JSON.parse(localStorage.getItem(BOOK_KEY) || "{}");
  } catch (_) {
    book = {};
  }
  // Drop junk: entries never actually connected and without a user note.
  let changed = false;
  for (const [k, r] of Object.entries(book)) {
    if (!r.note && !r.lastConnected) {
      delete book[k];
      changed = true;
    }
  }
  if (changed) saveBook();
}
function saveBook() {
  localStorage.setItem(BOOK_KEY, JSON.stringify(book));
}
async function refreshArp() {
  try {
    const entries = await invoke<ArpEntry[]>("arp_table");
    arpMap = {};
    for (const e of entries) arpMap[e.ip] = e.mac;
  } catch (_) {
    /* ignore */
  }
  migrateBook();
}

/**
 * Merge MAC-less `tcp:ip:port` records into their MAC-keyed twin once the ARP
 * table reveals the device's MAC. A device first connected before ARP resolved
 * its MAC creates a `tcp:` record; the next connect creates a `mac:` record —
 * leaving two history rows for one device. The MAC record (which carries the
 * user's note) wins; the tcp record is folded in and removed.
 */
function migrateBook() {
  let changed = false;
  // Fold a stray tcp record into the canonical MAC record (which holds the note).
  const fold = (tgt: DeviceRecord, r: DeviceRecord, mac?: string) => {
    if (!tgt.note && r.note) tgt.note = r.note;
    if (!tgt.name && r.name) tgt.name = r.name;
    if ((r.lastConnected || 0) > (tgt.lastConnected || 0)) {
      tgt.lastConnected = r.lastConnected;
      if (r.lastTarget) tgt.lastTarget = r.lastTarget;
    }
    if (r.lastPort && !tgt.lastPort) tgt.lastPort = r.lastPort;
    if (mac && !tgt.mac) tgt.mac = mac;
  };
  const macRecords = Object.values(book).filter((r) => r.id.startsWith("mac:"));
  for (const [k, r] of Object.entries(book)) {
    if (!k.startsWith("tcp:")) continue;
    const ip = (r.lastTarget || k.slice(4)).split(":")[0];
    const liveMac = arpMap[ip];
    // 1) ARP knows this IP's MAC → use that record (or promote if none).
    if (liveMac) {
      const macId = "mac:" + liveMac;
      if (book[macId]) fold(book[macId], r, liveMac);
      else {
        r.id = macId;
        r.mac = liveMac;
        r.kind = "TCP";
        book[macId] = r;
      }
      delete book[k];
      changed = true;
      continue;
    }
    // 2) Device offline (no ARP) — still merge if a MAC record shares this exact
    //    ip:port, so the duplicate collapses into the noted record regardless.
    const twin = macRecords.find((m) => m.lastTarget && m.lastTarget === r.lastTarget);
    if (twin) {
      fold(twin, r, twin.mac);
      delete book[k];
      changed = true;
    }
  }
  if (changed) saveBook();
}
function isTcpKey(key: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(key);
}
/** Stable identity for a device: MAC for TCP (falls back to ip:port), serial for USB. */
function identityFor(connectKey: string): {
  id: string;
  mac?: string;
  kind: string;
  target?: string;
} {
  if (isTcpKey(connectKey)) {
    const ip = connectKey.split(":")[0];
    const mac = arpMap[ip];
    return { id: mac ? `mac:${mac}` : `tcp:${connectKey}`, mac, kind: "TCP", target: connectKey };
  }
  return { id: `key:${connectKey}`, kind: "UNKNOWN" };
}
function noteForKey(connectKey: string): string | undefined {
  return book[identityFor(connectKey).id]?.note;
}

// ---------- hdc detection ----------
async function detectHdc() {
  const pill = $("#hdc-status");
  const text = $("#hdc-status-text");
  const detail = $("#hdc-detail");
  pill.className = "hdc-pill pill-warn";
  text.textContent = t("hdc.detecting");
  try {
    const info = await invoke<HdcInfo>("detect_hdc", { hdcPath: hdcPathArg() });
    log(
      "ok",
      t("log.hdcDetected", {
        version: info.version,
        path: info.path,
        port: info.server_port ?? t("hdc.notSet"),
      })
    );
    pill.className = "hdc-pill pill-ok";
    text.textContent = `hdc ${info.version}${info.api_version != null ? ` · API ${info.api_version}` : ""}`;
    pill.title = info.path;
    detail.innerHTML =
      `<b>${esc(t("hdc.detailPath"))}:</b> ${esc(info.path)}<br/>` +
      `<b>${esc(t("hdc.detailVersion"))}:</b> ${esc(info.version)}<br/>` +
      `<b>${esc(t("hdc.detailApi"))}:</b> ${esc(info.api_version != null ? String(info.api_version) : "?")}<br/>` +
      `<b>${esc(t("hdc.detailSource"))}:</b> ${esc(t(info.explicit ? "hdc.sourceManual" : "hdc.sourceAuto"))}<br/>` +
      `<b>${esc(t("hdc.detailServerPort"))}:</b> ${esc(info.server_port ?? t("hdc.notSet"))}`;
  } catch (e) {
    pill.className = "hdc-pill pill-err";
    text.textContent = t("hdc.notFound");
    detail.innerHTML =
      `<span style="color:var(--red)">${esc(t("hdc.notFoundHint"))}</span><br/>` +
      `<span class="muted">${esc(String(e))}</span>`;
  }
}

// ---------- hdc picker + terminal PATH ----------
function hdcDesc(c: HdcCandidate): string {
  return `API ${c.api_version ?? "?"} · hdc ${c.hdc_version || "?"}`;
}

/** Fill the "detected hdc" dropdown (newest SDK first; "" = auto). */
async function loadHdcPicker(refresh = false) {
  const sel = $<HTMLSelectElement>("#set-hdc-pick");
  try {
    const list = await invoke<HdcCandidate[]>("list_hdc", { refresh });
    const sdk = list.filter((c) => c.source !== "PATH");
    const autoLabel = sdk.length ? t("settings.hdcAuto", { desc: hdcDesc(sdk[0]) }) : t("settings.hdcNone");
    const current = ($("#set-hdc-path") as HTMLInputElement).value.trim().toLowerCase();
    sel.innerHTML =
      `<option value="">${esc(autoLabel)}</option>` +
      list
        .map(
          (c) =>
            `<option value="${esc(c.path)}"${c.path.toLowerCase() === current ? " selected" : ""}>${esc(
              `${hdcDesc(c)} · ${c.source} — ${c.path}`
            )}</option>`
        )
        .join("");
    if (!current) sel.value = "";
  } catch (e) {
    sel.innerHTML = `<option value="">${esc(String(e))}</option>`;
  }
}

/** Show whether the terminal PATH's hdc lags the newest SDK (with a fix button). */
async function refreshPathHdc(logIfOutdated = false) {
  const banner = $("#path-hdc");
  const ok = $("#path-hdc-ok");
  try {
    const st = await invoke<PathHdc>("path_hdc_status");
    if (st.outdated && st.best) {
      const best = hdcDesc(st.best);
      $("#path-hdc-text").textContent = st.current
        ? t("settings.pathHdcOld", { cur: hdcDesc(st.current), best })
        : t("settings.pathHdcMissing", { best });
      $("#btn-update-path").textContent = t(st.current ? "btn.updatePath" : "btn.addPath");
      $("#btn-update-path").title = st.entry ? `${st.entry} → ${st.best.path}` : st.best.path;
      banner.classList.remove("hidden");
      ok.classList.add("hidden");
      if (logIfOutdated && st.current) log("info", t("log.pathOutdated", { cur: hdcDesc(st.current), best }));
    } else {
      banner.classList.add("hidden");
      ok.textContent = st.current ? t("settings.pathHdcOk", { cur: hdcDesc(st.current) }) : "";
      ok.classList.toggle("hidden", !st.current);
    }
  } catch (e) {
    banner.classList.add("hidden");
    ok.classList.add("hidden");
  }
}

async function updatePathHdc() {
  const btn = $<HTMLButtonElement>("#btn-update-path");
  btn.disabled = true;
  try {
    const dir = await invoke<string>("update_path_hdc");
    log("ok", t("log.pathUpdated", { dir }));
    toast(t("toast.pathUpdated", { dir }), "ok");
  } catch (e) {
    toast(t("toast.pathFail", { e: String(e) }), "err");
  } finally {
    btn.disabled = false;
    await refreshPathHdc();
  }
}

// ---------- Interfaces ----------
async function loadInterfaces() {
  const sel = $<HTMLSelectElement>("#iface-select");
  const prev = sel.selectedOptions[0]?.dataset.network;
  sel.innerHTML = "";
  try {
    const ifaces = await invoke<NetIface[]>("get_interfaces");
    if (ifaces.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = t("iface.none");
      sel.appendChild(opt);
      return;
    }
    for (const f of ifaces) {
      const opt = document.createElement("option");
      opt.dataset.network = f.network;
      opt.dataset.prefix = String(f.prefix);
      const tag = f.is_private ? "" : " ⚠";
      opt.textContent =
        t("iface.option", {
          name: f.name,
          ip: f.ip,
          prefix: f.prefix,
          hosts: f.usable_hosts,
        }) + tag;
      sel.appendChild(opt);
      if (f.network === prev) opt.selected = true;
    }
  } catch (e) {
    toast(t("toast.ifaceFail", { e: String(e) }), "err");
  }
}

// ---------- Devices ----------
function deviceIcon(t: string): string {
  if (t === "USB" || t === "UART") return "🔌";
  if (t === "TCP") return "📶";
  return "📱";
}
function statusBadge(status: string): string {
  const s = status.toLowerCase();
  let cls = "badge-off";
  if (/connected|ready/.test(s)) cls = "badge-on";
  else if (/unauth|authing|connecting/.test(s)) cls = "badge-warn";
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}
// "Current" = actively connected or mid-handshake (excludes Offline/Empty/Unknown).
function isCurrent(d: Device): boolean {
  return /connected|ready|unauth|authing|connecting/i.test(d.status);
}
function timeAgo(ts: number): string {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return t("time.justNow");
  if (s < 3600) return t("time.minAgo", { n: Math.floor(s / 60) });
  if (s < 86400) return t("time.hourAgo", { n: Math.floor(s / 3600) });
  return t("time.dayAgo", { n: Math.floor(s / 86400) });
}

// UART (COM serial) ports are PC-side debug ports, not wireless/USB devices.
function isManaged(d: Device): boolean {
  return d.conn_type !== "UART";
}

function renderDevices() {
  const list = $("#device-list");
  const current = devices.filter((d) => isCurrent(d) && isManaged(d));
  $("#device-count").textContent = String(current.length);
  if (current.length === 0) {
    list.innerHTML = `<div class="empty">${esc(t("connected.empty"))}</div>`;
  } else {
    list.innerHTML = current
      .map((d) => {
        const id = identityFor(d.connect_key);
        const rec = book[id.id];
        const isTcp = d.conn_type === "TCP";
        const title = rec?.note || rec?.name || d.connect_key;
        const sub = [
          `<span class="badge ${isTcp ? "badge-tcp" : "badge-usb"}">${esc(d.conn_type)}</span>`,
          statusBadge(d.status),
          `<span class="muted">${esc(d.connect_key)}</span>`,
          rec?.name && rec?.note ? `<span class="muted">${esc(rec.name)}</span>` : "",
          id.mac ? `<span class="muted">${esc(id.mac)}</span>` : "",
        ]
          .filter(Boolean)
          .join("");
        // TCP rows open a detail popup on click (edit note / disconnect);
        // USB rows keep inline note + 开启无线 and aren't click-to-detail.
        const actions = isTcp
          ? `<button class="btn btn-danger btn-sm" data-act="disconnect" data-key="${esc(d.connect_key)}">${esc(t("btn.disconnect"))}</button>
             <span class="row-chev">›</span>`
          : `<button class="btn btn-ghost btn-sm" data-act="note" data-id="${esc(id.id)}">${esc(t("btn.note"))}</button>
             <button class="btn btn-ghost btn-sm" data-act="wireless" data-key="${esc(d.connect_key)}">${esc(t("btn.wireless"))}</button>`;
        const rowCls = isTcp ? "row-item host-row" : "row-item";
        const rowData = isTcp ? `data-act="detail-connected" data-key="${esc(d.connect_key)}"` : "";
        return `
        <div class="${rowCls}" ${rowData}>
          <div class="dev-icon">${deviceIcon(d.conn_type)}</div>
          <div class="dev-main">
            <div class="dev-key">${esc(title)}</div>
            <div class="dev-sub">${sub}</div>
          </div>
          <div class="dev-actions">${actions}</div>
        </div>`;
      })
      .join("");
  }
  renderHistory();
}

/**
 * A history device counts as online only if BOTH hold:
 *  1. its last ip:port answered a fresh TCP handshake this poll, and
 *  2. (when both MACs are known) the IP still belongs to this very device.
 * The MAC cross-check stops a reused IP — or a stale port that another device
 * happens to expose — from masquerading as "this device is back online".
 */
function isHistoryOnline(r: DeviceRecord): boolean {
  if (!r.lastTarget || !onlineTargets.has(r.lastTarget)) return false;
  if (!r.mac) return true; // no remembered MAC to verify against — trust the TCP probe
  const ip = r.lastTarget.split(":")[0];
  // MAC that actually answered the probe (freshest), falling back to the ARP table.
  const ansMac = (onlineMac[r.lastTarget] || arpMap[ip] || "").toLowerCase();
  // Require the remembered device to be genuinely present on the LAN: its MAC must
  // be answering. A port that accepts TCP but whose IP has no ARP entry (device
  // powered off / IP gone) is NOT treated as online, even though it "connected".
  return ansMac === r.mac.toLowerCase();
}

function renderHistory() {
  const list = $("#history-list");
  const currentIds = new Set(
    devices.filter((d) => isCurrent(d) && isManaged(d)).map((d) => identityFor(d.connect_key).id)
  );
  const items = Object.values(book)
    .filter((r) => !currentIds.has(r.id) && (r.lastConnected > 0 || !!r.note))
    .sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0));
  $("#history-count").textContent = String(items.length);
  if (items.length === 0) {
    list.innerHTML = `<div class="empty">${esc(t("history.empty"))}</div>`;
    return;
  }
  list.innerHTML = items
    .map((r) => {
      const title = r.note || r.name || r.lastTarget || r.lastKey || r.id;
      const online = isHistoryOnline(r);
      const statusBadge = r.lastTarget
        ? online
          ? `<span class="badge badge-on">${esc(t("history.online"))}</span>`
          : `<span class="badge badge-off">${esc(t("history.offline"))}</span>`
        : "";
      const sub = [
        statusBadge,
        r.lastTarget ? `<span class="muted">${esc(r.lastTarget)}</span>` : "",
        r.name && r.note ? `<span class="muted">${esc(r.name)}</span>` : "",
        r.mac ? `<span class="muted">${esc(r.mac)}</span>` : "",
        r.lastConnected ? `<span class="muted">${esc(t("history.last", { ago: timeAgo(r.lastConnected) }))}</span>` : "",
      ]
        .filter(Boolean)
        .join("");
      const connectBtn = r.lastTarget
        ? `<button class="btn ${online ? "btn-primary" : "btn-ghost"} btn-sm" data-act="connect" data-target="${esc(
            r.lastTarget
          )}">${esc(t("btn.connect"))}</button>`
        : "";
      return `
      <div class="row-item host-row" data-act="detail" data-id="${esc(r.id)}">
        <div class="dev-icon">🕘</div>
        <div class="dev-main">
          <div class="dev-key">${esc(title)}</div>
          <div class="dev-sub">${sub || `<span class="muted">${esc(t("history.noRecord"))}</span>`}</div>
        </div>
        <div class="dev-actions">
          ${connectBtn}
          <span class="row-chev">›</span>
        </div>
      </div>`;
    })
    .join("");
}

function upsertSeen() {
  const now = Date.now();
  for (const d of devices) {
    if (!isCurrent(d) || !isManaged(d)) continue; // skip UART; only real connected devices
    const id = identityFor(d.connect_key);
    const rec = book[id.id] || { id: id.id, kind: id.kind, lastConnected: 0 };
    rec.kind = d.conn_type;
    if (id.mac) rec.mac = id.mac;
    rec.lastKey = d.connect_key;
    if (id.target) rec.lastTarget = id.target;
    if (/connected|ready/i.test(d.status)) rec.lastConnected = now;
    // Remember the port that actually gave a real hdc Connected.
    if (/connected/i.test(d.status) && d.conn_type === "TCP" && id.target) {
      const port = parseInt(id.target.split(":")[1], 10);
      if (port) rec.lastPort = port;
    }
    book[id.id] = rec;
  }
  saveBook();
}

/** Remove dead TCP wireless connections (Offline/Unknown) from hdc's target list. */
async function cleanupDeadTcp() {
  const dead = devices.filter(
    (d) => d.conn_type === "TCP" && /offline|unknown/i.test(d.status)
  );
  if (dead.length === 0) return;
  for (const d of dead) {
    await invoke<CmdOutput>("disconnect_device", {
      hdcPath: hdcPathArg(),
      target: d.connect_key,
    }).catch(() => {});
  }
  await refreshDevices();
}

async function fetchNames() {
  // Only Connected devices answer `shell param get`; UART "Ready" ports would hang.
  const current = devices.filter((d) => /connected/i.test(d.status));
  let changed = false;
  await Promise.all(
    current.map(async (d) => {
      const id = identityFor(d.connect_key).id;
      if (book[id]?.name) return;
      try {
        const det = await invoke<DeviceDetail>("device_detail", {
          hdcPath: hdcPathArg(),
          connectKey: d.connect_key,
        });
        const name = [det.model, det.brand && det.brand !== det.model ? `(${det.brand})` : ""]
          .filter((x) => x && x !== "未知")
          .join(" ");
        if (name && book[id]) {
          book[id].name = name;
          changed = true;
        }
      } catch (_) {
        /* ignore */
      }
    })
  );
  if (changed) {
    saveBook();
    renderDevices();
  }
}

function editNote(id: string) {
  const cur = book[id]?.note || "";
  const v = prompt(t("prompt.note"), cur);
  if (v === null) return;
  if (!book[id]) book[id] = { id, kind: "UNKNOWN", lastConnected: 0 };
  book[id].note = v.trim();
  saveBook();
  renderDevices();
  renderCandidates();
  toast(t("toast.noteSaved"), "ok");
}
function forgetDevice(id: string) {
  if (!book[id]) return;
  if (!confirm(t("confirm.forget"))) return;
  delete book[id];
  saveBook();
  renderDevices();
}

// ---------- Device detail / connect modal ----------
type DmMode = "history" | "connected" | "host";
let dmCtx: { bookId: string; mode: DmMode; connectKey?: string } | null = null;

function openDeviceModal(ctx: {
  ip?: string;
  port?: string | number;
  mac?: string;
  name?: string;
  note?: string;
  bookId: string;
  mode: DmMode;
  connectKey?: string;
  title?: string;
  extra?: string;
}) {
  dmCtx = { bookId: ctx.bookId, mode: ctx.mode, connectKey: ctx.connectKey };
  $("#dm-title").textContent = ctx.title || ctx.note || ctx.name || ctx.ip || t("dm.title");
  $("#dm-name").textContent = ctx.name || t("dm.nameUnknown");
  ($("#dm-ip") as HTMLInputElement).value = ctx.ip || "";
  ($("#dm-port") as HTMLInputElement).value = ctx.port != null ? String(ctx.port) : "";
  $("#dm-mac").textContent = ctx.mac || t("dm.macUnknown");
  ($("#dm-note") as HTMLInputElement).value = ctx.note || "";
  $("#dm-extra").textContent = ctx.extra || "";
  // Delete only makes sense for a saved history record.
  ($("#dm-delete") as HTMLElement).style.display = ctx.mode === "history" ? "" : "none";
  ($("#dm-relocate") as HTMLElement).style.display = ctx.mode === "history" && ctx.mac ? "" : "none";
  // Connected devices get 断开 (red); history/host get 连接 (blue).
  const primary = $("#dm-connect") as HTMLButtonElement;
  const connected = ctx.mode === "connected";
  primary.textContent = connected ? t("btn.disconnect") : t("btn.connect");
  primary.className = connected ? "btn btn-danger" : "btn btn-primary";
  // IP/port are connection inputs — read-only-feel for an already-connected device.
  const ipEl = $("#dm-ip") as HTMLInputElement;
  const portEl = $("#dm-port") as HTMLInputElement;
  ipEl.readOnly = connected;
  portEl.readOnly = connected;
  $("#device-modal").classList.remove("hidden");
  setTimeout(() => (connected ? $("#dm-note") : portEl).focus(), 50);
}
function closeDeviceModal() {
  $("#device-modal").classList.add("hidden");
  dmCtx = null;
}
function dmSaveNote(silent = false) {
  if (!dmCtx) return;
  const id = dmCtx.bookId;
  const note = ($("#dm-note") as HTMLInputElement).value.trim();
  const ip = ($("#dm-ip") as HTMLInputElement).value.trim();
  const port = ($("#dm-port") as HTMLInputElement).value.trim();
  const mac = id.startsWith("mac:") ? id.slice(4) : undefined;
  if (!book[id]) book[id] = { id, kind: "TCP", lastConnected: 0, mac };
  book[id].note = note;
  if (ip && port) book[id].lastTarget = `${ip}:${port}`;
  saveBook();
  renderDevices();
  renderCandidates();
  renderHosts();
  if (!silent) toast(t("toast.saved"), "ok");
}
/** Primary button: 断开 for a connected device, otherwise 连接. */
async function dmPrimary() {
  if (dmCtx?.mode === "connected") {
    dmSaveNote(true); // keep any note edit
    const key = dmCtx.connectKey;
    closeDeviceModal();
    if (key) await disconnectTarget(key);
    return;
  }
  await dmConnect();
}
async function dmConnect() {
  const ip = ($("#dm-ip") as HTMLInputElement).value.trim();
  const port = ($("#dm-port") as HTMLInputElement).value.trim();
  if (!ip || !/^\d+$/.test(port)) {
    toast(t("toast.invalidIpPort"), "err");
    return;
  }
  dmSaveNote(true); // persist note/target before connecting
  closeDeviceModal();
  await connectTarget(`${ip}:${port}`);
}
function dmDelete() {
  if (!dmCtx) return;
  const id = dmCtx.bookId;
  closeDeviceModal();
  forgetDevice(id);
}

function openHistoryDetail(id: string) {
  const r = book[id];
  if (!r) return;
  const [ip, port] = (r.lastTarget || "").split(":");
  openDeviceModal({
    ip,
    port,
    mac: r.mac,
    name: r.name,
    note: r.note,
    bookId: id,
    mode: "history",
    title: r.note || r.name || t("history.title"),
    extra: r.lastConnected ? t("dm.lastConnected", { ago: timeAgo(r.lastConnected) }) : "",
  });
}
function openHostConnect(ip: string) {
  const h = hosts.find((x) => x.ip === ip);
  const mac = h?.mac || arpMap[ip];
  const bookId = mac ? "mac:" + mac : "tcp:" + ip;
  const rec = mac ? book["mac:" + mac] : undefined;
  openDeviceModal({
    ip,
    port: rec?.lastPort,
    mac,
    name: rec?.name,
    note: rec?.note,
    bookId,
    mode: "host",
    title: rec?.note || rec?.name || ip,
    extra: rec?.lastPort
      ? t("dm.hostExtraPort", { port: rec.lastPort })
      : t("dm.hostExtraNoPort"),
  });
}
/** Open detail for a currently-connected device (edit note / disconnect). */
function openConnectedDetail(connectKey: string) {
  const id = identityFor(connectKey);
  const rec = book[id.id];
  const [ip, port] = connectKey.split(":");
  openDeviceModal({
    ip,
    port,
    mac: id.mac,
    name: rec?.name,
    note: rec?.note,
    bookId: id.id,
    mode: "connected",
    connectKey,
    title: rec?.note || rec?.name || connectKey,
    extra: t("dm.connectedExtra"),
  });
}

async function refreshDevices() {
  try {
    await refreshArp();
    devices = await invoke<Device[]>("list_devices", { hdcPath: hdcPathArg() });
    upsertSeen();
    renderDevices();
    renderCandidates();
    fetchNames(); // async; updates names when ready
  } catch (e) {
    toast(t("toast.listFail", { e: String(e) }), "err");
  }
}

/** Probe history devices' last ip:port to see which are online/reconnectable. */
/** `relocate`: run (and await) a relocate pass with these options instead of the
 * background ARP-table-only check. */
async function probeHistory(relocate?: RelocateOpts) {
  const currentIds = currentIdSet();
  const targets = Object.values(book)
    .filter((r) => !currentIds.has(r.id) && r.lastTarget)
    .map((r) => r.lastTarget!) as string[];
  if (targets.length === 0) {
    onlineTargets = new Set();
    renderHistory();
    return;
  }
  try {
    const results = await invoke<{ target: string; mac: string | null }[]>("probe_targets", {
      targets,
      timeoutMs: 600,
    });
    onlineTargets = new Set(results.map((r) => r.target));
    onlineMac = {};
    for (const r of results) onlineMac[r.target] = r.mac ? r.mac.toLowerCase() : null;
    const offline = targets.filter((t) => !onlineTargets.has(t));
    // Show the answering MAC so a reused/proxied IP is visible at a glance.
    const onlineDesc = results
      .map((r) => `${r.target}${r.mac ? `→${r.mac}` : ""}`)
      .join(", ");
    log(
      "info",
      t("log.historyProbe", { ans: results.length, total: targets.length }) +
        (results.length ? t("log.probeAnswered", { desc: onlineDesc }) : "") +
        (offline.length ? t("log.probeOffline", { list: offline.join(", ") }) : "")
    );
  } catch (e) {
    onlineTargets = new Set(); // don't show stale "online" if the probe failed
    onlineMac = {};
    log("err", t("log.historyProbeFail", { e: String(e) }));
  }
  renderHistory();
  if (relocate) await relocateMovedDevices(currentIds, relocate);
  else if (settings.autoRelocate) void relocateMovedDevices(currentIds);
}

// ---------- Follow history devices to a new IP (by MAC) ----------
// DHCP may hand a device a new IP while its MAC and hdc port stay the same. For
// offline history devices we look the MAC up in ARP (sweeping the subnet now and
// then so the OS re-resolves), then only adopt the new ip:port after a real hdc
// handshake succeeds — an open port alone is not proof.
let relocating = false;
// Every poll only re-reads the ARP table. The subnet-wide sweep (knock every
// address so the OS re-learns MACs) runs once ~90 s after launch, then only on
// demand: "Refresh all" in the history panel, or "Find new IP" on one device.
const STARTUP_SWEEP_DELAY_MS = 90_000;
const RELOCATE_RETRY_MS = 300_000; // don't re-try the same failed candidate for 5 min
const relocateTried: Record<string, number> = {}; // "mac|ip:port" -> last attempt

function normMac(mac: string): string {
  return mac.trim().toLowerCase().replace(/:/g, "-");
}
function portOf(r: DeviceRecord): number | undefined {
  if (r.lastPort) return r.lastPort;
  const p = parseInt((r.lastTarget || "").split(":")[1] || "", 10);
  return p > 0 ? p : undefined;
}

interface RelocateOpts {
  /** Knock the whole subnet first so devices that moved show up in ARP. */
  sweep?: boolean;
  /** Only this history record. */
  onlyId?: string;
  /** User asked: ignore the per-candidate retry cooldown. */
  force?: boolean;
}
type RelocateOutcome = "notFound" | "same" | "closed" | "noHdc" | "relocated";

/** Returns what happened per record id (empty if nothing was checked). */
async function relocateMovedDevices(
  currentIds: Set<string>,
  opts: RelocateOpts = {}
): Promise<Map<string, RelocateOutcome>> {
  const outcome = new Map<string, RelocateOutcome>();
  if (relocating) {
    if (!opts.force) return outcome; // a background pass is running; skip this one
    while (relocating) await new Promise((r) => setTimeout(r, 200));
  }
  const moved = Object.values(book).filter(
    (r) =>
      (!opts.onlyId || r.id === opts.onlyId) &&
      !currentIds.has(r.id) &&
      r.mac &&
      portOf(r) &&
      !isHistoryOnline(r)
  );
  if (moved.length === 0) return outcome;
  relocating = true;
  try {
    const sub = selectedSubnet();
    const sweep = !!opts.sweep && !!sub;
    const found = await invoke<ArpEntry[]>("locate_macs", {
      macs: moved.map((r) => r.mac!),
      network: sub?.network ?? null,
      prefix: sub?.prefix ?? null,
      sweep,
    });
    const ipOfMac = new Map(found.map((e) => [normMac(e.mac), e.ip]));
    for (const r of moved) {
      const newIp = ipOfMac.get(normMac(r.mac!));
      outcome.set(r.id, "notFound");
      if (!newIp) continue; // not on the LAN (powered off / other network)
      const port = portOf(r)!;
      const cand = `${newIp}:${port}`;
      outcome.set(r.id, "same");
      if (cand === r.lastTarget) continue; // same address — device is there but hdc isn't listening
      const key = `${normMac(r.mac!)}|${cand}`;
      if (!opts.force && Date.now() - (relocateTried[key] || 0) < RELOCATE_RETRY_MS) continue;
      relocateTried[key] = Date.now();

      const name = r.note || r.name || r.mac!;
      const from = r.lastTarget || "?";
      log("info", t("log.relocateCheck", { name, from, to: cand }));
      // Cheap gate first: the port must answer, and (if ARP says) from this very MAC.
      const probe = await invoke<{ target: string; mac: string | null }[]>("probe_targets", {
        targets: [cand],
        timeoutMs: 800,
      });
      const ans = probe[0];
      if (!ans || (ans.mac && normMac(ans.mac) !== normMac(r.mac!))) {
        outcome.set(r.id, "closed");
        log("info", t("log.relocateClosed", { name, target: cand }));
        continue;
      }
      // Real proof: hdc handshake (tconn + list targets). We only want the address,
      // not a connection, so drop it again right after it checks out.
      if (await tryConnectQuiet(cand)) {
        await invoke<CmdOutput>("disconnect_device", { hdcPath: hdcPathArg(), target: cand }).catch(() => {});
        r.lastTarget = cand;
        r.lastPort = port;
        saveBook();
        arpMap[newIp] = r.mac!;
        // Show it as online/connectable right away instead of waiting for the next probe.
        onlineTargets.add(cand);
        onlineMac[cand] = normMac(r.mac!);
        outcome.set(r.id, "relocated");
        log("ok", t("log.relocated", { name, from, to: cand }));
        toast(t("toast.relocated", { name, to: cand }), "ok");
        await refreshDevices();
      } else {
        outcome.set(r.id, "noHdc");
        log("info", t("log.relocateNoHdc", { name, target: cand }));
      }
    }
  } catch (e) {
    log("err", t("log.relocateFail", { e: String(e) }));
  } finally {
    relocating = false;
  }
  return outcome;
}

/** "Find new IP" on one history device. */
async function relocateOne(id: string) {
  const r = book[id];
  if (!r) return;
  const name = r.note || r.name || r.mac || id;
  if (isHistoryOnline(r)) {
    toast(t("toast.relocateStillThere", { name }), "ok");
    return;
  }
  toast(t("toast.relocateSearching", { name }), "info");
  const res = (await relocateMovedDevices(currentIdSet(), { sweep: true, force: true, onlyId: id })).get(id);
  // undefined: nothing to check (no saved hdc port) — same advice as not found.
  if (res === "notFound" || res === undefined) toast(t("toast.relocateNotFound", { name }), "info");
  else if (res === "same" || res === "closed" || res === "noHdc")
    toast(t("toast.relocateNoHdc", { name }), "err");
  // "relocated" toasts on its own.
}

function currentIdSet(): Set<string> {
  return new Set(
    devices.filter((d) => isCurrent(d) && isManaged(d)).map((d) => identityFor(d.connect_key).id)
  );
}

/** Periodic status refresh (connected list + history online check). */
async function pollStatus(relocate?: RelocateOpts) {
  if (scanning || scanAllRunning) return;
  await refreshDevices();
  await probeHistory(relocate);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}
function startPolling() {
  stopPolling();
  const sec = settings.pollInterval;
  if (sec && sec > 0) {
    pollTimer = setInterval(pollStatus, Math.max(3, sec) * 1000);
  }
}

// ---------- Candidates ----------
function isConnected(target: string): boolean {
  return devices.some(
    (d) => d.connect_key === target && /connected/i.test(d.status)
  );
}

function renderCandidates() {
  const list = $("#found-list");
  $("#found-count").textContent = String(candidates.length);
  if (candidates.length === 0) {
    list.innerHTML = `<div class="empty">${esc(scanning ? t("found.scanning") : t("found.empty"))}</div>`;
    return;
  }
  list.innerHTML = candidates
    .map((c) => {
      const connected = isConnected(c.target);
      const note = noteForKey(c.target);
      const mac = arpMap[c.ip];
      const rec = mac ? book["mac:" + mac] : undefined;
      const isLastGood = rec?.lastPort === c.port;
      const action = connected
        ? `<span class="badge badge-on">${esc(t("found.connectedBadge"))}</span>`
        : `<button class="btn btn-primary btn-sm" data-act="connect" data-target="${esc(
            c.target
          )}">${esc(t("btn.connect"))}</button>`;
      const sub = [
        `<span class="badge badge-tcp">${esc(t("found.badgeOpen"))}</span>`,
        isLastGood ? `<span class="badge badge-star">${esc(t("found.badgeLastGood"))}</span>` : "",
        note ? `<span class="muted">📝 ${esc(note)}</span>` : "",
      ]
        .filter(Boolean)
        .join("");
      return `
      <div class="row-item">
        <div class="dev-icon">📡</div>
        <div class="dev-main">
          <div class="dev-key">${esc(c.target)}</div>
          <div class="dev-sub">${sub}</div>
        </div>
        <div class="dev-actions">${action}</div>
      </div>`;
    })
    .join("");
}

// ---------- Actions ----------
async function connectTarget(target: string, silent = false) {
  try {
    log("cmd", `hdc tconn ${target}`);
    const out = await invoke<CmdOutput>("connect_device", {
      hdcPath: hdcPathArg(),
      target,
      timeoutMs: settings.connectTimeout,
    });
    log("cmd", `  ↳ ${(out.stdout || out.stderr || t("log.noOutput")).trim()}`);
    // Verify the REAL status — an open port isn't always a working hdc device.
    const devs = await invoke<Device[]>("list_devices", { hdcPath: hdcPathArg() });
    const dev = devs.find((d) => d.connect_key === target);
    const s = (dev?.status || "").toLowerCase();
    if (/connected|ready/.test(s)) {
      if (!silent) toast(t("toast.connected", { target }), "ok");
    } else if (/unauth|authing/.test(s)) {
      if (!silent) toast(t("toast.needAuth", { target }), "info");
    } else {
      // dead / non-hdc port — clean it up so it doesn't linger as Offline
      await invoke<CmdOutput>("disconnect_device", {
        hdcPath: hdcPathArg(),
        target,
      }).catch(() => {});
      if (!silent)
        toast(
          t("toast.connectFailNotReady", {
            target,
            status: dev?.status || t("status.noResponse"),
          }),
          "err"
        );
    }
    await refreshDevices();
  } catch (e) {
    if (!silent) toast(t("toast.connectFail", { e: String(e) }), "err");
  }
}

async function disconnectTarget(target: string) {
  try {
    const out = await invoke<CmdOutput>("disconnect_device", {
      hdcPath: hdcPathArg(),
      target,
    });
    toast(t("toast.disconnected", { target }), out.success ? "ok" : "info");
    await refreshDevices();
    // Re-probe immediately: a manual disconnect just moved this device to
    // history, so refresh its online state now instead of waiting for the poll.
    await probeHistory();
  } catch (e) {
    toast(t("toast.disconnectFail", { e: String(e) }), "err");
  }
}

/** Try `hdc tconn`, verify via list targets, clean up dead ports. Returns true
 *  if this is the hdc port (Connected, or Unauth = real device needing auth). */
async function tryConnectQuiet(target: string): Promise<boolean> {
  try {
    log("cmd", `hdc tconn ${target} ${t("log.auto")}`);
    const out = await invoke<CmdOutput>("connect_device", {
      hdcPath: hdcPathArg(),
      target,
      timeoutMs: settings.connectTimeout,
    });
    const devs = await invoke<Device[]>("list_devices", { hdcPath: hdcPathArg() });
    const dev = devs.find((d) => d.connect_key === target);
    const s = (dev?.status || "").toLowerCase();
    log("cmd", `  ↳ ${(out.stdout || out.stderr || "").trim()} [${t("log.statusTag")}: ${dev?.status || t("log.none")}]`);
    if (/connected|unauth|authing/.test(s)) return true; // real hdc port
    await invoke<CmdOutput>("disconnect_device", {
      hdcPath: hdcPathArg(),
      target,
    }).catch(() => {});
    return false;
  } catch (_) {
    return false;
  }
}

/** After a scan, auto-try hdc connect on candidates (one success per IP). */
async function autoConnectCandidates() {
  if (candidates.length === 0) return;
  const byIp = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!byIp.has(c.ip)) byIp.set(c.ip, []);
    byIp.get(c.ip)!.push(c);
  }
  let connected = 0;
  const txt = $("#scan-progress-text");
  $("#scan-progress-wrap").classList.remove("hidden");
  for (const [ip, list] of byIp) {
    if (stopRequested) break;
    if (
      devices.some((d) => d.connect_key.startsWith(ip + ":") && /connected/i.test(d.status))
    ) {
      continue;
    }
    // Prioritize the port that last gave a real Connected for this device (by MAC).
    const mac = arpMap[ip];
    const preferred = mac ? book["mac:" + mac]?.lastPort : undefined;
    if (preferred) {
      list.sort((a, b) => (b.port === preferred ? 1 : 0) - (a.port === preferred ? 1 : 0));
      if (list[0]?.port === preferred) log("info", t("log.preferPort", { ip, port: preferred }));
    }
    let i = 0;
    for (const c of list) {
      if (stopRequested) break;
      i++;
      txt.textContent = t("progress.autoConnect", { target: c.target, i, n: list.length });
      if (await tryConnectQuiet(c.target)) {
        connected++;
        break; // found this IP's hdc port; skip its other ports
      }
    }
  }
  await refreshDevices();
  if (connected > 0) toast(t("toast.autoConnected", { n: connected }), "ok");
  else toast(t("toast.autoConnectNone"), "info");
}

async function restartHdc() {
  if (!confirm(t("confirm.restartHdc"))) return;
  log("cmd", `hdc kill -r ${t("log.restartHdc")}`);
  try {
    await invoke<string>("restart_hdc", { hdcPath: hdcPathArg() });
    toast(t("toast.hdcRestarted"), "ok");
    setTimeout(refreshDevices, 1000);
  } catch (e) {
    toast(t("toast.restartFail", { e: String(e) }), "err");
  }
}

async function enableWireless(connectKey: string) {
  const ok = confirm(
    t("confirm.enableWireless", { key: connectKey, port: settings.wirelessPort })
  );
  if (!ok) return;
  try {
    const out = await invoke<CmdOutput>("enable_wireless", {
      hdcPath: hdcPathArg(),
      connectKey,
      port: settings.wirelessPort,
    });
    toast(out.stdout || out.stderr || t("toast.wirelessSent"), "info");
    setTimeout(refreshDevices, 1500);
  } catch (e) {
    toast(t("toast.wirelessFail", { e: String(e) }), "err");
  }
}

// ---------- Discover (hdc native broadcast) ----------
const RECOMMENDED_RANGE = "32768-60999";

function hideBanner() {
  $("#discover-banner").classList.add("hidden");
}
function showBanner(kind: "firewall" | "broadcast") {
  const text = $("#discover-banner-text");
  const action = $<HTMLButtonElement>("#btn-banner-action");
  if (kind === "firewall") {
    text.innerHTML = t("banner.firewall");
    action.textContent = t("btn.addFirewall");
    action.onclick = addFirewallRule;
  } else {
    text.innerHTML = t("banner.broadcast");
    action.textContent = t("btn.switchToScan");
    action.onclick = () => {
      ($("#ports-input") as HTMLInputElement).value = RECOMMENDED_RANGE;
      ($("#target-input") as HTMLInputElement).focus();
      hideBanner();
      toast(t("toast.filledRange"), "info");
    };
  }
  $("#discover-banner").classList.remove("hidden");
}

async function discoverDevices() {
  if (scanning) return;
  const btn = $<HTMLButtonElement>("#btn-discover");
  btn.disabled = true;
  const label = btn.querySelector(".btn-label")!;
  label.innerHTML = `<span class="spin"></span>${esc(t("progress.discovering"))}`;
  hideBanner();
  log("cmd", `hdc discover ${t("log.discover")}`);
  try {
    const res = await invoke<DiscoverResult>("discover_devices", {
      hdcPath: hdcPathArg(),
    });
    if (res.targets.length > 0) {
      // Merge discovered targets into the candidate list.
      const set = new Map(candidates.map((c) => [c.target, c]));
      for (const t of res.targets) {
        const [ip, portStr] = t.split(":");
        set.set(t, { ip, port: parseInt(portStr, 10) || 0, target: t });
      }
      candidates = [...set.values()];
      renderCandidates();
      toast(t("toast.discovered", { n: res.targets.length }), "ok");
    } else {
      // hdc always prints the firewall reminder, so decide via the real rule state.
      const hasRule = await invoke<boolean>("firewall_rule_exists").catch(() => false);
      showBanner(hasRule ? "broadcast" : "firewall");
      toast(t("toast.discoverNone"), "info");
    }
  } catch (e) {
    toast(t("toast.discoverFail", { e: String(e) }), "err");
  } finally {
    btn.disabled = false;
    label.textContent = t("btn.discover");
  }
}

async function addFirewallRule() {
  const btn = $<HTMLButtonElement>("#btn-banner-action");
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = t("btn.uacConfirm");
  try {
    await invoke<string>("add_firewall_rule");
    toast(t("toast.firewallAdded"), "ok");
    hideBanner();
    setTimeout(discoverDevices, 600); // retry discovery
  } catch (e) {
    toast(String(e), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = prev || t("btn.addFirewall");
  }
}

// ---------- LAN host discovery ----------
function renderHosts() {
  const list = $("#host-list");
  const onlyMobile = ($("#only-mobile") as HTMLInputElement).checked;
  const shown = onlyMobile ? hosts.filter((h) => h.likely_mobile) : hosts;
  $("#host-count").textContent = String(shown.length);
  if (shown.length === 0) {
    list.innerHTML = `<div class="empty">${esc(
      hosts.length === 0 ? t("host.empty") : t("host.emptyNoMobile")
    )}</div>`;
    return;
  }
  list.innerHTML = shown
    .map((h) => {
      const rec = book["mac:" + h.mac];
      const known = rec?.note || rec?.name;
      // Title priority: hdc-known name/note > scanned hostname > IP.
      const title = known || h.hostname || h.ip;
      // Show the scanned hostname as a chip unless it's already the title.
      const showHost = h.hostname && h.hostname !== title;
      const sub = [
        `<span class="badge ${h.likely_mobile ? "badge-on" : "badge-off"}">${esc(
          h.likely_mobile ? t("host.badgeMobile") : t("host.badgeNormal")
        )}</span>`,
        showHost ? `<span class="badge badge-note">🏷 ${esc(h.hostname)}</span>` : "",
        rec?.lastConnected ? `<span class="badge badge-note">${esc(t("host.badgeKnown"))}</span>` : "",
        rec?.lastPort ? `<span class="badge badge-star">${esc(t("host.badgeLastPort", { port: rec.lastPort }))}</span>` : "",
        // Show the IP whenever the title is a name (not the IP itself), so a
        // named device always exposes its address too.
        title !== h.ip ? `<span class="muted">${esc(h.ip)}</span>` : "",
        `<span class="muted">${esc(h.mac)}</span>`,
        rec?.name && rec?.note ? `<span class="muted">${esc(rec.name)}</span>` : "",
      ]
        .filter(Boolean)
        .join("");
      return `
      <div class="row-item host-row" data-act="host-connect" data-ip="${esc(h.ip)}">
        <div class="dev-icon">${h.likely_mobile ? "📱" : "🖥"}</div>
        <div class="dev-main">
          <div class="dev-key">${esc(title)}</div>
          <div class="dev-sub">${sub}</div>
        </div>
        <div class="dev-actions">
          <button class="btn btn-primary btn-sm" data-act="host-connect" data-ip="${esc(h.ip)}">${esc(t("btn.connect"))}</button>
          <button class="btn btn-ghost btn-sm" data-act="deepscan" data-ip="${esc(h.ip)}">${esc(t("btn.deepScanPort"))}</button>
        </div>
      </div>`;
    })
    .join("");
}

async function discoverHosts() {
  if (scanning || scanAllRunning) return;
  const sub = selectedSubnet();
  if (!sub) {
    toast(t("toast.selectIface"), "err");
    return;
  }
  const btn = $<HTMLButtonElement>("#btn-host-scan");
  btn.disabled = true;
  const label = btn.querySelector(".btn-label")!;
  label.innerHTML = `<span class="spin"></span>${esc(t("progress.scanning"))}`;
  try {
    hosts = await invoke<HostInfo[]>("discover_hosts", {
      network: sub.network,
      prefix: sub.prefix,
    });
    renderHosts();
    const mobile = hosts.filter((h) => h.likely_mobile).length;
    toast(t("toast.hostScanResult", { n: hosts.length, mobile }), "ok");
    // Diagnostic: how many devices announced a resolvable name (mDNS/DNS/NetBIOS).
    const named = hosts.filter((h) => h.hostname);
    log(
      "info",
      t("log.nameResolve", { named: named.length, total: hosts.length }) +
        (named.length ? ` [${named.map((h) => `${h.ip}=${h.hostname}`).join(", ")}]` : t("log.nameResolveNone"))
    );
  } catch (e) {
    toast(t("toast.hostScanFail", { e: String(e) }), "err");
  } finally {
    btn.disabled = false;
    label.textContent = t("btn.hostScan");
  }
}

function deepScanHost(ip: string) {
  if (scanning || scanAllRunning) {
    toast(t("toast.scanningWait"), "info");
    return;
  }
  ($("#target-input") as HTMLInputElement).value = ip;
  ($("#ports-input") as HTMLInputElement).value = RECOMMENDED_RANGE;
  $("#found-list").scrollIntoView({ behavior: "smooth", block: "nearest" });
  doScan();
}

async function scanAll() {
  // Toggle off if already running.
  if (scanAllRunning) {
    scanAllAbort = true;
    stopRequested = true;
    invoke("cancel_scan").catch(() => {});
    toast(t("toast.stopRequested"), "info");
    return;
  }
  if (scanning) return;
  const sub = selectedSubnet();
  if (!sub) {
    toast(t("toast.selectIface"), "err");
    return;
  }
  const targets = hosts.filter((h) => h.likely_mobile);
  if (targets.length === 0) {
    toast(t("toast.noMobileScanFirst"), "err");
    return;
  }

  scanAllRunning = true;
  scanAllAbort = false;
  stopRequested = false;
  scanning = true;
  candidates = [];
  renderCandidates();
  const btn = $<HTMLButtonElement>("#btn-scan-all");
  btn.textContent = t("btn.stop");
  btn.classList.add("btn-danger");
  const wrap = $("#host-progress");
  wrap.classList.remove("hidden");

  let i = 0;
  for (const h of targets) {
    if (scanAllAbort) break;
    i++;
    $("#host-bar").style.width = Math.round((i / targets.length) * 100) + "%";
    $("#host-progress-text").textContent = t("progress.deepScan", {
      ip: h.ip,
      i,
      n: targets.length,
      found: candidates.length,
    });
    try {
      const found = await invoke<Candidate[]>("start_scan", {
        network: sub.network,
        prefix: sub.prefix,
        portSpec: RECOMMENDED_RANGE,
        timeoutMs: settings.timeout,
        concurrency: settings.concurrency,
        targetIp: h.ip,
      });
      const set = new Map(candidates.map((c) => [c.target, c]));
      for (const c of found) set.set(c.target, c);
      candidates = [...set.values()];
      renderCandidates();
    } catch (_) {
      /* skip host on error */
    }
  }

  $("#host-bar").style.width = "100%";
  if (!scanAllAbort && candidates.length > 0) {
    $("#host-progress-text").textContent = t("progress.autoConnecting");
    await autoConnectCandidates();
  } else {
    await refreshDevices();
  }
  scanning = false;
  scanAllRunning = false;
  btn.textContent = t("btn.scanAll");
  btn.classList.remove("btn-danger");
  setTimeout(() => wrap.classList.add("hidden"), 1000);
  toast(
    scanAllAbort
      ? t("toast.deepScanStopped", { n: candidates.length })
      : t("toast.deepScanDone", { n: candidates.length }),
    "ok"
  );
}

// ---------- Scan (TCP port range) ----------
async function doScan() {
  if (scanning) return;
  const sel = $<HTMLSelectElement>("#iface-select");
  const opt = sel.selectedOptions[0];
  const network = opt?.dataset.network;
  const prefix = opt?.dataset.prefix;
  if (!network || !prefix) {
    toast(t("toast.selectIface"), "err");
    return;
  }
  let portSpec = ($("#ports-input") as HTMLInputElement).value.trim() || settings.ports;
  const targetIp = ($("#target-input") as HTMLInputElement).value.trim() || null;

  // Targeted deep scan: if the port spec is just a port or two (e.g. the default),
  // the user almost certainly wants to find the unknown random port — use the range.
  if (targetIp && !portSpec.includes("-")) {
    const list = portSpec.split(/[,，\s]+/).filter(Boolean);
    if (list.length <= 2) {
      portSpec = RECOMMENDED_RANGE;
      toast(t("toast.targetDeepScan", { range: RECOMMENDED_RANGE }), "info");
    }
  }

  scanning = true;
  stopRequested = false;
  candidates = [];
  const btn = $<HTMLButtonElement>("#btn-scan");
  btn.disabled = true;
  $<HTMLButtonElement>("#btn-discover").disabled = true;
  btn.querySelector(".btn-label")!.innerHTML = `<span class="spin"></span>${esc(t("progress.scanning"))}`;
  const wrap = $("#scan-progress-wrap");
  wrap.classList.remove("hidden");
  $("#scan-bar").style.width = "0%";
  $("#scan-progress-text").textContent = t("progress.preparing");
  renderCandidates();

  log(
    "cmd",
    t("log.portScan", {
      scope: targetIp ? t("log.scopeTarget", { ip: targetIp }) : `${network}/${prefix}`,
      ports: portSpec,
    })
  );
  try {
    candidates = await invoke<Candidate[]>("start_scan", {
      network,
      prefix: parseInt(prefix, 10),
      portSpec,
      timeoutMs: settings.timeout,
      concurrency: settings.concurrency,
      targetIp,
    });
    await refreshDevices(); // also re-renders candidates
    if (stopRequested) {
      toast(t("toast.scanStopped", { n: candidates.length }), "info");
    } else {
      toast(t("toast.scanDone", { n: candidates.length }), "ok");
      await autoConnectCandidates();
    }
  } catch (e) {
    toast(t("toast.scanFail", { e: String(e) }), "err");
  } finally {
    scanning = false;
    btn.disabled = false;
    $<HTMLButtonElement>("#btn-discover").disabled = false;
    btn.querySelector(".btn-label")!.textContent = t("btn.scan");
    setTimeout(() => wrap.classList.add("hidden"), 1200);
  }
}

// ---------- Settings modal ----------
function openSettings() {
  ($("#set-hdc-path") as HTMLInputElement).value = settings.hdcPath;
  ($("#set-ports") as HTMLInputElement).value = settings.ports;
  ($("#set-wireless-port") as HTMLInputElement).value = String(settings.wirelessPort);
  ($("#set-timeout") as HTMLInputElement).value = String(settings.timeout);
  ($("#set-concurrency") as HTMLInputElement).value = String(settings.concurrency);
  ($("#set-poll") as HTMLInputElement).value = String(settings.pollInterval);
  ($("#set-connect-timeout") as HTMLInputElement).value = String(settings.connectTimeout);
  ($("#set-auto-relocate") as HTMLInputElement).checked = settings.autoRelocate;
  void loadHdcPicker();
  void refreshPathHdc();
  // Reflect the live autostart state (registry is the source of truth).
  invoke<boolean>("get_autostart")
    .then((on) => {
      ($("#set-autostart") as HTMLInputElement).checked = on;
    })
    .catch(() => {});
  $("#settings-modal").classList.remove("hidden");
}
function closeSettings() {
  $("#settings-modal").classList.add("hidden");
}
function applySettings() {
  settings = {
    hdcPath: ($("#set-hdc-path") as HTMLInputElement).value.trim(),
    ports: ($("#set-ports") as HTMLInputElement).value.trim() || DEFAULTS.ports,
    wirelessPort:
      parseInt(($("#set-wireless-port") as HTMLInputElement).value, 10) ||
      DEFAULTS.wirelessPort,
    timeout: parseInt(($("#set-timeout") as HTMLInputElement).value, 10) || DEFAULTS.timeout,
    concurrency:
      parseInt(($("#set-concurrency") as HTMLInputElement).value, 10) ||
      DEFAULTS.concurrency,
    pollInterval: (() => {
      const v = parseInt(($("#set-poll") as HTMLInputElement).value, 10);
      return Number.isFinite(v) && v >= 0 ? v : DEFAULTS.pollInterval;
    })(),
    connectTimeout:
      parseInt(($("#set-connect-timeout") as HTMLInputElement).value, 10) ||
      DEFAULTS.connectTimeout,
    autoRelocate: ($("#set-auto-relocate") as HTMLInputElement).checked,
    theme: settings.theme, // theme is applied live via the picker, not the form
    lang: settings.lang, // language is applied live via the picker, not the form
  };
  saveSettings(settings);
  ($("#ports-input") as HTMLInputElement).value = settings.ports;
  // Apply launch-on-startup (registry write; no elevation needed).
  const autostart = ($("#set-autostart") as HTMLInputElement).checked;
  invoke("set_autostart", { enabled: autostart })
    .then(() => log("ok", t("log.autostartSet", { state: autostart ? t("status.on") : t("status.off") })))
    .catch((e) => toast(t("toast.autostartFail", { e: String(e) }), "err"));
  closeSettings();
  detectHdc();
  startPolling();
  toast(t("toast.settingsSaved"), "ok");
}

// ---------- Wire up ----------
function bindEvents() {
  $("#btn-discover").addEventListener("click", discoverDevices);
  $("#btn-scan").addEventListener("click", doScan);
  $("#btn-stop-scan").addEventListener("click", stopScan);
  $("#btn-refresh").addEventListener("click", refreshDevices);
  $("#btn-host-scan").addEventListener("click", discoverHosts);
  $("#btn-scan-all").addEventListener("click", scanAll);
  $("#only-mobile").addEventListener("change", renderHosts);
  // "Refresh all": online status, plus a subnet sweep to find devices that moved.
  $("#btn-history-refresh").addEventListener("click", () => {
    toast(t("toast.refreshingOnline"), "info");
    pollStatus({ sweep: true, force: true });
  });
  $("#btn-device-refresh").addEventListener("click", async () => {
    toast(t("toast.refreshingDevices"), "info");
    await refreshDevices();
    await probeHistory();
  });
  $("#btn-restart-hdc").addEventListener("click", restartHdc);
  $("#btn-connect-manual").addEventListener("click", () => {
    const input = $("#manual-input") as HTMLInputElement;
    const val = input.value.trim();
    if (!val) {
      toast(t("toast.enterIpPort"), "err");
      return;
    }
    connectTarget(val.includes(":") ? val : `${val}:${settings.wirelessPort}`);
    input.value = "";
  });
  $("#manual-input").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") $("#btn-connect-manual").click();
  });

  $("#btn-log").addEventListener("click", openLog);
  $("#btn-log-close").addEventListener("click", closeLog);
  $("#btn-log-clear").addEventListener("click", () => {
    logs.length = 0;
    renderLogs();
  });
  $("#btn-log-copy").addEventListener("click", async () => {
    const text = logs.map((e) => `${ts(e.t)} [${e.level}] ${e.msg}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast(t("toast.logCopied"), "ok");
    } catch (_) {
      toast(t("toast.logCopyFail"), "err");
    }
  });
  $("#log-modal").addEventListener("click", (e) => {
    if (e.target === $("#log-modal")) closeLog();
  });

  $("#dm-close").addEventListener("click", closeDeviceModal);
  $("#dm-connect").addEventListener("click", dmPrimary);
  $("#dm-save").addEventListener("click", () => dmSaveNote());
  $("#dm-delete").addEventListener("click", dmDelete);
  $("#dm-relocate").addEventListener("click", () => {
    const id = dmCtx?.bookId;
    closeDeviceModal();
    if (id) void relocateOne(id);
  });
  $("#device-modal").addEventListener("click", (e) => {
    if (e.target === $("#device-modal")) closeDeviceModal();
  });
  $("#dm-port").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") dmPrimary();
  });

  $("#btn-settings").addEventListener("click", openSettings);
  // Topbar theme popover.
  $("#btn-theme").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#theme-pop").classList.toggle("hidden");
  });
  // Theme picker (topbar popover + settings) — apply & persist instantly.
  document.addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest("[data-theme-id]") as HTMLElement | null;
    if (card) {
      applyTheme(card.dataset.themeId!);
      saveSettings(settings);
      $("#theme-pop").classList.add("hidden");
      return;
    }
    // Click outside the popover closes it.
    const pop = $("#theme-pop");
    if (!pop.classList.contains("hidden") && !(e.target as HTMLElement).closest(".pop-wrap")) {
      pop.classList.add("hidden");
    }
  });
  $("#btn-settings-close").addEventListener("click", closeSettings);
  $("#btn-settings-save").addEventListener("click", applySettings);
  $("#btn-redetect").addEventListener("click", async () => {
    await loadHdcPicker(true); // re-scan SDKs (resets the auto pick) …
    await detectHdc(); // … then show what is used now
    await refreshPathHdc();
  });
  $("#set-hdc-pick").addEventListener("change", (e) => {
    ($("#set-hdc-path") as HTMLInputElement).value = (e.target as HTMLSelectElement).value;
  });
  $("#btn-update-path").addEventListener("click", updatePathHdc);
  $("#settings-modal").addEventListener("click", (e) => {
    if (e.target === $("#settings-modal")) closeSettings();
  });

  // Event delegation for dynamic device/candidate buttons.
  document.body.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "connect") connectTarget(btn.dataset.target!);
    else if (act === "disconnect") disconnectTarget(btn.dataset.key!);
    else if (act === "wireless") enableWireless(btn.dataset.key!);
    else if (act === "deepscan") deepScanHost(btn.dataset.ip!);
    else if (act === "note") editNote(btn.dataset.id!);
    else if (act === "forget") forgetDevice(btn.dataset.id!);
    else if (act === "detail") openHistoryDetail(btn.dataset.id!);
    else if (act === "detail-connected") openConnectedDetail(btn.dataset.key!);
    else if (act === "host-connect") openHostConnect(btn.dataset.ip!);
  });
}

async function bindBackendEvents() {
  await listen<ScanProgress>("scan-progress", (e) => {
    const { phase, scanned, total, found } = e.payload;
    const pct = total > 0 ? Math.round((scanned / total) * 100) : 0;
    $("#scan-bar").style.width = pct + "%";
    $("#scan-progress-text").textContent = t("progress.scanProgress", { phase, scanned, total, found });
  });
  await listen<Candidate>("scan-found", (e) => {
    if (!candidates.some((c) => c.target === e.payload.target)) {
      candidates.push(e.payload);
      renderCandidates();
    }
  });
  await listen("tray-scan", () => discoverDevices());
  // Tray toggled launch-on-startup — keep the settings checkbox + log in sync.
  await listen<boolean>("autostart-changed", (e) => {
    const el = $("#set-autostart") as HTMLInputElement | null;
    if (el) el.checked = e.payload;
    toast(t("toast.autostartTray", { state: e.payload ? t("status.on") : t("status.off") }), "ok");
  });
}

// ---------- Language ----------
/** Keep the Settings language dropdown showing the active language. */
function syncLangSelectors() {
  const sel = document.querySelector<HTMLSelectElement>("#set-lang");
  if (sel) sel.value = settings.lang;
}
/** Fill the Settings language dropdown and wire its change handler. */
function setupLanguagePickers() {
  const sel = document.querySelector<HTMLSelectElement>("#set-lang");
  if (!sel) return;
  sel.innerHTML = LANGS.map((l) => `<option value="${l.id}">${esc(l.label)}</option>`).join("");
  sel.value = settings.lang;
  sel.addEventListener("change", () => changeLanguage(sel.value as Lang));
}
/** Switch the active language and re-render everything (static + dynamic). */
async function changeLanguage(l: Lang) {
  if (!isLang(l)) return;
  setLang(l);
  settings.lang = l;
  saveSettings(settings);
  syncLangSelectors();
  applyStaticTranslations(); // labels, buttons, placeholders, titles, document.title
  // Re-render dynamic content that was generated through t().
  renderThemePickers();
  renderDevices(); // also re-renders history
  renderCandidates();
  renderHosts();
  // Rebuild interface option labels, preserving the current selection.
  const sub = selectedSubnet();
  await loadInterfaces();
  if (sub) {
    const sel = $<HTMLSelectElement>("#iface-select");
    const match = Array.from(sel.options).find(
      (o) => o.dataset.network === sub.network && o.dataset.prefix === String(sub.prefix)
    );
    if (match) match.selected = true;
  }
  detectHdc(); // re-localize the hdc status pill/detail
}

async function init() {
  loadBook();
  setLang(settings.lang);
  applyStaticTranslations();
  setupLanguagePickers();
  log("info", t("log.appStart"));
  applyTheme(settings.theme); // sync theme + render picker grid
  ($("#ports-input") as HTMLInputElement).value = settings.ports;
  bindEvents();
  await bindBackendEvents();
  await Promise.all([detectHdc(), loadInterfaces()]);
  void refreshPathHdc(true); // just a log hint if the terminal PATH lags the newest SDK
  await refreshDevices();
  await cleanupDeadTcp(); // remove lingering Offline TCP connections
  await probeHistory();
  startPolling();
  // One sweep shortly after launch. At login the real NIC may come up after us,
  // so re-read the interfaces first (keeps the user's pick if it still exists).
  setTimeout(async () => {
    if (!settings.autoRelocate) return;
    await loadInterfaces();
    await relocateMovedDevices(currentIdSet(), { sweep: true });
  }, STARTUP_SWEEP_DELAY_MS);
}

window.addEventListener("DOMContentLoaded", init);
