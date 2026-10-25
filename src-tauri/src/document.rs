//! Pure, testable document operations. This module never writes user documents.
use base64::{engine::general_purpose::STANDARD, Engine};
use pulldown_cmark::{html, Event, Options, Parser};
use serde::Serialize;
use std::{
    borrow::Cow,
    collections::HashSet,
    fs::File,
    io::Read,
    path::{Component, Path},
};

pub const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub path: String,
    pub name: String,
    pub source: String,
    pub html: String,
    pub word_count: usize,
    pub reading_minutes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendered {
    pub html: String,
    pub word_count: usize,
    pub reading_minutes: usize,
}

pub fn is_document_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["md", "markdown", "mdown", "txt"]
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

fn user_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    // Windows canonicalize returns a verbatim path. The frontend composes
    // relative Markdown links, whose `..` components must retain normal Windows
    // semantics, and users should see a conventional drive/UNC path.
    #[cfg(windows)]
    {
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(drive) = path.strip_prefix(r"\\?\") {
            if drive.as_bytes().get(1) == Some(&b':') {
                return drive.to_string();
            }
        }
    }
    path.into_owned()
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|error| format!("无法打开文件：{error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("请选择文件，不能打开文件夹或设备。".into());
    }
    if metadata.len() > limit {
        return Err(format!("文件过大，最大支持 {} MiB。", limit / 1024 / 1024));
    }
    // A hard read limit also covers a file growing after the metadata check.
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取文件：{error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("文件过大，最大支持 {} MiB。", limit / 1024 / 1024));
    }
    Ok(bytes)
}

pub fn read(path: &Path) -> Result<Document, String> {
    if !is_document_path(path) {
        return Err("支持的文件格式：.md、.markdown、.mdown、.txt。".into());
    }
    let path = path
        .canonicalize()
        .map_err(|error| format!("找不到文件：{error}"))?;
    let bytes = read_limited(&path, MAX_DOCUMENT_BYTES)?;
    let mut source = String::from_utf8(bytes)
        .map_err(|_| "文件不是有效的 UTF-8 文本，请转换为 UTF-8 编码后打开。".to_string())?;
    if source.starts_with('\u{feff}') {
        source.drain(..3);
    }
    let rendered = render(&source)?;
    Ok(Document {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: user_path(&path),
        source,
        html: rendered.html,
        word_count: rendered.word_count,
        reading_minutes: rendered.reading_minutes,
    })
}

/// CJK characters count individually; other letters/numbers count by word.
fn count_words(text: &str) -> usize {
    let mut count = 0;
    let mut in_word = false;
    for ch in text.chars() {
        let cjk = matches!(ch as u32,
            0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF |
            0x20000..=0x323AF | 0x3040..=0x30FF | 0xAC00..=0xD7AF);
        if cjk {
            count += 1;
            in_word = false;
        } else if ch.is_alphanumeric() {
            if !in_word {
                count += 1;
            }
            in_word = true;
        } else if ch != '\'' && ch != '’' {
            in_word = false;
        }
    }
    count
}

