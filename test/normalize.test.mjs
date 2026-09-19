/** Baileys 原始消息 → 核心 msg 的归一化。数据落在 data/test-normalize */
import { rmSync } from 'node:fs';
import { strictEqual as eq } from 'node:assert';
import { normalize } from '../src/normalize.mjs';

process.env.DATA_DIR = './data/test-normalize';
rmSync('./data/test-normalize', { recursive: true, force: true });
const { shouldReply } = await import('../src/lib.mjs');

const C = '8613@s.whatsapp.net';
const raw = (message, fromMe = false, pushName) => ({ key: { id: 'X1', remoteJid: C, fromMe }, message, pushName });
eq(JSON.stringify(normalize(raw({ conversation: 'hi' }))),
  JSON.stringify({ id: 'X1', chat: C, from: C, body: 'hi', fromMe: false }), 'text message');
eq(normalize(raw({ audioMessage: { ptt: true } })).media, 'voice', 'voice');
eq(normalize(raw({ imageMessage: {} })).media, 'image', 'uncaptioned image');
eq(JSON.stringify(normalize(raw({ imageMessage: { caption: 'how much is this' } })).body), '"how much is this"', 'captioned image counts as text');
eq(normalize(raw({ imageMessage: { caption: 'how much is this' } })).media, undefined, 'captioned image has no media');
eq(normalize(raw({ videoMessage: {} })).media, 'video', 'uncaptioned video');
eq(normalize(raw({ ptvMessage: {} })).media, 'video', 'video note');
eq(normalize(raw({ documentMessage: {} })).media, 'file', 'file');
eq(normalize(raw({ documentWithCaptionMessage: { message: { documentMessage: { caption: 'see attached' } } } })).body, 'see attached', 'captioned file counts as text');
eq(shouldReply(normalize(raw({ stickerMessage: {} }))), false, 'sticker dropped');
eq(shouldReply(normalize(raw({ reactionMessage: { text: '👍' } }))), false, 'reaction dropped');
eq(shouldReply(normalize(raw({ conversation: 'on it, I will take over' }, true))), true, 'operator message passed to core');
eq(normalize(raw({ conversation: 'on it, I will take over' }, true)).fromMe, true, 'keeps fromMe');
eq(normalize(raw({ conversation: 'hi' }, false, 'Jane Smith')).name, 'Jane Smith', 'customer message carries pushName');
eq(normalize(raw({ conversation: 'on it' }, true, 'Shop Owner')).name, undefined, 'operator message carries no name');
