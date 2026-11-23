#!/usr/bin/env bash
# =============================================================================
# OpenHuddle 服务器端解压安装 / 原子切换脚本（在目标主机以 root 执行）
#
# 用法：
#   sudo ./deploy/install.sh /tmp/openhuddle-xxx.tar.gz
#
# 目录约定：
#   /opt/openhuddle/releases/<release>/   每次发布独立目录（不可变）
#   /opt/openhuddle/current -> releases/<release>   原子软链切换，便于秒级回滚
#   /var/lib/openhuddle/                  PGlite 数据目录（跨版本保留）
#   /etc/openhuddle/openhuddle.env        运行配置（0600，首次安装生成，后续不覆盖）
#
# 关键不变量：
# 1. 主机零编译：仅解压预编译产物，绝不在 2C4G 主机执行 tsc / vite / pnpm install。
# 2. 健康检查失败自动回滚到上一个版本，保证线上始终可用。
# =============================================================================
set -euo pipefail

TARBALL="${1:?Usage: install.sh <openhuddle-release.tar.gz>}"
APP_ROOT="/opt/openhuddle"
DATA_DIR="/var/lib/openhuddle"
ETC_DIR="/etc/openhuddle"
ENV_FILE="$ETC_DIR/openhuddle.env"
SERVICE_USER="openhuddle"
NODE_DIR="$APP_ROOT/node"

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }

# 1. 运行时：Node.js 22 预编译二进制（非源码编译），优先国内镜像
if [ ! -x "$NODE_DIR/bin/node" ]; then
  NODE_VERSION="${NODE_VERSION:-v22.21.1}"
  case "$(uname -m)" in
    x86_64) NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
  esac
  NODE_PKG="node-${NODE_VERSION}-linux-${NODE_ARCH}"
  echo "==> 安装 Node.js ${NODE_VERSION} (${NODE_ARCH})"
  mkdir -p "$APP_ROOT"
  for mirror in "https://npmmirror.com/mirrors/node" "https://nodejs.org/dist"; do
    if curl -fsSL --retry 2 -m 120 "$mirror/${NODE_VERSION}/${NODE_PKG}.tar.xz" -o "/tmp/${NODE_PKG}.tar.xz"; then
      break
    fi
  done
  rm -rf "$NODE_DIR" "$APP_ROOT/${NODE_PKG}"
  tar -C "$APP_ROOT" -xJf "/tmp/${NODE_PKG}.tar.xz"
  mv "$APP_ROOT/${NODE_PKG}" "$NODE_DIR"
  chown -R root:root "$NODE_DIR"
  rm -f "/tmp/${NODE_PKG}.tar.xz"
fi
"$NODE_DIR/bin/node" -v

# 2. 专用低权限系统用户与目录
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_ROOT/releases" "$DATA_DIR" "$ETC_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"

# 3. 解压到不可变发布目录（tar -t | head 会触发 SIGPIPE，pipefail 下需局部豁免）
RELEASE_NAME="$(set +o pipefail; tar -tzf "$TARBALL" 2>/dev/null | head -1 | cut -d/ -f1)"
[ -n "$RELEASE_NAME" ] || { echo "cannot read release name from $TARBALL" >&2; exit 1; }
RELEASE_DIR="$APP_ROOT/releases/$RELEASE_NAME"
echo "==> 解压 $RELEASE_NAME"
rm -rf "$RELEASE_DIR"
tar -C "$APP_ROOT/releases" -xzf "$TARBALL"
chown -R root:root "$RELEASE_DIR"
chmod -R go-w "$RELEASE_DIR"

# 4. 首次安装生成配置（含随机 AUTH_SECRET）；已存在则保留，避免覆盖线上密钥
if [ ! -f "$ENV_FILE" ]; then
  echo "==> 生成 $ENV_FILE"
  AUTH_SECRET_VALUE="$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | head -c 48)"
  sed "s|__AUTH_SECRET__|${AUTH_SECRET_VALUE}|" "$RELEASE_DIR/deploy/openhuddle.env.example" > "$ENV_FILE"
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# 5. SMTP 凭据：复制主机已有 cyanarch-mail 凭据给服务用户只读（不打印内容）
if [ -f /etc/cyanarch-mail/smtp.json ]; then
  install -m 640 -o root -g "$SERVICE_USER" /etc/cyanarch-mail/smtp.json "$ETC_DIR/smtp.json"
fi

# 6. systemd 单元
install -m 644 "$RELEASE_DIR/deploy/openhuddle.service" /etc/systemd/system/openhuddle.service
systemctl daemon-reload

# 7. 原子切换 + 健康检查 + 失败回滚
PREVIOUS="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
ln -sfn "$RELEASE_DIR" "$APP_ROOT/current.tmp"
mv -Tf "$APP_ROOT/current.tmp" "$APP_ROOT/current"
systemctl enable openhuddle.service >/dev/null 2>&1
systemctl restart openhuddle.service

PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)"
PORT="${PORT:-18789}"
for i in $(seq 1 30); do
  if curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then
    echo "==> 健康检查通过 (${i}s): $(curl -fsS "http://127.0.0.1:${PORT}/api/v1/health")"
    # 仅保留最近 3 个版本
    ls -1dt "$APP_ROOT"/releases/* | tail -n +4 | xargs -r rm -rf
    exit 0
  fi
  sleep 1
done

echo "!! 健康检查失败，最近日志：" >&2
journalctl -u openhuddle.service -n 40 --no-pager >&2 || true
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$RELEASE_DIR" ] && [ -d "$PREVIOUS" ]; then
  echo "!! 回滚到 $PREVIOUS" >&2
  ln -sfn "$PREVIOUS" "$APP_ROOT/current.tmp"
  mv -Tf "$APP_ROOT/current.tmp" "$APP_ROOT/current"
  systemctl restart openhuddle.service
fi
exit 1
