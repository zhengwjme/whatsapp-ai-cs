/**
 * WAHA 传输层自检：起假 WAHA + 假 LLM，跑**真的** bot.mjs（不联网、不花钱）。
 * 覆盖：健康检查精确路径 · webhook 立即 200 并回发 · 超大 body 413 · WAHA 500 不掀掉进程
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
    if (req.url.startsWith('/api/sendText')) {
      if (failSend) return res.writeHead(500).end('down');
      sends.push(JSON.parse(b).text);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
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
