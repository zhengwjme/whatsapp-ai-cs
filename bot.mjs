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
    signal: AbortSignal.timeout(CFG.wahaTimeout),   // WAHA 半死时，别把该客户的会话链永久卡住
  });
  if (!r.ok) throw new Error(`WAHA ${path} ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

/**
 * 非文字类型归一化（只归一化，不做判断）：有说明文字的按文字走，不给 media；贴纸不给 media（随后被 shouldReply 丢掉）。
 * 表情回应是单独的 message.reaction 事件，本就不订阅。
 * media 可能是 null（WAHA 没下载媒体），拿不到 mimetype 时按文件处理：宁可转人工，也别把客户的消息吞了。
 */
function mediaOf(p) {
  if (p.body?.trim() || !p.hasMedia) return undefined;
  const mime = p.media?.mimetype || '';
  if (p._data?.message?.stickerMessage || p._data?.type === 'sticker' || mime === 'image/webp') return undefined;   // NOWEB / WEBJS / 兜底
  return mime.startsWith('audio/') ? 'voice' : mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';
}

const MAX_BODY = 1e6;                                         // WAHA 的真实载荷是几 KB，给个上限防打爆内存

const server = createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (req.method === 'GET' && path === '/health') return res.writeHead(200).end('ok');   // 容器健康检查，只认精确路径
  if (req.method !== 'POST' || path !== '/webhook') return res.writeHead(404).end();
  if (+(req.headers['content-length'] || 0) > MAX_BODY) {     // 有长度就硬拒，别默默截断（截断后必然 JSON 解析失败）
    res.writeHead(413).end();
    return req.destroy();
  }
  let raw = '';
  req.on('data', c => { if (raw.length < MAX_BODY) raw += c; });   // 分块上传没有 content-length，兜底截断
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}'); // 立即 200，WAHA 才不重试
    try {
      const { event, payload } = JSON.parse(raw || '{}');
      const msg = event === 'message' && payload
        && { id: payload.id, chat: payload.from, from: payload.from, body: payload.body, fromMe: payload.fromMe, media: mediaOf(payload) };
      if (msg && shouldReply(msg)) {
        handleIncoming(
          msg,
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
// PORT=0 时由系统分配，日志里打真实端口（e2e-waha.mjs 就靠这行拿端口）
else server.listen(WAHA.port, () => console.log(`bot(WAHA) on :${server.address().port} -> ${WAHA.url} (${CFG.model})`));
