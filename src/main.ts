import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------- Types (match Rust serde structs; returns are snake_case) ----------
interface HdcInfo {
  path: string;
  version: string;
  server_port: string | null;
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
  theme: string;
}
const DEFAULTS: Settings = {
  hdcPath: "",
  ports: "10178",
  wirelessPort: 10178,
  timeout: 400,
  concurrency: 256,
  pollInterval: 10,
  connectTimeout: 2000,
  theme: "eclipse",
};

// ---------- Themes ----------
interface ThemeDef {
  id: string;
  name: string;
  tag: string;
  swatch: [string, string, string]; // [bg, surface, accent]
}
const THEMES: ThemeDef[] = [
  { id: "eclipse", name: "暗夜", tag: "深色 · 靛蓝", swatch: ["#0a0b10", "#191c26", "#6366f1"] },
  { id: "carbon", name: "碳黑", tag: "深色 · 天青", swatch: ["#0b0c0e", "#1a1d21", "#38bdf8"] },
  { id: "daybreak", name: "晨曦", tag: "浅色 · 靛蓝", swatch: ["#f5f6f9", "#ffffff", "#6366f1"] },
  { id: "mist", name: "薄雾", tag: "浅色 · 青碧", swatch: ["#f2f6f5", "#ffffff", "#0d9488"] },
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
    (t) => `
    <button type="button" class="theme-card${t.id === settings.theme ? " active" : ""}" data-theme-id="${t.id}">
      <div class="theme-swatch" style="background:${t.swatch[0]}">
        <i style="background:${t.swatch[1]}"></i>
        <i class="s-accent" style="background:${t.swatch[2]}"></i>
      </div>
      <div class="theme-name">${t.name}</div>
      <div class="theme-tag">${t.tag}</div>
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
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) {
    /* ignore */
  }
  return { ...DEFAULTS };
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
    box.innerHTML = `<div class="empty">暂无日志。</div>`;
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
  $("#scan-progress-text").textContent = "正在停止…";
  try {
    await invoke("cancel_scan");
  } catch (_) {
    /* ignore */
  }
  toast("已请求停止扫描", "info");
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
  text.textContent = "检测 hdc 中…";
  try {
    const info = await invoke<HdcInfo>("detect_hdc", { hdcPath: hdcPathArg() });
    log("ok", `检测到 hdc ${info.version} @ ${info.path}（HDC_SERVER_PORT=${info.server_port ?? "未设"}）`);
    pill.className = "hdc-pill pill-ok";
    text.textContent = `hdc ${info.version}`;
    pill.title = info.path;
    detail.innerHTML =
      `<b>路径:</b> ${esc(info.path)}<br/>` +
      `<b>版本:</b> ${esc(info.version)}<br/>` +
      `<b>HDC_SERVER_PORT:</b> ${esc(info.server_port ?? "（未设置）")}`;
  } catch (e) {
    pill.className = "hdc-pill pill-err";
    text.textContent = "未找到 hdc";
    detail.innerHTML = `<span style="color:var(--red)">${esc(String(e))}</span>`;
  }
}

// ---------- Interfaces ----------
async function loadInterfaces() {
  const sel = $<HTMLSelectElement>("#iface-select");
  sel.innerHTML = "";
  try {
    const ifaces = await invoke<NetIface[]>("get_interfaces");
    if (ifaces.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "未检测到可用网卡";
      sel.appendChild(opt);
      return;
    }
    for (const f of ifaces) {
      const opt = document.createElement("option");
      opt.dataset.network = f.network;
      opt.dataset.prefix = String(f.prefix);
      const tag = f.is_private ? "" : " ⚠";
      opt.textContent = `${f.name} · ${f.ip}/${f.prefix}（${f.usable_hosts} 台）${tag}`;
      sel.appendChild(opt);
    }
  } catch (e) {
    toast("获取网卡失败: " + e, "err");
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
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
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
    list.innerHTML = `<div class="empty">暂无在连设备。扫描端口后会自动尝试连接。</div>`;
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
          ? `<button class="btn btn-danger btn-sm" data-act="disconnect" data-key="${esc(d.connect_key)}">断开</button>
             <span class="row-chev">›</span>`
          : `<button class="btn btn-ghost btn-sm" data-act="note" data-id="${esc(id.id)}">备注</button>
             <button class="btn btn-ghost btn-sm" data-act="wireless" data-key="${esc(d.connect_key)}">开启无线</button>`;
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
    list.innerHTML = `<div class="empty">暂无历史设备。</div>`;
    return;
  }
  list.innerHTML = items
    .map((r) => {
      const title = r.note || r.name || r.lastTarget || r.lastKey || r.id;
      const online = isHistoryOnline(r);
      const statusBadge = r.lastTarget
        ? online
          ? `<span class="badge badge-on">🟢 在线 · 可连接</span>`
          : `<span class="badge badge-off">⚪ 离线</span>`
        : "";
      const sub = [
        statusBadge,
        r.lastTarget ? `<span class="muted">${esc(r.lastTarget)}</span>` : "",
        r.name && r.note ? `<span class="muted">${esc(r.name)}</span>` : "",
        r.mac ? `<span class="muted">${esc(r.mac)}</span>` : "",
        r.lastConnected ? `<span class="muted">上次 ${timeAgo(r.lastConnected)}</span>` : "",
      ]
        .filter(Boolean)
        .join("");
      const connectBtn = r.lastTarget
        ? `<button class="btn ${online ? "btn-primary" : "btn-ghost"} btn-sm" data-act="connect" data-target="${esc(
            r.lastTarget
          )}">连接</button>`
        : "";
      return `
      <div class="row-item host-row" data-act="detail" data-id="${esc(r.id)}">
        <div class="dev-icon">🕘</div>
        <div class="dev-main">
          <div class="dev-key">${esc(title)}</div>
          <div class="dev-sub">${sub || '<span class="muted">无记录</span>'}</div>
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
  const v = prompt("设备备注（绑定 MAC，IP 变了也不丢）：", cur);
  if (v === null) return;
  if (!book[id]) book[id] = { id, kind: "UNKNOWN", lastConnected: 0 };
  book[id].note = v.trim();
  saveBook();
  renderDevices();
  renderCandidates();
  toast("备注已保存", "ok");
}
function forgetDevice(id: string) {
  if (!book[id]) return;
  if (!confirm("从历史中删除该设备记录？（备注也会一并删除）")) return;
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
  $("#dm-title").textContent = ctx.title || ctx.note || ctx.name || ctx.ip || "设备详情";
  $("#dm-name").textContent = ctx.name || "（未知，连接成功后自动获取）";
  ($("#dm-ip") as HTMLInputElement).value = ctx.ip || "";
  ($("#dm-port") as HTMLInputElement).value = ctx.port != null ? String(ctx.port) : "";
  $("#dm-mac").textContent = ctx.mac || "（未知）";
  ($("#dm-note") as HTMLInputElement).value = ctx.note || "";
  $("#dm-extra").textContent = ctx.extra || "";
  // Delete only makes sense for a saved history record.
  ($("#dm-delete") as HTMLElement).style.display = ctx.mode === "history" ? "" : "none";
  // Connected devices get 断开 (red); history/host get 连接 (blue).
  const primary = $("#dm-connect") as HTMLButtonElement;
  const connected = ctx.mode === "connected";
  primary.textContent = connected ? "断开" : "连接";
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
  if (!silent) toast("已保存", "ok");
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
    toast("请填写有效的 IP 和端口", "err");
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
    title: r.note || r.name || "历史设备",
    extra: r.lastConnected ? `上次连接：${timeAgo(r.lastConnected)}` : "",
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
    extra: rec?.lastPort ? `已自动填入上次成功端口 ${rec.lastPort}` : "端口未知？可先「深扫端口」找到它",
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
    extra: "当前已连接 · 可修改备注或断开连接",
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
    toast("获取设备列表失败: " + e, "err");
  }
}

/** Probe history devices' last ip:port to see which are online/reconnectable. */
async function probeHistory() {
  const currentIds = new Set(
    devices.filter((d) => isCurrent(d) && isManaged(d)).map((d) => identityFor(d.connect_key).id)
  );
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
      `历史在线检测：${results.length}/${targets.length} 应答` +
        (results.length ? ` [应答 ${onlineDesc}]` : "") +
        (offline.length ? ` [离线 ${offline.join(", ")}]` : "")
    );
  } catch (e) {
    onlineTargets = new Set(); // don't show stale "online" if the probe failed
    onlineMac = {};
    log("err", "历史在线检测失败: " + e);
  }
  renderHistory();
}

/** Periodic status refresh (connected list + history online check). */
async function pollStatus() {
  if (scanning || scanAllRunning) return;
  await refreshDevices();
  await probeHistory();
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
    list.innerHTML = `<div class="empty">${
      scanning ? "扫描中…" : "尚未扫描。"
    }</div>`;
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
        ? `<span class="badge badge-on">已连接</span>`
        : `<button class="btn btn-primary btn-sm" data-act="connect" data-target="${esc(
            c.target
          )}">连接</button>`;
      const sub = [
        `<span class="badge badge-tcp">端口开放</span>`,
        isLastGood ? `<span class="badge badge-star">⭐ 上次成功端口</span>` : "",
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
    log("cmd", `  ↳ ${(out.stdout || out.stderr || "(无输出)").trim()}`);
    // Verify the REAL status — an open port isn't always a working hdc device.
    const devs = await invoke<Device[]>("list_devices", { hdcPath: hdcPathArg() });
    const dev = devs.find((d) => d.connect_key === target);
    const s = (dev?.status || "").toLowerCase();
    if (/connected|ready/.test(s)) {
      if (!silent) toast(`✅ 已连接 ${target}`, "ok");
    } else if (/unauth|authing/.test(s)) {
      if (!silent)
        toast(`${target} 已连上，但设备需要授权 —— 请在设备屏幕上点「允许调试」`, "info");
    } else {
      // dead / non-hdc port — clean it up so it doesn't linger as Offline
      await invoke<CmdOutput>("disconnect_device", {
        hdcPath: hdcPathArg(),
        target,
      }).catch(() => {});
      if (!silent)
        toast(
          `连接失败 ${target}：设备未就绪（${dev?.status || "无响应"}）。该端口可能不是 hdc 调试端口，或设备未开启无线调试。`,
          "err"
        );
    }
    await refreshDevices();
  } catch (e) {
    if (!silent) toast("连接失败: " + e, "err");
  }
}

