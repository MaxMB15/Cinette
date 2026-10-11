#[cfg(target_os = "ios")]
extern "C" {
    fn ios_play_url(url: *const std::os::raw::c_char) -> i32;
    fn ios_play_mpv_url(url: *const std::os::raw::c_char) -> i32;
}

#[cfg(target_os = "ios")]
fn call_ios_bridge(url: &str, mpv: bool) -> Result<(), String> {
    let c_url = std::ffi::CString::new(url).map_err(|e| e.to_string())?;
    let rc = unsafe {
        if mpv { ios_play_mpv_url(c_url.as_ptr()) } else { ios_play_url(c_url.as_ptr()) }
    };
    if rc == 0 { Ok(()) } else { Err(format!("ios bridge rc={rc}")) }
}

#[cfg(not(target_os = "ios"))]
fn call_ios_bridge(_url: &str, _mpv: bool) -> Result<(), String> { Ok(()) }

#[tauri::command]
fn play_url(url: String) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    let engine = "AVPlayer (iOS)";
    #[cfg(not(target_os = "ios"))]
    let engine = "desktop-stub";

    call_ios_bridge(&url, false)?;
    println!("[mvp-ios-poc] play_url: engine={engine} url={url}");
    Ok(format!("{engine} → {url}"))
}

#[tauri::command]
fn play_url_mpv(url: String) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    let engine = "libmpv (iOS)";
    #[cfg(not(target_os = "ios"))]
    let engine = "desktop-stub";

    call_ios_bridge(&url, true)?;
    println!("[mvp-ios-poc] play_url_mpv: engine={engine} url={url}");
    Ok(format!("{engine} → {url}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![play_url, play_url_mpv])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
