const $ = (id) => document.getElementById(id);

const state = {
  servers: [],
  active: null, // server name
  inventory: null,
  tool: null,
};

async function api(url, options) {
  const res = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/* ---------- server list ---------- */

async function loadServers() {
  const data = await api("/api/servers");
  state.servers = data.servers;
  renderServers();
  renderProblems(data.problems);
}

function renderServers() {
  const list = $("server-list");
  list.innerHTML = "";

  for (const srv of state.servers) {
    const li = document.createElement("li");
    const card = document.createElement("div");
    card.className = "server-card" + (srv.name === state.active ? " active" : "");

    const head = document.createElement("div");
    head.className = "row";
    head.innerHTML = `<span class="name">${esc(srv.name)}</span>
      <span class="status ${srv.connected ? "on" : ""}">${srv.connected ? "connected" : "idle"}</span>`;

    const cmd = document.createElement("div");
    cmd.className = "cmd mono";
    cmd.textContent = [srv.command, ...srv.args].join(" ");

    const actions = document.createElement("div");
    actions.className = "row";

    const btn = document.createElement("button");
    btn.className = srv.connected ? "ghost" : "primary";
    btn.textContent = srv.connected ? "Disconnect" : "Connect";
    btn.onclick = () => (srv.connected ? disconnect(srv) : connect(srv, btn));

    const sources = document.createElement("span");
    sources.className = "sources";
    sources.textContent = srv.sources.join(" · ");

    actions.append(sources, btn);
    card.append(head, cmd, actions);
    li.append(card);
    list.append(li);
  }
}

function renderProblems(problems) {
  const box = $("problems");
  if (!problems?.length) return (box.hidden = true);
  box.hidden = false;
  box.innerHTML = `<strong>Config notes</strong><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`;
}

/* ---------- connection ---------- */

async function connect(srv, btn) {
  btn.disabled = true;
  btn.textContent = "Starting…";
  try {
    const data = await api(`/api/servers/${encodeURIComponent(srv.name)}/connect`, { method: "POST" });
    state.active = srv.name;
    state.inventory = data;
    state.tool = null;
    renderInventory(srv, data);
    renderRunner();
    await loadServers();
    await loadSessions(data.sessionId);
  } catch (err) {
    showResult({ error: err.message });
    btn.disabled = false;
    btn.textContent = "Connect";
  }
}

async function disconnect(srv) {
  await api(`/api/servers/${encodeURIComponent(srv.name)}/disconnect`, { method: "POST" });
  if (state.active === srv.name) {
    state.active = null;
    state.inventory = null;
    state.tool = null;
    $("tools-view").hidden = true;
    $("tools-empty").hidden = false;
    renderRunner();
  }
  await loadServers();
}

function renderInventory(srv, data) {
  $("tools-empty").hidden = true;
  $("tools-view").hidden = false;
  $("server-title").textContent = srv.name;

  const info = data.serverInfo ?? {};
  const caps = Object.keys(data.capabilities ?? {}).join(", ") || "none advertised";
  $("server-meta").innerHTML =
    `<div>${esc(info.name ?? "?")} v${esc(info.version ?? "?")}</div>` +
    `<div>capabilities: ${esc(caps)}</div>`;

  const tools = data.tools ?? [];
  $("tool-count").textContent = tools.length;

  const list = $("tool-list");
  list.innerHTML = "";
  for (const tool of tools) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "tool-btn" + (state.tool?.name === tool.name ? " active" : "");
    btn.innerHTML = `<strong>${esc(tool.title ?? tool.name)}</strong><span>${esc(tool.description ?? "")}</span>`;
    btn.onclick = () => {
      state.tool = tool;
      renderInventory(srv, data);
      renderRunner();
    };
    li.append(btn);
    list.append(li);
  }

  const extras = $("extras");
  extras.innerHTML = "";
  for (const [label, items] of [["Resources", data.resources], ["Prompts", data.prompts]]) {
    if (!items?.length) continue;
    const block = document.createElement("div");
    block.innerHTML =
      `<h3>${label} <span class="count">${items.length}</span></h3>` +
      `<ul class="extras-list">${items
        .map((i) => `<li>${esc(i.name ?? i.uri)}${i.description ? " — " + esc(i.description) : ""}</li>`)
        .join("")}</ul>`;
    extras.append(block);
  }
}

/* ---------- tool runner ---------- */

function renderRunner() {
  const tool = state.tool;
  $("runner-empty").hidden = !!tool;
  $("runner-view").hidden = !tool;
  $("result").hidden = true;
  if (!tool) return;

  $("tool-title").textContent = tool.title ?? tool.name;
  $("tool-desc").textContent = tool.description ?? "";

  const form = $("tool-form");
  form.innerHTML = "";
  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  if (!Object.keys(props).length) {
    form.innerHTML = `<p class="hint">This tool takes no arguments.</p>`;
    return;
  }

  for (const [key, prop] of Object.entries(props)) {
    form.append(buildField(key, prop, required.has(key)));
  }
}

