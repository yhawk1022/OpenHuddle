# 编译打包 + 解压部署（单机 2C4G，零主机编译）

适用于没有 Docker 的轻量主机（如阿里云 2C4G Ubuntu）。所有编译都在开发机完成，主机上只做解压和切换。

## 1. 本地编译打包

```bash
bash scripts/release/build-tarball.sh
# 产物：dist-release/openhuddle-<version>-<sha>-<time>.tar.gz（约 19MB，生产依赖为纯 JS + WASM，不区分平台）
```

## 2. 上传并安装（目标主机 root）

```bash
T=$(ls -t dist-release/*.tar.gz | head -1); N=$(basename "$T")
scp "$T" root@cyanarch.com:/tmp/
tar -xzOf "$T" "${N%.tar.gz}/deploy/install.sh" | ssh root@cyanarch.com "cat > /tmp/oh-install.sh && bash /tmp/oh-install.sh /tmp/$N"
```

`install.sh` 依次执行以下步骤：

1. 首次运行时安装 Node 22 预编译二进制（优先 npmmirror）。
2. 创建 `openhuddle` 系统用户。
3. 解压到 `/opt/openhuddle/releases/<release>`。
4. 首次运行时生成 `/etc/openhuddle/openhuddle.env`，包含随机 `AUTH_SECRET`；之后发布不会覆盖该文件。
5. 复制 `/etc/cyanarch-mail/smtp.json`，作为阿里云 DirectMail 的发信凭据。
6. 切换软链 `current`，然后 `systemctl restart openhuddle`。
7. 做健康检查：失败时自动回滚到上一版本；成功时只保留最近 3 个版本。

## 3. cyanarch.com 线上拓扑

- 服务监听 `127.0.0.1:18789`。现有 nginx 站点 `www.cyanarch.com` 的 `location /` 已经反代到该端口（包含 WebSocket/SSE、`X-Forwarded-*`、`proxy_buffering off`），所以 **nginx 配置无需改动**。`/game`、`/desktop-demo`、`/agents` 等原有路由优先匹配，不受影响。
- 数据：`DATABASE_URL=file:///var/lib/openhuddle/pglite`（嵌入式 PGlite），实时总线使用 `memory`。
- 常用命令：`journalctl -u openhuddle -f`、`systemctl status openhuddle`；修改配置后执行 `systemctl restart openhuddle`。
- 回滚：`ln -sfn /opt/openhuddle/releases/<旧版本> /opt/openhuddle/current && systemctl restart openhuddle`。
