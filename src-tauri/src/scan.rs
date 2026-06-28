//! Local-network scanner.
//!
//! Two strategies feed device discovery:
//! * `hdc discover` (native UDP broadcast) lives in `hdc.rs` — the primary path,
//!   since HarmonyOS devices commonly drop ICMP and closed TCP ports, leaving no
//!   fast aliveness signal for a blind subnet scan.
//! * This module does firewall-free TCP discovery. It scans a port spec across a
//!   subnet (fast only for small port lists) or, more usefully, deep-scans a port
//!   range against a single known target IP ("I know the device IP, find its port").

use serde::Serialize;
use std::collections::{BTreeSet, HashSet};
use std::net::Ipv4Addr;
use std::process::Command as SysCommand;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinSet;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Cooperative cancel flag for an in-flight scan (set by the `cancel_scan` cmd).
static CANCEL: AtomicBool = AtomicBool::new(false);

pub fn request_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}
fn reset_cancel() {
    CANCEL.store(false, Ordering::SeqCst);
}
fn is_cancelled() -> bool {
    CANCEL.load(Ordering::SeqCst)
}

/// Hard cap on hosts per scan so a misconfigured prefix can't launch a
/// multi-million-address sweep.
const MAX_HOSTS: usize = 8192;
/// Max probes for a whole-subnet scan (keeps it from running for hours).
const MAX_SUBNET_PROBES: usize = 65_536;
/// Max probes for a single-target deep scan (one host × full port range is fine).
const MAX_TARGET_PROBES: usize = 70_000;

#[derive(Debug, Clone, Serialize)]
pub struct NetIface {
    pub name: String,
    pub ip: String,
    pub netmask: String,
    pub prefix: u8,
    /// Network address (e.g. 192.168.3.0) — the scan base.
    pub network: String,
    pub usable_hosts: usize,
    pub is_private: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub ip: String,
    pub port: u16,
    /// connect key form used by hdc: "ip:port".
    pub target: String,
}

#[derive(Clone, Serialize)]
struct Progress {
    phase: String,
    scanned: usize,
    total: usize,
    found: usize,
}

/// A host found on the LAN via the ARP table.
#[derive(Debug, Clone, Serialize)]
pub struct HostInfo {
    pub ip: String,
    pub mac: String,
    /// Heuristic: a locally-administered (randomized) MAC is typically a modern
    /// phone/tablet using MAC privacy — what we want to prioritize for hdc.
    pub likely_mobile: bool,
    pub note: String,
    /// Best-effort device name resolved without hdc (reverse DNS / NetBIOS).
    pub hostname: String,
}

fn prefix_from_mask(mask: Ipv4Addr) -> u8 {
    u32::from(mask).count_ones() as u8
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
}

/// Parse a port spec like "10178, 32768-60999" into a sorted, de-duped list.
pub fn parse_port_spec(spec: &str) -> Result<Vec<u16>, String> {
    let mut set: BTreeSet<u16> = BTreeSet::new();
    for part in spec.split([',', '，', ' ', '\t', '\n']) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((a, b)) = part.split_once('-') {
            let a: u32 = a.trim().parse().map_err(|_| format!("无效端口范围: {part}"))?;
            let b: u32 = b.trim().parse().map_err(|_| format!("无效端口范围: {part}"))?;
            if a == 0 || b == 0 || a > 65535 || b > 65535 || a > b {
                return Err(format!("无效端口范围: {part}"));
            }
            for p in a..=b {
                set.insert(p as u16);
            }
        } else {
            let p: u32 = part.parse().map_err(|_| format!("无效端口: {part}"))?;
            if p == 0 || p > 65535 {
                return Err(format!("无效端口: {part}"));
            }
            set.insert(p as u16);
        }
    }
    if set.is_empty() {
        return Err("未指定要扫描的端口".into());
    }
    Ok(set.into_iter().collect())
}

