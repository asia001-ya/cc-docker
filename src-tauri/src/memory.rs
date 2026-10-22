//! Host memory analysis, selected application trimming and Docker WSL2 cache controls.
//!
//! WSL controls never shut down the VM, restart containers or change configuration.
//! Selected Windows applications retain their private allocations when trimmed.
//! Linux cache reduction is an estimate, not a claim about memory returned to
//! Windows: page reporting is asynchronous and optional.

use std::process::{Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::docker::client::DockerClient;
use crate::error::{AppError, AppResult};

pub mod windows;
pub use windows::{ProcessMemoryEntry, ProcessTarget, ProcessTrimResult, SystemMemorySnapshot};

const COOLDOWN: Duration = Duration::from_secs(30);
const RECLAIM_SCRIPT: &str = include_str!("memory/reclaim.sh");
const COMPACT_SCRIPT: &str = include_str!("memory/compact.sh");
const BEFORE: &str = "TDC_MEMORY_BEFORE\n";
const AFTER: &str = "TDC_MEMORY_AFTER\n";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReclaimStatus {
    pub supported: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReclaimResult {
    /// Buffers + Cached + SReclaimable - Shmem; includes cache still in use.
    pub cache_before_bytes: u64,
    pub cache_after_bytes: Option<u64>,
    /// Observed total VmmemWSL working set; may include other WSL distributions.
    pub host_before_bytes: Option<u64>,
    pub host_after_bytes: Option<u64>,
    pub operation: MemoryOperation,
    /// Time from operation completion to the final Windows memory observation.
    pub observation_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAnalysis {
    pub system: Option<SystemMemorySnapshot>,
    pub processes: Vec<ProcessMemoryEntry>,
    pub supported: bool,
    pub reason: Option<String>,
    pub wsl: MemoryReclaimStatus,
    pub running: bool,
    pub cooldown_remaining_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryCleanupRequest {
    pub targets: Vec<ProcessTarget>,
    pub include_wsl_cache: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCleanupResult {
    pub system_before: Option<SystemMemorySnapshot>,
    pub system_after: Option<SystemMemorySnapshot>,
    pub processes: Vec<ProcessTrimResult>,
    pub wsl: Option<MemoryReclaimResult>,
    pub errors: Vec<String>,
    pub observation_seconds: u64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryOperation {
    Cache,
    Compact,
}

impl MemoryOperation {
    fn script(self) -> &'static str {
        match self {
            Self::Cache => RECLAIM_SCRIPT,
            Self::Compact => COMPACT_SCRIPT,
        }
    }

    fn observation_delay(self) -> Duration {
        Duration::from_secs(match self {
            Self::Cache => 15,
            Self::Compact => 30,
        })
    }

    fn label(self) -> &'static str {
        match self {
            Self::Cache => "WSL 缓存回收",
            Self::Compact => "WSL 内存整理",
        }
    }
}

#[derive(Default)]
struct GateState {
    running: bool,
    finished: Option<Instant>,
}

struct ReclaimGate(Mutex<GateState>);
struct ReclaimLease<'a>(&'a ReclaimGate);

static RECLAIM_GATE: ReclaimGate = ReclaimGate(Mutex::new(GateState { running: false, finished: None }));

impl ReclaimGate {
    fn state(&self) -> (bool, u64) {
        let gate = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let remaining = gate.finished.and_then(|time| COOLDOWN.checked_sub(time.elapsed()));
        (gate.running, remaining.map_or(0, |time| time.as_millis() as u64))
    }

    fn acquire(&self) -> AppResult<ReclaimLease<'_>> {
        let mut gate = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if gate.running {
            return Err(AppError::Other("正在回收或整理内存，请等待本次操作完成".into()));
        }
        if let Some(remaining) = gate.finished.and_then(|time| COOLDOWN.checked_sub(time.elapsed())) {
            return Err(AppError::Other(format!(
                "请在 {} 秒后再试，频繁回收或整理内存会影响性能",
                remaining.as_secs() + 1
            )));
        }
        gate.running = true;
        Ok(ReclaimLease(self))
    }
}

impl Drop for ReclaimLease<'_> {
    fn drop(&mut self) {
        let mut gate = self.0 .0.lock().unwrap_or_else(|error| error.into_inner());
        gate.running = false;
        // Failure and cancellation also cool down, and never leave the gate locked.
        gate.finished = Some(Instant::now());
    }
}

fn validate_host(host: &str, windows: bool) -> AppResult<()> {
    if !windows {
        return Err(AppError::Other("释放 WSL 内存仅支持 Windows 上的 Docker Desktop WSL2 后端".into()));
    }
    // Do not act on another local pipe that could proxy a remote engine.
    if !matches!(
        host.to_ascii_lowercase().as_str(),
        "npipe:////./pipe/docker_engine" | "npipe:////./pipe/dockerdesktoplinuxengine"
    ) {
        return Err(AppError::Other("释放内存仅支持本机 Docker Desktop 管道，当前引擎地址不受支持".into()));
    }
    Ok(())
}

fn validate_engine(os_type: &str, operating_system: &str, kernel: &str) -> AppResult<()> {
    let kernel = kernel.to_ascii_lowercase();
    if os_type != "linux"
        || operating_system != "Docker Desktop"
        || !kernel.contains("microsoft")
        || !kernel.contains("wsl2")
    {
        return Err(AppError::Other("当前 Docker 引擎未使用 Docker Desktop WSL2 后端，无法释放 WSL 内存".into()));
    }
    Ok(())
}

fn system_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32")
}

