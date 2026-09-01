# QQ 机器人托管平台（本地版 v0.3）

把 QQ 机器人"变成服务"：**用户注册后，在网页上填自己的 QQ 机器人凭证、AI 配置、人设、规定、特殊词语法，即可增删改查并一键启动/停止自己的机器人**。每个用户的机器人是独立实例（官方 SDK 多实例架构）。

> 状态：本地版 v0.3（运行在自己电脑上，未部署到任何服务器）
> 版本历史：v0.2 SQLite + 密钥加密 + HTTPS ｜ **v0.3 功能对齐单机版（完整指令 + 群规审查）**

## 快速开始

1. 双击 `start.bat`（首次自动安装依赖）
2. 浏览器打开 **http://localhost:3000**（启用 HTTPS 后为 https://localhost:3000）
3. 注册账号 → 登录 → 「＋ 新建机器人」
4. 填写：
   - **机器人名字**、**QQ AppID / AppSecret**（用户自己到 q.qq.com 注册获取）
   - **AI 接口地址 / API Key / 模型**（DeepSeek 等 OpenAI 兼容接口，用户自带 Key）
   - **机器人人设**（角色提示词）、**机器人规定**（群规，AI 严格遵守）
   - **特殊词语法**（触发词 → 动作，见下）
   - **群规审查**（色情关键词自动攻击开关 + 关键词列表）
5. 点「启动」→ 状态变「运行中」→ 用手机 QQ 和机器人聊天

## 完整功能（v0.3 已对齐单机版）

### 内置指令（每个机器人都有）
| 指令 | 作用 |
|---|---|
| `/帮助` | 指令列表 |
| `/重置` | 清空与该用户的对话记忆 |
| `/人格` | 查看当前人设与规定 |
| `/模型` | 查看当前 AI 模型 |
| `/ping` | 状态检查 |
| `/查违规` | AI 审查今天群内消息并公示（仅群聊） |

指令可带斜杠或不带（整条消息恰好是指令词时）；未知 `/xxx` 会提示，不交给 AI 人设。

### 特殊词语法（触发词 → 动作）
| 动作 | 第三个输入框填什么 |
|---|---|
| 固定回复 | 回复文本（原样发出） |
| **交给AI判断** | **给 AI 的提示词**：AI 按该提示词自行判断并回答（如"用户可能涉及辱骂，请判断并严肃警告"） |
| 忽略 | 不填（命中后不回复） |

### 群规审查
- **色情关键词自动攻击**：群内出现关键词自动毒舌警告（每群 5 分钟一次，关键词可自定义）
- **/查违规**：AI 按「色情（重点）/ 违法不实（重点）/ 辱骂 / 广告 / 刷屏 / 其他」审查今天的群消息记录并公示，报告含涉事人、类型、严重度、原话摘要
- 每机器人独立审计账本（`data/audits/<机器人ID>.json`，保留 3 天），对话记忆独立持久化（`data/memories/`）
- 注意：平台默认只推送 `@机器人` 的消息；想覆盖全群，需在手机 QQ 群设置开启「获取群内全部消息」

## 启用 HTTPS（推荐）

双击 `make-cert.bat` 生成自签名证书 → 重启 `start.bat` → 用 **https://localhost:3000** 访问。
浏览器提示"不安全"是自签名证书的正常现象（本机开发用），点"高级 → 继续访问"。上线部署时换成正式证书（Let's Encrypt 等）。

## 安全设计

| 项 | 实现 |
|---|---|
| 存储 | SQLite（Node 内置 node:sqlite，需 Node 24+），文件 `data/db.sqlite` |
| 密钥加密 | 用户的 AppSecret / API Key 用 **AES-256-GCM** 加密后落库，主密钥在 `data/master.key` |
| 密钥隔离 | API **永不返回**密钥原文，只返回 `hasSecret/hasKey`；编辑留空 = 保持原密钥 |
| 密码 | scrypt 加盐哈希 |
| 传输 | 可选 HTTPS（make-cert.bat） |
| 运维 | `POST /api/admin/shutdown` + `X-Admin-Key`（data/admin.key）优雅关闭 |

⚠️ `data/master.key` 丢失将无法解密已存密钥（预期行为，务必不要误删）。正式对外部署前还应加：登录限流、审计日志、数据库备份。

## 目录结构

```
├── start.bat            一键启动（自动装依赖）
├── make-cert.bat        生成 HTTPS 自签名证书
├── server.js            后端 API + HTTPS + 静态页面
├── store.js             SQLite 数据库（含旧 JSON 自动迁移）
├── crypto.js            AES-256-GCM 密钥加密
├── bot-runner.js        多机器人运行器（完整指令/审查/自动攻击）
├── audit.js             群消息审计账本
├── llm.js / memory.js / utils.js
├── public/              前端（登录注册 + 管理面板）
├── data/                db.sqlite、master.key、admin.key、certs/、audits/、memories/
└── test-api.mjs         API 冒烟测试
```

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/register | 注册 |
| POST | /api/login | 登录（返回 token） |
| POST | /api/logout | 退出 |
| GET | /api/me | 当前用户 |
| GET | /api/bots | 我的机器人列表 |
| POST | /api/bots | 新建机器人 |
| PUT | /api/bots/:id | 编辑机器人 |
| DELETE | /api/bots/:id | 删除机器人 |
| POST | /api/bots/:id/start | 启动 |
| POST | /api/bots/:id/stop | 停止 |
| POST | /api/admin/shutdown | 优雅关闭（X-Admin-Key） |

除注册/登录/关闭外均需 `Authorization: Bearer <token>`。

## 路线图

1. ~~SQLite 存储~~ ✅
2. ~~密钥加密存储~~ ✅
3. ~~HTTPS~~ ✅（自签名；正式证书待部署时接入）
4. ~~完整指令 + /查违规 + 色情自动攻击（对齐单机版）~~ ✅ v0.3
5. 登录限流 + 审计日志 + 数据库备份
6. 部署到云服务器（Node 24）+ 正式域名证书

MIT License
