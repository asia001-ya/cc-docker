//! 壁纸资源：导入到应用数据目录，严格限制访问范围，保存配置与草稿资源各自管理。

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const IMAGE_LIMIT: u64 = 40 * 1024 * 1024;
const VIDEO_LIMIT: u64 = 500 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WallpaperKind {
    Image,
    Video,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperAsset {
    pub file_name: String,
    pub original_name: String,
    pub kind: WallpaperKind,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WallpaperFit {
    #[default]
    Cover,
    Contain,
    Fill,
    Center,
    Tile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct WallpaperSettings {
    pub asset: Option<WallpaperAsset>,
    pub fit: WallpaperFit,
    pub opacity: u8,
    pub blur: u8,
    pub dim: u8,
    pub terminal_opacity: u8,
    pub panel_opacity: u8,
    pub glass_blur: u8,
}

impl Default for WallpaperSettings {
    fn default() -> Self {
        Self {
            asset: None,
            fit: WallpaperFit::Cover,
            opacity: 75,
            blur: 0,
            dim: 25,
            terminal_opacity: 20,
            panel_opacity: 75,
            glass_blur: 0,
        }
    }
}

impl WallpaperSettings {
    /// IPC 保存时严格校验，不能将外部路径伪装成已导入的资源。
    pub fn validate(&self, directory: &Path) -> AppResult<()> {
        if self.opacity > 100 || self.dim > 100 || self.terminal_opacity > 100 || self.panel_opacity > 100 {
            return Err(AppError::Invalid("壁纸透明度与压暗数值必须在 0–100 之间".into()));
        }
        if self.blur > 40 || self.glass_blur > 40 {
            return Err(AppError::Invalid("壁纸与玻璃模糊必须在 0–40 px 之间".into()));
        }
        if let Some(asset) = &self.asset {
            if asset.original_name.is_empty()
                || asset.original_name.contains(['/', '\\', '\0'])
                || asset.original_name.chars().count() > 255
            {
                return Err(AppError::Invalid("壁纸原始文件名无效".into()));
            }
            let path = resolve(directory, &asset.file_name)?;
            let extension = extension(&path)?;
            ensure_kind(&extension, asset.kind)?;
            let mut file = File::open(path)?;
            validate_media(&mut file, &extension, asset.kind)?;
        }
        Ok(())
    }

    /// 读取磁盘设置时修复数值，避免损坏的外观字段影响终端、Docker 等其它配置。
    pub fn normalize_loaded(&mut self) {
        self.opacity = self.opacity.min(100);
        self.dim = self.dim.min(100);
        self.terminal_opacity = self.terminal_opacity.min(100);
        self.panel_opacity = self.panel_opacity.min(100);
        self.blur = self.blur.min(40);
        self.glass_blur = self.glass_blur.min(40);
    }
}

/// 只开放常见浏览器可解码的静态/动图与视频容器；不接受 SVG、HTML 或任意文件。
fn ensure_kind(extension: &str, kind: WallpaperKind) -> AppResult<()> {
    let supported = match kind {
        WallpaperKind::Image => matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"),
        WallpaperKind::Video => matches!(extension, "mp4" | "webm"),
    };
    if supported {
        Ok(())
    } else {
        Err(AppError::Invalid("壁纸文件格式与所选类型不符或不受支持".into()))
    }
}

fn extension(path: &Path) -> AppResult<String> {
    path.extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| AppError::Invalid("壁纸文件缺少有效扩展名".into()))
}

fn limit(kind: WallpaperKind) -> u64 {
    match kind {
        WallpaperKind::Image => IMAGE_LIMIT,
        WallpaperKind::Video => VIDEO_LIMIT,
    }
}

fn validate_media(file: &mut File, extension: &str, kind: WallpaperKind) -> AppResult<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit(kind) {
        return Err(AppError::Invalid(match kind {
            WallpaperKind::Image => "请选择非空图片文件（最大 40 MiB）".into(),
            WallpaperKind::Video => "请选择非空视频文件（最大 500 MiB）".into(),
        }));
    }
    file.seek(SeekFrom::Start(0))?;
    let mut header = [0_u8; 4096];
    let count = file.read(&mut header)?;
    let h = &header[..count];
    // 这里验证媒体容器基本签名；具体编解码器兼容性由 WebView 的加载事件反馈。
    let valid = match extension {
        "png" => {
            h.len() >= 33
                && h.starts_with(b"\x89PNG\r\n\x1a\n")
                && &h[12..16] == b"IHDR"
                && h[16..20] != [0; 4]
                && h[20..24] != [0; 4]
        }
        "jpg" | "jpeg" => h.len() >= 4 && h.starts_with(b"\xff\xd8\xff"),
        "gif" => h.len() >= 13 && (h.starts_with(b"GIF87a") || h.starts_with(b"GIF89a")),
        "webp" => h.len() >= 20 && h.starts_with(b"RIFF") && &h[8..12] == b"WEBP",
        "bmp" => h.len() >= 26 && h.starts_with(b"BM"),
        "mp4" => {
            h.len() >= 24
                && &h[4..8] == b"ftyp"
                && matches!(
                    &h[8..12],
                    b"isom"
                        | b"iso2"
                        | b"iso3"
                        | b"iso4"
                        | b"iso5"
                        | b"iso6"
                        | b"iso7"
                        | b"iso8"
                        | b"iso9"
                        | b"mp41"
                        | b"mp42"
                        | b"avc1"
                        | b"M4V "
                        | b"MSNV"
                        | b"dash"
                )
        }
        "webm" => h.starts_with(b"\x1a\x45\xdf\xa3") && h.windows(4).any(|part| part == b"webm"),
        _ => false,
    };
    if !valid {
        return Err(AppError::Invalid("壁纸文件内容与扩展名不符，或媒体文件已损坏".into()));
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(())
}

#[cfg(windows)]
fn is_link(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT，包括 junction
}

#[cfg(not(windows))]
fn is_link(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn managed_directory(directory: &Path, create: bool) -> AppResult<PathBuf> {
    if create {
        fs::create_dir_all(directory)?;
    }
    let metadata = fs::symlink_metadata(directory)?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(AppError::Invalid("壁纸管理目录不能是链接或其它文件".into()));
    }
    Ok(directory.canonicalize()?)
}

fn managed_file_name(file_name: &str) -> AppResult<()> {
    if file_name.contains(['/', '\\', ':', '\0']) {
        return Err(AppError::Invalid("壁纸资源名称无效".into()));
    }
    let path = Path::new(file_name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
    if uuid::Uuid::parse_str(stem).map(|id| id.hyphenated().to_string() != stem).unwrap_or(true) {
        return Err(AppError::Invalid("只允许访问应用导入的壁纸资源".into()));
    }
    let extension = extension(path)?;
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "mp4" | "webm") {
        return Err(AppError::Invalid("壁纸资源扩展名无效".into()));
    }
    Ok(())
}

/// 返回可信管理文件的绝对路径，供前端使用 convertFileSrc。
pub fn resolve(directory: &Path, file_name: &str) -> AppResult<PathBuf> {
    managed_file_name(file_name)?;
    let root = managed_directory(directory, false)?;
    let path = root.join(file_name);
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err(AppError::Invalid("壁纸资源必须是管理目录中的普通文件".into()));
    }
    let canonical = path.canonicalize()?;
    if canonical.parent() != Some(root.as_path()) {
        return Err(AppError::Invalid("壁纸资源不属于应用管理目录".into()));
    }
    Ok(canonical)
}

/// 复制媒体到唯一文件；失败清理本次创建的文件，绝不修改源文件。
pub fn import(directory: &Path, source: &Path, kind: WallpaperKind) -> AppResult<WallpaperAsset> {
    if !source.is_absolute() {
        return Err(AppError::Invalid("请选择壁纸文件的绝对路径".into()));
    }
    let extension = extension(source)?;
    ensure_kind(&extension, kind)?;
    let original_name = source
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|name| !name.contains(['/', '\\', '\0']) && name.chars().count() <= 255)
        .ok_or_else(|| AppError::Invalid("壁纸文件名无效".into()))?
        .to_string();
    let mut input = File::open(source)?;
    validate_media(&mut input, &extension, kind)?;
    let root = managed_directory(directory, true)?;
    let file_name = format!("{}.{}", uuid::Uuid::new_v4(), extension);
    let destination = root.join(&file_name);
    let mut output = OpenOptions::new().read(true).write(true).create_new(true).open(&destination)?;
    let copied = (|| -> AppResult<()> {
        let bytes = std::io::copy(&mut input.take(limit(kind) + 1), &mut output)?;
        if bytes > limit(kind) {
            return Err(AppError::Invalid("导入期间壁纸文件大小超过限制".into()));
        }
        output.sync_all()?;
        validate_media(&mut output, &extension, kind)?;
        Ok(())
    })();
    drop(output);
    if let Err(error) = copied {
        let _ = fs::remove_file(&destination);
        return Err(error);
    }
    Ok(WallpaperAsset { file_name, original_name, kind })
}

