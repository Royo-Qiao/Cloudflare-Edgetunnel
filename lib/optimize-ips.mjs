/**
 * CF 优选 IP 测速：用 net.createConnection 实测 TCP 握手延迟。
 * 不依赖 ICMP（被 CF 禁），直接测 443 TCP 建连时间。
 */
import net from 'node:net';
import tls from 'node:tls';

/**
 * 生成 CF Anycast IP 候选池。
 * 覆盖 104.16-30、172.64-67、162.159 等常用段，每段取若干第三字节。
 * @param {number} perOctet 每个第二字节段取多少个第三字节（默认 16，约 700 个）
 * @returns {string[]}
 */
export function buildCandidates(perOctet = 16) {
  const out = new Set();
  const thirds = Array.from({ length: perOctet }, (_, i) => i); // 0..perOctet-1
  // 104.16-30.x.1
  for (let b = 16; b <= 30; b++) {
    for (const t of thirds) out.add(`104.${b}.${t}.1`);
  }
  // 172.64-67.x.1
  for (let b = 64; b <= 67; b++) {
    for (const t of thirds) out.add(`172.${b}.${t}.1`);
  }
  // 162.159.x.1
  for (const t of thirds) out.add(`162.159.${t}.1`);
  // 注意：1.1.1.1 / 1.0.0.1 是 CF 公共 DNS，TCP 443 可连但不适合做代理节点地址
  return [...out];
}

/**
 * 测单个 IP 的 443 延迟，取 N 次最小值。
 * 提供 sni 时做 TLS 握手测试（模拟真实代理连接，能测出 GFW 在 TLS 层的 SNI 封锁）；
 * 否则退化为纯 TCP 连接测试。
 * @param {string} ip
 * @param {{port?: number, tries?: number, timeout?: number, sni?: string}} [opts]
 * @returns {Promise<number>} 延迟秒，失败返回 Infinity
 */
export function testIP(ip, { port = 443, tries = 2, timeout = 2000, sni } = {}) {
  return new Promise((resolve) => {
    let best = Infinity;
    let done = 0;
    const attempt = () => {
      if (done >= tries) return resolve(best);
      done++;
      const start = process.hrtime.bigint();
      const onOk = (sock) => {
        const dt = process.hrtime.bigint() - start;
        sock.destroy();
        const sec = Number(dt) / 1e9;
        if (sec < best) best = sec;
        if (done < tries) attempt(); else resolve(best);
      };
      const onFail = (sock) => {
        sock.destroy();
        if (done < tries) attempt(); else resolve(best);
      };
      if (sni) {
        const sock = tls.connect({ host: ip, port, servername: sni, rejectUnauthorized: false }, () => onOk(sock));
        sock.setTimeout(timeout);
        sock.on('timeout', () => onFail(sock));
        sock.on('error', () => onFail(sock));
      } else {
        const sock = net.createConnection({ host: ip, port }, () => onOk(sock));
        sock.setTimeout(timeout);
        sock.on('timeout', () => onFail(sock));
        sock.on('error', () => onFail(sock));
      }
    };
    attempt();
  });
}

/**
 * 并发测速一批 IP，返回按延迟升序的结果。
 * @param {string[]} [ips]
 * @param {{concurrency?: number, topN?: number, onProgress?: (done:number,total:number)=>void}} [opts]
 * @returns {Promise<{ip:string, ms:number}[]>}
 */
export async function testBatch(ips, { concurrency = 50, onProgress, sni } = {}) {
  const results = [];
  let index = 0;
  let done = 0;
  const total = ips.length;

  async function worker() {
    while (index < ips.length) {
      const i = index++;
      const ip = ips[i];
      const sec = await testIP(ip, { sni });
      done++;
      onProgress?.(done, total);
      if (Number.isFinite(sec)) results.push({ ip, ms: sec * 1000 });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, worker));
  results.sort((a, b) => a.ms - b.ms);
  return results;
}

/**
 * 把 TOP N IP 格式化为 ADD.txt 内容（每行 IP#CF优K）。
 * @param {{ip:string, ms:number}[]} ranked
 * @param {number} [n=30]
 */
export function toADDContent(ranked, n = 30) {
  return ranked
    .slice(0, n)
    .map((r, i) => `${r.ip}#CF优${i + 1}`)
    .join('\n') + '\n';
}
