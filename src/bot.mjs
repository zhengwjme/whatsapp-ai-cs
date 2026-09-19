/**
 * 传输层：Baileys 直连（只要 Node ≥ 22.13，不需要 Docker）。
 *
 * 装依赖：npm install
 * 登录并启动：npm start        （首次终端出二维码，或用 WHATSAPP_PHONE 要配对码）
 */
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from 'baileys';
import qrcode from 'qrcode-terminal';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { exec } from 'node:child_process';
import { shouldReply, handleIncoming, CFG } from './lib.mjs';
import { normalize } from './normalize.mjs';
import { startAdmin } from './admin.mjs';

const AUTH_DIR = join(CFG.dataDir, 'baileys-auth');
let pairingRequested = false;
let conn = { state: 'connecting' };   // 连接适配器的当前状态：connecting | open | qr（附 qr 原始串）| loggedOut
let current;                          // 当前这条连接的 socket：重连后换新，管理界面发消息、申请配对码用它
let retry;                            // 断线重连的定时器：重新关联时要取消，免得起两条连接
let relinking;                        // 进行中的重新关联：连点两次只跑一次，否则会起两条连接、重复回复客户

// 静音 Baileys 的内置 pino 日志，终端只留我们自己的输出（老 Windows 控制台更友好）
const quiet = new Proxy({}, { get: () => () => quiet });

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, printQRInTerminal: false, markOnlineOnConnect: false, logger: quiet,
  });

  current = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      conn = { state: 'qr', qr };
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
    if (connection === 'open') {
      conn = { state: 'open' };
      console.log('Connected to WhatsApp, auto-reply is running');
    }
    if (connection === 'close') {
      const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      conn = { state: loggedOut ? 'loggedOut' : 'connecting' };
      console.log(loggedOut ? 'Logged out. Click "Log out and relink" on the admin page, or delete data/baileys-auth and restart' : 'Connection lost, reconnecting in 5 seconds…');
      if (!loggedOut) retry = setTimeout(start, 5000);
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

const adapter = {
  status: () => conn,
  send: async (chat, text) => (await current.sendMessage(chat, { text }))?.key?.id,   // 运营在管理界面回复客户
  pair: phone => current.requestPairingCode(phone),                                  // 管理界面「用号码获取配对码」
  relink: () => (relinking ??= relink().finally(() => { relinking = undefined; })),   // 管理界面「退出并重新关联」
};

/** 退出并重新关联：旧连接的事件一律不再处理（否则关闭会被当成登出/断线，creds 还会写回刚删的目录）→ 登出 → 清登录态 → 重连 */
async function relink() {
  clearTimeout(retry);
  const old = current;
  for (const e of ['connection.update', 'creds.update', 'messages.upsert']) old.ev.removeAllListeners(e);
  await old.logout().catch(() => {});   // 让手机端移除本设备；已登出/未登录时会失败，无所谓
  await old.end(undefined);
  rmSync(AUTH_DIR, { recursive: true, force: true });
  pairingRequested = false;
  conn = { state: 'connecting' };
  console.log('Relinking: logged out, waiting for a new login');
  await start();
}

// 管理界面起不来不影响机器人收发消息
startAdmin({ port: CFG.adminPort, conn: adapter, envFile: '.env' }).then(() => {
  const url = `http://127.0.0.1:${CFG.adminPort}`;
  console.log(`Admin page: ${url}`);
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});                                  // 打不开浏览器就算了，地址已打印
}, e => console.error(e.code === 'EADDRINUSE'
  ? `Admin page not started: port ${CFG.adminPort} is already in use. Set ADMIN_PORT in .env to another port (e.g. 3001) and restart. The bot keeps running.`
  : `Admin page not started: ${e.message}. The bot keeps running.`));
