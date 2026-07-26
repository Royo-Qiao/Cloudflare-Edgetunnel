/* ═══════════ Edgetunnel · Cloudflare - 前端逻辑 ═══════════
 * 5 步配置向导：认证 → 配置 → 部署 → 优选 IP → 完成。
 * 原生 ES，无框架；与 server.mjs 的 /api/* + SSE 契约对齐。
 *
 * mock 适配层：无后端（静态预览 / 网络失败 / 非 JSON 响应）时自动回退到
 * 本地模拟，同一代码路径。mock 演示口令：
 *   token 以 bad 开头      → 无效令牌（S1 失败分支）
 *   token 以 lim 开头      → 缺 KV + Pages 两项权限（S1 阻断分支）
 *   子域名以 fail 开头     → 部署在「自定义域」阶段失败，首次必败、重试成功（S3 失败分支）
 *   其余                   → 全流程成功
 */

const $ = (id) => document.getElementById(id);

const STATE = {
  step: 1,
  token: '',
  zones: [],
  accountId: '',
  zoneId: '',
  zoneName: '',
  subdomain: 'cloudflare-edgetunnel',
  uuid: '',
  deploy: null,
};

const STEPS = ['认证', '配置', '部署', '优选 IP', '完成'];

/* 与 lib/deploy.mjs 对齐的 10 个部署阶段 */
const STAGES = [
  ['verify', '验证 Token'],
  ['fetch-worker', '拉取 worker'],
  ['kv', 'KV 命名空间'],
  ['pages-project', 'Pages 项目'],
  ['pages-deploy', '上传部署'],
  ['settings', '环境变量/KV 绑定'],
  ['redeploy', '重新部署'],
  ['domain', '自定义域'],
  ['cname', 'CNAME 记录'],
  ['done', '完成'],
];

let maxReachedStep = 1;

/* ---------- 工具 ---------- */

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600); // 契约 §1.2 #10：1.6 秒
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('复制失败');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- API 层：真实后端优先，失败回退 mock ---------- */

/** JSON POST。网络失败或非 JSON 响应（无后端）→ mockFn；后端业务错误如实返回。 */
async function apiPost(url, body, mockFn) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  } catch {
    return mockFn(body);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return mockFn(body);
  }
  return data;
}

/** SSE POST。无法连接或非事件流响应 → mockGen（异步生成器）。 */
async function apiStream(url, body, onEvent, mockGen) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return runMockStream(mockGen, onEvent);
  }
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || !ct.includes('text/event-stream') || !res.body) {
    return runMockStream(mockGen, onEvent);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (line.startsWith('data: ')) {
        try { onEvent(JSON.parse(line.slice(6))); } catch { /* 忽略坏帧 */ }
      }
    }
  }
}

async function runMockStream(mockGen, onEvent) {
  for await (const e of mockGen()) onEvent(e);
}

/* ---------- mock 实现（仅预览用） ---------- */

const ALL_PERMS = [
  'Zone · Zone · Read',
  'Zone · DNS · Edit',
  'Account · Workers Scripts · Edit',
  'Account · Workers KV Storage · Edit',
  'Account · Cloudflare Pages · Edit',
];

async function mockVerify({ token }) {
  await sleep(900);
  if (/^bad/i.test(token)) return { success: false, error: 'Token 不可用或已过期，请检查后重试。' };
  const perms = {};
  const missing = [];
  for (const p of ALL_PERMS) {
    const lack = /^lim/i.test(token) && (p.includes('Pages') || p.includes('KV'));
    perms[p] = !lack;
    if (lack) missing.push(p);
  }
  return {
    success: true,
    accountId: 'demo-account-01a2b3',
    zones: [
      { id: 'zone-demo-1', name: 'example.com', status: 'active' },
      { id: 'zone-demo-2', name: 'example.org', status: 'active' },
    ],
    perms,
    missing,
  };
}

async function mockUuid() {
  await sleep(250);
  const uuid = (crypto.randomUUID && crypto.randomUUID()) ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  return { success: true, uuid };
}

