/**
 * 传输层：Baileys 直连（只要 Node ≥ 22.13，不需要 Docker）。
 *
 * 装依赖：npm install
 * 登录并启动：npm start        （首次终端出二维码，或用 WHATSAPP_PHONE 要配对码）
 * 自检：  node bot-baileys.mjs --selftest
 */
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from 'baileys';
import qrcode from 'qrcode-terminal';
import { join } from 'node:path';
import { strictEqual as eq } from 'node:assert';
import { shouldReply, handleIncoming, selftest, CFG } from './lib.mjs';

if (process.argv.includes('--selftest')) { selftest(); normalizeSelftest(); process.exit(0); }

const AUTH_DIR = join(CFG.dataDir, 'baileys-auth');
let pairingRequested = false;

// 静音 Baileys 的内置 pino 日志，终端只留我们自己的输出（老 Windows 控制台更友好）
const quiet = new Proxy({}, { get: () => () => quiet });

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, printQRInTerminal: false, markOnlineOnConnect: false, logger: quiet,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      if (CFG.phone && !pairingRequested && !sock.authState.creds.registered) {
        pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(CFG.phone);
          console.log(`\n配对码: ${code}\n手机 WhatsApp → 已关联的设备 → 关联设备 → 改用配对码登录 → 输入上面的码\n`);
        } catch (e) { console.error('配对码失败，改用二维码:', e.message); qrcode.generate(qr, { small: true }); }
      } else {
        qrcode.generate(qr, { small: true });
      }
    }
    if (connection === 'open') console.log('已连接 WhatsApp，开始自动回复');
    if (connection === 'close') {
      const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      console.log(loggedOut ? '已被登出，请删除 data/baileys-auth 后重新登录' : '连接断开，5 秒后重连…');
      if (!loggedOut) setTimeout(start, 5000);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    // 运营从手机/其他已关联设备发的消息：在线时是 notify + key.fromMe（离线补推是 append，不处理，同客户消息）。
    // 本号经 sock.sendMessage 发出的回显是 append（emitOwnEvents），到不了这里；万一到了，也会被已发送 id 认出来
    if (type !== 'notify') return;
    for (const m of messages) {
      const msg = normalize(m);
      const { chat } = msg;
      if (!shouldReply(msg)) continue;
      void handleIncoming(msg, {   // 内部已兜住异常，不 await 也不会掀掉进程
        typing: () => sock.sendPresenceUpdate('composing', chat),
        stopTyping: () => sock.sendPresenceUpdate('paused', chat),
        send: async text => (await sock.sendMessage(chat, { text }))?.key?.id,   // 与回显的 m.key.id 同值
      });
    }
  });
}

/** Baileys 原始消息 → 核心 msg。只归一化，不做判断 */
function normalize(m) {
  const chat = m.key.remoteJid;
  const body = m.message?.conversation
    || m.message?.extendedTextMessage?.text
    || m.message?.imageMessage?.caption
    || m.message?.videoMessage?.caption
    || m.message?.documentWithCaptionMessage?.message?.documentMessage?.caption   // 说明文字放进 body
    || '';
  // 非文字类型只归一化、不做判断：有说明文字的按文字走；贴纸、表情回应（stickerMessage / reactionMessage）
  // 既没 body 也没 media，随后被 shouldReply 丢掉
  const mm = m.message || {};
  const media = body ? undefined
    : mm.audioMessage ? 'voice'
    : mm.imageMessage ? 'image'
    : mm.videoMessage || mm.ptvMessage ? 'video'
    : mm.documentMessage || mm.documentWithCaptionMessage ? 'file'
    : undefined;
  return { id: m.key.id, chat, from: chat, body, fromMe: m.key.fromMe, media };
}

/* ---------- 自检：原始消息 → msg 的归一化 ---------- */
function normalizeSelftest() {
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
  console.log('baileys normalize selftest OK');
}

start().catch(e => { console.error('启动失败:', e); process.exit(1); });