function buildField(key, prop, isRequired) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const type = prop.type ?? "string";

  const labelText =
    `<b>${esc(key)}</b>${isRequired ? ' <span class="req">*</span>' : ""}` +
    `<span> — ${esc(prop.description ?? type)}</span>`;

  let input;
  if (type === "boolean") {
    wrap.className = "field check";
    input = el("input", { type: "checkbox" });
    const label = el("label");
    label.innerHTML = labelText;
    wrap.append(input, label);
  } else {
    const label = el("label");
    label.innerHTML = labelText;
    if (prop.enum) {
      input = el("select");
      for (const value of prop.enum) input.append(new Option(value, value));
    } else if (type === "number" || type === "integer") {
      input = el("input", { type: "number", step: type === "integer" ? "1" : "any" });
    } else if (type === "object" || type === "array") {
      input = el("textarea", { placeholder: `JSON ${type}` });
    } else {
      input = el("input", { type: "text", placeholder: prop.default ?? "" });
    }
    wrap.append(label, input);
  }

  input.dataset.key = key;
  input.dataset.type = type;
  input.dataset.required = String(isRequired);
  return wrap;
}

function collectArgs() {
  const args = {};
  for (const input of $("tool-form").querySelectorAll("[data-key]")) {
    const { key, type, required } = input.dataset;
    if (type === "boolean") {
      if (input.checked || required === "true") args[key] = input.checked;
      continue;
    }
    const raw = input.value.trim();
    if (!raw) {
      if (required === "true") throw new Error(`"${key}" is required.`);
      continue; // omit optional empty fields rather than sending ""
    }
    if (type === "number" || type === "integer") {
      const num = Number(raw);
      if (Number.isNaN(num)) throw new Error(`"${key}" must be a number.`);
      args[key] = num;
    } else if (type === "object" || type === "array") {
      try {
        args[key] = JSON.parse(raw);
      } catch {
        throw new Error(`"${key}" must be valid JSON.`);
      }
    } else {
      args[key] = raw;
    }
  }
  return args;
}

async function runTool() {
  const btn = $("run");
  btn.disabled = true;
  btn.textContent = "Running…";
  try {
    const args = collectArgs();
    const data = await api(`/api/servers/${encodeURIComponent(state.active)}/call`, {
      method: "POST",
      body: JSON.stringify({ tool: state.tool.name, args }),
    });
    showResult(data);
    await loadSessions(data.sessionId);
  } catch (err) {
    showResult({ error: err.message });
    await loadSessions();
  } finally {
    btn.disabled = false;
    btn.textContent = "Run tool";
  }
}

function showResult(data) {
  const box = $("result");
  box.hidden = false;
  box.className = "result" + (data.error || data.result?.isError ? " error" : "");

  const text = data.error
    ? data.error
    : (data.result?.content ?? [])
        .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
        .join("\n") || JSON.stringify(data.result, null, 2);

  const stamp = data.error ? "failed" : `ok · ${data.durationMs} ms`;
  box.innerHTML = `<div class="bar"><span>Result</span><span>${esc(stamp)}</span></div>`;
  const pre = el("pre");
  pre.textContent = text;
  box.append(pre);
}

/* ---------- helpers ---------- */

