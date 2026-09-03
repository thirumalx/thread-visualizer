use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let about_item = tauri::menu::MenuItem::with_id(app, "about", "About", true, None::<&str>)?;
            let help_submenu = tauri::menu::Submenu::with_items(app, "Help", true, &[&about_item])?;
            let menu = tauri::menu::Menu::with_items(app, &[&help_submenu])?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "about" {
                let _ = app.emit("show-about", ());
            }
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
