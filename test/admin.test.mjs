/**
 * 管理服务 HTTP API：随机端口起服务、注入假连接适配器，用 fetch 调真实接口。数据落在 data/test-admin
 * 覆盖：只绑本机 · 连接状态透传 · 会话列表 · 历史分页与三方角色 · 未知 API · 端口占用
 */
import { rmSync } from 'node:fs';
import { strictEqual as eq, ok, deepStrictEqual as deq, rejects } from 'node:assert';

process.env.DATA_DIR = './data/test-admin';
rmSync('./data/test-admin', { recursive: true, force: true });
const { handleIncoming, saveMsg, setPause } = await import('../src/lib.mjs');
const { startAdmin } = await import('../src/admin.mjs');

let conn = { state: 'connecting' };
const server = await startAdmin({ port: 0, conn: { status: () => conn } });
const { address, port } = server.address();
eq(address, '127.0.0.1', 'admin must only listen on localhost');
const api = async path => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, body: await r.json() };
};

/* 连接状态：如实透传适配器 */
for (const state of ['connecting', 'open', 'qr', 'loggedOut']) {
  conn = { state, qr: 'raw-qr' };
  eq((await api('/api/status')).body.state, state, `status ${state}`);
}

/* 会话列表：最后一条消息摘要和时间、转人工期到期时间，按最后一条消息倒序 */
const io = { typing: async () => {}, send: async () => `s-${Math.random()}` };
const a = 'a@s.whatsapp.net', b = 'b@s.whatsapp.net';
saveMsg(a, 'user', 'hello from a');
saveMsg(b, 'user', 'hello from b');
await handleIncoming({ id: 'b-op', chat: b, from: b, body: 'operator here', fromMe: true }, io);   // 运营接管 → 转人工期
saveMsg(a, 'assistant', 'x'.repeat(500));
{
  const { status, body } = await api('/api/chats');
  eq(status, 200);
  deq(body.map(c => c.chat), [a, b], 'newest last message first');
  ok(body[0].last.length < 500, 'last message is a summary');
  eq(body[0].until, 0, 'a is not in a handoff window');
  eq(body[1].last, 'operator here');
  ok(body[1].until > Date.now(), 'b is in a handoff window');
  ok(body[1].ts > 0 && body[0].ts >= body[1].ts, 'last message time');
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
