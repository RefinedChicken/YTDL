#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
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
            // macOS: run as background agent — no Dock icon, no App Switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Resolve bundled sidecar paths from the directory containing this binary.
            // Tauri strips the target-triple suffix, so yt-dlp-aarch64-apple-darwin
            // becomes yt-dlp in the final bundle alongside the main binary.
            let exe_dir = std::env::current_exe()
                .unwrap()
                .parent()
                .unwrap()
                .to_path_buf();

            let ext = if cfg!(windows) { ".exe" } else { "" };
            let ytdlp_path  = exe_dir.join(format!("yt-dlp{}", ext));
            let ffmpeg_path = exe_dir.join(format!("ffmpeg{}", ext));

            // public/ lives in the Tauri resource directory (bundled via tauri.conf.json resources).
            let public_dir = app.path().resource_dir().unwrap().join("public");

            // Downloads go to the OS-appropriate app data directory.
            let download_dir = app.path().app_data_dir().unwrap().join("downloads");

            // Spawn the Node SEA server sidecar.
            let (_rx, child) = app
                .shell()
                .sidecar("binaries/ytdl-server")
                .unwrap()
                .env("YTDL_PORT",         PORT.to_string())
                .env("YTDLP_PATH",        ytdlp_path.to_str().unwrap_or("yt-dlp"))
                .env("FFMPEG_PATH",       ffmpeg_path.to_str().unwrap_or("ffmpeg"))
                .env("YTDL_PUBLIC_DIR",   public_dir.to_str().unwrap_or("public"))
                .env("YTDL_DOWNLOAD_DIR", download_dir.to_str().unwrap_or("downloads"))
                .spawn()
                .expect("failed to spawn ytdl-server sidecar");

            app.manage(ServerProcess(Arc::new(Mutex::new(Some(child)))));

            // Build tray icon from the compile-time embedded 32x32 PNG.
            let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
                .expect("tray icon missing — run: npm run build:icons");

            let url        = format!("http://localhost:{}", PORT);
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
                    "open" => {
                        let _ = app.opener().open_url(&url_open, None::<&str>);
                    }
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
                    // Left-click opens the browser; right-click shows the menu (default).
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

            // Open the browser ~1.5 s after launch to let the Node server bind its port.
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                let _ = app_handle.opener().open_url(&url_thread, None::<&str>);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
