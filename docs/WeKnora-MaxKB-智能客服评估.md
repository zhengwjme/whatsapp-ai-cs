# WeKnora vs MaxKB：能不能当「WhatsApp 个人号 AI 客服」的大脑

**方法**：两个仓库都 clone 到本地逐层读源码（MaxKB commit `341481bef9` / v2.0.0；WeKnora commit `2514e42`），关键结论我另外用 grep 独立复核过一遍，标 ✅ 的是复核过的。

数据日：2026-09-17。

---

## 0. 结论先说

| 问题 | 答案 |
|---|---|
| 能当知识库大脑吗？ | **都能**。RAG、引用、多轮、FAQ 都齐 |
| 能当「智能客服」全套吗？ | **都不能**。两者的转人工/工单/坐席都是 **0 行代码** ✅复核 |
| 能直接顶掉我那个 bot 吗？ | **都不能**。两家都**没有 WhatsApp 适配器** ✅复核（WeKnora 全仓 grep `whatsapp` 命中 0；MaxKB 的 WECHAT/LARK/DINGTALK/SLACK 只是枚举标记） |
| 接入难度 | **MaxKB 小改**（有 OpenAI 兼容路径，但有 3 个坑）；**WeKnora 中等**（无兼容端点、SSE、要写适配） |
| 你这台老 Windows 能跑吗 | **都有麻**（下面第 5 节），**都没在你机器上实测过** |

一句话：**它们替代的是「LLM + 知识库」那一格，不是 bot**。你现有 `lib.mjs` 的六件事它们一件都不接（收事件、过滤、去重、转人工、拟人延迟、回发）。

---

## 1. 事实对照（源码级）

| 维度 | MaxKB | WeKnora |
|---|---|---|
| 技术栈 | Django 5.2.16 + Python 3.11 + LangChain/LangGraph | Go（2315 文件 / 594k 行）+ Vue3 + Python docreader |
| 许可证 | **GPL-3.0**（强 copyleft，对外分发衍生要开源） | **MIT**（原文明确无附加限制；三方组件无 GPL/AGPL）✅复核 |
| 对外聊天 API | `POST /chat/api/{application_id}/chat/completions` ✅路线存在 | `POST /api/v1/knowledge-chat/{session_id}`、`/agent-chat/{session_id}`（**SSE**） |
| OpenAI 兼容 | ⚠️ **有路径但不是真兼容**：只取 `messages[-1]` ✅复核（`apps/chat/serializers/chat.py:229`），**无 `model` 参数**，历史由服务端读 DB | ❌ **完全没有入站兼容端点** ✅复核（命中项全是出站客户端） |
| 会话隔离 | `chat_id`（UUID，可外部指定）；`chat_user_id` 由 API Key 决定、**外部不可指定** | `session` + **`X-External-User-ID`** → `PrincipalAPIExternalUser` ✅复核（`middleware/auth.go:23`、`types/tenant.go:197-201`）→ **每个访客一个身份，原生支持** |
| 多轮上下文 | 服务端 DB，轮数 = 应用字段 `dialogue_number`（**默认 0 = 不带上下文**）✅复核 | 服务端 DB，`config.yaml` `conversation.max_rounds: 5`，每个 agent 可覆盖 |
| 转人工 / 工单 / 坐席 | ❌ 无 ✅复核 | ❌ 无 ✅复核（`steer.go` 是「运行中人工干预 Agent」，不是客服接管） |
| 渠道 | 网页 `embed.js`；后台渠道枚举无实现 | 网页 embed + 9 家 IM 适配器（企微/微信/飞书/Slack/Telegram/钉钉/QQ/Mattermost/云之家）+ IM webhook 回调；**无 WhatsApp** |
| 引用溯源 | 仅 `show_source=True` 时在会话详情返回，**API 响应不含** | 引用随 assistant 消息落库（`types/chat.go:307`） |
| RAG 底子 | pgvector 硬依赖；自动/QA/表格分段；默认 `text2vec-base-chinese`；100MB 上限 | 10 种检索驱动（含 **sqlite-vec 本地**）；混合检索；重排 6 家；FAQ 独立知识库类型 |
| Agent | ~40 节点工作流 + 函数沙箱 + MCP | ReAct 引擎 + **136 个工具** + MCP 客户端/服务端 |
| 服务端「回复完成」推送 | 无（同步/流式返回） | 无（只能守 SSE 长连接） |

---

## 2. 对接我们现有 bot 的改造清单

### 2.1 MaxKB（小，1–2 小时）

```ini
OPENAI_BASE_URL=http://kb:8080/chat/api/<application_id>
OPENAI_API_KEY=application-xxxxxxxx        # 在应用里生成，形如 application-xxx
```

三个必须处理的坑：

1. **`chat_id` 要稳定** —— 否则每个客户共用一个服务端会话。改 `lib.mjs` 约 8 行：用 `uuid5(NAMESPACE_URL, wa_jid)` 从 WhatsApp JID 派生固定 UUID，作为 `chat_id` 传过去（MaxKB 接受外部指定）。
2. **`dialogue_number` 默认 0** —— 不去后台改成正数，MaxKB 就完全不带上文（它的历史在它自己库里，不看我们发的 `messages`）。
3. **我们发全量 `messages` 是白发的** —— MaxKB 只读最后一条。要么接受（无害，只是浪费带宽），要么这个模式下我们不再拼历史，交给它管。

### 2.2 WeKnora（中，半天）

