/** Baileys 原始消息 → 核心 msg 的归一化。数据落在 data/test-normalize */
import { rmSync } from 'node:fs';
import { strictEqual as eq } from 'node:assert';
import { normalize } from '../src/normalize.mjs';

process.env.DATA_DIR = './data/test-normalize';
rmSync('./data/test-normalize', { recursive: true, force: true });
const { shouldReply } = await import('../src/lib.mjs');

const C = '8613@s.whatsapp.net';
const raw = (message, fromMe = false) => ({ key: { id: 'X1', remoteJid: C, fromMe }, message });
eq(JSON.stringify(normalize(raw({ conversation: 'hi' }))),
  JSON.stringify({ id: 'X1', chat: C, from: C, body: 'hi', fromMe: false }), '文字消息');
eq(normalize(raw({ audioMessage: { ptt: true } })).media, 'voice', '语音');
eq(normalize(raw({ imageMessage: {} })).media, 'image', '无说明图片');
eq(JSON.stringify(normalize(raw({ imageMessage: { caption: '多少钱' } })).body), '"多少钱"', '带说明图片按文字');
eq(normalize(raw({ imageMessage: { caption: '多少钱' } })).media, undefined, '带说明图片不带 media');
eq(normalize(raw({ videoMessage: {} })).media, 'video', '无说明视频');
eq(normalize(raw({ ptvMessage: {} })).media, 'video', '圆形视频');
eq(normalize(raw({ documentMessage: {} })).media, 'file', '文件');
eq(normalize(raw({ documentWithCaptionMessage: { message: { documentMessage: { caption: '看附件' } } } })).body, '看附件', '带说明文件按文字');
eq(shouldReply(normalize(raw({ stickerMessage: {} }))), false, '贴纸丢弃');
eq(shouldReply(normalize(raw({ reactionMessage: { text: '👍' } }))), false, '表情回应丢弃');
eq(shouldReply(normalize(raw({ conversation: '我来跟进' }, true))), true, '运营消息交给核心');
eq(normalize(raw({ conversation: '我来跟进' }, true)).fromMe, true, '保留 fromMe');
