/**
 * 管理服务 HTTP API：随机端口起服务、注入假连接适配器，用 fetch 调真实接口。数据落在 data/test-admin
 * 覆盖：只绑本机 · 连接状态透传 · 会话列表与客户昵称 · 旧库升级 · 历史分页与三方角色 · 手动转人工与恢复接待 · 运营发送 · 配置读写 · 网页登录与重新关联 · 未知 API · 端口占用
 */
import { createServer, request } from 'node:http';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { strictEqual as eq, ok, deepStrictEqual as deq, rejects } from 'node:assert';

process.env.DATA_DIR = './data/test-admin';
process.env.OPENAI_API_KEY = 'sk-test-123456789';
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
const outbox = [];                                        // 假适配器经 WhatsApp 发出的消息
let sendFails = false;
const paired = [];                                        // 假适配器收到的配对码请求
let relinks = 0;
const adapter = {
  status: () => conn,
  pair: async phone => { paired.push(phone); return 'ABCD1234'; },
  relink: async () => { relinks++; conn = { state: 'connecting' }; },
  send: async (chat, text) => {
    if (sendFails) throw new Error('send 500');
    outbox.push({ chat, text });
    return `op-${outbox.length}`;
  },
};
const ENV = './data/test-admin/.env';
const server = await startAdmin({ port: 0, conn: adapter, envFile: ENV });
const { address, port } = server.address();
eq(address, '127.0.0.1', 'admin must only listen on localhost');
const api = async (path, method = 'GET', body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const chatApi = (chat, action, body) => api(`/api/chats/${encodeURIComponent(chat)}/${action}`, 'POST', body);
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

/* 运营发送：经适配器发出 → 以运营身份记一次 → 开启转人工期；回显不重复；失败/空白/未连接都拒绝 */
{
  const g = 'g@s.whatsapp.net', io = makeIo();
  await handleIncoming({ id: 'g-1', chat: g, from: g, body: 'Qg' }, io);
  const roles = () => historyOf(g, 20).map(m => m.role).join(',');

  conn = { state: 'connecting' };
  const off = await chatApi(g, 'send', { text: 'hello' });
  ok(off.status >= 400 && /not connected/i.test(off.body.error), 'refused while WhatsApp is not connected');
  conn = { state: 'open' };

  for (const text of ['', '   \n ', undefined]) {
    const r = await chatApi(g, 'send', { text });
    ok(r.status >= 400 && r.body.field === 'text', `blank text refused: ${JSON.stringify(text)}`);
  }
  eq(outbox.length, 0, 'nothing sent when refused');

  sendFails = true;
  const failed = await chatApi(g, 'send', { text: 'will fail' });
  ok(failed.status >= 400 && failed.body.error, 'adapter failure is an error');
  eq(roles(), 'user,assistant', 'failed send writes no history');
  eq(pauseUntil(g), 0, 'failed send opens no window');
  sendFails = false;

  const r = await chatApi(g, 'send', { text: 'Hi, Sam here £5 off' });
  eq(r.status, 200);
  deq(outbox.at(-1), { chat: g, text: 'Hi, Sam here £5 off' }, 'sent through the adapter');
  deq({ ...historyOf(g, 1)[0] }, { role: 'operator', content: 'Hi, Sam here £5 off' }, 'logged as operator');
  ok(pauseUntil(g) > Date.now(), 'counts as operator takeover');

  await handleIncoming({ id: `op-${outbox.length}`, chat: g, from: g, body: 'Hi, Sam here £5 off', fromMe: true }, io);   // 回显
  eq(roles(), 'user,assistant,operator', 'echo is not logged again');

  await handleIncoming({ id: 'g-phone', chat: g, from: g, body: 'from my phone', fromMe: true }, io);   // 手机上回复照旧
  eq(roles(), 'user,assistant,operator,operator', 'phone reply still logged as operator');
  eq(io.sent.length, 1, 'bot stays quiet');

  // 与客户消息同一条队列：机器人正在回复时运营发送，排在这条回复之后
  const k = 'k@s.whatsapp.net', io2 = makeIo();
  const h = holdLlm();
  const p = handleIncoming({ id: 'k-1', chat: k, from: k, body: 'Qk' }, io2);
  await h.arrived;
  const sending = chatApi(k, 'send', { text: 'op after bot' });
  await new Promise(r => setTimeout(r, 50));
  eq(outbox.at(-1).text, 'Hi, Sam here £5 off', 'operator send waits for the queued bot reply');
  h.release();
  await p;
  eq((await sending).status, 200);
  eq(historyOf(k, 20).map(m => `${m.role}:${m.content}`).join('|'), 'user:Qk|assistant:echo:Qk|operator:op after bot', 'queue order kept');
}

/* 配置读写：写回 .env（只改对应行，注释和无关行保留）、立即生效、Key 不回明文、整体校验 */
{
  const original = [
    '# --- AI model ---',
    'OPENAI_BASE_URL=https://api.example.com/v1',
    'OPENAI_API_KEY=sk-secret-123456789',
    'LLM_TIMEOUT_MS=30000                  # Per-call timeout in ms',
    '',
    'SYSTEM_PROMPT="old line 1',
    'old line 2"',
    'UNRELATED=keep me # and my comment',
    'PAUSE_HOURS=1',
    '',
  ].join('\r\n');                                         // 记事本存的是 CRLF
  writeFileSync(ENV, original);
  const cfgApi = body => api('/api/config', body ? 'POST' : 'GET', body);

  const got = (await cfgApi()).body;
  ok(!JSON.stringify(got).includes('sk-test-123456789'), 'API key is never returned in plain text');
  eq(got.OPENAI_API_KEY.set, true);
  ok(got.OPENAI_API_KEY.masked.endsWith('6789'), 'masked key');
  ok(Array.isArray(got.PAUSE_KEYWORD) && typeof got.REPLY_GROUPS === 'boolean');

  const prompt = 'You sell baths. Prices from £199 — it\'s "cheap" #1.\nIf unsure, end with [[HANDOFF]].';
  const good = {
    SYSTEM_PROMPT: prompt, HANDOFF_TEXT: 'A colleague will reply shortly — £0 extra.', PAUSE_KEYWORD: ['need a human', 'call me back'],
    PAUSE_HOURS: 2, HISTORY_TURNS: 8, REPLY_GROUPS: false, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: '', OPENAI_MODEL: 'fake-2', LLM_TIMEOUT_MS: 5000,
  };

  // 非法值：整体拒绝，指出字段，.env 一个字节都不动
  for (const [field, bad] of [['PAUSE_HOURS', -1], ['PAUSE_HOURS', 'abc'], ['HISTORY_TURNS', 0], ['LLM_TIMEOUT_MS', ''],
    ['REPLY_GROUPS', 'yes'], ['OPENAI_BASE_URL', 'ftp://x'], ['OPENAI_BASE_URL', 'not a url'], ['PAUSE_KEYWORD', []]]) {
    const r = await cfgApi({ ...good, [field]: bad });
    eq(r.status, 400, `${field}=${JSON.stringify(bad)} rejected`);
    eq(r.body.field, field, `error names ${field}`);
    eq(readFileSync(ENV, 'utf8'), original, `.env untouched after invalid ${field}`);
  }

  // 修改时长前先有一个转人工期：保存后它的到期时间不变
  const w = 'w@s.whatsapp.net';
  const oldUntil = (await chatApi(w, 'handoff')).body.until;

  const r = await cfgApi(good);
  eq(r.status, 200);
  ok(!r.body.warning, 'no warning when [[HANDOFF]] is present');
  const text = readFileSync(ENV, 'utf8');
  const env = parseEnv(text);
  eq(env.SYSTEM_PROMPT, prompt, 'multi-line prompt with £, quotes and # round-trips through Node --env-file rules');
  eq(env.HANDOFF_TEXT, good.HANDOFF_TEXT, 'missing key appended');
  eq(env.PAUSE_KEYWORD, 'need a human,call me back');
  eq(env.OPENAI_API_KEY, 'sk-secret-123456789', 'blank API key leaves the key unchanged');
  eq(env.UNRELATED, 'keep me', 'unrelated key kept');
  ok(text.startsWith('# --- AI model ---\r\n'), 'comment kept');
  ok(text.includes('UNRELATED=keep me # and my comment\r\n'), 'unrelated line kept byte for byte');
  ok(text.includes('LLM_TIMEOUT_MS=5000                  # Per-call timeout in ms'), 'inline comment kept');
  ok(!text.includes('old line'), 'old multi-line value fully replaced');
  ok(text.includes('\r\n\r\n'), 'blank lines kept');

  // 立即生效：新 SYSTEM_PROMPT、新关键词、新转人工期时长
  eq(pauseUntil(w), oldUntil, 'existing handoff window unchanged by the new PAUSE_HOURS');
  const t0 = Date.now();
  ok((await chatApi('w2@s.whatsapp.net', 'handoff')).body.until >= t0 + 2 * 3600e3, 'new windows use the new length');
  const x = 'x@s.whatsapp.net', io = makeIo();
  await handleIncoming({ id: 'x-1', chat: x, from: x, body: 'hello' }, io);
  eq(calls.at(-1)[0].content, prompt, 'next LLM call uses the new SYSTEM_PROMPT');
  await handleIncoming({ id: 'x-2', chat: x, from: x, body: 'please CALL ME BACK' }, io);
  eq(io.sent.at(-1), good.HANDOFF_TEXT, 'new keyword and handoff text take effect at once');

  // 新 Key 写入；缺 [[HANDOFF]] 照常保存但带警告
  const r2 = await cfgApi({ ...good, SYSTEM_PROMPT: 'no marker here', OPENAI_API_KEY: 'sk-new-abcdefgh' });
  eq(r2.status, 200);
  ok(r2.body.warning?.includes('[[HANDOFF]]'), 'warning when [[HANDOFF]] is missing');
  eq(parseEnv(readFileSync(ENV, 'utf8')).OPENAI_API_KEY, 'sk-new-abcdefgh', 'new API key saved');
  eq(parseEnv(readFileSync(ENV, 'utf8')).SYSTEM_PROMPT, 'no marker here');

  // .env 不存在就新建
  rmSync(ENV);
  eq((await cfgApi({ PAUSE_HOURS: 3 })).status, 200);
  eq(parseEnv(readFileSync(ENV, 'utf8')).PAUSE_HOURS, '3', '.env created when missing');
}

/* 网页登录：二维码 SVG、配对码（号码写回 .env）、退出并重新关联 */
{
  conn = { state: 'qr', qr: '2@first-qr-string,abc' };
  const s1 = (await api('/api/status')).body;
  eq(s1.state, 'qr');
  ok(/^<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"[^>]*>[\s\S]*<\/svg>$/.test(s1.qrSvg), 'valid SVG QR code');
  ok(!s1.qr, 'raw QR string is not needed by the page');
  conn = { state: 'qr', qr: '2@second-qr-string,xyz' };
  const s2 = (await api('/api/status')).body;
  ok(s2.qrSvg && s2.qrSvg !== s1.qrSvg, 'new QR code after it changes');
  conn = { state: 'open' };
  eq((await api('/api/status')).body.qrSvg, undefined, 'no QR code once connected');

  writeFileSync(ENV, '# Your number, country code first, no +\nWHATSAPP_PHONE=\nPAUSE_HOURS=3\n');
  const before = readFileSync(ENV, 'utf8');
  conn = { state: 'qr', qr: 'x' };
  for (const bad of ['+447700900123', '44 7700 900123', '447700-900123', 'abc', '', undefined, 123]) {
    const r = await api('/api/pair', 'POST', { phone: bad });
    eq(r.status, 400, `bad phone ${JSON.stringify(bad)} rejected`);
    eq(r.body.field, 'phone');
  }
  eq(paired.length, 0, 'adapter not called for bad numbers');
  eq(readFileSync(ENV, 'utf8'), before, '.env untouched for bad numbers');

  const r = await api('/api/pair', 'POST', { phone: '447700900123' });
  eq(r.status, 200);
  eq(r.body.code, 'ABCD1234', 'pairing code returned');
  deq(paired, ['447700900123'], 'pairing goes through the adapter');
  const text = readFileSync(ENV, 'utf8');
  eq(parseEnv(text).WHATSAPP_PHONE, '447700900123', 'number written back to WHATSAPP_PHONE');
  ok(text.startsWith('# Your number, country code first, no +\n'), 'comment kept');
  eq(parseEnv(text).PAUSE_HOURS, '3');
  eq(CFG.phone, '447700900123', 'CFG knows the number too');
  eq((await api('/api/config')).body.WHATSAPP_PHONE, '447700900123', 'remembered number is offered next time');

  conn = { state: 'open' };
  const again = await api('/api/pair', 'POST', { phone: '447700900123' });
  ok(again.status >= 400 && /already connected/i.test(again.body.error), 'pairing refused while connected');
  eq(paired.length, 1);

  eq((await api('/api/relink', 'POST')).status, 200);
  eq(relinks, 1, 'relink goes through the adapter');
  eq((await api('/api/status')).body.state, 'connecting');
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

/* 跨源与改写 Host 的请求要挡掉：运营浏览器里的别的网页不能借本机地址改配置、发消息 */
{
  const r = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { origin: 'http://evil.example' } });
  eq(r.status, 403, 'cross-origin request rejected');
  const h = await new Promise(done => {                         // fetch 不让改 Host，用原始请求
    request({ host: '127.0.0.1', port, path: '/api/config', headers: { Host: 'evil.example' } }, done).end();
  });
  eq(h.statusCode, 403, 'rebound host rejected');
  const ok200 = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { origin: `http://localhost:${port}` } });
  eq(ok200.status, 200, 'same-origin request still works');
}

/* 端口被占用：启动失败要抛出，交给调用方提示 */
await rejects(startAdmin({ port, conn: adapter, envFile: ENV }), { code: 'EADDRINUSE' });

setPause(b, 0);
server.close();
llm.closeAllConnections();
llm.close();
