# cloudflare-edge_tunnel

基于 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) 的**一键部署 + 优选 IP** 工具，本地 Web 界面配置，不用手敲命令。

通过 Cloudflare Pages 部署 VLESS+WS+TLS+CDN 节点，永久免费，绑定自有域名，自动测速优选 CF IP 提速，生成的订阅直接导入 FlClash / Clash Verge / sing-box 等客户端。

## 特性

- 🖥️ **Web 界面**：5 步向导，填表即部署，极简交互
- 🚀 **一键部署**：自动建 KV、Pages 项目、绑自定义域、签证书
- ⚡ **优选 IP**：本机 TCP 实测 ~700 个 CF IP，自动写入最快的 30 个
- 🔑 **安全**：API Token 仅存内存，不落盘、不打日志
- 📋 **开箱即用**：生成订阅链接 + 后台地址 + 客户端导入指引

## 快速开始

```bash
git clone <本仓库地址> cloudflare-edge_tunnel
cd cloudflare-edge_tunnel
npm install
npm start
```

浏览器打开 `http://localhost:3000`，按界面走 5 步：

1. **认证** — 粘贴 Cloudflare API Token
2. **配置** — 选域名 + 子域 + UUID（全预填，可直接下一步）
3. **部署** — 点按钮，实时进度日志
4. **优选 IP** — 点按钮，测速并写入最快 IP
5. **完成** — 复制订阅链接，导入客户端

## 前置条件

- **Node.js ≥ 18**
- **Cloudflare 账号** + 一个**已托管在 CF 的域名**（zone 状态 Active）
- **API Token**：在 [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) 创建，需要以下权限：
  - `Zone` - `Zone` - `Read`
  - `Zone` - `DNS` - `Edit`
  - `Account` - `Workers Scripts` - `Edit`
  - `Account` - `Workers KV Storage` - `Edit`
  - `Account` - `Cloudflare Pages` - `Edit`
  - Zone Resources 限定你的域名

  或直接用 **"Edit Cloudflare Workers"** 模板 + 追加 DNS Edit + Pages Edit。

## 工作原理

```
浏览器 (localhost:3000)
    │  fetch /api/*
    ▼
本地 Express 服务 ──► Cloudflare REST API（ zones / pages / kv / dns ）
                     │
                     └─► wrangler pages deploy（上传 _worker.js）
                              │
                              ▼
                   edgetunnel 上游 raw _worker.js（部署时拉取）
```

- `_worker.js` **不入库**，部署时从 edgetunnel 上游拉取（带 CN 镜像 fallback）
- 部署用 **Cloudflare Pages**（edgetunnel README 标注的最佳推荐方式，比 Workers 部署稳）
- 优选 IP 用 `net.createConnection` TCP 实测延迟，写入 KV 的 `ADD.txt`，并设置 `config.json` 的 `随机IP=false`

## 命令行备选

不用 UI 也可直接命令行部署：

```bash
CF_API_TOKEN=xxxxx node scripts/deploy-cli.mjs --zone royoyourdomain.com --subdomain cf-proxy
```

参数：
- `--zone` 域名（必填）
- `--subdomain` 子域（默认 `cf-proxy`）
- `--uuid` 自定义 UUID（默认随机生成）
- `--optimize` 部署后顺带测速优选

## 订阅与客户端

部署完成后，界面会给到：

- **订阅链接**：`https://<子域>.<域名>/sub?token=<...>`
- **后台地址**：`https://<子域>.<域名>/<UUID>`（管理员密码 = UUID）
- **FlClash / Clash Verge**：新建订阅 → URL → 粘贴订阅链接
- **sing-box**：用 `/sub?token=...&singbox=1` 获取 sing-box 格式

## FAQ

**Q: 为什么用 Pages 而不是 Workers？**
A: edgetunnel 的 `_worker.js` 在 Workers 部署下线上会异常（回源到 nginx 伪装页），Pages 部署正常。这是上游 README 标注的「最佳推荐」方式。

**Q: 优选 IP 真的有效吗？**
A: 是。默认节点用 CF 随机 IP，本机到这些 IP 的延迟不定。工具实测 700+ 个 CF Anycast IP 的 TCP 延迟，取最快的 30 个写入订阅，能明显降低握手延迟。

**Q: 会被 Cloudflare 封号吗？**
A: 自建代理属 ToS 灰区，正常个人使用极少触发。免费版 100k 请求/天 + 10ms CPU/请求，WebSocket 长连接不计请求数，日常够用。

**Q: Token 安全吗？**
A: Token 仅存在本地服务的内存里，不写文件、不打日志、不发往任何第三方。关闭服务即清除。

## 致谢

- [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) — 核心隧道方案
- [Cloudflare](https://www.cloudflare.com/) — 免费边缘计算与 CDN

## License

MIT。edgetunnel 源码版权归上游原作者，本仓库仅提供部署工具。