async function disconnectTarget(target: string) {
  try {
    const out = await invoke<CmdOutput>("disconnect_device", {
      hdcPath: hdcPathArg(),
      target,
    });
    toast(`已断开 ${target}`, out.success ? "ok" : "info");
    await refreshDevices();
  } catch (e) {
    toast("断开失败: " + e, "err");
  }
}

/** Try `hdc tconn`, verify via list targets, clean up dead ports. Returns true
 *  if this is the hdc port (Connected, or Unauth = real device needing auth). */
async function tryConnectQuiet(target: string): Promise<boolean> {
  try {
    log("cmd", `hdc tconn ${target} (自动)`);
    const out = await invoke<CmdOutput>("connect_device", {
      hdcPath: hdcPathArg(),
      target,
      timeoutMs: settings.connectTimeout,
    });
    const devs = await invoke<Device[]>("list_devices", { hdcPath: hdcPathArg() });
    const dev = devs.find((d) => d.connect_key === target);
    const s = (dev?.status || "").toLowerCase();
    log("cmd", `  ↳ ${(out.stdout || out.stderr || "").trim()} [状态: ${dev?.status || "无"}]`);
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
      if (list[0]?.port === preferred) log("info", `${ip}: 优先尝试上次成功端口 ${preferred}`);
    }
    let i = 0;
    for (const c of list) {
      if (stopRequested) break;
      i++;
      txt.textContent = `自动连接 ${c.target} (${i}/${list.length}) …`;
      if (await tryConnectQuiet(c.target)) {
        connected++;
        break; // found this IP's hdc port; skip its other ports
      }
    }
  }
  await refreshDevices();
  if (connected > 0) toast(`✅ 自动连接成功 ${connected} 台设备`, "ok");
  else toast("自动连接未成功，可在「扫描发现」里手动点连接", "info");
}