```bash
KEY=<api-key>
# 每个 WhatsApp 客户建一次会话（或用 X-External-User-ID 免映射）
SID=$(curl -s -X POST http://kb:8080/api/v1/sessions -H "X-API-Key: $KEY" \
      -H 'Content-Type: application/json' -d '{"title":"wa-8613800138000"}' | jq -r .data.id)
# 提问（SSE）
curl -N -X POST "http://kb:8080/api/v1/knowledge-chat/$SID" -H "X-API-Key: $KEY" \
      -H 'Content-Type: application/json' \
      -d '{"query":"退货政策?","knowledge_base_ids":["<kb-id>"],"channel":"api"}'
```

要在 `lib.mjs` 里补的：
- 读 SSE 流并拼完整答案（~20 行，fetch + reader）——**不能边流边发**，WhatsApp 是整条发
- `chat_id ↔ session_id` 映射存进我们现有的 SQLite（或直接用 `X-External-User-ID` 免映射）
- 认证头 `X-API-Key`

---

## 3. 两者的缺口（都要自己补）

| 缺口 | MaxKB | WeKnora |
|---|---|---|
| 转人工 / 工单 | 中（自建，或用工作流 intent 节点兜底） | 中（自建） |
| 引用溯源自定义输出 | 中（要改 `openai_to_response.py`） | 小（引用已落库） |
| 多客户运营后台 | 有（Django admin 那套） | Lite 单空间没有，要上标准版 Docker |
| 按用户限流/去重/防抖 | 小（Node 侧做） | 小（Node 侧做） |
| Agent token 成本控制 | 小 | 小（默认 10 轮 ReAct，要压 `MaxIterations`） |

两家都**没有**的，恰好是我们已经写好的：入站过滤、幂等去重、拟人延迟、转人工关键词暂停、`/health`。

---

## 4. 部署可行性（针对你那台低版本 Windows）

| | MaxKB | WeKnora |
|---|---|---|
| 官方方式 | Docker 一键（镜像内置 **PG17 + pgvector + Redis**） | Docker Compose（一长串服务） |
| 硬依赖 | **pgvector 硬依赖** ✅复核（`installer/init.sql:5` `CREATE EXTENSION "vector"`）→ 换 SQLite/MySQL 不可行；Redis 必需 | 单机标准版要 PG(ParadeDB) + Redis |
| **无 Docker 形态** | 有入口（`python main.py start`）但**官方无文档、无支持**，且要自己装 PG17+pgvector+Redis | **有**：Lite 单二进制（`.env.lite.example`：SQLite + FTS5/sqlite-vec + 内存队列 + 本地存储）✅复核 |
| Windows 上的坑 | 裸跑未验证；torch/sentence-transformers 依赖重 | Lite 需要 CGO；**CI 只出 linux/darwin 纯二进制**，Windows 只有 Wails 桌面安装包（依赖 WebView2）✅复核 |

**给你的判断**：这两条路都比不上你现在的方案省事。真要上知识库，我建议**先在任意一台能跑 Docker 的机器上把它们跑起来验证答题质量**，确认有用之后再纠结部署形态——否则你是在为「可能不需要的能力」付部署成本。

---

## 5. 最终建议

1. **现在**：不动。`lib.mjs` + WAHA/Baileys 继续跑，用 `SYSTEM_PROMPT` 先回答 FAQ。等客户问题真的超出提示词能覆盖的范围，再上知识库。
2. **要上知识库就选 MaxKB**（中文 FAQ 生态好、OpenAI 兼容路径已存在、改造最小），按 §2.1 三个坑改。
3. **WeKnora 更适合的场合**：你以后要多号多租户、要 MIT 许可、要 Agent 工具链（136 工具 + MCP）、要本地 SQLite 形态。它的 `X-External-User-ID` 是这两家里唯一原生支持「每个访客一个身份」的设计。
4. **两者都不解决「转人工」**。你的 `PAUSE_KEYWORD` 逻辑得继续留着，甚至要扩展（转人工后把会话标记、通知你）。

---

## 6. 置信度

| 结论 | 依据 | 置信度 |
|---|---|---|
| MaxKB 兼容端点只取 `messages[-1]`、无 model | 源码 `apps/chat/serializers/chat.py:229` | ✅ 我复核 |
| MaxKB 无转人工/工单 | 全仓 grep 为空 | ✅ 我复核 |
| MaxKB pgvector 硬依赖 | `installer/init.sql:5` | ✅ 我复核 |
| MaxKB 上下文由 `dialogue_number` 控制、默认 0 | `application/models/application.py:69` + `base_generate_human_message_step.py:35` | ✅ 我复核 |
| WeKnora 无入站 OpenAI 兼容端点、无 WhatsApp 适配器、无转人工 | 全仓 grep 为空 | ✅ 我复核 |
| WeKnora `X-External-User-ID` 多访客隔离 | `middleware/auth.go:23`、`types/tenant.go:197-201` | ✅ 我复核 |
| WeKnora Lite 无 Docker 形态 + Windows 只有桌面 exe | `Makefile:267-292`、`.env.lite.example`、`release-lite.yml` CI 矩阵 | ✅ 我复核 |
| 两家许可证 | LICENSE 原文 | ✅ 我复核 |
| **答题质量 / RAG 实际效果** | 未运行任何一方（本机无 Ollama、无 LLM key） | ❌ 未验证 |
| 在你那台低版本 Windows 上的实际可跑性 | 未实测 | ❌ 未验证 |
| WeKnora 官方最低配置 | 官方文档未给量化门槛 | 待确认 |

**下一步（要我做的话）**：在能跑 Docker 的机器上把 MaxKB 拉起来，配一个真实知识库（10 篇产品文档 + 20 条 FAQ），跑 20 个问题看召回与拒答，再决定接不接。需要你的 LLM key。
