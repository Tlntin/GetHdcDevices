//! Thin wrapper around the OpenHarmony `hdc` (HarmonyOS Device Connector) binary.
//!
//! Responsibilities:
//! * locate the `hdc` executable (explicit path > newest SDK by API level > PATH)
//! * run hdc sub-commands without flashing a console window on Windows
//! * parse `hdc list targets -v` into structured device records

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW — prevents a console window from popping up for every hdc call.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Information about the resolved hdc binary.
#[derive(Debug, Clone, Serialize)]
pub struct HdcInfo {
    pub path: String,
    pub version: String,
    /// Value of HDC_SERVER_PORT if set in the environment.
    pub server_port: Option<String>,
    /// SDK API level of this hdc (from the manifest beside it), if known.
    pub api_version: Option<u32>,
    /// True when the path came from the settings override, not auto-detection.
    pub explicit: bool,
}

/// A device as reported by `hdc list targets -v`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    /// Connect key — `ip:port` for TCP devices, serial number for USB.
    pub connect_key: String,
    /// "USB" | "TCP" | "UART" | "BT" | "UNKNOWN"
    pub conn_type: String,
    /// "Connected" | "Offline" | "Unauth" | ...
    pub status: String,
    pub raw: String,
}

/// Raw result of running an hdc command.
#[derive(Debug, Clone, Serialize)]
pub struct CmdOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

