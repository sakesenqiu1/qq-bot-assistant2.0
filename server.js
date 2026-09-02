/**
 * QQ 机器人托管平台 - 后端 API（v0.2）
 * 更新：SQLite 存储（node:sqlite）+ 敏感字段 AES-256-GCM 加密 + 可选 HTTPS
 * 提供：注册/登录、机器人增删改查、启动/停止、前端静态页面
 */
import express from "express";
import https from "node:https";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Users, Bots, Sessions, hashPassword, verifyPassword, genId } from "./store.js";
import { startBot, stopBot, runningCount, defaultBotRecord } from "./bot-runner.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));

// ---------------- 鉴权 ----------------
function auth(req, res, next) {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const session = token ? Sessions.find(token) : null;
  const user = session ? Users.findById(session.user_id) : null;
  if (!session || !user) return res.status(401).json({ error: "未登录或登录已过期" });
  req.user = user;
  req.token = token;
  next();
}

function ownBot(req, res, next) {
  const bot = Bots.find(req.params.id);
  if (!bot) return res.status(404).json({ error: "机器人不存在" });
  if (bot.ownerId !== req.user.id) return res.status(403).json({ error: "无权操作该机器人" });
  req.bot = bot;
  next();
}

// ---------------- 用户 ----------------
app.post("/api/register", (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!/^[\w\u4e00-\u9fa5-]{2,20}$/.test(username)) {
    return res.status(400).json({ error: "用户名需为 2~20 位字母/数字/中文/下划线" });
  }
  if (password.length < 6) return res.status(400).json({ error: "密码至少 6 位" });
  if (Users.findByUsername(username)) return res.status(409).json({ error: "用户名已存在" });
  const user = Users.create(username, hashPassword(password));
  const token = Sessions.create(user.id);
  res.json({ token, username: user.username });
});

app.post("/api/login", (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  const user = Users.findByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "用户名或密码错误" });
  }
  const token = Sessions.create(user.id);
  res.json({ token, username: user.username });
});

app.post("/api/logout", auth, (req, res) => {
  Sessions.remove(req.token);
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ username: req.user.username });
});