/// Enumerate usable IPv4 interfaces (skips loopback and /32-style addresses).
pub fn interfaces() -> Vec<NetIface> {
    let mut out = Vec::new();
    let Ok(ifaces) = if_addrs::get_if_addrs() else {
        return out;
    };
    for iface in ifaces {
        if iface.is_loopback() {
            continue;
        }
        let if_addrs::IfAddr::V4(v4) = iface.addr else {
            continue;
        };
        let ip = v4.ip;
        let mask = v4.netmask;
        let prefix = prefix_from_mask(mask);
        if prefix == 0 || prefix >= 31 {
            continue;
        }
        let net = u32::from(ip) & u32::from(mask);
        let host_bits = 32 - prefix as u32;
        let usable = (1u64 << host_bits).saturating_sub(2) as usize;
        out.push(NetIface {
            name: iface.name.clone(),
            ip: ip.to_string(),
            netmask: mask.to_string(),
            prefix,
            network: Ipv4Addr::from(net).to_string(),
            usable_hosts: usable,
            is_private: is_private_v4(ip),
        });
    }
    out.sort_by(|a, b| {
        b.is_private
            .cmp(&a.is_private)
            .then(a.usable_hosts.cmp(&b.usable_hosts))
    });
    out
}

/// Compute the list of host addresses for `network/prefix`.
fn hosts(network: Ipv4Addr, prefix: u8) -> Result<Vec<Ipv4Addr>, String> {
    if prefix >= 31 || prefix == 0 {
        return Err("无效的子网前缀（仅支持 /1 ~ /30）".into());
    }
    let host_bits = 32 - prefix as u32;
    let count = (1u64 << host_bits) as usize;
    if count.saturating_sub(2) > MAX_HOSTS {
        return Err(format!(
            "子网过大（{} 个主机），请选择更小的子网（/19 以上）",
            count - 2
        ));
    }
    let base = u32::from(network) & (u32::MAX << host_bits);
    let mut v = Vec::with_capacity(count.saturating_sub(2));
    for i in 1..(count as u32 - 1) {
        v.push(Ipv4Addr::from(base + i));
    }
    Ok(v)
}

/// Probe a batch of (ip, port) targets with bounded concurrency, emitting
/// progress / found events. Returns the targets whose port is open.
async fn run_probes(
    app: &AppHandle,
    tasks: Vec<(Ipv4Addr, u16)>,
    timeout: Duration,
    concurrency: usize,
    phase: &str,
) -> Vec<Candidate> {
    let total = tasks.len();
    if total == 0 {
        return Vec::new();
    }
    let found: Arc<Mutex<Vec<Candidate>>> = Arc::new(Mutex::new(Vec::new()));
    let sem = Arc::new(Semaphore::new(concurrency));
    let scanned = Arc::new(AtomicUsize::new(0));
    let step = (total / 100).max(1);
    let phase = phase.to_string();

    let mut set: JoinSet<()> = JoinSet::new();
    for (ip, port) in tasks {
        let sem = sem.clone();
        let found = found.clone();
        let scanned = scanned.clone();
        let app = app.clone();
        let phase = phase.clone();
        set.spawn(async move {
            if is_cancelled() {
                return;
            }
            let _permit = sem.acquire_owned().await.ok();
            if is_cancelled() {
                return;
            }
            let open = matches!(
                tokio::time::timeout(timeout, TcpStream::connect((ip, port))).await,
                Ok(Ok(_))
            );
            if open {
                let cand = Candidate {
                    ip: ip.to_string(),
                    port,
                    target: format!("{ip}:{port}"),
                };
                found.lock().await.push(cand.clone());
                let _ = app.emit("scan-found", cand);
            }
            let done = scanned.fetch_add(1, Ordering::Relaxed) + 1;
            if done % step == 0 || done == total {
                let found_count = found.lock().await.len();
                let _ = app.emit(
                    "scan-progress",
                    Progress {
                        phase: phase.clone(),
                        scanned: done,
                        total,
                        found: found_count,
                    },
                );
            }
        });
    }
    while set.join_next().await.is_some() {}

    let mut v = Arc::try_unwrap(found).map(|m| m.into_inner()).unwrap_or_default();
    v.sort_by(|a, b| {
        let pa: Ipv4Addr = a.ip.parse().unwrap_or(Ipv4Addr::UNSPECIFIED);
        let pb: Ipv4Addr = b.ip.parse().unwrap_or(Ipv4Addr::UNSPECIFIED);
        u32::from(pa).cmp(&u32::from(pb)).then(a.port.cmp(&b.port))
    });
    v.dedup_by(|a, b| a.target == b.target);
    v
}

