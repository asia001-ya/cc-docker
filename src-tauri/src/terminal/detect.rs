//! 终端输出中的限额提示识别（热切换的辅助信号；主信号是 statusline 上报的 rate_limits）。

use regex::Regex;

/// 限额文案检测器。
pub struct LimitDetector {
    patterns: Vec<Regex>,
    ansi: Regex,
    /// 跨帧保留的尾部文本，防止提示语被分帧截断
    tail: String,
}

impl LimitDetector {
    /// 由正则列表构造（非法正则会被忽略）。
    /// 参数：patterns——正则字符串；返回：检测器。
    pub fn new(patterns: &[String]) -> Self {
        Self {
            patterns: patterns.iter().filter_map(|p| Regex::new(p).ok()).collect(),
            ansi: Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)").expect("静态正则"),
            tail: String::new(),
        }
    }

    /// 扫描一帧输出。
    /// 参数：text——已解码的终端输出；返回：命中时返回匹配到的文本。
    pub fn scan(&mut self, text: &str) -> Option<String> {
        if self.patterns.is_empty() {
            return None;
        }
        let plain = self.ansi.replace_all(text, "");
        let joined = format!("{}{}", self.tail, plain);
        let hit = self.patterns.iter().find_map(|re| re.find(&joined).map(|m| m.as_str().to_string()));
        // 只保留最后 160 个字符作为下一帧前缀
        let chars: Vec<char> = joined.chars().collect();
        self.tail = chars[chars.len().saturating_sub(160)..].iter().collect();
        if hit.is_some() {
            self.tail.clear();
        }
        hit
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::store::QuotaSettings;

    #[test]
    fn 识别带颜色的限额提示并支持跨帧() {
        let mut d = LimitDetector::new(&QuotaSettings::default().limit_patterns);
        assert!(d.scan("\x1b[31m5-hour li").is_none());
        assert!(d.scan("mit reached ∙ resets 3pm\x1b[0m").is_some());
        assert!(d.scan("普通输出").is_none());
    }

    #[test]
    fn 非法正则被忽略() {
        let mut d = LimitDetector::new(&["(".to_string()]);
        assert!(d.scan("usage limit reached").is_none());
    }
}
