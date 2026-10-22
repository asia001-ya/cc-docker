//! 在主进程退出后安装已校验的更新。辅助进程使用当前程序的副本，
//! 在 Tauri 和单实例插件初始化前运行，不通过 shell 执行安装命令。

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use uuid::Uuid;

use super::{verify_file, InstallKind, PreparedUpdate};

const HELPER_FLAG: &str = "--tdc-update-helper";
const ERROR_FILE: &str = "update-install-error.txt";
const PLAN_FILE: &str = "plan.json";
const READY_FILE: &str = "ready";
const HELPER_FILE: &str = "helper.exe";
const PLAN_LIMIT: u64 = 16 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum HelperKind {
    Installer,
    Portable,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct InstallPlan {
    format: u32,
    job_id: String,
    version: String,
    source: PathBuf,
    target: PathBuf,
    sha256: String,
    size: u64,
    helper_sha256: String,
    helper_size: u64,
    kind: HelperKind,
    parent_pid: u32,
    restart: bool,
}

struct ValidatedPlan {
    plan: InstallPlan,
    job: PathBuf,
    cache: PathBuf,
}

/// 开发构建不能自更新；Windows x64 发行构建区分安装版和便携版。
pub fn kind(exe: &Path) -> InstallKind {
    if cfg!(debug_assertions) {
        return InstallKind::Development;
    }
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        if exe.parent().is_some_and(|dir| dir.join("uninstall.exe").is_file()) {
            InstallKind::Installer
        } else {
            InstallKind::Portable
        }
    } else {
        InstallKind::Unsupported
    }
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

fn helper_kind(exe: &Path) -> AppResult<HelperKind> {
    match kind(exe) {
        InstallKind::Installer => Ok(HelperKind::Installer),
        InstallKind::Portable => Ok(HelperKind::Portable),
        InstallKind::Development => Err(invalid("开发模式不能安装更新，请使用发行版程序")),
        InstallKind::Unsupported => Err(invalid("当前系统不支持自动安装更新")),
    }
}

fn regular_file(path: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err(invalid("更新路径必须是普通文件，不能是链接"));
    }
    Ok(())
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn ordinary_dir(path: &Path) -> AppResult<PathBuf> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(invalid("更新目录不能是链接"));
    }
    Ok(fs::canonicalize(path)?)
}

fn digest_file(path: &Path) -> AppResult<(String, u64)> {
    regular_file(path)?;
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut bytes = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut bytes)?;
        if read == 0 {
            break;
        }
        hash.update(&bytes[..read]);
        size += read as u64;
    }
    Ok((format!("{:x}", hash.finalize()), size))
}

fn trusted_cache() -> AppResult<PathBuf> {
    // 与 tauri.conf.json 的 identifier 以及 app_cache_dir().join("updates") 一致。
    let local = std::env::var_os("LOCALAPPDATA").ok_or_else(|| invalid("无法定位本机更新缓存目录"))?;
    ordinary_dir(&PathBuf::from(local).join("com.tdc.app").join("updates"))
}

fn has_exe_extension(path: &Path) -> bool {
    path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}

fn source_name(version: &str, kind: HelperKind) -> AppResult<String> {
    if version.is_empty()
        || version.len() > 128
        || !version.as_bytes()[0].is_ascii_digit()
        || version.contains("..")
        || !version.bytes().all(|c| c.is_ascii_alphanumeric() || b".-+".contains(&c))
    {
        return Err(invalid("更新版本格式无效"));
    }
    Ok(format!(
        "release-{version}-{}.exe",
        match kind {
            HelperKind::Installer => "setup",
            HelperKind::Portable => "portable",
        }
    ))
}

