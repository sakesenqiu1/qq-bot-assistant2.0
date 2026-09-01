/**
 * 用户数据库（SQLite 版，基于 Node 内置 node:sqlite，需 Node 24+）
 * 表结构：
 *   users    用户（用户名、密码哈希）
 *   bots     机器人（QQ凭证/AI配置 的敏感字段加密存储）
 *   sessions 登录会话 token
 * 兼容迁移：首次运行时若存在旧版 data/db.json，自动导入到 SQLite
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { encrypt, decrypt } from "./crypto.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.sqlite");
const OLD_JSON = path.join(DATA_DIR, "db.json");

const db = new DatabaseSync(DB_FILE);
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'stopped',
  last_error TEXT NOT NULL DEFAULT '',
  app_id TEXT NOT NULL DEFAULT '',
  app_secret_enc TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT 'https://api.deepseek.com',
  api_key_enc TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'deepseek-chat',
  temperature REAL NOT NULL DEFAULT 0.7,
  persona TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',
  special_words TEXT NOT NULL DEFAULT '[]',
  moderation TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// 兼容旧版 SQLite 库：补 moderation 列
{
  const cols = db.prepare("PRAGMA table_info(bots)").all().map((c) => c.name);
  if (!cols.includes("moderation")) db.exec("ALTER TABLE bots ADD COLUMN moderation TEXT NOT NULL DEFAULT '{}'");
}
// ---------------- 旧 JSON 数据库自动迁移 ----------------
migrateFromJson();

function migrateFromJson() {
  if (!existsSync(OLD_JSON)) return;
  try {
    const old = JSON.parse(readFileSync(OLD_JSON, "utf8"));
    const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
    const botCount = db.prepare("SELECT COUNT(*) AS c FROM bots").get().c;
    if (userCount === 0 && botCount === 0 && (old.users?.length || old.bots?.length)) {
      const insUser = db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)");
      for (const u of old.users ?? []) insUser.run(u.id, u.username, u.passwordHash, u.createdAt ?? Date.now());
      const insBot = db.prepare(`INSERT OR IGNORE INTO bots
        (id, owner_id, name, enabled, status, last_error, app_id, app_secret_enc, base_url, api_key_enc, model, temperature, persona, rules, special_words, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const b of old.bots ?? []) {
        insBot.run(
          b.id, b.ownerId, b.name ?? "我的机器人", b.enabled !== false ? 1 : 0,
          b.status ?? "stopped", b.lastError ?? "",
          b.qq?.appId ?? "", encrypt(b.qq?.appSecret ?? ""),
          b.llm?.baseUrl ?? "https://api.deepseek.com", encrypt(b.llm?.apiKey ?? ""),
          b.llm?.model ?? "deepseek-chat", Number(b.llm?.temperature ?? 0.7),
          b.persona ?? "", b.rules ?? "",
          JSON.stringify(b.specialWords ?? []),
          b.createdAt ?? Date.now(), b.updatedAt ?? Date.now(),
        );
      }
      const insSess = db.prepare("INSERT OR IGNORE INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)");
      for (const s of old.sessions ?? []) insSess.run(s.token, s.userId, s.createdAt ?? Date.now());
      console.log(`✔ 已从旧版 db.json 迁移：用户 ${old.users?.length ?? 0} 个，机器人 ${old.bots?.length ?? 0} 个`);
    }
    renameSync(OLD_JSON, OLD_JSON + ".migrated");
  } catch (err) {
    console.warn("旧数据迁移失败（跳过）：" + err.message);
  }
}

// ---------------- 行映射 ----------------
function rowToBot(row) {
  if (!row) return null;
  let specialWords = [];
  try { specialWords = JSON.parse(row.special_words ?? "[]"); } catch {}
  let moderation = { enabled: true, autoRebuke: true, cooldownMinutes: 5, keywords: [] };
  try { moderation = { enabled: true, autoRebuke: true, cooldownMinutes: 5, keywords: [], ...JSON.parse(row.moderation ?? "{}") }; } catch {}
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    enabled: Boolean(row.enabled),
    status: row.status,
    lastError: row.last_error,
    appId: row.app_id,
    appSecretEnc: row.app_secret_enc,
    baseUrl: row.base_url,
    apiKeyEnc: row.api_key_enc,
    model: row.model,
    temperature: row.temperature,
    persona: row.persona,
    rules: row.rules,
    specialWords,
    moderation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------- 密码 ----------------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 32).toString("hex");
  return salt + ":" + hash;
}

export function verifyPassword(pw, stored) {
  const parts = String(stored ?? "").split(":");
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  try {
    const calc = crypto.scryptSync(String(pw), salt, 32);
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), calc);
  } catch {
    return false;
  }
}

export function genId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

// ---------------- 用户 ----------------
export const Users = {
  findByUsername: (username) => db.prepare("SELECT * FROM users WHERE username = ?").get(username) ?? null,
  findById: (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id) ?? null,
  create: (username, passwordHash) => {
    const user = { id: genId(), username, passwordHash, createdAt: Date.now() };
    db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(user.id, user.username, user.passwordHash, user.createdAt);
    return user;
  },
  count: () => db.prepare("SELECT COUNT(*) AS c FROM users").get().c,
};

// ---------------- 机器人 ----------------
export const Bots = {
  listByOwner: (ownerId) =>
    db.prepare("SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at DESC").all(ownerId).map(rowToBot),
  find: (id) => rowToBot(db.prepare("SELECT * FROM bots WHERE id = ?").get(id)),
  /** 运行器专用：返回含解密密钥的记录（仅在启动机器人时调用） */
  findWithSecrets: (id) => {
    const b = Bots.find(id);
    if (!b) return null;
    return {
      id: b.id, ownerId: b.ownerId, name: b.name, enabled: b.enabled, status: b.status, lastError: b.lastError,
      qq: { appId: b.appId, appSecret: decrypt(b.appSecretEnc) },
      llm: { baseUrl: b.baseUrl, apiKey: decrypt(b.apiKeyEnc), model: b.model, temperature: b.temperature },
      persona: b.persona, rules: b.rules, specialWords: b.specialWords, moderation: b.moderation,
      createdAt: b.createdAt, updatedAt: b.updatedAt,
    };
  },
  create: (record) => {
    const now = Date.now();
    db.prepare(`INSERT INTO bots
      (id, owner_id, name, enabled, status, last_error, app_id, app_secret_enc, base_url, api_key_enc, model, temperature, persona, rules, special_words, moderation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id, record.ownerId, record.name, record.enabled !== false ? 1 : 0,
        record.status ?? "stopped", record.lastError ?? "",
        record.qq?.appId ?? "", encrypt(record.qq?.appSecret ?? ""),
        record.llm?.baseUrl ?? "https://api.deepseek.com", encrypt(record.llm?.apiKey ?? ""),
        record.llm?.model ?? "deepseek-chat", Number(record.llm?.temperature ?? 0.7),
        record.persona ?? "", record.rules ?? "",
        JSON.stringify(record.specialWords ?? []),
        JSON.stringify(record.moderation ?? {}),
        record.createdAt ?? now, record.updatedAt ?? now,
      );
    return Bots.find(record.id);
  },
  update: (id, patch) => {
    const cur = Bots.find(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, qq: { ...cur.qq, ...(patch.qq ?? {}) }, llm: { ...cur.llm, ...(patch.llm ?? {}) }, updatedAt: Date.now() };
    db.prepare(`UPDATE bots SET name=?, enabled=?, status=?, last_error=?, app_id=?, app_secret_enc=?, base_url=?, api_key_enc=?, model=?, temperature=?, persona=?, rules=?, special_words=?, moderation=?, updated_at=? WHERE id=?`)
      .run(
        next.name, next.enabled !== false ? 1 : 0, next.status ?? "stopped", next.lastError ?? "",
        next.qq?.appId ?? cur.appId,
        next.qq?.appSecret ? encrypt(next.qq.appSecret) : cur.appSecretEnc,
        next.llm?.baseUrl ?? cur.baseUrl,
        next.llm?.apiKey ? encrypt(next.llm.apiKey) : cur.apiKeyEnc,
        next.llm?.model ?? cur.model, Number(next.llm?.temperature ?? cur.temperature),
        next.persona ?? cur.persona, next.rules ?? cur.rules,
        JSON.stringify(next.specialWords ?? cur.specialWords),
        JSON.stringify(next.moderation ?? cur.moderation),
        next.updatedAt, id,
      );
    return Bots.find(id);
  },
  remove: (id) => {
    const r = db.prepare("DELETE FROM bots WHERE id = ?").run(id);
    return r.changes > 0;
  },
  all: () => db.prepare("SELECT * FROM bots ORDER BY created_at DESC").all().map(rowToBot),
  resetStatuses: () => db.prepare("UPDATE bots SET status='stopped', last_error='' WHERE status!='stopped'").run(),
};

// ---------------- 会话 ----------------
export const Sessions = {
  create: (userId) => {
    const token = crypto.randomBytes(24).toString("hex");
    db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(token, userId, Date.now());
    return token;
  },
  find: (token) => db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) ?? null,
  remove: (token) => db.prepare("DELETE FROM sessions WHERE token = ?").run(token),
};
