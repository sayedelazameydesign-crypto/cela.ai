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
  } catch (err) {
    showResult({ error: err.message });
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

$("run").onclick = runTool;
$("refresh").onclick = loadServers;
loadServers();
