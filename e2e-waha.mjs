/**
 * WAHA 传输层自检：起假 WAHA + 假 LLM，跑**真的** bot.mjs（不联网、不花钱）。
 * 覆盖：健康检查精确路径 · webhook 立即 200 并回发 · 非文字消息归一化 · 运营接管与回显（message.any） · 超大 body 413 · WAHA 500 不掀掉进程
 * 用法：npm run e2e:waha
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strictEqual as eq, ok } from 'node:assert';

const DATA = mkdtempSync(join(tmpdir(), 'bot-waha-'));
const sends = [];
let failSend = false;

const llm = createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    const last = [...(JSON.parse(b || '{}').messages || [])].reverse().find(m => m.role === 'user')?.content;
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { content: `echo:${last}` } }] }));
  });
});
const waha = createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    let out = '{}';
    if (req.url.startsWith('/api/sendText')) {
      if (failSend) return res.writeHead(500).end('down');
      const { chatId, text } = JSON.parse(b);
      sends.push(text);
      out = JSON.stringify({ id: `true_${chatId}_BOT${sends.length}`, fromMe: true, body: text });   // 真 WAHA 回 WAMessage
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(out);
  });
});
await new Promise(r => llm.listen(0, '127.0.0.1', r));
await new Promise(r => waha.listen(0, '127.0.0.1', r));

const bot = spawn('node', ['bot.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: '0',                                  // 端口交给系统分配
    WAHA_URL: `http://127.0.0.1:${waha.address().port}`, WAHA_API_KEY: 'k',
    OPENAI_BASE_URL: `http://127.0.0.1:${llm.address().port}/v1`, OPENAI_API_KEY: 't', OPENAI_MODEL: 'fake',
    DATA_DIR: DATA,
  },
});
let out = '', err = '';
bot.stdout.on('data', d => { out += d; });
bot.stderr.on('data', d => { err += d; });

const wait = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); }
  return false;
};
ok(await wait(() => /bot\(WAHA\) on :(\d+)/.test(out)), `bot.mjs 没起来: ${out}${err}`);
const port = +out.match(/bot\(WAHA\) on :(\d+)/)[1];
const URL = `http://127.0.0.1:${port}`;
const post = body => fetch(`${URL}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

try {
  eq((await fetch(`${URL}/health`)).status, 200, '/health 要 200');
  eq((await fetch(`${URL}/health?x=1`)).status, 200, '/health 带查询串也算');
  eq((await fetch(`${URL}/healthxxx`)).status, 404, '/healthxxx 不能算健康检查');
  eq((await fetch(URL)).status, 404, '/ 要 404');
  console.log('1) 健康检查与路由精确匹配 OK');

  const r = await post(JSON.stringify({ event: 'message', payload: { id: 'w1', from: '111@s.whatsapp.net', body: '你好', fromMe: false } }));
  eq(r.status, 200, 'webhook 立即 200');
  ok(await wait(() => sends.length === 1), '应回发一条');
  eq(sends[0], 'echo:你好');
  console.log('2) webhook → 回发 OK:', JSON.stringify(sends));

  // 非文字归一化：语音 → 转人工；带说明图片 → 按文字回；贴纸 / 无媒体空消息 → 忽略；媒体未下载（media: null）也算文件
  const msg = (id, from, extra) => post(JSON.stringify({ event: 'message', payload: { id, from, body: '', fromMe: false, ...extra } }));
  await msg('w-sticker', '222@s.whatsapp.net', { hasMedia: true, media: { mimetype: 'image/webp' }, _data: { message: { stickerMessage: {} } } });
  await msg('w-empty', '222@s.whatsapp.net', {});
  await msg('w-caption', '222@s.whatsapp.net', { body: '这个多少钱', hasMedia: true, media: { mimetype: 'image/jpeg' } });
  ok(await wait(() => sends.length === 2), `带说明图片应按文字回: ${JSON.stringify(sends)}`);
  eq(sends[1], 'echo:这个多少钱', '贴纸和空消息不回，带说明图片按文字回');
  await msg('w-voice', '333@s.whatsapp.net', { hasMedia: true, media: { mimetype: 'audio/ogg; codecs=opus' } });
  await msg('w-nodl', '444@s.whatsapp.net', { hasMedia: true, media: null });
  ok(await wait(() => sends.length === 4), `语音、未下载媒体都应转人工: ${JSON.stringify(sends)}`);
  eq(sends.slice(2).join('|'), '已为您转接人工，稍后回复您。|已为您转接人工，稍后回复您。');
  console.log('2b) 非文字消息归一化 OK');

  // 运营接管：订阅 message.any 后本号消息也会推来，from 是本号、to 才是会话
  const ME = '999@s.whatsapp.net', C = '555@s.whatsapp.net';
  const any = payload => post(JSON.stringify({ event: 'message.any', payload: { body: '', fromMe: false, ...payload } }));
  await any({ id: 'w-c1', from: C, to: ME, body: 'Q1' });
  ok(await wait(() => sends.length === 5), '客户消息经 message.any 也要回');
  await any({ id: `true_${C}_BOT5`, from: ME, to: C, body: sends[4], fromMe: true, source: 'api' });   // 机器人回复的回显
  await any({ id: 'w-c2', from: C, to: ME, body: 'Q2' });
  ok(await wait(() => sends.length === 6), `回显不算接管，客户下一条照常回: ${JSON.stringify(sends)}`);
  await any({ id: 'true_555_OP1', from: ME, to: C, body: '我来跟进', fromMe: true, source: 'app' });   // 运营从手机回复
  await any({ id: 'w-c3', from: C, to: ME, body: 'Q3' });
  await new Promise(r => setTimeout(r, 1500));
  eq(sends.length, 6, '运营接管后客户消息不再自动回复');
  console.log('2c) 运营接管与回显识别 OK');

  const big = await post('x'.repeat(2e6));                       // 超过 MAX_BODY 的 1MB
  eq(big.status, 413, '超大 body 要 413');
  eq(bot.exitCode, null, '413 之后进程要活着');
  console.log('3) 超大 body 413 OK（2MB →', big.status, '）');

  failSend = true;
  await post(JSON.stringify({ event: 'message', payload: { id: 'w2', from: '111@s.whatsapp.net', body: '我要转人工', fromMe: false } }));
  await new Promise(r => setTimeout(r, 1200));
  eq(bot.exitCode, null, 'WAHA 500 之后进程要活着');
  ok(err.includes('[reply failed]'), '异常要进日志');
  console.log('4) WAHA 失败不崩 OK, 日志:', err.trim().split('\n').pop());
} finally {
  bot.kill();
  llm.closeAllConnections(); waha.closeAllConnections(); llm.close(); waha.close();
  rmSync(DATA, { recursive: true, force: true });
}
console.log('e2e-waha OK');