async function restartHdc() {
  if (
    !confirm(
      "重启 hdc 服务会断开当前所有连接（之后可从历史/扫描重连），用于清理无效/卡死的连接。确定继续？"
    )
  )
    return;
  log("cmd", "hdc kill -r (重启服务)");
  try {
    const msg = await invoke<string>("restart_hdc", { hdcPath: hdcPathArg() });
    toast(msg || "hdc 服务已重启", "ok");
    setTimeout(refreshDevices, 1000);
  } catch (e) {
    toast("重启失败: " + e, "err");
  }
}

async function enableWireless(connectKey: string) {
  const ok = confirm(
    `将设备 ${connectKey} 切换到无线(TCP)模式，端口 ${settings.wirelessPort}。\n该操作会重启设备，确定继续？`
  );
  if (!ok) return;
  try {
    const out = await invoke<CmdOutput>("enable_wireless", {
      hdcPath: hdcPathArg(),
      connectKey,
      port: settings.wirelessPort,
    });
    toast(out.stdout || out.stderr || "已发送无线模式命令，设备将重启", "info");
    setTimeout(refreshDevices, 1500);
  } catch (e) {
    toast("开启无线失败: " + e, "err");
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
    text.innerHTML =
      "⚠ 广播无应答，且未放行 <b>UDP 8710 入站</b>。放行后会自动重试。";
    action.textContent = "添加防火墙规则";
    action.onclick = addFirewallRule;
  } else {
    text.innerHTML =
      "⚠ 防火墙已放行但仍无应答 —— 此网络可能<b>不支持 UDP 广播</b>（VPN / 虚拟网卡 / 代理常见）。请改用「端口扫描」：填<b>目标 IP</b> + 端口范围。";
    action.textContent = "切到端口扫描";
    action.onclick = () => {
      ($("#ports-input") as HTMLInputElement).value = RECOMMENDED_RANGE;
      ($("#target-input") as HTMLInputElement).focus();
      hideBanner();
      toast("已填入推荐端口段，请输入目标设备 IP 后点「端口扫描」", "info");
    };
  }
  $("#discover-banner").classList.remove("hidden");
}

