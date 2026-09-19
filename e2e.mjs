/**
 * 离线端到端自检：起一个假 LLM（不联网、不花钱），把传输层之外的整条链路跑一遍。
 * 覆盖：同客户并发串行 · 上下文顺序 · LLM 报错/超时/空内容即转人工 · 无法回答标记 · 非文字消息转人工 · 去重 · 转人工暂停 · io 失败不崩
 * 用法：npm run e2e        （数据落在 data/e2e，不碰 data/bot.db）
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

const { CFG, HANDOFF_MARK, handleIncoming, historyOf, pauseUntil, setPause, wantsHuman } = await import('./lib.mjs');
eq(CFG.baseUrl, process.env.OPENAI_BASE_URL);

const makeIo = () => {
  const io = { sent: [], typed: 0, stopped: 0 };
  io.typing = async () => { io.typed++; };
  io.stopTyping = async () => { io.stopped++; };
  io.send = async t => { io.sent.push(t); };
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
  eq(io.sent.join('|'), 'echo:Q1|echo:Q2', '回复顺序');
  eq(roles(chat), 'user,assistant,user,assistant', '历史顺序（同毫秒也不能把回答排到提问前）');
  const second = calls[1].map(m => m.content).join(' / ');
  ok(second.includes('Q1') && second.includes('echo:Q1'), `第二次调用要带上下文，实际: ${second}`);
  eq(io.stopped, 2, '每次都要收掉「正在输入」');
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
  eq(historyOf(chat, 2).map(m => m.role).join(','), 'user,assistant', '同毫秒也不能把回答排到提问前');
}

/* 2) 去重：同 id 重推不再回 */
{
  const io = makeIo(); const chat = 'c1@s.whatsapp.net';
  await handleIncoming({ id: '2', chat, from: chat, body: 'Q2' }, io);
  eq(io.sent.length, 0, '重复 id 不能重复回复');
}

/* 3) 模型调用失败即转人工（归为机器人无法回答）：客户收到话术、进入转人工期、这句话不吞 */
const handedOff = (chat, io, what) => {
  eq(io.sent.join('|'), CFG.handoffText, `${what}：客户应收到转人工话术`);
  ok(pauseUntil(chat) > Date.now(), `${what}：应进入转人工期`);
  eq(JSON.stringify(historyOf(chat, 20).map(m => [m.role, m.content])),
    JSON.stringify([['user', `Q-${what}`], ['assistant', CFG.handoffText]]),
    `${what}：历史里依次是客户消息、转人工话术`);
  eq(io.stopped, 1, `${what}：也要收掉「正在输入」`);
};
{
  mode = 'fail';
  const io = makeIo(); const chat = 'c3@s.whatsapp.net';
  await handleIncoming({ id: '3', chat, from: chat, body: 'Q-报错' }, io);
  handedOff(chat, io, '报错');
  mode = 'ok';
}
{
  mode = 'empty';
  const io = makeIo(); const chat = 'c3b@s.whatsapp.net';
  await handleIncoming({ id: '3b', chat, from: chat, body: 'Q-空内容' }, io);
  handedOff(chat, io, '空内容');
  mode = 'ok';
}

/* 4) LLM 挂住：超时按失败走（尽快转人工），不把客户一直晾着 */
{
  mode = 'hang';
  const io = makeIo(); const chat = 'c4@s.whatsapp.net';
  const t0 = Date.now();
  await handleIncoming({ id: '4', chat, from: chat, body: 'Q-超时' }, io);
  const dt = Date.now() - t0;
  ok(dt >= 900 && dt < 5000, `超时后应尽快失败，实际 ${dt}ms`);
  handedOff(chat, io, '超时');
  mode = 'ok';
}

/* 4b) 机器人无法回答：模型附约定标记 → 先发去掉标记的正文，再发话术并转人工；标记不外泄、不入历史 */
{
  mode = 'mark';
  const io = makeIo(); const chat = 'c4b@s.whatsapp.net';
  await handleIncoming({ id: '4b', chat, from: chat, body: 'Q-部分' }, io);
  eq(io.sent.join('|'), `echo:Q-部分|${CFG.handoffText}`, '先正文、再话术');
  ok(pauseUntil(chat) > Date.now(), '带标记应进入转人工期');
  eq(JSON.stringify(historyOf(chat, 20).map(m => [m.role, m.content])),
    JSON.stringify([['user', 'Q-部分'], ['assistant', 'echo:Q-部分'], ['assistant', CFG.handoffText]]),
    '历史：客户消息、正文、话术');
  eq(io.stopped, 1, '带标记也要收掉「正在输入」');

  mode = 'markOnly';
  const io2 = makeIo(); const chat2 = 'c4c@s.whatsapp.net';
  await handleIncoming({ id: '4c', chat: chat2, from: chat2, body: 'Q-只有标记' }, io2);
  eq(io2.sent.join('|'), CFG.handoffText, '只有标记时只发话术');
  ok(pauseUntil(chat2) > Date.now(), '只有标记也应进入转人工期');
  eq(roles(chat2), 'user,assistant', '只有标记：历史只多一条话术');
  mode = 'ok';

  const leaked = [...io.sent, ...io2.sent, ...historyOf(chat, 20).map(m => m.content), ...historyOf(chat2, 20).map(m => m.content)]
    .filter(t => t.includes(HANDOFF_MARK));
  eq(leaked.length, 0, '标记不能发给客户、不能进历史');
}