/// Scan for open hdc ports.
/// * `target_ip` set → deep-scan that single host across `ports` (fast, reliable).
/// * `target_ip` empty → scan `ports` across the whole `network/prefix` subnet
///   (only practical for small port lists).
pub async fn scan(
    app: AppHandle,
    network: String,
    prefix: u8,
    ports: Vec<u16>,
    timeout_ms: u64,
    concurrency: usize,
    target_ip: Option<String>,
) -> Result<Vec<Candidate>, String> {
    if ports.is_empty() {
        return Err("未指定要扫描的端口".into());
    }
    reset_cancel(); // clear any stale cancel from a previous scan

    let (host_list, single) = match target_ip.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => {
            let ip: Ipv4Addr = t.parse().map_err(|_| format!("无效的目标 IP: {t}"))?;
            (vec![ip], true)
        }
        _ => {
            let net: Ipv4Addr = network
                .trim()
                .parse()
                .map_err(|_| format!("无效的网络地址: {network}"))?;
            (hosts(net, prefix)?, false)
        }
    };
    if host_list.is_empty() {
        return Ok(Vec::new());
    }

    let total = host_list.len() * ports.len();
    let cap = if single { MAX_TARGET_PROBES } else { MAX_SUBNET_PROBES };
    if total > cap {
        return Err(if single {
            format!("端口范围过大（{total}），请缩小端口范围")
        } else {
            format!(
                "探测数过大（{total}）。整网段扫描大端口段不可行——请填写「目标 IP」对单台设备做端口段深度扫描，或改用「广播发现」。"
            )
        });
    }

    let timeout = Duration::from_millis(timeout_ms.clamp(50, 5000));
    let mut concurrency = concurrency.clamp(8, 2048);
    if single {
        // A single host tolerates more parallelism — speeds up range scans a lot,
        // which matters because devices that drop closed ports cost a full timeout each.
        concurrency = concurrency.max(512);
    }
    let phase = if single {
        format!("深度扫描 {}", host_list[0])
    } else {
        "扫描".to_string()
    };
    let tasks: Vec<(Ipv4Addr, u16)> = host_list
        .iter()
        .flat_map(|ip| ports.iter().map(move |p| (*ip, *p)))
        .collect();
    Ok(run_probes(&app, tasks, timeout, concurrency, &phase).await)
}

// ----------------------------- Host discovery (ARP) -----------------------------

/// Parse "aa-bb-cc-dd-ee-ff" / "aa:bb:..." → the 6 octets, if a valid unicast MAC.
fn mac_octets(mac: &str) -> Option<[u8; 6]> {
    let parts: Vec<&str> = mac.split(['-', ':']).collect();
    if parts.len() != 6 {
        return None;
    }
    let mut out = [0u8; 6];
    for (i, p) in parts.iter().enumerate() {
        out[i] = u8::from_str_radix(p, 16).ok()?;
    }
    // Exclude multicast/broadcast and all-zero.
    if out[0] & 0x01 != 0 || out == [0, 0, 0, 0, 0, 0] {
        return None;
    }
    Some(out)
}

/// One ARP table entry, for binding notes/history to a stable MAC.
#[derive(Debug, Clone, Serialize)]
pub struct ArpEntry {
    pub ip: String,
    pub mac: String,
}

/// Probe specific "ip:port" targets; return the subset that is reachable (open).
/// Used to check whether history devices are still online / reconnectable.
/// One reachable target plus the MAC that actually answered the TCP handshake.
/// A successful connect forces the OS to (re)resolve ARP for that IP, so the MAC
/// read right afterwards identifies *who* answered — letting the UI reject a
/// reused IP / AP-proxied address that isn't really the remembered device.
#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub target: String,
    pub mac: Option<String>,
}

