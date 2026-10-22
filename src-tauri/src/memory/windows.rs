//! Windows host memory observations and explicitly selected process working sets.
//!
//! Working-set trimming does not release private allocations. Its result is only
//! an observed resident-page change; Windows may retain or fault those pages back.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMemorySnapshot {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
    pub commit_bytes: u64,
    pub commit_limit_bytes: u64,
    pub sampled_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemoryEntry {
    pub pid: u32,
    /// Decimal FILETIME, kept as text to preserve identity through JavaScript.
    pub created_at: Option<String>,
    pub name: String,
    pub working_set_bytes: Option<u64>,
    /// Private committed virtual memory, not resident physical memory.
    pub private_bytes: Option<u64>,
    pub eligible: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessTarget {
    pub pid: u32,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProcessTrimStatus {
    Trimmed,
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessTrimResult {
    pub pid: u32,
    pub created_at: String,
    pub name: String,
    pub status: ProcessTrimStatus,
    pub before_bytes: Option<u64>,
    pub after_bytes: Option<u64>,
    pub reason: Option<String>,
}

/// Holds successfully trimmed process handles throughout the observation window.
pub struct TrimBatch {
    results: Vec<ProcessTrimResult>,
    #[cfg(windows)]
    pending: Vec<(usize, native::OwnedHandle)>,
}

#[cfg(windows)]
pub use native::{begin_trim, finish_trim, list_processes, system_snapshot};

#[cfg(not(windows))]
fn unsupported<T>() -> AppResult<T> {
    Err(AppError::Other("整机内存分析与应用内存整理仅支持 Windows".into()))
}

#[cfg(not(windows))]
pub fn system_snapshot() -> AppResult<SystemMemorySnapshot> {
    unsupported()
}

#[cfg(not(windows))]
pub fn list_processes() -> AppResult<Vec<ProcessMemoryEntry>> {
    unsupported()
}

#[cfg(not(windows))]
pub fn begin_trim(_targets: &[ProcessTarget]) -> AppResult<TrimBatch> {
    unsupported()
}

#[cfg(not(windows))]
pub fn finish_trim(batch: TrimBatch) -> Vec<ProcessTrimResult> {
    batch.results
}

#[cfg(windows)]
mod native {
    use std::collections::{HashMap, HashSet};
    use std::mem::{size_of, size_of_val};
    use std::ptr;
    use std::time::{SystemTime, UNIX_EPOCH};

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_NO_MORE_FILES, FILETIME, HANDLE,
        INVALID_HANDLE_VALUE, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, IsValidSid, TokenElevation, TokenSessionId, TokenUser, TOKEN_ELEVATION,
        TOKEN_INFORMATION_CLASS, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        K32EmptyWorkingSet, K32GetPerformanceInfo, K32GetProcessMemoryInfo, PERFORMANCE_INFORMATION,
        PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessInformation, GetProcessTimes, IsProcessCritical, OpenProcess, OpenProcessToken,
        ProcessProtectionLevelInfo, QueryFullProcessImageNameW, WaitForSingleObject,
        PROCESS_PROTECTION_LEVEL_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
        PROCESS_SYNCHRONIZE, PROTECTION_LEVEL_NONE,
    };

    use super::*;

    pub(super) struct OwnedHandle(HANDLE);

    // Kernel process/token handles are thread independent. This wrapper has sole
    // ownership, is moved between workers, and closes exactly once. It is not Sync.
    unsafe impl Send for OwnedHandle {}

    impl OwnedHandle {
        fn new(handle: HANDLE) -> Result<Self, String> {
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                Err(format!("无法访问进程或系统信息（Windows 错误 {}）", unsafe { GetLastError() }))
            } else {
                Ok(Self(handle))
            }
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    #[derive(Debug, Clone)]
    struct RawProcess {
        pid: u32,
        parent_pid: u32,
        name: String,
    }

    struct RuntimeContext {
        owner: Vec<u8>,
        session: u32,
        windows_directory: String,
        own_image: String,
        own_tree: HashSet<u32>,
    }

    #[derive(Default)]
    struct ObservedProcess {
        created_at: Option<u64>,
        image: Option<String>,
        memory: Option<ProcessMemory>,
        reason: Option<String>,
    }

    #[derive(Debug, Clone, Copy)]
    struct ProcessMemory {
        working_set: u64,
        private_commit: u64,
    }

    struct AccessFacts {
        same_user: bool,
        session: u32,
        elevated: bool,
        critical: bool,
        protection: u32,
    }

    fn verify_access(facts: Result<AccessFacts, String>, expected_session: u32) -> Result<(), String> {
        // Any unavailable identity or protection observation is a rejection.
        let facts = facts?;
        if !facts.same_user {
            return Err("其他用户或系统服务进程".into());
        }
        if facts.session == 0 || facts.session != expected_session {
            return Err("其他会话或系统服务进程".into());
        }
        if facts.elevated {
            return Err("以管理员权限运行的进程".into());
        }
        if facts.critical {
            return Err("Windows 关键进程".into());
        }
        if facts.protection != PROTECTION_LEVEL_NONE {
            return Err("受保护的进程".into());
        }
        Ok(())
    }

    fn last_error(label: &str) -> String {
        format!("{label}（Windows 错误 {}）", unsafe { GetLastError() })
    }

    pub fn system_snapshot() -> AppResult<SystemMemorySnapshot> {
        let mut data =
            PERFORMANCE_INFORMATION { cb: size_of::<PERFORMANCE_INFORMATION>() as u32, ..Default::default() };
        if unsafe { K32GetPerformanceInfo(&mut data, size_of_val(&data) as u32) } == 0 {
            return Err(AppError::Other(last_error("无法读取整机内存统计")));
        }
        snapshot_from_pages(
            data.PhysicalTotal as u64,
            data.PhysicalAvailable as u64,
            data.CommitTotal as u64,
            data.CommitLimit as u64,
            data.PageSize as u64,
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64,
        )
    }

    fn snapshot_from_pages(
        total: u64,
        available: u64,
        committed: u64,
        limit: u64,
        page: u64,
        at: u64,
    ) -> AppResult<SystemMemorySnapshot> {
        if total == 0 || page == 0 || available > total {
            return Err(AppError::Other("整机内存统计无效".into()));
        }
        let bytes = |count: u64| count.checked_mul(page).ok_or_else(|| AppError::Other("整机内存统计超出范围".into()));
        let total_bytes = bytes(total)?;
        let available_bytes = bytes(available)?;
        Ok(SystemMemorySnapshot {
            total_bytes,
            available_bytes,
            used_bytes: total_bytes - available_bytes,
            commit_bytes: bytes(committed)?,
            commit_limit_bytes: bytes(limit)?,
            sampled_at_ms: at,
        })
    }

    fn raw_processes() -> AppResult<Vec<RawProcess>> {
        let snapshot =
            OwnedHandle::new(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }).map_err(AppError::Other)?;
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut processes = Vec::new();
        if unsafe { Process32FirstW(snapshot.0, &mut entry) } == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_NO_MORE_FILES {
                return Ok(processes);
            }
            return Err(AppError::Other(format!("无法枚举进程（Windows 错误 {code}）")));
        }
        loop {
            let length = entry.szExeFile.iter().position(|character| *character == 0).unwrap_or(entry.szExeFile.len());
            processes.push(RawProcess {
                pid: entry.th32ProcessID,
                parent_pid: entry.th32ParentProcessID,
                name: String::from_utf16_lossy(&entry.szExeFile[..length]),
            });
            if unsafe { Process32NextW(snapshot.0, &mut entry) } == 0 {
                if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
                    return Err(AppError::Other(last_error("进程枚举未完成")));
                }
                break;
            }
        }
        Ok(processes)
    }

    fn descendants(processes: &[RawProcess], own_pid: u32) -> HashSet<u32> {
        let mut tree = HashSet::from([own_pid]);
        loop {
            let old_length = tree.len();
            for process in processes {
                if tree.contains(&process.parent_pid) {
                    tree.insert(process.pid);
                }
            }
            if tree.len() == old_length {
                return tree;
            }
        }
    }

    fn runtime_context(processes: &[RawProcess]) -> Result<RuntimeContext, String> {
        // The pseudo handle must never be wrapped in OwnedHandle or closed.
        let own_process = unsafe { GetCurrentProcess() };
        let token = process_token(own_process)?;
        let session = token_session(token.0)?;
        if session == 0 {
            return Err("当前程序不在普通用户桌面会话，无法整理应用内存".into());
        }
        Ok(RuntimeContext {
            owner: token_owner(token.0)?,
            session,
            windows_directory: windows_directory()?,
            own_image: image_path(own_process)?,
            own_tree: descendants(processes, std::process::id()),
        })
    }

    fn process_token(process: HANDLE) -> Result<OwnedHandle, String> {
        let mut token = ptr::null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(last_error("无法验证进程用户身份"));
        }
        OwnedHandle::new(token)
    }

    fn token_buffer(token: HANDLE, kind: TOKEN_INFORMATION_CLASS) -> Result<(Vec<usize>, usize), String> {
        let mut length = 0;
        let first = unsafe { GetTokenInformation(token, kind, ptr::null_mut(), 0, &mut length) };
        if first != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || length == 0 || length > 65536 {
            return Err("无法验证进程令牌".into());
        }
        // usize elements supply suitable alignment for TOKEN_USER and its SID.
        let mut data = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
        let capacity = size_of_val(data.as_slice());
        if unsafe { GetTokenInformation(token, kind, data.as_mut_ptr().cast(), capacity as u32, &mut length) } == 0
            || length as usize > capacity
        {
            return Err(last_error("无法验证进程令牌"));
        }
        Ok((data, length as usize))
    }

    fn token_owner(token: HANDLE) -> Result<Vec<u8>, String> {
        let (data, length) = token_buffer(token, TokenUser)?;
        if length < size_of::<TOKEN_USER>() {
            return Err("进程用户令牌无效".into());
        }
        let user = unsafe { ptr::read(data.as_ptr().cast::<TOKEN_USER>()) };
        let start = data.as_ptr() as usize;
        let end = start.checked_add(length).ok_or("进程用户令牌无效")?;
        let sid = user.User.Sid as usize;
        if sid < start || sid.checked_add(8).map_or(true, |value| value > end) {
            return Err("进程用户 SID 无效".into());
        }
        // A SID contains an eight-byte header followed by SubAuthorityCount u32s.
        // Check its full extent before passing a token-derived pointer to Win32.
        let authorities = unsafe { *user.User.Sid.cast::<u8>().add(1) } as usize;
        if sid.checked_add(8 + authorities * 4).map_or(true, |value| value > end)
            || unsafe { IsValidSid(user.User.Sid) } == 0
        {
            return Err("进程用户 SID 无效".into());
        }
        let sid_length = unsafe { windows_sys::Win32::Security::GetLengthSid(user.User.Sid) } as usize;
        if sid_length == 0 || sid.checked_add(sid_length).map_or(true, |value| value > end) {
            return Err("进程用户 SID 无效".into());
        }
        Ok(unsafe { std::slice::from_raw_parts(user.User.Sid.cast::<u8>(), sid_length) }.to_vec())
    }

    fn token_session(token: HANDLE) -> Result<u32, String> {
        let mut session = 0u32;
        let mut length = 0;
        if unsafe {
            GetTokenInformation(
                token,
                TokenSessionId,
                ptr::from_mut(&mut session).cast(),
                size_of::<u32>() as u32,
                &mut length,
            )
        } == 0
            || length != size_of::<u32>() as u32
        {
            return Err(last_error("无法验证进程会话"));
        }
        Ok(session)
    }

    fn token_elevated(token: HANDLE) -> Result<bool, String> {
        let mut elevation = TOKEN_ELEVATION::default();
        let mut length = 0;
        if unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                ptr::from_mut(&mut elevation).cast(),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut length,
            )
        } == 0
            || length != size_of::<TOKEN_ELEVATION>() as u32
        {
            return Err(last_error("无法验证进程权限"));
        }
        Ok(elevation.TokenIsElevated != 0)
    }

    fn normalize_path(path: &str) -> String {
        path.replace('/', "\\").trim_start_matches("\\\\?\\").trim_end_matches('\\').to_lowercase()
    }

    fn inside_directory(image: &str, directory: &str) -> bool {
        let image = normalize_path(image);
        let directory = normalize_path(directory);
        image == directory || image.strip_prefix(&directory).is_some_and(|suffix| suffix.starts_with('\\'))
    }

    fn windows_directory() -> Result<String, String> {
        let mut buffer = vec![0u16; 32768];
        let length = unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
        if length == 0 || length >= buffer.len() {
            return Err(last_error("无法验证 Windows 系统目录"));
        }
        resolved_path(&String::from_utf16_lossy(&buffer[..length]))
    }

    fn resolved_path(path: &str) -> Result<String, String> {
        // Resolve directory junctions and symlinks before applying system-path
        // exclusions. Unresolvable paths never qualify for trimming.
        std::fs::canonicalize(path)
            .map(|resolved| resolved.to_string_lossy().into_owned())
            .map_err(|_| "无法确认进程路径或系统目录".into())
    }

    fn image_path(process: HANDLE) -> Result<String, String> {
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) } == 0
            || length == 0
            || length as usize > buffer.len()
        {
            return Err(last_error("无法验证进程路径"));
        }
        resolved_path(&String::from_utf16_lossy(&buffer[..length as usize]))
    }

    fn process_created_at(process: HANDLE) -> Result<u64, String> {
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
            return Err(last_error("无法验证进程启动时间"));
        }
        let value = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        if value == 0 {
            return Err("进程启动时间无效".into());
        }
        Ok(value)
    }

    fn process_memory(process: HANDLE) -> Result<ProcessMemory, String> {
        let mut memory =
            PROCESS_MEMORY_COUNTERS_EX { cb: size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32, ..Default::default() };
        if unsafe {
            K32GetProcessMemoryInfo(
                process,
                ptr::from_mut(&mut memory).cast::<PROCESS_MEMORY_COUNTERS>(),
                size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            )
        } == 0
        {
            return Err(last_error("无法读取进程内存"));
        }
        Ok(ProcessMemory { working_set: memory.WorkingSetSize as u64, private_commit: memory.PrivateUsage as u64 })
    }

    fn running(process: HANDLE) -> bool {
        // A signaled handle proves exit even if the process used exit code 259.
        unsafe { WaitForSingleObject(process, 0) == WAIT_TIMEOUT }
    }

    fn excluded_name(name: &str) -> Option<&'static str> {
        let name = name.to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "system"
                | "registry"
                | "memory compression"
                | "smss.exe"
                | "csrss.exe"
                | "wininit.exe"
                | "services.exe"
                | "lsass.exe"
                | "winlogon.exe"
                | "svchost.exe"
                | "dwm.exe"
                | "fontdrvhost.exe"
                | "sihost.exe"
                | "taskhostw.exe"
                | "conhost.exe"
        ) {
            return Some("Windows 系统进程");
        }
        if matches!(
            name.as_str(),
            "explorer.exe"
                | "shellexperiencehost.exe"
                | "startmenuexperiencehost.exe"
                | "searchhost.exe"
                | "searchapp.exe"
                | "searchui.exe"
                | "runtimebroker.exe"
                | "applicationframehost.exe"
                | "textinputhost.exe"
                | "widgets.exe"
                | "widgetservice.exe"
        ) {
            return Some("Windows 桌面与 Shell 进程");
        }
        if name == "msedgewebview2.exe" || name == "tht-docker-claude.exe" {
            return Some("应用与 WebView 运行进程");
        }
        if name.contains("docker")
            || name.starts_with("vmmem")
            || name.starts_with("wsl")
            || matches!(
                name.as_str(),
                "vmcompute.exe"
                    | "vmwp.exe"
                    | "vmms.exe"
                    | "vmware.exe"
                    | "vmware-vmx.exe"
                    | "vmware-hostd.exe"
                    | "vmware-authd.exe"
                    | "vmware-tray.exe"
                    | "vboxsvc.exe"
                    | "vboxheadless.exe"
                    | "virtualbox.exe"
                    | "virtualboxvm.exe"
                    | "qemu.exe"
            )
            || name.starts_with("qemu-system-")
        {
            return Some("Docker、WSL 或虚拟化进程");
        }
        if matches!(
            name.as_str(),
            "msmpeng.exe"
                | "mssense.exe"
                | "nissrv.exe"
                | "securityhealthservice.exe"
                | "securityhealthsystray.exe"
                | "smartscreen.exe"
                | "avp.exe"
                | "avpui.exe"
                | "avguard.exe"
                | "avgnt.exe"
                | "avgsvc.exe"
                | "avgui.exe"
                | "avastsvc.exe"
                | "avastui.exe"
                | "ekrn.exe"
                | "egui.exe"
                | "mbamservice.exe"
                | "mbam.exe"
                | "wrsa.exe"
                | "savservice.exe"
                | "sophosui.exe"
                | "hipsdaemon.exe"
                | "hipstray.exe"
                | "kvdefend.exe"
                | "kavstart.exe"
        ) || name.starts_with("360")
            || name.starts_with("qqpc")
            || name.starts_with("huorong")
            || name.starts_with("k7")
        {
            return Some("安全与防护软件");
        }
        None
    }

    fn safety_reason(
        process: HANDLE,
        raw: &RawProcess,
        observed: &ObservedProcess,
        context: &RuntimeContext,
    ) -> Option<String> {
        let check = || -> Result<(), String> {
            if raw.pid <= 4 {
                return Err("Windows 系统进程".into());
            }
            if context.own_tree.contains(&raw.pid) {
                return Err("本应用及其子进程".into());
            }
            let image = observed.image.as_deref().ok_or("无法验证进程路径")?;
            if normalize_path(image) == normalize_path(&context.own_image) {
                return Err("本应用运行进程".into());
            }
            if inside_directory(image, &context.windows_directory) {
                return Err("Windows 系统目录中的进程".into());
            }
            // Check the trusted image basename as well as the enumeration name.
            let image_name = image.rsplit(['\\', '/']).next().unwrap_or_default();
            if let Some(reason) = excluded_name(&raw.name).or_else(|| excluded_name(image_name)) {
                return Err(reason.into());
            }
            observed.created_at.ok_or("无法验证进程启动时间")?;
            observed.memory.ok_or("无法读取进程内存")?;
            verify_access(access_facts(process, context), context.session)?;
            if !running(process) {
                return Err("进程已退出或无法验证运行状态".into());
            }
            Ok(())
        };
        check().err()
    }

    fn access_facts(process: HANDLE, context: &RuntimeContext) -> Result<AccessFacts, String> {
        let token = process_token(process)?;
        let same_user = token_owner(token.0)? == context.owner;
        let session = token_session(token.0)?;
        let elevated = token_elevated(token.0)?;
        let mut critical = 0;
        if unsafe { IsProcessCritical(process, &mut critical) } == 0 {
            return Err(last_error("无法验证关键进程状态"));
        }
        let mut protection = PROCESS_PROTECTION_LEVEL_INFORMATION::default();
        if unsafe {
            GetProcessInformation(
                process,
                ProcessProtectionLevelInfo,
                ptr::from_mut(&mut protection).cast(),
                size_of::<PROCESS_PROTECTION_LEVEL_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(last_error("无法验证进程保护状态"));
        }
        Ok(AccessFacts {
            same_user,
            session,
            elevated,
            critical: critical != 0,
            protection: protection.ProtectionLevel,
        })
    }

    fn observe_process(process: HANDLE) -> ObservedProcess {
        let mut observed = ObservedProcess::default();
        match process_created_at(process) {
            Ok(value) => observed.created_at = Some(value),
            Err(reason) => observed.reason = Some(reason),
        }
        match image_path(process) {
            Ok(value) => observed.image = Some(value),
            Err(reason) => {
                observed.reason.get_or_insert(reason);
            }
        }
        match process_memory(process) {
            Ok(value) => observed.memory = Some(value),
            Err(reason) => {
                observed.reason.get_or_insert(reason);
            }
        }
        observed
    }

    pub fn list_processes() -> AppResult<Vec<ProcessMemoryEntry>> {
        let raw = raw_processes()?;
        let context = runtime_context(&raw).map_err(AppError::Other)?;
        let mut processes = Vec::with_capacity(raw.len());
        for process in &raw {
            let opened = OwnedHandle::new(unsafe {
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, process.pid)
            });
            let (observed, reason) = match opened {
                Ok(handle) => {
                    let observed = observe_process(handle.0);
                    let reason =
                        safety_reason(handle.0, process, &observed, &context).or_else(|| observed.reason.clone());
                    (observed, reason)
                }
                Err(reason) => (ObservedProcess::default(), Some(reason)),
            };
            processes.push(ProcessMemoryEntry {
                pid: process.pid,
                created_at: observed.created_at.map(|value| value.to_string()),
                name: process.name.clone(),
                working_set_bytes: observed.memory.map(|memory| memory.working_set),
                private_bytes: observed.memory.map(|memory| memory.private_commit),
                eligible: reason.is_none(),
                reason,
            });
        }
        processes.sort_by(|a, b| b.working_set_bytes.cmp(&a.working_set_bytes).then(a.pid.cmp(&b.pid)));
        Ok(processes)
    }

    fn target_identity(target: &ProcessTarget) -> Result<u64, String> {
        let value = target.created_at.parse::<u64>().map_err(|_| "进程启动时间无效".to_string())?;
        if value == 0 || value.to_string() != target.created_at {
            return Err("进程启动时间无效".into());
        }
        Ok(value)
    }

    fn verify_identity(expected: u64, observed: Option<u64>) -> Result<(), String> {
        if observed != Some(expected) {
            return Err("进程已退出、重启或身份发生变化，请重新分析".into());
        }
        Ok(())
    }

    fn trim_one(
        target: &ProcessTarget,
        raw: &RawProcess,
        context: &RuntimeContext,
    ) -> (ProcessTrimResult, Option<OwnedHandle>) {
        let mut result = ProcessTrimResult {
            pid: target.pid,
            created_at: target.created_at.clone(),
            name: raw.name.clone(),
            status: ProcessTrimStatus::Skipped,
            before_bytes: None,
            after_bytes: None,
            reason: None,
        };
        let mut operation = || -> Result<OwnedHandle, String> {
            let expected = target_identity(target)?;
            let handle = OwnedHandle::new(unsafe {
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA | PROCESS_SYNCHRONIZE, 0, target.pid)
            })?;
            let observed = observe_process(handle.0);
            verify_identity(expected, observed.created_at)?;
            if let Some(reason) = safety_reason(handle.0, raw, &observed, context).or(observed.reason) {
                return Err(reason);
            }
            result.before_bytes = observed.memory.map(|memory| memory.working_set);
            if unsafe { K32EmptyWorkingSet(handle.0) } == 0 {
                return Err(last_error("没有整理权限或工作集整理失败"));
            }
            Ok(handle)
        };
        match operation() {
            Ok(handle) => {
                result.status = ProcessTrimStatus::Trimmed;
                (result, Some(handle))
            }
            Err(reason) => {
                result.reason = Some(reason);
                (result, None)
            }
        }
    }

    pub fn begin_trim(targets: &[ProcessTarget]) -> AppResult<TrimBatch> {
        // Bound input before process I/O; the command can also enforce UI limits.
        if targets.len() > 256 {
            return Err(AppError::Invalid("一次最多选择 256 个进程".into()));
        }
        let raw = raw_processes()?;
        let context = runtime_context(&raw).map_err(AppError::Other)?;
        let processes: HashMap<u32, &RawProcess> = raw.iter().map(|process| (process.pid, process)).collect();
        let mut seen = HashSet::new();
        let mut batch = TrimBatch { results: Vec::with_capacity(targets.len()), pending: Vec::new() };
        for target in targets {
            let (result, handle) = if !seen.insert(target.pid) {
                (skipped_target(target, "重复选择的进程"), None)
            } else if let Some(process) = processes.get(&target.pid) {
                trim_one(target, process, &context)
            } else {
                (skipped_target(target, "进程已退出，请重新分析"), None)
            };
            if let Some(handle) = handle {
                batch.pending.push((batch.results.len(), handle));
            }
            batch.results.push(result);
        }
        Ok(batch)
    }

    fn skipped_target(target: &ProcessTarget, reason: &str) -> ProcessTrimResult {
        ProcessTrimResult {
            pid: target.pid,
            created_at: target.created_at.clone(),
            name: format!("PID {}", target.pid),
            status: ProcessTrimStatus::Skipped,
            before_bytes: None,
            after_bytes: None,
            reason: Some(reason.into()),
        }
    }

    pub fn finish_trim(mut batch: TrimBatch) -> Vec<ProcessTrimResult> {
        for (index, handle) in batch.pending {
            let result = &mut batch.results[index];
            result.after_bytes = None;
            let observation = || -> Result<u64, String> {
                if !running(handle.0) {
                    return Err("整理操作已完成，但进程随后退出，无法确认工作集变化".into());
                }
                if process_created_at(handle.0)?.to_string() != result.created_at {
                    return Err("整理后的进程身份无法确认".into());
                }
                let memory = process_memory(handle.0)?;
                if !running(handle.0) {
                    return Err("整理操作已完成，但采样时进程退出，无法确认工作集变化".into());
                }
                Ok(memory.working_set)
            };
            match observation() {
                Ok(bytes) => result.after_bytes = Some(bytes),
                Err(reason) => result.reason = Some(reason),
            }
        }
        batch.results
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn windows_memory_page_conversion_uses_system_totals_and_checks_overflow() {
            let snapshot = snapshot_from_pages(100, 30, 160, 200, 4096, 123).unwrap();
            assert_eq!(snapshot.total_bytes, 409600);
            assert_eq!(snapshot.available_bytes, 122880);
            assert_eq!(snapshot.used_bytes, 286720);
            assert_eq!(snapshot.commit_bytes, 655360);
            assert_eq!(snapshot.sampled_at_ms, 123);
            assert!(snapshot_from_pages(100, 101, 20, 30, 4096, 123).is_err());
            assert!(snapshot_from_pages(0, 0, 20, 30, 4096, 123).is_err());
            assert!(snapshot_from_pages(100, 30, u64::MAX, 30, 4096, 123).is_err());
        }

        #[test]
        fn windows_memory_exclusions_match_paths_and_virtualization_names() {
            assert!(inside_directory(r"C:\Windows\System32\svchost.exe", r"c:\WINDOWS"));
            assert!(inside_directory(r"\\?\C:\Windows\System32\svchost.exe", r"C:\Windows\"));
            assert!(!inside_directory(r"C:\WindowsApps\app.exe", r"C:\Windows"));
            for name in [
                "VmmemWSL",
                "Docker Desktop.exe",
                "com.docker.backend.exe",
                "wslservice.exe",
                "VMware-vmx.exe",
                "VirtualBoxVM.exe",
                "MsMpEng.exe",
                "360Tray.exe",
                "explorer.exe",
                "msedgewebview2.exe",
            ] {
                assert!(excluded_name(name).is_some(), "{name}");
            }
            for name in ["chrome.exe", "notepad.exe", "Code.exe", "python.exe"] {
                assert!(excluded_name(name).is_none(), "{name}");
            }
        }

        #[test]
        fn windows_memory_descendants_include_nested_children_without_following_unrelated_cycles() {
            let raw = |pid, parent_pid| RawProcess { pid, parent_pid, name: "fixture.exe".into() };
            let processes = [raw(12, 11), raw(11, 10), raw(21, 22), raw(22, 21), raw(10, 9)];
            assert_eq!(descendants(&processes, 10), HashSet::from([10, 11, 12]));
        }

        #[test]
        fn windows_memory_target_time_must_round_trip_exactly() {
            let target = |created_at: &str| ProcessTarget { pid: 50, created_at: created_at.into() };
            assert_eq!(target_identity(&target("134063820000000001")).unwrap(), 134063820000000001);
            for value in ["", "0", "01", "-1", "+1", "1.0", " 1", "18446744073709551616"] {
                assert!(target_identity(&target(value)).is_err(), "{value}");
            }
            assert!(verify_identity(134063820000000001, Some(134063820000000002)).is_err());
            assert!(verify_identity(134063820000000001, None).is_err());
            assert!(verify_identity(134063820000000001, Some(134063820000000001)).is_ok());
        }

        #[test]
        fn windows_memory_access_policy_rejects_unknown_other_user_service_elevated_and_protected() {
            let ordinary = || AccessFacts {
                same_user: true,
                session: 2,
                elevated: false,
                critical: false,
                protection: PROTECTION_LEVEL_NONE,
            };
            assert!(verify_access(Ok(ordinary()), 2).is_ok());
            assert!(verify_access(Err("拒绝访问".into()), 2).is_err());
            assert!(verify_access(Ok(AccessFacts { same_user: false, ..ordinary() }), 2).is_err());
            assert!(verify_access(Ok(AccessFacts { session: 0, ..ordinary() }), 2).is_err());
            assert!(verify_access(Ok(AccessFacts { session: 3, ..ordinary() }), 2).is_err());
            assert!(verify_access(Ok(AccessFacts { elevated: true, ..ordinary() }), 2).is_err());
            assert!(verify_access(Ok(AccessFacts { critical: true, ..ordinary() }), 2).is_err());
            assert!(verify_access(Ok(AccessFacts { protection: 0, ..ordinary() }), 2).is_err());
        }

        #[test]
        fn windows_memory_batch_is_send_and_preserves_missing_readings() {
            fn assert_send<T: Send>() {}
            assert_send::<TrimBatch>();
            let target = ProcessTarget { pid: 1, created_at: "134063820000000001".into() };
            let result = skipped_target(&target, "进程已退出");
            let results = finish_trim(TrimBatch { results: vec![result], pending: Vec::new() });
            assert_eq!(results[0].after_bytes, None);
            assert_eq!(results[0].status, ProcessTrimStatus::Skipped);
        }

        #[test]
        fn windows_memory_readonly_snapshot_and_self_exclusion() {
            let snapshot = system_snapshot().unwrap();
            assert!(snapshot.total_bytes > 0);
            assert!(snapshot.available_bytes <= snapshot.total_bytes);
            let list = list_processes().unwrap();
            let own = list.iter().find(|entry| entry.pid == std::process::id()).unwrap();
            assert!(!own.eligible);
            assert!(own.created_at.is_some());
            assert!(own.working_set_bytes.is_some());
        }

        #[test]
        fn windows_memory_rechecks_self_stale_missing_and_duplicate_targets_without_trimming() {
            let own_time = process_created_at(unsafe { GetCurrentProcess() }).unwrap().to_string();
            let own = ProcessTarget { pid: std::process::id(), created_at: own_time };
            let stale = ProcessTarget { pid: std::process::id(), created_at: "1".into() };
            let absent = ProcessTarget { pid: u32::MAX, created_at: "1".into() };
            let batch = begin_trim(&[stale, absent, own.clone(), own]).unwrap();
            assert!(batch.pending.is_empty());
            let results = finish_trim(batch);
            assert!(results.iter().all(|result| result.status == ProcessTrimStatus::Skipped));
            assert!(results.iter().all(|result| result.before_bytes.is_none() && result.after_bytes.is_none()));
            assert!(results[0].reason.as_ref().unwrap().contains("身份发生变化"));
            assert!(results[1].reason.as_ref().unwrap().contains("退出"));
            // The stale target reserved this PID too: never retry a PID twice.
            assert!(results[2].reason.as_ref().unwrap().contains("重复"));
            assert!(results.iter().all(|result| !result.name.is_empty()));
        }

        /// Helper tests are dormant unless a dedicated fixture directory is set.
        #[test]
        #[ignore = "only launched by windows_memory_trim_dedicated_fixture_live"]
        fn windows_memory_fixture_launcher() {
            let Some(directory) = std::env::var_os("TDC_MEMORY_FIXTURE_DIRECTORY") else { return };
            use std::os::windows::process::CommandExt;
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "memory::windows::native::tests::windows_memory_fixture_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("TDC_MEMORY_FIXTURE_DIRECTORY", directory)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(0x08000000)
                .spawn()
                .unwrap();
            // Exiting this launcher makes the fixture independent of the test
            // runner's child tree. Production exclusions remain intact.
            drop(child);
        }

        #[test]
        #[ignore = "only launched by windows_memory_trim_dedicated_fixture_live"]
        fn windows_memory_fixture_child() {
            let Some(directory) = std::env::var_os("TDC_MEMORY_FIXTURE_DIRECTORY") else { return };
            let directory = std::path::PathBuf::from(directory);
            let mut allocation = vec![0u8; 64 * 1024 * 1024];
            for byte in allocation.iter_mut().step_by(4096) {
                *byte = 0x5a;
            }
            let own_process = unsafe { GetCurrentProcess() };
            let before = process_memory(own_process).unwrap();
            let created_at = process_created_at(own_process).unwrap();
            std::fs::write(
                directory.join("ready"),
                format!("{}\n{}\n{}\n", std::process::id(), created_at, before.private_commit),
            )
            .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
            while !directory.join("stop").exists() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            // Touch the allocation after trimming to prove content was preserved.
            assert!(allocation.iter().step_by(4096).all(|byte| *byte == 0x5a));
            std::fs::write(directory.join("done"), "allocation preserved").unwrap();
            std::hint::black_box(allocation);
        }

        struct DedicatedFixture {
            directory: std::path::PathBuf,
            process: Option<OwnedHandle>,
        }

        impl Drop for DedicatedFixture {
            fn drop(&mut self) {
                let _ = std::fs::write(self.directory.join("stop"), "stop");
                if let Some(process) = self.process.take() {
                    unsafe { WaitForSingleObject(process.0, 5000) };
                }
                // This UUID directory was created and owned only by this test.
                let _ = std::fs::remove_dir_all(&self.directory);
            }
        }

        /// Exercises the full cleanup path only against an owned 64 MiB fixture.
        #[tokio::test]
        #[ignore = "manual Windows integration test; trims only a dedicated test process"]
        async fn windows_memory_trim_dedicated_fixture_live() {
            use std::os::windows::process::CommandExt;
            let directory = std::env::temp_dir().join(format!("tdc-memory-fixture-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let mut fixture = DedicatedFixture { directory, process: None };
            let executable = fixture.directory.join("memory-fixture.exe");
            std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
            let mut launcher = std::process::Command::new(&executable)
                .args([
                    "--exact",
                    "memory::windows::native::tests::windows_memory_fixture_launcher",
                    "--ignored",
                    "--nocapture",
                ])
                .env("TDC_MEMORY_FIXTURE_DIRECTORY", &fixture.directory)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(0x08000000)
                .spawn()
                .unwrap();
            assert!(launcher.wait().unwrap().success());
            let ready_deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !fixture.directory.join("ready").is_file() {
                assert!(std::time::Instant::now() < ready_deadline, "dedicated fixture did not start");
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            let ready = std::fs::read_to_string(fixture.directory.join("ready")).unwrap();
            let values: Vec<_> = ready.lines().collect();
            let pid = values[0].parse::<u32>().unwrap();
            let created_at = values[1].to_string();
            let private_before = values[2].parse::<u64>().unwrap();
            let handle = OwnedHandle::new(unsafe {
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid)
            })
            .unwrap();
            fixture.process = Some(handle);
            let entry = list_processes().unwrap().into_iter().find(|entry| entry.pid == pid).unwrap();
            assert!(entry.eligible, "dedicated fixture rejected: {:?}", entry.reason);
            assert_eq!(entry.created_at.as_deref(), Some(created_at.as_str()));
            let result = crate::memory::cleanup(
                None,
                crate::memory::MemoryCleanupRequest {
                    targets: vec![ProcessTarget { pid, created_at: created_at.clone() }],
                    include_wsl_cache: false,
                },
            )
            .await
            .unwrap();
            assert!(result.errors.is_empty(), "{:?}", result.errors);
            assert_eq!(result.processes.len(), 1);
            assert_eq!(result.processes[0].status, ProcessTrimStatus::Trimmed);
            assert!(result.processes[0].before_bytes.is_some());
            assert!(result.processes[0].after_bytes.is_some());
            let handle = fixture.process.as_ref().unwrap();
            assert!(running(handle.0));
            let private_after = process_memory(handle.0).unwrap().private_commit;
            assert!(private_before >= 64 * 1024 * 1024);
            assert!(private_after >= 64 * 1024 * 1024, "private allocation unexpectedly disappeared");
            assert!(private_after.abs_diff(private_before) < 4 * 1024 * 1024);
            // Preserve the same handle across exit to check the post-sample path.
            let exited_batch = TrimBatch {
                results: vec![result.processes[0].clone()],
                pending: vec![(
                    0,
                    OwnedHandle::new(unsafe {
                        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid)
                    })
                    .unwrap(),
                )],
            };
            std::fs::write(fixture.directory.join("stop"), "stop").unwrap();
            assert_eq!(unsafe { WaitForSingleObject(handle.0, 5000) }, windows_sys::Win32::Foundation::WAIT_OBJECT_0);
            assert!(fixture.directory.join("done").is_file());
            let exited = finish_trim(exited_batch);
            assert_eq!(exited[0].status, ProcessTrimStatus::Trimmed);
            assert!(exited[0].after_bytes.is_none(), "exit must never be reported as zero bytes");
            assert!(exited[0].reason.as_ref().unwrap().contains("退出"));
        }
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn host_memory_is_explicitly_unsupported_off_windows() {
        assert!(system_snapshot().is_err());
        assert!(list_processes().is_err());
        assert!(begin_trim(&[]).is_err());
        assert!(finish_trim(TrimBatch { results: Vec::new() }).is_empty());
    }
}
