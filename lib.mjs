/**
 * 大脑：与传输方式无关的全部逻辑（判定 / 上下文 / LLM / 去重 / 转人工）。
 * 两种传输复用本文件：
 *   bot.mjs          —— WAHA HTTP（有 Docker 时用）
 *   bot-baileys.mjs  —— Baileys 直连（Windows 装不了 Docker/WSL 时用）
 * 自检：node lib.mjs --selftest
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { strictEqual as eq, ok } from 'node:assert';

export const CFG = {
  dataDir: process.env.DATA_DIR || './data',
  baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
  apiKey: process.env.OPENAI_API_KEY || '',
  model: process.env.OPENAI_MODEL || 'deepseek-chat',
  system: process.env.SYSTEM_PROMPT || '你是客服助手，回答简洁专业。不确定的不要编，直接说转人工。',
  replyGroups: process.env.REPLY_GROUPS === 'true',
  history: +(process.env.HISTORY_TURNS || 12),
  pauseKeyword: (process.env.PAUSE_KEYWORD || '人工,human').split(',').map(s => s.trim()).filter(Boolean),
  pauseHours: +(process.env.PAUSE_HOURS || 12),
  handoffText: process.env.HANDOFF_TEXT || '已为您转接人工，稍后回复您。',
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

/** 命中转人工关键词 */
export function wantsHuman(body, cfg = CFG) {
  const t = (body || '').toLowerCase();
  return cfg.pauseKeyword.some(k => t.includes(k.toLowerCase()));
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
`);

export const alreadySeen = id =>
  db.prepare('INSERT OR IGNORE INTO seen(id, ts) VALUES(?,?)').run(id, Date.now()).changes === 0;
export const saveMsg = (chat, role, content) =>
  db.prepare('INSERT INTO msg VALUES(?,?,?,?)').run(chat, role, content, Date.now());
export const historyOf = (chat, n) =>
  db.prepare('SELECT role, content FROM msg WHERE chat_id=? ORDER BY ts DESC LIMIT ?').all(chat, n).reverse();
export const pauseUntil = chat => db.prepare('SELECT until FROM pause WHERE chat_id=?').get(chat)?.until || 0;
export const setPause = (chat, until) =>
  db.prepare('INSERT INTO pause(chat_id, until) VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET until=excluded.until').run(chat, until);

/* ---------- LLM ---------- */
export async function askLLM(chat, text) {
  const r = await fetch(`${CFG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.apiKey}` },
    body: JSON.stringify({
      model: CFG.model,
      messages: [{ role: 'system', content: CFG.system }, ...historyOf(chat, CFG.history), { role: 'user', content: text }],
    }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status} ${await r.text()}`);
  return (await r.json()).choices[0].message.content.trim();
}

/* ---------- 主流程（传输无关） ---------- */
/**
 * @param msg {{id: string, chat: string, from: string, body: string, fromMe?: boolean}}
 * @param io  {{send(text): Promise, typing(): Promise, stopTyping?(): Promise}}
 */
export async function handleIncoming(msg, io) {
  const chat = msg.chat;
  if (alreadySeen(msg.id)) return;                     // 幂等
  if (pauseUntil(chat) > Date.now()) return saveMsg(chat, 'user', msg.body);   // 已转人工，只记不答

  if (wantsHuman(msg.body)) {
    setPause(chat, Date.now() + CFG.pauseHours * 3600e3);
    saveMsg(chat, 'user', msg.body);
    return io.send(CFG.handoffText);
  }

  try {
    await io.typing();
    const reply = await askLLM(chat, msg.body);        // 先拿回复，再按字数拟人延迟发送
    await sleep(typingDelay(reply));
    await io.send(reply);
    saveMsg(chat, 'user', msg.body);
    saveMsg(chat, 'assistant', reply);
    await io.stopTyping?.();
  } catch (e) {
    console.error('[reply failed]', chat, e.message);
  }
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
  ok(typingDelay('') < 1300 && typingDelay('x'.repeat(500)) === 6000, 'typing delay bounds');
  console.log('selftest OK');
}

if (process.argv[1]?.endsWith('lib.mjs') && process.argv.includes('--selftest')) selftest();
