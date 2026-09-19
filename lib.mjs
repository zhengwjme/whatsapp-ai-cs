/**
 * 大脑：与传输方式无关的全部逻辑（判定 / 上下文 / LLM / 去重 / 转人工）。
 * 两种传输复用本文件：
 *   bot.mjs          —— WAHA HTTP（有 Docker 时用）
 *   bot-baileys.mjs  —— Baileys 直连（Windows 装不了 Docker/WSL 时用）
 * 自检：node lib.mjs --selftest        离线端到端：node e2e.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { strictEqual as eq, ok } from 'node:assert';

/** 环境变量兜底：填错/留空时回默认值，别让 NaN 变成「静默不回消息」 */
const num = (v, d) => {
  const n = +v;
  return v === undefined || v === '' || !Number.isFinite(n) || n <= 0 ? d : n;
};

/** 机器人无法回答的约定标记：只有代码和默认 SYSTEM_PROMPT 知道，不做配置项 */
export const HANDOFF_MARK = '[[HANDOFF]]';

export const CFG = {
  dataDir: process.env.DATA_DIR || './data',
  baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
  apiKey: process.env.OPENAI_API_KEY || '',
  model: process.env.OPENAI_MODEL || 'deepseek-chat',
  system: process.env.SYSTEM_PROMPT || `你是客服助手，回答简洁专业。不确定的不要编：能答的部分照常回答，答不上来的在回复末尾附上 ${HANDOFF_MARK}，不要自己说转人工。`,
  replyGroups: process.env.REPLY_GROUPS === 'true',
  history: num(process.env.HISTORY_TURNS, 12),
  pauseKeyword: (process.env.PAUSE_KEYWORD || '人工,转人工,human agent,real person').split(',').map(s => s.trim()).filter(Boolean),
  pauseHours: num(process.env.PAUSE_HOURS, 12),
  llmTimeout: num(process.env.LLM_TIMEOUT_MS, 30000),
  handoffText: process.env.HANDOFF_TEXT || '已为您转接人工，稍后回复您。',
  wahaTimeout: num(process.env.WAHA_TIMEOUT_MS, 15000),   // 仅 WAHA 传输用：HTTP 调用超时
  debug: process.env.DEBUG === '1',                       // 失败日志带调用栈
  phone: process.env.WHATSAPP_PHONE || '',   // Baileys 配对码用（带国家码，无 +）
};

/* ---------- 纯逻辑 ---------- */
const isGroup = jid => jid.endsWith('@g.us');
const isStatus = jid => jid === 'status@broadcast' || jid.endsWith('@broadcast');

/** 是否该由机器人回这条消息 */
export function shouldReply(msg, cfg = CFG) {
  if (!msg || !msg.from || !msg.body?.trim()) return false;
  if (msg.fromMe) return false;                       // 自己发的不回
  if (isStatus(msg.from)) return false;               // 状态/广播
  if (isGroup(msg.from) && !cfg.replyGroups) return false;
  return true;
}

/**
 * 命中转人工关键词：子串、不分大小写。
 * 默认只给词组（`human agent` / `real person`）——**单独一个 `human` 不能放默认值**：
 * "do you sell human hair wigs?" 里 human 是独立单词，词边界也拦不住，会把正常咨询判成要人工，
 * 那个客户就被静默 12 小时。关键词要加就加词组。
 */
export function wantsHuman(body, cfg = CFG) {
  const t = (body || '').toLowerCase();
  return cfg.pauseKeyword.some(k => t.includes(k.toLowerCase()));
}

/** 拆出模型回复里的标记：text 是去掉标记后要发给客户的正文（可能为空） */
export function splitHandoff(reply) {
  return { text: reply.replaceAll(HANDOFF_MARK, '').trim(), handoff: reply.includes(HANDOFF_MARK) };
}

