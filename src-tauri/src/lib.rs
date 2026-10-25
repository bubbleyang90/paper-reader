pub mod document;

use document::{Document, Rendered};
use std::path::Path;

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
async fn get_startup_document() -> Result<Option<Document>, String> {
    background(|| {
        std::env::args_os()
            .skip(1)
            .find(|arg| document::is_document_path(Path::new(arg)))
            .map(|arg| document::read(Path::new(&arg)))
            .transpose()
    })
    .await
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
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_document,
            read_document,
            render_markdown,
            get_startup_document,
            read_local_image,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("Paper 启动失败");
}
