// release 构建不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 程序入口：转交 lib 中的 run。
/// 参数：无；返回：无。
fn main() {
    if tdc_lib::updates::install::run_helper_if_requested() {
        return;
    }
    tdc_lib::run()
}