fn host_command(executable: &str) -> Command {
    let directory = system_dir();
    let mut command = Command::new(directory.join(executable));
    command
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

async fn run_command(command: &mut Command, duration: Duration, label: &str) -> AppResult<Output> {
    tokio::time::timeout(duration, command.output())
        .await
        .map_err(|_| AppError::Other(format!("{label}超时，结果未确认，请稍后重试；容器和终端会话保持运行")))?
        .map_err(|_| AppError::Other(format!("无法执行{label}，请确认 WSL 和系统组件可用")))
}

/// WSL's list output and launcher errors may be UTF-16LE even with redirected I/O.
fn decode_windows_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.iter().skip(1).step_by(2).take(64).any(|byte| *byte == 0) {
        let bytes = bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes);
        let utf16: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        String::from_utf16_lossy(&utf16)
    } else {
        String::from_utf8_lossy(bytes).trim_start_matches('\u{feff}').to_string()
    }
}

fn docker_distribution_running(bytes: &[u8]) -> bool {
    decode_windows_text(bytes).lines().any(|line| line.trim() == "docker-desktop")
}

async fn ensure_supported(docker: &DockerClient) -> AppResult<()> {
    validate_host(docker.connection_key(), cfg!(windows))?;
    let info = tokio::time::timeout(Duration::from_secs(8), docker.system_info())
        .await
        .map_err(|_| AppError::Other("Docker 能力检查超时，请稍后重试".into()))??;
    validate_engine(
        info.os_type.as_deref().unwrap_or_default(),
        info.operating_system.as_deref().unwrap_or_default(),
        info.kernel_version.as_deref().unwrap_or_default(),
    )?;
    let output = run_command(
        host_command("wsl.exe").args(["--list", "--running", "--quiet"]),
        Duration::from_secs(8),
        "WSL 状态检查",
    )
    .await?;
    if !output.status.success() || !docker_distribution_running(&output.stdout) {
        return Err(AppError::Other("Docker Desktop 的 WSL 发行版未运行，请先启动 Docker Desktop".into()));
    }
    Ok(())
}

pub async fn status(docker: &DockerClient) -> MemoryReclaimStatus {
    match ensure_supported(docker).await {
        Ok(()) => MemoryReclaimStatus { supported: true, reason: None },
        Err(error) => MemoryReclaimStatus { supported: false, reason: Some(error.to_string()) },
    }
}