pub async fn probe_targets(targets: Vec<String>, timeout_ms: u64) -> Vec<ProbeResult> {
    let timeout = Duration::from_millis(timeout_ms.clamp(50, 3000));
    let sem = Arc::new(Semaphore::new(128));
    let open: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let mut set: JoinSet<()> = JoinSet::new();
    for t in targets {
        let Some((ip_s, port_s)) = t.rsplit_once(':') else {
            continue;
        };
        let (Ok(ip), Ok(port)) = (ip_s.parse::<Ipv4Addr>(), port_s.parse::<u16>()) else {
            continue;
        };
        let sem = sem.clone();
        let open = open.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            if matches!(
                tokio::time::timeout(timeout, TcpStream::connect((ip, port))).await,
                Ok(Ok(_))
            ) {
                open.lock().await.push(t);
            }
        });
    }
    while set.join_next().await.is_some() {}
    let open_targets = Arc::try_unwrap(open).map(|m| m.into_inner()).unwrap_or_default();
    // A successful connect forces the OS to resolve ARP, but Windows may not commit
    // the entry to `arp -a` instantly — wait briefly, then read; retry once if any
    // open target is still missing. A target that answered TCP yet never appears in
    // ARP isn't a real device on the LAN (the port was answered by something else),
    // and the UI keeps such a target out of "online".
    let ip_of = |t: &str| t.rsplit_once(':').and_then(|(ip, _)| ip.parse::<Ipv4Addr>().ok());
    tokio::time::sleep(Duration::from_millis(150)).await;
    let mut arp = read_arp_table();
    if open_targets
        .iter()
        .any(|t| ip_of(t).map_or(false, |ip| !arp.contains_key(&ip)))
    {
        tokio::time::sleep(Duration::from_millis(200)).await;
        arp = read_arp_table();
    }
    open_targets
        .into_iter()
        .map(|t| {
            let mac = ip_of(&t).and_then(|ip| arp.get(&ip).cloned());
            ProbeResult { target: t, mac }
        })
        .collect()
}

/// Current ARP table as serializable ip/mac pairs (no fresh probing).
pub fn arp_entries() -> Vec<ArpEntry> {
    read_arp_table()
        .into_iter()
        .map(|(ip, mac)| ArpEntry {
            ip: ip.to_string(),
            mac,
        })
        .collect()
}

/// Read the OS ARP table → map of IPv4 → MAC string (lowercased).
fn read_arp_table() -> std::collections::HashMap<Ipv4Addr, String> {
    let mut map = std::collections::HashMap::new();
    let mut cmd = SysCommand::new("arp");
    cmd.arg("-a");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let Ok(out) = cmd.output() else {
        return map;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let toks: Vec<&str> = line.split_whitespace().collect();
        if toks.len() < 2 {
            continue;
        }
        if let Ok(ip) = toks[0].parse::<Ipv4Addr>() {
            if mac_octets(toks[1]).is_some() {
                map.insert(ip, toks[1].to_lowercase());
            }
        }
    }
    map
}

/// Run a short-lived helper process, killing it if it outruns `timeout_ms`.
/// Returns its stdout, or None on spawn/timeout/error.
async fn run_cmd_timeout(program: &str, args: &[&str], timeout_ms: u64) -> Option<String> {
    let mut std_cmd = SysCommand::new(program);
    std_cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    std_cmd.creation_flags(CREATE_NO_WINDOW);
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true);
    let child = cmd.spawn().ok()?;
    match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output()).await {
        Ok(Ok(o)) => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
        _ => None,
    }
}

