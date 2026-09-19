/** 纯逻辑单测：过滤 / 关键词边界 / 标记拆分 / 延迟 / 环境变量兜底 / 上下文顺序。数据落在 data/test-lib */
import { rmSync } from 'node:fs';
import { strictEqual as eq, ok } from 'node:assert';

process.env.DATA_DIR = './data/test-lib';
rmSync('./data/test-lib', { recursive: true, force: true });
const { CFG, HANDOFF_MARK, shouldReply, wantsHuman, splitHandoff, typingDelay, num, saveMsg, historyOf } = await import('../src/lib.mjs');

eq(shouldReply({ from: '8613@s.whatsapp.net', body: 'hi' }), true);
eq(shouldReply({ from: '8613@s.whatsapp.net', body: 'hi', fromMe: true }), true);   // 可能是运营接管，交给 run
eq(shouldReply({ from: '123@g.us', body: 'hi' }), false);
eq(shouldReply({ from: '123@g.us', body: 'hi' }, { ...CFG, replyGroups: true }), true);
eq(shouldReply({ from: 'status@broadcast', body: 'x' }), false);
eq(shouldReply({ from: 'a@s.whatsapp.net', body: '   ' }), false);
eq(shouldReply({ from: 'a@s.whatsapp.net', body: '', media: 'voice' }), true);
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
const c = 'c@s.whatsapp.net';
saveMsg(c, 'user', 'q1'); saveMsg(c, 'assistant', 'a1');
saveMsg(c, 'user', 'q2'); saveMsg(c, 'assistant', 'a2');
eq(historyOf(c, 12).map(m => m.role).join(','), 'user,assistant,user,assistant');
eq(historyOf(c, 2).map(m => m.role).join(','), 'user,assistant');