/// 启动已复制的辅助程序，收到校验完成信号后，调用方才可退出主进程。
pub fn launch(prepared: &PreparedUpdate, exe: &Path, restart: bool) -> AppResult<()> {
    let install_kind = helper_kind(exe)?;
    let cache = trusted_cache()?;
    regular_file(&prepared.path)?;
    let source = fs::canonicalize(&prepared.path)?;
    if source.parent() != Some(cache.as_path())
        || source.file_name() != Some(std::ffi::OsStr::new(&source_name(&prepared.version, install_kind)?))
    {
        return Err(invalid("更新文件必须位于应用更新缓存中"));
    }
    verify_file(&source, &prepared.digest, prepared.size)?;
    regular_file(exe)?;
    let target = fs::canonicalize(exe)?;
    validate_target(&target, &cache, install_kind)?;
    let (helper_sha256, helper_size) = digest_file(&target)?;
    let job_id = Uuid::new_v4().to_string();
    let job = cache.join(format!("install-{job_id}"));
    fs::create_dir(&job)?;
    let helper = job.join(HELPER_FILE);
    fs::copy(&target, &helper)?;
    verify_file(&helper, &helper_sha256, helper_size)?;
    let plan = InstallPlan {
        format: 1,
        job_id,
        version: prepared.version.clone(),
        source,
        target,
        sha256: prepared.digest.clone(),
        size: prepared.size,
        helper_sha256,
        helper_size,
        kind: install_kind,
        parent_pid: std::process::id(),
        restart,
    };
    let plan_path = job.join(PLAN_FILE);
    let mut plan_file = OpenOptions::new().write(true).create_new(true).open(&plan_path)?;
    plan_file.write_all(&serde_json::to_vec(&plan)?)?;
    plan_file.sync_all()?;
    let _ = fs::remove_file(cache.join(ERROR_FILE));
    let mut command = Command::new(&helper);
    command.arg(HELPER_FLAG).arg(&plan_path);
    hide_command(&mut command);
    let mut child = command.spawn().map_err(|error| AppError::Io(format!("无法启动更新安装程序：{error}")))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if job.join(READY_FILE).is_file() {
            return Ok(());
        }
        if child.try_wait()?.is_some() {
            return Err(AppError::Other(
                read_install_error(&cache).unwrap_or_else(|| "更新安装程序未能完成准备".into()),
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::Other("更新安装程序准备超时，请重试".into()));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn validate_target(target: &Path, cache: &Path, kind: HelperKind) -> AppResult<()> {
    if !target.is_absolute() || !has_exe_extension(target) || target.starts_with(cache) {
        return Err(invalid("更新目标必须是缓存目录之外的应用程序"));
    }
    regular_file(target)?;
    if kind == HelperKind::Installer {
        if target.file_name() != Some(std::ffi::OsStr::new("tht-docker-claude.exe")) {
            return Err(invalid("安装版更新目标名称无效"));
        }
        let uninstaller = target.parent().ok_or_else(|| invalid("应用程序目录无效"))?.join("uninstall.exe");
        regular_file(&uninstaller)?;
    }
    Ok(())
}

fn validate_plan(plan_path: &Path, current_exe: &Path, cache: &Path) -> AppResult<ValidatedPlan> {
    if !plan_path.is_absolute() || plan_path.file_name() != Some(std::ffi::OsStr::new(PLAN_FILE)) {
        return Err(invalid("更新安装计划路径无效"));
    }
    let cache = ordinary_dir(cache)?;
    let job = ordinary_dir(plan_path.parent().ok_or_else(|| invalid("更新安装目录无效"))?)?;
    if job.parent() != Some(cache.as_path()) {
        return Err(invalid("更新安装计划不在应用缓存中"));
    }
    let job_name = job.file_name().and_then(|name| name.to_str()).ok_or_else(|| invalid("更新任务名称无效"))?;
    let job_id = job_name.strip_prefix("install-").ok_or_else(|| invalid("更新任务名称无效"))?;
    if Uuid::parse_str(job_id).map(|id| id.to_string()).ok().as_deref() != Some(job_id) {
        return Err(invalid("更新任务标识无效"));
    }
    regular_file(plan_path)?;
    if fs::metadata(plan_path)?.len() > PLAN_LIMIT {
        return Err(invalid("更新安装计划过大"));
    }
    let plan: InstallPlan = serde_json::from_slice(&fs::read(plan_path)?)?;
    if plan.format != 1 || plan.job_id != job_id || plan.parent_pid == 0 || plan.parent_pid == std::process::id() {
        return Err(invalid("更新安装计划内容无效"));
    }
    regular_file(current_exe)?;
    let helper = fs::canonicalize(current_exe)?;
    if helper != job.join(HELPER_FILE) {
        return Err(invalid("更新辅助程序必须从隔离更新目录运行"));
    }
    verify_file(&helper, &plan.helper_sha256, plan.helper_size)?;
    if !plan.source.is_absolute() || !plan.target.is_absolute() {
        return Err(invalid("更新文件路径必须是绝对路径"));
    }
    regular_file(&plan.source)?;
    let source = fs::canonicalize(&plan.source)?;
    if source != plan.source
        || source.parent() != Some(cache.as_path())
        || source.file_name() != Some(std::ffi::OsStr::new(&source_name(&plan.version, plan.kind)?))
    {
        return Err(invalid("更新来源文件路径无效"));
    }
    let target = fs::canonicalize(&plan.target)?;
    if target != plan.target {
        return Err(invalid("更新目标路径不能包含间接路径"));
    }
    validate_target(&target, &cache, plan.kind)?;
    // 限定为这份辅助程序所复制的旧应用，拒绝借用计划覆盖其它程序。
    verify_file(&target, &plan.helper_sha256, plan.helper_size)?;
    verify_file(&source, &plan.sha256, plan.size)?;
    Ok(ValidatedPlan { plan, job, cache })
}

/// main 必须在初始化 Tauri / 单实例插件前调用；辅助程序永不进入普通应用路径。
pub fn run_helper_if_requested() -> bool {
    let args: Vec<_> = std::env::args_os().collect();
    if !args.iter().skip(1).any(|arg| arg == HELPER_FLAG) {
        return false;
    }
    let result = (|| {
        if cfg!(debug_assertions) || !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            return Err(invalid("当前构建不支持更新辅助程序"));
        }
        let cache = trusted_cache()?;
        if args.len() != 3 || args[1] != HELPER_FLAG {
            return Err(invalid("更新辅助程序参数无效"));
        }
        let validated = validate_plan(Path::new(&args[2]), &std::env::current_exe()?, &cache)?;
        let parent = ParentProcess::open(validated.plan.parent_pid)?;
        File::create(validated.job.join(READY_FILE))?.sync_all()?;
        parent.wait()?;
        // 父进程退出期间缓存或目标可能被改动，写入前再次校验。
        regular_file(&validated.plan.source)?;
        regular_file(&validated.plan.target)?;
        verify_file(&validated.plan.source, &validated.plan.sha256, validated.plan.size)?;
        verify_file(&validated.plan.target, &validated.plan.helper_sha256, validated.plan.helper_size)?;
        install(&validated)?;
        let _ = fs::remove_file(validated.cache.join(ERROR_FILE));
        let _ = fs::remove_file(&validated.plan.source);
        let _ = fs::remove_file(validated.cache.join("pending.json"));
        let _ = fs::remove_file(validated.job.join(PLAN_FILE));
        let _ = fs::remove_file(validated.job.join(READY_FILE));
        // 便携版先清理状态，再启动新版，避免新进程读取旧的失败或待安装记录。
        if validated.plan.kind == HelperKind::Portable && validated.plan.restart {
            restart_application(&validated.plan.target)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        if let Ok(cache) = trusted_cache() {
            let _ = fs::write(cache.join(ERROR_FILE), format!("更新安装失败：{error}"));
        }
    }
    true
}

/// 回收完成任务留下的辅助程序；只处理直接子目录，不递归删除任何内容。
pub fn cleanup_cache(cache: &Path) {
    cleanup_cache_after(cache, Duration::from_secs(60));
}

fn cleanup_cache_after(cache: &Path, minimum_age: Duration) {
    let Ok(cache) = ordinary_dir(cache) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&cache) else {
        return;
    };
    // 单次启动的清理工作有上限；后续启动会继续处理余下的完成任务。
    for entry in entries.take(128).flatten() {
        let job = entry.path();
        let Some(job_id) = entry.file_name().to_str().and_then(|name| name.strip_prefix("install-")).map(str::to_owned)
        else {
            continue;
        };
        if Uuid::parse_str(&job_id).map(|id| id.to_string()).ok().as_deref() != Some(job_id.as_str()) {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&job) else {
            continue;
        };
        if !metadata.is_dir() || is_link(&metadata) {
            continue;
        }
        let old_enough =
            metadata.modified().ok().and_then(|time| time.elapsed().ok()).is_some_and(|age| age >= minimum_age);
        if !old_enough {
            continue;
        }
        // 未写入计划的新任务由时间限制保护；含计划或准备标记的任务可能仍在运行。
        if fs::symlink_metadata(job.join(PLAN_FILE)).is_ok() || fs::symlink_metadata(job.join(READY_FILE)).is_ok() {
            continue;
        }
        let helper = job.join(HELPER_FILE);
        let Ok(files) = fs::read_dir(&job) else {
            continue;
        };
        let Ok(names) =
            files.take(2).map(|file| file.map(|file| file.file_name())).collect::<std::io::Result<Vec<_>>>()
        else {
            continue;
        };
        if names.len() > 1 || names.first().is_some_and(|name| name != HELPER_FILE) {
            continue;
        }
        if !names.is_empty() {
            if regular_file(&helper).is_err() {
                continue;
            }
            // Windows 拒绝删除正在执行的 helper.exe；删除失败时保留整项任务。
            if fs::remove_file(&helper).is_err() {
                continue;
            }
        }
        // remove_dir 只能移除空目录；意外新增内容时会安全失败。
        let _ = fs::remove_dir(&job);
    }
}

/// 下次启动展示上一次安装失败原因，限制文件大小以免异常日志占用内存。
pub fn read_install_error(cache: &Path) -> Option<String> {
    let path = cache.join(ERROR_FILE);
    regular_file(&path).ok()?;
    if fs::metadata(&path).ok()?.len() > PLAN_LIMIT {
        return Some("更新安装失败，错误记录过大，请重新下载更新".into());
    }
    fs::read_to_string(path).ok().filter(|message| !message.trim().is_empty())
}

fn hide_command(command: &mut Command) {
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
}

struct ParentProcess {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

impl ParentProcess {
    fn open(pid: u32) -> AppResult<Self> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
            use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
            // 同步权限只用于等待，不读写父进程内存；不继承句柄。
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            if handle.is_null() {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_INVALID_PARAMETER as i32) {
                    return Err(AppError::Io(format!("无法等待应用退出：{error}")));
                }
                // 应用可能已在辅助程序打开句柄前退出。
            }
            Ok(Self { handle })
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
            Err(invalid("当前系统不支持更新安装"))
        }
    }

    fn wait(&self) -> AppResult<()> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
            use windows_sys::Win32::System::Threading::WaitForSingleObject;
            if self.handle.is_null() {
                return Ok(());
            }
            match unsafe { WaitForSingleObject(self.handle, 120_000) } {
                WAIT_OBJECT_0 => Ok(()),
                WAIT_TIMEOUT => Err(AppError::Other("应用未能在两分钟内退出，更新已停止".into())),
                _ => Err(AppError::Io(format!("等待应用退出失败：{}", std::io::Error::last_os_error()))),
            }
        }
        #[cfg(not(windows))]
        {
            Err(invalid("当前系统不支持更新安装"))
        }
    }
}

