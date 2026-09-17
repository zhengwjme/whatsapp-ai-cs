/**
 * 传输 B：Baileys 直连（**不需要 Docker / 不需要 WSL**，只要 Node ≥ 22.13）。
 * Windows 版本低装不了 Docker Desktop 时走这条。
 *
 * 装依赖：npm install
 * 登录：  npm run login        （终端出二维码，或用 WHATSAPP_PHONE 要配对码）
 * 启动：  node bot-baileys.mjs
 * 自检：  node bot-baileys.mjs --selftest
 */
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from 'baileys';
import qrcode from 'qrcode-terminal';
import { join } from 'node:path';
import { shouldReply, handleIncoming, selftest, CFG } from './lib.mjs';

if (process.argv.includes('--selftest')) { selftest(); process.exit(0); }

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
    if (type !== 'notify') return;
    for (const m of messages) {
      const chat = m.key.remoteJid;
      const body = m.message?.conversation
        || m.message?.extendedTextMessage?.text
        || m.message?.imageMessage?.caption
        || m.message?.videoMessage?.caption
        || '';
      const msg = { id: m.key.id, chat, from: chat, body, fromMe: m.key.fromMe };
      if (!shouldReply(msg)) continue;
      void handleIncoming(msg, {   // 内部已兜住异常，不 await 也不会掀掉进程
        typing: () => sock.sendPresenceUpdate('composing', chat),
        stopTyping: () => sock.sendPresenceUpdate('paused', chat),
        send: text => sock.sendMessage(chat, { text }),
      });
    }
  });
}

start().catch(e => { console.error('启动失败:', e); process.exit(1); });
