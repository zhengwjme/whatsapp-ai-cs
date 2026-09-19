/**
 * 传输层：Baileys 直连（只要 Node ≥ 22.13，不需要 Docker）。
 *
 * 装依赖：npm install
 * 登录并启动：npm start        （首次终端出二维码，或用 WHATSAPP_PHONE 要配对码）
 */
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from 'baileys';
import qrcode from 'qrcode-terminal';
import { join } from 'node:path';
import { shouldReply, handleIncoming, CFG } from './lib.mjs';
import { normalize } from './normalize.mjs';

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
          console.log(`\nPairing code: ${code}\nOn your phone: WhatsApp → Linked devices → Link a device → Link with phone number instead → enter the code above\n`);
        } catch (e) { console.error('Pairing code failed, falling back to QR code:', e.message); qrcode.generate(qr, { small: true }); }
      } else {
        qrcode.generate(qr, { small: true });
      }
    }
    if (connection === 'open') console.log('Connected to WhatsApp, auto-reply is running');
    if (connection === 'close') {
      const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      console.log(loggedOut ? 'Logged out. Delete data/baileys-auth and log in again' : 'Connection lost, reconnecting in 5 seconds…');
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

start().catch(e => { console.error('Failed to start:', e); process.exit(1); });
