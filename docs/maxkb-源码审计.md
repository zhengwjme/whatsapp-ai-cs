# MaxKB 源码审计（能否当 WhatsApp 客服大脑）

仓库 commit `341481bef9` / v2.0.0。以下均为源码实测，未采信 README 宣传。

## 1. 代码结构

Django 5.2.16 + Python 3.11（`pyproject.toml:9`，无 requirements.txt），LangChain 1.x / LangGraph 1.2.6。
- `apps/knowledge/` 知识库：文档解析分段、向量化、检索（`sql/embedding_search.sql`）、同步站点/飞书/语雀
- `apps/application/` 应用与 Agent：`models/application.py` 应用定义、`flow/` 工作流引擎、`chat_pipeline/` 简易 RAG 流水线
- `apps/chat/` 对外会话侧：匿名认证、OpenAI 兼容、embed.js、历史会话
- `apps/users/ system_manage/` 用户、工作空间、权限、对话用户
- `apps/models_provider/impl/*` 模型供应商适配（含 openai/anthropic/deepseek/ollama/vllm 等）
- `apps/tools/` 函数库（沙箱执行+MCP）、`apps/trigger/` 定时/Webhook、`apps/locales/` UI 与语言包（`ui/`）
- 无 `X-Pack` 目录

## 2. 对外 API

根路由 `apps/maxkb/urls/web.py`：`/admin/api/*` 管理面、`/chat/api/*` 对话面（前缀由 `CONFIG.get_chat_path()` 控制）。应用对话端点在 `apps/chat/urls.py`：
- `POST /chat/api/{application_id}/chat/completions` → `views/chat.py:70 OpenAIView`
- `GET /chat/api/open` → `OpenAIView` 旁 `OpenView.open()` 新建会话
- `GET /chat/api/application/profile`、`GET /chat/api/embed`、`POST /chat/api/auth/anonymous`
- 管理面 `apps/application/urls.py`：`workspace/{ws}/application/{id}/chat`、`chat/export`、`chat/{chat_id}/chat_record`

OpenAI 兼容实现：`apps/chat/serializers/chat.py:217 OpenAIChatSerializer.chat` + `apps/common/handle/impl/response/openai_to_response.py:22`。请求参数仅 `messages / chat_id(UUID,可选) / re_chat / stream`（`chat.py:205-214`，无 `model`）。**只取 `messages[-1]`**（`chat.py:229 get_message`），历史由服务端从 DB 取，因此外部机器人自管的 messages 历史会被丢弃——需改用 `chat_id` 续聊。

认证：`Authorization: Bearer application-xxx|agent-xxx`（`common/auth/authenticate.py ChatTokenAuth`，句柄 `handle/impl/application_key.py` 校验 `secret_key`、`is_active`、`expire_time`），且路径 `application_id` 必须等于 token 的应用（`views/chat.py:82`）。密钥生成见 `application/serializers/application_api_key.py:54`。

## 3. 会话隔离

`chat_id` 即隔离键：`OpenAIInstanceSerializer.chat_id` 可传，缺省则 `uuid1()` 新建（`chat.py:239 generate_chat`）。不同 chat_id 各自拥有 `ChatInfo` 与 `ChatRecord`（`application/serializers/chat.py:108`；表 `application_chat` / `application_chat_record`）。多轮上下文由应用字段 `dialogue_number` 决定注入条数（`chat_pipeline/.../base_generate_human_message_step.py:35`），`=0` 即无上下文；老会话最多回读 5 条（`chat.py:521`）。`chat_user_id` 被硬编码为 API Key 的 id（`application_key.py:29`），外部无法指定，多客户共用一个 key 时身份相同——只能用 chat_id 兜住。另有 `ApplicationLongTermMemory` 按 `(application, chat_user_id)` 存长期记忆（`models/application_chat.py`）。

## 4. 客服能力

- 公开链接/嵌入：`ApplicationAccessToken.access_token` + 白名单/认证开关；`GET /chat/api/embed` 下发 `apps/chat/template/embed.js`（`chat/serializers/chat_embed_serializers.py:34`）
- 提问者身份：`Chat.asker`（默认 `{username:'游客'}`）、`ip_address`；前台匿名授信在 `chat_authentication.py`
- **转人工：无**。全仓无工单/坐席/接管逻辑；`转人工` 仅出现在开场白模板（`ui/src/locales/lang/zh-CN/views/application.ts:115`、`ui/src/workflow/common/template.ts:23`）
- 留痕/导出：`ChatRecord` 存问题/答案/details/投票/改进标注；导出接口见 `application/urls.py` 的 `chat/export`；`Application.clean_time` 控制清理
- 引用仅当 `ApplicationAccessToken.show_source=True` 时在会话详情返回 `knowledge_list/paragraph_list`（`application/serializers/application_chat_record.py:156 reset_chat_record`）；**API/OpenAI 响应不含引用**（`openai_to_response.py` 只回 content）

