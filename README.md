# WhatsApp AI 客服（个人号版）

用你自己的一张 WhatsApp 号做 AI 客服：扫码/配对码登录，客户来消息自动回复，答不上来转人工。
**不依赖任何第三方机器人平台，不装 Docker 也能跑。**

```
客户 WhatsApp  ⇄  Baileys 协议  ⇄  node bot-baileys.mjs  ⇄  任意 OpenAI 兼容 LLM
                                        └─ lib.mjs：过滤 · 去重 · 上下文 · 转人工 · 拟人延迟
```

- 语言/运行时：Node ≥ 22.5（内置 `node:sqlite`，零框架）
- 依赖：`baileys` + `qrcode-terminal`（共 2 个）
- 数据：全部落在本机 `data/`（SQLite + 登录态）

---

## 特性

| 能力 | 说明 |
|---|---|
| 幂等去重 | 按消息 id 落库，传输层重试不会重复回复 |
| 多轮上下文 | 每个客户独立会话，最近 12 轮存 SQLite，重启不丢 |
| 转人工 | 命中「人工 / human」等关键词，该会话暂停 N 小时，只记录不回复 |
| 拟人节奏 | 先出「正在输入」，按回复字数等待后再发送，封顶 6 秒 |
| 不乱回 | 自己发的消息、群聊（可开）、状态广播一律忽略 |
| 模型可换 | OpenAI / DeepSeek / 本地 Ollama / 自建 MaxKB，只改 3 个环境变量 |
| 两种传输 | Baileys 直连（无需 Docker）或 WAHA HTTP（有 Docker 时） |
| 终端模拟器 | `npm run sim` 不用手机就能验模型与话术 |
| 容器化 | 有 Docker 的机器可以一键起 WAHA + bot |

---

## 快速开始

### 路线 A：不装 Docker（推荐，Windows 老版本也可）

```bash
# 1. 装 Node 24（nodejs.org）
node -v                          # 需要 ≥ v22.5

# 2. 装依赖
npm install

# 3. 配置
cp .env.example .env             # 填 OPENAI_API_KEY、WHATSAPP_PHONE
#    Windows: Copy-Item .env.example .env   （用记事本保存为 UTF-8）

# 4. 先在终端验模型和话术，不碰手机
npm run sim

# 5. 登录（终端出 8 位配对码）
npm run login
#    手机：WhatsApp → 设置 → 已关联的设备 → 关联设备 → 改用配对码登录

# 6. 常驻运行
npm run start:baileys
```

开机自启（Windows）：

```powershell
schtasks /create /tn WhatsAppBot /tr "cmd /c cd /d C:\whatsapp-ai-cs && node --env-file-if-exists=.env bot-baileys.mjs" /sc onlogon /f
```

> 老控制台渲染二维码容易糊，**优先用配对码**（`.env` 里填 `WHATSAPP_PHONE`，国家码开头不带 +）。

### 路线 B：有 Docker（WAHA 网关）

```bash
cp .env.example .env && docker compose up -d --build
# 面板 http://localhost:3000 → POST /api/sessions {"name":"default"} → GET /api/screenshot 扫码
curl http://localhost:8787/health        # 应输出 ok
```

---

## 配置（`.env`）

| 变量 | 必填 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | 模型 key（本地 Ollama 填任意非空值） |
| `OPENAI_BASE_URL` | | 默认 `https://api.deepseek.com/v1`；Ollama 用 `http://host.docker.internal:11434/v1` |
| `OPENAI_MODEL` | | 默认 `deepseek-chat` |
| `SYSTEM_PROMPT` | | 客服人设与口径。**产品事实写这里，别让它编** |
| `WHATSAPP_PHONE` | 建议 | 你的号（国家码开头不带 +）。填了用配对码登录，不填出二维码 |
| `PAUSE_KEYWORD` | | 默认 `人工,human,转人工` |
| `PAUSE_HOURS` | | 转人工后暂停多久，默认 12 |
| `HISTORY_TURNS` | | 带几轮上下文，默认 12 |
| `REPLY_GROUPS` | | 群聊是否也回，默认 false |
| `HANDOFF_TEXT` | | 转人工时的回话 |
| `DATA_DIR` | | 默认 `./data`，容器里是 `/data` |
| `PORT` / `WAHA_URL` / `WAHA_API_KEY` / `WAHA_SESSION` | | 仅 WAHA 传输用 |

接自建知识库的写法（改完不用动代码）：

```ini
# MaxKB（注意：它只读最后一条消息，且上下文轮数要在它后台配 dialogue_number）
OPENAI_BASE_URL=http://kb:8080/chat/api/<application_id>
OPENAI_API_KEY=application-xxxxxxxx
# AnythingLLM（model 必须是 workspace slug，不是模型名）
OPENAI_BASE_URL=http://kb:3001/api/v1/openai
# 本地 Ollama
OPENAI_BASE_URL=http://host.docker.internal:11434/v1
OPENAI_API_KEY=ollama
```

---

## 命令

