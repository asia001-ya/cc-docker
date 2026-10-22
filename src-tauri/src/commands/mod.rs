//! Tauri 命令层：只做参数转发，业务逻辑在各领域模块中。

pub mod container_cmds;
pub mod container_edit_cmds;
pub mod git_cmds;
pub mod host_config_cmds;
pub mod image_cmds;
pub mod memory_cmds;
pub mod output_cmds;
pub mod proxy_cmds;
pub mod settings_cmds;
pub mod term_cmds;
pub mod update_cmds;
pub mod usage_cmds;
pub mod wallpaper_cmds;
