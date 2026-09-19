/**
 * 管理服务：与机器人同进程，只监听 127.0.0.1、不鉴权（见 docs/adr/0002）。
 * /api/* 是 JSON API，其余路径返回 admin.html。测试：test/admin.test.mjs
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { listChats, historyPage, openHandoff, resume } from './lib.mjs';

const PAGE = readFileSync(new URL('./admin.html', import.meta.url));

/**
 * @param opts {{port: number, conn: {status(): {state: 'connecting'|'open'|'qr'|'loggedOut', qr?: string}}}}
 *   conn 是传输层注入的连接适配器
 * @returns {Promise<import('node:http').Server>} 监听失败（如端口被占用）时 reject
 */
export function startAdmin({ port, conn }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
    const json = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    try {
      const route = `${req.method} ${url.pathname.replace(/^\/api\/chats\/[^/]+\//, '/api/chats/:chat/')}`;
      const chat = decodeURIComponent(url.pathname.split('/')[3] || '');
      const q = url.searchParams;
      switch (route) {
        case 'GET /api/status': return json(200, { state: conn.status().state });
        case 'GET /api/chats': return json(200, listChats());
        case 'GET /api/chats/:chat/messages':
          return json(200, historyPage(chat, +q.get('before') || undefined, +q.get('limit') || undefined));
        case 'POST /api/chats/:chat/handoff': return json(200, { until: openHandoff(chat) });   // 手动转人工
        case 'POST /api/chats/:chat/resume': resume(chat); return json(200, {});             // 恢复接待
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