/** 拟人打字延迟：按字数估算，封顶 6s。ponytail: 固定启发式，被限流再调 */
export function typingDelay(text, rand = Math.random) {
  return Math.min(6000, 500 + (text || '').length * 45 + Math.floor(rand() * 700));
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 持久化 ---------- */
mkdirSync(CFG.dataDir, { recursive: true });
const db = new DatabaseSync(join(CFG.dataDir, 'bot.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY, ts INTEGER);      -- 传输层会重试，去重防重复回复
  CREATE TABLE IF NOT EXISTS msg(chat_id TEXT, role TEXT, content TEXT, ts INTEGER);
  CREATE TABLE IF NOT EXISTS pause(chat_id TEXT PRIMARY KEY, until INTEGER);
  CREATE INDEX IF NOT EXISTS idx_msg ON msg(chat_id);                    -- 别让 historyOf 全表扫
`);
// 表会一直长，启动时滚一刀。ponytail: 固定保留期，要长期留档就先导出再删
// 但自检不能有破坏性副作用：`node lib.mjs --selftest` 用的是同一个 DATA_DIR，不许顺手删生产库
if (!process.argv.includes('--selftest')) {
  db.prepare('DELETE FROM seen WHERE ts < ?').run(Date.now() - 30 * 864e5);
  db.prepare('DELETE FROM msg  WHERE ts < ?').run(Date.now() - 180 * 864e5);
}

export const alreadySeen = id =>
  db.prepare('INSERT OR IGNORE INTO seen(id, ts) VALUES(?,?)').run(id, Date.now()).changes === 0;
export const saveMsg = (chat, role, content) =>
  db.prepare('INSERT INTO msg VALUES(?,?,?,?)').run(chat, role, content, Date.now());
/** 最近 n 条。按 rowid（插入顺序）取，不能按 ts：一问一答常落在同一毫秒，ts 排序会把回答排到提问前面 */
export const historyOf = (chat, n) =>
  db.prepare('SELECT role, content FROM msg WHERE chat_id=? ORDER BY rowid DESC LIMIT ?').all(chat, n).reverse();
export const pauseUntil = chat => db.prepare('SELECT until FROM pause WHERE chat_id=?').get(chat)?.until || 0;
export const setPause = (chat, until) =>
  db.prepare('INSERT INTO pause(chat_id, until) VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET until=excluded.until').run(chat, until);

/* ---------- LLM ---------- */
/** 只传会话历史（当前这句在调用前已落库） */
export async function askLLM(chat) {
  const r = await fetch(`${CFG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.apiKey}` },
    body: JSON.stringify({
      model: CFG.model,
      messages: [{ role: 'system', content: CFG.system }, ...historyOf(chat, CFG.history)],
    }),
    signal: AbortSignal.timeout(CFG.llmTimeout),      // 上游挂住不能把客户一直晾着
  });
  if (!r.ok) throw new Error(`LLM ${r.status} ${await r.text()}`);
  const reply = ((await r.json()).choices?.[0]?.message?.content || '').trim();
  if (!reply) throw new Error('LLM 返回空内容');
  return reply;
}

/* ---------- 主流程（传输无关） ---------- */
const chains = new Map();   // 同客户串行：连发两条时，第二条必须看到第一条的上下文
// ponytail: 队列不设上限——同客户连发 N 条时，最后一条最坏等 N×(LLM 超时 + 6s)。要限流就按 chat 记深度并合并，
// 现在不做：丢客户消息比排队更糟

/**
 * 统一的转人工动作：发话术 → 以机器人身份记入历史 → 开启转人工期。
 * 话术先发出去：发失败就抛出、不开窗口，客户下一条还有机会被回
 */
async function handoff(chat, io) {
  await io.send(CFG.handoffText);
  saveMsg(chat, 'assistant', CFG.handoffText);
  openHandoff(chat);
}

/** 开启或重新计满转人工期：到期时间总是「此刻 + 时长」 */
const openHandoff = chat => setPause(chat, Date.now() + CFG.pauseHours * 3600e3);

async function run(msg, io) {
  const chat = msg.chat;
  if (alreadySeen(msg.id)) return;                     // 幂等
  if (pauseUntil(chat) > Date.now()) {                 // 已转人工，只记不答
    saveMsg(chat, 'user', msg.body);
    if (wantsHuman(msg.body)) openHandoff(chat);       // 再次要求人工：重新计满，话术已发过不再发
    return;
  }

  if (wantsHuman(msg.body)) {
    saveMsg(chat, 'user', msg.body);
    return handoff(chat, io);
  }

  saveMsg(chat, 'user', msg.body);                     // 先落库：LLM 挂掉也不丢客户这句话
  await io.typing();
  try {
    let reply;
    try {
      reply = await askLLM(chat);                      // 先拿回复，再按字数拟人延迟发送
    } catch (e) {                                      // 报错/超时/空内容 = 机器人无法回答，别把客户晾着
      console.error('[llm failed]', chat, CFG.debug ? (e.stack || e.message) : e.message);
      return await handoff(chat, io);
    }
    const { text, handoff: cannotAnswer } = splitHandoff(reply);
    if (text) {
      await sleep(typingDelay(text));
      await io.send(text);
      saveMsg(chat, 'assistant', text);
    }
    if (cannotAnswer) await handoff(chat, io);         // 答上的先发，答不上的交给人
  } finally {
    await io.stopTyping?.().catch(() => {});           // 失败也要收掉「正在输入」
  }
}

/**
 * @param msg {{id: string, chat: string, from: string, body: string, fromMe?: boolean}}
 * @param io  {{send(text): Promise, typing(): Promise, stopTyping?(): Promise}}
 * @returns {Promise<void>} 永不 reject（调用方漏 await 也不会掀掉进程）
 */
export function handleIncoming(msg, io) {
  const prev = chains.get(msg.chat) || Promise.resolve();
  const p = prev
    .then(() => run(msg, io))
    .catch(e => console.error('[reply failed]', msg.chat, CFG.debug ? (e.stack || e.message) : e.message));
  chains.set(msg.chat, p);
  p.then(() => { if (chains.get(msg.chat) === p) chains.delete(msg.chat); });   // 防 map 涨
  return p;
}

/* ---------- 自检 ---------- */
export function selftest() {
  eq(shouldReply({ from: '8613@s.whatsapp.net', body: 'hi' }), true);
  eq(shouldReply({ from: '8613@s.whatsapp.net', body: 'hi', fromMe: true }), false);
  eq(shouldReply({ from: '123@g.us', body: 'hi' }), false);
  eq(shouldReply({ from: '123@g.us', body: 'hi' }, { ...CFG, replyGroups: true }), true);
  eq(shouldReply({ from: 'status@broadcast', body: 'x' }), false);
  eq(shouldReply({ from: 'a@s.whatsapp.net', body: '   ' }), false);
  eq(wantsHuman('我要转人工'), true);
  eq(wantsHuman('what is the price'), false);
  // 转人工关键词不能误伤正常咨询（外贸里 "human hair" 是高频词 → 默认不给裸 human）
  eq(wantsHuman('do you sell human hair wigs?'), false);
  eq(wantsHuman('humanoid robot?'), false);
  eq(wantsHuman('can I talk to a human agent?'), true);
  eq(wantsHuman('I WANT A REAL PERSON'), true);
  eq(wantsHuman('I need a human', { ...CFG, pauseKeyword: ['human'] }), true);   // 想踩坑可以自己加，配置说了算
  eq(JSON.stringify(splitHandoff('hi')), '{"text":"hi","handoff":false}');
  eq(JSON.stringify(splitHandoff(`部分答案\n${HANDOFF_MARK}`)), '{"text":"部分答案","handoff":true}');
  eq(JSON.stringify(splitHandoff(HANDOFF_MARK)), '{"text":"","handoff":true}');
  ok(typingDelay('') < 1300 && typingDelay('x'.repeat(500)) === 6000, 'typing delay bounds');
  // 环境变量填错要回默认值，不能变 NaN
  eq(num('abc', 12), 12);
  eq(num('', 12), 12);
  eq(num('0', 12), 12);
  eq(num('5', 12), 5);
  // 同毫秒的一问一答，历史顺序必须是「先问后答」
  const c = `__selftest__${Date.now()}`;
  try {
    saveMsg(c, 'user', 'q1'); saveMsg(c, 'assistant', 'a1');
    saveMsg(c, 'user', 'q2'); saveMsg(c, 'assistant', 'a2');
    eq(historyOf(c, 12).map(m => m.role).join(','), 'user,assistant,user,assistant');
    eq(historyOf(c, 2).map(m => m.role).join(','), 'user,assistant');
  } finally {
    db.prepare('DELETE FROM msg WHERE chat_id=?').run(c);
  }
  console.log('selftest OK');
}

if (process.argv[1]?.endsWith('lib.mjs') && process.argv.includes('--selftest')) selftest();