/// Windows statistics never require a Docker connection. WSL probing is bounded
/// independently so a disconnected engine cannot block analysis indefinitely.
pub async fn analyze(docker: Option<&DockerClient>) -> AppResult<MemoryAnalysis> {
    let windows_task = tokio::task::spawn_blocking(|| (windows::system_snapshot(), windows::list_processes()));
    let wsl_probe = async {
        let Some(docker) = docker else {
            return MemoryReclaimStatus { supported: false, reason: Some("尚未连接 Docker 引擎".into()) };
        };
        tokio::time::timeout(Duration::from_secs(12), status(docker)).await.unwrap_or_else(|_| MemoryReclaimStatus {
            supported: false,
            reason: Some("WSL 能力检查超时，可继续分析和整理 Windows 应用".into()),
        })
    };
    let (samples, wsl) = tokio::join!(windows_task, wsl_probe);
    let (system, processes) = samples.map_err(|_| AppError::Other("Windows 内存分析未完成，请重试".into()))?;
    let mut reasons = Vec::new();
    let system = system.map_err(|error| reasons.push(error.to_string())).ok();
    let processes = processes.map_err(|error| reasons.push(error.to_string())).unwrap_or_default();
    reasons.dedup();
    let (running, cooldown_remaining_ms) = RECLAIM_GATE.state();
    Ok(MemoryAnalysis {
        system,
        processes,
        supported: cfg!(windows),
        reason: (!reasons.is_empty()).then(|| reasons.join("；")),
        wsl,
        running,
        cooldown_remaining_ms,
    })
}

fn cache_bytes(meminfo: &str) -> AppResult<u64> {
    let mut fields = [None; 4];
    for line in meminfo.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let Some(index) = ["Buffers", "Cached", "SReclaimable", "Shmem"].iter().position(|name| *name == key) else {
            continue;
        };
        let mut words = value.split_whitespace();
        let parsed = words.next().and_then(|value| value.parse::<u64>().ok());
        if fields[index].is_some() || parsed.is_none() || words.next() != Some("kB") || words.next().is_some() {
            return Err(AppError::Other("WSL 内存统计格式无效，无法确认回收结果".into()));
        }
        fields[index] = parsed;
    }
    let [Some(buffers), Some(cached), Some(reclaimable), Some(shared)] = fields else {
        return Err(AppError::Other("WSL 内存统计不完整，无法确认回收结果".into()));
    };
    buffers
        .checked_add(cached)
        .and_then(|sum| sum.checked_add(reclaimable))
        .map(|sum| sum.saturating_sub(shared))
        .and_then(|sum| sum.checked_mul(1024))
        .ok_or_else(|| AppError::Other("WSL 内存统计数值超出范围".into()))
}