async function mockDeployedUuid() {
  await sleep(150);
  return { success: true, uuid: null }; // mock 无已部署项目，回退到生成新 UUID
}

/** 简单非加密哈希 → 32 hex，仅为 mock 订阅链接形似（真实环境由服务端 MD5MD5 计算）。 */
function mockHex32(str) {
  let out = '';
  for (let round = 0; round < 2; round++) {
    let h1 = 0x811c9dc5 ^ round, h2 = 0x01000193 ^ (round * 7);
    for (let i = 0; i < str.length; i++) {
      h1 = Math.imul(h1 ^ str.charCodeAt(i), 0x01000193) >>> 0;
      h2 = (Math.imul(h2, 31) + str.charCodeAt(i) + round) >>> 0;
    }
    out += h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }
  return out.slice(0, 32);
}

async function mockSubscription({ host, uuid }) {
  await sleep(300);
  const token = mockHex32(host + uuid);
  return {
    success: true,
    token,
    subscription: `https://${host}/sub?token=${token}`,
    admin: `https://${host}/${uuid}`,
    password: uuid,
  };
}

let mockDeployFailedOnce = false;
async function* mockDeployEvents(body) {
  const hostname = `${body.subdomain}.${body.zoneName}`;
  const accountId = STATE.accountId || 'demo-account-01a2b3';
  const willFail = /^fail/i.test(body.subdomain) && !mockDeployFailedOnce;
  const detail = {
    'fetch-worker': '184 KiB',
    'pages-deploy': `https://${hostname}`,
  };
  for (const [step, label] of STAGES) {
    if (step === 'done') continue;
    yield { step, status: 'start', message: label };
    await sleep(320 + Math.random() * 360);
    if (willFail && step === 'domain') {
      yield {
        step: 'error', status: 'error',
        message: `${hostname} 已绑定到其他 Pages 项目（可能是一次手动部署留下的 edt-royo-pages）。请更换子域名，或到 Dashboard 删除旧绑定后重试。`,
      };
      return;
    }
    yield { step, status: 'ok', message: label + ' 完成', detail: detail[step] };
  }
  yield { step: 'done', status: 'ok', message: '部署完成' };
  await sleep(200);
  yield {
    step: 'result', status: 'ok', message: '部署完成',
    result: {
      accountId,
      projectName: `edt-pages-${body.subdomain}`,
      kvId: 'demo-kv-namespace-id',
      hostname,
      pagesUrl: `https://${hostname}`,
    },
  };
}

async function* mockOptimizeEvents() {
  const total = 320; // 与 lib/optimize-ips.mjs buildCandidates(16) 一致
  yield { type: 'start', total };
  for (let done = 20; done <= total; done += 20) {
    await sleep(110);
    yield { type: 'progress', done: Math.min(done, total), total };
  }
  await sleep(300);
  yield { type: 'tested', reachable: 287 };
  await sleep(400);
  yield { type: 'add-written', count: 30 };
  await sleep(300);
  yield { type: 'config-updated' };
  await sleep(200);
  const pools = ['104.16', '104.21', '104.24', '172.64', '172.67', '162.159', '188.114', '198.41', '141.101', '190.93'];
  const top = [];
  let ms = 62;
  for (let i = 0; i < 30; i++) {
    const p = pools[i % pools.length];
    top.push({ ip: `${p}.${(i * 37) % 255}.${(i * 91) % 254 + 1}`, ms: Math.round(ms), rank: i + 1 });
    ms += 4 + Math.random() * 14 * (1 + i / 12);
  }
  yield { type: 'result', top };
}

async function mockStatus({ host }) {
  await sleep(1100);
  return {
    success: true,
    project: { name: 'edt-pages', subdomain: 'edt-pages.pages.dev' },
    domains: [{ name: host, status: 'active' }],
    nodeCount: 27,
  };
}

/* ---------- 步骤轨道（契约 §1.2 #9：仅可向后点击） ---------- */

