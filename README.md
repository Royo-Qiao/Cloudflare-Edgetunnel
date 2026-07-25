# Cloudflare-Edgetunnel

给 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) 包了一层本地 Web 界面，填个表就能把 VLESS+WS+TLS 节点部署到 Cloudflare Pages 上——永久免费、绑自己的域名，还会自动帮你测速挑出最快的 CF IP。

## 能做什么

- 网页填表，5 步走完部署（认证 → 配置域名/UUID → 部署 → 优选 IP → 拿订阅链接），不用记命令
- 自动建 KV、建 Pages 项目、绑域名、签证书
- 对 ~700 个 Cloudflare IP 做 TCP 测速，把最快的 30 个写进订阅，减少握手延迟
- 部署完直接给订阅链接，Clash导入后可直接用

## 前置准备

- Node.js ≥ 18
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
CF_API_TOKEN=xxxxx node scripts/deploy-cli.mjs --zone yourdomain.com --subdomain cf-proxy
```

参数：
- `--zone` 域名，必填
- `--subdomain` 子域，默认 `cf-proxy`
- `--uuid` 自定义 UUID，不填就随机生成
- `--optimize` 部署完顺便测速优选

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
- 优选 IP 靠 `net.createConnection` 实测 TCP 延迟，结果写进 KV 的 `ADD.txt`，同时把 `config.json` 的「随机IP」关掉

## 进阶

部署完成后会提供后台地址：`https://<子域>.<域名>/<UUID>`，管理员密码就是 UUID

想了解节点实现细节、自定义 Worker 逻辑，可以研究一下上游项目 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel)。
