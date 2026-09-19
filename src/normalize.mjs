/** Baileys 原始消息 → 核心 msg。只归一化，不做判断 */
export function normalize(m) {
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
  const name = m.key.fromMe ? undefined : m.pushName || undefined;   // 客户的 WhatsApp 昵称；运营消息的 pushName 是本号自己
  return { id: m.key.id, chat, from: chat, body, fromMe: m.key.fromMe, media, name };
}
