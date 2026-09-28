// Front end for the coach: chat, today's dashboard, and setup.
const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = "coach-token";

let token = readToken();
let state = null;

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function writeToken(value) {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: token lives in memory only */
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...options.headers },
  });
  if (res.status === 401) {
    showLogin("That token didn't work.");
    throw new Error("unauthorized");
  }
  return res;
}

// ---------- Login ----------
function showLogin(message) {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-error").hidden = !message;
  $("#login-error").textContent = message || "";
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  writeToken($("#login-token").value.trim());
  await start();
});

// ---------- Tabs ----------
document.querySelectorAll(".tabs button").forEach((btn) =>
  btn.addEventListener("click", () => selectTab(btn.dataset.tab)),
);

function selectTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
  for (const t of ["coach", "today", "setup"]) $(`#tab-${t}`).hidden = t !== name;
  if (name !== "coach") refresh();
}

// ---------- Data ----------
async function refresh() {
  const res = await api("/api/state");
  state = await res.json();
  renderHeader();
  renderToday();
}

async function start() {
  if (!token) return showLogin();
  try {
    await refresh();
  } catch {
    return;
  }
  $("#login").hidden = true;
  $("#app").hidden = false;
  renderChat();
  renderSettings();
  renderSetupUrls();
}

function renderHeader() {
  const { settings, snapshot } = state;
  const hour = Number(snapshot.now.time.split(":")[0]);
  const part = hour < 5 ? "Still up" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  $("#greeting").textContent = settings.name ? `${part}, ${settings.name}` : part;
  const t = snapshot.today;
  let line = `${t.distractionMin} min of entertainment today`;
  if (snapshot.current) line = `In ${snapshot.current.app} for ${snapshot.current.minutes} min · ` + line;
  if (!snapshot.trackingSince) line = "No app activity yet. Connect your iPhone under Setup.";
  if (!state.aiEnabled) line += " · AI is off (set ANTHROPIC_API_KEY)";
  $("#status-line").textContent = line;
}

// ---------- Chat ----------
function addBubble(role, text, extraClass = "") {
  $(".empty")?.remove();
  const div = document.createElement("div");
  div.className = `msg ${role} ${extraClass}`.trim();
  div.textContent = text;
  $("#messages").append(div);
  div.scrollIntoView({ block: "end" });
  return div;
}

function renderChat() {
  const box = $("#messages");
  box.replaceChildren();
  if (!state.chat.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Hi! I'm your coach. I can see how much time you spend in the apps you track. Ask me how today is going, or tell me what you'd like to change.";
    box.append(p);
  }
  for (const m of state.chat) addBubble(m.role, m.text);
}

async function sendMessage(text) {
  text = text.trim();
  if (!text) return;
  $("#chat-input").value = "";
  autosize();
  $("#send").disabled = true;
  addBubble("user", text);
  const bubble = addBubble("assistant", "", "typing");

  try {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: text }) });
    if (!res.ok) throw new Error((await res.json()).error || "Request failed");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.delta) {
          bubble.textContent += msg.delta;
          bubble.scrollIntoView({ block: "end" });
        }
        if (msg.error) throw new Error(msg.error);
      }
    }
  } catch (err) {
    if (err.message !== "unauthorized") {
      bubble.className = "msg error";
      bubble.textContent = `Couldn't reach the coach: ${err.message}`;
    }
  } finally {
    bubble.classList.remove("typing");
    $("#send").disabled = false;
  }
}

function autosize() {
  const el = $("#chat-input");
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage($("#chat-input").value);
});
$("#chat-input").addEventListener("input", autosize);
$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage($("#chat-input").value);
  }
});
$("#chips").addEventListener("click", (e) => {
  if (e.target.dataset.prompt) sendMessage(e.target.dataset.prompt);
});