function renderRail() {
  const rail = $('stepRail');
  rail.innerHTML = '';
  STEPS.forEach((name, i) => {
    const n = i + 1;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'step-item';
    item.dataset.odId = 'step-rail-' + n;
    if (n === STATE.step) item.classList.add('active');
    if (n < maxReachedStep) item.classList.add('done');
    item.disabled = n >= maxReachedStep;
    item.setAttribute('aria-label', '第 ' + n + ' 步：' + name + (n < maxReachedStep ? '（已完成）' : n === STATE.step ? '（当前）' : ''));
    const num = document.createElement('span');
    num.className = 'num';
    if (n < maxReachedStep) {
      num.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.2l2.4 2.4 4.6-4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    } else {
      num.textContent = n;
    }
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;
    item.append(num, label);
    if (n < maxReachedStep) item.addEventListener('click', () => goStep(n));
    rail.appendChild(item);
    if (n < STEPS.length) {
      const link = document.createElement('span');
      link.className = 'step-link';
      link.setAttribute('aria-hidden', 'true');
      rail.appendChild(link);
    }
  });
}

function goStep(n) {
  STATE.step = n;
  maxReachedStep = Math.max(maxReachedStep, n);
  for (let i = 1; i <= 5; i++) $('screen' + i).classList.toggle('hidden', i !== n);
  renderRail();
  if (n === 3) fillDeployContext();
  if (n === 5) prepareStep5();
  window.scrollTo({ top: 0 });
  saveState();
}

function saveState() {
  const { token, ...safe } = STATE; // token 刻意排除，仅存内存
  localStorage.setItem('edt-state', JSON.stringify(safe));
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem('edt-state') || '{}');
    Object.assign(STATE, s);
    if (s.step) maxReachedStep = Math.max(maxReachedStep, s.step);
  } catch { /* 忽略坏状态 */ }
}

/* ---------- S1 认证 ---------- */

const tokenInput = $('tokenInput');
const verifyBtn = $('verifyBtn');
let verifying = false;

tokenInput.addEventListener('input', () => {
  verifyBtn.disabled = verifying || tokenInput.value.trim().length < 20; // 契约 #1
});
tokenInput.addEventListener('paste', () => {
  setTimeout(() => {
    tokenInput.value = tokenInput.value.trim();
    verifyBtn.disabled = tokenInput.value.trim().length < 20;
    if (tokenInput.value) verify(); // 契约 #2：粘贴自动验证
  }, 0);
});
tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (!verifyBtn.disabled) verify(); } // 契约 #2：Enter 提交
});

$('tokenToggle').addEventListener('click', () => {
  const showing = tokenInput.type === 'text';
  tokenInput.type = showing ? 'password' : 'text';
  $('eyeOn').classList.toggle('hidden', !showing);
  $('eyeOff').classList.toggle('hidden', showing);
  $('tokenToggle').setAttribute('aria-label', showing ? '显示 Token' : '隐藏 Token');
  tokenInput.focus();
});

verifyBtn.addEventListener('click', verify);

async function verify() {
  const token = tokenInput.value.trim();
  if (!token || verifying) return;
  verifying = true;
  hideAuthError();
  $('permsPanel').classList.add('hidden');
  verifyBtn.disabled = true;
  verifyBtn.innerHTML = '<span class="spin" aria-hidden="true"></span>验证中…';

  const data = await apiPost('/api/verify-token', { token }, mockVerify);
  verifying = false;

  if (!data.success) {
    showAuthError(data.error || '验证失败');
    verifyBtn.textContent = '验证并继续';
    verifyBtn.disabled = token.length < 20;
    return;
  }

  STATE.token = token;
  STATE.zones = data.zones || [];
  STATE.accountId = data.accountId || '';
  renderPerms(data.perms || {}, data.missing || []);

  if ((data.missing || []).length === 0) {
    verifyBtn.textContent = '已验证 ✓';
    toast('验证成功 · ' + STATE.zones.length + ' 个域名可用，权限齐全');
    setupStep2();
    setTimeout(() => goStep(2), 1000); // 契约 #3：1 秒自动前进
  } else {
    toast('缺少 ' + data.missing.length + ' 项权限，无法部署'); // 契约 #3：缺权限阻断
    verifyBtn.textContent = '重新验证';
    verifyBtn.disabled = false;
  }
}

