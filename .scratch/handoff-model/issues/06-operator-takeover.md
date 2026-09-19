# 06: 运营接管

**What to build:** 运营在会话里亲自发任何消息（含非文字消息），即视为运营接管：该消息以“运营”身份记入会话历史（非文字用类型占位），转人工期开启或重新计满，机器人不回复。机器人自己发出消息的回显不算运营发言：发送动作返回消息 id，机器人持久化记录已发送 id（进程重启后仍有效），回显命中即忽略。发给模型时运营发言映射为 `assistant`。README 补充“运营直接回复即接管”。

开工前先查证并写入交付说明：Baileys 中运营从手机/其他已关联设备所发消息以何种事件类型到达；WAHA 发送接口返回的 id 与回显事件 id 格式是否一致；WAHA 回显事件名与订阅方式。若任一传输层拿不到可靠的发送 id，停下找维护者确认，不自行选替代方案。

**Blocked by:** 01, 05

**Status:** done

- [x] 机器人接待期间运营发言：历史中记为运营，会话进入转人工期，机器人不再回复该会话后续客户消息
- [x] 转人工期内运营再次发言，转人工期重新计满
- [x] 运营发非文字消息同样算接管，历史中为类型占位
- [x] 机器人的回复与转人工话术的回显不触发接管，也不重复记入历史
- [x] 已发送 id 记录在进程重启后仍能识别迟到的回显
- [x] 转人工期结束后机器人调用模型时，历史里含运营发言且角色为 `assistant`
- [x] 去重与同一会话串行处理保证不受影响
- [x] 核心行为由 e2e 覆盖（假 `io.send` 返回递增 id）；WAHA 侧由 WAHA e2e 覆盖；交付说明列出 Baileys 真机验证步骤
- [x] 交付说明含三项查证结论

## Comments

### Delivery notes: verification findings

1. **Baileys, operator messages from the phone or other linked devices**: they arrive as a `messages.upsert` event with `type: 'notify'` and `key.fromMe: true` (`lib/Socket/messages-recv.js`, `upsertMessage(msg, offline ? 'append' : 'notify')`). Messages pushed while the bot was offline arrive as `append` and are not handled, same as customer messages. The echo of the bot's own `sock.sendMessage` is an `append` (`emitOwnEvents` defaults to true, `messages-send.js`), so it never reaches the `notify` branch. If it ever does, the sent-id record catches it. `sendMessage` returns `fullMsg` and `key.id` equals the echo's `m.key.id`.
2. **WAHA, sent id vs echo id**: per the docs/OpenAPI, `POST /api/sendText` returns a `WAMessage` whose `id` has the same `{fromMe}_{chat}_{message_id}` format as the event `payload.id`. Offline this rests on the docs only; confirm on a real device.
3. **WAHA, echo event**: `message.any` (fired for every message creation, including our own, with `source: 'api' | 'app'`). The `message` event only covers incoming messages. `docker-compose.yml` now subscribes to `message.any,session.status`. For messages we sent, `from` is our own number and `to` is the chat.

### Real-device verification steps (Baileys and WAHA)

Use a second phone as the customer:
1. Customer asks a normal question and the bot replies. The customer asks again and still gets a reply (the reply's echo must not count as a takeover).
2. The operator replies with text from the business phone. The customer sends another message: no auto-reply. In `data/bot.db`, `msg` has an `operator` row and `pause` has this chat.
3. On a new chat, the operator sends an image/voice note: `msg` records `[图片]`/`[语音]` with role `operator`.
4. Restart the bot, then have the customer send a message on a chat where the bot just replied: it must not be misread as a takeover.
5. **Watch for LID**: check that the `remoteJid` (Baileys) / `to` (WAHA) of the operator's message matches the chat id of the customer's incoming messages (whether one is `@lid` and the other `@s.whatsapp.net`). If they differ, the takeover lands on the wrong chat. Stop and confirm with the maintainer.

### Known limitation (from code review)

If a send actually goes out but the request times out or errors, we never get its id, and that message's echo is misread as an operator takeover. The chat ends up handed off by mistake, erring toward a human. If a transport doesn't return an id at all, the log prints `[send] 传输层没返回消息 id…` (the transport returned no message id); stop and investigate as soon as you see it.
