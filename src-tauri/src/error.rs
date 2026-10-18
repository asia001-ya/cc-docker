//! 应用统一错误类型。
//!
//! 命令层一律返回 `Result<T, AppError>`；序列化为 `{code, message}` 交给前端，
//! 前端据 code 分支处理（如 DOCKER_UNAVAILABLE 时提示启动 Docker Desktop）。

use serde::ser::{Serialize, SerializeStruct, Serializer};

/// 后端统一错误枚举。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// Docker 引擎不可达（未安装 / 未启动 / 管道地址错误）
    #[error("{0}")]
    DockerUnavailable(String),
    /// Docker API 返回错误
    #[error("Docker 错误：{0}")]
    Docker(String),
    /// 未找到资源（容器 / 会话 / 供应商）
    #[error("未找到：{0}")]
    NotFound(String),
    /// 参数校验失败
    #[error("参数无效：{0}")]
    Invalid(String),
    /// 文件读写错误
    #[error("IO 错误：{0}")]
    Io(String),
    /// 凭据管理器读写错误
    #[error("凭据存储错误：{0}")]
    Credential(String),
    /// 其它错误
    #[error("{0}")]
    Other(String),
}

impl AppError {
    /// 返回稳定错误码。
    /// 参数：无；返回：静态字符串错误码。
    pub fn code(&self) -> &'static str {
        match self {
            AppError::DockerUnavailable(_) => "DOCKER_UNAVAILABLE",
            AppError::Docker(_) => "DOCKER_ERROR",
            AppError::NotFound(_) => "NOT_FOUND",
            AppError::Invalid(_) => "INVALID",
            AppError::Io(_) => "IO_ERROR",
            AppError::Credential(_) => "CREDENTIAL_ERROR",
            AppError::Other(_) => "OTHER",
        }
    }
}

impl Serialize for AppError {
    /// 序列化为 `{code, message}`。
    /// 参数：serializer——serde 序列化器；返回：序列化结果。
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut st = serializer.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

impl From<bollard::errors::Error> for AppError {
    /// 把 bollard 错误分为"引擎不可达"与"API 错误"两类。
    /// 参数：e——bollard 错误；返回：AppError。
    fn from(e: bollard::errors::Error) -> Self {
        use bollard::errors::Error as B;
        match e {
            B::DockerResponseServerError { status_code: 404, message } => AppError::NotFound(message),
            B::DockerResponseServerError { status_code, message } => {
                AppError::Docker(format!("[{status_code}] {message}"))
            }
            other => {
                let text = other.to_string();
                // named pipe 不存在 / 拒绝连接等传输层错误统一视为引擎不可用
                if text.contains("pipe")
                    || text.contains("系统找不到")
                    || text.contains("connect")
                    || text.contains("os error 2")
                {
                    AppError::DockerUnavailable(text)
                } else {
                    AppError::Docker(text)
                }
            }
        }
    }
}

impl From<std::io::Error> for AppError {
    /// IO 错误转换。参数：e——IO 错误；返回：AppError::Io。
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    /// JSON 错误转换。参数：e——serde_json 错误；返回：AppError::Other。
    fn from(e: serde_json::Error) -> Self {
        AppError::Other(format!("JSON 解析失败：{e}"))
    }
}

impl From<keyring::Error> for AppError {
    /// 凭据错误转换。参数：e——keyring 错误；返回：AppError::Credential。
    fn from(e: keyring::Error) -> Self {
        AppError::Credential(e.to_string())
    }
}

/// 后端统一 Result 别名。
pub type AppResult<T> = Result<T, AppError>;