function renderPerms(perms, missing) {
  const panel = $('permsPanel');
  panel.classList.remove('hidden');
  const grid = $('permGrid');
  grid.innerHTML = '';
  const total = Object.keys(perms).length;
  $('permsSummary').textContent = (total - missing.length) + ' / ' + total + ' 已通过';
  $('permsSummary').className = 'summary ' + (missing.length === 0 ? 'ok' : 'err');

  for (const [name, ok] of Object.entries(perms)) {
    const row = document.createElement('div');
    row.className = 'perm-row ' + (ok ? 'ok' : 'err');
    row.innerHTML = ok
      ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 7.3l2.6 2.6L11 4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M4 4l6 6M10 4l-6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    const span = document.createElement('span');
    span.textContent = name;
    row.appendChild(span);
    grid.appendChild(row);
  }

  const warn = $('permWarn');
  if (missing.length > 0) {
    warn.classList.remove('hidden');
    const list = $('permMissing');
    list.innerHTML = '';
    for (const m of missing) {
      const li = document.createElement('li');
      li.textContent = m;
      list.appendChild(li);
    }
  } else {
    warn.classList.add('hidden');
  }
}

function showAuthError(msg) {
  $('errorText').textContent = msg;
  $('errorBanner').classList.remove('hidden');
}
function hideAuthError() {
  $('errorBanner').classList.add('hidden');
}

/* ---------- S2 配置 ---------- */

const zoneInput = $('zoneInput');
const subInput = $('subInput');
const uuidInput = $('uuidInput');

function setupStep2() {
  zoneInput.innerHTML = '';
  for (const z of STATE.zones) {
    const opt = document.createElement('option');
    opt.value = z.id;
    opt.textContent = z.name;
    zoneInput.appendChild(opt);
  }
  // 契约 #4：仅 1 个 zone 时自动隐藏下拉
  $('zoneField').style.display = STATE.zones.length === 1 ? 'none' : '';
  if (STATE.zones.length === 1) zoneInput.value = STATE.zones[0].id;
  if (STATE.zoneId && STATE.zones.some((z) => z.id === STATE.zoneId)) zoneInput.value = STATE.zoneId;
  updateZone();
  subInput.value = STATE.subdomain || 'cloudflare-edgetunnel';
  if (STATE.uuid) uuidInput.value = STATE.uuid;
  else prefillUuid(); // 契约 #5：UUID 预填（优先沿用已部署 UUID）
  updateHostPreview();
}

function updateZone() {
  const z = STATE.zones.find((x) => x.id === zoneInput.value);
  if (!z) return;
  STATE.zoneId = z.id;
  STATE.zoneName = z.name;
  $('zoneSuffix').textContent = '.' + z.name; // 契约 #4：后缀实时显示
  updateHostPreview();
}

function updateHostPreview() {
  const host = (subInput.value.trim() || 'cloudflare-edgetunnel') + (STATE.zoneName ? '.' + STATE.zoneName : '');
  $('hostPreview').textContent = host;
}

zoneInput.addEventListener('change', updateZone);
subInput.addEventListener('input', () => {
  STATE.subdomain = subInput.value.trim() || 'cloudflare-edgetunnel';
  clearFieldError(subInput, 'subHint');
  updateHostPreview();
});
uuidInput.addEventListener('input', () => {
  STATE.uuid = uuidInput.value.trim();
  uuidInput.dataset.touched = '1'; // 用户手动改过
  clearFieldError(uuidInput, 'uuidHint');
});

// 子域变更失焦时，如果用户没手动改过 UUID，自动重新预填对应该子域的已部署 UUID
subInput.addEventListener('blur', () => {
  if (uuidInput.dataset.touched === '1') return;
  prefillUuid(true);
});

