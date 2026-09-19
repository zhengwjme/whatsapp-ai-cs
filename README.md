# WhatsApp AI Customer Service

An AI assistant that answers customers on a WhatsApp number. When a customer messages the number, the bot replies automatically using an AI model. If it can't answer, or the customer asks for a person, it hands the chat to your team and stays quiet in that chat so a human can take over in WhatsApp.

- Runs on a normal Windows PC with Node.js. No Docker or other bot platform needed.
- Works with any OpenAI-compatible AI model (DeepSeek, OpenAI, a local Ollama model, and others).
- Everything is stored locally in the `data\` folder.

---

## What customers experience

| Time | Customer sees | Behind the scenes |
|---|---|---|
| 0 s | Message sent | The bot receives it. Duplicates are ignored. |
| ~1 s | "typing…" | The bot sends the last 12 messages of the chat to the AI model. |
| 3–8 s | A full reply | The bot waits a little, based on reply length (max 6 s), then sends the reply. |

The short delay is deliberate. Instant replies look robotic and are more likely to be flagged by WhatsApp.

## When the bot hands a chat to a human

A chat is handed to a human when any of these happens:

1. **The customer asks for a person.** Their message contains one of the phrases in `PAUSE_KEYWORD` (default: `speak to a human`, `real person`, `human agent`, `speak to someone`, `talk to someone`).
2. **The bot can't answer.** The AI model says it can't answer (any part it *can* answer is sent first), or the model call fails or times out.
3. **The customer sends something the bot can't read**, such as a voice note, or a picture, video or file without a caption. Stickers and reactions are ignored.
4. **Someone on your team replies in the chat.** Any message your team sends from the phone (or another linked device) counts as taking over. No command is needed.

In cases 1–3, the bot sends the handoff message (`HANDOFF_TEXT`) to the customer.

After a handoff, the bot **stays quiet in that chat for 12 hours** (`PAUSE_HOURS`). It still records messages, so when it takes over again it knows what was said. The 12 hours restart whenever the customer asks for a person again or your team sends another message. If the handoff message itself fails to send, the chat is *not* silenced, so the customer is never left without an answer.

To restart auto-replies for one customer straight away, the `pause` row for that chat has to be deleted from `data\bot.db` (ask whoever set the bot up).

---

## Setup (Windows, about 20 minutes)

### 1. Install Node.js

Download and install Node.js 24 LTS from <https://nodejs.org>. Then open **PowerShell** and check:

```powershell
node -v        # must be v22.13 or newer
```

### 2. Download the project and install

```powershell
cd C:\whatsapp-ai-cs
npm install
```

### 3. Configure

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill in at least `OPENAI_API_KEY` and `WHATSAPP_PHONE`, then save. In Notepad, choose **Save As → Encoding: UTF-8**. All settings are explained in `.env.example` and in the [Settings](#settings-env) table below.

### 4. Try it without a phone

```powershell
npm run sim
```

Chat with the bot in the terminal as if you were a customer. Check that the answers are correct and in the right tone, and type `speak to a human` to test the handoff. Type `exit` to quit.

### 5. Log in and start

```powershell
npm start
```

The first time, the terminal shows an 8-character pairing code. On the phone, open **WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead** and enter the code. If `WHATSAPP_PHONE` is empty, a QR code is shown instead. Scan it from the same menu.

When you see `Connected to WhatsApp, auto-reply is running`, the bot is live. Keep the window open.

### 6. Start automatically when Windows starts

```powershell
schtasks /create /tn WhatsAppBot /tr "cmd /c cd /d C:\whatsapp-ai-cs && npm start" /sc onlogon /f
```

---

## Settings (`.env`)

| Setting | Required | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | yes | API key for the AI model (any non-empty value for local Ollama) |
| `OPENAI_BASE_URL` | | Default `https://api.deepseek.com/v1`. Local Ollama: `http://localhost:11434/v1` |
| `OPENAI_MODEL` | | Default `deepseek-chat` |
| `SYSTEM_PROMPT` | | Who the bot is, what it knows, what it must not say. **Put product facts here, or the bot will hand off instead of answering.** |
| `HANDOFF_TEXT` | | Message sent to the customer on handoff |
| `WHATSAPP_PHONE` | recommended | Your number, country code first, no `+` (e.g. `447700900123`). Enables pairing-code login. |
| `PAUSE_KEYWORD` | | Phrases that mean "I want a person", comma-separated, case-insensitive |
| `PAUSE_HOURS` | | Hours the bot stays quiet after a handoff. Default 12 |
| `HISTORY_TURNS` | | Recent messages sent to the model. Default 12 (a question and an answer count as 2) |
| `LLM_TIMEOUT_MS` | | Model timeout in milliseconds. Default 30000. A timeout counts as "can't answer". |
| `REPLY_GROUPS` | | `true` to also reply in group chats. Default `false` |
| `DEBUG` | | `1` adds stack traces to error logs |
| `DATA_DIR` | | Where data is stored. Default `./data` |
| `ADMIN_PORT` | | Port of the admin page (http://127.0.0.1:PORT, this computer only). Default 3000 |

After changing `.env`, close the bot window and run `npm start` again.

### Editing what the bot says

Everything the bot says comes from `SYSTEM_PROMPT`. Two rules:

- **Only state facts you are sure of.** Anything not in the prompt (prices, stock, return periods, delivery to a specific postcode), the bot is told to hand off rather than guess.
- **Keep the `[[HANDOFF]]` instruction.** When the model can't answer, it ends its reply with this marker, and that is what actually hands the chat to a human. The marker is never shown to the customer. Without it, the model might write "let me transfer you" but nobody would be told.

### Handoff phrases

Use phrases, not single words. `human` on its own would match "humane", and `agent` on its own would match "travel agent", which would silence a normal customer for 12 hours.

---

## Daily routine

| How often | What to do | Good if |
|---|---|---|
| Daily | Reply to every chat that received the handoff message | Every handed-off customer gets a reply from your team |
| Daily | Check the bot is alive: message it from another number | It replies within 3–8 seconds |
| Weekly | Read 10 random bot replies | No invented prices, dates or policies. If there are, tighten `SYSTEM_PROMPT` |
| Monthly | Check the AI model bill and copy the `data\` folder somewhere safe | Cost within budget, backup made |
| First 48 hours | Run on a spare number and watch closely | No disconnections, no warnings from WhatsApp |

---

## Troubleshooting

| Problem | What to do |
|---|---|
| A customer says the bot didn't reply | The chat is probably in its 12-hour handoff window. Reply yourself. |
| The bot stopped replying to everyone | Message it from a test number. If there's no reply, restart it (`npm start`) and keep a screenshot of any error in the window. |
| The bot says wrong things | Screenshot it and correct or add the fact in `SYSTEM_PROMPT` |
| A customer asked for a person but the bot kept replying | Reply yourself (this also stops the bot), then add their wording to `PAUSE_KEYWORD` |
| Pairing code keeps failing | Check the number format (country code first, no `+`). Too many requests in a short time are rate-limited, so wait a few minutes. |
| `LLM 401` or `LLM 404` in the log | Wrong API key or model name. `OPENAI_BASE_URL` must not end with `/chat/completions`. |
| `node:sqlite` not found | Node.js is older than 22.13. Install Node.js 24. |
| Phone shows "logged out from another device" | **Stop using that number immediately.** Delete `data\baileys-auth` and log in again. Check nobody was sending bulk messages. |

---

## Risks

- This uses an **unofficial WhatsApp protocol** (Baileys / WhatsApp Web multi-device). It breaks WhatsApp's terms of service, and **a banned number cannot be appealed**. Use a spare number.
- **Never send bulk or unsolicited messages.** The bot only answers customers who message first.
- Customer messages are sent to the AI provider you configure. If that is not acceptable, use a local Ollama model.
- For high volume or strict compliance, move to the official WhatsApp Business Cloud API.

---

## For developers

| Command | What it does |
|---|---|
| `npm start` | Log in (first run) and run the bot |
| `npm test` | Unit tests and an offline end-to-end test with a fake AI model (`node --test`) |
| `npm run sim` | Terminal chat simulator using the real model and prompt |

```
.
├── src/
│   ├── lib.mjs          Core: filtering, dedup, context, AI call, handoff
│   ├── bot.mjs          WhatsApp connection (Baileys)
│   ├── admin.mjs        Admin page server (localhost only) + admin.html
│   └── normalize.mjs    Raw WhatsApp message → core message
├── scripts/sim.mjs      Terminal simulator
├── test/                node --test suites
├── docs/adr/            Architecture decisions
├── .env.example         All settings
└── data/                Created at runtime: bot.db (chats) + baileys-auth/ (login)
```

Dependencies: `baileys` (MIT; its dependency libsignal is GPLv3) and `qrcode-terminal` (Apache-2.0). Check libsignal's copyleft terms before distributing this as a closed-source product.
