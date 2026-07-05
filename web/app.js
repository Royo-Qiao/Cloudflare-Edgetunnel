// cloudflare-edge_tunnel 前端逻辑：5 步向导，极简交互

const $ = (id) => document.getElementById(id);
const STATE = {
  step: 1,
  token: '',
  zones: [],
  zoneId: '',
  zoneName: '',
  subdomain: 'cf-proxy',
  uuid: '',
  deploy: null,
};
const STEP_TITLES = ['认证', '配置', '部署', '优选 IP', '完成'];

/* ---------- 工具 ---------- */

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1600);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('复制失败');
  }
}

/** POST + SSE 流式读取 */
async function streamSSE(url, body, onEvent) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${t}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (line.startsWith('data: ')) {
        try { onEvent(JSON.parse(line.slice(6))); } catch {}
      }
    }
  }
}

/* ---------- 步骤导航 ---------- */

function goStep(n) {
  STATE.step = n;
  for (let i = 1; i <= 5; i++) $(`step${i}`).classList.toggle('hidden', i !== n);
  $('stepTitle').textContent = STEP_TITLES[n - 1];
  document.querySelectorAll('.dot').forEach((d) => {
    const s = +d.dataset.step;
    d.classList.toggle('active', s === n);
    d.classList.toggle('done', s < n);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
  saveState();
}

function saveState() {
  const { token, ...safe } = STATE;
  localStorage.setItem('edt-state', JSON.stringify(safe));
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem('edt-state') || '{}');
    Object.assign(STATE, s);
  } catch {}
}

/* ---------- Step 1: 认证 ---------- */

const tokenEl = $('token');
const verifyBtn = $('verifyBtn');

tokenEl.addEventListener('input', () => {
  verifyBtn.disabled = tokenEl.value.trim().length < 20;
});
// 粘贴即校验
tokenEl.addEventListener('paste', (e) => {
  setTimeout(() => {
    tokenEl.value = tokenEl.value.trim();
    verifyBtn.disabled = tokenEl.value.trim().length < 20;
    if (tokenEl.value) verify();
  }, 0);
});
tokenEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!verifyBtn.disabled) verify(); }
});

verifyBtn.addEventListener('click', verify);