async function genUUID() {
  const btn = $('genUuidBtn');
  btn.disabled = true;
  const data = await apiPost('/api/uuid', {}, mockUuid);
  btn.disabled = false;
  if (data.success && data.uuid) {
    STATE.uuid = data.uuid;
    uuidInput.value = data.uuid;
    clearFieldError(uuidInput, 'uuidHint');
  } else {
    toast('UUID 生成失败');
  }
}
$('genUuidBtn').addEventListener('click', genUUID);

/**
 * UUID 预填：优先沿用当前子域对应 Pages 项目的 UUID，避免重新部署时
 * 擅自生成新 UUID 顶掉在用订阅/节点。每个子域对应一个独立 Pages 项目
 * （edt-pages-<子域名>），互不干扰。用户已手动填值则不覆盖。
 * @param {boolean} [force=false]  true=即使用户填了也刷新（子域变更时用，但需先确认用户没改过）
 */
async function prefillUuid(force = false) {
  const subdomain = STATE.subdomain || 'cloudflare-edgetunnel';
  const projectName = `edt-pages-${subdomain}`;
  const d = await apiPost('/api/deployed-uuid', { token: STATE.token, accountId: STATE.accountId, projectName }, mockDeployedUuid);
  const userTouched = uuidInput.dataset.touched === '1';
  if (d && d.success && d.uuid) {
    if (!force && uuidInput.value.trim() && userTouched) return; // 用户已手动改过，尊重输入
    STATE.uuid = d.uuid;
    uuidInput.value = d.uuid;
    clearFieldError(uuidInput, 'uuidHint');
    toast(`已沿用 ${projectName} 的 UUID（${d.uuid.slice(0, 8)}…）`);
  } else if (d && d.success && d.uncertain) {
    toast('未能确认是否已有部署（网络异常），已生成新 UUID；若此前部署过，请检查网络后重进此步，避免覆盖在用订阅');
    genUUID();
  } else {
    if (!force && userTouched && uuidInput.value.trim()) return;
    genUUID(); // 确认首次部署
  }
}

function setFieldError(input, hintId, msg) {
  input.classList.add('invalid');
  const hint = $(hintId);
  if (msg) hint.textContent = msg;
  hint.classList.remove('hidden');
}
function clearFieldError(input, hintId) {
  input.classList.remove('invalid');
  $(hintId).classList.add('hidden');
}

$('back2').addEventListener('click', () => goStep(1));
$('toDeploy').addEventListener('click', () => {
  // 契约 #5：Next 时校验（内联提示，非 toast —— plan §3 S2 升级）
  STATE.subdomain = subInput.value.trim() || 'cloudflare-edgetunnel';
  STATE.uuid = uuidInput.value.trim();
  let firstBad = null;
  if (!/^[a-z0-9-]+$/i.test(STATE.subdomain)) {
    setFieldError(subInput, 'subHint');
    firstBad = firstBad || subInput;
  }
  if (!/^[0-9a-f-]{36}$/i.test(STATE.uuid)) {
    setFieldError(uuidInput, 'uuidHint');
    firstBad = firstBad || uuidInput;
  }
  if (firstBad) { firstBad.focus(); return; }
  goStep(3);
});

/* ---------- S3 部署 ---------- */

const deployBtn = $('deployBtn');
const deployLog = $('deployLog');
let deploying = false;

function fillDeployContext() {
  $('ctxHost').textContent = STATE.subdomain + '.' + STATE.zoneName;
  $('ctxUuid').textContent = '…' + STATE.uuid.slice(-4);
}

function buildStageList() {
  const list = $('stageList');
  list.innerHTML = '';
  for (const [step, label] of STAGES) {
    const li = document.createElement('li');
    li.className = 'stage-row pending';
    li.id = 'stage-' + step;
    li.innerHTML =
      '<span class="st-ico" aria-hidden="true"><span class="st-dot"></span></span>' +
      '<span class="st-label"></span>' +
      '<span class="st-msg"></span>';
    li.querySelector('.st-label').textContent = label;
    list.appendChild(li);
  }
  updateStageProgress();
}

