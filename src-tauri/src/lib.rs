mod hdc;
mod scan;

use hdc::{CmdOutput, Device, DiscoverResult, HdcInfo};
use scan::{ArpEntry, Candidate, HostInfo, NetIface};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

// ---------- Launch-on-startup (Windows HKCU\...\Run) ----------
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_NAME: &str = "GetHdcDevices";

/// Holds the tray's "开机自启动" check item so settings + tray stay in sync.
struct AutostartMenu(Mutex<Option<CheckMenuItem<tauri::Wry>>>);

/// The command stored under Run: the exe path plus a flag so autostart launches
/// straight to the tray instead of popping the window.
#[cfg(windows)]
fn autostart_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法获取程序路径: {e}"))?;
    Ok(format!("\"{}\" --minimized", exe.to_string_lossy()))
}

/// Whether the Run entry currently exists.
fn is_autostart_enabled() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        Command::new("reg")
            .args(["query", RUN_KEY, "/v", RUN_NAME])
            .creation_flags(0x0800_0000)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Write or remove the Run entry.
fn set_autostart_registry(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        if enabled {
            let cmd = autostart_command()?;
            let status = Command::new("reg")
                .args(["add", RUN_KEY, "/v", RUN_NAME, "/t", "REG_SZ", "/d", &cmd, "/f"])
                .creation_flags(0x0800_0000)
                .status()
                .map_err(|e| format!("写入注册表失败: {e}"))?;
            if !status.success() {
                return Err("写入自启动注册表项失败".into());
            }
        } else {
            // Ignore "value not found" — deleting a missing entry is a no-op.
            let _ = Command::new("reg")
                .args(["delete", RUN_KEY, "/v", RUN_NAME, "/f"])
                .creation_flags(0x0800_0000)
                .status();
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("开机自启动仅支持 Windows".into())
    }
}

/// Apply the desired autostart state and reflect it on the tray check item.
fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    set_autostart_registry(enabled)?;
    if let Some(state) = app.try_state::<AutostartMenu>() {
        if let Ok(guard) = state.0.lock() {
            if let Some(item) = guard.as_ref() {
                let _ = item.set_checked(enabled);
            }
        }
    }
    Ok(())
}

/// Read the current launch-on-startup state.
#[tauri::command]
fn get_autostart() -> bool {
    is_autostart_enabled()
}

/// Enable/disable launch-on-startup (keeps the tray checkbox in sync).
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    apply_autostart(&app, enabled)
}

/// Run a blocking hdc closure on the blocking pool and flatten the join error.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("内部任务错误: {e}"))?
}

/// Resolve hdc and return its path + version.
#[tauri::command]
async fn detect_hdc(hdc_path: Option<String>) -> Result<HdcInfo, String> {
    blocking(move || hdc::info(hdc_path.as_deref())).await
}

/// `hdc list targets -v` parsed into structured devices.
#[tauri::command]
async fn list_devices(hdc_path: Option<String>) -> Result<Vec<Device>, String> {
    blocking(move || {
        let path = hdc::resolve_path(hdc_path.as_deref())?;
        let out = hdc::run(&path, &["list", "targets", "-v"])?;
        Ok(hdc::parse_targets(&out.stdout))
    })
    .await
}

/// `hdc tconn <target>` — connect to a wireless device, with a hard timeout so a
/// non-hdc port's handshake can't hang the UI.
#[tauri::command]
async fn connect_device(
    hdc_path: Option<String>,
    target: String,
    timeout_ms: Option<u64>,
) -> Result<CmdOutput, String> {
    let path = hdc::resolve_path(hdc_path.as_deref())?;
    let timeout = timeout_ms.unwrap_or(8000).clamp(1000, 30000);
    hdc::run_timeout(&path, &["tconn", target.trim()], timeout).await
}

/// `hdc kill -r` — restart the hdc server (clears stuck/Offline ghost targets).
#[tauri::command]
async fn restart_hdc(hdc_path: Option<String>) -> Result<String, String> {
    blocking(move || {
        let path = hdc::resolve_path(hdc_path.as_deref())?;
        let out = hdc::run(&path, &["kill", "-r"])?;
        let msg = format!("{}{}", out.stdout, out.stderr);
        Ok(if msg.trim().is_empty() {
            "hdc 服务已重启".to_string()
        } else {
            msg.trim().to_string()
        })
    })
    .await
}