/// Reduce an FQDN to its leftmost label and drop a trailing dot:
/// "Mate60-Pro.lan." → "Mate60-Pro".
fn short_host(name: &str) -> String {
    name.trim()
        .trim_end_matches('.')
        .split('.')
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Reverse-DNS (PTR) lookup via `nslookup` — picks up router-registered DHCP
/// hostnames. None if the IP has no PTR record.
async fn reverse_dns(ip: Ipv4Addr) -> Option<String> {
    let ip_s = ip.to_string();
    let out = run_cmd_timeout("nslookup", &["-timeout=1", "-retry=1", &ip_s], 1700).await?;
    for line in out.lines() {
        let l = line.trim();
        // English "Name:" or localized "名称:".
        let val = l
            .strip_prefix("Name:")
            .or_else(|| l.strip_prefix("名称:"))
            .map(str::trim);
        if let Some(v) = val {
            let host = short_host(v);
            // Guard against the value just echoing the IP.
            if !host.is_empty() && host.parse::<Ipv4Addr>().is_err() {
                return Some(host);
            }
        }
    }
    None
}

/// NetBIOS name via `nbtstat -A <ip>` — resolves Windows / SMB hosts that have
/// no PTR record. None for devices that don't speak NetBIOS (most phones).
#[cfg(windows)]
async fn netbios_name(ip: Ipv4Addr) -> Option<String> {
    let ip_s = ip.to_string();
    let out = run_cmd_timeout("nbtstat", &["-A", &ip_s], 1500).await?;
    for line in out.lines() {
        // "    DESKTOP-ABC    <00>  UNIQUE      Registered"
        if line.contains("<00>") && line.to_uppercase().contains("UNIQUE") {
            let name = line.split("<00>").next().unwrap_or("").trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

// ---------- mDNS (.local) name discovery ----------
// Many modern devices (Windows, Linux/avahi, Apple, some HarmonyOS/Android)
// answer multicast DNS but expose no PTR / NetBIOS name. We send one service-
// enumeration query plus a reverse-PTR query per host to 224.0.0.251:5353 with
// the "unicast response" (QU) bit set, then harvest A and reverse-PTR records.

/// Parse a (possibly compression-pointer) DNS name at `start`.
/// Returns the dotted name and the offset just past the name in this branch.
fn dns_name(buf: &[u8], start: usize) -> (String, usize) {
    let mut labels: Vec<String> = Vec::new();
    let mut pos = start;
    let mut next = start;
    let mut jumped = false;
    let mut guard = 0;
    while pos < buf.len() && guard < 128 {
        guard += 1;
        let len = buf[pos];
        if len & 0xC0 == 0xC0 {
            if pos + 1 >= buf.len() {
                break;
            }
            let ptr = (((len & 0x3F) as usize) << 8) | buf[pos + 1] as usize;
            if !jumped {
                next = pos + 2;
            }
            jumped = true;
            pos = ptr;
        } else if len == 0 {
            if !jumped {
                next = pos + 1;
            }
            break;
        } else {
            let s = pos + 1;
            let e = s + len as usize;
            if e > buf.len() {
                break;
            }
            labels.push(String::from_utf8_lossy(&buf[s..e]).into_owned());
            pos = e;
            if !jumped {
                next = pos;
            }
        }
    }
    (labels.join("."), next)
}

/// "3.3.168.192.in-addr.arpa" → 192.168.3.3
fn ip_from_in_addr(name: &str) -> Option<Ipv4Addr> {
    let lower = name.to_ascii_lowercase();
    let rest = lower.strip_suffix(".in-addr.arpa")?;
    let p: Vec<&str> = rest.split('.').collect();
    if p.len() != 4 {
        return None;
    }
    Some(Ipv4Addr::new(
        p[3].parse().ok()?,
        p[2].parse().ok()?,
        p[1].parse().ok()?,
        p[0].parse().ok()?,
    ))
}

/// Build an mDNS query packet for one question (class IN + unicast-response bit).
fn mdns_question(labels: &[&str], qtype: u16) -> Vec<u8> {
    let mut p = vec![0u8, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]; // id+flags, qdcount=1
    for l in labels {
        p.push(l.len() as u8);
        p.extend_from_slice(l.as_bytes());
    }
    p.push(0);
    p.extend_from_slice(&qtype.to_be_bytes());
    p.extend_from_slice(&0x8001u16.to_be_bytes()); // QCLASS = IN | QU
    p
}

/// Harvest A and reverse-PTR records from one mDNS response into `out` (ip → name).
fn parse_mdns_into(buf: &[u8], out: &mut std::collections::HashMap<Ipv4Addr, String>) {
    if buf.len() < 12 {
        return;
    }
    let qd = u16::from_be_bytes([buf[4], buf[5]]) as usize;
    let rrs = u16::from_be_bytes([buf[6], buf[7]]) as usize
        + u16::from_be_bytes([buf[8], buf[9]]) as usize
        + u16::from_be_bytes([buf[10], buf[11]]) as usize;
    let mut pos = 12;
    for _ in 0..qd {
        let (_n, p) = dns_name(buf, pos);
        pos = p + 4; // qtype + qclass
        if pos > buf.len() {
            return;
        }
    }
    for _ in 0..rrs {
        let (name, p) = dns_name(buf, pos);
        pos = p;
        if pos + 10 > buf.len() {
            break;
        }
        let rtype = u16::from_be_bytes([buf[pos], buf[pos + 1]]);
        let rdlen = u16::from_be_bytes([buf[pos + 8], buf[pos + 9]]) as usize;
        pos += 10;
        if pos + rdlen > buf.len() {
            break;
        }
        match rtype {
            1 if rdlen == 4 => {
                // A record: this name lives at this IPv4.
                let ip = Ipv4Addr::new(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
                let h = short_host(&name);
                if !h.is_empty() && h.parse::<Ipv4Addr>().is_err() {
                    out.entry(ip).or_insert(h);
                }
            }
            12 => {
                // Reverse PTR: <ip>.in-addr.arpa → hostname.
                if let Some(ip) = ip_from_in_addr(&name) {
                    let (target, _) = dns_name(buf, pos);
                    let h = short_host(&target);
                    if !h.is_empty() {
                        out.insert(ip, h);
                    }
                }
            }
            _ => {}
        }
        pos += rdlen;
    }
}

/// Blocking mDNS sweep: returns ip → short hostname for whatever answers within
/// `budget_ms`. `local_ip` is the scanning interface (for the multicast join).
fn mdns_names(
    local_ip: Option<Ipv4Addr>,
    ips: &[Ipv4Addr],
    budget_ms: u64,
) -> std::collections::HashMap<Ipv4Addr, String> {
    use socket2::{Domain, Protocol, Socket, Type};
    use std::net::{SocketAddr, SocketAddrV4, UdpSocket};
    let mut out = std::collections::HashMap::new();

    // Bind to UDP 5353 with address reuse so we receive the *multicast* responses
    // most responders send (replies go to 224.0.0.251:5353, not our source port).
    // Address reuse lets us co-bind alongside the OS's own mDNS responder. Fall
    // back to an ephemeral port if 5353 is unavailable.
    let Ok(raw) = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)) else {
        return out;
    };
    let _ = raw.set_reuse_address(true);
    // Pin the multicast egress + receive interface to the LAN NIC. On a VM host
    // with virtual switches (Hyper-V/WSL/VirtualBox), the default route for
    // 224.0.0.251 often leaves the wrong adapter — so queries never reach the LAN.
    if let Some(lip) = local_ip {
        let _ = raw.set_multicast_if_v4(&lip);
    }
    let p5353: SocketAddr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 5353).into();
    let pephem: SocketAddr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0).into();
    if raw.bind(&p5353.into()).is_err() && raw.bind(&pephem.into()).is_err() {
        return out;
    }
    let sock: UdpSocket = raw.into();
    let _ = sock.set_multicast_loop_v4(false);
    let _ = sock.set_multicast_ttl_v4(2);
    let _ = sock.join_multicast_v4(
        &Ipv4Addr::new(224, 0, 0, 251),
        &local_ip.unwrap_or(Ipv4Addr::UNSPECIFIED),
    );

    let dst: SocketAddr = SocketAddrV4::new(Ipv4Addr::new(224, 0, 0, 251), 5353).into();
    // Service enumeration + a few concrete types that carry a hostname (avahi
    // advertises the host under _workstation._tcp; Apple under _device-info).
    for svc in [
        "_services._dns-sd._udp.local",
        "_workstation._tcp.local",
        "_device-info._tcp.local",
        "_smb._tcp.local",
        "_http._tcp.local",
        "_ssh._tcp.local",
        "_googlecast._tcp.local",
        "_airplay._tcp.local",
    ] {
        let labels: Vec<&str> = svc.split('.').collect();
        let _ = sock.send_to(&mdns_question(&labels, 12), dst);
    }
    for ip in ips {
        let o = ip.octets();
        let (l0, l1, l2, l3) = (
            o[3].to_string(),
            o[2].to_string(),
            o[1].to_string(),
            o[0].to_string(),
        );
        let _ = sock.send_to(
            &mdns_question(
                &[l0.as_str(), l1.as_str(), l2.as_str(), l3.as_str(), "in-addr", "arpa"],
                12,
            ),
            dst,
        );
    }
    let _ = sock.set_read_timeout(Some(Duration::from_millis(300)));
    let deadline = std::time::Instant::now() + Duration::from_millis(budget_ms);
    let mut buf = [0u8; 4096];
    while std::time::Instant::now() < deadline {
        if let Ok((n, _)) = sock.recv_from(&mut buf) {
            parse_mdns_into(&buf[..n], &mut out);
        }
    }
    out
}

/// Local IPv4 of the interface that hosts `net/prefix` (for the multicast join).
fn local_ipv4_in(net: Ipv4Addr, prefix: u8) -> Option<Ipv4Addr> {
    let mask: u32 = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix as u32)
    };
    let target = u32::from(net) & mask;
    for iface in if_addrs::get_if_addrs().ok()? {
        if let if_addrs::IfAddr::V4(v4) = iface.addr {
            if (u32::from(v4.ip) & mask) == target {
                return Some(v4.ip);
            }
        }
    }
    None
}

