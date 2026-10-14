// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Tauri refuses a plugin command unless one of the app's capabilities
//! grants a permission for it. A command the mpv plugin registers but leaves
//! out of its permissions passes the plugin's own tests and still fails in
//! the app, so these tests send the frontend's mpv calls through the app's
//! real capabilities.

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::utils::config::AppDirectoriesOverride;
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindowBuilder};
use tempfile::TempDir;

/// The app with the capabilities `run` builds it with, on the mock runtime
/// and with its folders in `dir`.
fn app(dir: &TempDir) -> App<MockRuntime> {
    let mut context = tauri::generate_context!(test = true);
    // The real identifier would point the app's folders at the user's data
    // if the override below were ever dropped.
    context.config_mut().identifier = "com.maxvideoplayer.test".into();
    context.config_mut().app.app_directories_override =
        Some(AppDirectoriesOverride::Root(dir.path().join("app")));
    mock_builder()
        .plugin(tauri_plugin_mpv::init())
        .build(context)
        .expect("build the app")
}

/// Calls `command` from the main window's page with no arguments and
/// returns the error, if any. A command that takes arguments is refused for
/// the first one it misses, after the permission check and before it runs.
fn call(app: &App<MockRuntime>, command: &str) -> Option<String> {
    let webview = match app.get_webview_window("main") {
        Some(webview) => webview,
        None => WebviewWindowBuilder::new(app, "main", Default::default())
            .build()
            .expect("open a mock webview"),
    };
    let request = InvokeRequest {
        cmd: command.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().unwrap(),
        body: InvokeBody::Json(json!({})),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.into(),
    };
    get_ipc_response(&webview, request)
        .err()
        .map(|error| match error {
            Value::String(message) => message,
            other => other.to_string(),
        })
}

/// Every `plugin:mpv|` command `src/lib/tauri.ts` calls.
fn frontend_mpv_commands() -> Vec<String> {
    include_str!("../../src/lib/tauri.ts")
        .split("\"plugin:mpv|")
        .skip(1)
        .map(|rest| format!("plugin:mpv|{}", rest.split('"').next().unwrap()))
        .collect()
}

#[test]
fn the_page_may_call_every_mpv_command_the_frontend_uses() {
    let dir = tempfile::tempdir().expect("create a folder for the app");
    let app = app(&dir);
    let commands = frontend_mpv_commands();
    assert!(
        commands
            .iter()
            .any(|command| command == "plugin:mpv|mpv_load"),
        "found no mpv calls in src/lib/tauri.ts: {commands:?}"
    );
    for command in commands {
        if let Some(error) = call(&app, &command) {
            assert!(
                !error.contains("not allowed") && !error.contains("not found"),
                "{command} was refused: {error}"
            );
        }
    }
}

/// Shows the test above can tell a refused command from one that ran.
#[test]
fn the_page_may_not_call_an_mpv_command_no_permission_names() {
    let dir = tempfile::tempdir().expect("create a folder for the app");
    let app = app(&dir);
    let error = call(&app, "plugin:mpv|mpv_no_such_command").expect("a refusal");
    assert!(error.contains("not allowed"), "{error}");
}
