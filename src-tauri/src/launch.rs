use crate::document;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// Keep launches until the webview has installed its listener. Events are only
/// wake-up signals; a launch before JavaScript is ready must not lose its file.
#[derive(Default)]
pub struct PendingDocuments(Mutex<Vec<PathBuf>>);

impl PendingDocuments {
    pub fn enqueue(&self, paths: impl IntoIterator<Item = PathBuf>) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(paths);
    }

    pub fn take(&self) -> Vec<PathBuf> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// Arguments already have OS quoting removed: never split on spaces or parse
/// them as a command. Resolve relative paths in the launching process's cwd.
pub fn document_paths<I, S>(args: I, cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .skip(1)
        .map(|arg| PathBuf::from(arg.as_ref()))
        .filter(|path| document::is_document_path(path))
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_executable_and_preserves_spaces_unicode_and_case() {
        let cwd = std::env::temp_dir().join("Paper launch tests");
        let paths = document_paths(
            ["Paper.md", "中文 笔记.MD", "notes.markdown", "photo.png"],
            &cwd,
        );
        assert_eq!(
            paths,
            vec![cwd.join("中文 笔记.MD"), cwd.join("notes.markdown")]
        );
    }

    #[test]
    fn resolves_against_sender_cwd_and_keeps_absolute_paths() {
        let cwd = std::env::temp_dir().join("sender");
        let absolute = std::env::temp_dir().join("absolute note.md");
        let paths = document_paths(
            vec![
                PathBuf::from("Paper.exe"),
                PathBuf::from("relative.md"),
                absolute.clone(),
            ],
            &cwd,
        );
        assert_eq!(paths, vec![cwd.join("relative.md"), absolute]);
    }

    #[test]
    fn queued_early_launches_are_taken_once_and_repeated_opens_are_kept() {
        let pending = PendingDocuments::default();
        let path = PathBuf::from("same 中文 file.md");
        pending.enqueue([path.clone()]);
        pending.enqueue([path.clone()]);
        assert_eq!(pending.take(), vec![path.clone(), path.clone()]);
        assert!(pending.take().is_empty());
        pending.enqueue([path.clone()]);
        assert_eq!(pending.take(), vec![path]);
    }

    #[test]
    fn no_document_arguments_leave_the_queue_empty() {
        assert!(document_paths(
            ["Paper.exe", "--help", "https://example.test/"],
            Path::new(".")
        )
        .is_empty());
    }
}
