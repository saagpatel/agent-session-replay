//! Tauri desktop shell for Agent Session Replay.
//!
//! The viewer is entirely client-side — transcripts are parsed and rendered in
//! the webview, and nothing ever leaves the machine — so the Rust side owns no
//! commands. It exists only to host the local-first SPA in a native window.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Agent Session Replay");
}
