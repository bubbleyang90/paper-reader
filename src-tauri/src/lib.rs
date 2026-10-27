pub mod document;
mod launch;

use document::{Document, Rendered};
use std::path::Path;
#[cfg(windows)]
use tauri::{Emitter, Manager};

// Parsing, disk access and dialogs run away from the UI thread. There are no
// polling loops, background document watchers or persistent document caches.
async fn background<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("后台任务失败：{error}"))?
}

#[tauri::command]
async fn open_document() -> Result<Option<Document>, String> {
    background(|| {
        rfd::FileDialog::new()
            .set_title("在 Paper 中打开 Markdown")
            .add_filter("Markdown / 文本", &["md", "markdown", "mdown", "txt"])
            .pick_file()
            .map(|path| document::read(&path))
            .transpose()
    })
    .await
}

#[tauri::command]
async fn read_document(path: String) -> Result<Document, String> {
    background(move || document::read(Path::new(&path))).await
}

#[tauri::command]
async fn render_markdown(source: String) -> Result<Rendered, String> {
    background(move || document::render(&source)).await
}

#[tauri::command]
fn take_pending_documents(
    pending: tauri::State<'_, launch::PendingDocuments>,
) -> Vec<std::path::PathBuf> {
    pending.take()
}

#[tauri::command]
async fn open_default_apps() -> Result<(), String> {
    #[cfg(windows)]
    {
        background(|| {
            open::that("ms-settings:defaultapps?registeredAppUser=Paper")
                .map_err(|error| format!("无法打开 Windows 默认应用设置：{error}"))
        })
        .await
    }
    #[cfg(not(windows))]
    {
        Err("默认应用设置仅适用于 Windows 安装版".into())
    }
}

#[tauri::command]
async fn read_local_image(document_path: String, image_path: String) -> Result<String, String> {
    background(move || document::read_image(Path::new(&document_path), &image_path)).await
}

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    background(move || {
        let validated = document::external_url(&url)?;
        open::that(validated.as_str()).map_err(|error| format!("无法打开浏览器：{error}"))
    })
    .await
}

pub fn run() {
    let pending = launch::PendingDocuments::default();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    pending.enqueue(launch::document_paths(std::env::args_os(), &cwd));
    let builder = tauri::Builder::default().manage(pending);
    // Register this first: secondary launches forward their arguments and exit.
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        app.state::<launch::PendingDocuments>()
            .enqueue(launch::document_paths(args, Path::new(&cwd)));
        let _ = app.emit_to("main", "paper://open-documents", ());
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));
    builder
        .invoke_handler(tauri::generate_handler![
            open_document,
            read_document,
            render_markdown,
            take_pending_documents,
            open_default_apps,
            read_local_image,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("Paper 启动失败");
}
