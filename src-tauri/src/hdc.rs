//! Thin wrapper around the OpenHarmony `hdc` (HarmonyOS Device Connector) binary.
//!
//! Responsibilities:
//! * locate the `hdc` executable (explicit path > PATH > OpenHarmony SDK install)
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

/// Candidate locations for hdc.exe inside an OpenHarmony SDK install.
fn sdk_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let exe = if cfg!(windows) { "hdc.exe" } else { "hdc" };

    // %LOCALAPPDATA%\OpenHarmony\Sdk\<ver>\toolchains\hdc.exe  (Windows default)
    // ~/OpenHarmony/Sdk/...                                     (other platforms)
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("OpenHarmony").join("Sdk"));
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        roots.push(PathBuf::from(home).join("OpenHarmony").join("Sdk"));
    }
    if let Ok(sdk) = std::env::var("OHOS_SDK_HOME").or_else(|_| std::env::var("HOS_SDK_HOME")) {
        roots.push(PathBuf::from(sdk));
    }

    for root in roots {
        if !root.is_dir() {
            continue;
        }
        // Collect version sub-dirs, prefer the highest (numeric) one first.
        let mut versions: Vec<PathBuf> = std::fs::read_dir(&root)
            .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default();
        versions.sort();
        versions.reverse();
        for v in versions {
            let p = v.join("toolchains").join(exe);
            if p.is_file() {
                out.push(p);
            }
        }
    }
    out
}

/// Resolve the hdc binary path: explicit override, then PATH, then SDK install.
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

    // On PATH?
    let exe = if cfg!(windows) { "hdc.exe" } else { "hdc" };
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(exe);
            if p.is_file() {
                return Ok(p);
            }
        }
    }

    // SDK install locations.
    if let Some(p) = sdk_candidates().into_iter().next() {
        return Ok(p);
    }

    Err("未找到 hdc，可在设置中手动指定 hdc.exe 路径".into())
}

/// Resolve hdc and query its version.
pub fn info(explicit: Option<&str>) -> Result<HdcInfo, String> {
    let path = resolve_path(explicit)?;
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
