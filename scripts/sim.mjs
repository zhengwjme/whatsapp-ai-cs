/**
 * 假客户模拟器：不接 WhatsApp，直接在终端把「判定 → 上下文 → LLM → 回发」整条链路跑一遍。
 * 用途：第一次配好 .env 后验证 key/模型/提示词，而不用拿手机试。
 * 用法：npm run sim       （退出 Ctrl+C；想要干净历史就删 data/sim）
 */
import { createInterface } from 'node:readline';

process.env.DATA_DIR = process.env.SIM_DATA_DIR || './data/sim';   // 模拟对话单独落库，不污染真实记录
const { CFG, handleIncoming } = await import('../src/lib.mjs');

const chat = `sim-${Date.now().toString(36)}@s.whatsapp.net`;      // 每次运行都是新客户，避免上次的「转人工」残留
let n = 0, out = 0;

const io = {
  typing: async () => process.stdout.write('\n  [typing…]\n'),
  stopTyping: async () => {},
  send: async text => { console.log(`\nBot> ${text}\n`); return `${chat}#out${++out}`; },   // 像真传输层一样返回 id
};

console.log(`Simulated customer chat · model ${CFG.model} · ${CFG.baseUrl}`);
console.log(`Prompt: ${CFG.system.slice(0, 60)}…`);
console.log(`Type "${CFG.pauseKeyword[0]}" to test the handoff; type "exit" to quit.\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'You> ' });
let closed = false;
let chain = Promise.resolve();                      // 串行处理：粘贴多行时不会乱序
rl.on('close', () => { closed = true; });
rl.prompt();

rl.on('line', line => {
  const body = line.trim();
  if (body === 'exit' || closed) return rl.close();
  if (!body) return rl.prompt();
  chain = chain
    .then(async () => {
      // id 必须带上 chat（每轮唯一）：去重表是全库的，id 复用会让第二次运行整条静默
      await handleIncoming({ id: `${chat}#${++n}`, chat, from: chat, body }, io);
      if (!closed) rl.prompt();                      // stdin 已 EOF（管道输入）时不再 prompt
    })
    .catch(e => console.error('[sim]', e.message));  // 必须回写 chain：否则一次出错整条链作废，之后输入全被吞
});