function setStage(step, status, msg) {
  const row = $('stage-' + step);
  if (!row) return;
  row.className = 'stage-row ' + status;
  const ico = row.querySelector('.st-ico');
  if (status === 'running') {
    ico.innerHTML = '<span class="spin" aria-hidden="true"></span>';
  } else if (status === 'done') {
    ico.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 7.3l2.6 2.6L11 4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  } else if (status === 'error') {
    ico.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M4 4l6 6M10 4l-6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  } else {
    ico.innerHTML = '<span class="st-dot"></span>';
  }
  if (msg) row.querySelector('.st-msg').textContent = msg;
  updateStageProgress();
}

function updateStageProgress() {
  const done = STAGES.filter(([s]) => {
    const r = $('stage-' + s);
    return r && r.classList.contains('done');
  }).length;
  const running = STAGES.find(([s]) => {
    const r = $('stage-' + s);
    return r && r.classList.contains('running');
  });
  $('stageBarFill').style.width = (done / STAGES.length) * 100 + '%';
  $('stageProgress').textContent = running
    ? done + ' / ' + STAGES.length + ' · ' + running[1] + '中…'
    : done === STAGES.length ? STAGES.length + ' / ' + STAGES.length + ' · 全部完成'
    : done > 0 ? done + ' / ' + STAGES.length
    : '等待开始';
}

function appendLog(step, status, msg, detail) {
  const line = document.createElement('div');
  line.className = 'log-line ' + (status === 'ok' ? 'ok' : status === 'error' ? 'err' : 'start');
  const ico = status === 'ok' ? '✓' : status === 'error' ? '✗' : '→';
  const label = (STAGES.find(([s]) => s === step) || [step, step])[1];
  const mk = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };
  line.append(mk('ico', ico), mk('msg', label + (msg && msg !== label ? '：' + msg : '')));
  if (detail) line.appendChild(mk('detail', detail));
  deployLog.appendChild(line);
  deployLog.scrollTop = deployLog.scrollHeight; // 契约 #6：自动滚动
}

$('consoleToggle').addEventListener('click', () => {
  const open = $('consoleToggle').getAttribute('aria-expanded') === 'true';
  $('consoleToggle').setAttribute('aria-expanded', String(!open));
  $('consoleWrap').classList.toggle('hidden', open);
});

deployBtn.addEventListener('click', async () => {
  if (deploying) return;
  if (!STATE.token) {
    $('deployErrorText').textContent = '会话已刷新，Token 不在内存中。请返回第 1 步重新验证后再部署。';
    $('deployError').classList.remove('hidden');
    return;
  }
  deploying = true;
  deployBtn.disabled = true;
  deployBtn.innerHTML = '<span class="spin" aria-hidden="true"></span>部署中…';
  $('toOptimize').classList.add('hidden');
  $('deployError').classList.add('hidden');
  buildStageList();
  deployLog.innerHTML = '';
  let lastStep = null;
  let failedMsg = null;

  try {
    await apiStream(
      '/api/deploy',
      { token: STATE.token, zoneId: STATE.zoneId, zoneName: STATE.zoneName, subdomain: STATE.subdomain, uuid: STATE.uuid },
      (e) => {
        if (e.step === 'result') {
          STATE.deploy = e.result;
          // 'done' 事件已先行到达并落日志，此处仅兜底标记阶段完成，不重复 appendLog
          setStage('done', 'done');
        } else if (e.step === 'error') {
          if (lastStep) setStage(lastStep, 'error');
          appendLog(lastStep || 'error', 'error', e.message);
          failedMsg = e.message;
        } else {
          lastStep = e.step;
          if (e.status === 'start') setStage(e.step, 'running');
          else if (e.status === 'ok') setStage(e.step, 'done', e.detail || '');
          appendLog(e.step, e.status, e.message, e.detail);
        }
      },
      () => mockDeployEvents({ subdomain: STATE.subdomain, zoneName: STATE.zoneName })
    );
  } catch (e) {
    failedMsg = failedMsg || e.message;
  }
  deploying = false;

  if (STATE.deploy) {
    mockDeployFailedOnce = false;
    deployBtn.classList.add('hidden');
    $('toOptimize').classList.remove('hidden'); // 契约 #6：成功显示 Next
    saveState();
  } else {
    // 契约 #6：失败显示重试；plan §3：错误内联持久化
    if (lastStep) setStage(lastStep, 'error');
    $('deployErrorText').textContent = failedMsg || '部署中断，请重试。';
    $('deployError').classList.remove('hidden');
    deployBtn.disabled = false;
    deployBtn.textContent = '重试';
    toast(failedMsg || '部署失败');
  }
});

