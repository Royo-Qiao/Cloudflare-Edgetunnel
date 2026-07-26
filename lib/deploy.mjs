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
 * @property {string} subdomain 如 cloudflare-edgetunnel
 * @property {string} uuid
 * @property {(e:{step:string,status:string,message:string,detail?:string})=>void} [onProgress]
 */
import { spawn } from 'node:child_process';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifyToken, listZones, createKV, listKV,
  createPagesProject, getPagesProject, patchPagesSettings,
  bindPagesDomain, listPagesDomains, unbindPagesDomain,
  listDNSRecords, createDNSRecord, deleteDNSRecord,
} from './cf-api.mjs';
import { getConfig, putConfig } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 上游后台 UI 静态站（_worker.js 里的 Pages静态页面 常量值） */
const ADMIN_UI_UPSTREAM = 'https://edt-pages.github.io';
/** 自托管后台 UI 的 Pages 项目名，源码在本仓库 admin-ui/ */
const ADMIN_UI_PROJECT = 'edt-admin-ui';
const ADMIN_UI_DIR = path.join(ROOT, 'admin-ui');
/**
 * 订阅导入客户端后显示的配置名，写入 config.json 的 优选订阅生成.SUBNAME。
 * worker 用它作 Content-Disposition 文件名（_worker.js 的 responseHeaders），
 * FlClash/Clash Verge 等据此命名配置。
 */
const SUB_NAME = 'Edgetunnel · Cloudflare';

