//! Keep the terminal `PATH`'s hdc current.
//!
//! Which hdc a *new* terminal runs is decided by the registry, not by this
//! process's (stale, inherited) environment: system Path first, then user Path.
//! We find the first entry holding hdc.exe, compare it with the newest SDK's hdc,
//! and can repoint that entry at the newest SDK's `toolchains` dir.
//!
//! The registry value is edited in place (value type preserved, other entries
//! untouched) — never via `setx`, which silently truncates PATH at 1024 chars.

use crate::hdc::{self, HdcCandidate, HDC_EXE};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct PathHdc {
    /// The hdc a new terminal would run, if any.
    pub current: Option<HdcCandidate>,
    /// "user" | "system" | "" (not on PATH)
    pub scope: String,
    /// The PATH entry (as written, unexpanded) that holds it.
    pub entry: String,
    /// Newest SDK hdc on this machine.
    pub best: Option<HdcCandidate>,
    /// PATH hdc is missing or older than `best`.
    pub outdated: bool,
}

#[cfg(windows)]
mod reg {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE};
    use winreg::{RegKey, RegValue};

    pub const USER: (winreg::HKEY, &str) = (HKEY_CURRENT_USER, "Environment");
    pub const SYSTEM: (winreg::HKEY, &str) =
        (HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment");

    /// Raw Path value (unexpanded) + its registry value type.
    pub fn read(scope: (winreg::HKEY, &str)) -> Option<(String, winreg::enums::RegType)> {
        let key = RegKey::predef(scope.0).open_subkey_with_flags(scope.1, KEY_READ).ok()?;
        let raw: RegValue = key.get_raw_value("Path").ok()?;
        // REG_SZ / REG_EXPAND_SZ are UTF-16LE, NUL-terminated.
        let wide: Vec<u16> = raw.bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let s = String::from_utf16_lossy(&wide).trim_end_matches('\0').to_string();
        Some((s, raw.vtype))
    }

    pub fn write(scope: (winreg::HKEY, &str), value: &str, vtype: winreg::enums::RegType) -> Result<(), String> {
        let key = RegKey::predef(scope.0)
            .open_subkey_with_flags(scope.1, KEY_READ | KEY_WRITE)
            .map_err(|e| format!("无法打开注册表 PATH（{e}）"))?;
        let mut bytes: Vec<u8> = value.encode_utf16().chain([0]).flat_map(|u| u.to_le_bytes()).collect();
        if bytes.is_empty() {
            bytes = vec![0, 0];
        }
        key.set_raw_value("Path", &RegValue { bytes, vtype })
            .map_err(|e| format!("写入注册表 PATH 失败（{e}）"))
    }
}

/// Expand `%VAR%` references the way the shell does for PATH entries.
fn expand(entry: &str) -> String {
    let mut out = String::new();
    let mut rest = entry;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) if !name.is_empty() => out.push_str(&v),
                    _ => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn hdc_in(entry: &str) -> Option<PathBuf> {
    let dir = expand(entry.trim().trim_matches('"'));
    if dir.is_empty() {
        return None;
    }
    let p = Path::new(&dir).join(HDC_EXE);
    p.is_file().then_some(p)
}

/// Where the PATH hdc lives and whether it lags the newest SDK.
pub fn status() -> PathHdc {
    let best = hdc::list_candidates().into_iter().find(|c| c.source != "PATH");
    let mut found: Option<(PathBuf, &str, String)> = None;
    #[cfg(windows)]
    for (scope, name) in [(reg::SYSTEM, "system"), (reg::USER, "user")] {
        let Some((value, _)) = reg::read(scope) else { continue };
        if let Some(entry) = value.split(';').find(|e| hdc_in(e).is_some()) {
            found = Some((hdc_in(entry).unwrap(), name, entry.to_string()));
            break;
        }
    }
    let current = found.as_ref().map(|(p, _, _)| hdc::describe(p, "PATH"));
    let outdated = match (&current, &best) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(c), Some(b)) => {
            !hdc::same_file(Path::new(&c.path), Path::new(&b.path)) && hdc::rank(b) > hdc::rank(c)
        }
    };
    PathHdc {
        current,
        scope: found.as_ref().map(|(_, s, _)| s.to_string()).unwrap_or_default(),
        entry: found.map(|(_, _, e)| e).unwrap_or_default(),
        best,
        outdated,
    }
}

