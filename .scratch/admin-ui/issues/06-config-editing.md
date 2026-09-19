# 06: 配置读写

**What to build:** 管理员在配置页用表单修改机器人配置，保存后立即生效、不用重启，并写回 `.env`（`.env` 仍是唯一的配置来源，见 ADR 0002）。可编辑的配置项：`SYSTEM_PROMPT`（多行大输入框）、`HANDOFF_TEXT`、`PAUSE_KEYWORD`、`PAUSE_HOURS`、`HISTORY_TURNS`、`REPLY_GROUPS`、`OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`、`LLM_TIMEOUT_MS`。API Key 只显示掩码，留空表示不改。保存前整体校验，任何一项不合法就整体拒绝并指出是哪一项；`SYSTEM_PROMPT` 不含 `[[HANDOFF]]` 时照常保存，但给出警告。写回时只替换对应 `KEY=` 行的值，找不到就追加，注释和无关行原样保留，UTF-8 读写，多行值按 Node `--env-file` 支持的双引号语法写入；`.env` 不存在就新建。解析规则（关键词拆分、数值兜底）与启动时一致。本票提供的 `.env` 写回能力会被 07 复用。

**Blocked by:** 02

**Status:** ready-for-agent

- [x] 读取配置 API 不返回 API Key 明文
- [x] 保存后 `.env` 对应行被改；注释、空行、无关 key 保留；缺少的 key 被追加
- [x] 多行 `SYSTEM_PROMPT` 和含 `£` 的话术写回后，按 Node 的 `--env-file` 规则重新读出，内容一致
- [x] 保存后立即生效：下一次调用 LLM 用的是新的 `SYSTEM_PROMPT`；新的关键词立即参与判断
- [x] API Key 留空时 `.env` 中的 Key 不变
- [x] 非法值（非正数、非布尔、非 http(s) URL）整体拒绝，返回出错的字段名，`.env` 不被改动
- [x] 缺少 `[[HANDOFF]]` 时保存成功，响应带警告
- [x] 修改 `PAUSE_HOURS` 后，已在转人工期的会话到期时间不变，新开的窗口用新时长
- [ ] 人工验收：Windows 上保存后用记事本打开 `.env`，格式和注释完好，`£` 不乱码；页面显示校验错误和警告
