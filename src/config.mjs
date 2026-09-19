/**
 * 管理界面的配置读写。`.env` 是唯一配置来源（见 docs/adr/0002）：
 * 保存 = 整体校验 → 只改对应 `KEY=` 行写回 `.env` → 按启动时同一套规则重算 CFG，立即生效。测试：test/admin.test.mjs
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { CFG, HANDOFF_MARK, loadCfg } from './lib.mjs';

/* 每个可编辑项：界面传来的值 → 写进 .env 的字符串；不合法返回 undefined */
const str = v => (typeof v === 'string' && v.trim() ? v : undefined);
const positive = integer => v => {
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && (!integer || Number.isInteger(n)) ? String(n) : undefined;
};
const bool = v => (v === true || v === 'true' ? 'true' : v === false || v === 'false' ? 'false' : undefined);
const url = v => (str(v) && /^https?:\/\/[^/\s]+/i.test(v.trim()) && URL.canParse(v.trim()) ? v.trim() : undefined);
/** 关键词：非空列表，每个非空、不含逗号（.env 里用逗号分隔） */
const keywords = v => {
  const list = Array.isArray(v) ? v.map(k => (typeof k === 'string' ? k.trim() : '')) : [];
  return list.length && list.every(k => k && !k.includes(',')) ? list.join(',') : undefined;
};
const FIELDS = {
  SYSTEM_PROMPT: str, HANDOFF_TEXT: str, PAUSE_KEYWORD: keywords, PAUSE_HOURS: positive(false),
  HISTORY_TURNS: positive(true), REPLY_GROUPS: bool, OPENAI_BASE_URL: url, OPENAI_API_KEY: str,
  OPENAI_MODEL: str, LLM_TIMEOUT_MS: positive(true),
};

const fieldError = (field, message) => Object.assign(new Error(message), { field });
const mask = key => (!key ? '' : key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : '••••');

/** 当前生效的配置（含默认值）。API Key 只给是否已设置和掩码 */
export const readConfig = () => ({
  SYSTEM_PROMPT: CFG.system, HANDOFF_TEXT: CFG.handoffText, PAUSE_KEYWORD: CFG.pauseKeyword,
  PAUSE_HOURS: CFG.pauseHours, HISTORY_TURNS: CFG.history, REPLY_GROUPS: CFG.replyGroups,
  OPENAI_BASE_URL: CFG.baseUrl, OPENAI_API_KEY: { set: !!CFG.apiKey, masked: mask(CFG.apiKey) },
  OPENAI_MODEL: CFG.model, LLM_TIMEOUT_MS: CFG.llmTimeout,
});

/**
 * 保存界面提交的配置（只处理传来的项；API Key 留空 = 不改）。
 * 任何一项不合法就整体拒绝、`.env` 不动：抛出带 `field` 的错误。
 * 已有的转人工期不受影响：pause 表存的是绝对到期时刻
 * @returns {{warning?: string}}
 */
export function saveConfig(envFile, body) {
  const values = {};
  for (const [key, parse] of Object.entries(FIELDS)) {
    if (!Object.hasOwn(body, key) || (key === 'OPENAI_API_KEY' && !body[key])) continue;
    const v = parse(body[key]);
    if (v === undefined) throw fieldError(key, `invalid value for ${key}`);
    values[key] = v;
  }
  writeEnv(envFile, values);
  Object.assign(process.env, values);
  Object.assign(CFG, loadCfg(process.env));
  return values.SYSTEM_PROMPT?.includes(HANDOFF_MARK) === false
    ? { warning: `SYSTEM_PROMPT does not mention ${HANDOFF_MARK}: the bot will never hand a chat to a human because it cannot answer` }
    : {};
}

/**
 * 把 values 写回 .env：按行找到 `KEY=`（含跨多行的引号值）只换值，保留行尾注释；找不到就追加。
 * 其余行、注释、空行、换行风格（CRLF/LF）、BOM 原样保留。文件不存在就新建。先写临时文件再改名，写一半断电也不坏原文件
 */
export function writeEnv(file, values) {
  let src = '';
  try { src = readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const bom = src.startsWith('\uFEFF') ? '\uFEFF' : '';
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.slice(bom.length).split(/\r?\n/);
  const out = [], done = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*(?:export\s+)?([\w.-]+)\s*=\s*)(.*)$/);
    if (!m) { out.push(lines[i]); continue; }
    const [, head, key, rest] = m;
    let end = i, trailing = rest.match(/\s*#.*$/)?.[0] ?? '';   // 无引号值：# 起是行尾注释
    const q = rest[0];
    if (q === '"' || q === "'" || q === '`') {                 // 引号值可能跨行：找到收尾引号所在行
      let line = rest, close = rest.indexOf(q, 1);
      while (close < 0 && end + 1 < lines.length) { line = lines[++end]; close = line.indexOf(q); }
      if (close >= 0) trailing = line.slice(close + 1); else { end = i; trailing = ''; }
    }
    if (Object.hasOwn(values, key)) {                          // 旧值整段替换
      out.push(head + formatValue(key, values[key], eol) + trailing);
      done.add(key);
    } else out.push(...lines.slice(i, end + 1));               // 别的 key 原样保留（多行值里像 KEY= 的行不能误改）
    i = end;
  }
  const missing = Object.keys(values).filter(k => !done.has(k)).map(k => `${k}=${formatValue(k, values[k], eol)}`);
  if (out.at(-1) === '') out.splice(-1, 0, ...missing); else out.push(...missing, '');
  writeFileSync(`${file}.tmp`, bom + out.join(eol), 'utf8');
  renameSync(`${file}.tmp`, file);
}

/**
 * 值 → .env 里的写法，保证按 Node `--env-file` 的规则读回来一模一样：
 * 普通值原样写；含 #、换行、首尾空白或以引号开头的加引号，多行值真的分行写（记事本里好读）。
 * 默认双引号；值里本来就有 " 或字面 \n（双引号里会被当成换行）时改用单引号/反引号
 */
function formatValue(key, v, eol = '\n') {
  if (!/[#\r\n]|^[\s"'`]|\s$/.test(v)) return v;
  const s = v.replace(/\r\n?/g, '\n');
  const q = !s.includes('"') && !s.includes('\\n') ? '"' : ["'", '`'].find(c => !s.includes(c));
  if (!q) throw fieldError(key, `${key} cannot be written to .env: it contains both ' and \`, plus " or a literal \\n`);
  return q + s.replaceAll('\n', eol) + q;
}
