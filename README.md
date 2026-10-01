# Cloudflare-Edgetunnel — 本地 Web 部署向导

<p align="center">
  <a href="NOTICE.md"><img alt="License: MIT + GPL-2.0" src="https://img.shields.io/badge/license-MIT_%2B_GPL--2.0-blue.svg"></a>
  <img alt="Deploys to Cloudflare Pages" src="https://img.shields.io/badge/deploys_to-Cloudflare_Pages-f6821c?logo=cloudflare&logoColor=white">
</p>

面向已有 Cloudflare 托管域名的用户，通过本地 Web 向导将 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) 的 VLESS+WS+TLS 节点部署到 Cloudflare Pages，自动配置 Pages、KV 与自定义域名，并生成 Clash 订阅链接。

**English:** A local web GUI for deploying cmliu/edgetunnel to Cloudflare Pages, with Pages/KV/custom-domain setup, TLS-latency IP selection, and Clash subscriptions.

工具开源；Cloudflare 资源的费用与限制以账号套餐及平台规则为准，域名需自行准备。

## 界面演示

<p align="center">
  <img src="https://github.com/Royo-Qiao/Cloudflare-Edgetunnel/releases/download/v1.0.0/demo.webp" width="800" alt="Cloudflare-Edgetunnel Web 向导界面演示">
</p>

## 能做什么

- 部署流程由本地 Web 向导完成：认证 → 配置域名/UUID → 部署 → 优选 IP → 获取订阅链接
- 自动创建 KV 与 Pages 项目，并配置自定义域名和 DNS
- 从 320 个候选 Cloudflare IP 中，按当前网络下携带节点域名 SNI 的 TLS 建连耗时排序，将至多 30 个可连接地址写入订阅配置；此测量不代表下载吞吐或代理全链路速度
- 生成 Clash 订阅链接；导入客户端后检查节点连接状态

## 前置准备

- Node.js ≥ 22（lockfile 锁定的 wrangler 要求 Node ≥ 22）
- 一个已经托管在 Cloudflare、状态是 Active 的域名，参考：[Cloudflare 添加站点教程](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/) 流程很简单：  

  买一个域名 → 登录 Cloudflare 添加站点 → 选 Free 套餐 → 把域名注册商那边的 Nameserver 改成 Cloudflare 给你的两条 NS 记录，等几分钟状态变成 Active 就行

- 在 [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) 建一个 API Token，需要这些权限：
  - Zone → Zone → Read
  - Zone → DNS → Edit
  - Account → Workers Scripts → Edit
  - Account → Workers KV Storage → Edit
  - Account → Cloudflare Pages → Edit
  - Zone Resources 限定成你自己的域名

  嫌麻烦可以直接套官方 "Edit Cloudflare Workers" 模板，再加上 DNS Edit 和 Pages Edit 两条权限。

## 快速开始

```bash
git clone https://github.com/Royo-Qiao/Cloudflare-Edgetunnel.git
cd Cloudflare-Edgetunnel
npm install
npm start
```

打开 `http://localhost:3000`，跟着页面走：认证 → 配置 → 部署 → 优选 IP → 完成。

不想用界面，命令行也能直接部署：

```bash
CF_API_TOKEN=xxxxx node scripts/deploy-cli.mjs --zone=yourdomain.com --subdomain=cloudflare-edgetunnel
```

将 `xxxxx` 和 `yourdomain.com` 替换为自己的 Token 与域名。所有带值参数使用 `--参数=值` 格式。

参数：
- `--zone` 域名，必填
- `--subdomain` 子域，默认 `cloudflare-edgetunnel`
- `--uuid` 自定义 UUID，不填就随机生成
- `--optimize` 部署完进行 TLS 建连延迟优选

重新部署已有节点时，CLI 未指定 `--uuid` 会生成新 UUID；请显式传入原 UUID，或使用会尝试读取现有 UUID 的 Web 向导。

