//! 终端输出环形缓冲：保存最近 N 字节原始输出，前端重新附着（切 Tab / 刷新）时整体回放。

/// 定长字节环形缓冲。
pub struct Ring {
    buf: Vec<u8>,
    cap: usize,
}

impl Ring {
    /// 创建环形缓冲。参数：cap——容量（字节）；返回：Ring。
    pub fn new(cap: usize) -> Self {
        Self { buf: Vec::with_capacity(cap.min(64 * 1024)), cap }
    }

    /// 追加数据，超出容量时丢弃最旧部分。参数：data——新数据；返回：无。
    pub fn push(&mut self, data: &[u8]) {
        if data.len() >= self.cap {
            self.buf.clear();
            self.buf.extend_from_slice(&data[data.len() - self.cap..]);
            return;
        }
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(..overflow);
        }
        self.buf.extend_from_slice(data);
    }

    /// 取出可安全回放的快照：跳过开头被截断的 UTF-8 续字节，避免出现乱码首字符。
    /// 参数：无；返回：字节副本。
    pub fn snapshot(&self) -> Vec<u8> {
        let skip = self.buf.iter().take(4).take_while(|b| (**b & 0xC0) == 0x80).count();
        self.buf[skip..].to_vec()
    }
}

/// 把字节流切分为"完整 UTF-8 前缀 + 残尾"，残尾留到下一帧拼接（解决中文被读边界劈断）。
/// 参数：carry——上一帧残尾（会被消费并写入新残尾）；chunk——本帧数据；返回：可直接解码的完整字节。
pub fn split_utf8(carry: &mut Vec<u8>, chunk: &[u8]) -> Vec<u8> {
    let mut data = std::mem::take(carry);
    data.extend_from_slice(chunk);
    let valid = match std::str::from_utf8(&data) {
        Ok(_) => data.len(),
        Err(e) => match e.error_len() {
            // 末尾不完整序列：保留到下一帧
            None => e.valid_up_to(),
            // 中间存在非法字节：整体交给 lossy 解码，不再拖尾
            Some(_) => data.len(),
        },
    };
    *carry = data.split_off(valid);
    if carry.len() > 3 {
        // 防御：残尾超过 UTF-8 最大长度说明不是合法前缀，直接放行
        data.append(carry);
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 超出容量时保留最新数据() {
        let mut r = Ring::new(5);
        r.push(b"abc");
        r.push(b"defg");
        assert_eq!(r.snapshot(), b"cdefg");
        r.push(b"0123456789");
        assert_eq!(r.snapshot(), b"56789");
    }

    #[test]
    fn 快照跳过被截断的多字节字符() {
        let mut r = Ring::new(4);
        r.push("中文".as_bytes()); // 6 字节，保留后 4 字节：1 个续字节 + "文"
        assert_eq!(String::from_utf8(r.snapshot()).unwrap(), "文");
    }

    #[test]
    fn utf8_残尾跨帧拼接() {
        let bytes = "你好".as_bytes();
        let mut carry = Vec::new();
        let a = split_utf8(&mut carry, &bytes[..4]);
        assert_eq!(String::from_utf8(a).unwrap(), "你");
        assert_eq!(carry.len(), 1);
        let b = split_utf8(&mut carry, &bytes[4..]);
        assert_eq!(String::from_utf8(b).unwrap(), "好");
        assert!(carry.is_empty());
    }
}
