// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

use crate::mpv::{MpvState, PlayerState};
use tauri::{command, AppHandle, Runtime, State};

#[command]
pub async fn mpv_load<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, MpvState>,
    url: String,
    start_pos: Option<f64>,
    hwdec: Option<bool>,
) -> Result<(), String> {
    let hwdec = hwdec.unwrap_or(true);
    tracing::info!("[MPV cmd] load url={} start_pos={:?} hwdec={}", url, start_pos, hwdec);
    state.load(&url, start_pos, hwdec, &app)?;
    tracing::debug!("[MPV cmd] load complete, state={:?}", state.get_state());
    Ok(())
}

#[command]
pub async fn mpv_play<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, MpvState>,
) -> Result<(), String> {
    tracing::info!("[MPV cmd] play");
    state.play()?;
    Ok(())
}

#[command]
pub async fn mpv_pause<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, MpvState>,
) -> Result<(), String> {
    tracing::info!("[MPV cmd] pause");
    state.pause()?;
    Ok(())
}

#[command]
pub async fn mpv_stop<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, MpvState>,
) -> Result<(), String> {
    tracing::info!("[MPV cmd] stop");
    state.stop();
    Ok(())
}

#[command]
pub async fn mpv_seek<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, MpvState>,
    position: f64,
) -> Result<(), String> {
    tracing::debug!("[MPV cmd] seek position={}", position);
    state.seek(position)?;
    Ok(())
}

#[command]
pub async fn mpv_set_volume<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, MpvState>,
    volume: f64,
) -> Result<(), String> {
    tracing::debug!("[MPV cmd] set_volume volume={}", volume);
    state.set_volume(volume)?;
    Ok(())
}

#[command]
pub async fn mpv_set_bounds<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, MpvState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    state.set_bounds(x, y, w, h);
    Ok(())
}

#[command]
pub async fn mpv_set_visible<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, MpvState>,
    visible: bool,
) -> Result<(), String> {
    state.set_visible(visible);
    Ok(())
}

#[command]
pub async fn mpv_set_media_info<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, MpvState>,
    title: Option<String>,
    live: bool,
) -> Result<(), String> {
    state.set_media_info(title, live);
    Ok(())
}

#[command]
pub async fn mpv_sub_add<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, MpvState>,
    path: String,
) -> Result<(), String> {
    tracing::info!("[MPV cmd] sub_add path={}", path);
    state.sub_add(&path)?;
    Ok(())
}

#[command]
pub async fn mpv_sub_remove<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, MpvState>,
    id: i64,
) -> Result<(), String> {
    tracing::info!("[MPV cmd] sub_remove id={}", id);
    state.sub_remove(id)?;
    Ok(())
}

#[command]
pub async fn mpv_set_sub_pos(
    pos: f64,
    state: tauri::State<'_, MpvState>,
) -> Result<(), String> {
    tracing::info!("[MPV] set_sub_pos: {}", pos);
    state.set_sub_pos(pos)
}

#[command]
pub async fn mpv_set_sub_delay(
    delay: f64,
    state: tauri::State<'_, MpvState>,
) -> Result<(), String> {
    tracing::info!("[MPV] set_sub_delay: {}", delay);
    state.set_sub_delay(delay)
}

#[command]
pub async fn mpv_get_state<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, MpvState>,
) -> Result<PlayerState, String> {
    let s = state.get_state();
    tracing::trace!("[MPV cmd] get_state -> playing={} url={:?}", s.is_playing, s.current_url);
    Ok(s)
}