/** Pages 项目名 → edt-pages-<子域名>（方案 A：每个子域一个项目，UUID/KV/配置完全隔离） */
const pagesProjectName = (subdomain) => `edt-pages-${subdomain}`;
/** KV 命名空间名 → edt-kv-<子域名>（与 Pages 项目一一对应） */
const kvNamespaceTitle = (subdomain) => `edt-kv-${subdomain}`;
const WORKER_URLS = [
  'https://cdn.jsdelivr.net/gh/cmliu/edgetunnel@main/_worker.js',
  'https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js',
  'https://ghfast.top/https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js',
  'https://gitclone.com/github.com/cmliu/edgetunnel/raw/main/_worker.js',
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
 * Pages 项目的访问基址。CF API 返回的 subdomain 字段通常已含 .pages.dev
 * （如 edt-pages-5az.pages.dev），名字被占时会加后缀，不可自己再拼。
 */
function pagesSubdomain(project) {
  const sub = project.subdomain;
  if (!sub) throw new Error(`无法获取 Pages 项目 ${project.name} 的 subdomain`);
  return sub.includes('.pages.dev') ? sub : `${sub}.pages.dev`;
}

/**
 * 部署管理后台 UI 静态站（admin-ui/ → edt-admin-ui Pages 项目，幂等）。
 * 只需 pages.dev 默认域：浏览器访问的是节点域名，由 Worker 服务端 fetch 本站转发，
 * 不绑自定义域、不需要 DNS。
 * @returns {Promise<string>} 形如 https://edt-admin-ui.pages.dev 的基址
 */
async function deployAdminUI({ token, accountId, onProgress }) {
  try {
    await access(ADMIN_UI_DIR);
  } catch {
    throw new Error(`未找到 ${ADMIN_UI_DIR}（后台 UI 源码目录），请恢复后重试`);
  }
  onProgress?.({ step: 'admin-ui', status: 'start', message: '准备后台 UI 静态站' });
  let project;
  try {
    project = await getPagesProject(token, accountId, ADMIN_UI_PROJECT);
  } catch {
    project = await createPagesProject(token, accountId, ADMIN_UI_PROJECT);
  }
  await runWrangler(
    ['pages', 'deploy', ADMIN_UI_DIR, '--project-name', ADMIN_UI_PROJECT, '--branch', 'main', '--commit-dirty=true'],
    { env: { CLOUDFLARE_API_TOKEN: token }, onProgress, step: 'admin-ui' },
  );
  // 新建项目时 create 响应可能不带最终 subdomain，部署后重查一次
  project = await getPagesProject(token, accountId, ADMIN_UI_PROJECT);
  const base = `https://${pagesSubdomain(project)}`;
  onProgress?.({ step: 'admin-ui', status: 'ok', message: `后台 UI 已部署 → ${base}` });
  return base;
}

/**
 * 把 worker 里的上游后台 UI 地址替换为自托管静态站。
 * 替换失败（上游改版）不致命：worker 会沿用上游 UI，仅失去自定义能力。
 */
function patchWorkerAdminUI(workerCode, adminUiBase, onProgress) {
  if (!workerCode.includes(ADMIN_UI_UPSTREAM)) {
    onProgress?.({ step: 'admin-ui', status: 'error', message: '警告：worker 中未找到上游后台 UI 常量（上游可能已改版），本次沿用上游 UI' });
    return workerCode;
  }
  const patched = workerCode.split(ADMIN_UI_UPSTREAM).join(adminUiBase);
  onProgress?.({ step: 'admin-ui', status: 'ok', message: 'worker 后台 UI 地址已指向自托管静态站' });
  return patched;
}

/** 本机是否配置了代理环境变量 */
const hasProxyEnv = () => !!(process.env.HTTPS_PROXY || process.env.https_proxy
  || process.env.HTTP_PROXY || process.env.http_proxy
  || process.env.ALL_PROXY || process.env.all_proxy);

/** 是否网络层错误（区别于 wrangler 业务报错），用于决定是否值得换代理重试 */
const isNetErr = (e) => /fetch failed|connectivity|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|socket hang up|network/i.test(e?.message || '');

/**
 * 剥离代理环境变量。用于 wrangler 的「直连尝试」：防止本机配置了死代理时
 * wrangler 误用导致 fetch failed。若直连失败，runWrangler 会带代理重试（见下）。
 */
function cleanProxyEnv() {
  const strip = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const env = { ...process.env };
  for (const k of strip) delete env[k];
  return env;
}

/** 构造 wrangler 进程环境：stripProxy=true 走直连（剥代理），false 走代理（保留） */
function wranglerEnv(env, stripProxy) {
  return { ...(stripProxy ? cleanProxyEnv() : { ...process.env }), ...env };
}

/** 解析 wrangler 可执行文件路径（优先本地 node_modules，回退全局） */
function resolveWrangler() {
  const local = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
  return local; // 不存在时 spawn 会失败，由调用方回退 npx
}

/** 运行 wrangler 一次，流式收集输出。stripProxy 决定是否剥离代理环境变量 */
function runWranglerOnce(args, { env, cwd, stripProxy }) {
  return new Promise((resolve, reject) => {
    const bin = resolveWrangler();
    const child = spawn(bin, args, {
      env: wranglerEnv(env, stripProxy),
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
          const r = await runNpxWrangler(args, { env, cwd, stripProxy });
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

function runNpxWrangler(args, { env, cwd, stripProxy }) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', 'wrangler', ...args], {
      env: wranglerEnv(env, stripProxy), cwd, stdio: ['ignore', 'pipe', 'pipe'],
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
 * 运行 wrangler：直连/代理交替重试，骑过 GFW 对 api.cloudflare.com 的间歇阻断。
 * 仅网络错误重试（业务错误直接抛）；本机无代理时只重试直连。
 */
async function runWrangler(args, opts = {}) {
  const { onProgress, step = 'pages-deploy', ...rest } = opts;
  const useProxy = hasProxyEnv();
  const maxAttempts = useProxy ? 6 : 3;
  let stripProxy = true, lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const mode = stripProxy ? '直连' : '代理';
    try {
      return await runWranglerOnce(args, { ...rest, stripProxy });
    } catch (e) {
      lastErr = e;
      if (!isNetErr(e) || attempt === maxAttempts) throw e;
      stripProxy = useProxy ? !stripProxy : true; // 有代理则交替，无代理只重试直连
      onProgress?.({ step, status: 'start', message: `${mode}失败，换${stripProxy ? '直连' : '代理'}重试（${attempt + 1}/${maxAttempts}）…` });
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw lastErr;
}

/**
 * 主部署流程。
 * @param {DeployParams} p
 * @returns {Promise<{accountId:string, projectName:string, kvId:string, hostname:string, pagesUrl:string, adminUiUrl:string}>}
 */
export async function deploy(p) {
  const { token, zoneId, zoneName, subdomain, uuid, onProgress } = p;
  const hostname = `${subdomain}.${zoneName}`;
  const projectName = pagesProjectName(subdomain);
  const kvTitle = kvNamespaceTitle(subdomain);

  // 1. 验证 token + 拿 account
  onProgress?.({ step: 'verify', status: 'start', message: '验证 API Token' });
  await verifyToken(token);
  const zones = await listZones(token);
  const zone = zones.find((z) => z.id === zoneId);
  if (!zone) throw new Error('未找到该 zone，请确认域名已托管在当前账号');
  const accountId = zone.account.id;
  onProgress?.({ step: 'verify', status: 'ok', message: `账号 ${accountId.slice(0, 8)}… zone ${zoneName}` });

  // 2. 拉 _worker.js
  let workerCode = await fetchWorker(onProgress);

  // 2.5 部署自托管后台 UI 静态站，并把 worker 的 Pages静态页面 常量指向它。
  //     想自定义后台界面时改 admin-ui/ 里的 HTML，重新部署即生效。
  const adminUiUrl = await deployAdminUI({ token, accountId, onProgress });
  workerCode = patchWorkerAdminUI(workerCode, adminUiUrl, onProgress);

  // 3. KV（幂等：同名复用）
  onProgress?.({ step: 'kv', status: 'start', message: '准备 KV 命名空间' });
  let kv = (await listKV(token, accountId)).find((k) => k.title === kvTitle);
  if (!kv) {
    kv = await createKV(token, accountId, kvTitle);
    onProgress?.({ step: 'kv', status: 'ok', message: `已创建 KV ${kvTitle}` });
  } else {
    onProgress?.({ step: 'kv', status: 'ok', message: `复用已有 KV ${kvTitle}` });
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
  const projectSubdomain = pagesSubdomain(project);
  const cnameTarget = projectSubdomain;

  // 5. 写临时目录 + wrangler 部署
  const tmp = await mkdtemp(path.join(tmpdir(), 'edt-deploy-'));
  try {
    await writeFile(path.join(tmp, '_worker.js'), workerCode);

    onProgress?.({ step: 'pages-deploy', status: 'start', message: '上传 _worker.js 到 Pages' });
    const r1 = await runWrangler(
      ['pages', 'deploy', tmp, '--project-name', projectName, '--branch', 'main', '--commit-dirty=true'],
      { env: { CLOUDFLARE_API_TOKEN: token }, onProgress, step: 'pages-deploy' },
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

    // 6.5 同步 config.json：HOST 为当前域名 + SUBNAME 订阅名。
    // HOST：edgetunnel 会把 HOST 持久化到 KV（首访时以当时域名初始化），换域名后
    //       残留旧值，导致节点 SNI/Host 指向旧域名而超时，部署时强制同步为当前域名。
    // SUBNAME：客户端导入订阅时显示的配置名。
    try {
      const cfg = await getConfig(token, accountId, kvId);
      if (cfg) {
        let dirty = false;
        if (cfg.HOST !== hostname || !Array.isArray(cfg.HOSTS) || cfg.HOSTS[0] !== hostname) {
          cfg.HOST = hostname;
          cfg.HOSTS = [hostname];
          dirty = true;
        }
        if (!cfg['优选订阅生成']) cfg['优选订阅生成'] = {};
        if (cfg['优选订阅生成'].SUBNAME !== SUB_NAME) {
          cfg['优选订阅生成'].SUBNAME = SUB_NAME;
          dirty = true;
        }
        if (dirty) {
          await putConfig(token, accountId, kvId, cfg);
          onProgress?.({ step: 'settings', status: 'ok', message: `config 已同步：HOST=${hostname}，订阅名=${SUB_NAME}` });
        }
      }
    } catch {
      // config.json 不存在时 worker 会以当前域名初始化，无需处理
    }

    // 7. 重新部署让绑定生效
    onProgress?.({ step: 'redeploy', status: 'start', message: '重新部署使绑定生效' });
    await runWrangler(
      ['pages', 'deploy', tmp, '--project-name', projectName, '--branch', 'main', '--commit-dirty=true'],
      { env: { CLOUDFLARE_API_TOKEN: token }, onProgress, step: 'redeploy' },
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

    // 10. 清理项目里其它自定义域：本工具单节点部署，项目只保留当次域名，
    //     避免多次测试部署导致自定义域堆积。
    onProgress?.({ step: 'cleanup', status: 'start', message: '清理项目里其它自定义域' });
    const allDomains = await listPagesDomains(token, accountId, projectName);
    const others = allDomains.filter((d) => d.name !== hostname);
    if (others.length === 0) {
      onProgress?.({ step: 'cleanup', status: 'ok', message: '无其它自定义域' });
    } else {
      let removed = 0;
      for (const d of others) {
        try {
          await unbindPagesDomain(token, accountId, projectName, d.name);
          // 删除同 zone 的 DNS 记录（其它自定义域通常同 zone）
          const recs2 = await listDNSRecords(token, zoneId, d.name);
          for (const r of recs2) {
            await deleteDNSRecord(token, zoneId, r.id);
          }
          removed++;
          onProgress?.({ step: 'cleanup', status: 'ok', message: `已解绑 ${d.name}` });
        } catch (e) {
          onProgress?.({ step: 'cleanup', status: 'error', message: `解绑 ${d.name} 失败：${e.message}` });
        }
      }
      onProgress?.({ step: 'cleanup', status: 'ok', message: `共清理 ${removed} 个其它自定义域` });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  onProgress?.({ step: 'done', status: 'ok', message: '部署完成' });
  return { accountId, projectName, projectSubdomain, kvId, hostname, pagesUrl: `https://${hostname}`, adminUiUrl };
}