// ---------------- 机器人 CRUD ----------------
/** 对外输出：绝不返回密钥原文，只返回"是否已设置" */
function sanitizeBot(b) {
  return {
    id: b.id,
    ownerId: b.ownerId,
    name: b.name,
    enabled: b.enabled,
    status: b.status,
    lastError: b.lastError,
    qq: { appId: b.appId, hasSecret: Boolean(b.appSecretEnc) },
    llm: { baseUrl: b.baseUrl, model: b.model, temperature: b.temperature, hasKey: Boolean(b.apiKeyEnc) },
    persona: b.persona,
    rules: b.rules,
    specialWords: b.specialWords,
    moderation: b.moderation,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

app.get("/api/bots", auth, (req, res) => {
  res.json(Bots.listByOwner(req.user.id).map(sanitizeBot));
});

app.post("/api/bots", auth, (req, res) => {
  const name = String(req.body?.name ?? "").trim() || "我的机器人";
  const record = defaultBotRecord(req.user.id, name);
  record.id = genId();
  record.qq = {
    appId: String(req.body?.qq?.appId ?? "").trim(),
    appSecret: String(req.body?.qq?.appSecret ?? "").trim(),
  };
  record.llm = {
    ...record.llm,
    ...(req.body?.llm ?? {}),
    baseUrl: String(req.body?.llm?.baseUrl ?? record.llm.baseUrl).trim(),
    apiKey: String(req.body?.llm?.apiKey ?? "").trim(),
    model: String(req.body?.llm?.model ?? record.llm.model).trim(),
  };
  if (req.body?.persona !== undefined) record.persona = String(req.body.persona);
  if (req.body?.rules !== undefined) record.rules = String(req.body.rules);
  if (Array.isArray(req.body?.specialWords)) {
    record.specialWords = req.body.specialWords
      .filter((w) => w && String(w.word ?? "").trim())
      .map((w) => ({
        word: String(w.word).trim(),
        action: ["reply", "ai", "ignore"].includes(w.action) ? w.action : "reply",
        reply: String(w.reply ?? ""),
        prompt: String(w.prompt ?? ""),
      }));
  }
  if (req.body?.moderation) {
    record.moderation = {
      enabled: req.body.moderation.enabled !== false,
      autoRebuke: req.body.moderation.autoRebuke !== false,
      cooldownMinutes: 5,
      autoMute: {
        enabled: req.body.moderation.autoMute?.enabled === true,
        level: ["light", "medium", "heavy"].includes(req.body.moderation.autoMute?.level)
          ? req.body.moderation.autoMute.level
          : "light",
        scanIntervalMinutes: (() => {
          const n = Number(req.body.moderation.autoMute?.scanIntervalMinutes);
          return n >= 5 && n <= 1440 ? n : 10;
        })(),
      },
      keywords: Array.isArray(req.body.moderation.keywords)
        ? req.body.moderation.keywords.filter((k) => String(k).trim()).map((k) => String(k).trim())
        : [],
    };
  }
  const bot = Bots.create(record);
  res.json(sanitizeBot(bot));
});

app.put("/api/bots/:id", auth, ownBot, (req, res) => {
  const patch = {};
  if (req.body?.name !== undefined) patch.name = String(req.body.name).trim() || "我的机器人";
  if (req.body?.enabled !== undefined) patch.enabled = Boolean(req.body.enabled);

  const qqPatch = {};
  if (req.body?.qq?.appId !== undefined) qqPatch.appId = String(req.body.qq.appId).trim();
  if (req.body?.qq?.appSecret !== undefined && String(req.body.qq.appSecret).trim() !== "") {
    qqPatch.appSecret = String(req.body.qq.appSecret).trim(); // 留空 = 保持原密钥
  }
  if (Object.keys(qqPatch).length > 0) patch.qq = qqPatch;

  const llmPatch = {};
  if (req.body?.llm?.baseUrl !== undefined && String(req.body.llm.baseUrl).trim() !== "") {
    llmPatch.baseUrl = String(req.body.llm.baseUrl).trim();
  }
  if (req.body?.llm?.apiKey !== undefined && String(req.body.llm.apiKey).trim() !== "") {
    llmPatch.apiKey = String(req.body.llm.apiKey).trim(); // 留空 = 保持原密钥
  }
  if (req.body?.llm?.model !== undefined && String(req.body.llm.model).trim() !== "") {
    llmPatch.model = String(req.body.llm.model).trim();
  }
  if (req.body?.llm?.temperature !== undefined) llmPatch.temperature = Number(req.body.llm.temperature) || 0.7;
  if (Object.keys(llmPatch).length > 0) patch.llm = llmPatch;

  if (req.body?.persona !== undefined) patch.persona = String(req.body.persona);
  if (req.body?.rules !== undefined) patch.rules = String(req.body.rules);
  if (Array.isArray(req.body?.specialWords)) {
    patch.specialWords = req.body.specialWords
      .filter((w) => w && String(w.word ?? "").trim())
      .map((w) => ({
        word: String(w.word).trim(),
        action: ["reply", "ai", "ignore"].includes(w.action) ? w.action : "reply",
        reply: String(w.reply ?? ""),
        prompt: String(w.prompt ?? ""),
      }));
  }
  if (req.body?.moderation) {
    patch.moderation = {
      enabled: req.body.moderation.enabled !== false,
      autoRebuke: req.body.moderation.autoRebuke !== false,
      cooldownMinutes: 5,
      autoMute: {
        enabled: req.body.moderation.autoMute?.enabled === true,
        level: ["light", "medium", "heavy"].includes(req.body.moderation.autoMute?.level)
          ? req.body.moderation.autoMute.level
          : "light",
        scanIntervalMinutes: (() => {
          const n = Number(req.body.moderation.autoMute?.scanIntervalMinutes);
          return n >= 5 && n <= 1440 ? n : 10;
        })(),
      },
      keywords: Array.isArray(req.body.moderation.keywords)
        ? req.body.moderation.keywords.filter((k) => String(k).trim()).map((k) => String(k).trim())
        : [],
    };
  }
  const bot = Bots.update(req.params.id, patch);
  res.json(sanitizeBot(bot));
});

app.delete("/api/bots/:id", auth, ownBot, async (req, res) => {
  await stopBot(req.params.id);
  Bots.remove(req.params.id);
  res.json({ ok: true });
});

// ---------------- 启动 / 停止 ----------------
app.post("/api/bots/:id/start", auth, ownBot, async (req, res) => {
  try {
    const result = await startBot(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

app.post("/api/bots/:id/stop", auth, ownBot, async (req, res) => {
  const result = await stopBot(req.params.id);
  res.json(result);
});

app.get("/api/info", auth, (req, res) => {
  res.json({ runningBots: runningCount(), version: "0.3.0" });
});

// ---------------- 管理：优雅关闭（本机运维/自动化使用） ----------------
const ADMIN_KEY_FILE = path.join(ROOT, "data", "admin.key");
function loadAdminKey() {
  if (existsSync(ADMIN_KEY_FILE)) return readFileSync(ADMIN_KEY_FILE, "utf8").trim();
  const k = crypto.randomBytes(16).toString("hex");
  writeFileSync(ADMIN_KEY_FILE, k + "\n", "utf8");
  return k;
}
const ADMIN_KEY = loadAdminKey();

app.post("/api/admin/shutdown", (req, res) => {
  const provided = String(req.headers["x-admin-key"] ?? "");
  if (provided !== ADMIN_KEY) return res.status(403).json({ error: "拒绝访问" });
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 300);
});
Bots.resetStatuses(); // 启动时把所有机器人的运行状态复位为“已停止”（实例需手动启动）

// ---------------- 启动（HTTP / HTTPS 自适应） ----------------
const certDir = path.join(ROOT, "data", "certs");
const keyFile = path.join(certDir, "server.key");
const crtFile = path.join(certDir, "server.crt");
const useHttps = existsSync(keyFile) && existsSync(crtFile);

function banner() {
  console.log("============================================");
  console.log("  QQ 机器人托管平台（本地版 v0.3）");
  console.log("============================================");
  if (useHttps) {
    console.log(`  ✔ HTTPS 已启用：https://localhost:${PORT}`);
    console.log("  （自签名证书，浏览器提示不安全时点\"高级 → 继续访问\"）");
  } else {
    console.log(`  访问地址：http://localhost:${PORT}`);
    console.log("  提示：运行 make-cert.bat 可启用 HTTPS（推荐）");
  }
  console.log("  存储：SQLite（data/db.sqlite）· 密钥已 AES-256-GCM 加密");
  console.log("  管理密钥：data/admin.key（本机运维用）");
  console.log("  按 Ctrl+C 停止");
  console.log("============================================");
}

if (useHttps) {
  https
    .createServer({ key: readFileSync(keyFile), cert: readFileSync(crtFile) }, app)
    .listen(PORT, banner);
} else {
  app.listen(PORT, banner);
}