| 命令 | 作用 |
|---|---|
| `npm run sim` | 假客户模拟器：终端里跑完「判定→上下文→LLM→回发」，不用手机 |
| `npm run selftest` | 纯逻辑自检（过滤/关键词/延迟边界） |
| `npm run login` / `npm run start:baileys` | 扫码登录 / 启动（Baileys 直连） |
| `npm start` | 启动 WAHA 传输（需 Docker） |
| `npm run docker` | `docker compose up -d --build` |

---

## 目录结构

```
.
├── lib.mjs              大脑：过滤、去重、上下文、LLM 调用、转人工（两种传输共用）
├── bot-baileys.mjs      传输 A：Baileys 直连（不需要 Docker）
├── bot.mjs              传输 B：WAHA HTTP（需要 Docker）
├── sim.mjs              假客户模拟器
├── Dockerfile           bot 小镜像（node:24-alpine，无 bind mount）
├── docker-compose.yml   WAHA + bot（端口只绑 127.0.0.1，命名卷存数据）
├── .env.example         全部配置项
├── data/                运行时生成：bot.db（会话）+ baileys-auth/（登录态）
└── docs/                调研与决策文档（见下方索引）
```

业务流程图：`docs/whatsapp-ai-cs-flow.html`（自包含，浏览器打开）。

---

## 上线检查表

| 检查 | 命令 / 做法 | 通过标准 |
|---|---|---|
| 逻辑自检 | `npm run selftest` | 输出 `selftest OK` |
| 模型通不通 | `npm run sim` 问一句 | 回答专业、不编造 |
| 上下文生效 | sim 里连问两句相关的 | 第二句能接上第一句 |
| 转人工 | sim 里打「人工」 | 回转人工话术，之后不再自动回 |
| 数据可备份 | 复制 `data/` | 内含 `bot.db` + `baileys-auth/`，带上它换机器免重扫码 |
| 风险控制 | 副号先跑 48 小时 | 无掉线、无异常提示 |

---

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 终端只有 JSON 日志刷屏 | 这版已静音；若仍有，检查是否用了旧版 `bot-baileys.mjs` |
| 配对码一直失败 | 手机号格式要对（国家码开头、不带 `+`）；同一号码短时间反复请求会被限流，等几分钟 |
| 连上了但不回消息 | 先跑 `npm run sim` 确认模型通；再看是否命中过「人工」导致该会话暂停中 |
| 群消息不回 | 设计如此，`REPLY_GROUPS=true` 可开 |
| 报 `LLM 401/404` | key 或模型名错；`OPENAI_BASE_URL` 结尾不要带 `/chat/completions` |
| 报 `node:sqlite` 不存在 | Node 低于 22.5，升级 |
| PowerShell 里 `curl` 行为奇怪 | PS 的 `curl` 是 `Invoke-WebRequest` 别名，用 `curl.exe` 或 `Invoke-RestMethod` |
| 中文日志乱码 | `chcp 65001`，或用 Windows Terminal + PowerShell 7 |
| 想清空某客户上下文 | 删 `data/bot.db` 里对应的 `msg` 记录（或整体删除重来） |

---

## 风险与合规

- **非官方协议**（Baileys / WhatsApp Web 多设备）**违反 WhatsApp 服务条款，封号不可申诉**。请用副号，不要群发、不要冷启动陌生人。
- 客户消息原文会发送到你配置的 LLM 厂商；介意数据外发就换本地 Ollama（回答质量会下降）。
- 本项目不替代官方 Business API。合规要求高、量大时请迁移到官方 Cloud API。

---

## 文档索引（`docs/`）

| 文件 | 内容 |
|---|---|
| `最终方案.md` | **决策文档**：选型理由、落地步骤、升级触发器、成本与风险 |
| `研究记录.md` | 完整调研：候选项目对比、许可证、封号风险、Windows 部署细节 |
| `知识库选型.md` | 要上知识库时看：MaxKB / AnythingLLM / WeKnora / RAGFlow 对比与零代码接法 |
| `WeKnora-MaxKB-智能客服评估.md` | 两家源码级评估 + 对接改造清单（含三个必踩的坑） |
| `maxkb-源码审计.md` | MaxKB 逐层源码审计（证据到行号） |
| `方案补充调研.md` | 第二批方案（whatsmeow / WuzAPI / n8n …）+ 排除清单 |
| `whatsapp-agentkit-调研.md` | 某 GitHub 项目的源码级评估（结论：不采用） |
| `whatsapp-ai-cs-flow.html` / `.workflow.json` | 业务流程图与图源 |

---

## 实测状态

**已验证**：`npm run selftest` 通过；`npm run sim` 端到端跑通（多轮上下文累积、转人工生效且不再调用模型、之后只记录不回复、进程干净退出）；Baileys 通道真连上 WhatsApp（二维码出图、配对码返回真实 8 位码）；WAHA 通道容器化复测（`/health` 200、webhook 立即 200、同 id 只回一次、`healthy`）。

**未验证**：低版本 Windows 本机、真实扫码后的双向收发、你实际选用的模型回答质量、本地 Ollama 路径。

---

## 许可

本项目代码供自用。使用的第三方：`baileys`(MIT，其依赖 libsignal 为 GPLv3，自用无碍)、`qrcode-terminal`(Apache-2.0)。若要对外分发闭源产品，请先评估 libsignal 的 copyleft 义务。
