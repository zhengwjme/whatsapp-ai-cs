/**
 * 传输 A：WAHA HTTP（推荐，需 Docker）。
 * 启动：node bot.mjs        自检：node bot.mjs --selftest
 */
import { createServer } from 'node:http';
import { shouldReply, handleIncoming, selftest, CFG } from './lib.mjs';

const WAHA = {
  port: +(process.env.PORT || 8787),
  url: (process.env.WAHA_URL || 'http://localhost:3000').replace(/\/$/, ''),
  key: process.env.WAHA_API_KEY || '',
  session: process.env.WAHA_SESSION || 'default',
};

async function waha(path, body) {
  const r = await fetch(`${WAHA.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': WAHA.key },
    body: JSON.stringify({ session: WAHA.session, ...body }),
  });
  if (!r.ok) throw new Error(`WAHA ${path} ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/health')) return res.writeHead(200).end('ok');  // 容器健康检查
  if (req.method !== 'POST' || !req.url.startsWith('/webhook')) return res.writeHead(404).end();
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}'); // 立即 200，WAHA 才不重试
    try {
      const { event, payload } = JSON.parse(raw || '{}');
      if (event === 'message' && shouldReply(payload)) {
        handleIncoming(
          { id: payload.id, chat: payload.from, from: payload.from, body: payload.body, fromMe: payload.fromMe },
          {
            typing: () => waha('/api/startTyping', { chatId: payload.from }),
            stopTyping: () => waha('/api/stopTyping', { chatId: payload.from }),
            send: text => waha('/api/sendText', { chatId: payload.from, text }),
          },
        );
      }
      if (event === 'session.status') console.log('[session]', payload?.status ?? payload);
    } catch (e) { console.error('[webhook]', e.message); }
  });
});

if (process.argv.includes('--selftest')) selftest();
else server.listen(WAHA.port, () => console.log(`bot(WAHA) on :${WAHA.port} -> ${WAHA.url} (${CFG.model})`));
