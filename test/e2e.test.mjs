/**
 * 离线端到端自检：起一个假 LLM（不联网、不花钱），把传输层之外的整条链路跑一遍。
 * 覆盖：同客户并发串行 · 上下文顺序 · LLM 报错/超时/空内容即转人工 · 无法回答标记 · 非文字消息转人工 · 运营接管 · 去重 · 转人工暂停 · io 失败不崩
 * 用法：npm test        （数据落在 data/e2e，不碰 data/bot.db）
 */
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { strictEqual as eq, ok } from 'node:assert';

process.env.DATA_DIR = './data/e2e';
process.env.OPENAI_API_KEY = 'test';
process.env.OPENAI_MODEL = 'fake';
process.env.LLM_TIMEOUT_MS = '900';
process.env.PAUSE_HOURS = '1';
process.env.SYSTEM_PROMPT = 'sys';
rmSync('./data/e2e', { recursive: true, force: true });   // 每次全新库，免得消息 id 撞上去重表

let mode = 'ok';                                          // ok | fail | hang | empty | mark | markOnly
const calls = [];                                         // 每次调用的 messages 快照
const llm = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const msgs = JSON.parse(body || '{}').messages || [];
    calls.push(msgs);
    if (mode === 'fail') return res.writeHead(500).end('boom');
    if (mode === 'hang') return;                          // 永不响应，用来测超时
    const last = [...msgs].reverse().find(m => m.role === 'user')?.content || '';
    const content = { empty: '  ', mark: `echo:${last}\n${HANDOFF_MARK}`, markOnly: HANDOFF_MARK }[mode] ?? `echo:${last}`;
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});
await new Promise(r => llm.listen(0, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${llm.address().port}/v1`;

const { CFG, HANDOFF_MARK, handleIncoming, historyOf, pauseUntil, setPause, wantsHuman } = await import('../src/lib.mjs');
eq(CFG.baseUrl, process.env.OPENAI_BASE_URL);

let sentSeq = 0;
const makeIo = () => {
  const io = { sent: [], typed: 0, stopped: 0 };
  io.typing = async () => { io.typed++; };
  io.stopTyping = async () => { io.stopped++; };
  io.send = async t => { io.sent.push(t); return `sent-${++sentSeq}`; };   // 像真传输层一样返回消息 id
  return io;
};
const roles = chat => historyOf(chat, 20).map(m => m.role).join(',');

/* 1) 同客户连发两条：必须串行，第二条要看到第一条的问答，回复不许乱序 */
{
  const io = makeIo(); const chat = 'c1@s.whatsapp.net';
  await Promise.all([
    handleIncoming({ id: '1', chat, from: chat, body: 'Q1' }, io),
    handleIncoming({ id: '2', chat, from: chat, body: 'Q2' }, io),
  ]);
  eq(io.sent.join('|'), 'echo:Q1|echo:Q2', 'reply order');
  eq(roles(chat), 'user,assistant,user,assistant', 'history order (answer never before question, even in the same ms)');
  const second = calls[1].map(m => m.content).join(' / ');
  ok(second.includes('Q1') && second.includes('echo:Q1'), `second call must carry context, actual: ${second}`);
  eq(io.stopped, 2, 'typing indicator stopped every time');
}

/* 1b) 同一毫秒的一问一答：必须仍按插入顺序（改回 ORDER BY ts DESC 时这条会挂——真同毫秒才测得出来） */
{
  const chat = 'c1b@s.whatsapp.net';
  const raw = new DatabaseSync('./data/e2e/bot.db');
  const ts = Date.now();
  const ins = raw.prepare('INSERT INTO msg VALUES(?,?,?,?)');
  ins.run(chat, 'user', 'q', ts);
  ins.run(chat, 'assistant', 'a', ts);      // 与上一行完全相同的 ts
  raw.close();
  eq(historyOf(chat, 2).map(m => m.role).join(','), 'user,assistant', 'answer never before question, even in the same ms');
}

/* 2) 去重：同 id 重推不再回 */
{
  const io = makeIo(); const chat = 'c1@s.whatsapp.net';
  await handleIncoming({ id: '2', chat, from: chat, body: 'Q2' }, io);
  eq(io.sent.length, 0, 'duplicate id must not reply twice');
}

/* 3) 模型调用失败即转人工（归为机器人无法回答）：客户收到话术、进入转人工期、这句话不吞 */
const handedOff = (chat, io, what) => {
  eq(io.sent.join('|'), CFG.handoffText, `${what}: customer should get the handoff text`);
  ok(pauseUntil(chat) > Date.now(), `${what}: should open the handoff window`);
  eq(JSON.stringify(historyOf(chat, 20).map(m => [m.role, m.content])),
    JSON.stringify([['user', `Q-${what}`], ['assistant', CFG.handoffText]]),
    `${what}: history should be customer message then handoff text`);
  eq(io.stopped, 1, `${what}: typing indicator must be stopped too`);
};
{
  mode = 'fail';
  const io = makeIo(); const chat = 'c3@s.whatsapp.net';
  await handleIncoming({ id: '3', chat, from: chat, body: 'Q-error' }, io);
  handedOff(chat, io, 'error');
  mode = 'ok';
}
{
  mode = 'empty';
  const io = makeIo(); const chat = 'c3b@s.whatsapp.net';
  await handleIncoming({ id: '3b', chat, from: chat, body: 'Q-empty' }, io);
  handedOff(chat, io, 'empty');
  mode = 'ok';
}

/* 4) LLM 挂住：超时按失败走（尽快转人工），不把客户一直晾着 */
{
  mode = 'hang';
  const io = makeIo(); const chat = 'c4@s.whatsapp.net';
  const t0 = Date.now();
  await handleIncoming({ id: '4', chat, from: chat, body: 'Q-timeout' }, io);
  const dt = Date.now() - t0;
  ok(dt >= 900 && dt < 5000, `should fail fast after timeout, actual ${dt}ms`);
  handedOff(chat, io, 'timeout');
  mode = 'ok';
}

/* 4b) 机器人无法回答：模型附约定标记 → 先发去掉标记的正文，再发话术并转人工；标记不外泄、不入历史 */
{
  mode = 'mark';
  const io = makeIo(); const chat = 'c4b@s.whatsapp.net';
  await handleIncoming({ id: '4b', chat, from: chat, body: 'Q-partial' }, io);
  eq(io.sent.join('|'), `echo:Q-partial|${CFG.handoffText}`, 'answer first, then handoff text');
  ok(pauseUntil(chat) > Date.now(), 'marker should open the handoff window');
  eq(JSON.stringify(historyOf(chat, 20).map(m => [m.role, m.content])),
    JSON.stringify([['user', 'Q-partial'], ['assistant', 'echo:Q-partial'], ['assistant', CFG.handoffText]]),
    'history: customer message, answer, handoff text');
  eq(io.stopped, 1, 'typing indicator stopped with marker too');

  mode = 'markOnly';
  const io2 = makeIo(); const chat2 = 'c4c@s.whatsapp.net';
  await handleIncoming({ id: '4c', chat: chat2, from: chat2, body: 'Q-markOnly' }, io2);
  eq(io2.sent.join('|'), CFG.handoffText, 'marker only sends only the handoff text');
  ok(pauseUntil(chat2) > Date.now(), 'marker only should open the handoff window');
  eq(roles(chat2), 'user,assistant', 'marker only: history gains just the handoff text');
  mode = 'ok';

  const leaked = [...io.sent, ...io2.sent, ...historyOf(chat, 20).map(m => m.content), ...historyOf(chat2, 20).map(m => m.content)]
    .filter(t => t.includes(HANDOFF_MARK));
  eq(leaked.length, 0, 'marker must never reach the customer or history');
}

/* 5) 转人工：话术发成功才静默；发失败不能把客户晾着 */
{
  // 5a) 话术发不出去 → 不静默，下一条照常回（否则客户既没收到话术、又被晾 12 小时）
  const chat = 'c5@s.whatsapp.net';
  const bad = makeIo();
  bad.send = async () => { throw new Error('send 500'); };
  await handleIncoming({ id: '5', chat, from: chat, body: 'I want to speak to a human' }, bad);
  eq(pauseUntil(chat), 0, 'unsent handoff text must not silence the chat');
  eq(roles(chat), 'user', 'unsent handoff text must not be logged');
  const io2 = makeIo();
  await handleIncoming({ id: '6', chat, from: chat, body: 'hello?' }, io2);
  eq(io2.sent.join('|'), 'echo:hello?', 'not silenced, next message gets a reply');

  // 5b) 话术发成功 → 暂停，之后只记不答
  const chat2 = 'c5b@s.whatsapp.net';
  const io3 = makeIo();
  await handleIncoming({ id: '7', chat: chat2, from: chat2, body: 'I want to speak to a human' }, io3);
  eq(io3.sent.join('|'), CFG.handoffText, 'should reply with the handoff text');
  ok(pauseUntil(chat2) > Date.now(), 'window opens only after the handoff text is sent');
  eq(JSON.stringify(historyOf(chat2, 20)),
    JSON.stringify([{ role: 'user', content: 'I want to speak to a human' }, { role: 'assistant', content: CFG.handoffText }]),
    'history ends with customer message then bot handoff text');
  const io4 = makeIo();
  await handleIncoming({ id: '8', chat: chat2, from: chat2, body: 'hello?' }, io4);
  eq(io4.sent.length, 0, 'no reply during the handoff window');
  eq(roles(chat2), 'user,assistant,user', 'only logged during the window');

  // 5c) 转人工期内：未命中关键词不动窗口；再次要求人工则从此刻重新计满，且不重发话术、不回复
  const soon = Date.now() + 60e3;                         // 模拟快到期
  setPause(chat2, soon);
  const io5 = makeIo();
  await handleIncoming({ id: '9', chat: chat2, from: chat2, body: 'anyone there?' }, io5);
  eq(pauseUntil(chat2), soon, 'non-keyword message does not change the window');
  const t0 = Date.now();
  await handleIncoming({ id: '10', chat: chat2, from: chat2, body: 'let me speak to a human now' }, io5);
  const until = pauseUntil(chat2);
  ok(until >= t0 + 3600e3 && until <= Date.now() + 3600e3, `asking again should refill the window, actual remaining ${until - Date.now()}ms`);
  eq(io5.sent.length, 0, 'asking again in the window: no repeat handoff text, no reply');
  eq(roles(chat2), 'user,assistant,user,user,user', 'all messages only logged during the window');
}

/* 5d) 非文字消息（语音/无说明图片/视频/文件）：类型占位记录 → 发话术 → 转人工，不调模型 */
{
  const before = calls.length;
  for (const [media, label] of [['voice', '[voice message]'], ['image', '[image]'], ['video', '[video]'], ['file', '[file]']]) {
    const io = makeIo(); const chat = `c5d-${media}@s.whatsapp.net`;
    await handleIncoming({ id: `5d-${media}`, chat, from: chat, body: '', media }, io);
    eq(io.sent.join('|'), CFG.handoffText, `${media}: customer should get the handoff text`);
    ok(pauseUntil(chat) > Date.now(), `${media}: should open the handoff window`);
    eq(JSON.stringify(historyOf(chat, 20).map(m => [m.role, m.content])),
      JSON.stringify([['user', label], ['assistant', CFG.handoffText]]), `${media}: placeholder logged, then handoff text`);
  }
  eq(calls.length, before, 'non-text never calls the model');

  // 转人工期内再发非文字：只占位记录
  const chat = 'c5d-voice@s.whatsapp.net'; const io = makeIo();
  await handleIncoming({ id: '5d-again', chat, from: chat, body: '', media: 'image' }, io);
  eq(io.sent.length, 0, 'no reply to non-text in the window');
  eq(historyOf(chat, 20).at(-1).content, '[image]', 'non-text in the window only logged as placeholder');
}

/* 6) 关键词：正常咨询不能被当成「找人工」（外贸里 "human hair" 是高频词） */
{
  eq(wantsHuman('do you sell human hair wigs?'), false, 'human hair must not trigger a handoff');
  eq(wantsHuman('humanoid robot?'), false);
  eq(wantsHuman('can I talk to a human agent?'), true);
  eq(wantsHuman('I want to speak to a human'), true);
}

/* 7) 运营接管：运营亲自发言 → 以运营身份入历史、开启/重新计满转人工期；机器人自己消息的回显不算 */
{
  const chat = 'c7@s.whatsapp.net';
  const io = makeIo();
  await handleIncoming({ id: '7-q', chat, from: chat, body: 'Q7' }, io);
  eq(io.sent.join('|'), 'echo:Q7');
  const echoId = `sent-${sentSeq}`;
  await handleIncoming({ id: echoId, chat, from: chat, body: 'echo:Q7', fromMe: true }, io);
  eq(pauseUntil(chat), 0, 'echo of a bot reply is not a takeover');
  eq(roles(chat), 'user,assistant', 'echo is not logged twice');

  // 7a) 机器人接待期间运营插话 → 接管；同 id 重推只记一次
  await handleIncoming({ id: '7-op', chat, from: chat, body: 'on it, I will take over', fromMe: true }, io);
  await handleIncoming({ id: '7-op', chat, from: chat, body: 'on it, I will take over', fromMe: true }, io);
  ok(pauseUntil(chat) > Date.now(), 'operator message should open the handoff window');
  eq(roles(chat), 'user,assistant,operator', 'operator message logged as operator, deduplicated');
  eq(io.sent.length, 1, 'operator message triggers no reply');
  await handleIncoming({ id: '7-q2', chat, from: chat, body: 'ok thanks' }, io);
  eq(io.sent.length, 1, 'no auto-reply after takeover');

  // 7b) 转人工期内运营再次发言 → 重新计满；运营发非文字 → 类型占位
  const soon = Date.now() + 60e3;
  setPause(chat, soon);
  await handleIncoming({ id: '7-op2', chat, from: chat, body: '', media: 'file', fromMe: true }, io);
  ok(pauseUntil(chat) > soon + 3000e3, 'operator speaking again refills the window');
  eq(JSON.stringify(historyOf(chat, 1)[0]), JSON.stringify({ role: 'operator', content: '[file]' }), 'operator non-text is a type placeholder');

  // 7c) 转人工话术的回显同样不算接管
  const chat2 = 'c7c@s.whatsapp.net'; const io2 = makeIo();
  await handleIncoming({ id: '7c-q', chat: chat2, from: chat2, body: 'real person please' }, io2);
  setPause(chat2, 0);                                     // 让窗口先失效，看回显会不会把它再打开
  await handleIncoming({ id: `sent-${sentSeq}`, chat: chat2, from: chat2, body: CFG.handoffText, fromMe: true }, io2);
  eq(pauseUntil(chat2), 0, 'echo of the handoff text is not a takeover');
  eq(roles(chat2), 'user,assistant', 'handoff text echo is not logged twice');

  // 7d) 进程重启后迟到的回显仍能识别（新模块实例 = 新进程的内存状态，只剩库里的记录）
  const fresh = await import('../src/lib.mjs?restart');
  const chat3 = 'c7d@s.whatsapp.net'; const io3 = makeIo();
  await handleIncoming({ id: '7d-q', chat: chat3, from: chat3, body: 'Q7d' }, io3);
  await fresh.handleIncoming({ id: `sent-${sentSeq}`, chat: chat3, from: chat3, body: 'echo:Q7d', fromMe: true }, io3);
  eq(pauseUntil(chat3), 0, 'late echo after restart is not a takeover');

  // 7e) 转人工期结束后：发给模型的历史里运营发言映射为 assistant
  setPause(chat, 0);
  await handleIncoming({ id: '7-q3', chat, from: chat, body: 'one more question' }, io);
  const sentToLlm = calls.at(-1);
  ok(sentToLlm.some(m => m.role === 'assistant' && m.content === 'on it, I will take over'), `operator message goes to the model as assistant: ${JSON.stringify(sentToLlm)}`);
  ok(!sentToLlm.some(m => m.role === 'operator'), 'operator role must never reach the model');
}

/* 8) 传输层没返回发送 id：必须吵出来（否则回显会被静默当成运营接管，每条都误转人工） */
{
  const chat = 'c8@s.whatsapp.net';
  const io = makeIo(); io.send = async t => { io.sent.push(t); };   // 接错的传输层：不返回 id
  const warned = []; const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try { await handleIncoming({ id: '8-q', chat, from: chat, body: 'Q8' }, io); } finally { console.warn = warn; }
  eq(io.sent.join('|'), 'echo:Q8', 'still replies without an id');
  ok(warned.some(w => w.includes('[send]') && w.includes(chat)), `missing id must warn: ${JSON.stringify(warned)}`);
}

llm.closeAllConnections();   // fetch 是 keep-alive，不关连接脚本退不出去
llm.close();