function el(tag, attrs = {}) {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  return node;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---------- approval gates + kill switch ---------- */

async function pollApprovals() {
  try {
    const { pending } = await api("/api/approvals");
    renderApprovals(pending);
  } catch {
    /* transient: the console may be restarting */
  }
}

function renderApprovals(pending) {
  const tray = $("approval-tray");
  const badge = $("pending-badge");
  tray.hidden = pending.length === 0;
  badge.hidden = pending.length === 0;
  badge.textContent = `${pending.length} awaiting approval`;
  tray.innerHTML = "";

  for (const req of pending) {
    const card = document.createElement("div");
    card.className = "approval";

    const left = document.createElement("div");
    left.innerHTML =
      `<h3>Approval required</h3>` +
      `<div class="tool">${esc(req.server)} › ${esc(req.tool)}</div>` +
      `<p class="why">${esc(req.reason ?? "")} · expires ${new Date(req.expiresAt).toLocaleTimeString()}</p>`;
    const pre = el("pre");
    pre.textContent = JSON.stringify(req.args, null, 2);
    left.append(pre);

    const choices = document.createElement("div");
    choices.className = "choices";
    const approve = el("button", { className: "approve-btn", textContent: "Approve" });
    const deny = el("button", { className: "deny-btn", textContent: "Deny" });
    approve.onclick = () => decide(req.id, true, choices);
    deny.onclick = () => decide(req.id, false, choices);
    choices.append(deny, approve);

    card.append(left, choices);
    tray.append(card);
  }
}

async function decide(id, approve, container) {
  for (const b of container.querySelectorAll("button")) b.disabled = true;
  try {
    await api(`/api/approvals/${id}/decide`, { method: "POST", body: JSON.stringify({ approve }) });
  } catch (err) {
    showResult({ error: err.message });
  }
  await pollApprovals();
}

async function killAll() {
  if (!confirm("Kill switch: deny every pending approval and terminate all MCP child processes?")) return;
  const btn = $("kill");
  btn.disabled = true;
  try {
    const data = await api("/api/kill", { method: "POST" });
    showResult({
      result: {
        content: [
          {
            type: "text",
            text: `Kill switch engaged.\nDenied approvals: ${data.deniedApprovals}\nTerminated sessions: ${
              data.killedSessions.join(", ") || "(none)"
            }`,
          },
        ],
      },
      durationMs: 0,
    });
    state.active = null;
    state.inventory = null;
    state.tool = null;
    $("tools-view").hidden = true;
    $("tools-empty").hidden = false;
    renderRunner();
  } catch (err) {
    showResult({ error: err.message });
  } finally {
    btn.disabled = false;
    await Promise.all([loadServers(), loadSessions(), pollApprovals()]);
  }
}

/* ---------- session history ---------- */

async function loadSessions(preferId) {
  const { sessions } = await api("/api/sessions?limit=50");
  const select = $("session-select");
  const previous = Number(select.value) || null;
  select.innerHTML = "";

  if (!sessions.length) {
    select.append(new Option("no sessions yet", ""));
    $("session-stats").innerHTML = "";
    $("call-list").innerHTML = "";
    setExportLinks(null);
    return;
  }

  for (const s of sessions) {
    const when = new Date(s.started_at).toLocaleString();
    const live = s.ended_at ? "" : " · live";
    select.append(new Option(`#${s.id} ${s.server_name} — ${s.call_count} calls · ${when}${live}`, s.id));
  }

  const target = [preferId, previous, sessions[0].id].find((id) => sessions.some((s) => s.id === Number(id)));
  select.value = String(target);
  await showSession(target);
}

async function showSession(id) {
  const { session, calls } = await api(`/api/sessions/${id}`);
  setExportLinks(id);

  const avg = calls.length ? Math.round(session.total_ms / calls.length) : 0;
  $("session-stats").innerHTML = [
    stat(session.call_count, "calls"),
    stat(session.error_count, "errors", session.error_count > 0),
    stat(`${avg} ms`, "avg duration"),
    stat(fmtBytes(session.bytes_in), "payload in"),
    stat(fmtBytes(session.bytes_out), "payload out"),
    stat(session.ended_at ? session.end_reason : "live", "state"),
  ].join("");

  const slowest = Math.max(1, ...calls.map((c) => c.duration_ms));
  const list = $("call-list");
  list.innerHTML = "";

  for (const call of calls) {
    const li = document.createElement("li");
    li.className = "call " + (call.is_error ? "bad" : "ok");

    const output = call.error
      ? call.error
      : (call.result?.content ?? []).map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");

    li.innerHTML =
      `<span class="seq">#${call.seq}</span>` +
      `<span class="tool">${esc(call.tool)}` +
      (call.replay_of ? ` <em>replay of #${call.replay_of}</em>` : "") +
      `</span>` +
      `<span class="decision ${esc(call.decision)}">${esc(call.decision)}</span>` +
      `<span class="num">${call.duration_ms} ms</span>` +
      `<span class="num">↑${fmtBytes(call.bytes_in)}</span>` +
      `<span class="num">↓${fmtBytes(call.bytes_out)}</span>`;

    const replay = el("button", { className: "ghost", textContent: "Replay" });
    replay.onclick = () => replayCall(call.id, replay);
    li.append(replay);

    const bar = document.createElement("span");
    bar.className = "bar-wrap";
    bar.innerHTML = `<span class="bar-fill" style="width:${(call.duration_ms / slowest) * 100}%"></span>`;
    li.append(bar);

    const out = document.createElement("div");
    out.className = "out";
    const pre = el("pre");
    pre.textContent = truncate(output, 600) || "(no output)";
    out.append(pre);
    li.append(out);

    list.append(li);
  }
}

async function replayCall(id, btn) {
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const data = await api(`/api/calls/${id}/replay`, { method: "POST" });
    showResult(data);
    await loadSessions(data.sessionId);
  } catch (err) {
    showResult({ error: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = "Replay";
  }
}

function setExportLinks(id) {
  for (const [elId, format] of [["export-json", "json"], ["export-csv", "csv"]]) {
    const node = $(elId);
    node.href = id ? `/api/sessions/${id}/export?format=${format}` : "#";
    node.setAttribute("aria-disabled", String(!id));
  }
}

const stat = (value, label, bad = false) =>
  `<div class="stat${bad ? " bad" : ""}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length} chars)` : text);

$("kill").onclick = killAll;
setInterval(pollApprovals, 2000);
pollApprovals();

$("session-select").onchange = (e) => e.target.value && showSession(e.target.value);
$("run").onclick = runTool;
$("refresh").onclick = () => Promise.all([loadServers(), loadSessions()]);
loadServers();
loadSessions();
