#!/usr/bin/env node
/**
 * 命令行部署入口（复用 lib/deploy.mjs + lib/optimize-ips.mjs）。
 *
 * 用法：
 *   CF_API_TOKEN=xxx node scripts/deploy-cli.mjs --zone royoyourdomain.com [--subdomain cloudflare-edgetunnel] [--uuid <uuid>] [--optimize]
 */
import { deploy } from '../lib/deploy.mjs';
import { buildCandidates, testBatch, toADDContent } from '../lib/optimize-ips.mjs';
import { verifyToken, listZones, listKV } from '../lib/cf-api.mjs';
import { getConfig, putConfig, disableRandomIP, putADD } from '../lib/config.mjs';
import { MD5MD5, genUUID } from '../lib/md5.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [, k, v] = a.match(/^--([^=]+)(?:=(.*))?$/) || [];
    return [k, v ?? true];
  }),
);

const token = process.env.CF_API_TOKEN;
if (!token) { console.error('缺少 CF_API_TOKEN 环境变量'); process.exit(1); }
if (!args.zone) { console.error('缺少 --zone 参数'); process.exit(1); }

const subdomain = args.subdomain || 'cloudflare-edgetunnel';
const uuid = args.uuid || genUUID();
const onProgress = (e) => {
  const ico = e.status === 'ok' ? '✓' : e.status === 'error' ? '✗' : '→';
  console.log(`  ${ico} [${e.step}] ${e.message}${e.detail ? ` (${e.detail})` : ''}`);
};

try {
  await verifyToken(token);
  const zones = await listZones(token);
  const zone = zones.find((z) => z.name === args.zone);
  if (!zone) throw new Error(`未找到 zone ${args.zone}（确认域名已托管在当前账号且 status=active）`);

  console.log(`\n部署 ${subdomain}.${args.zone}，UUID=${uuid}\n`);
  const result = await deploy({
    token, zoneId: zone.id, zoneName: zone.name, subdomain, uuid, onProgress,
  });

  const subToken = MD5MD5(result.hostname + uuid);
  console.log(`\n── 完成 ──`);
  console.log(`  订阅：https://${result.hostname}/sub?token=${subToken}`);
  console.log(`  后台：https://${result.hostname}/${uuid}`);
  console.log(`  密码：${uuid}`);

  if (args.optimize) {
    console.log(`\n优选 IP 测速…`);
    const kvs = await listKV(token, result.accountId);
    const kv = kvs.find((k) => k.id === result.kvId);
    if (!kv) throw new Error('KV 不存在');
    const ranked = await testBatch(buildCandidates(16), { concurrency: 50 });
    await putADD(token, result.accountId, result.kvId, toADDContent(ranked, 30));
    const config = await getConfig(token, result.accountId, result.kvId);
    if (config) { disableRandomIP(config); await putConfig(token, result.accountId, result.kvId, config); }
    console.log(`  写入 ${Math.min(30, ranked.length)} 个优选 IP，最快 ${Math.round(ranked[0].ms)}ms`);
  }
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}