pub fn render(source: &str) -> Result<Rendered, String> {
    if source.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("文档过大，最大支持 16 MiB。".into());
    }
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_GFM;
    let mut word_count = 0;
    let parser = Parser::new_ext(source, options).inspect(|event| {
        if let Event::Text(text) | Event::Code(text) = event {
            word_count += count_words(text);
        }
    });
    let mut rendered = String::with_capacity(source.len() + source.len() / 4);
    html::push_html(&mut rendered, parser);

    // Markdown is untrusted: scripts, handlers, embeds, CSS and active URLs are
    // stripped before anything reaches the WebView. Task checkboxes are inert.
    let safe_html = ammonia::Builder::default()
        .url_schemes(HashSet::from(["http", "https"]))
        .add_tags(["input"])
        .add_generic_attributes(["id"])
        .add_tag_attributes("code", ["class"])
        .add_tag_attributes("div", ["class"])
        .add_tag_attributes("sup", ["class"])
        .add_tag_attributes("blockquote", ["class"])
        .add_tag_attributes("input", ["type", "checked", "disabled"])
        .set_tag_attribute_value("input", "type", "checkbox")
        .set_tag_attribute_value("input", "disabled", "")
        .attribute_filter(|element, attribute, value| {
            // Preserve only parser-produced styling hooks; raw HTML classes
            // cannot impersonate application controls or hide document content.
            if attribute == "class" {
                let allowed = match element {
                    "code" => {
                        value.starts_with("language-") && !value.chars().any(char::is_whitespace)
                    }
                    "div" => value == "footnote-definition",
                    "sup" => matches!(value, "footnote-reference" | "footnote-definition-label"),
                    "blockquote" => value.starts_with("markdown-alert"),
                    _ => false,
                };
                return allowed.then_some(Cow::Borrowed(value));
            }
            Some(Cow::Borrowed(value))
        })
        .clean(&rendered)
        .to_string();

    Ok(Rendered {
        html: safe_html,
        word_count,
        reading_minutes: word_count.div_ceil(300).max(1),
    })
}

