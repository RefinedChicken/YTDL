#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use anyhow::{anyhow, Context};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{process::CommandChild, ShellExt};

const PORT: u16 = 9090;

struct ServerProcess(Arc<Mutex<Option<CommandChild>>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Err(e) = run_setup(app) {
                // Write error to a log file next to app data so the crash is diagnosable.
                let log = app
                    .path()
                    .app_data_dir()
                    .map(|d| { let _ = std::fs::create_dir_all(&d); d.join("ytdl-error.log") })
                    .unwrap_or_else(|_| std::path::PathBuf::from("ytdl-error.log"));
                let _ = std::fs::write(&log, format!("{e:?}\n"));
                return Err(e.into());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn run_setup(app: &mut tauri::App) -> anyhow::Result<()> {
    // macOS: run as background agent — no Dock icon, no App Switcher entry.
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);

    // All bundled sidecars (ytdl-server, yt-dlp, ffmpeg) sit in the same
    // directory as the main ytdl binary. Tauri strips the target-triple
    // suffix when bundling, so ytdl-server-x86_64-pc-windows-msvc.exe
    // becomes ytdl-server.exe in the install dir.
    let exe = std::env::current_exe().context("failed to locate current exe")?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| anyhow!("executable has no parent directory"))?
        .to_path_buf();

    let ext = if cfg!(windows) { ".exe" } else { "" };
    let ytdlp_path  = exe_dir.join(format!("yt-dlp{ext}"));
    let ffmpeg_path = exe_dir.join(format!("ffmpeg{ext}"));

    // public/ is bundled as a resource; resource_dir resolves to the dir
    // Tauri unpacks resources into at runtime.
    let resource_dir = app.path().resource_dir().context("failed to resolve resource dir")?;
    let public_dir   = resource_dir.join("public");

    // Downloads land in the OS app-data dir so they survive app updates.
    let download_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data dir")?
        .join("downloads");

    // Spawn the Node SEA server. The sidecar identifier must match the
    // externalBin key in tauri.conf.json exactly (no binaries/ prefix here).
    let (_rx, child) = app
        .shell()
        .sidecar("ytdl-server")
        .context("ytdl-server sidecar not registered in tauri.conf.json")?
        .env("YTDL_PORT",         PORT.to_string())
        .env("YTDLP_PATH",        ytdlp_path.to_str().unwrap_or("yt-dlp"))
        .env("FFMPEG_PATH",       ffmpeg_path.to_str().unwrap_or("ffmpeg"))
        .env("YTDL_PUBLIC_DIR",   public_dir.to_str().unwrap_or("public"))
        .env("YTDL_DOWNLOAD_DIR", download_dir.to_str().unwrap_or("downloads"))
        .spawn()
        .context("failed to spawn ytdl-server sidecar")?;

    app.manage(ServerProcess(Arc::new(Mutex::new(Some(child)))));

    // Tray icon embedded at compile time from the generated 32x32 PNG.
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .context("failed to load tray icon (run: npm run build:icons)")?;

    let url        = format!("http://localhost:{PORT}");
    let url_open   = url.clone();
    let url_thread = url.clone();

    let open_item = MenuItem::with_id(app, "open", "Open YTDL", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit",      true, None::<&str>)?;
    let menu      = Menu::with_items(app, &[&open_item, &quit_item])?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("YTDL — YouTube Downloader")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => { let _ = app.opener().open_url(&url_open, None::<&str>); }
            "quit" => {
                if let Some(state) = app.try_state::<ServerProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = tray.app_handle().opener().open_url(&url, None::<&str>);
            }
        })
        .build(app)?;

    // Open browser ~1.5 s after launch so the Node server has time to bind.
    let app_handle = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let _ = app_handle.opener().open_url(&url_thread, None::<&str>);
    });

    Ok(())
}
