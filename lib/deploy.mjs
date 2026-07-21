/**
 * 部署编排：fetch worker → KV → Pages 项目 → 部署 → 环境变量/KV 绑定 → 自定义域 → CNAME。
 *
 * 用 Cloudflare Pages 部署（edgetunnel README 标注的最佳推荐方式）。
 * Pages 文件上传通过 wrangler 完成，其余操作走 REST API。
 *
 * @typedef {Object} DeployParams
 * @property {string} token Cloudflare API token
 * @property {string} zoneId
 * @property {string} zoneName 如 royoyourdomain.com
 * @property {string} subdomain 如 cf-proxy
 * @property {string} uuid
 * @property {(e:{step:string,status:string,message:string,detail?:string})=>void} [onProgress]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifyToken, listZones, createKV, listKV,
  createPagesProject, getPagesProject, patchPagesSettings,
  bindPagesDomain, listPagesDomains,
  listDNSRecords, createDNSRecord, deleteDNSRecord,
} from './cf-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_URLS = [
  'https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js',
  'https://gitclone.com/github.com/cmliu/edgetunnel/raw/main/_worker.js',
  'https://ghfast.top/https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js',
];

/** 从上游拉取 _worker.js，带多个镜像 fallback */
async function fetchWorker(onProgress) {
  for (const url of WORKER_URLS) {
    try {
      onProgress?.({ step: 'fetch-worker', status: 'start', message: `拉取 _worker.js`, detail: url });
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.includes('export default')) throw new Error('内容不像 Worker 代码');
      onProgress?.({ step: 'fetch-worker', status: 'ok', message: '已拉取 _worker.js', detail: `${(text.length / 1024).toFixed(0)} KiB` });
      return text;
    } catch (e) {
      onProgress?.({ step: 'fetch-worker', status: 'error', message: `镜像失败：${e.message}`, detail: url });
    }
  }
  throw new Error('所有镜像均无法拉取 _worker.js，请检查网络（可能需要代理）');
}

/**
 * 剥离代理环境变量。本机 127.0.0.1:7890 常是死代理（如过期机场），
 * wrangler 自带代理检测会误用导致 fetch failed。Node 的 fetch 不读这些变量，
 * 所以服务端调 CF API 不受影响，但 spawn wrangler 时必须剥离，让它直连。
 */
function cleanProxyEnv() {
  const strip = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const env = { ...process.env };
  for (const k of strip) delete env[k];
  return env;
}

/** 解析 wrangler 可执行文件路径（优先本地 node_modules，回退全局） */
function resolveWrangler() {
  const local = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
  return local; // 不存在时 spawn 会失败，由调用方回退 npx
}

/** 运行 wrangler，流式收集输出 */
function runWrangler(args, { env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveWrangler();
    const child = spawn(bin, args, {
      env: { ...cleanProxyEnv(), ...env },
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', async (e) => {
      if (e.code === 'ENOENT') {
        // 回退 npx
        try {
          const r = await runNpxWrangler(args, { env, cwd });
          resolve(r);
        } catch (e2) { reject(e2); }
      } else reject(e);
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`wrangler 退出码 ${code}\n${stderr || stdout}`));
    });
  });
}

function runNpxWrangler(args, { env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', 'wrangler', ...args], {
      env: { ...cleanProxyEnv(), ...env }, cwd, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`wrangler(npx) 退出码 ${code}\n${stderr || stdout}`));
    });
  });
}

/**
 * 主部署流程。
 * @param {DeployParams} p
 * @returns {Promise<{accountId:string, projectName:string, kvId:string, hostname:string, pagesUrl:string}>}
 */
