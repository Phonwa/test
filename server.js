// AI Life Coach server: receives app open/close events from iOS Shortcuts,
// serves the web app, and talks to Claude.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODEL, assessOpen, chat, nudge } from "./lib/coach.js";
import { Store } from "./lib/store.js";
import { snapshot } from "./lib/usage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(here, "data");
const PUBLIC_DIR = path.join(here, "public");

const store = new Store(path.join(DATA_DIR, "coach.json"));
const TOKEN = loadToken();

function loadToken() {
  if (process.env.COACH_TOKEN) return process.env.COACH_TOKEN;
  const file = path.join(DATA_DIR, "token.txt");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const token = crypto.randomBytes(18).toString("base64url");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function authorized(req, url) {
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const given = Buffer.from(header || url.searchParams.get("token") || "");
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("body too large");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Shortcuts can also send form-encoded bodies.
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

function eventType(value) {
  const v = String(value ?? "open").toLowerCase();
  if (["open", "opened", "start", "is opened"].includes(v)) return "open";
  if (["close", "closed", "stop", "is closed"].includes(v)) return "close";
  return null;
}

function aiEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function chatForDisplay() {
  return store.chat.map((m) => ({ role: m.role, text: m.text, ts: m.ts }));
}

const routes = {
  async "POST /api/event"(req, res, url) {
    const body = await readBody(req);
    const app = store.resolveApp(body.app ?? url.searchParams.get("app"));
    const type = eventType(body.type ?? body.event ?? url.searchParams.get("type"));
    if (!app || !type) return send(res, 400, "Need app and type (open|close)", "text/plain; charset=utf-8");

    store.addEvent({ ts: Date.now(), app: app.name, type });
    if (type === "close") return send(res, 200, "", "text/plain; charset=utf-8");

    const snap = snapshot(store);
    const assessment = assessOpen(snap, store.settings, app.name);
    const text = await nudge({ store, snap, assessment });
    // Plain text, so the Shortcut can pipe it straight into "Show Notification".
    send(res, 200, text, "text/plain; charset=utf-8");
  },

  async "GET /api/state"(req, res) {
    send(res, 200, {
      snapshot: snapshot(store),
      settings: store.settings,
      chat: chatForDisplay(),
      model: MODEL,
      aiEnabled: aiEnabled(),
    });
  },

  async "PUT /api/settings"(req, res) {
    const patch = await readBody(req);
    send(res, 200, store.updateSettings(patch));
  },

  async "POST /api/chat"(req, res) {
    const { message } = await readBody(req);
    const userText = String(message ?? "").trim().slice(0, 4000);
    if (!userText) return send(res, 400, { error: "Empty message" });
    if (!aiEnabled()) return send(res, 503, { error: "Chat needs ANTHROPIC_API_KEY set on the server." });

    // Newline-delimited JSON so the browser can render the reply as it streams.
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
    const write = (obj) => res.write(JSON.stringify(obj) + "\n");
    try {
      await chat({ store, snap: snapshot(store), userText, onText: (t) => write({ delta: t }) });
      write({ done: true });
    } catch (err) {
      console.error("chat failed:", err);
      write({ error: err.message || "Something went wrong" });
    }
    res.end();
  },

  async "DELETE /api/chat"(req, res) {
    store.clearChat();
    send(res, 200, { ok: true });
  },

  async "GET /api/export"(req, res) {
    res.setHeader("Content-Disposition", 'attachment; filename="coach-data.json"');
    send(res, 200, store.data);
  },
};

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
  res.writeHead(200, { "Content-Type": STATIC_TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/health") return send(res, 200, { ok: true });
    if (url.pathname.startsWith("/api/")) {
      if (!authorized(req, url)) return send(res, 401, { error: "Missing or wrong token" });
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) return send(res, 404, { error: "Not found" });
      return await handler(req, res, url);
    }
    if (req.method === "GET") return serveStatic(res, url.pathname);
    send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: "Server error" });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`AI Life Coach running on http://localhost:${PORT}`);
  console.log(`Access token: ${TOKEN}`);
  if (!aiEnabled()) {
    console.log("ANTHROPIC_API_KEY is not set: chat is disabled and nudges use built-in templates.");
  }
});
