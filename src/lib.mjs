/**
 * 大脑：与传输方式无关的全部逻辑（判定 / 上下文 / LLM / 去重 / 转人工）。
 * 传输层见 bot.mjs（Baileys 直连）。测试：npm test
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 环境变量兜底：填错/留空时回默认值，别让 NaN 变成「静默不回消息」 */
export const num = (v, d) => {
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
  system: process.env.SYSTEM_PROMPT || `You are a customer service assistant for a UK business. Reply in concise, friendly British English; if the customer writes in another language, reply in that language. Answer the question first, then ask about their needs. Never make things up: answer what you can, and if you can't answer something, end your reply with ${HANDOFF_MARK}. Never say you are transferring them yourself.`,
  replyGroups: process.env.REPLY_GROUPS === 'true',
  history: num(process.env.HISTORY_TURNS, 12),
  pauseKeyword: (process.env.PAUSE_KEYWORD || 'speak to a human,real person,human agent,speak to someone,talk to someone').split(',').map(s => s.trim()).filter(Boolean),
  pauseHours: num(process.env.PAUSE_HOURS, 12),
  llmTimeout: num(process.env.LLM_TIMEOUT_MS, 30000),
  handoffText: process.env.HANDOFF_TEXT || "Thanks for your patience. I'm passing you to a member of our team, who'll reply shortly.",
  debug: process.env.DEBUG === '1',                       // 失败日志带调用栈
  phone: process.env.WHATSAPP_PHONE || '',   // Baileys 配对码用（带国家码，无 +）
  adminPort: num(process.env.ADMIN_PORT, 3000),   // 管理界面端口（只绑 127.0.0.1）
};

/* ---------- 纯逻辑 ---------- */
const isGroup = jid => jid.endsWith('@g.us');
const isStatus = jid => jid === 'status@broadcast' || jid.endsWith('@broadcast');

/** 是否交给核心逻辑处理（fromMe 也交：可能是运营接管，由 run 分辨） */
export function shouldReply(msg, cfg = CFG) {
  if (!msg || !msg.from || (!msg.body?.trim() && !msg.media)) return false;   // 贴纸/表情回应：传输层不给 media，落在这里丢掉
  if (isStatus(msg.from)) return false;               // 状态/广播
  if (isGroup(msg.from) && !cfg.replyGroups) return false;
  return true;
}

/**
 * 命中转人工关键词：子串、不分大小写。
 * 默认只给词组（`speak to a human` / `real person` 等）——**单独一个 `human` 不能放默认值**：
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

/** 非文字消息在会话历史里的类型占位：模型看不到内容，但知道那里有一条 */
const MEDIA_LABEL = { voice: '[voice message]', image: '[image]', video: '[video]', file: '[file]' };

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
  CREATE TABLE IF NOT EXISTS sent(id TEXT PRIMARY KEY, ts INTEGER);      -- 机器人发过的消息 id：回显不能当成运营接管，落库防重启后误判
  CREATE INDEX IF NOT EXISTS idx_msg ON msg(chat_id);                    -- 别让 historyOf 全表扫