// ---------- Today ----------
function renderToday() {
  const { snapshot } = state;
  const t = snapshot.today;
  $("#tile-distraction").textContent = t.distractionMin;
  $("#tile-productive").textContent = t.productiveMin;
  $("#tile-late").textContent = t.lateNightDistractionMin;

  const now = $("#now-card");
  now.hidden = !snapshot.current;
  if (snapshot.current) now.textContent = `Right now: ${snapshot.current.app}, ${snapshot.current.minutes} min so far.`;

  // Apps today: one row per app, bar scaled to the largest of usage or limit.
  const chart = $("#apps-chart");
  chart.replaceChildren();
  if (!t.apps.length) chart.innerHTML = '<p class="muted small">Nothing tracked yet today.</p>';
  const max = Math.max(1, ...t.apps.map((a) => Math.max(a.minutes, a.limitMin)));
  for (const a of t.apps) {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.title = `${a.app}: ${a.minutes} min, ${a.opens} opens, longest ${a.longestMin} min` + (a.limitMin ? `, limit ${a.limitMin} min` : "");
    const limitTick = a.limitMin ? `<span class="bar-limit" style="left:${(a.limitMin / max) * 100}%"></span>` : "";
    row.innerHTML = `
      <span class="bar-name"></span>
      <span class="bar-track">
        <span class="bar-fill ${a.category === "distraction" ? "distraction" : ""}" style="width:${(a.minutes / max) * 100}%"></span>
        ${limitTick}
      </span>
      <span class="bar-value ${a.overLimit ? "over" : ""}">${a.overLimit ? "⚠ " : ""}${a.minutes}${a.limitMin ? `/${a.limitMin}` : ""}m</span>`;
    row.querySelector(".bar-name").textContent = a.app;
    chart.append(row);
  }

  // Week: entertainment minutes per day.
  const week = $("#week-chart");
  week.replaceChildren();
  const wmax = Math.max(1, ...snapshot.week.map((d) => d.distractionMin));
  snapshot.week.forEach((d, i) => {
    const isToday = i === snapshot.week.length - 1;
    const label = isToday ? "Today" : new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
    const col = document.createElement("div");
    col.className = `day ${isToday ? "today" : ""}`;
    col.title = `${d.date}: ${d.distractionMin} min entertainment, ${d.productiveMin} min productive`;
    col.innerHTML = `<span class="day-val">${d.distractionMin}</span>
      <span class="day-col" style="height:${(d.distractionMin / wmax) * 100}px"></span>
      <span class="day-label">${label}</span>`;
    week.append(col);
  });

  const list = $("#sessions");
  list.replaceChildren();
  if (!snapshot.recentSessions.length) list.innerHTML = '<li class="muted">No sessions yet today.</li>';
  for (const s of [...snapshot.recentSessions].reverse()) {
    const li = document.createElement("li");
    li.innerHTML = "<span></span><span class='muted'></span>";
    li.children[0].textContent = `${s.at} · ${s.app}`;
    li.children[1].textContent = s.ongoing ? `${s.minutes} min (now)` : `${s.minutes} min`;
    list.append(li);
  }
}

// ---------- Settings ----------
function renderSettings() {
  const f = $("#settings-form");
  const s = state.settings;
  for (const key of ["name", "goals", "bedtime", "timezone", "coachStyle", "language", "nudgeMode"]) {
    if (f.elements[key]) f.elements[key].value = s[key] ?? "";
  }
  const editor = $("#apps-editor");
  editor.replaceChildren();
  for (const a of s.apps) addAppRow(a);
}

function addAppRow(a = { name: "", category: "distraction", dailyLimitMin: 30 }) {
  const row = document.createElement("div");
  row.className = "app-row";
  row.innerHTML = `
    <input class="app-name" placeholder="App name" aria-label="App name">
    <select class="app-cat" aria-label="Category">
      <option value="distraction">Entertainment</option>
      <option value="neutral">Neutral</option>
      <option value="productive">Productive</option>
    </select>
    <input class="app-limit" type="number" min="0" inputmode="numeric" aria-label="Daily limit in minutes">
    <button type="button" aria-label="Remove">✕</button>`;
  row.querySelector(".app-name").value = a.name;
  row.querySelector(".app-cat").value = a.category;
  row.querySelector(".app-limit").value = a.dailyLimitMin;
  row.querySelector("button").addEventListener("click", () => row.remove());
  $("#apps-editor").append(row);
}

$("#add-app").addEventListener("click", () => addAppRow());

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const patch = {};
  for (const key of ["name", "goals", "bedtime", "timezone", "coachStyle", "language", "nudgeMode"]) {
    patch[key] = f.elements[key].value.trim();
  }
  patch.apps = [...document.querySelectorAll(".app-row")].map((r) => ({
    name: r.querySelector(".app-name").value,
    category: r.querySelector(".app-cat").value,
    dailyLimitMin: Number(r.querySelector(".app-limit").value),
  }));
  await api("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
  await refresh();
  renderSettings();
  $("#settings-saved").hidden = false;
  setTimeout(() => ($("#settings-saved").hidden = true), 2000);
});

function renderSetupUrls() {
  const base = `${location.origin}/api/event?token=${encodeURIComponent(token)}&app=Rednote`;
  $("#url-open").textContent = `${base}&type=open`;
  $("#url-close").textContent = `${base}&type=close`;
  // First run: default the time zone to this phone's.
  if (!state.snapshot.trackingSince && !state.settings.name) {
    $("#settings-form").elements.timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

document.querySelectorAll("code.copy").forEach((el) =>
  el.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(el.textContent);
      const old = el.textContent;
      el.textContent = "Copied!";
      setTimeout(() => (el.textContent = old), 1000);
    } catch {
      /* clipboard blocked: the user can still select the text */
    }
  }),
);

$("#export").addEventListener("click", async () => {
  const res = await api("/api/export");
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "coach-data.json";
  a.click();
});

$("#clear-chat").addEventListener("click", async () => {
  if (!confirm("Clear the whole conversation?")) return;
  await api("/api/chat", { method: "DELETE" });
  state.chat = [];
  renderChat();
});

$("#logout").addEventListener("click", () => {
  writeToken("");
  showLogin();
});

// Keep the dashboard and header fresh while the app is open.
setInterval(() => {
  if (token && !$("#app").hidden && document.visibilityState === "visible") refresh().catch(() => {});
}, 60_000);

start();