/// New Path value: the first hdc-holding entry becomes `new_dir`; later
/// hdc-holding entries and duplicates of `new_dir` are dropped (they would only
/// be shadowed / confusing). Appends `new_dir` if no entry held hdc.
fn repoint(value: &str, new_dir: &str) -> String {
    let same = |e: &str| expand(e.trim()).trim_end_matches('\\').eq_ignore_ascii_case(new_dir.trim_end_matches('\\'));
    let mut out: Vec<String> = Vec::new();
    let mut placed = false;
    for e in value.split(';') {
        if hdc_in(e).is_some() || same(e) {
            if !placed {
                out.push(new_dir.to_string());
                placed = true;
            }
            continue;
        }
        out.push(e.to_string());
    }
    if !placed {
        // Keep a trailing ";" layout intact: insert before empty tail entries.
        let at = out.iter().rposition(|e| !e.is_empty()).map(|i| i + 1).unwrap_or(0);
        out.insert(at, new_dir.to_string());
    }
    out.join(";")
}

/// Point PATH's hdc at the newest SDK. Edits whichever scope currently wins
/// (system needs admin); with no hdc on PATH, adds it to the user Path.
pub fn update_to_best() -> Result<String, String> {
    let st = status();
    let best = st.best.ok_or("没有找到任何 SDK 里的 hdc")?;
    let new_dir = Path::new(&best.path)
        .parent()
        .ok_or("hdc 路径无效")?
        .to_string_lossy()
        .to_string();
    #[cfg(windows)]
    {
        let scope = if st.scope == "system" { reg::SYSTEM } else { reg::USER };
        let (value, vtype) = reg::read(scope).unwrap_or((String::new(), winreg::enums::RegType::REG_EXPAND_SZ));
        let updated = repoint(&value, &new_dir);
        // Keep the previous value so a bad edit can always be undone by hand.
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let dir = PathBuf::from(local).join("com.gethdc.devices");
            let _ = std::fs::create_dir_all(&dir);
            let name = format!("path-backup-{}.txt", if st.scope == "system" { "system" } else { "user" });
            let _ = std::fs::write(dir.join(name), &value);
        }
        reg::write(scope, &updated, vtype).map_err(|e| {
            if st.scope == "system" {
                format!("{e}：旧 hdc 在系统 PATH 里，需要以管理员身份运行本工具再点一次")
            } else {
                e
            }
        })?;
        broadcast_env_change();
        Ok(new_dir)
    }
    #[cfg(not(windows))]
    {
        let _ = (new_dir, repoint);
        Err("仅支持 Windows".into())
    }
}

/// Tell Explorer & co. that the environment changed, so newly started
/// terminals see the new PATH without logging out.
#[cfg(windows)]
fn broadcast_env_change() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    let param: Vec<u16> = "Environment".encode_utf16().chain([0]).collect();
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            param.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            3000,
            std::ptr::null_mut(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repoint_replaces_first_hdc_entry_and_keeps_the_rest() {
        let dir = std::env::temp_dir().join("gethdc_repoint_test_old");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(HDC_EXE), b"").unwrap();
        let old = dir.to_string_lossy().to_string();
        let v = format!(r"C:\a;{old};D:\b;{old};");
        let out = repoint(&v, r"C:\SDK\26\toolchains");
        assert_eq!(out, r"C:\a;C:\SDK\26\toolchains;D:\b;");
        // No hdc entry → appended before the trailing empty entry.
        assert_eq!(repoint(r"C:\a;D:\b;", r"C:\new"), r"C:\a;D:\b;C:\new;");
        // Already present → not duplicated.
        assert_eq!(repoint(r"C:\a;C:\new\", r"C:\new"), r"C:\a;C:\new");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn expands_env_vars() {
        std::env::set_var("GETHDC_T", r"C:\x");
        assert_eq!(expand(r"%GETHDC_T%\bin"), r"C:\x\bin");
        assert_eq!(expand(r"%NOPE_GETHDC%\bin"), r"%NOPE_GETHDC%\bin");
    }
}

#[cfg(test)]
mod live {
    /// Read-only: `cargo test live_hdc -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_hdc_detection() {
        for c in crate::hdc::list_candidates() {
            println!("API {:?} · hdc {} · {} · {}", c.api_version, c.hdc_version, c.source, c.path);
        }
        println!("resolve_path(None) = {:?}", crate::hdc::resolve_path(None));
        let st = super::status();
        println!(
            "PATH: scope={} entry={} current={:?} outdated={}",
            st.scope,
            st.entry,
            st.current.map(|c| (c.api_version, c.hdc_version)),
            st.outdated
        );
    }
}
