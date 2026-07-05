/**
 * 本地 Express 服务：托管 web/ 前端 + /api/* 端点。
 * Token 仅存内存，不落盘、不打日志。
 *
 * 启动：npm start  →  http://localhost:3000
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyToken, listZones, getPagesProject, listPagesDomains, canAccess } from './lib/cf-api.mjs';
import { deploy } from './lib/deploy.mjs';
import { buildCandidates, testBatch, toADDContent } from './lib/optimize-ips.mjs';
import { MD5MD5, genUUID } from './lib/md5.mjs';
import { getConfig, putConfig, disableRandomIP, putADD } from './lib/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const app = express();
app.use(express.json());

// 静态托管前端
app.use(express.static(path.join(ROOT, 'web')));

/** 统一异步错误包装 */
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  res.status(400).json({ success: false, error: e.message || String(e), cfErrors: e.cfErrors });
});

/* ---------------- 端点 ---------------- */

/** 验证 token + 列 zones + 探测权限 */
app.post('/api/verify-token', wrap(async (req, res) => {
  const { token } = req.body || {};
  if (!token) throw new Error('缺少 token');
  const v = await verifyToken(token);
  if (v.status !== 'active') throw new Error('Token 不可用');
  const zones = await listZones(token);
  const accountId = zones[0]?.account?.id;

  // 权限自检：探测各接口是否可调
  const perms = {};
  perms['Zone:Read'] = true; // listZones 成功即说明有
  if (zones[0]) {
    perms['Zone:DNS:Edit'] = await canAccess(token, `/zones/${zones[0].id}/dns_records?per_page=1`);
  }
  if (accountId) {
    perms['Account:Workers KV:Edit'] = await canAccess(token, `/accounts/${accountId}/storage/kv/namespaces`);
    perms['Account:Pages:Edit'] = await canAccess(token, `/accounts/${accountId}/pages/projects`);
    perms['Account:Workers Scripts:Edit'] = await canAccess(token, `/accounts/${accountId}/workers/scripts`);
  }
  const missing = Object.entries(perms).filter(([, ok]) => !ok).map(([k]) => k);

  res.json({
    success: true,
    accountId,
    zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status })),
    perms,
    missing,
  });
}));

/** 生成 UUID */
app.post('/api/uuid', (req, res) => res.json({ success: true, uuid: genUUID() }));

/** 算订阅 token + 返回订阅/后台 URL */
app.post('/api/subscription', wrap(async (req, res) => {
  const { host, uuid } = req.body || {};
  if (!host || !uuid) throw new Error('缺少 host 或 uuid');
  const token = MD5MD5(host + uuid);
  res.json({
    success: true,
    token,
    subscription: `https://${host}/sub?token=${token}`,
    admin: `https://${host}/${uuid}`,
    password: uuid,
  });
}));

/** 部署（SSE 流式进度） */
app.post('/api/deploy', (req, res) => {
  const { token, zoneId, zoneName, subdomain, uuid } = req.body || {};
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  deploy({
    token, zoneId, zoneName, subdomain, uuid,
    onProgress: (e) => send(e),
  }).then((result) => {
    send({ step: 'result', status: 'ok', message: '部署完成', result });
    res.end();
  }).catch((e) => {
    send({ step: 'error', status: 'error', message: e.message || String(e), cfErrors: e.cfErrors });
    res.end();
  });
});

/** 优选 IP 测速 + 写入 KV（SSE 流式进度） */
app.post('/api/optimize-ips', (req, res) => {
  const { token, accountId, kvId, host, uuid, count = 30 } = req.body || {};
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  if (!token || !accountId || !kvId || !host || !uuid) {
    send({ type: 'error', message: '缺少参数（token/accountId/kvId/host/uuid）' });
    return res.end();
  }

  (async () => {
    const ips = buildCandidates(16);
    send({ type: 'start', total: ips.length });
    const ranked = await testBatch(ips, {
      concurrency: 50,
      onProgress: (done, total) => {
        if (done % 20 === 0 || done === total) send({ type: 'progress', done, total });
      },
    });
    send({ type: 'tested', reachable: ranked.length });

    const addContent = toADDContent(ranked, count);
    await putADD(token, accountId, kvId, addContent);
    send({ type: 'add-written', count: Math.min(count, ranked.length) });

    const config = await getConfig(token, accountId, kvId);
    if (config) {
      disableRandomIP(config);
      await putConfig(token, accountId, kvId, config);
      send({ type: 'config-updated' });
    }
    send({
      type: 'result',
      top: ranked.slice(0, count).map((r, i) => ({ ip: r.ip, ms: Math.round(r.ms), rank: i + 1 })),
    });
    res.end();
  })().catch((e) => {
    send({ type: 'error', message: e.message || String(e) });
    res.end();
  });
});

/** 查状态：Pages 项目、自定义域、节点数 */
app.post('/api/status', wrap(async (req, res) => {
  const { token, accountId, projectName = 'edt-pages', host, uuid } = req.body || {};
  const out = {};
  try { out.project = await getPagesProject(token, accountId, projectName); } catch { out.project = null; }
  try { out.domains = await listPagesDomains(token, accountId, projectName); } catch { out.domains = []; }
  if (host && uuid) {
    try {
      const subToken = MD5MD5(host + uuid);
      const r = await fetch(`https://${host}/sub?token=${subToken}`, {
        headers: { 'User-Agent': 'clash.meta' },
        signal: AbortSignal.timeout(15000),
      });
      const text = await r.text();
      out.nodeCount = (text.match(/^\s+- \{/gm) || []).length;
    } catch (e) { out.nodeError = e.message; }
  }
  res.json({ success: true, ...out });
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ▸ cloudflare-edge_tunnel 配置工具已启动`);
  console.log(`  ▸ 浏览器打开：http://localhost:${PORT}\n`);
});