## 5. 知识库 / RAG

格式：pdf/doc(x)/xls(x)/csv/html/zip/md/txt，处理链 `knowledge/serializers/document.py:96 split_handles`。分段：按 Markdown 标题默认规则 + `patterns/limit` 自定义（`common/handle/impl/text/text_split_handle.py:17`、`common/utils/split_model.py`）；QA 模式 `common/handle/impl/qa/md_parse_qa_handle.py`（`## 标题 / 问题 / 答案`）；表格模式 `result/parse_table_handle`。向量：`knowledge/models/knowledge.py:344 VectorField` → pgvector `vector`，检索 SQL `knowledge/sql/embedding_search.sql`、`blend_search.sql`、`keywords_search.sql`（embedding/keywords/blend）；嵌入模型可选，本地默认 `text2vec-base-chinese`；文件上限默认 100MB。问题优化（`problem_optimization`）用 LLM 补全指代。

## 6. Agent / 工作流

约 40 节点 `application/flow/step_node/`（ai_chat、search_knowledge、intent、condition、loop、form、mcp_node、tool_lib_node、application_node 等），编排 `flow/workflow_manage.py`；函数库沙箱执行 `flow/backend/`+`common/utils/tool_code.py`+`installer/sandbox.c`；MCP `flow/backend/sandbox_mcp.py`、`flow/tools.py:397 _initialize_skills`（`langchain-mcp-adapters`）；trigger 支持 webhook/定时。`trigger/models` 等含 `WECHAT/LARK/DINGTALK/SLACK` 标记（`ChatSourceChoices`），仓库内无对应对接实现。

## 7. 部署与资源

镜像 `installer/Dockerfile` 基于 `1panel-dev/maxkb-base:python3.11-pg17.11-20260903`，**内置 PostgreSQL 17（pgvector）+ Redis**，`start-all.sh` 默认 `MAXKB_DB_HOST=127.0.0.1` 本机启动，可改外部。**硬依赖 pgvector**：`init.sql` `CREATE EXTENSION "vector"`，`VectorField` 与 `<=>` 运算；任何"换 SQLite/MySQL"的设想都不可行。裸跑入口存在：`main.py start [web|celery|local_model]` + `apps/manage.py`，依赖 `pyproject.toml`（含 torch、sentence-transformers），Windows 有 torch 源（`pyproject.toml:84-87`）。README 仅给 Docker 与离线包，**无官方非 Docker 文档**。Redis 也是必需（`conf.py get_cache_setting`）。v1→v2 不支持升级（`installer/start-all.sh`）。

## 8. 许可证

`LICENSE` = GPL-3.0，强 copyleft：对外分发衍生需开源。`apps/maxkb/settings/base/web.py:189 edition='CE'`，企业能力用 `is_ee` 标记（如 `common/constants/permission_constants.py:1049`），本地仓库无企业代码；`chat_anonymous_user_token.py` 的 `['PE','EE']` 分支在开源自建下不生效。内部自用不分发无风险，SaaS 转售需评估。

## 9. README 声称 vs 代码

1. "OpenAI 兼容"：端点存在但按 OpenAI 语义传的 **messages 全量历史被丢弃**，且无 `model` 参数——外部自管上下文的调用方必须改造。
2. "无缝嵌入第三方系统"：仅 `embed.js` 网页挂件（token 走 query），**无服务端开放 API/SDK**；README 的"零编码嵌入"指向 UI 组件而非机器人集成。
3. "智能客服"场景宣传：无任何转人工/工单/坐席实现，只有留痕与投票。

## 结论

可用，但不是即插即用，缺口清单：

| 缺口 | 内容 | 工作量 |
|---|---|---|
| 会话映射 | wa_id→chat_id 映射持久化；改造 `lib.mjs` 透传 `chat_id`（现固定发全量 messages） | 小 |
| 上下文一致性 | MaxKB 只认 DB 历史，Node 侧上下文需以 chat_id 为准，`dialogue_number` 必须 >0 | 小 |
| 转人工/工单 | 自建接管状态（关键词/意图节点兜底），或外挂人工 | 中 |
| 引用溯源 | API 通道无引用；需改 `openai_to_response.py` 或在 Node 侧另查会话详情 | 中 |
| 部署 | 需 PG17+pgvector+Redis；Windows 无 Docker 需装 PostgreSQL 17 与 pgvector 并自跑 `python main.py start`（README 未支持，需实测） | 中 |
| 知识库接入 | 后台导入文档即可，无需编码 | 小 |

阻断项排序：先验证 Windows 裸跑 PG+pgvector，再改 Node 调用方式，最后补转人工。