`);
// 表会一直长，启动时滚一刀。ponytail: 固定保留期，要长期留档就先导出再删
db.prepare('DELETE FROM seen WHERE ts < ?').run(Date.now() - 30 * 864e5);
db.prepare('DELETE FROM sent WHERE ts < ?').run(Date.now() - 30 * 864e5);
db.prepare('DELETE FROM msg  WHERE ts < ?').run(Date.now() - 180 * 864e5);

export const alreadySeen = id =>
  db.prepare('INSERT OR IGNORE INTO seen(id, ts) VALUES(?,?)').run(id, Date.now()).changes === 0;
const markSent = id => db.prepare('INSERT OR IGNORE INTO sent(id, ts) VALUES(?,?)').run(id, Date.now());
const wasSent = id => !!db.prepare('SELECT 1 FROM sent WHERE id=?').get(id);
/** role: user = 客户，assistant = 机器人，operator = 运营 */
export const saveMsg = (chat, role, content) =>
  db.prepare('INSERT INTO msg VALUES(?,?,?,?)').run(chat, role, content, Date.now());
/** 最近 n 条。按 rowid（插入顺序）取，不能按 ts：一问一答常落在同一毫秒，ts 排序会把回答排到提问前面 */
export const historyOf = (chat, n) =>
  db.prepare('SELECT role, content FROM msg WHERE chat_id=? ORDER BY rowid DESC LIMIT ?').all(chat, n).reverse();
/** 管理界面的会话列表：每个会话最后一条消息的摘要和时间、转人工期到期时间，最新的在前 */
export const listChats = () => db.prepare(`
  SELECT m.chat_id AS chat, substr(m.content, 1, 120) AS last, m.ts, COALESCE(p.until, 0) AS until
  FROM msg m JOIN (SELECT MAX(rowid) AS r FROM msg GROUP BY chat_id) l ON m.rowid = l.r
  LEFT JOIN pause p ON p.chat_id = m.chat_id
  ORDER BY m.rowid DESC`).all();
/** 管理界面的历史分页：按插入顺序倒序，before 是上一页最后一条的 id */
export const historyPage = (chat, before = Number.MAX_SAFE_INTEGER, limit = 200) =>
  db.prepare('SELECT rowid AS id, role, content, ts FROM msg WHERE chat_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(chat, before, limit);
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
      messages: [
        { role: 'system', content: CFG.system },
        // 运营发言对客户而言也是「本号说的话」，映射为 assistant 才兼容所有 OpenAI 兼容接口
        ...historyOf(chat, CFG.history).map(m => ({ role: m.role === 'operator' ? 'assistant' : m.role, content: m.content })),
      ],
    }),
    signal: AbortSignal.timeout(CFG.llmTimeout),      // 上游挂住不能把客户一直晾着
  });
  if (!r.ok) throw new Error(`LLM ${r.status} ${await r.text()}`);
  const reply = ((await r.json()).choices?.[0]?.message?.content || '').trim();
  if (!reply) throw new Error('LLM returned empty content');
  return reply;
}

/* ---------- 主流程（传输无关） ---------- */
const chains = new Map();   // 同客户串行：连发两条时，第二条必须看到第一条的上下文
// ponytail: 队列不设上限——同客户连发 N 条时，最后一条最坏等 N×(LLM 超时 + 6s)。要限流就按 chat 记深度并合并，
// 现在不做：丢客户消息比排队更糟

/**
 * 统一的转人工动作：发话术 → 以机器人身份记入历史 → 开启转人工期。
 * 话术先发出去：发失败就抛出、不开窗口，客户下一条还有机会被回。
 * 会话已在转人工期（生成期间被别处转了人工）则 say 作废，窗口也不动
 */
async function handoff(chat, io) {
  if (await say(chat, io, CFG.handoffText)) openHandoff(chat);
}

/**
 * 机器人发言：复查转人工期 → 发出 → 记下发送 id（回显靠它识别）→ 以机器人身份入历史。
 * 复查是因为 LLM 生成和拟人延迟期间，会话可能已被排队之外的动作（如手动转人工）转了人工：
 * 已在转人工期就丢弃这条（不发、不记），返回 false。
 * ponytail: 发送其实成功、但请求超时/报错时拿不到 id，那条的回显会被当成运营接管（该会话误转人工，往安全的方向错）。
 * 真遇到再按「会话 + 内容」短时匹配兜底
 */
async function say(chat, io, text) {
  if (pauseUntil(chat) > Date.now()) return false;
  const id = await io.send(text);
  if (id) markSent(id);
  else console.warn('[send] transport returned no message id; its echo will be treated as an operator takeover', chat);   // 传输层接错了要吵出来
  saveMsg(chat, 'assistant', text);
  return true;
}

/** 开启或重新计满转人工期：到期时间总是「此刻 + 时长」 */
const openHandoff = chat => setPause(chat, Date.now() + CFG.pauseHours * 3600e3);

async function run(msg, io) {
  const chat = msg.chat;
  const content = msg.media ? MEDIA_LABEL[msg.media] : msg.body;
  if (alreadySeen(msg.id)) return;                     // 幂等
  if (msg.fromMe) {                                    // 本号发的：机器人回显忽略，其余是运营接管
    if (wasSent(msg.id)) return;                       // 同会话串行：回显一定排在 say() 记下 id 之后
    saveMsg(chat, 'operator', content);
    return openHandoff(chat);
  }
  if (pauseUntil(chat) > Date.now()) {                 // 已转人工，只记不答
    saveMsg(chat, 'user', content);
    if (wantsHuman(msg.body)) openHandoff(chat);       // 再次要求人工：重新计满，话术已发过不再发
    return;
  }

  if (wantsHuman(msg.body) || msg.media) {             // 客户要求 / 非文字消息（机器人无法回答）
    saveMsg(chat, 'user', content);
    return handoff(chat, io);
  }

  saveMsg(chat, 'user', content);                      // 先落库：LLM 挂掉也不丢客户这句话
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
      await say(chat, io, text);
    }
    if (cannotAnswer) await handoff(chat, io);         // 答上的先发，答不上的交给人
  } finally {
    await io.stopTyping?.().catch(() => {});           // 失败也要收掉「正在输入」
  }
}

/**
 * @param msg {{id: string, chat: string, from: string, body: string, fromMe?: boolean, media?: 'voice'|'image'|'video'|'file'}}
 *   media 只给无说明的非文字消息；带说明的图片/视频由传输层把说明放进 body、不带 media
 * @param io  {{send(text): Promise<string|undefined>, typing(): Promise, stopTyping?(): Promise}}
 *   send 要返回所发消息的 id：本号消息的回显靠它和运营发言区分
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