fn parse_reclaim_output(bytes: &[u8]) -> AppResult<(u64, Option<u64>)> {
    let output =
        std::str::from_utf8(bytes).map_err(|_| AppError::Other("WSL 内存操作结果未确认：无法解析返回内容".into()))?;
    let output = output.replace("\r\n", "\n");
    let before =
        output.strip_prefix(BEFORE).ok_or_else(|| AppError::Other("WSL 内存操作结果未确认：缺少操作前统计".into()))?;
    let (before, after) = before.split_once(AFTER).ok_or_else(|| {
        AppError::Other("WSL 内存操作结果未确认：未返回完成标记，可能是写入权限不足或操作超时".into())
    })?;
    let before = cache_bytes(before)
        .map_err(|_| AppError::Other("WSL 已执行内存操作，但操作前统计无效，无法确认内存变化量".into()))?;
    // The AFTER marker is emitted only after the requested kernel write succeeds.
    // A subsequent read error must not misreport a completed action as a failure.
    Ok((before, cache_bytes(after).ok()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostMemorySample {
    pids: Vec<u32>,
    bytes: u64,
}

fn parse_host_sample(bytes: &[u8]) -> Option<HostMemorySample> {
    let mut sample: HostMemorySample = serde_json::from_str(decode_windows_text(bytes).trim()).ok()?;
    if sample.pids.is_empty() || sample.pids.contains(&0) {
        return None;
    }
    sample.pids.sort_unstable();
    if sample.pids.windows(2).any(|pair| pair[0] == pair[1]) {
        return None;
    }
    Some(sample)
}

fn comparable_host_samples(
    before: Option<&HostMemorySample>,
    after: Option<&HostMemorySample>,
) -> (Option<u64>, Option<u64>) {
    let first = before.map(|sample| sample.bytes);
    let last = before.zip(after).filter(|(before, after)| before.pids == after.pids).map(|(_, after)| after.bytes);
    (first, last)
}

async fn host_working_set() -> Option<HostMemorySample> {
    // Read-only, fixed PowerShell expression. No process trimming or termination.
    const SCRIPT: &str = "$p = @(Get-Process -Name VmmemWSL -ErrorAction SilentlyContinue); if ($p.Count -gt 0) { [pscustomobject]@{ pids = @($p | ForEach-Object { $_.Id }); bytes = [long](($p | Measure-Object -Property WorkingSet64 -Sum).Sum) } | ConvertTo-Json -Compress }";
    let output = run_command(
        host_command("WindowsPowerShell/v1.0/powershell.exe").args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            SCRIPT,
        ]),
        Duration::from_secs(5),
        "Windows 内存采样",
    )
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_host_sample(&output.stdout)
}

pub async fn reclaim(docker: &DockerClient) -> AppResult<MemoryReclaimResult> {
    perform(docker, MemoryOperation::Cache).await
}

pub async fn compact(docker: &DockerClient) -> AppResult<MemoryReclaimResult> {
    perform(docker, MemoryOperation::Compact).await
}

async fn perform(docker: &DockerClient, operation: MemoryOperation) -> AppResult<MemoryReclaimResult> {
    // Both actions retain this same lease through the observation window, then
    // share a cooldown. Neither action can overlap the other.
    let _lease = RECLAIM_GATE.acquire()?;
    let pending = execute_wsl(docker, operation).await?;
    let observation_started = Instant::now();
    tokio::time::sleep(operation.observation_delay()).await;
    Ok(finish_wsl(pending, observation_started.elapsed().as_secs()).await)
}

struct PendingWsl {
    operation: MemoryOperation,
    cache_before_bytes: u64,
    cache_after_bytes: Option<u64>,
    host_before: Option<HostMemorySample>,
}

/// The caller owns the shared lease. Combined cleanup uses this path without
/// recursively acquiring a gate or waiting through a second observation window.
async fn execute_wsl(docker: &DockerClient, operation: MemoryOperation) -> AppResult<PendingWsl> {
    ensure_supported(docker).await?;
    let host_before = host_working_set().await;
    // Re-check directly before exec: wsl --distribution would otherwise start a
    // stopped distro. A concurrent external shutdown can still race this check.
    ensure_supported(docker).await?;
    let script = operation.script().replace("\r\n", "\n");
    // The launcher and Linux timeout are cancellable. A kernel sysctl write can
    // remain in uninterruptible execution, so neither timeout is a hard bound on
    // the kernel operation itself. A missing completion marker is never success.
    let output = run_command(
        host_command("wsl.exe").args([
            "--distribution",
            "docker-desktop",
            "--user",
            "root",
            "--exec",
            "timeout",
            "-s",
            "TERM",
            "-k",
            "2",
            "30",
            "sh",
            "-c",
            &script,
        ]),
        Duration::from_secs(38),
        operation.label(),
    )
    .await
    .map_err(|error| AppError::Other(format!("{error}；停止等待不代表内核中的内存操作已强制终止")))?;
    // The completion marker is stronger evidence than the exit code: the final
    // optional statistics command may fail after a successful cache write.
    let (cache_before_bytes, cache_after_bytes) = parse_reclaim_output(&output.stdout)?;
    Ok(PendingWsl { operation, cache_before_bytes, cache_after_bytes, host_before })
}

async fn finish_wsl(pending: PendingWsl, observation_seconds: u64) -> MemoryReclaimResult {
    let host_after = host_working_set().await;
    let (host_before_bytes, host_after_bytes) =
        comparable_host_samples(pending.host_before.as_ref(), host_after.as_ref());
    MemoryReclaimResult {
        cache_before_bytes: pending.cache_before_bytes,
        cache_after_bytes: pending.cache_after_bytes,
        host_before_bytes,
        host_after_bytes,
        operation: pending.operation,
        observation_seconds,
    }
}

fn validate_cleanup(request: &MemoryCleanupRequest) -> AppResult<()> {
    if request.targets.is_empty() && !request.include_wsl_cache {
        return Err(AppError::Invalid("请先选择要整理的应用或 WSL 缓存".into()));
    }
    if request.targets.len() > 256 {
        return Err(AppError::Invalid("选择的进程过多，请刷新分析结果".into()));
    }
    let mut pids = std::collections::HashSet::new();
    for target in &request.targets {
        if target.pid == 0
            || !pids.insert(target.pid)
            || !target.created_at.parse::<u64>().is_ok_and(|time| time > 0 && time.to_string() == target.created_at)
        {
            return Err(AppError::Invalid("进程身份无效或重复，请刷新分析结果".into()));
        }
    }
    Ok(())
}

pub async fn cleanup(docker: Option<&DockerClient>, request: MemoryCleanupRequest) -> AppResult<MemoryCleanupResult> {
    validate_cleanup(&request)?;
    let _lease = RECLAIM_GATE.acquire()?;
    if !cfg!(windows) {
        return Err(AppError::Other("整机内存清理仅支持 Windows 桌面应用".into()));
    }
    let include_wsl_cache = request.include_wsl_cache;
    let (before, batch) = tokio::task::spawn_blocking(move || {
        let before = windows::system_snapshot();
        let batch = if request.targets.is_empty() { None } else { Some(windows::begin_trim(&request.targets)) };
        (before, batch)
    })
    .await
    .map_err(|_| AppError::Other("Windows 内存整理执行中断，结果未确认".into()))?;
    let mut errors = Vec::new();
    let system_before = before.map_err(|error| errors.push(error.to_string())).ok();
    let batch = batch.and_then(|result| result.map_err(|error| errors.push(error.to_string())).ok());
    let pending_wsl = if include_wsl_cache {
        match docker {
            Some(docker) => {
                execute_wsl(docker, MemoryOperation::Cache).await.map_err(|error| errors.push(error.to_string())).ok()
            }
            None => {
                errors.push("未回收 WSL 缓存：尚未连接 Docker 引擎".into());
                None
            }
        }
    } else {
        None
    };
    let observation_started = Instant::now();
    tokio::time::sleep(Duration::from_secs(if include_wsl_cache { 15 } else { 5 })).await;
    let observation_seconds = observation_started.elapsed().as_secs();
    let final_windows = tokio::task::spawn_blocking(move || {
        let after = windows::system_snapshot();
        let processes = batch.map(windows::finish_trim).unwrap_or_default();
        (after, processes)
    });
    let final_wsl = async {
        match pending_wsl {
            Some(pending) => Some(finish_wsl(pending, observation_seconds).await),
            None => None,
        }
    };
    let (final_windows, wsl) = tokio::join!(final_windows, final_wsl);
    let (system_after, processes) = match final_windows {
        Ok((after, processes)) => (after.map_err(|error| errors.push(error.to_string())).ok(), processes),
        Err(_) => {
            errors.push("清理后的 Windows 采样未完成，无法确认变化".into());
            (None, Vec::new())
        }
    };
    Ok(MemoryCleanupResult { system_before, system_after, processes, wsl, errors, observation_seconds })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MEMINFO: &str = "MemTotal: 1234 kB\nBuffers: 100 kB\nCached: 400 kB\nSReclaimable: 60 kB\nShmem: 20 kB\n";

    #[test]
    fn cleanup_rejects_empty_duplicate_and_invalid_process_identities() {
        let request = |targets, include_wsl_cache| MemoryCleanupRequest { targets, include_wsl_cache };
        let target = || ProcessTarget { pid: 123, created_at: "134000000000000001".into() };
        assert!(validate_cleanup(&request(Vec::new(), false)).is_err());
        assert!(validate_cleanup(&request(Vec::new(), true)).is_ok());
        assert!(validate_cleanup(&request(vec![target()], false)).is_ok());
        assert!(validate_cleanup(&request(vec![target(), target()], false)).is_err());
        for created_at in ["", "0", "-1", "01", "1.1", "18446744073709551616"] {
            assert!(validate_cleanup(&request(vec![ProcessTarget { pid: 123, created_at: created_at.into() }], false))
                .is_err());
        }
    }

    #[tokio::test]
    async fn windows_analysis_does_not_require_a_docker_connection() {
        let analysis = analyze(None).await.unwrap();
        assert!(!analysis.wsl.supported);
        assert!(analysis.wsl.reason.unwrap().contains("尚未连接"));
        assert_eq!(analysis.supported, cfg!(windows));
        #[cfg(windows)]
        {
            let system = analysis.system.unwrap();
            assert!(system.total_bytes > 0);
            assert!(system.available_bytes <= system.total_bytes);
            assert!(!analysis.processes.is_empty());
            assert!(!analysis.processes.iter().find(|row| row.pid == std::process::id()).unwrap().eligible);
        }
    }

    #[test]
    fn memory_target_requires_windows_known_local_pipe_and_wsl2() {
        assert!(validate_host("npipe:////./pipe/docker_engine", true).is_ok());
        assert!(validate_host("npipe:////./pipe/dockerDesktopLinuxEngine", true).is_ok());
        for host in [
            "tcp://localhost:2375",
            "ssh://remote",
            "npipe:////remote/pipe/docker_engine",
            "npipe:////./pipe/other",
            "unix:///var/run/docker.sock",
        ] {
            assert!(validate_host(host, true).is_err(), "{host}");
        }
        assert!(validate_host("npipe:////./pipe/docker_engine", false).is_err());
        assert!(validate_engine("linux", "Docker Desktop", "6.18.54.1-microsoft-standard-WSL2").is_ok());
        for (os, distro, kernel) in [
            ("windows", "Docker Desktop", "WSL2-microsoft"),
            ("linux", "Ubuntu", "microsoft-WSL2"),
            ("linux", "Docker Desktop", "linuxkit"),
            ("linux", "Docker Desktop", "microsoft-standard"),
        ] {
            assert!(validate_engine(os, distro, kernel).is_err());
        }
    }

    #[test]
    fn memory_running_distribution_handles_utf16_and_exact_names() {
        for text in ["docker-desktop\r\nUbuntu\r\n", "  docker-desktop\n"] {
            let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
            assert!(docker_distribution_running(&utf16));
            let mut bom = vec![0xff, 0xfe];
            bom.extend(utf16);
            assert!(docker_distribution_running(&bom));
            assert!(docker_distribution_running(text.as_bytes()));
        }
        for text in ["", "docker-desktop-data\n", "Ubuntu\ndocker-desktop-copy\n"] {
            assert!(!docker_distribution_running(text.as_bytes()));
        }
    }

    #[test]
    fn memory_cache_estimate_excludes_tmpfs_and_detects_invalid_input() {
        assert_eq!(cache_bytes(MEMINFO).unwrap(), 540 * 1024);
        for invalid in [
            MEMINFO.replace("Cached: 400 kB\n", ""),
            MEMINFO.replace("400", "-1"),
            MEMINFO.replace("400 kB", "400 MB"),
            MEMINFO.replace("400 kB", "400 kB extra"),
            format!("{MEMINFO}Cached: 400 kB\n"),
            MEMINFO.replace("400", "18446744073709551615"),
            MEMINFO.replace("400", "18014398509481984"),
        ] {
            assert!(cache_bytes(&invalid).is_err(), "{invalid}");
        }
        assert_eq!(cache_bytes(&MEMINFO.replace("Shmem: 20", "Shmem: 900")).unwrap(), 0);
    }

    #[test]
    fn memory_result_requires_both_complete_snapshots() {
        let complete = format!("{BEFORE}{MEMINFO}{AFTER}{}", MEMINFO.replace("400", "100"));
        assert_eq!(parse_reclaim_output(complete.as_bytes()).unwrap(), (540 * 1024, Some(240 * 1024)));
        assert!(parse_reclaim_output(format!("{BEFORE}{MEMINFO}").as_bytes()).is_err());
        assert_eq!(
            parse_reclaim_output(format!("{BEFORE}{MEMINFO}{AFTER}bad").as_bytes()).unwrap(),
            (540 * 1024, None)
        );
        let error = parse_reclaim_output(format!("{BEFORE}{MEMINFO}Permission denied\n").as_bytes()).unwrap_err();
        assert!(error.to_string().contains("结果未确认"));
        assert!(parse_reclaim_output(format!("{BEFORE}{MEMINFO}TDC_MEMORY_AFT").as_bytes()).is_err());
    }

    #[test]
    fn memory_host_samples_compare_only_the_same_process_set() {
        let first = parse_host_sample(br#"{"pids":[20,10],"bytes":900}"#).unwrap();
        let last = parse_host_sample(br#"{"pids":[10,20],"bytes":950}"#).unwrap();
        assert_eq!(comparable_host_samples(Some(&first), Some(&last)), (Some(900), Some(950)));
        let changed = parse_host_sample(br#"{"pids":[10,21],"bytes":200}"#).unwrap();
        assert_eq!(comparable_host_samples(Some(&first), Some(&changed)), (Some(900), None));
        assert_eq!(comparable_host_samples(None, Some(&last)), (None, None));
        assert_eq!(comparable_host_samples(Some(&first), None), (Some(900), None));
        for invalid in [
            r#"{"pids":[],"bytes":10}"#,
            r#"{"pids":[0],"bytes":10}"#,
            r#"{"pids":[1,1],"bytes":10}"#,
            r#"{"pids":[1],"bytes":-1}"#,
            r#"{"bytes":10}"#,
        ] {
            assert!(parse_host_sample(invalid.as_bytes()).is_none());
        }
        let utf16: Vec<u8> = r#"{"pids":[10],"bytes":900}"#.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(parse_host_sample(&utf16).unwrap().pids, [10]);
    }

    #[test]
    fn memory_operation_and_observation_metadata_are_explicit() {
        for (operation, name, seconds) in
            [(MemoryOperation::Cache, "cache", 15), (MemoryOperation::Compact, "compact", 30)]
        {
            let result = MemoryReclaimResult {
                cache_before_bytes: 100,
                cache_after_bytes: Some(100),
                host_before_bytes: Some(900),
                host_after_bytes: Some(950),
                operation,
                observation_seconds: seconds,
            };
            let value = serde_json::to_value(result).unwrap();
            assert_eq!(value["operation"], name);
            assert_eq!(value["observationSeconds"], seconds);
            assert_eq!(operation.observation_delay().as_secs(), seconds);
            assert_eq!(value["hostAfterBytes"], 950); // Report final increases, never a minimum.
        }
    }

    #[tokio::test]
    async fn memory_actions_share_gate_and_cooldown() {
        // Acquisition precedes any Docker/WSL I/O, so this test never touches a VM.
        let docker = DockerClient::connect("").unwrap();
        let lease = RECLAIM_GATE.acquire().unwrap();
        let request = || MemoryCleanupRequest {
            targets: vec![ProcessTarget { pid: 123, created_at: "134000000000000001".into() }],
            include_wsl_cache: false,
        };
        assert!(cleanup(None, request()).await.unwrap_err().to_string().contains("等待本次操作完成"));
        for operation in [MemoryOperation::Cache, MemoryOperation::Compact] {
            let result = match operation {
                MemoryOperation::Cache => reclaim(&docker).await,
                MemoryOperation::Compact => compact(&docker).await,
            };
            assert!(result.unwrap_err().to_string().contains("等待本次操作完成"));
        }
        drop(lease);
        assert!(reclaim(&docker).await.unwrap_err().to_string().contains("秒后再试"));
        assert!(compact(&docker).await.unwrap_err().to_string().contains("秒后再试"));
        assert!(cleanup(None, request()).await.unwrap_err().to_string().contains("秒后再试"));
    }

    #[test]
    fn memory_gate_rejects_concurrency_and_cools_down_after_failure() {
        let gate = ReclaimGate(Mutex::new(GateState::default()));
        let lease = gate.acquire().unwrap();
        assert!(gate.acquire().is_err());
        drop(lease); // The same path is used by success, early ? and cancellation.
        assert!(!gate.0.lock().unwrap().running);
        assert!(gate.acquire().is_err());
        gate.0.lock().unwrap().finished = Some(Instant::now() - COOLDOWN);
        assert!(gate.acquire().is_ok());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn memory_subprocess_timeout_is_bounded() {
        let started = Instant::now();
        let error = run_command(
            host_command("WindowsPowerShell/v1.0/powershell.exe").args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]),
            Duration::from_millis(100),
            "测试",
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    /// Explicit opt-in only: actually drops clean caches on the running local WSL2 VM.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "manual host integration test; actually reclaims WSL caches"]
    async fn memory_reclaim_live() {
        let docker = DockerClient::connect("npipe:////./pipe/dockerDesktopLinuxEngine").unwrap();
        let result = reclaim(&docker).await.unwrap();
        println!("{}", serde_json::to_string(&result).unwrap());
        docker.engine_info().await.unwrap();
    }

    /// Explicit opt-in only: may introduce system-wide latency during compaction.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "manual host integration test; actually compacts WSL memory"]
    async fn memory_compact_live() {
        let docker = DockerClient::connect("npipe:////./pipe/dockerDesktopLinuxEngine").unwrap();
        let result = compact(&docker).await.unwrap();
        println!("{}", serde_json::to_string(&result).unwrap());
        docker.engine_info().await.unwrap();
    }
}
