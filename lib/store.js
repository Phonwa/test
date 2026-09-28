// Tiny JSON-file store. Everything the coach knows about you lives in one file
// on your own server (default: ./data/coach.json).
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_SETTINGS = {
  name: "",
  timezone: "Asia/Shanghai",
  bedtime: "23:30",
  goals: "",
  coachStyle: "warm but honest",
  // Language for phone notifications. In chat the coach mirrors whatever you write.
  language: "English",
  // "always": a short notification every time you open a tracked app.
  // "smart": only speak up when you are over a limit, bingeing, or up late.
  nudgeMode: "always",
  apps: [
    { name: "Rednote", category: "distraction", dailyLimitMin: 30 },
    { name: "Douyin", category: "distraction", dailyLimitMin: 30 },
    { name: "Bilibili", category: "distraction", dailyLimitMin: 45 },
    { name: "YouTube", category: "distraction", dailyLimitMin: 45 },
    { name: "Weibo", category: "distraction", dailyLimitMin: 20 },
    { name: "WeChat", category: "neutral", dailyLimitMin: 0 },
    { name: "Kindle", category: "productive", dailyLimitMin: 0 },
    { name: "Duolingo", category: "productive", dailyLimitMin: 0 },
  ],
};

const MAX_EVENTS = 20000;
const MAX_CHAT = 200;

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { settings: structuredClone(DEFAULT_SETTINGS), events: [], chat: [] };
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, "utf8"));
      this.data = {
        settings: { ...structuredClone(DEFAULT_SETTINGS), ...loaded.settings },
        events: loaded.events ?? [],
        chat: loaded.chat ?? [],
      };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get settings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    for (const key of allowed) {
      if (patch[key] !== undefined) this.data.settings[key] = patch[key];
    }
    this.data.settings.apps = normalizeApps(this.data.settings.apps);
    this.save();
    return this.data.settings;
  }

  // Returns the canonical app entry, auto-registering apps we have not seen.
  resolveApp(rawName) {
    const name = String(rawName ?? "").trim().slice(0, 60);
    if (!name) return null;
    const found = this.data.settings.apps.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (found) return found;
    const entry = { name, category: "neutral", dailyLimitMin: 0 };
    this.data.settings.apps.push(entry);
    return entry;
  }

  addEvent(event) {
    this.data.events.push(event);
    if (this.data.events.length > MAX_EVENTS) this.data.events.splice(0, this.data.events.length - MAX_EVENTS);
    this.save();
  }

  get events() {
    return this.data.events;
  }

  get chat() {
    return this.data.chat;
  }

  addChat(...messages) {
    this.data.chat.push(...messages);
    if (this.data.chat.length > MAX_CHAT) this.data.chat.splice(0, this.data.chat.length - MAX_CHAT);
    this.save();
  }

  clearChat() {
    this.data.chat = [];
    this.save();
  }
}

const CATEGORIES = new Set(["distraction", "neutral", "productive"]);

function normalizeApps(apps) {
  if (!Array.isArray(apps)) return structuredClone(DEFAULT_SETTINGS.apps);
  const seen = new Set();
  const out = [];
  for (const a of apps) {
    const name = String(a?.name ?? "").trim().slice(0, 60);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      category: CATEGORIES.has(a.category) ? a.category : "neutral",
      dailyLimitMin: Math.max(0, Math.round(Number(a.dailyLimitMin) || 0)),
    });
  }
  return out;
}