/// `hdc tconn <target> -remove` — disconnect a wireless device.
#[tauri::command]
async fn disconnect_device(hdc_path: Option<String>, target: String) -> Result<CmdOutput, String> {
    blocking(move || {
        let path = hdc::resolve_path(hdc_path.as_deref())?;
        hdc::run(&path, &["tconn", target.trim(), "-remove"])
    })
    .await
}

/// `hdc [-t key] tmode port <port>` — switch a USB device into TCP listening mode.
/// NOTE: this reboots the target device.
#[tauri::command]
async fn enable_wireless(
    hdc_path: Option<String>,
    connect_key: Option<String>,
    port: u16,
) -> Result<CmdOutput, String> {
    blocking(move || {
        let path = hdc::resolve_path(hdc_path.as_deref())?;
        let port_s = port.to_string();
        let mut args: Vec<&str> = Vec::new();
        if let Some(key) = connect_key.as_deref() {
            let key = key.trim();
            if !key.is_empty() {
                args.push("-t");
                args.push(key);
            }
        }
        args.extend_from_slice(&["tmode", "port", &port_s]);
        hdc::run(&path, &args)
    })
    .await
}

#[derive(Serialize)]
struct DeviceDetail {
    model: String,
    brand: String,
    os_version: String,
}

/// Best-effort device facts via `hdc -t <key> shell param get ...`.
#[tauri::command]
async fn device_detail(hdc_path: Option<String>, connect_key: String) -> Result<DeviceDetail, String> {
    blocking(move || {
        let path = hdc::resolve_path(hdc_path.as_deref())?;
        let key = connect_key.trim().to_string();
        let get = |k: &str| -> String {
            hdc::run(&path, &["-t", &key, "shell", "param", "get", k])
                .map(|o| o.stdout.lines().next().unwrap_or("").trim().to_string())
                .unwrap_or_default()
        };
        Ok(DeviceDetail {
            model: nz(get("const.product.model")),
            brand: nz(get("const.product.brand")),
            os_version: nz(get("const.ohos.fullname")),
        })
    })
    .await
}

fn nz(s: String) -> String {
    if s.is_empty() || s.contains("Fail") {
        "未知".into()
    } else {
        s
    }
}

/// IPv4 interfaces available for scanning.
#[tauri::command]
fn get_interfaces() -> Vec<NetIface> {
    scan::interfaces()
}

/// Current ARP table (ip ↔ mac) — used to bind notes/history to a stable MAC.
#[tauri::command]
async fn arp_table() -> Result<Vec<ArpEntry>, String> {
    blocking(|| Ok(scan::arp_entries())).await
}

/// Probe "ip:port" targets; return the reachable subset with the answering MAC
/// (history online check).
#[tauri::command]
async fn probe_targets(
    targets: Vec<String>,
    timeout_ms: u64,
) -> Result<Vec<scan::ProbeResult>, String> {
    Ok(scan::probe_targets(targets, timeout_ms).await)
}

/// Discover LAN hosts via the ARP table (phone/tablet candidates first).
#[tauri::command]
async fn discover_hosts(network: String, prefix: u8) -> Result<Vec<HostInfo>, String> {
    scan::discover_hosts(network, prefix).await
}

/// Native LAN discovery via `hdc discover` (UDP broadcast). Returns the
/// discovered ip:port targets, or a firewall hint if blocked.
#[tauri::command]
async fn discover_devices(hdc_path: Option<String>) -> Result<DiscoverResult, String> {
    blocking(move || {
        let path = hdc::resolve_path(hdc_path.as_deref())?;
        hdc::discover(&path)
    })
    .await
}

/// Scan a subnet for open hdc ports. `port_spec` supports lists and ranges
/// (e.g. "10178, 32768-60999"). Streams progress via events.
#[tauri::command]
async fn start_scan(
    app: AppHandle,
    network: String,
    prefix: u8,
    port_spec: String,
    timeout_ms: u64,
    concurrency: usize,
    target_ip: Option<String>,
) -> Result<Vec<Candidate>, String> {
    let ports = scan::parse_port_spec(&port_spec)?;
    scan::scan(app, network, prefix, ports, timeout_ms, concurrency, target_ip).await
}

