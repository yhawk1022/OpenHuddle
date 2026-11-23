#!/usr/bin/env bash
# =============================================================================
# OpenHuddle 本地编译打包脚本（2C4G 主机零编译部署）
#
# 在开发机 / CI 上完成全部 TypeScript + Vite 编译，并用 `pnpm deploy --prod`
# 生成自包含的生产 node_modules，最终产出单个 tarball：
#   dist-release/openhuddle-<version>-<gitsha>.tar.gz
#
# 解压后结构（路径与 apps/server/src/app.ts 的相对定位约定保持一致）：
#   apps/server/{dist,public/openhuddle.mjs,node_modules,package.json}
#   apps/web/dist
#   deploy/{install.sh,openhuddle.service,openhuddle.env.example}
#
# 关键不变量：生产依赖均为纯 JS / WASM（PGlite），与开发机 OS/CPU 架构无关，
# 因此 macOS 上打出的包可直接在 Linux x86_64 / arm64 主机运行。
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  GIT_SHA="${GIT_SHA}-dirty"
fi
STAMP="$(date -u +%Y%m%d%H%M%S)"
RELEASE_NAME="openhuddle-${VERSION}-${GIT_SHA}-${STAMP}"
OUT_DIR="$ROOT_DIR/dist-release"
STAGE_DIR="$OUT_DIR/$RELEASE_NAME"

echo "==> [1/4] 全量编译（protocol / core-governance / db / mcp / cli / server / web）"
pnpm build

echo "==> [2/4] 生成自包含生产依赖（pnpm deploy --prod）"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/apps" "$STAGE_DIR/deploy"
pnpm --filter @openhuddle/server deploy --prod --legacy "$STAGE_DIR/apps/server" >/dev/null

# legacy deploy 会 hoist 原工作区链接。在本机这些链接可能有效，移到服务器后才会断开。
node - "$STAGE_DIR" <<'JS'
const { existsSync, readdirSync, readlinkSync, unlinkSync } = require("node:fs");
const { join, resolve, sep } = require("node:path");

const stage = process.argv[2];
const hoisted = join(stage, "apps/server/node_modules/.pnpm/node_modules/@openhuddle");
if (existsSync(hoisted)) {
  for (const entry of readdirSync(hoisted, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const link = join(hoisted, entry.name);
    const target = resolve(hoisted, readlinkSync(link));
    if (target !== stage && !target.startsWith(stage + sep)) unlinkSync(link);
  }
}
JS

# pnpm deploy 依据 files/全量拷贝源码目录；确保编译产物与 CLI 单文件存在
rm -rf "$STAGE_DIR/apps/server/src" "$STAGE_DIR/apps/server/.data" "$STAGE_DIR/apps/server/.turbo"
cp -R apps/server/dist "$STAGE_DIR/apps/server/dist"
mkdir -p "$STAGE_DIR/apps/server/public"
cp apps/server/public/openhuddle.mjs "$STAGE_DIR/apps/server/public/openhuddle.mjs"

echo "==> [3/4] 拷贝 Web 静态产物与部署模板"
mkdir -p "$STAGE_DIR/apps/web"
cp -R apps/web/dist "$STAGE_DIR/apps/web/dist"
cp deploy/tarball/install.sh deploy/tarball/openhuddle.service deploy/tarball/openhuddle.env.example "$STAGE_DIR/deploy/"
chmod 755 "$STAGE_DIR/deploy/install.sh"
cat > "$STAGE_DIR/RELEASE" <<EOF
name=${RELEASE_NAME}
version=${VERSION}
git=${GIT_SHA}
builtAt=${STAMP}
EOF

# 冒烟校验：关键入口必须存在，避免上传残缺包
for required in apps/server/dist/index.js apps/server/public/openhuddle.mjs apps/web/dist/index.html apps/server/node_modules/@openhuddle/db/dist/index.js; do
  if [ ! -f "$STAGE_DIR/$required" ]; then
    echo "!! 打包校验失败：缺少 $required" >&2
    exit 1
  fi
done

echo "==> [4/4] 压缩 tarball"
# 剥离 macOS 扩展属性（com.apple.provenance 等），避免 GNU tar 在 Linux 解压时告警
export COPYFILE_DISABLE=1
if tar --version 2>/dev/null | grep -q bsdtar; then
  tar --no-xattrs --no-mac-metadata -C "$OUT_DIR" -czf "$OUT_DIR/$RELEASE_NAME.tar.gz" "$RELEASE_NAME"
else
  tar -C "$OUT_DIR" -czf "$OUT_DIR/$RELEASE_NAME.tar.gz" "$RELEASE_NAME"
fi
rm -rf "$STAGE_DIR"
du -h "$OUT_DIR/$RELEASE_NAME.tar.gz"
echo "$OUT_DIR/$RELEASE_NAME.tar.gz"