/// 调用方必须与设置保存串行，并先检查当前配置引用。
pub fn delete(directory: &Path, file_name: &str) -> AppResult<()> {
    managed_file_name(file_name)?;
    // 清理草稿可重复执行；其它错误仍报告给 UI，不能默默绕过范围校验。
    match resolve(directory, file_name) {
        Ok(path) => Ok(fs::remove_file(path)?),
        Err(AppError::Io(_)) if !directory.join(file_name).try_exists()? => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub struct TestDirectory(pub PathBuf);

    impl TestDirectory {
        pub fn new() -> Self {
            let path = std::env::temp_dir().join(format!("tdc-wallpaper-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        pub fn image(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            // 有效的 1 × 1 PNG，包含 IHDR、IDAT、IEND。
            fs::write(
                &path,
                [
                    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
                    0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5, 1, 1, 39, 24,
                    227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
                ],
            )
            .unwrap();
            path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn 图片导入为独立文件且删除或移动源文件后仍然有效() {
        let directory = TestDirectory::new();
        let source = directory.image("测试壁纸.PNG");
        let expected = fs::read(&source).unwrap();
        let managed = directory.0.join("wallpapers");
        let asset = import(&managed, &source, WallpaperKind::Image).unwrap();
        assert_eq!(asset.original_name, "测试壁纸.PNG");
        assert!(asset.file_name.ends_with(".png"));
        fs::remove_file(source).unwrap();
        let resolved = resolve(&managed, &asset.file_name).unwrap();
        assert_eq!(fs::read(resolved).unwrap(), expected);
        WallpaperSettings { asset: Some(asset), ..Default::default() }.validate(&managed).unwrap();
    }

    #[test]
    fn 同名文件多次导入不会覆盖之前的资源() {
        let directory = TestDirectory::new();
        let source = directory.image("photo.png");
        let managed = directory.0.join("wallpapers");
        let first = import(&managed, &source, WallpaperKind::Image).unwrap();
        let second = import(&managed, &source, WallpaperKind::Image).unwrap();
        assert_ne!(first.file_name, second.file_name);
        assert!(resolve(&managed, &first.file_name).is_ok());
        assert!(resolve(&managed, &second.file_name).is_ok());
    }

    #[test]
    fn 拒绝伪装媒体和错误类型且不产生垃圾文件() {
        let directory = TestDirectory::new();
        let source = directory.0.join("fake.png");
        fs::write(&source, b"<html><script>alert(1)</script></html>").unwrap();
        let managed = directory.0.join("wallpapers");
        assert!(import(&managed, &source, WallpaperKind::Image).is_err());
        let source = directory.image("real.png");
        assert!(import(&managed, &source, WallpaperKind::Video).is_err());
        assert!(import(&managed, Path::new("relative.png"), WallpaperKind::Image).is_err());
        assert!(!managed.exists());
    }

    #[test]
    fn 拒绝超限图片和视频() {
        let directory = TestDirectory::new();
        for (name, kind, size) in
            [("large.png", WallpaperKind::Image, IMAGE_LIMIT + 1), ("large.mp4", WallpaperKind::Video, VIDEO_LIMIT + 1)]
        {
            let source = directory.0.join(name);
            File::create(&source).unwrap().set_len(size).unwrap();
            assert!(import(&directory.0.join("wallpapers"), &source, kind).is_err());
        }
    }

    #[test]
    fn 支持mp4和webm基本容器签名() {
        let directory = TestDirectory::new();
        let managed = directory.0.join("wallpapers");
        for (name, header) in [
            ("clip.mp4", &b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42"[..]),
            ("clip.webm", &b"\x1a\x45\xdf\xa3\x87\x42\x82\x84webm"[..]),
        ] {
            let source = directory.0.join(name);
            fs::write(&source, header).unwrap();
            let asset = import(&managed, &source, WallpaperKind::Video).unwrap();
            assert_eq!(asset.kind, WallpaperKind::Video);
            assert_eq!(fs::read(resolve(&managed, &asset.file_name).unwrap()).unwrap(), header);
        }
    }

    #[test]
    fn 路径穿越和非管理文件不可读取或删除() {
        let directory = TestDirectory::new();
        let source = directory.image("outside.png");
        let managed = directory.0.join("wallpapers");
        fs::create_dir_all(&managed).unwrap();
        for name in ["../outside.png", "..\\outside.png", "C:\\outside.png", "outside.png", "../settings.json"] {
            assert!(resolve(&managed, name).is_err());
            assert!(delete(&managed, name).is_err());
        }
        assert!(source.exists());
    }

    #[test]
    fn 草稿资源删除可重复执行() {
        let directory = TestDirectory::new();
        let source = directory.image("draft.png");
        let managed = directory.0.join("wallpapers");
        let asset = import(&managed, &source, WallpaperKind::Image).unwrap();
        delete(&managed, &asset.file_name).unwrap();
        delete(&managed, &asset.file_name).unwrap();
        assert!(source.exists());
        assert!(resolve(&managed, &asset.file_name).is_err());
    }

    #[test]
    fn 设置必须引用存在且类型正确的管理文件并限制数值() {
        let directory = TestDirectory::new();
        let source = directory.image("asset.png");
        let managed = directory.0.join("wallpapers");
        let asset = import(&managed, &source, WallpaperKind::Image).unwrap();
        let settings = WallpaperSettings { asset: Some(asset.clone()), ..Default::default() };
        settings.validate(&managed).unwrap();
        assert!(WallpaperSettings { opacity: 101, ..settings.clone() }.validate(&managed).is_err());
        assert!(WallpaperSettings { dim: 101, ..settings.clone() }.validate(&managed).is_err());
        assert!(WallpaperSettings { terminal_opacity: 101, ..settings.clone() }.validate(&managed).is_err());
        assert!(WallpaperSettings { panel_opacity: 101, ..settings.clone() }.validate(&managed).is_err());
        assert!(WallpaperSettings { blur: 41, ..settings.clone() }.validate(&managed).is_err());
        assert!(WallpaperSettings { glass_blur: 41, ..settings.clone() }.validate(&managed).is_err());
        let bad_kind = WallpaperAsset { kind: WallpaperKind::Video, ..asset.clone() };
        assert!(WallpaperSettings { asset: Some(bad_kind), ..settings.clone() }.validate(&managed).is_err());
        delete(&managed, &asset.file_name).unwrap();
        assert!(settings.validate(&managed).is_err());
    }

    #[test]
    fn 明确拒绝未支持的铺放和媒体类型() {
        assert!(serde_json::from_str::<WallpaperSettings>(r#"{"fit":"unknown"}"#).is_err());
        assert!(serde_json::from_str::<WallpaperKind>(r#""html""#).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn 拒绝指向管理目录外部的符号链接() {
        use std::os::unix::fs::symlink;

        let directory = TestDirectory::new();
        let source = directory.image("outside.png");
        let managed = directory.0.join("wallpapers");
        fs::create_dir_all(&managed).unwrap();
        let name = format!("{}.png", uuid::Uuid::new_v4());
        symlink(&source, managed.join(&name)).unwrap();
        assert!(resolve(&managed, &name).is_err());
        assert!(delete(&managed, &name).is_err());
        assert!(source.exists());
    }
}
