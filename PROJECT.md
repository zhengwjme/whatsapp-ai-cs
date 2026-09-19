# 项目说明

用一张个人 WhatsApp 号做 AI 客服：客户私聊来消息，机器人调用任意 OpenAI 兼容的大模型先自动回复；答不上来（模型输出约定标记 `[[HANDOFF]]`，或调用失败）或客户要求“人工”时，机器人发转人工话术，该会话暂停自动回复，交给运营在 WhatsApp 里人工接手。

## 消息流

```
客户 WhatsApp ⇄ 传输层（Baileys 直连）⇄ bot ⇄ OpenAI 兼容 LLM
                                        └─ lib.mjs：过滤 · 去重 · 上下文 · 转人工 · 拟人延迟
```

## 文件

- `src/lib.mjs`：核心逻辑（消息过滤、按消息 id 去重、SQLite 多轮上下文、转人工暂停、拟人延迟），测试在 `test/`，`npm test`
- `src/bot.mjs`：Baileys 直连传输（`npm start`）；`src/normalize.mjs`：Baileys 消息归一化
- `scripts/sim.mjs`：终端模拟器，不用手机验证模型与话术（`npm run sim`）
- `test/`：`node --test` 单测与离线端到端
- `data/`：SQLite 数据与登录态，全部本地存储

## 技术约束

- Node ≥ 22.13，ESM，零框架；依赖只有 `baileys` 和 `qrcode-terminal`
- 配置全部走 `.env`（模型地址、密钥、`SYSTEM_PROMPT`、转人工关键词等）

部署与运营细节见 `README.md`。
