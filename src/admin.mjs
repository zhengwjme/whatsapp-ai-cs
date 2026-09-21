/**
 * 管理服务：与机器人同进程，只监听 127.0.0.1、不鉴权（见 docs/adr/0002）。
 * /api/* 是 JSON API，其余路径返回 admin.html。测试：test/admin.test.mjs
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { listChats, historyPage, openHandoff, resume, operatorSend } from './lib.mjs';
import { readConfig, saveConfig, savePhone } from './config.mjs';

const PAGE = readFileSync(new URL('./admin.html', import.meta.url));

// 二维码用已装的 qrcode-terminal 自带的编码器（不加新依赖），自己画成 SVG
const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

/** 二维码字符串 → SVG：每个黑模块一个 1×1 方块，四周留 4 格白边 */
function qrSvg(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), size = n + 8;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/**
 * @param opts {{port: number, envFile: string, conn: {
 *   status(): {state: 'connecting'|'open'|'qr'|'loggedOut', qr?: string},
 *   send(chat: string, text: string): Promise<string|undefined>,
 *   pair(phone: string): Promise<string>, relink(): Promise<void>}}}
 *   conn 是传输层注入的连接适配器：send 以本号身份发文字、返回消息 id；pair 为号码申请配对码；
 *   relink 退出登录、清除登录态、重新发起连接。envFile 是配置写回的 .env 路径
 * @returns {Promise<import('node:http').Server>} 监听失败（如端口被占用）时 reject
 */
export function startAdmin({ port, conn, envFile }) {
  // 只监听本机不等于只有本人能访问：运营浏览器里的任何网页都能跨源 POST 进来（改模型地址、偷 API key、
  // 冒充本号发消息），DNS rebinding 还能绕开 IP 限制。挡住非本机来源的 Origin 与被改写的 Host
  const local = host => {                                 // port 为 0 时真实端口要等监听后才知道；80 端口浏览器不带端口号
    const m = /^(?:127\.0\.0\.1|localhost)(?::(\d+))?$/.exec(host || '');
    return !!m && +(m[1] ?? 80) === server.address()?.port;
  };
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!local(req.headers.host) || (origin && !local(origin.replace(/^http:\/\//, '')))) {
      return res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
    }
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
    const json = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    try {
      const route = `${req.method} ${url.pathname.replace(/^\/api\/chats\/[^/]+\//, '/api/chats/:chat/')}`;
      const chat = decodeURIComponent(url.pathname.split('/')[3] || '');
      const q = url.searchParams;
      switch (route) {
        case 'GET /api/status': {
          const { state, qr } = conn.status();
          return json(200, state === 'qr' && qr ? { state, qrSvg: qrSvg(qr) } : { state });
        }
        case 'POST /api/pair': {                                                               // 用号码获取配对码
          const { phone } = await readJson(req);
          if (typeof phone !== 'string' || !/^\d{7,15}$/.test(phone)) {
            return json(400, { error: 'enter the number with country code, digits only, no + or spaces', field: 'phone' });
          }
          const { state } = conn.status();
          if (state === 'open') return json(409, { error: 'WhatsApp is already connected' });
          if (state !== 'qr') return json(409, { error: 'WhatsApp is not ready for login yet, try again in a moment' });
          const code = await conn.pair(phone);
          savePhone(envFile, phone);                                                           // 记住号码，下次重新关联不用再填
          return json(200, { code });
        }
        case 'POST /api/relink': await conn.relink(); return json(200, {});                   // 退出并重新关联
        case 'GET /api/chats': return json(200, listChats());
        case 'GET /api/chats/:chat/messages':
          return json(200, historyPage(chat, +q.get('before') || undefined, +q.get('limit') || undefined));
        case 'POST /api/chats/:chat/handoff': return json(200, { until: openHandoff(chat) });   // 手动转人工
        case 'POST /api/chats/:chat/resume': resume(chat); return json(200, {});             // 恢复接待
        case 'POST /api/chats/:chat/send': {                                                   // 运营发送
          const { text } = await readJson(req);
          if (typeof text !== 'string' || !text.trim()) return json(400, { error: 'message is empty', field: 'text' });
          if (conn.status().state !== 'open') return json(409, { error: 'WhatsApp is not connected' });
          try {
            return json(200, { until: await operatorSend(chat, text, t => conn.send(chat, t)) });
          } catch (e) {
            return json(502, { error: `send failed: ${e.message}` });
          }
        }
        case 'GET /api/config': return json(200, readConfig());
        case 'POST /api/config':
          try {
            return json(200, saveConfig(envFile, await readJson(req)));
          } catch (e) {
            if (e.field) return json(400, { error: e.message, field: e.field });
            throw e;
          }
        default: return json(404, { error: 'not found' });
      }
    } catch (e) {
      json(500, { error: e.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}
