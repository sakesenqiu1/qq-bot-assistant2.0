// 前端逻辑：登录注册 + 机器人管理面板（增删改查 + 启停）
const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = "qqbot_platform_token";

let token = localStorage.getItem(TOKEN_KEY) || "";
let bots = [];
let editingId = null;

// ---------------- API ----------------
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(options.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败(" + res.status + ")");
  return data;
}

// ---------------- 视图切换 ----------------
function show(view) {
  $("#auth-view").classList.toggle("hidden", view !== "auth");
  $("#dashboard").classList.toggle("hidden", view !== "dash");
}

// ---------------- 认证 ----------------
function setAuthMsg(text, ok = false) {
  const el = $("#auth-msg");
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
}

$("#tab-login").onclick = () => switchTab(true);
$("#tab-register").onclick = () => switchTab(false);
function switchTab(isLogin) {
  $("#tab-login").classList.toggle("active", isLogin);
  $("#tab-register").classList.toggle("active", !isLogin);
  $("#auth-submit").textContent = isLogin ? "登录" : "注册";
  $("#auth-form").dataset.mode = isLogin ? "login" : "register";
  setAuthMsg("");
}

$("#auth-form").onsubmit = async (e) => {
  e.preventDefault();
  const username = $("#auth-username").value.trim();
  const password = $("#auth-password").value;
  const mode = $("#auth-form").dataset.mode || "login";
  try {
    const data = await api("/api/" + mode, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    setAuthMsg(mode === "login" ? "登录成功" : "注册成功", true);
    await enterDashboard();
  } catch (err) {
    setAuthMsg(err.message);
  }
};

$("#btn-logout").onclick = async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  token = "";
  localStorage.removeItem(TOKEN_KEY);
  show("auth");
};

// ---------------- 面板 ----------------
async function enterDashboard() {
  const me = await api("/api/me");
  $("#who").textContent = "👤 " + me.username;
  show("dash");
  await loadBots();
}

async function loadBots() {
  bots = await api("/api/bots");
  const list = $("#bot-list");
  if (bots.length === 0) {
    list.innerHTML = '<div class="empty">还没有机器人，点击右上角「＋ 新建机器人」开始</div>';
    return;
  }
  list.innerHTML = bots.map(renderCard).join("");
  list.querySelectorAll("[data-act]").forEach((btn) => {
    btn.onclick = () => handleAction(btn.dataset.act, btn.dataset.id);
  });
}

function statusBadge(s) {
  const map = { stopped: ["已停止", "stopped"], starting: ["启动中", "starting"], running: ["运行中", "running"], error: ["出错", "error"] };
  const [text, cls] = map[s] || [s, "stopped"];
  return `<span class="badge ${cls}">${text}</span>`;
}

function renderCard(b) {
  const running = b.status === "running" || b.status === "starting";
  return `
  <div class="bot-card">
    <div class="top"><h4>${esc(b.name)}</h4>${statusBadge(b.status)}</div>
    <div class="meta">
      AppID：${esc(b.qq.appId || "未填写")}${b.qq.hasSecret || b.llm.hasKey ? " · 🔒密钥已加密" : ""}<br>
      AI 模型：${esc(b.llm.model || "未填写")} · ${esc(b.llm.baseUrl || "")}<br>
      特殊词：${b.specialWords?.length ?? 0} 条${b.moderation?.autoRebuke ? " · 🚨自动攻击开" : ""} · 更新于 ${new Date(b.updatedAt).toLocaleString("zh-CN")}
    </div>
    ${b.lastError ? `<div class="err-line">⚠ ${esc(b.lastError)}</div>` : ""}
    <div class="actions">
      ${running
        ? `<button class="btn" data-act="stop" data-id="${b.id}">停止</button>`
        : `<button class="btn success" data-act="start" data-id="${b.id}">启动</button>`}
      <button class="btn" data-act="edit" data-id="${b.id}">编辑</button>
      <button class="btn danger" data-act="del" data-id="${b.id}">删除</button>
    </div>
  </div>`;
}

async function handleAction(act, id) {
  if (act === "start") {
    const btn = event.target;
    btn.disabled = true;
    try { await api(`/api/bots/${id}/start`, { method: "POST" }); } catch (err) { alert(err.message); }
    await loadBots();
    return;
  }
  if (act === "stop") {
    try { await api(`/api/bots/${id}/stop`, { method: "POST" }); } catch {}
    await loadBots();
    return;
  }
  if (act === "edit") {
    const bot = bots.find((b) => b.id === id);
    openModal(bot);
    return;
  }
  if (act === "del") {
    if (!confirm("确定删除该机器人？此操作不可恢复。")) return;
    try { await api(`/api/bots/${id}`, { method: "DELETE" }); } catch (err) { alert(err.message); }
    await loadBots();
  }
}

// ---------------- 弹窗 ----------------
$("#btn-new").onclick = () => openModal(null);
$("#modal-close").onclick = closeModal;
$("#modal-cancel").onclick = closeModal;
$("#modal").onclick = (e) => { if (e.target === $("#modal")) closeModal(); };