/// Best-effort device name for an IP without an hdc connection.
async fn resolve_hostname(ip: Ipv4Addr) -> String {
    if let Some(n) = reverse_dns(ip).await {
        return n;
    }
    #[cfg(windows)]
    if let Some(n) = netbios_name(ip).await {
        return n;
    }
    String::new()
}

/// Discover hosts on `network/prefix`: trigger ARP resolution for every host,
/// then read the ARP table. Returns hosts with a MAC, phone/tablet candidates
/// (randomized MAC) sorted first.
pub async fn discover_hosts(network: String, prefix: u8) -> Result<Vec<HostInfo>, String> {
    let net: Ipv4Addr = network
        .trim()
        .parse()
        .map_err(|_| format!("无效的网络地址: {network}"))?;
    let host_list = hosts(net, prefix)?;
    let host_set: HashSet<Ipv4Addr> = host_list.iter().copied().collect();

    // Fire short connects to populate the ARP cache (ARP resolves before the SYN,
    // so even hosts that drop the packet still answer ARP at layer 2).
    let sem = Arc::new(Semaphore::new(256));
    let mut set: JoinSet<()> = JoinSet::new();
    for ip in host_list {
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            let _ =
                tokio::time::timeout(Duration::from_millis(150), TcpStream::connect((ip, 9))).await;
        });
    }
    while set.join_next().await.is_some() {}
    tokio::time::sleep(Duration::from_millis(150)).await;

    let arp = tokio::task::spawn_blocking(read_arp_table)
        .await
        .unwrap_or_default();

    let mut out: Vec<HostInfo> = arp
        .into_iter()
        .filter(|(ip, _)| host_set.contains(ip))
        .map(|(ip, mac)| {
            let local = mac_octets(&mac).map(|o| o[0] & 0x02 != 0).unwrap_or(false);
            HostInfo {
                ip: ip.to_string(),
                mac,
                likely_mobile: local,
                note: if local {
                    "随机 MAC · 手机/平板候选".into()
                } else {
                    "固定 MAC · 普通设备".into()
                },
                hostname: String::new(),
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.likely_mobile.cmp(&a.likely_mobile).then_with(|| {
            let pa: Ipv4Addr = a.ip.parse().unwrap_or(Ipv4Addr::UNSPECIFIED);
            let pb: Ipv4Addr = b.ip.parse().unwrap_or(Ipv4Addr::UNSPECIFIED);
            u32::from(pa).cmp(&u32::from(pb))
        })
    });

    // Names are resolved here because `out` is no longer reordered after this point.
    // First a single mDNS sweep (catches modern `.local` devices with no PTR /
    // NetBIOS record), then per-host reverse-DNS / NetBIOS for any still unnamed.
    let mdns_ips: Vec<Ipv4Addr> = out.iter().filter_map(|h| h.ip.parse().ok()).collect();
    let local_ip = local_ipv4_in(net, prefix);
    let mdns = tokio::task::spawn_blocking(move || mdns_names(local_ip, &mdns_ips, 1800))
        .await
        .unwrap_or_default();
    for h in out.iter_mut() {
        if let Ok(ip) = h.ip.parse::<Ipv4Addr>() {
            if let Some(name) = mdns.get(&ip) {
                h.hostname = name.clone();
            }
        }
    }

    let name_sem = Arc::new(Semaphore::new(32));
    let mut name_set: JoinSet<(usize, String)> = JoinSet::new();
    for (i, h) in out.iter().enumerate() {
        if !h.hostname.is_empty() {
            continue; // already named by mDNS
        }
        let Ok(ip) = h.ip.parse::<Ipv4Addr>() else {
            continue;
        };
        let name_sem = name_sem.clone();
        name_set.spawn(async move {
            let _permit = name_sem.acquire_owned().await.ok();
            (i, resolve_hostname(ip).await)
        });
    }
    while let Some(res) = name_set.join_next().await {
        if let Ok((i, name)) = res {
            if !name.is_empty() {
                out[i].hostname = name;
            }
        }
    }

    Ok(out)
}