$('back3').addEventListener('click', () => goStep(2));
$('toOptimize').addEventListener('click', () => goStep(4));

/* ---------- S4 优选 IP ---------- */

const optimizeBtn = $('optimizeBtn');
let optimizing = false;

optimizeBtn.addEventListener('click', async () => {
  if (optimizing) return;
  if (!STATE.deploy) { toast('请先完成部署'); return; }
  if (!STATE.token) {
    $('optErrorText').textContent = '会话已刷新，Token 不在内存中。请返回第 1 步重新验证后再测速。';
    $('optError').classList.remove('hidden');
    return;
  }
  optimizing = true;
  optimizeBtn.disabled = true;
  optimizeBtn.innerHTML = '<span class="spin" aria-hidden="true"></span>测速中…';
  $('toDone').classList.add('hidden');
  $('optError').classList.add('hidden');
  $('ipCard').classList.add('hidden');
  $('optProgressCard').classList.remove('hidden');
  $('optBarFill').style.width = '0%';
  $('optProgressText').textContent = '准备中…';
  $('optStage').textContent = '正在建立候选清单…';
  let failMsg = null;

  try {
    await apiStream(
      '/api/optimize-ips',
      {
        token: STATE.token, accountId: STATE.deploy.accountId, kvId: STATE.deploy.kvId,
        host: STATE.deploy.hostname, uuid: STATE.uuid, count: 30,
      },
      (e) => {
        if (e.type === 'start') {
          $('optProgressText').textContent = '0 / ' + e.total;
          $('optStage').textContent = '测速中…';
        } else if (e.type === 'progress') {
          const pct = Math.round((e.done / e.total) * 100);
          $('optBarFill').style.width = pct + '%';
          $('optProgressText').textContent = e.done + ' / ' + e.total + '（' + pct + '%）'; // 契约 #7
        } else if (e.type === 'tested') {
          $('optStage').textContent = '可连 ' + e.reachable + ' 个，写入中…';
          $('ipNote').textContent = '候选中 ' + e.reachable + ' 个可达';
        } else if (e.type === 'add-written') {
          toast('已写入 ' + e.count + ' 个优选 IP'); // 契约 #7：KV 写入 toast
        } else if (e.type === 'config-updated') {
          toast('已启用优选 IP（随机IP=false）'); // 契约 #7：配置切换 toast
        } else if (e.type === 'result') {
          renderIPList(e.top);
          $('optBarFill').style.width = '100%';
          $('optProgressText').textContent = '完成';
          $('optStage').textContent = '优选完成，可进入下一步。';
          $('toDone').classList.remove('hidden');
        } else if (e.type === 'error') {
          failMsg = e.message;
        }
      },
      mockOptimizeEvents
    );
  } catch (e) {
    failMsg = failMsg || e.message;
  }
  optimizing = false;
  optimizeBtn.disabled = false;

  if (failMsg) {
    $('optErrorText').textContent = failMsg; // plan §3：错误内联持久化
    $('optError').classList.remove('hidden');
    optimizeBtn.textContent = '重试';
  } else {
    optimizeBtn.textContent = '重新测速';
  }
});