#[cfg(windows)]
impl Drop for ParentProcess {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
        }
    }
}

fn install(validated: &ValidatedPlan) -> AppResult<()> {
    let plan = &validated.plan;
    match plan.kind {
        HelperKind::Portable => {
            replace_portable(&plan.source, &plan.target, &plan.sha256, plan.size)?;
        }
        HelperKind::Installer => {
            let mut command = installer_command(&plan.source, &plan.target, plan.restart)?;
            let status = command.status().map_err(|error| AppError::Io(format!("无法运行更新安装包：{error}")))?;
            if !status.success() {
                return Err(AppError::Other(format!(
                    "更新安装包退出码：{}",
                    status.code().map_or_else(|| "未知".into(), |code| code.to_string())
                )));
            }
        }
    }
    Ok(())
}

fn restart_application(target: &Path) -> AppResult<()> {
    let mut command = Command::new(target);
    command.current_dir(target.parent().ok_or_else(|| invalid("应用目录无效"))?);
    hide_command(&mut command);
    command.spawn().map_err(|error| AppError::Io(format!("更新已安装，但重新启动失败：{error}")))?;
    Ok(())
}

fn installer_command(source: &Path, target: &Path, restart: bool) -> AppResult<Command> {
    let dir = target.parent().ok_or_else(|| invalid("安装目标目录无效"))?;
    let mut command = Command::new(source);
    command.arg("/P").arg("/UPDATE");
    if restart {
        command.arg("/R");
    }
    // NSIS 的 /D 必须最后、且不能自动加引号，目录空格由 NSIS 自己处理。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut raw = std::ffi::OsString::from("/D=");
        raw.push(installer_directory(dir));
        command.raw_arg(raw);
    }
    #[cfg(not(windows))]
    {
        command.arg(format!("/D={}", dir.display()));
    }
    hide_command(&mut command);
    Ok(command)
}