pub fn external_url(value: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(value).map_err(|_| "链接地址无效。".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("只允许在浏览器中打开 HTTP 或 HTTPS 链接。".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("不支持包含登录凭据的链接。".into());
    }
    Ok(parsed)
}

pub fn read_image(document_path: &Path, image_path: &str) -> Result<String, String> {
    if !is_document_path(document_path) {
        return Err("图片必须关联一个 Markdown 文档。".into());
    }
    let document = document_path
        .canonicalize()
        .map_err(|_| "找不到原始文档。".to_string())?;
    if !document.is_file() {
        return Err("找不到原始文档。".into());
    }
    let root = document.parent().ok_or("文档目录无效。")?;
    let without_suffix = image_path.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_encoding::percent_decode_str(without_suffix)
        .decode_utf8()
        .map_err(|_| "图片路径编码无效。".to_string())?;
    // Reject schemes, Windows drive/ADS paths, UNC paths and rooted paths.
    if decoded.is_empty() || decoded.contains(':') || decoded.contains('\0') {
        return Err("只支持文档目录内的相对图片路径。".into());
    }
    let relative = Path::new(decoded.as_ref());
    if relative
        .components()
        .any(|part| matches!(part, Component::Prefix(_) | Component::RootDir))
    {
        return Err("只支持文档目录内的相对图片路径。".into());
    }
    let resolved = root
        .join(relative)
        .canonicalize()
        .map_err(|_| "找不到本地图片。".to_string())?;
    if !resolved.starts_with(root) {
        return Err("图片不能位于文档目录之外。".into());
    }
    let extension = resolved
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => return Err("本地图片支持 PNG、JPEG、GIF、WebP、BMP、AVIF。".into()),
    };
    let bytes = read_limited(&resolved, MAX_IMAGE_BYTES)?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn renders_gfm_and_chinese() {
        let source = "# 你好 Paper\n\n| 项目 | 状态 |\n| --- | --- |\n| Rust | 完成 |\n\n- [x] 任务\n\n~~删除~~\n\n正文[^note]\n\n[^note]: 注释\n";
        let rendered = render(source).unwrap();
        for fragment in [
            "<h1>", "<table>", "checkbox", "checked", "disabled", "<del>", "footnote", "你好",
        ] {
            assert!(
                rendered.html.contains(fragment),
                "missing {fragment}: {}",
                rendered.html
            );
        }
        assert!(rendered.word_count > 10);
        assert_eq!(count_words("你好 Rust world，纸页。"), 6);
    }

    #[test]
    fn strips_active_content_and_dangerous_links() {
        let source = "<script>window.evil = true</script>\n\n<img src=\"x\" onerror=\"evil()\">\n\n<a href=\"javascript:alert(1)\">bad</a>\n\n[bad](vbscript:evil)\n\n<iframe src=\"https://evil.test\"></iframe>\n\n<a href=\"https://example.org\">safe</a>";
        let output = render(source).unwrap().html;
        for forbidden in [
            "<script",
            "window.evil",
            "onerror",
            "javascript:",
            "vbscript:",
            "<iframe",
        ] {
            assert!(!output.contains(forbidden), "unsafe {forbidden}: {output}");
        }
        assert!(output.contains("https://example.org"));
    }

    #[test]
    fn keeps_code_escaped_and_forces_inert_checkboxes() {
        let output = render("```html\n<script>alert(1)</script>\n```\n\n<input type=\"text\" autofocus onfocus=\"evil()\">\n").unwrap().html;
        assert!(output.contains("&lt;script&gt;"));
        assert!(output.contains("language-html"));
        assert!(output.contains("type=\"checkbox\""));
        assert!(output.contains("disabled"));
        assert!(!output.contains("autofocus"));
        assert!(!output.contains("onfocus"));
    }

    #[test]
    fn reads_utf8_bom_and_rejects_unsupported_encoding() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("中文.MD");
        fs::write(&path, "\u{feff}# 纸页").unwrap();
        let document = read(&path).unwrap();
        assert_eq!(document.source, "# 纸页");
        assert_eq!(document.name, "中文.MD");
        fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read(&path).unwrap_err().contains("UTF-8"));
        assert!(read(&directory.path().join("file.exe")).is_err());
    }

    #[test]
    fn rejects_large_documents_before_reading() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.md");
        File::create(&path)
            .unwrap()
            .set_len(MAX_DOCUMENT_BYTES + 1)
            .unwrap();
        assert!(read(&path).unwrap_err().contains("过大"));
        assert!(render(&"a".repeat(MAX_DOCUMENT_BYTES as usize + 1)).is_err());
    }

    #[test]
    fn confines_images_and_rejects_large_or_active_files() {
        let directory = tempfile::tempdir().unwrap();
        let docs = directory.path().join("docs");
        fs::create_dir(&docs).unwrap();
        let document = docs.join("readme.md");
        fs::write(&document, "# test").unwrap();
        fs::write(docs.join("a b.png"), [0x89, b'P', b'N', b'G']).unwrap();
        fs::write(directory.path().join("outside.png"), "secret").unwrap();
        fs::write(docs.join("active.svg"), "<svg/>").unwrap();
        assert!(read_image(&document, "a%20b.png")
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(read_image(&document, "./a%20b.png").is_ok());
        for path in [
            "../outside.png",
            "%2e%2e/outside.png",
            "active.svg",
            "file:///tmp/a.png",
            "C:/a.png",
            "//server/a.png",
        ] {
            assert!(read_image(&document, path).is_err(), "accepted {path}");
        }
        File::create(docs.join("large.png"))
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();
        assert!(read_image(&document, "large.png")
            .unwrap_err()
            .contains("过大"));
    }

    #[test]
    fn validates_external_url_schemes() {
        assert!(external_url("https://example.org/docs?x=1&y=2").is_ok());
        for url in [
            "file:///etc/passwd",
            "javascript:evil()",
            "cmd://open",
            "https://user:pass@example.org",
            "//example.org",
        ] {
            assert!(external_url(url).is_err());
        }
    }

    #[test]
    fn returned_paths_support_parent_relative_links() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("chapter")).unwrap();
        let first = directory.path().join("chapter").join("first.md");
        fs::write(&first, "[next](../next.md)").unwrap();
        fs::write(directory.path().join("next.md"), "# Next").unwrap();
        let document = read(&first).unwrap();
        let parent = Path::new(&document.path).parent().unwrap();
        // This string concatenation mirrors the frontend's local link resolver.
        let link = format!(
            "{}{}..{}next.md",
            parent.display(),
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR
        );
        assert_eq!(read(Path::new(&link)).unwrap().name, "next.md");
    }
}