/* 5) 转人工：话术发成功才静默；发失败不能把客户晾着 */
{
  // 5a) 话术发不出去 → 不静默，下一条照常回（否则客户既没收到话术、又被晾 12 小时）
  const chat = 'c5@s.whatsapp.net';
  const bad = makeIo();
  bad.send = async () => { throw new Error('WAHA /api/sendText 500'); };
  await handleIncoming({ id: '5', chat, from: chat, body: '我要转人工' }, bad);
  eq(pauseUntil(chat), 0, '话术没发出去就不该静默');
  eq(roles(chat), 'user', '话术没发出去就不该记进历史');
  const io2 = makeIo();
  await handleIncoming({ id: '6', chat, from: chat, body: '在吗' }, io2);
  eq(io2.sent.join('|'), 'echo:在吗', '没静默，下一条要照常回');

  // 5b) 话术发成功 → 暂停，之后只记不答
  const chat2 = 'c5b@s.whatsapp.net';
  const io3 = makeIo();
  await handleIncoming({ id: '7', chat: chat2, from: chat2, body: '我要转人工' }, io3);
  eq(io3.sent.join('|'), CFG.handoffText, '应回一句转接话术');
  ok(pauseUntil(chat2) > Date.now(), '话术发成功才暂停');
  eq(JSON.stringify(historyOf(chat2, 20)),
    JSON.stringify([{ role: 'user', content: '我要转人工' }, { role: 'assistant', content: CFG.handoffText }]),
    '历史末尾依次是客户消息、机器人身份的转人工话术');
  const io4 = makeIo();
  await handleIncoming({ id: '8', chat: chat2, from: chat2, body: '在吗' }, io4);
  eq(io4.sent.length, 0, '暂停期内不回');
  eq(roles(chat2), 'user,assistant,user', '转人工期内只记录');

  // 5c) 转人工期内：未命中关键词不动窗口；再次要求人工则从此刻重新计满，且不重发话术、不回复
  const soon = Date.now() + 60e3;                         // 模拟快到期
  setPause(chat2, soon);
  const io5 = makeIo();
  await handleIncoming({ id: '9', chat: chat2, from: chat2, body: '还在吗' }, io5);
  eq(pauseUntil(chat2), soon, '未命中关键词不改变转人工期');
  const t0 = Date.now();
  await handleIncoming({ id: '10', chat: chat2, from: chat2, body: '快给我转人工' }, io5);
  const until = pauseUntil(chat2);
  ok(until >= t0 + 3600e3 && until <= Date.now() + 3600e3, `再次要求人工应重新计满，实际剩 ${until - Date.now()}ms`);
  eq(io5.sent.length, 0, '转人工期内再次要求人工：不重发话术、不回复');
  eq(roles(chat2), 'user,assistant,user,user,user', '转人工期内消息都只记录');
}

/* 5d) 非文字消息（语音/无说明图片/视频/文件）：类型占位记录 → 发话术 → 转人工，不调模型 */
{
  const before = calls.length;
  for (const [media, label] of [['voice', '[语音]'], ['image', '[图片]'], ['video', '[视频]'], ['file', '[文件]']]) {
    const io = makeIo(); const chat = `c5d-${media}@s.whatsapp.net`;
    await handleIncoming({ id: `5d-${media}`, chat, from: chat, body: '', media }, io);
    eq(io.sent.join('|'), CFG.handoffText, `${media}：客户应收到转人工话术`);
    ok(pauseUntil(chat) > Date.now(), `${media}：应进入转人工期`);
    eq(JSON.stringify(historyOf(chat, 20).map(m => [m.role, m.content])),
      JSON.stringify([['user', label], ['assistant', CFG.handoffText]]), `${media}：先占位记录，再记话术`);
  }
  eq(calls.length, before, '非文字消息不调模型');

  // 转人工期内再发非文字：只占位记录
  const chat = 'c5d-voice@s.whatsapp.net'; const io = makeIo();
  await handleIncoming({ id: '5d-again', chat, from: chat, body: '', media: 'image' }, io);
  eq(io.sent.length, 0, '转人工期内非文字消息不回');
  eq(historyOf(chat, 20).at(-1).content, '[图片]', '转人工期内非文字消息只占位记录');
}

/* 6) 关键词：正常咨询不能被当成「找人工」（外贸里 "human hair" 是高频词） */
{
  eq(wantsHuman('do you sell human hair wigs?'), false, 'human hair 不该转人工');
  eq(wantsHuman('humanoid robot?'), false);
  eq(wantsHuman('can I talk to a human agent?'), true);
  eq(wantsHuman('我要转人工'), true);
}

llm.closeAllConnections();   // fetch 是 keep-alive，不关连接脚本退不出去
llm.close();
console.log('e2e OK');
