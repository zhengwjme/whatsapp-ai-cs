/**
 * 离线端到端自检：起一个假 LLM（不联网、不花钱），把传输层之外的整条链路跑一遍。
 * 覆盖：同客户并发串行 · 上下文顺序 · LLM 报错/超时不吃掉消息 · 去重 · 转人工暂停 · io 失败不崩
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

let mode = 'ok';                                          // ok | fail | hang
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
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `echo:${last}` } }] }));
  });
});
await new Promise(r => llm.listen(0, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${llm.address().port}/v1`;

const { CFG, handleIncoming, historyOf, pauseUntil, wantsHuman } = await import('./lib.mjs');
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

/* 3) LLM 500：不崩，且客户这句话仍要落库 */
{
  mode = 'fail';
  const io = makeIo(); const chat = 'c3@s.whatsapp.net';
  await handleIncoming({ id: '3', chat, from: chat, body: 'Q3' }, io);
  eq(io.sent.length, 0, '失败不发送');
  eq(roles(chat), 'user', '失败也要留下用户消息');
  mode = 'ok';
}

/* 4) LLM 挂住：超时按失败走，不把客户一直晾着 */
{
  mode = 'hang';
  const io = makeIo(); const chat = 'c4@s.whatsapp.net';
  const t0 = Date.now();
  await handleIncoming({ id: '4', chat, from: chat, body: 'Q4' }, io);
  const dt = Date.now() - t0;
  ok(dt >= 900 && dt < 5000, `超时后应尽快失败，实际 ${dt}ms`);
  eq(io.sent.length, 0, '超时不发送');
  eq(io.stopped, 1, '超时也要收掉「正在输入」');
  mode = 'ok';
}

/* 5) 转人工：话术发成功才静默；发失败不能把客户晾着 */
{
  // 5a) 话术发不出去 → 不静默，下一条照常回（否则客户既没收到话术、又被晾 12 小时）
  const chat = 'c5@s.whatsapp.net';
  const bad = makeIo();
  bad.send = async () => { throw new Error('WAHA /api/sendText 500'); };
  await handleIncoming({ id: '5', chat, from: chat, body: '我要转人工' }, bad);
  eq(pauseUntil(chat), 0, '话术没发出去就不该静默');
  const io2 = makeIo();
  await handleIncoming({ id: '6', chat, from: chat, body: '在吗' }, io2);
  eq(io2.sent.join('|'), 'echo:在吗', '没静默，下一条要照常回');

  // 5b) 话术发成功 → 暂停，之后只记不答
  const chat2 = 'c5b@s.whatsapp.net';
  const io3 = makeIo();
  await handleIncoming({ id: '7', chat: chat2, from: chat2, body: '我要转人工' }, io3);
  eq(io3.sent.length, 1, '应回一句转接话术');
  ok(pauseUntil(chat2) > Date.now(), '话术发成功才暂停');
  const io4 = makeIo();
  await handleIncoming({ id: '8', chat: chat2, from: chat2, body: '在吗' }, io4);
  eq(io4.sent.length, 0, '暂停期内不回');
  eq(roles(chat2), 'user,user', '暂停期内只记录');
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
