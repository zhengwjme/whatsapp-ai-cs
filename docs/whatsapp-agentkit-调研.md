# whatsapp-agentkit 调研（Hainrixz/whatsapp-agentkit）

> 说明：按调研规范本该拆成 4 个文件（原始事实 / 产品 / 工程 / 汇总），这里合成一份，分节标注，方便你一次读完。

## 0. 一句话结论

它**不是一个能跑的 WhatsApp 机器人**，是一个**西班牙语的 Claude Code 提示词包**：让 Claude Code 访谈你 10 个问题，然后**生成**一个 Python 机器人项目。生成的机器人走**官方 Meta Cloud API 或 Zernio（SaaS 平台）**——恰好就是你用不了个人号的那条路。

## 1. 已验证事实（2026-09-17 取数）

| 项 | 值 |
|---|---|
| 仓库 | [Hainrixz/whatsapp-agentkit](https://github.com/Hainrixz/whatsapp-agentkit) |
| ⭐ / fork / issue | 494 / 151 / 10 开放 |
| 授权 | MIT |
| 语言 / 创建 / 最后推送 | Python（实为提示词+脚本）/ 2026-03-18 / 2026-08-19 |
| 作者 | 单人（Enrique Henry），贡献者 1 人 |
| 主页 | hainrixz.github.io/whatsapp-agentkit（落地页） |

**仓库里到底有什么**（全量文件，除 .git）：

```
CLAUDE.md            2155 行 / 80KB   ← 真正的主体：给 Claude Code 的指令系统
scripts/audit.py      879 行          ← 自审脚本（见 §3）
.claude/commands/build-agent.md  55 行 ← /build-agent 斜杠命令
start.sh                             ← 只做环境检查（Python≥3.11、claude CLI）
.env.example  README.md  LICENSE  docs/index.html  knowledge/.gitkeep
```

**没有**：agent 源码、测试、CI、Dockerfile。README 自己讲明了——「不是模板，是让 Claude Code 生成代码的指令系统」。

**生成的产物长这样**（README 明示）：

```
agent/{main,brain,memory,tools}.py
agent/providers/{base,__init__,zernio|meta}.py
config/{business,prompts}.yaml
knowledge/  tests/test_local.py  Dockerfile  docker-compose.yml  .env
```

**工程细节覆盖度**（对 `CLAUDE.md` grep 计数，说明作者确实写了平台规则）：

| 主题 | 命中 | 说明 |
|---|---|---|
| 签名校验 firma/signature | 38 | Meta App Secret / Zernio Webhook Secret |
| 24 小时窗口 + 模板消息 | 10 | 有专章 3.3，明确说窗口外必须用模板 |
| 幂等去重 message_id | 11 | 写在 `memory.py` 职责里 |
| 重试 retry | 11 | |
| sqlite / postgres | 28 | 本地 SQLite，生产 Postgres |
| Railway 部署 | 26 | 部署目标 |
| 媒体/音频处理 | 18 | |
| 终端模拟器 | 9 | `tests/test_local.py`，你在终端扮演客户 |

**它支持的 WhatsApp 接入方式**（就这两种）：
1. **Zernio** —— SaaS，跑在 Meta Cloud API 之上。$3–30/月/号（自己已有 WABA 号码则连接免费，前 2 个账号免费，前 1 万条/月免费）。有 7 天共享号沙箱（50 条/天）可试。
2. **Meta Cloud API** —— 官方，需 Access Token / Phone Number ID / Verify Token / App Secret。

**全仓库 grep：`Baileys` 0 命中，`WhatsApp Web` 0 命中，`unofficial` 0 命中。** 也就是说，它没有任何个人号（非官方协议）路线。

## 2. 对照你的三条硬约束

| 你的约束 | 这个项目 | 依据 |
|---|---|---|
| **个人号**当客服 | ❌ 不支持 | 全仓库无 Baileys/非官方路线；Meta 官方规定：号码必须先**注销 WhatsApp（个人版或商业版）**才能注册 Cloud API；Zernio 同样是 Cloud API 之上的层 |
| **不想用三方服务** | ❌ 至少 4 个供应商 | Zernio 或 Meta、Anthropic（Claude）、Railway（部署）、还要一个**公网 HTTPS 域名**（Fase 5 才配 webhook）。我们那套只有 1 个可换的 LLM |
| **老 Windows、装不了 Docker** | ❌ | `bash start.sh` 要 Git Bash；要 Python 3.11+、Claude Code（要较新 Node）；生成物自带 Dockerfile + compose；webhook 必须公网可达 |

补充一条它自己的限制：**只接 Anthropic/Claude**，不是 OpenAI 兼容 → 接不了本地 Ollama，和你要「不出网」的目标冲突。

## 3. 值得抄的 5 个点

1. **`scripts/audit.py` 的思路（最值得抄）**：因为「产品」是提示词里的代码块，作者就写脚本审计——提示词里的 ```python 块必须能编译、```yaml 必须能解析、CLAUDE.md 里用到的每个环境变量必须在 `.env.example` 里、README 里的链接必须能通、hero 图尺寸要对。**把文档里的代码当代码审**，这个思路很少见。
2. **终端「假客户」模拟器**：`tests/test_local.py` 让你在命令行扮演客户，不接 WhatsApp 也能验话术。我们 `bot.mjs` 现在只有 `--selftest` 测纯逻辑，缺这一层。
3. **provider 分层**（`base.py` + `zernio.py`/`meta.py`）——和我们 `lib.mjs` + `bot.mjs`/`bot-baileys.mjs` 是同一个结构。算是独立验证了我们的方向。
4. **幂等去重写进 memory 层**（按 message_id）——和我们 `alreadySeen()` 一致。
5. **把平台规则写进产品说明**（24 小时窗口、模板消息）而不是让用户踩坑。我们对应要写的是封号风险与发送频率（README §5 已有雏形）。

反过来，它比我们强的一点：**入站签名校验**。我们 bot 现在没有任何入站鉴权（因为 WAHA 在本地环回、不对公网开放）。哪天要暴露公网，这一课得补上。

## 4. 产品视角

- **定位**：LATAM 西语、非程序员、20 分钟访谈式生成器。真身是 **Zernio 的获客漏斗**（CLAUDE.md 里 101 处提到 Zernio，落地页也在 docs/）。
- **增长**：5 个月 494⭐，吃的是 Claude Code skill/命令生态的自然流量；单作者。
- **商业模式**：kit 免费 MIT，钱赚在 Zernio 订阅或作者服务。
- **竞品**：n8n 模板 / Botpress / Typebot 都是「拖拽或付费」，它的差异点是「AI 访谈完直接帮你写代码」——对完全不会编程的西语用户确实有吸引力。
- **风险**：单作者 + 无测试无 CI，唯一质量门是那个 audit.py；强绑 Claude Code 与 Anthropic 定价；生成物没有上游更新通道（升级 = 重新生成）。

## 5. 工程视角

- **架构**：提示词驱动生成 → FastAPI + provider 抽象 + SQLite/Postgres + Claude SDK。设计合理，但**每个用户拿到的是一次性生成的代码**，没有版本升级路径。
- **质量信号**：仓库零测试零 CI；audit.py 只审「提示词块」，不审生成物在真实环境的行为。10 个开放 issue。
- **安全**：有 webhook 签名校验（比我们强）；密钥放 `.env` 且 `.gitignore` 覆盖生成目录（合理）。
- **小瑕疵**：把 `.claude/settings.local.json` 提交进了仓库（本地配置本不该进版本库）。
- **可验证性**：要真正评估生成物质量，需要 Anthropic key + 跑 Claude Code 走完五阶段——**我没做**，所以「生成出来的代码好不好」这条我标为待确认。

## 6. 结论

- **采用？不采用。** 三条硬约束（个人号 / 少三方 / 老 Windows）全部冲突，而且它解决的是「帮不会编程的人从 0 生成」，不是「把已有链路补全」。
- **该抄的**：审计脚本思路、终端假客户模拟器、入站签名校验（若暴露公网）。provider 分层我们已经同构。
- **什么情况下它会变有用**：哪天你愿意走**官方 Cloud API**（正规、不封号、代价是要企业资质 + 一个干净号码 + 按会话付费），这个项目就是现成的加速器，届时可以拿它生成再改造。

## 7. 置信度表

| 说法 | 来源 | 置信度 |
|---|---|---|
| 494⭐ / 151 fork / MIT / 单作者 / 最后推送 2026-08-19 | GitHub API 实时取数 | ✅ |
| 仓库内无 agent 代码，主体是 CLAUDE.md | 已 clone 全量文件清点 | ✅ |
| 不支持个人号/非官方协议 | 全仓库 grep 0 命中 + provider 仅 zernio/meta | ✅ |
| Meta 要求号码先注销 WhatsApp 才能注册 Cloud API | [Meta 官方文档](https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers?locale=zh_CN) | ✅ |
| Zernio 价格（$3–30/月/号、前 2 账号免费、前 1 万条免费） | [Zernio 定价](https://docs.zernio.com/platforms/whatsapp/pricing) | ✅ |
| 生成物的实际代码质量 | 需跑完 Claude Code 五阶段，未执行 | 待确认 |
| 「24 小时窗口/模板」写得好不好 | 只做了关键词与专章定位，未逐字审 | ⚠️ 部分 |