async function discoverDevices() {
  if (scanning) return;
  const btn = $<HTMLButtonElement>("#btn-discover");
  btn.disabled = true;
  const label = btn.querySelector(".btn-label")!;
  label.innerHTML = `<span class="spin"></span>发现中`;
  hideBanner();
  log("cmd", "hdc discover (广播发现)");
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
      toast(`广播发现 ${res.targets.length} 台设备`, "ok");
    } else {
      // hdc always prints the firewall reminder, so decide via the real rule state.
      const hasRule = await invoke<boolean>("firewall_rule_exists").catch(() => false);
      showBanner(hasRule ? "broadcast" : "firewall");
      toast("广播发现：未找到设备", "info");
    }
  } catch (e) {
    toast("广播发现失败: " + e, "err");
  } finally {
    btn.disabled = false;
    label.textContent = "📡 广播发现";
  }
}

async function addFirewallRule() {
  const btn = $<HTMLButtonElement>("#btn-banner-action");
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "请在 UAC 中确认…";
  try {
    const msg = await invoke<string>("add_firewall_rule");
    toast(msg, "ok");
    hideBanner();
    setTimeout(discoverDevices, 600); // retry discovery
  } catch (e) {
    toast("" + e, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = prev || "添加防火墙规则";
  }
}

// ---------- LAN host discovery ----------
function renderHosts() {
  const list = $("#host-list");
  const onlyMobile = ($("#only-mobile") as HTMLInputElement).checked;
  const shown = onlyMobile ? hosts.filter((h) => h.likely_mobile) : hosts;
  $("#host-count").textContent = String(shown.length);
  if (shown.length === 0) {
    list.innerHTML = `<div class="empty">${
      hosts.length === 0 ? "点击「扫描局域网设备」列出局域网内的设备。" : "没有手机/平板候选，取消勾选可查看全部设备。"
    }</div>`;
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
        `<span class="badge ${h.likely_mobile ? "badge-on" : "badge-off"}">${
          h.likely_mobile ? "手机/平板候选" : "普通设备"
        }</span>`,
        showHost ? `<span class="badge badge-note">🏷 ${esc(h.hostname)}</span>` : "",
        rec?.lastConnected ? `<span class="badge badge-note">📒 已连过</span>` : "",
        rec?.lastPort ? `<span class="badge badge-star">⭐ 上次端口 ${rec.lastPort}</span>` : "",
        known || showHost ? `<span class="muted">${esc(h.ip)}</span>` : "",
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
          <button class="btn btn-primary btn-sm" data-act="host-connect" data-ip="${esc(h.ip)}">连接</button>
          <button class="btn btn-ghost btn-sm" data-act="deepscan" data-ip="${esc(h.ip)}">深扫端口</button>
        </div>
      </div>`;
    })
    .join("");
}

async function discoverHosts() {
  if (scanning || scanAllRunning) return;
  const sub = selectedSubnet();
  if (!sub) {
    toast("请选择有效的网络接口", "err");
    return;
  }
  const btn = $<HTMLButtonElement>("#btn-host-scan");
  btn.disabled = true;
  const label = btn.querySelector(".btn-label")!;
  label.innerHTML = `<span class="spin"></span>扫描中`;
  try {
    hosts = await invoke<HostInfo[]>("discover_hosts", {
      network: sub.network,
      prefix: sub.prefix,
    });
    renderHosts();
    const mobile = hosts.filter((h) => h.likely_mobile).length;
    toast(`发现 ${hosts.length} 台设备，其中 ${mobile} 台手机/平板候选`, "ok");
    // Diagnostic: how many devices announced a resolvable name (mDNS/DNS/NetBIOS).
    const named = hosts.filter((h) => h.hostname);
    log(
      "info",
      `设备名解析：${named.length}/${hosts.length} 台拿到名称` +
        (named.length ? ` [${named.map((h) => `${h.ip}=${h.hostname}`).join(", ")}]` : "（其余设备未在网络上广播名称）")
    );
  } catch (e) {
    toast("扫描设备失败: " + e, "err");
  } finally {
    btn.disabled = false;
    label.textContent = "扫描局域网设备";
  }
}

function deepScanHost(ip: string) {
  if (scanning || scanAllRunning) {
    toast("正在扫描中，请稍候…", "info");
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
    toast("已请求停止", "info");
    return;
  }
  if (scanning) return;
  const sub = selectedSubnet();
  if (!sub) {
    toast("请选择有效的网络接口", "err");
    return;
  }
  const targets = hosts.filter((h) => h.likely_mobile);
  if (targets.length === 0) {
    toast("没有手机/平板候选，请先「扫描局域网设备」", "err");
    return;
  }

  scanAllRunning = true;
  scanAllAbort = false;
  stopRequested = false;
  scanning = true;
  candidates = [];
  renderCandidates();
  const btn = $<HTMLButtonElement>("#btn-scan-all");
  btn.textContent = "停止";
  btn.classList.add("btn-danger");
  const wrap = $("#host-progress");
  wrap.classList.remove("hidden");

  let i = 0;
  for (const h of targets) {
    if (scanAllAbort) break;
    i++;
    $("#host-bar").style.width = Math.round((i / targets.length) * 100) + "%";
    $("#host-progress-text").textContent = `深扫 ${h.ip} (${i}/${targets.length}) · 已发现 ${candidates.length}`;
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
    $("#host-progress-text").textContent = "正在自动连接发现的端口…";
    await autoConnectCandidates();
  } else {
    await refreshDevices();
  }
  scanning = false;
  scanAllRunning = false;
  btn.textContent = "深扫全部候选";
  btn.classList.remove("btn-danger");
  setTimeout(() => wrap.classList.add("hidden"), 1000);
  toast(
    scanAllAbort ? `已停止，发现 ${candidates.length} 个端口` : `深扫完成，发现 ${candidates.length} 个端口`,
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
    toast("请选择有效的网络接口", "err");
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
      toast(`目标深扫：已使用推荐端口段 ${RECOMMENDED_RANGE}`, "info");
    }
  }

  scanning = true;
  stopRequested = false;
  candidates = [];
  const btn = $<HTMLButtonElement>("#btn-scan");
  btn.disabled = true;
  $<HTMLButtonElement>("#btn-discover").disabled = true;
  btn.querySelector(".btn-label")!.innerHTML = `<span class="spin"></span>扫描中`;
  const wrap = $("#scan-progress-wrap");
  wrap.classList.remove("hidden");
  $("#scan-bar").style.width = "0%";
  $("#scan-progress-text").textContent = "准备中…";
  renderCandidates();

  log("cmd", `端口扫描 ${targetIp ? `目标 ${targetIp}` : `${network}/${prefix}`} 端口=${portSpec}`);
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
      toast(`已停止，发现 ${candidates.length} 个开放端口`, "info");
    } else {
      toast(`扫描完成，发现 ${candidates.length} 个开放端口，正在自动连接…`, "ok");
      await autoConnectCandidates();
    }
  } catch (e) {
    toast("扫描失败: " + e, "err");
  } finally {
    scanning = false;
    btn.disabled = false;
    $<HTMLButtonElement>("#btn-discover").disabled = false;
    btn.querySelector(".btn-label")!.textContent = "端口扫描";
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
    theme: settings.theme, // theme is applied live via the picker, not the form
  };
  saveSettings(settings);
  ($("#ports-input") as HTMLInputElement).value = settings.ports;
  // Apply launch-on-startup (registry write; no elevation needed).
  const autostart = ($("#set-autostart") as HTMLInputElement).checked;
  invoke("set_autostart", { enabled: autostart })
    .then(() => log("ok", `开机自启动已${autostart ? "开启" : "关闭"}`))
    .catch((e) => toast("设置开机自启动失败: " + e, "err"));
  closeSettings();
  detectHdc();
  startPolling();
  toast("设置已保存", "ok");
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
  $("#btn-history-refresh").addEventListener("click", () => {
    toast("正在刷新在线状态…", "info");
    pollStatus();
  });
  $("#btn-device-refresh").addEventListener("click", async () => {
    toast("正在刷新已连接设备…", "info");
    await refreshDevices();
    await probeHistory();
  });
  $("#btn-restart-hdc").addEventListener("click", restartHdc);
  $("#btn-connect-manual").addEventListener("click", () => {
    const input = $("#manual-input") as HTMLInputElement;
    const t = input.value.trim();
    if (!t) {
      toast("请输入 IP:端口", "err");
      return;
    }
    connectTarget(t.includes(":") ? t : `${t}:${settings.wirelessPort}`);
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
      toast("日志已复制到剪贴板", "ok");
    } catch (_) {
      toast("复制失败", "err");
    }
  });
  $("#log-modal").addEventListener("click", (e) => {
    if (e.target === $("#log-modal")) closeLog();
  });

  $("#dm-close").addEventListener("click", closeDeviceModal);
  $("#dm-connect").addEventListener("click", dmPrimary);
  $("#dm-save").addEventListener("click", () => dmSaveNote());
  $("#dm-delete").addEventListener("click", dmDelete);
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
  $("#btn-redetect").addEventListener("click", detectHdc);
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
    $("#scan-progress-text").textContent = `${phase} · ${scanned}/${total} · 发现 ${found}`;
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
    toast(`开机自启动已${e.payload ? "开启" : "关闭"}（托盘）`, "ok");
  });
}

async function init() {
  loadBook();
  log("info", "应用启动");
  applyTheme(settings.theme); // sync theme + render picker grid
  ($("#ports-input") as HTMLInputElement).value = settings.ports;
  bindEvents();
  await bindBackendEvents();
  await Promise.all([detectHdc(), loadInterfaces()]);
  await refreshDevices();
  await cleanupDeadTcp(); // remove lingering Offline TCP connections
  await probeHistory();
  startPolling();
}

window.addEventListener("DOMContentLoaded", init);
