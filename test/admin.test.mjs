/**
 * 管理服务 HTTP API：随机端口起服务、注入假连接适配器，用 fetch 调真实接口。数据落在 data/test-admin
 * 覆盖：只绑本机 · 连接状态透传 · 会话列表与客户昵称 · 旧库升级 · 历史分页与三方角色 · 手动转人工与恢复接待 · 未知 API · 端口占用
 */
import { createServer } from 'node:http';
import { rmSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { strictEqual as eq, ok, deepStrictEqual as deq, rejects } from 'node:assert';

process.env.DATA_DIR = './data/test-admin';
process.env.OPENAI_API_KEY = 'test';
process.env.SYSTEM_PROMPT = 'sys';

/* 假 LLM：回 echo:<最后一句客户话>；hold 非空时挂起，等 hold.release() */
const calls = [];
let hold = null;
const holdLlm = () => {
  const h = {};
  h.arrived = new Promise(r => { h.arrive = r; });
  h.gate = new Promise(r => { h.release = r; });
  return (hold = h);
};
const llm = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const msgs = JSON.parse(body).messages;
    calls.push(msgs);
    const last = msgs.findLast(m => m.role === 'user').content;
    const reply = () => res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `echo:${last}` } }] }));
    if (!hold) return reply();
    const h = hold; hold = null;
    h.arrive(); h.gate.then(reply);
  });
});
await new Promise(r => llm.listen(0, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${llm.address().port}/v1`;

rmSync('./data/test-admin', { recursive: true, force: true });
{ // 旧库：只有旧表和旧数据，启动时要自动补上昵称表
  mkdirSync('./data/test-admin', { recursive: true });
  const old = new DatabaseSync('./data/test-admin/bot.db');
  old.exec(`CREATE TABLE msg(chat_id TEXT, role TEXT, content TEXT, ts INTEGER);
    INSERT INTO msg VALUES('old@s.whatsapp.net', 'user', 'from before', ${Date.now()});`);
  old.close();
}
const { CFG, handleIncoming, saveMsg, setPause, pauseUntil, historyOf } = await import('../src/lib.mjs');
const { startAdmin } = await import('../src/admin.mjs');

let conn = { state: 'connecting' };
const server = await startAdmin({ port: 0, conn: { status: () => conn } });
const { address, port } = server.address();
eq(address, '127.0.0.1', 'admin must only listen on localhost');
const api = async (path, method = 'GET') => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return { status: r.status, body: await r.json() };
};
const chatApi = (chat, action) => api(`/api/chats/${encodeURIComponent(chat)}/${action}`, 'POST');
const untilIn = async chat => (await api('/api/chats')).body.find(c => c.chat === chat)?.until;

/* 连接状态：如实透传适配器 */
for (const state of ['connecting', 'open', 'qr', 'loggedOut']) {
  conn = { state, qr: 'raw-qr' };
  eq((await api('/api/status')).body.state, state, `status ${state}`);
}

/* 会话列表：最后一条消息摘要和时间、转人工期到期时间，按最后一条消息倒序 */
const makeIo = () => {
  const io = { sent: [], stopped: 0, typing: async () => {} };
  io.stopTyping = async () => { io.stopped++; };
  io.send = async t => { io.sent.push(t); return `s-${Math.random()}`; };
  return io;
};
const io = makeIo();
const a = 'a@s.whatsapp.net', b = 'b@s.whatsapp.net';
saveMsg(a, 'user', 'hello from a');
saveMsg(b, 'user', 'hello from b');
await handleIncoming({ id: 'b-op', chat: b, from: b, body: 'operator here', fromMe: true }, io);   // 运营接管 → 转人工期
saveMsg(a, 'assistant', 'x'.repeat(500));
{
  const { status, body } = await api('/api/chats');
  eq(status, 200);
  deq(body.map(c => c.chat), [a, b, 'old@s.whatsapp.net'], 'newest last message first');
  ok(body[0].last.length < 500, 'last message is a summary');
  eq(body[0].until, 0, 'a is not in a handoff window');
  eq(body[1].last, 'operator here');
  ok(body[1].until > Date.now(), 'b is in a handoff window');
  ok(body[1].ts > 0 && body[0].ts >= body[1].ts, 'last message time');
  eq(body.at(-1).chat, 'old@s.whatsapp.net', 'old database still listed');
  eq(body.at(-1).name, '', 'no name yet: empty field');
}

/* 客户昵称：只取客户消息的 pushName，改名后显示新昵称，运营消息不覆盖 */
{
  const d = 'd@s.whatsapp.net';
  const nameOf = async () => (await api('/api/chats')).body.find(c => c.chat === d)?.name;
  await handleIncoming({ id: 'd-1', chat: d, from: d, body: '', media: 'image', name: 'Jane' }, io);
  eq(await nameOf(), 'Jane', 'name from customer message');
  await handleIncoming({ id: 'd-2', chat: d, from: d, body: 'still me', name: 'Jane Smith' }, io);   // 转人工期内也更新
  eq(await nameOf(), 'Jane Smith', 'renamed customer shows the new name');
  await handleIncoming({ id: 'd-3', chat: d, from: d, body: 'op', fromMe: true }, io);
  eq(await nameOf(), 'Jane Smith', 'operator message keeps the customer name');
}

/* 历史：倒序分页、游标、默认 200 条、三方角色、非文字占位 */
{
  const c = 'c@s.whatsapp.net';
  for (let i = 0; i < 250; i++) saveMsg(c, 'user', `m${i}`);
  await handleIncoming({ id: 'c-voice', chat: c, from: c, body: '', media: 'voice' }, io);   // 非文字 → 占位 + 转人工话术
  await handleIncoming({ id: 'c-op', chat: c, from: c, body: 'op reply', fromMe: true }, io);
  const p1 = (await api(`/api/chats/${encodeURIComponent(c)}/messages`)).body;
  eq(p1.length, 200, 'default page size 200');
  deq(p1.slice(0, 3).map(m => [m.role, m.content]),
    [['operator', 'op reply'], ['assistant', (await import('../src/lib.mjs')).CFG.handoffText], ['user', '[voice message]']],
    'newest first, three roles, non-text placeholder');
  ok(p1.every(m => m.id && m.ts), 'each message has cursor id and time');
  const p2 = (await api(`/api/chats/${encodeURIComponent(c)}/messages?before=${p1.at(-1).id}`)).body;
  eq(p2.length, 53, 'second page holds the rest');
  eq(p2[0].content, `m${249 - 197}`, 'second page continues right before the cursor');
  eq(p2.at(-1).content, 'm0');
  const small = (await api(`/api/chats/${encodeURIComponent(c)}/messages?limit=5`)).body;
  eq(small.length, 5, 'limit respected');
}

/* 手动转人工：客户察觉不到（不发话术、不写历史）；之后客户消息只记不答；再点重新计满 */
{
  const e = 'e@s.whatsapp.net', io = makeIo();
  await handleIncoming({ id: 'e-1', chat: e, from: e, body: 'Q1' }, io);
  eq(io.sent.join('|'), 'echo:Q1');
  const t0 = Date.now();
  const r = await chatApi(e, 'handoff');
  eq(r.status, 200);
  ok(r.body.until >= t0 + CFG.pauseHours * 3600e3, 'window uses the configured length');
  eq(await untilIn(e), r.body.until, 'list shows the handoff window');
  eq(io.sent.length, 1, 'manual handoff sends nothing to the customer');
  eq(historyOf(e, 20).map(m => m.role).join(','), 'user,assistant', 'manual handoff writes no history');
  await handleIncoming({ id: 'e-2', chat: e, from: e, body: 'Q2' }, io);
  eq(io.sent.length, 1, 'customer messages are only logged during the window');

  setPause(e, Date.now() + 60e3);                      // 快到期时再点：从此刻重新计满
  const t1 = Date.now();
  ok((await chatApi(e, 'handoff')).body.until >= t1 + CFG.pauseHours * 3600e3, 'handoff again refills the window');

  /* 恢复接待：不发任何消息；之后机器人回复，并能看到转人工期间客户和运营的发言 */
  await handleIncoming({ id: 'e-op', chat: e, from: e, body: 'operator: order shipped', fromMe: true }, io);
  eq((await chatApi(e, 'resume')).status, 200);
  eq(io.sent.length, 1, 'resume sends nothing to the customer');
  eq(await untilIn(e), 0, 'list shows the bot is back');
  await handleIncoming({ id: 'e-3', chat: e, from: e, body: 'Q3' }, io);
  eq(io.sent.join('|'), 'echo:Q1|echo:Q3', 'bot replies after resume');
  const ctx = calls.at(-1).map(m => m.content);
  ok(ctx.includes('Q2') && ctx.includes('operator: order shipped'), `model sees what was said during the window: ${ctx}`);

  eq((await chatApi('nobody@s.whatsapp.net', 'resume')).status, 200, 'resume outside a window is fine');
}

/* 竞态：模型生成期间手动转人工 → 放行后回复不发、不记 */
{
  const f = 'f@s.whatsapp.net', io = makeIo();
  const h = holdLlm();
  const p = handleIncoming({ id: 'f-1', chat: f, from: f, body: 'Qf' }, io);
  await h.arrived;
  await chatApi(f, 'handoff');
  h.release();
  await p;
  eq(io.sent.length, 0, 'reply is dropped after a manual handoff');
  eq(historyOf(f, 20).map(m => m.role).join(','), 'user', 'dropped reply is not logged');
  eq(io.stopped, 1, 'typing indicator stopped');
  ok(pauseUntil(f) > Date.now());
}

/* 未知 API：非 2xx + { error } */
{
  const { status, body } = await api('/api/nope');
  ok(status >= 400, 'unknown api is an error');
  ok(typeof body.error === 'string', 'error body');
}

/* 页面：非 /api/ 路径返回 HTML */
{
  const r = await fetch(`http://127.0.0.1:${port}/`);
  eq(r.status, 200);
  ok(r.headers.get('content-type').startsWith('text/html'));
  ok((await r.text()).includes('<html'), 'serves the page');
}

/* 端口被占用：启动失败要抛出，交给调用方提示 */
await rejects(startAdmin({ port, conn: { status: () => conn } }), { code: 'EADDRINUSE' });

setPause(b, 0);
server.close();
llm.closeAllConnections();
llm.close();