/// Request cancellation of the in-flight scan.
#[tauri::command]
fn cancel_scan() {
    scan::request_cancel();
}

/// Check (non-elevated) whether both inbound allow rules exist: UDP 8710
/// (`hdc discover`) and UDP 5353 (mDNS device-name discovery).
#[cfg(windows)]
fn fw_rule_exists() -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    let present = |name: &str| -> bool {
        Command::new("netsh")
            .args(["advfirewall", "firewall", "show", "rule", &format!("name={name}")])
            .creation_flags(0x0800_0000)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(name))
            .unwrap_or(false)
    };
    Ok(present("HDC_Discover_UDP_8710") && present("HDC_mDNS_UDP_5353"))
}

/// Whether the UDP 8710 inbound allow rule already exists.
#[tauri::command]
async fn firewall_rule_exists() -> Result<bool, String> {
    blocking(|| {
        #[cfg(windows)]
        {
            fw_rule_exists()
        }
        #[cfg(not(windows))]
        {
            Ok(false)
        }
    })
    .await
}

/// Add the inbound UDP firewall rules: 8710 (`hdc discover`) and 5353 (mDNS
/// device-name discovery). Idempotent — one UAC prompt covers both, and rules
/// are delete-then-added so re-running never leaves duplicates.
#[tauri::command]
async fn add_firewall_rule() -> Result<String, String> {
    blocking(|| {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use std::process::Command;
            if fw_rule_exists()? {
                return Ok("防火墙规则已存在（UDP 8710 + 5353 已放行）".to_string());
            }
            // One elevated cmd adds both rules. Rule names are space-free so they
            // survive the elevation/argv hop. delete>nul makes re-runs idempotent.
            let cmd_line = "/c \
                netsh advfirewall firewall delete rule name=HDC_Discover_UDP_8710 >nul 2>&1 & \
                netsh advfirewall firewall add rule name=HDC_Discover_UDP_8710 dir=in action=allow protocol=UDP localport=8710 & \
                netsh advfirewall firewall delete rule name=HDC_mDNS_UDP_5353 >nul 2>&1 & \
                netsh advfirewall firewall add rule name=HDC_mDNS_UDP_5353 dir=in action=allow protocol=UDP localport=5353";
            let ps = format!(
                "Start-Process -Verb RunAs -Wait -WindowStyle Hidden cmd -ArgumentList '{}'",
                cmd_line
            );
            let status = Command::new("powershell")
                .args(["-NoProfile", "-Command", &ps])
                .creation_flags(0x0800_0000)
                .status()
                .map_err(|e| format!("启动提权失败: {e}"))?;
            if status.success() {
                Ok("已添加防火墙规则（UDP 8710 + 5353 入站放行）".to_string())
            } else {
                Err("提权被取消或失败".to_string())
            }
        }
        #[cfg(not(windows))]
        {
            Err("该功能仅支持 Windows".to_string())
        }
    })
    .await
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
    let scan = MenuItem::with_id(app, "scan", "扫描局域网", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启动",
        true,
        is_autostart_enabled(),
        None::<&str>,
    )?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &scan, &sep, &autostart, &sep2, &quit])?;

    // Keep a handle so the settings panel can update this checkbox.
    app.manage(AutostartMenu(Mutex::new(Some(autostart.clone()))));

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("HDC 无线设备扫描器")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "scan" => {
                show_main(app);
                let _ = app.emit("tray-scan", ());
            }
            "autostart" => {
                // Source of truth is the registry; flip it and re-sync the check.
                let want = !is_autostart_enabled();
                if let Err(e) = apply_autostart(app, want) {
                    eprintln!("set autostart failed: {e}");
                }
                let _ = app.emit("autostart-changed", want);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            build_tray(app.handle())?;
            // The window starts hidden (config visible:false). Show it now unless
            // we were autostarted with --minimized (then stay in the tray).
            let minimized = std::env::args().any(|a| a == "--minimized");
            if !minimized {
                show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it to the tray instead of quitting.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            detect_hdc,
            list_devices,
            connect_device,
            disconnect_device,
            restart_hdc,
            enable_wireless,
            device_detail,
            get_interfaces,
            arp_table,
            probe_targets,
            discover_hosts,
            discover_devices,
            start_scan,
            cancel_scan,
            firewall_rule_exists,
            add_firewall_rule,
            get_autostart,
            set_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
