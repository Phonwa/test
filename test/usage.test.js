import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assessOpen, templateNudge } from "../lib/coach.js";
import { Store } from "../lib/store.js";
import { MAX_SESSION_MS, buildSessions, dayStats, lastNDays, snapshot } from "../lib/usage.js";

const MIN = 60_000;
// 2026-09-28 10:00 in Asia/Shanghai (UTC+8).
const T0 = Date.UTC(2026, 8, 28, 2, 0);

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coach-"));
  return new Store(path.join(dir, "coach.json"));
}

test("pairs open and close into sessions", () => {
  const s = buildSessions(
    [
      { ts: T0, app: "Rednote", type: "open" },
      { ts: T0 + 12 * MIN, app: "Rednote", type: "close" },
    ],
    T0 + 60 * MIN,
  );
  assert.equal(s.length, 1);
  assert.equal(s[0].end - s[0].start, 12 * MIN);
  assert.equal(s[0].ongoing, false);
});

test("opening another app ends the previous session", () => {
  const s = buildSessions(
    [
      { ts: T0, app: "Rednote", type: "open" },
      { ts: T0 + 5 * MIN, app: "Bilibili", type: "open" },
      { ts: T0 + 8 * MIN, app: "Bilibili", type: "close" },
    ],
    T0 + 60 * MIN,
  );
  assert.deepEqual(
    s.map((x) => [x.app, (x.end - x.start) / MIN]),
    [
      ["Rednote", 5],
      ["Bilibili", 3],
    ],
  );
});

test("a missing close is capped, and a fresh open is ongoing", () => {
  const stale = buildSessions([{ ts: T0, app: "Douyin", type: "open" }], T0 + 5 * 60 * MIN);
  assert.equal(stale[0].end - stale[0].start, MAX_SESSION_MS);
  assert.equal(stale[0].ongoing, false);

  const live = buildSessions([{ ts: T0, app: "Douyin", type: "open" }], T0 + 7 * MIN);
  assert.equal(live[0].ongoing, true);
  assert.equal(live[0].end - live[0].start, 7 * MIN);
});

test("day stats use the configured time zone and flag limits", () => {
  const store = tempStore();
  const settings = store.settings; // Asia/Shanghai, Rednote limit 30
  const sessions = buildSessions(
    [
      { ts: T0, app: "Rednote", type: "open" },
      { ts: T0 + 35 * MIN, app: "Rednote", type: "close" },
      // 23:50 local, after the 23:30 bedtime.
      { ts: T0 + (13 * 60 + 50) * MIN, app: "Douyin", type: "open" },
      { ts: T0 + (14 * 60 + 5) * MIN, app: "Douyin", type: "close" },
    ],
    T0 + 15 * 60 * MIN,
  );
  const day = dayStats(sessions, "2026-09-28", settings);
  const rednote = day.apps.find((a) => a.app === "Rednote");
  assert.equal(rednote.minutes, 35);
  assert.equal(rednote.overLimit, true);
  assert.equal(day.distractionMin, 50);
  assert.equal(day.lateNightDistractionMin, 15);
});

test("lastNDays returns consecutive local dates ending today", () => {
  assert.deepEqual(lastNDays(T0, 3, "Asia/Shanghai"), ["2026-09-26", "2026-09-27", "2026-09-28"]);
});

test("store matches app names case-insensitively and registers new ones", () => {
  const store = tempStore();
  assert.equal(store.resolveApp("rednote").name, "Rednote");
  const added = store.resolveApp("Kuaishou");
  assert.equal(added.category, "neutral");
  assert.ok(store.settings.apps.some((a) => a.name === "Kuaishou"));
});

test("opening a distraction app over its limit is a warning", () => {
  const store = tempStore();
  store.addEvent({ ts: T0, app: "Rednote", type: "open" });
  store.addEvent({ ts: T0 + 31 * MIN, app: "Rednote", type: "close" });
  store.addEvent({ ts: T0 + 40 * MIN, app: "Rednote", type: "open" });
  const snap = snapshot(store, T0 + 40 * MIN);
  const a = assessOpen(snap, store.settings, "Rednote");
  assert.equal(a.level, "warn");
  assert.match(a.reasons[0], /over today's 30-min limit/);
  assert.match(templateNudge(a, "English"), /Rednote: 31\/30 min/);
  assert.match(templateNudge(a, "Chinese (中文)"), /今天已刷/);
});

test("light use of a distraction app is informational only", () => {
  const store = tempStore();
  store.addEvent({ ts: T0, app: "Bilibili", type: "open" });
  const a = assessOpen(snapshot(store, T0 + MIN), store.settings, "Bilibili");
  assert.equal(a.level, "info");
  assert.deepEqual(a.reasons, []);
});