function renderIPList(top) {
  const list = $('ipList');
  list.innerHTML = '';
  $('ipCard').classList.remove('hidden');
  for (const r of top) {
    const row = document.createElement('div');
    row.className = 'ip-row';
    const tier = r.ms <= 150 ? 't-fast' : r.ms <= 300 ? 't-mid' : 't-slow';
    const w = Math.min((r.ms / 500) * 100, 100).toFixed(1);
    const mk = (cls, text) => {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      return s;
    };
    const bar = document.createElement('span');
    bar.className = 'msbar';
    const fill = document.createElement('i');
    fill.className = tier;
    fill.style.width = w + '%';
    bar.appendChild(fill);
    row.append(mk('rank', '#' + r.rank), mk('ip', r.ip), bar, mk('ms', r.ms + ' ms'));
    list.appendChild(row);
  }
}

$('back4').addEventListener('click', () => goStep(3));
$('toDone').addEventListener('click', () => goStep(5)); // 契约 #8：订阅 URL 在 prepareStep5 计算

/* ---------- S5 完成 ---------- */

let subPrepared = false;
async function prepareStep5() {
  if (!STATE.deploy) return;
  $('doneHost').textContent = STATE.deploy.hostname;
  $('pwdValue').textContent = STATE.uuid;
  if (subPrepared) return;
  subPrepared = true;
  $('subUrl').textContent = '计算中…';
  $('adminUrl').textContent = '计算中…';
  const data = await apiPost(
    '/api/subscription',
    { host: STATE.deploy.hostname, uuid: STATE.uuid },
    mockSubscription
  );
  if (data.success) {
    $('subUrl').textContent = data.subscription;
    $('adminUrl').textContent = data.admin;
  } else {
    $('subUrl').textContent = '生成失败：' + (data.error || '未知错误');
    $('adminUrl').textContent = '—';
  }
}

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => copy($(btn.dataset.copy).textContent)); // 契约 #8
});

/* 节点状态检测（/api/status 驱动） */
let statusChecking = false;
$('statusBtn').addEventListener('click', async () => {
  if (statusChecking || !STATE.deploy) return;
  statusChecking = true;
  const btn = $('statusBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin" aria-hidden="true"></span>检测中…';
  $('statusHint').classList.add('hidden');
  $('statusRows').classList.add('hidden');

  const data = await apiPost(
    '/api/status',
    {
      token: STATE.token,
      accountId: STATE.deploy.accountId,
      projectName: STATE.deploy.projectName || `edt-pages-${STATE.subdomain || 'cloudflare-edgetunnel'}`,
      host: STATE.deploy.hostname,
      uuid: STATE.uuid,
    },
    mockStatus
  );
  statusChecking = false;
  btn.disabled = false;
  btn.textContent = '重新检测';

  if (!data.success) {
    $('statusHint').textContent = '检测失败：' + (data.error || '未知错误');
    $('statusHint').classList.remove('hidden');
    return;
  }
  const setV = (id, text, cls) => {
    const el = $(id);
    el.textContent = text;
    el.className = 'v' + (cls ? ' ' + cls : '');
  };
  setV('stProject', data.project ? data.project.name : '未找到', data.project ? 'ok' : 'err');
  setV('stSubdomain', data.project && data.project.subdomain ? data.project.subdomain : '—');
  const domains = Array.isArray(data.domains) ? data.domains : [];
  setV('stDomains', domains.length ? domains.map((d) => d.name).join('、') : '未绑定');
  if (typeof data.nodeCount === 'number') {
    setV('stNodes', data.nodeCount + ' 个', data.nodeCount > 0 ? 'ok' : 'err');
  } else {
    setV('stNodes', '检测失败' + (data.nodeError ? '：' + data.nodeError : ''), 'err');
  }
  $('statusRows').classList.remove('hidden');
});

$('restartBtn').addEventListener('click', () => {
  localStorage.removeItem('edt-state'); // 契约 #8：清空存储并刷新
  location.reload();
});

/* ---------- 初始化 ---------- */

buildStageList();
renderRail();
loadState();
if (STATE.step > 1 && STATE.zones.length) {
  setupStep2();
  goStep(STATE.step);
} else {
  goStep(1);
}