fn build_command(path: &Path) -> Command {
    let mut cmd = Command::new(path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Run hdc with the given args and capture output. Synchronous — call from a
/// blocking context (the Tauri commands wrap this in `spawn_blocking`).
pub fn run(path: &Path, args: &[&str]) -> Result<CmdOutput, String> {
    let output = build_command(path)
        .args(args)
        .output()
        .map_err(|e| format!("启动 hdc 失败 ({}): {e}", path.display()))?;
    Ok(CmdOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

/// Run hdc with a hard timeout; kills the process if it exceeds `timeout_ms`.
/// `tconn` to a non-hdc open port can block on the handshake — this guarantees
/// the call returns so the UI never stalls.
pub async fn run_timeout(path: &Path, args: &[&str], timeout_ms: u64) -> Result<CmdOutput, String> {
    let mut std_cmd = Command::new(path);
    std_cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    std_cmd.creation_flags(CREATE_NO_WINDOW);

    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 hdc 失败 ({}): {e}", path.display()))?;

    match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output()).await {
        Ok(Ok(o)) => Ok(CmdOutput {
            success: o.status.success(),
            code: o.status.code(),
            stdout: String::from_utf8_lossy(&o.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&o.stderr).trim().to_string(),
        }),
        Ok(Err(e)) => Err(format!("hdc 执行错误: {e}")),
        // Timeout: the wait future is dropped here, and kill_on_drop terminates hdc.
        Err(_) => Ok(CmdOutput {
            success: false,
            code: None,
            stdout: String::new(),
            stderr: "连接超时：该端口无 hdc 响应（可能不是 hdc 调试端口）".into(),
        }),
    }
}

pub const HDC_EXE: &str = if cfg!(windows) { "hdc.exe" } else { "hdc" };

/// One hdc binary found on this machine.
#[derive(Debug, Clone, Serialize)]
pub struct HdcCandidate {
    pub path: String,
    /// SDK API level from the `oh-uni-package.json` next to hdc (e.g. 26), if any.
    pub api_version: Option<u32>,
    /// SDK package version (e.g. "26.0.0.105").
    pub sdk_version: String,
    /// `hdc -v` (e.g. "3.2.0f"); empty if it could not be run.
    pub hdc_version: String,
    /// "DevEco Studio" | "OpenHarmony SDK" | "PATH"
    pub source: String,
}

/// SDK roots to search, each tagged with where it came from.
fn sdk_roots() -> Vec<(PathBuf, &'static str)> {
    let mut roots: Vec<(PathBuf, &'static str)> = Vec::new();
    // DevEco Studio's bundled SDK: <sdk>\<name>\openharmony\toolchains\hdc.exe
    if let Ok(p) = std::env::var("DEVECO_SDK_HOME") {
        roots.push((PathBuf::from(p), "DevEco Studio"));
    }
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(pf) = std::env::var(var) {
            let huawei = PathBuf::from(pf).join("Huawei");
            // "DevEco Studio", "DevEco Studio 5.1", … — every install dir.
            for e in std::fs::read_dir(&huawei).into_iter().flatten().flatten() {
                let name = e.file_name().to_string_lossy().to_ascii_lowercase();
                if name.starts_with("deveco") {
                    roots.push((e.path().join("sdk"), "DevEco Studio"));
                }
            }
        }
    }
    // Standalone OpenHarmony SDKs: <root>\<api>\toolchains\hdc.exe
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        roots.push((PathBuf::from(local).join("OpenHarmony").join("Sdk"), "OpenHarmony SDK"));
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        roots.push((PathBuf::from(home).join("OpenHarmony").join("Sdk"), "OpenHarmony SDK"));
    }
    for var in ["OHOS_SDK_HOME", "HOS_SDK_HOME"] {
        if let Ok(p) = std::env::var(var) {
            roots.push((PathBuf::from(p), "OpenHarmony SDK"));
        }
    }
    roots
}

/// `…/toolchains/hdc.exe` under `root`, whatever the layout: the root itself,
/// `<root>/<ver>/toolchains`, or `<root>/<ver>/openharmony/toolchains`.
fn find_in_root(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut try_dir = |d: &Path| {
        for sub in [d.join("toolchains"), d.join("openharmony").join("toolchains")] {
            let p = sub.join(HDC_EXE);
            if p.is_file() {
                out.push(p);
            }
        }
    };
    try_dir(root);
    for e in std::fs::read_dir(root).into_iter().flatten().flatten() {
        if e.path().is_dir() {
            try_dir(&e.path());
        }
    }
    out
}

/// Read apiVersion / version from the SDK package manifest beside hdc.
fn sdk_meta(hdc: &Path) -> (Option<u32>, String) {
    let Some(dir) = hdc.parent() else { return (None, String::new()) };
    for name in ["oh-uni-package.json", "uni-package.json"] {
        let Ok(text) = std::fs::read_to_string(dir.join(name)) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let api = v["apiVersion"]
            .as_str()
            .and_then(|s| s.trim().parse().ok())
            .or_else(|| v["apiVersion"].as_u64().map(|n| n as u32));
        return (api, v["version"].as_str().unwrap_or("").to_string());
    }
    (None, String::new())
}

fn hdc_version(path: &Path) -> String {
    run(path, &["-v"])
        .map(|o| o.stdout.lines().next().unwrap_or("").trim().trim_start_matches("Ver:").trim().to_string())
        .unwrap_or_default()
}

/// "3.2.0f" → comparable key ([3,2,0], "f").
fn hdc_version_key(v: &str) -> (Vec<u32>, String) {
    let digits_end = v.rfind(|c: char| c.is_ascii_digit()).map(|i| i + 1).unwrap_or(0);
    let nums = v[..digits_end].split('.').filter_map(|p| p.parse().ok()).collect();
    (nums, v[digits_end..].to_string())
}

/// Every hdc on this machine (SDK installs + PATH), newest SDK API first.
pub fn list_candidates() -> Vec<HdcCandidate> {
    let mut found: Vec<(PathBuf, &'static str)> = Vec::new();
    for (root, source) in sdk_roots() {
        if root.is_dir() {
            found.extend(find_in_root(&root).into_iter().map(|p| (p, source)));
        }
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(HDC_EXE);
            if p.is_file() {
                found.push((p, "PATH"));
            }
        }
    }
    // Same binary reached twice (e.g. an SDK dir that is also on PATH): keep the
    // first, i.e. the SDK-tagged entry.
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<HdcCandidate> = found
        .into_iter()
        .filter(|(p, _)| {
            let key = std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
            seen.insert(key.to_string_lossy().to_ascii_lowercase())
        })
        .map(|(p, source)| describe(&p, source))
        .collect();
    out.sort_by(|a, b| rank(b).cmp(&rank(a)));
    out
}

/// API level + version facts for one hdc binary.
pub fn describe(p: &Path, source: &str) -> HdcCandidate {
    let (api_version, sdk_version) = sdk_meta(p);
    HdcCandidate {
        hdc_version: hdc_version(p),
        path: p.to_string_lossy().to_string(),
        api_version,
        sdk_version,
        source: source.to_string(),
    }
}

/// Ordering key: newer SDK API first, then newer hdc.
pub fn rank(c: &HdcCandidate) -> (Option<u32>, (Vec<u32>, String)) {
    (c.api_version, hdc_version_key(&c.hdc_version))
}

/// Same file? (case-insensitive, through symlinks when resolvable)
pub fn same_file(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        std::fs::canonicalize(p)
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .to_ascii_lowercase()
    };
    norm(a) == norm(b)
}

/// Resolve the hdc binary path: explicit override, else the hdc from the newest
/// SDK (highest API level; ties broken by hdc version). A bare hdc on PATH only
/// wins when no SDK copy exists — PATH often points at an older SDK.
pub fn resolve_path(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        let p = p.trim();
        if !p.is_empty() {
            let pb = PathBuf::from(p);
            if pb.is_file() {
                return Ok(pb);
            }
            return Err(format!("指定的 hdc 路径不存在: {p}"));
        }
    }

    if let Some(best) = best_candidate() {
        return Ok(PathBuf::from(best.path));
    }
    Err("未找到 hdc，可在设置中手动指定 hdc.exe 路径".into())
}

