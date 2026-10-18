#!/usr/bin/env bash
# 仅在镜像构建时运行：按版本清单下载 Xray 并校验 sha256；容器运行时不再下载内核。
set -euo pipefail
XRAY="${TDC_XRAY_BIN:-/usr/local/bin/xray}"
RELEASE="${TDC_XRAY_RELEASE:-/opt/tdc/xray-release.json}"
version=$(jq -r '.version' "$RELEASE")
if [[ -x "$XRAY" ]] && [[ $("$XRAY" version | head -n 1) == "Xray $version "* ]]; then exit 0; fi
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo 'Xray 不支持当前容器架构' >&2; exit 1 ;;
esac
file=$(jq -r --arg a "$arch" '.assets[$a].file' "$RELEASE")
sum=$(jq -r --arg a "$arch" '.assets[$a].sha256' "$RELEASE")
base=$(jq -r '.baseUrl' "$RELEASE")
tmp=$(mktemp -d /tmp/tdc-xray-install.XXXXXXXX)
trap 'rm -rf -- "$tmp"' EXIT
if ! curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 60 --output "$tmp/xray.zip" "$base/$file"; then
  echo 'Xray 内核下载失败，请检查 GitHub 连通性或构建带 Xray 的最新标准镜像' >&2
  exit 1
fi
printf '%s  %s\n' "$sum" "$tmp/xray.zip" | sha256sum --check --status || {
  echo 'Xray 下载文件校验失败，未安装' >&2; exit 1;
}
unzip -p "$tmp/xray.zip" xray > "$tmp/xray"
chmod 0755 "$tmp/xray"
[[ $("$tmp/xray" version | head -n 1) == "Xray $version "* ]] || { echo 'Xray 版本校验失败' >&2; exit 1; }
install -m 0755 "$tmp/xray" "$XRAY.next"
mv -f -- "$XRAY.next" "$XRAY"