#[cfg(windows)]
fn installer_directory(dir: &Path) -> std::ffi::OsString {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let wide: Vec<u16> = dir.as_os_str().encode_wide().collect();
    let verbatim: Vec<u16> = "\\\\?\\".encode_utf16().collect();
    let unc: Vec<u16> = "\\\\?\\UNC\\".encode_utf16().collect();
    // canonicalize 使用 Windows verbatim 路径；NSIS 的目录解析接受常规路径。
    if wide.starts_with(&unc) {
        let mut conventional: Vec<u16> = "\\\\".encode_utf16().collect();
        conventional.extend_from_slice(&wide[unc.len()..]);
        std::ffi::OsString::from_wide(&conventional)
    } else if wide.starts_with(&verbatim) {
        std::ffi::OsString::from_wide(&wide[verbatim.len()..])
    } else {
        dir.as_os_str().to_owned()
    }
}

fn copy_create_new(source: &Path, target: &Path) -> AppResult<()> {
    let mut source = File::open(source)?;
    let mut target = OpenOptions::new().write(true).create_new(true).open(target)?;
    std::io::copy(&mut source, &mut target)?;
    target.sync_all()?;
    Ok(())
}

/// 将新文件先写入目标目录，旧程序备份后切换；切换失败恢复旧程序。
fn replace_portable(source: &Path, target: &Path, digest: &str, size: u64) -> AppResult<()> {
    replace_portable_with(source, target, digest, size, |from, to| fs::rename(from, to))
}