/// Auto-detection result, cached: every hdc call resolves the path, and probing
/// each candidate runs `hdc -v`. Cleared by `refresh_candidates` (re-detect).
static BEST: std::sync::Mutex<Option<Option<HdcCandidate>>> = std::sync::Mutex::new(None);

fn best_candidate() -> Option<HdcCandidate> {
    let mut guard = BEST.lock().unwrap();
    if guard.is_none() {
        *guard = Some(list_candidates().into_iter().next());
    }
    guard.clone().flatten()
}

/// Re-scan (after installing a new SDK) and return the fresh list.
pub fn refresh_candidates() -> Vec<HdcCandidate> {
    let list = list_candidates();
    *BEST.lock().unwrap() = Some(list.first().cloned());
    list
}

/// Resolve hdc and query its version.
pub fn info(explicit: Option<&str>) -> Result<HdcInfo, String> {
    let path = resolve_path(explicit)?;
    let (api_version, _) = sdk_meta(&path);
    let explicit = explicit.map_or(false, |p| !p.trim().is_empty());
    let out = run(&path, &["-v"])?;
    // hdc -v prints e.g. "Ver: 3.2.0c"
    let version = out
        .stdout
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .trim_start_matches("Ver:")
        .trim()
        .to_string();
    Ok(HdcInfo {
        path: path.to_string_lossy().to_string(),
        version: if version.is_empty() { out.stdout } else { version },
        server_port: std::env::var("HDC_SERVER_PORT").ok(),
        api_version,
        explicit,
    })
}

/// Result of `hdc discover` (native UDP-broadcast LAN discovery).
#[derive(Debug, Clone, Serialize)]
pub struct DiscoverResult {
    /// Discovered "ip:port" targets.
    pub targets: Vec<String>,
    pub total: usize,
    /// True when discovery returned nothing AND hdc warned about the firewall —
    /// the UI uses this to offer the one-click UDP 8710 allow rule.
    pub needs_firewall: bool,
    pub raw: String,
}

/// Is `s` an "a.b.c.d:port" string?
fn is_ip_port(s: &str) -> bool {
    let Some((ip, port)) = s.rsplit_once(':') else {
        return false;
    };
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let octets: Vec<&str> = ip.split('.').collect();
    octets.len() == 4
        && octets
            .iter()
            .all(|o| !o.is_empty() && o.parse::<u8>().is_ok())
}

/// Run `hdc discover` and parse the broadcast results.
pub fn discover(path: &Path) -> Result<DiscoverResult, String> {
    let out = run(path, &["discover"])?;
    let combined = format!("{}\n{}", out.stdout, out.stderr);
    let mut targets = Vec::new();
    for line in combined.lines() {
        for tok in line.split_whitespace() {
            let tok = tok.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ':' && c != '.');
            if is_ip_port(tok) && !targets.contains(&tok.to_string()) {
                targets.push(tok.to_string());
            }
        }
    }
    let needs_firewall =
        targets.is_empty() && combined.to_lowercase().contains("firewall");
    Ok(DiscoverResult {
        total: targets.len(),
        targets,
        needs_firewall,
        raw: combined.trim().to_string(),
    })
}

const TYPE_TOKENS: &[&str] = &["USB", "TCP", "UART", "BT"];
const STATUS_TOKENS: &[&str] = &[
    "Connected",
    "Ready",
    "Offline",
    "Unauth",
    "Empty",
    "Lost",
    "Authing",
];

/// Parse the output of `hdc list targets -v` into structured devices.
pub fn parse_targets(stdout: &str) -> Vec<Device> {
    let mut devices = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("[Empty]") || line.eq_ignore_ascii_case("empty") {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.is_empty() {
            continue;
        }
        let connect_key = tokens[0].to_string();
        let conn_type = tokens
            .iter()
            .find(|t| TYPE_TOKENS.iter().any(|k| k.eq_ignore_ascii_case(t)))
            .map(|t| t.to_uppercase())
            .unwrap_or_else(|| {
                if connect_key.contains(':') {
                    "TCP".into()
                } else {
                    "UNKNOWN".into()
                }
            });
        let status = tokens
            .iter()
            .find(|t| STATUS_TOKENS.iter().any(|k| k.eq_ignore_ascii_case(t)))
            .map(|t| t.to_string())
            .unwrap_or_else(|| "Unknown".into());
        devices.push(Device {
            connect_key,
            conn_type,
            status,
            raw: line.to_string(),
        });
    }
    devices
}
