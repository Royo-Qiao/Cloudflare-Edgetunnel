/**
 * Cloudflare REST API 客户端。
 * 所有方法返回 { success, result, errors }，失败时抛出带可读消息的 Error。
 *
 * Token 安全：仅作为参数在内存中传递，不落盘、不打日志。
 */

const API = 'https://api.cloudflare.com/client/v4';

/**
 * @param {string} token
 * @param {string} path 形如 '/zones' 或 '/accounts/{id}/workers/scripts'
 * @param {object} [init]
 */
async function cf(token, path, init = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    ...(init.body !== undefined && !(init.body instanceof FormData)
      ? { 'Content-Type': 'application/json' }
      : {}),
    ...init.headers,
  };
  const opts = { ...init, headers };

  // 网络错误（fetch failed / ECONNRESET 等）重试一次：wrangler 子进程跑完后，
  // 到 api.cloudflare.com 的 keep-alive 连接可能已被对端关闭，复用废连接会失败。
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(API + path, opts);
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(`Cloudflare API ${path} 返回非 JSON（HTTP ${res.status}）`);
      }
      if (!data.success) {
        const msg = data.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ') || `HTTP ${res.status}`;
        const err = new Error(`Cloudflare API ${path} 失败：${msg}`);
        err.cfErrors = data.errors;
        err.cfPath = path;
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (e) {
      if (e.cfErrors) throw e; // CF API 业务错误，不重试
      lastErr = e;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
    }
  }
  const cause = lastErr.cause ? `（${lastErr.cause.code || lastErr.cause.message || lastErr.cause}）` : '';
  const err = new Error(`Cloudflare API ${path} 网络错误：${lastErr.message}${cause}`);
  err.cfPath = path;
  throw err;
}

/** 验证 token，返回 { id, status } */
export const verifyToken = (token) => cf(token, '/user/tokens/verify').then((d) => d.result);

/** 探测某个 GET 接口是否可调（用于权限自检），返回 boolean */
export async function canAccess(token, path) {
  try {
    await cf(token, path);
    return true;
  } catch {
    return false;
  }
}

/** 列出账号下所有 zone（status=active） */
export async function listZones(token) {
  const out = [];
  let page = 1;
  while (true) {
    const d = await cf(token, `/zones?page=${page}&per_page=50&status=active`);
    out.push(...d.result);
    if (out.length >= d.result_info.total_count) break;
    page++;
  }
  return out;
}

/** 按 name 精确查 zone */
export const getZone = (token, name) =>
  cf(token, `/zones?name=${encodeURIComponent(name)}`).then((d) => d.result[0] || null);

/* ---------------- KV ---------------- */

/** 创建 KV 命名空间 */
export const createKV = (token, accountId, title) =>
  cf(token, `/accounts/${accountId}/storage/kv/namespaces`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  }).then((d) => d.result);

/** 列 KV 命名空间 */
export const listKV = (token, accountId) =>
  cf(token, `/accounts/${accountId}/storage/kv/namespaces`).then((d) => d.result);

/** 读 KV 某个 key 的原始文本 */
export async function getKVValue(token, accountId, nsId, key) {
  const res = await fetch(`${API}/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`读 KV ${key} 失败：HTTP ${res.status}`);
  return res.text();
}

/** 写 KV 某个 key */
export async function putKVValue(token, accountId, nsId, key, value, contentType = 'text/plain') {
  const res = await fetch(`${API}/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': contentType,
    },
    body: value,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`写 KV ${key} 失败：HTTP ${res.status} ${t}`);
  }
  return true;
}

/* ---------------- Pages ---------------- */

/** 创建 Pages 项目 */
export const createPagesProject = (token, accountId, name, productionBranch = 'main') =>
  cf(token, `/accounts/${accountId}/pages/projects`, {
    method: 'POST',
    body: JSON.stringify({ name, production_branch: productionBranch }),
  }).then((d) => d.result);

/** 列 Pages 项目 */
export const listPagesProjects = (token, accountId) =>
  cf(token, `/accounts/${accountId}/pages/projects`).then((d) => d.result);

/** 查 Pages 项目 */
export const getPagesProject = (token, accountId, name) =>
  cf(token, `/accounts/${accountId}/pages/projects/${name}`).then((d) => d.result);

/** 修改 Pages 项目设置（环境变量、KV 绑定等） */
export const patchPagesSettings = (token, accountId, name, deploymentConfigs) =>
  cf(token, `/accounts/${accountId}/pages/projects/${name}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ deployment_configs: deploymentConfigs }),
  }).then((d) => d.result);

/** 给 Pages 项目绑自定义域 */
export const bindPagesDomain = (token, accountId, projectName, hostname) =>
  cf(token, `/accounts/${accountId}/pages/projects/${projectName}/domains`, {
    method: 'POST',
    body: JSON.stringify({ name: hostname }),
  }).then((d) => d.result);

/** 列 Pages 自定义域 */
export const listPagesDomains = (token, accountId, projectName) =>
  cf(token, `/accounts/${accountId}/pages/projects/${projectName}/domains`).then((d) => d.result);

/* ---------------- DNS ---------------- */

/** 列 DNS 记录（可按 name 过滤） */
export const listDNSRecords = (token, zoneId, name) =>
  cf(token, `/zones/${zoneId}/dns_records${name ? `?name=${encodeURIComponent(name)}` : ''}`).then((d) => d.result);

/** 创建 DNS 记录 */
export const createDNSRecord = (token, zoneId, { type, name, content, proxied = true }) =>
  cf(token, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ type, name, content, proxied }),
  }).then((d) => d.result);

/** 删除 DNS 记录 */
export const deleteDNSRecord = (token, zoneId, id) =>
  cf(token, `/zones/${zoneId}/dns_records/${id}`, { method: 'DELETE' }).then((d) => d.result);