fn replace_portable_with<F>(source: &Path, target: &Path, digest: &str, size: u64, mut rename: F) -> AppResult<()>
where
    F: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    regular_file(source)?;
    regular_file(target)?;
    verify_file(source, digest, size)?;
    let dir = ordinary_dir(target.parent().ok_or_else(|| invalid("应用目录无效"))?)?;
    let suffix = Uuid::new_v4();
    let staged = dir.join(format!(".tdc-update-{suffix}.new"));
    let backup = dir.join(format!(".tdc-update-{suffix}.bak"));
    let prepare = copy_create_new(source, &staged).and_then(|()| verify_file(&staged, digest, size));
    if let Err(error) = prepare {
        let _ = fs::remove_file(&staged);
        return Err(error);
    }
    if let Err(error) = rename(target, &backup) {
        let _ = fs::remove_file(&staged);
        return Err(AppError::Io(format!("无法备份旧程序：{error}")));
    }
    if let Err(error) = rename(&staged, target) {
        let rollback = rename(&backup, target);
        let _ = fs::remove_file(&staged);
        return Err(AppError::Io(match rollback {
            Ok(()) => format!("替换程序失败，已恢复旧版本：{error}"),
            Err(rollback) => format!("替换程序失败：{error}；恢复失败：{rollback}。旧程序保留在 {}", backup.display()),
        }));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("tdc updater 空格 {}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            // 仅测试创建并持有的临时目录；不使用来自更新计划的路径。
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (TestDir, PathBuf, PathBuf, PathBuf, InstallPlan) {
        let dir = TestDir::new();
        let cache = dir.0.join("updates");
        fs::create_dir(&cache).unwrap();
        let job_id = Uuid::new_v4().to_string();
        let job = cache.join(format!("install-{job_id}"));
        fs::create_dir(&job).unwrap();
        let helper = job.join(HELPER_FILE);
        let target = dir.0.join("便携 程序.exe");
        fs::write(&target, b"MZ old application").unwrap();
        fs::copy(&target, &helper).unwrap();
        let source = cache.join("release-1.2.3-portable.exe");
        fs::write(&source, b"MZ updated application").unwrap();
        let (sha256, size) = digest_file(&source).unwrap();
        let (helper_sha256, helper_size) = digest_file(&helper).unwrap();
        let plan = InstallPlan {
            format: 1,
            job_id,
            version: "1.2.3".into(),
            source,
            target,
            sha256,
            size,
            helper_sha256,
            helper_size,
            kind: HelperKind::Portable,
            parent_pid: std::process::id().wrapping_add(1).max(1),
            restart: false,
        };
        let plan_path = job.join(PLAN_FILE);
        fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
        (dir, cache, helper, plan_path, plan)
    }

    #[test]
    fn validates_isolated_plan_and_rejects_tampered_download() {
        let (_dir, cache, helper, plan_path, plan) = fixture();
        assert!(validate_plan(&plan_path, &helper, &cache).is_ok());
        fs::write(&plan.source, b"MZ tampered application").unwrap();
        assert!(validate_plan(&plan_path, &helper, &cache).is_err());
    }

    #[test]
    fn rejects_targets_unrelated_to_the_running_helper() {
        let (dir, cache, helper, plan_path, mut plan) = fixture();
        let unrelated = dir.0.join("unrelated.exe");
        fs::write(&unrelated, b"MZ another application").unwrap();
        plan.target = unrelated;
        fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
        assert!(validate_plan(&plan_path, &helper, &cache).is_err());
        plan.target = plan.source.clone();
        fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
        assert!(validate_plan(&plan_path, &helper, &cache).is_err());
    }

    #[test]
    fn rejects_source_and_job_outside_cache_boundary() {
        let (dir, cache, helper, plan_path, mut plan) = fixture();
        let outside = dir.0.join("release-1.2.3-portable.exe");
        fs::copy(&plan.source, &outside).unwrap();
        plan.source = outside;
        fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
        assert!(validate_plan(&plan_path, &helper, &cache).is_err());
        assert!(validate_plan(&plan_path, &helper, &dir.0).is_err());
    }

    #[test]
    fn portable_replace_preserves_spaces_unicode_and_cleans_backups() {
        let (dir, _cache, _helper, _plan_path, plan) = fixture();
        replace_portable(&plan.source, &plan.target, &plan.sha256, plan.size).unwrap();
        assert_eq!(fs::read(&plan.target).unwrap(), b"MZ updated application");
        assert!(!fs::read_dir(&dir.0).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".tdc-update-")));
    }

    #[test]
    fn portable_replace_rolls_back_when_final_move_fails() {
        let (_dir, _cache, _helper, _plan_path, plan) = fixture();
        let mut moves = 0;
        let result = replace_portable_with(&plan.source, &plan.target, &plan.sha256, plan.size, |from, to| {
            moves += 1;
            if moves == 2 {
                Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "simulated final move failure"))
            } else {
                fs::rename(from, to)
            }
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&plan.target).unwrap(), b"MZ old application");
        assert_eq!(moves, 3);
    }

    #[test]
    fn portable_replace_rejects_bad_hash_before_touching_old_program() {
        let (_dir, _cache, _helper, _plan_path, plan) = fixture();
        fs::write(&plan.source, b"tampered").unwrap();
        assert!(replace_portable(&plan.source, &plan.target, &plan.sha256, plan.size).is_err());
        assert_eq!(fs::read(&plan.target).unwrap(), b"MZ old application");
    }

    #[test]
    fn cache_cleanup_removes_only_completed_jobs() {
        let dir = TestDir::new();
        let cache = dir.0.join("updates");
        fs::create_dir(&cache).unwrap();
        let completed = cache.join(format!("install-{}", Uuid::new_v4()));
        fs::create_dir(&completed).unwrap();
        fs::write(completed.join(HELPER_FILE), b"MZ completed helper").unwrap();
        let planned = cache.join(format!("install-{}", Uuid::new_v4()));
        fs::create_dir(&planned).unwrap();
        fs::write(planned.join(HELPER_FILE), b"MZ active helper").unwrap();
        fs::write(planned.join(PLAN_FILE), b"active plan").unwrap();
        let ready = cache.join(format!("install-{}", Uuid::new_v4()));
        fs::create_dir(&ready).unwrap();
        fs::write(ready.join(READY_FILE), b"").unwrap();
        let unknown = cache.join(format!("install-{}", Uuid::new_v4()));
        fs::create_dir(&unknown).unwrap();
        fs::write(unknown.join("unknown.txt"), b"preserve").unwrap();
        let unrelated = cache.join("install-not-a-uuid");
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join(HELPER_FILE), b"preserve").unwrap();
        cleanup_cache(&cache);
        assert!(completed.is_dir(), "fresh tasks must be preserved");
        cleanup_cache_after(&cache, Duration::ZERO);
        assert!(!completed.exists());
        assert!(planned.join(PLAN_FILE).is_file());
        assert!(planned.join(HELPER_FILE).is_file());
        assert!(ready.join(READY_FILE).is_file());
        assert!(unknown.join("unknown.txt").is_file());
        assert!(unrelated.join(HELPER_FILE).is_file());
    }

    #[cfg(windows)]
    #[test]
    fn cache_cleanup_preserves_linked_directories() {
        use std::os::windows::fs::symlink_dir;
        use std::os::windows::fs::MetadataExt;
        let dir = TestDir::new();
        let cache = dir.0.join("updates");
        fs::create_dir(&cache).unwrap();
        let outside = dir.0.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join(HELPER_FILE), b"MZ outside file").unwrap();
        let linked = cache.join(format!("install-{}", Uuid::new_v4()));
        // Windows without Developer Mode may reject symlink creation; other cleanup tests still run.
        if symlink_dir(&outside, &linked).is_err() {
            return;
        }
        cleanup_cache_after(&cache, Duration::ZERO);
        assert!(outside.join(HELPER_FILE).is_file());
        assert!(fs::symlink_metadata(&linked).unwrap().file_attributes() & 0x400 != 0);
        fs::remove_dir(&linked).unwrap();
    }

    #[test]
    fn installer_restart_flag_only_for_manual_install() {
        let dir = TestDir::new();
        let source = dir.0.join("setup.exe");
        let target = dir.0.join("tht-docker-claude.exe");
        for restart in [false, true] {
            let command = installer_command(&source, &target, restart).unwrap();
            let args: Vec<_> = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
            assert_eq!(&args[..2], &["/P", "/UPDATE"]);
            assert_eq!(args.iter().any(|arg| arg == "/R"), restart);
            #[cfg(not(windows))]
            assert!(args.last().unwrap().starts_with("/D="));
            #[cfg(windows)]
            assert!(format!("{command:?}").contains("/D="));
        }
    }

    #[cfg(windows)]
    #[test]
    fn native_parent_wait_observes_a_real_process_exit() {
        // 测试程序的 --list 只列出测试后退出，不初始化应用或启动任何安装。
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.arg("--list");
        hide_command(&mut command);
        let mut child = command.spawn().unwrap();
        let parent = ParentProcess::open(child.id()).unwrap();
        let start = Instant::now();
        parent.wait().unwrap();
        assert!(start.elapsed() < Duration::from_secs(10));
        assert!(child.wait().unwrap().success());
    }
}
