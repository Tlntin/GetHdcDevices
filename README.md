<div align="center">

# GetHdcDevices

**A Windows desktop app to discover and wirelessly connect HarmonyOS / OpenHarmony devices over `hdc` — no command line required.**

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-backend-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-frontend-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)](#requirements)

English · [简体中文](./README.zh-CN.md)

</div>

---

## Overview

Connecting a HarmonyOS device wirelessly with `hdc` (HarmonyOS Device Connector) normally means juggling several commands and guessing a system-assigned random port. **GetHdcDevices** wraps that whole flow in a small, native desktop UI: it finds devices on your LAN, surfaces their real `hdc` port, and connects them with one click — then lives quietly in the system tray.

It ships as a single native `.exe` / `.msi` (~5 MB) with low memory usage, built on **Tauri 2 (Rust backend) + Vanilla TypeScript + Vite (frontend)**.

> [!NOTE]
> **Why a dedicated tool?** HarmonyOS assigns the wireless debug port at random (e.g. `38789`, `46853` — not a fixed `10178`), and devices typically **drop ICMP and closed-TCP probes** (no ping reply, no RST). So "fixed-port / whole-subnet brute scanning" is both slow and incomplete. The reliable path is `hdc discover`, where the device itself broadcasts its real port — exactly what DevEco Studio does under the hood.

## Screenshots

<div align="center">

![GetHdcDevices — main window](img/screen-zh.png)

<sub>Main window — discover (broadcast / port scan), one-click connect, and connected / history device management.</sub>

</div>

## Features

- 🖧 **LAN host discovery** — lists devices from the ARP table (works even when a device drops ICMP/TCP). Modern phones/tablets use a **randomized MAC**, so they're flagged as *phone/tablet candidates* and sorted first. Deep-scan one device's ports, or auto-iterate every candidate with **Deep-scan all**.
- 📡 **Broadcast discovery** — runs native `hdc discover` (UDP broadcast) so devices report their real `IP:port`. First use needs inbound **UDP 8710** allowed; a one-click **Add firewall rule** button handles it (triggers a UAC prompt). _Note: VPN / virtual adapters / proxied networks may block UDP broadcast — fall back to LAN host → deep-scan port._
- 🔍 **Port scanning (firewall-free fallback)** — multi-threaded async TCP probing. Scan a short port list across the subnet, or do a **target IP + port range** deep scan of a single device when the port is unknown (e.g. `32768-60999`).
- 🔌 **One-click connect / disconnect** — `hdc tconn <ip:port>` / `tconn -remove`.
- 📋 **Connected devices** — parses `hdc list targets -v`, showing connection type (USB/TCP) and status, with auto-refresh every 10 s.
- 📶 **Enable wireless mode** — runs `hdc tmode port <port>` on a USB-connected device (reboots it into TCP listening mode).
- 🧠 **Device memory & history** — bind custom notes/names to a device's MAC; reconnect history devices when they come back online (🟢).
- ⌨️ **Manual connect** — type an `IP:port` directly.
- 🎨 **Themes** — 4 modern palettes (eclipse / carbon / daybreak / mist), light & dark, with an instant no-flash theme switcher.
- 🌐 **Multilingual UI** — English, Simplified Chinese, and Hong Kong Traditional Chinese, switchable from a dropdown. The system language is auto-detected on first launch (falls back to English).
- 🖥️ **System tray** — closing the window minimizes to the tray; the tray menu offers Show / Scan / Autostart / Quit, and a left-click reopens the window.
- 🚀 **Launch on startup** — optionally start minimized to the tray on Windows login.
- ⚙️ **Settings** — custom `hdc` path (auto-detected by default), scan ports, wireless port, timeouts, and concurrency (saved locally).

## How wireless `hdc` connection works

The standard flow this app automates:

1. Connect the device via **USB** first and run `hdc tmode port <port>` (the **Enable wireless** button) to enter TCP listening mode. The device reboots, then listens on a **system-assigned port** (usually a random high port) on the same LAN.
2. From the PC, run `hdc tconn <device-ip>:<port>` to connect.

Two ways to find a device:

| Method | Mechanism | Notes |
| --- | --- | --- |
| **Broadcast discovery** (recommended) | `hdc discover` over UDP — the device reports its real `IP:port` | Needs inbound UDP 8710 (one-click rule). Same approach as DevEco Studio; most reliable. |
| **Port scanning** | Concurrent TCP probes for open ports | Whole-subnet brute scans of large ranges are **not viable** (devices drop closed ports/ICMP). Use **target IP + range** for one device. Open ports are candidates only — `hdc tconn` is the source of truth. |

## How `hdc` is located

The app auto-detects the `hdc` executable in this order:

1. The path set manually in **Settings**
2. The system `PATH`
3. The OpenHarmony SDK install dir
   (`%LOCALAPPDATA%\OpenHarmony\Sdk\<version>\toolchains\hdc.exe`, highest version chosen automatically)

The `HDC_SERVER_PORT` environment variable is inherited automatically (read by `hdc` itself).

## Requirements

- **Windows 10/11** with the **WebView2 Runtime** (built into Windows 11)
- The **`hdc`** tool from the OpenHarmony SDK (for actually connecting to devices)

For development you additionally need:

- [Rust](https://rustup.rs/) (verified on 1.95)
- [Node.js](https://nodejs.org/) (verified on v24) + npm

## Getting started

### Run in development

```bash
npm install
npm run tauri dev
```

### Build a release (installer / exe)

```bash
npm run tauri build
```

Artifacts land in `src-tauri/target/release/`:

- Executable: `GetHdcDevices.exe`
- Installers: `bundle/msi/*.msi`, `bundle/nsis/*-setup.exe`

## Project structure

```
GetHdcDevices/
├─ index.html            # UI structure
├─ src/
│  ├─ main.ts            # Frontend logic (Tauri command calls, events, rendering, themes)
│  ├─ i18n.ts            # Translations + language detection (en / zh-CN / zh-HK)
│  └─ styles.css         # Themed token system (light/dark)
└─ src-tauri/
   ├─ src/
   │  ├─ lib.rs          # Tauri command registration + system tray + close-to-tray + autostart
   │  ├─ hdc.rs          # Locate hdc, run commands, parse `list targets`, `hdc discover`
   │  └─ scan.rs         # NIC enumeration + async concurrent subnet/ARP scanning
   ├─ tauri.conf.json    # App config (window, bundle, icons)
   └─ Cargo.toml
```

## Tech stack

| Layer | Technology |
| --- | --- |
| Shell / runtime | [Tauri 2](https://tauri.app/) (native WebView2) |
| Backend | Rust (async via Tokio, system tray, firewall/registry integration) |
| Frontend | Vanilla TypeScript + [Vite](https://vitejs.dev/) |
| Packaging | MSI + NSIS installers, single `.exe` |

## Contributing

Issues and pull requests are welcome. Please keep changes focused and match the existing code style.

## License

No license file is currently included. Until one is added, all rights are reserved by the author — open an issue if you'd like a specific license added.