### 完成后检查

- 在 Cloudflare 控制台确认 Pages 自定义域状态。
- 将生成的订阅链接导入客户端，并确认节点可以连接。
- 保存部署时使用的域名、UUID 与订阅信息，重新部署前先核对。

## 工作原理

```
浏览器 (localhost:3000)
    │  fetch /api/*
    ▼
本地 Express 服务 ──► Cloudflare REST API（ zones / pages / kv / dns ）
                     │
                     ├─► wrangler pages deploy（上传 _worker.js）
                     │        │
                     │        ▼
                     │  edgetunnel 上游 raw _worker.js（部署时拉取）
                     │
                     └─► wrangler pages deploy（admin-ui/ → edt-admin-ui 项目）
```

几个关键点：

- `_worker.js` 不放进仓库，每次部署都从 edgetunnel 上游拉最新版（国内访问不了自动切镜像）
- Web 和 CLI 入口都使用携带节点域名 SNI 的 TLS 建连测试，默认对每个 IP 测两次并取较小耗时；排序结果写进 KV 的 `ADD.txt`，同时关闭 `config.json` 的「随机IP」
- **资源按子域标签命名**：Pages 项目 `edt-pages-<子域标签>` + KV 命名空间 `edt-kv-<子域标签>`。不同标签对应不同资源；同一账号跨主域复用相同标签时，应先核查资源复用。


## 常见踩坑

**⚠️ 换子域标签或重新部署时，如何保留旧订阅？**

资源名只包含子域标签，不包含主域。使用不同标签会对应不同的 Pages/KV 资源；同一账号下跨主域使用相同标签时，不应假定资源完全隔离。

- 同一个子域重新部署：向导第 2 步会自动读取该子域对应项目的 UUID 并预填沿用，**不会擅自生成新 UUID**
- 网络不通时读不到已部署 UUID，工具会生成新 UUID 并弹警告——**这种情况下别直接部署**，检查网络后重进该步，否则可能顶掉在用订阅
- 换成不同的子域标签会使用不同资源；已有标签重新部署前，先核对 UUID 与订阅配置


**⚠️ 部署时 fetch failed - 网络问题**

部署过程中如遇报错 `fetch failed` / `UND_ERR_CONNECT_TIMEOUT`，请检查本地是否能连上 `api.cloudflare.com`。

工具会读取 `HTTP_PROXY` 等环境变量；存在本地代理配置时，wrangler 在网络错误后交替尝试直连和代理，每次重试间隔 2.5 秒。没有代理配置时仅重试直连；业务错误不会通过切换网络重试。


## 进阶

部署完成后会提供后台地址：`https://<子域>.<域名>/<UUID>`，管理员密码就是 UUID

想了解节点实现细节、自定义 Worker 逻辑，可以研究一下上游项目 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel)。

## 贡献

欢迎提 issue 讨论问题，或直接开 PR。环境要求与本地开发步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)；提交 PR 前请先阅读该文档，参与即视为同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 致谢上游

本项目的节点实现完全依赖上游项目：

- [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) —— 提供核心 `_worker.js`（每次部署实时拉取上游最新版）
- [edt-pages/EDT-Pages.github.io](https://github.com/edt-pages/EDT-Pages.github.io) —— 本仓库 `admin-ui/` 管理界面在其基础上 fork 修改而来

edgetunnel 上游项目版权归其原作者所有；`admin-ui/` 目录为 GPL-2.0 衍生代码，随上游继续以 GPL-2.0 授权。详见 [NOTICE.md](NOTICE.md)。

## 许可

本仓库自有代码（Web 向导、`lib/`、部署脚本等）以 [MIT](LICENSE) 授权，© Cloudflare-Edgetunnel contributors。

`admin-ui/` 目录为 GPL-2.0 衍生代码，继续以上游的 [GNU GPL-2.0](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) 授权，详见 [NOTICE.md](NOTICE.md)。