async function verify() {
  const token = tokenEl.value.trim();
  if (!token) return;
  verifyBtn.disabled = true;
  verifyBtn.textContent = '验证中…';
  $('perms').classList.add('hidden');
  try {
    const res = await fetch('/api/verify-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '验证失败');
    STATE.token = token;
    STATE.zones = data.zones;
    STATE.accountId = data.accountId;

    // 渲染权限清单
    renderPerms(data.perms, data.missing);

    if (data.missing.length === 0) {
      toast(`验证成功，${data.zones.length} 个域名，权限齐全`);
      setupStep2();
      setTimeout(() => goStep(2), 1000);
    } else {
      toast(`缺少 ${data.missing.length} 项权限，无法部署`);
    }
  } catch (e) {
    toast(e.message);
    verifyBtn.disabled = false;
    verifyBtn.textContent = '验证';
  }
}

function renderPerms(perms, missing) {
  const box = $('perms');
  box.classList.remove('hidden');
  const allOk = missing.length === 0;
  const rows = Object.entries(perms).map(([k, ok]) => {
    const ico = ok ? '✓' : '✗';
    return `<div class="perm-row ${ok ? 'ok' : 'err'}"><span class="ico">${ico}</span><span>${k}</span></div>`;
  }).join('');
  const warn = allOk ? '' : `
    <p class="perm-warn">缺少以下权限，部署会在第 3 步失败。请到
      <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank">Cloudflare Dashboard</a>
      创建 Custom Token 并勾选：</p>
    <ul class="perm-missing">${missing.map((m) => `<li>${m}</li>`).join('')}</ul>`;
  box.innerHTML = `<div class="perm-list">${rows}</div>${warn}`;
  verifyBtn.textContent = allOk ? '已验证 ✓' : '重新验证';
  verifyBtn.disabled = false;
}

/* ---------- Step 2: 配置 ---------- */

function setupStep2() {
  const zoneSel = $('zone');
  zoneSel.innerHTML = '';
  for (const z of STATE.zones) {
    const opt = document.createElement('option');
    opt.value = z.id;
    opt.textContent = z.name;
    zoneSel.appendChild(opt);
  }
  if (STATE.zones.length === 1) {
    // 只有一个 zone：选中并隐藏选择框
    zoneSel.value = STATE.zones[0].id;
    zoneSel.parentElement.style.display = 'none';
  }
  updateZone();
  // UUID 默认生成
  if (!STATE.uuid) genUUID();
  else $('uuid').value = STATE.uuid;
}

function updateZone() {
  const z = STATE.zones.find((x) => x.id === $('zone').value);
  if (!z) return;
  STATE.zoneId = z.id;
  STATE.zoneName = z.name;
  $('zoneSuffix').textContent = '.' + z.name;
}

$('zone').addEventListener('change', updateZone);
$('subdomain').addEventListener('input', () => { STATE.subdomain = $('subdomain').value || 'cf-proxy'; });

async function genUUID() {
  try {
    const res = await fetch('/api/uuid', { method: 'POST' });
    const data = await res.json();
    STATE.uuid = data.uuid;
    $('uuid').value = data.uuid;
  } catch { toast('UUID 生成失败'); }
}
$('genUuidBtn').addEventListener('click', genUUID);
$('uuid').addEventListener('input', () => { STATE.uuid = $('uuid').value.trim(); });

$('back2').addEventListener('click', () => goStep(1));
$('toDeployBtn').addEventListener('click', () => {
  if (!/^[a-z0-9-]+$/i.test(STATE.subdomain)) return toast('子域名格式错误');
  if (!/^[0-9a-f-]{36}$/i.test(STATE.uuid)) return toast('UUID 格式错误');
  goStep(3);
});

/* ---------- Step 3: 部署 ---------- */

const deployBtn = $('deployBtn');
const deployLog = $('deployLog');
const STEP_LABELS = {
  verify: '验证 Token', 'fetch-worker': '拉取 worker', kv: 'KV 命名空间',
  'pages-project': 'Pages 项目', 'pages-deploy': '上传部署', settings: '环境变量/KV 绑定',
  redeploy: '重新部署', domain: '自定义域', cname: 'CNAME 记录', done: '完成',
};

deployBtn.addEventListener('click', async () => {
  deployBtn.disabled = true;
  deployBtn.textContent = '部署中…';
  deployLog.classList.remove('hidden');
  deployLog.innerHTML = '';
  let lastStep = null;

  const appendLog = (step, status, msg, detail) => {
    const line = document.createElement('div');
    line.className = `log-line ${status === 'ok' ? 'ok' : status === 'error' ? 'err' : 'start'}`;
    const ico = status === 'ok' ? '✓' : status === 'error' ? '✗' : '→';
    const label = STEP_LABELS[step] || step;
    line.innerHTML = `<span class="ico">${ico}</span><span class="msg">${label}${msg ? '：' + msg : ''}</span>${detail ? `<span class="detail">${detail}</span>` : ''}`;
    deployLog.appendChild(line);
    deployLog.scrollTop = deployLog.scrollHeight;
  };

  try {
    await streamSSE('/api/deploy', {
      token: STATE.token, zoneId: STATE.zoneId, zoneName: STATE.zoneName,
      subdomain: STATE.subdomain, uuid: STATE.uuid,
    }, (e) => {
      if (e.step === 'result') {
        STATE.deploy = e.result;
        appendLog('done', 'ok', '部署完成');
        $('deployActions').classList.remove('hidden');
        deployBtn.textContent = '部署完成 ✓';
      } else if (e.step === 'error') {
        appendLog(e.cfErrors ? 'error' : (lastStep || 'error'), 'error', e.message);
        throw new Error(e.message);
      } else {
        lastStep = e.step;
        appendLog(e.step, e.status, e.message, e.detail);
      }
    });
    if (!STATE.deploy) throw new Error('未收到部署结果');
  } catch (e) {
    deployBtn.disabled = false;
    deployBtn.textContent = '重试';
    toast(e.message);
  }
});

$('back3').addEventListener('click', () => goStep(2));
$('toOptimizeBtn').addEventListener('click', () => goStep(4));

/* ---------- Step 4: 优选 IP ---------- */

const optimizeBtn = $('optimizeBtn');
const optProgress = $('optProgress');
const optBarFill = $('optBarFill');
const optProgressText = $('optProgressText');
const ipList = $('ipList');

optimizeBtn.addEventListener('click', async () => {
  if (!STATE.deploy) return toast('请先完成部署');
  optimizeBtn.disabled = true;
  optimizeBtn.textContent = '测速中…';
  optProgress.classList.remove('hidden');
  optBarFill.style.width = '0%';
  optProgressText.textContent = '准备中…';
  ipList.classList.add('hidden');
  ipList.innerHTML = '';

  try {
    await streamSSE('/api/optimize-ips', {
      token: STATE.token, accountId: STATE.deploy.accountId, kvId: STATE.deploy.kvId,
      host: STATE.deploy.hostname, uuid: STATE.uuid, count: 30,
    }, (e) => {
      if (e.type === 'start') {
        optProgressText.textContent = `0 / ${e.total}`;
      } else if (e.type === 'progress') {
        const pct = Math.round((e.done / e.total) * 100);
        optBarFill.style.width = pct + '%';
        optProgressText.textContent = `${e.done} / ${e.total}（${pct}%）`;
      } else if (e.type === 'tested') {
        optProgressText.textContent = `可连 ${e.reachable} 个，写入中…`;
      } else if (e.type === 'add-written') {
        toast(`已写入 ${e.count} 个优选 IP`);
      } else if (e.type === 'config-updated') {
        toast('已启用优选 IP（随机IP=false）');
      } else if (e.type === 'result') {
        renderIPList(e.top);
        optBarFill.style.width = '100%';
        optProgressText.textContent = '完成';
        $('optActions').classList.remove('hidden');
        optimizeBtn.textContent = '重新测速';
        optimizeBtn.disabled = false;
      } else if (e.type === 'error') {
        throw new Error(e.message);
      }
    });
  } catch (e) {
    optimizeBtn.disabled = false;
    optimizeBtn.textContent = '重试';
    toast(e.message);
  }
});

function renderIPList(top) {
  ipList.classList.remove('hidden');
  ipList.innerHTML = '';
  for (const r of top) {
    const row = document.createElement('div');
    row.className = 'ip-row';
    row.innerHTML = `<span class="rank">#${r.rank}</span><span class="ip">${r.ip}</span><span class="ms">${r.ms} ms</span>`;
    ipList.appendChild(row);
  }
}

$('back4').addEventListener('click', () => goStep(3));
$('toDoneBtn').addEventListener('click', async () => {
  // 算订阅链接
  const host = STATE.deploy.hostname;
  try {
    const res = await fetch('/api/subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, uuid: STATE.uuid }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    $('subscription').textContent = data.subscription;
    $('admin').textContent = data.admin;
  } catch (e) {
    toast(e.message);
  }
  goStep(5);
});

/* ---------- Step 5: 完成 ---------- */

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => copy($(btn.dataset.copy).textContent));
});

$('restartBtn').addEventListener('click', () => {
  localStorage.removeItem('edt-state');
  location.reload();
});

/* ---------- 进度点点击回看 ---------- */

document.querySelectorAll('.dot').forEach((d) => {
  d.addEventListener('click', () => {
    const s = +d.dataset.step;
    if (s < STATE.step) goStep(s);
  });
});

/* ---------- 初始化 ---------- */

loadState();
if (STATE.uuid) $('uuid').value = STATE.uuid;
if (STATE.subdomain) $('subdomain').value = STATE.subdomain;
if (STATE.step > 1 && STATE.zones.length) {
  setupStep2();
  goStep(STATE.step);
} else {
  goStep(1);
}
