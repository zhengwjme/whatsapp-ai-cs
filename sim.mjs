/**
 * 假客户模拟器：不接 WhatsApp，直接在终端把「判定 → 上下文 → LLM → 回发」整条链路跑一遍。
 * 用途：第一次配好 .env 后验证 key/模型/提示词，而不用拿手机试。
 * 用法：npm run sim       （退出 Ctrl+C；想要干净历史就删 data/sim）
 */
import { createInterface } from 'node:readline';

process.env.DATA_DIR = process.env.SIM_DATA_DIR || './data/sim';   // 模拟对话单独落库，不污染真实记录
const { CFG, handleIncoming } = await import('./lib.mjs');

const chat = `sim-${Date.now().toString(36)}@s.whatsapp.net`;      // 每次运行都是新客户，避免上次的「转人工」残留
let n = 0;

const io = {
  typing: async () => process.stdout.write('\n  [正在输入…]\n'),
  stopTyping: async () => {},
  send: async text => console.log(`\n客服> ${text}\n`),
};

console.log(`模拟客户对话 · 模型 ${CFG.model} · ${CFG.baseUrl}`);
console.log(`提示词：${CFG.system.slice(0, 40)}…`);
console.log(`输入「人工」测试转人工；输入「exit」退出。\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '你> ' });
let closed = false;
let chain = Promise.resolve();                      // 串行处理：粘贴多行时不会乱序
rl.on('close', () => { closed = true; });
rl.prompt();

rl.on('line', line => {
  const body = line.trim();
  if (body === 'exit' || closed) return rl.close();
  if (!body) return rl.prompt();
  chain = chain.then(async () => {
    await handleIncoming({ id: `sim-${++n}`, chat, from: chat, body }, io);
    if (!closed) rl.prompt();                        // stdin 已 EOF（管道输入）时不再 prompt
  });
  chain.catch(e => console.error('[sim]', e.message));
});
