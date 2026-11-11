# 通过内网 IP 部署 HTTPS

适用于浏览器直接访问服务器内网 IPv4 地址的部署。Caddy 在服务器上签发 IP 证书，转发网页、API 和 WebSocket。应用在 Compose 网络内通过 `ai-ide:3000` 接收请求。启用这份覆盖文件后，宿主机的 HTTPS 入口使用 `443`，`80` 用于重定向，原应用端口 `9798` 不再发布。

## 1. 配置并启动

需要 Docker Compose v2.24.4 或更新版本。选一个客户端可访问的服务器内网 IPv4 地址，确保该地址的 TCP `80` 和 `443` 可用。Caddy 将这两个端口绑定在选定的 IP 上。

在仓库根目录的 `.env` 中加入下面这一行，将示例替换为服务器实际的内网 IP。

```dotenv
CROWNFORGE_HTTPS_IP=192.168.1.20
```

已有 Compose 部署请沿用原工作目录，并在下面每条 Compose 命令中保留原来的 `-p`、`--env-file` 和覆盖文件参数。将 `-f docker-compose.https.yml` 加到最后。应用新的端口映射会重新创建应用容器，请在当前任务结束并保存编辑后执行。

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml config -q
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
```

已有 `ai-ide:latest` 镜像时，可以省略 `--build`。如果原来使用了 sandbox 覆盖文件，启动命令应包含以下三个文件。

```bash
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml \
  -f docker-compose.https.yml up -d
```

## 2. 让浏览器信任证书

在服务器导出此部署的根证书。

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml cp \
  caddy:/data/caddy/pki/authorities/local/root.crt /tmp/crownforge-local-ca.crt
```

首次启动时，若证书还未生成，可用相同的 Compose 参数执行 `logs caddy` 查看启动状态，再重试导出。

通过可信渠道将 `crownforge-local-ca.crt` 复制到访问设备，导入该浏览器使用的受信任根证书库。Firefox 如使用独立证书库，可在证书管理器的证书颁发机构中导入并信任它。保留服务器上的 `caddy-data` 数据卷，它保存 CA 私钥及已签发证书，重建容器时会继续使用同一 CA。 [Linux、macOS、Windows 的证书导入方法](https://caddyserver.com/docs/running#local-https-with-docker)

访问 `https://192.168.1.20`，地址与配置的 IP 保持一致。浏览器认可证书后，页面可以使用 `crypto.subtle` 和 `crypto.randomUUID()`。

## 3. 验证入口

在持有根证书的客户端运行下面的检查，替换 IP 和证书路径。

```bash
curl --fail --show-error --cacert /tmp/crownforge-local-ca.crt \
  https://192.168.1.20/api/health
```

健康检查通过后，用浏览器登录，打开终端或聊天面板确认 WebSocket 能连接，再编辑并保存一份测试文件。可在浏览器控制台用 `window.isSecureContext` 确认页面已进入安全上下文。若还需要手机控制台配对，手机也需信任这份 CA，并将 `MOBILE_PUBLIC_BASE_URL` 设置为手机访问的同一 HTTPS 源。 [手机控制台部署](../mobile-web-control.md)