export async function deploy(p) {
  const { token, zoneId, zoneName, subdomain, uuid, onProgress } = p;
  const hostname = `${subdomain}.${zoneName}`;
  const projectName = 'edt-pages';

  // 1. 验证 token + 拿 account
  onProgress?.({ step: 'verify', status: 'start', message: '验证 API Token' });
  await verifyToken(token);
  const zones = await listZones(token);
  const zone = zones.find((z) => z.id === zoneId);
  if (!zone) throw new Error('未找到该 zone，请确认域名已托管在当前账号');
  const accountId = zone.account.id;
  onProgress?.({ step: 'verify', status: 'ok', message: `账号 ${accountId.slice(0, 8)}… zone ${zoneName}` });

  // 2. 拉 _worker.js
  const workerCode = await fetchWorker(onProgress);

  // 3. KV（幂等：同名复用）
  onProgress?.({ step: 'kv', status: 'start', message: '准备 KV 命名空间' });
  let kv = (await listKV(token, accountId)).find((k) => k.title === 'edt-kv');
  if (!kv) {
    kv = await createKV(token, accountId, 'edt-kv');
    onProgress?.({ step: 'kv', status: 'ok', message: '已创建 KV edt-kv' });
  } else {
    onProgress?.({ step: 'kv', status: 'ok', message: '复用已有 KV edt-kv' });
  }
  const kvId = kv.id;

  // 4. Pages 项目（幂等）
  onProgress?.({ step: 'pages-project', status: 'start', message: '准备 Pages 项目' });
  let project;
  try {
    project = await getPagesProject(token, accountId, projectName);
    onProgress?.({ step: 'pages-project', status: 'ok', message: '复用已有 Pages 项目' });
  } catch {
    project = await createPagesProject(token, accountId, projectName);
    onProgress?.({ step: 'pages-project', status: 'ok', message: '已创建 Pages 项目' });
  }
  // 项目实际 subdomain（CF 在名字被占时加后缀，如 edt-pages -> edt-pages-5az），
  // CNAME 目标与 deploy result 都要用它，故在 try 块外声明。
  const projectSubdomain = project.subdomain;
  if (!projectSubdomain) {
    throw new Error('无法获取 Pages 项目 subdomain');
  }

  // 5. 写临时目录 + wrangler 部署
  const tmp = await mkdtemp(path.join(tmpdir(), 'edt-deploy-'));
  try {
    await writeFile(path.join(tmp, '_worker.js'), workerCode);

    onProgress?.({ step: 'pages-deploy', status: 'start', message: '上传 _worker.js 到 Pages' });
    const r1 = await runWrangler(
      ['pages', 'deploy', tmp, '--project-name', projectName, '--branch', 'main', '--commit-dirty=true'],
      { env: { CLOUDFLARE_API_TOKEN: token } },
    );
    const pagesUrl = (r1.stdout.match(/https:\/\/[^\s]+\.pages\.dev/) || [])[0] || '';
    onProgress?.({ step: 'pages-deploy', status: 'ok', message: '已部署', detail: pagesUrl });

    // 6. 设置环境变量 + KV 绑定
    onProgress?.({ step: 'settings', status: 'start', message: '设置 UUID 环境变量 + KV 绑定' });
    await patchPagesSettings(token, accountId, projectName, {
      production: {
        env_vars: { UUID: { value: uuid }, PROXYIP: { value: '' } },
        kv_namespaces: { KV: { namespace_id: kvId } },
      },
    });
    onProgress?.({ step: 'settings', status: 'ok', message: '环境变量 + KV 绑定已设置' });

    // 7. 重新部署让绑定生效
    onProgress?.({ step: 'redeploy', status: 'start', message: '重新部署使绑定生效' });
    await runWrangler(
      ['pages', 'deploy', tmp, '--project-name', projectName, '--branch', 'main', '--commit-dirty=true'],
      { env: { CLOUDFLARE_API_TOKEN: token } },
    );
    onProgress?.({ step: 'redeploy', status: 'ok', message: '重新部署完成' });

    // 8. 绑自定义域（幂等：先查本项目是否已绑）
    onProgress?.({ step: 'domain', status: 'start', message: `绑定自定义域 ${hostname}` });
    const existing = await listPagesDomains(token, accountId, projectName);
    if (existing.some((d) => d.name === hostname)) {
      onProgress?.({ step: 'domain', status: 'ok', message: '自定义域已绑定到本项目' });
    } else {
      try {
        await bindPagesDomain(token, accountId, projectName, hostname);
        onProgress?.({ step: 'domain', status: 'ok', message: `已绑定 ${hostname}` });
      } catch (e) {
        if (/already|exist|in use|another/i.test(e.message)) {
          throw new Error(
            `${hostname} 已绑定到其他 Pages 项目（可能是一次手动部署留下的 edt-royo-pages）。` +
            `请到 Dashboard → Pages → 该项目 → Custom Domains 解绑，或换一个子域名重试。`,
          );
        }
        throw e;
      }
    }

    // 9. CNAME（若未设置）
    onProgress?.({ step: 'cname', status: 'start', message: '检查 CNAME 记录' });
    const cnameTarget = `${projectSubdomain}.pages.dev`;
    const recs = await listDNSRecords(token, zoneId, hostname);
    const hasCNAME = recs.some((r) => r.type === 'CNAME' && r.content.includes(cnameTarget));
    if (!hasCNAME) {
      // 删除该 hostname 下所有现存记录（错误 CNAME + 残留 A/AAAA），再建正确的
      for (const r of recs) {
        await deleteDNSRecord(token, zoneId, r.id);
      }
      await createDNSRecord(token, zoneId, { type: 'CNAME', name: subdomain, content: cnameTarget, proxied: true });
      onProgress?.({ step: 'cname', status: 'ok', message: `已创建 CNAME → ${cnameTarget}` });
    } else {
      onProgress?.({ step: 'cname', status: 'ok', message: `CNAME 已存在 -> ${cnameTarget}` });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  onProgress?.({ step: 'done', status: 'ok', message: '部署完成' });
  return { accountId, projectName, projectSubdomain, kvId, hostname, pagesUrl: `https://${hostname}` };
}