function openModal(bot) {
  editingId = bot?.id ?? null;
  $("#modal-title").textContent = bot ? "编辑机器人：" + bot.name : "新建机器人";
  const f = $("#bot-form");
  f.reset();
  f.name.value = bot?.name ?? "";
  f.appId.value = bot?.qq.appId ?? "";
  f.appSecret.value = ""; // 编辑时留空 = 保持原值
  f.appSecret.placeholder = bot?.qq?.hasSecret ? "已加密保存（留空保持不变）" : "未设置（q.qq.com 开发设置获取）";
  f.apiKey.placeholder = bot?.llm?.hasKey ? "已加密保存（留空保持不变）" : "sk-...（本地 Ollama 可留空）";
  f.baseUrl.value = bot?.llm.baseUrl ?? "https://api.deepseek.com";
  f.apiKey.value = bot?.llm.apiKey ?? "";
  f.model.value = bot?.llm.model ?? "deepseek-chat";
  f.persona.value = bot?.persona ?? "";
  f.rules.value = bot?.rules ?? "";
  f.enabled.checked = bot ? bot.enabled : true;
  f.autoRebuke.checked = bot ? (bot.moderation?.autoRebuke !== false) : true;
  f.keywords.value = (bot?.moderation?.keywords ?? []).join(",");
  renderWords(bot?.specialWords ?? []);
  $("#modal").classList.remove("hidden");
}

function closeModal() {
  $("#modal").classList.add("hidden");
}

function renderWords(words) {
  const list = $("#words-list");
  list.innerHTML = "";
  (words.length ? words : [{}]).forEach((w) => list.appendChild(wordRow(w)));
}
function wordRow(w = {}) {
  const div = document.createElement("div");
  div.className = "word-row";
  div.innerHTML = `
    <input class="w-word" placeholder="触发词，如：群规" value="${esc(w.word ?? "")}">
    <select class="w-action">
      <option value="reply" ${w.action === "reply" ? "selected" : ""}>固定回复</option>
      <option value="ai" ${w.action === "ai" ? "selected" : ""}>交给AI判断</option>
      <option value="ignore" ${w.action === "ignore" ? "selected" : ""}>忽略该消息</option>
    </select>
    <input class="w-value" placeholder="" value="${esc(w.action === "ai" ? (w.prompt ?? "") : (w.reply ?? ""))}">
    <button type="button" class="btn ghost" onclick="this.parentElement.remove()">✕</button>`;
  const sel = div.querySelector(".w-action");
  const input = div.querySelector(".w-value");
  const applyPlaceholder = () => {
    if (sel.value === "ai") {
      input.placeholder = "给 AI 的提示词（AI 将按此判断和回答）";
      input.disabled = false;
    } else if (sel.value === "reply") {
      input.placeholder = "固定回复内容";
      input.disabled = false;
    } else {
      input.placeholder = "（忽略消息，无需填写）";
      input.disabled = true;
    }
  };
  sel.onchange = applyPlaceholder;
  applyPlaceholder();
  return div;
}
$("#btn-add-word").onclick = () => $("#words-list").appendChild(wordRow());

$("#bot-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const qq = { appId: f.appId.value.trim(), appSecret: f.appSecret.value.trim() };
  const llm = { baseUrl: f.baseUrl.value.trim(), apiKey: f.apiKey.value.trim(), model: f.model.value.trim() };
  const specialWords = [...document.querySelectorAll(".word-row")]
    .map((row) => {
      const action = row.querySelector(".w-action").value;
      const value = row.querySelector(".w-value").value.trim();
      return {
        word: row.querySelector(".w-word").value.trim(),
        action,
        reply: action === "reply" ? value : "",
        prompt: action === "ai" ? value : "",
      };
    })
    .filter((w) => w.word);
  const moderation = {
    autoRebuke: f.autoRebuke.checked,
    keywords: f.keywords.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
  };
  const body = {
    name: f.name.value.trim(),
    qq: Object.fromEntries(Object.entries(qq).filter(([, v]) => v !== "")),
    llm: Object.fromEntries(Object.entries(llm).filter(([, v]) => v !== "")),
    persona: f.persona.value,
    rules: f.rules.value,
    specialWords,
    moderation,
    enabled: f.enabled.checked,
  };
  try {
    if (editingId) {
      await api(`/api/bots/${editingId}`, { method: "PUT", body: JSON.stringify(body) });
    } else {
      await api("/api/bots", { method: "POST", body: JSON.stringify(body) });
    }
    closeModal();
    await loadBots();
  } catch (err) {
    alert(err.message);
  }
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------- 启动 ----------------
(async () => {
  if (token) {
    try {
      await enterDashboard();
      return;
    } catch {
      token = "";
      localStorage.removeItem(TOKEN_KEY);
    }
  }
  show("auth");
})();
