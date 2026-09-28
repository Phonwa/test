// Turns raw "app opened / app closed" events from iOS Shortcuts into sessions
// and daily stats.

const MIN = 60 * 1000;
// If a "closed" event never arrives (automation skipped, phone died), cap the
// session instead of counting hours of phantom usage.
export const MAX_SESSION_MS = 90 * MIN;
// A second "open" for the same app within this window is the same session.
const REOPEN_MERGE_MS = 10 * 1000;

export function localDateKey(ts, timeZone) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

export function localTime(ts, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ts));
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return { hour, minute, minutesOfDay: hour * 60 + minute, label: `${pad(hour)}:${pad(minute)}` };
}

export function localWeekday(ts, timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(new Date(ts));
}

function pad(n) {
  return String(n).padStart(2, "0");
}

export function buildSessions(events, now = Date.now()) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const sessions = [];
  let current = null;

  const close = (end) => {
    const capped = Math.min(end, current.start + MAX_SESSION_MS);
    sessions.push({ app: current.app, start: current.start, end: capped, ongoing: false });
    current = null;
  };

  for (const ev of sorted) {
    if (ev.type === "open") {
      if (current && current.app === ev.app && ev.ts - current.lastOpen < REOPEN_MERGE_MS) {
        current.lastOpen = ev.ts;
        continue;
      }
      // You can only be in one app at a time: a new open ends the previous one.
      if (current) close(ev.ts);
      current = { app: ev.app, start: ev.ts, lastOpen: ev.ts };
    } else if (ev.type === "close") {
      if (current && current.app === ev.app) close(ev.ts);
    }
  }

  if (current) {
    const ongoing = now - current.start < MAX_SESSION_MS;
    sessions.push({
      app: current.app,
      start: current.start,
      end: ongoing ? now : current.start + MAX_SESSION_MS,
      ongoing,
    });
  }
  return sessions;
}

export function minutes(ms) {
  return Math.round(ms / MIN);
}

function appInfo(settings, name) {
  return (
    settings.apps.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? {
      name,
      category: "neutral",
      dailyLimitMin: 0,
    }
  );
}

// Stats for one local calendar day. Sessions count toward the day they start.
export function dayStats(sessions, dateKey, settings) {
  const tz = settings.timezone;
  const byApp = new Map();
  let lateNightMs = 0;
  const [bh, bm] = String(settings.bedtime || "23:30").split(":").map(Number);
  const bedtimeMin = (bh || 0) * 60 + (bm || 0);

  for (const s of sessions) {
    if (localDateKey(s.start, tz) !== dateKey) continue;
    const info = appInfo(settings, s.app);
    const row = byApp.get(info.name) ?? {
      app: info.name,
      category: info.category,
      limitMin: info.dailyLimitMin,
      ms: 0,
      opens: 0,
      longestMs: 0,
    };
    const dur = s.end - s.start;
    row.ms += dur;
    row.opens += 1;
    row.longestMs = Math.max(row.longestMs, dur);
    byApp.set(info.name, row);

    const t = localTime(s.start, tz).minutesOfDay;
    if (info.category === "distraction" && (t >= bedtimeMin || t < 5 * 60)) lateNightMs += dur;
  }

  const apps = [...byApp.values()]
    .map((r) => ({
      app: r.app,
      category: r.category,
      limitMin: r.limitMin,
      minutes: minutes(r.ms),
      opens: r.opens,
      longestMin: minutes(r.longestMs),
      overLimit: r.limitMin > 0 && minutes(r.ms) > r.limitMin,
    }))
    .sort((a, b) => b.minutes - a.minutes);

  const sum = (cat) => apps.filter((a) => a.category === cat).reduce((n, a) => n + a.minutes, 0);
  return {
    date: dateKey,
    apps,
    distractionMin: sum("distraction"),
    productiveMin: sum("productive"),
    neutralMin: sum("neutral"),
    lateNightDistractionMin: minutes(lateNightMs),
  };
}

export function lastNDays(now, n, timeZone) {
  const keys = [];
  const seen = new Set();
  // Step back in 12h increments so DST shifts never skip a day.
  for (let t = now; keys.length < n; t -= 12 * 60 * MIN) {
    const k = localDateKey(t, timeZone);
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return keys.reverse();
}

// Everything the coach (and the dashboard) needs, in one object.
export function snapshot(store, now = Date.now()) {
  const settings = store.settings;
  const tz = settings.timezone;
  const sessions = buildSessions(store.events, now);
  const days = lastNDays(now, 7, tz).map((k) => dayStats(sessions, k, settings));
  const today = days[days.length - 1];

  const last = sessions[sessions.length - 1];
  const current =
    last && last.ongoing
      ? { app: last.app, category: appInfo(settings, last.app).category, minutes: minutes(now - last.start) }
      : null;

  const hourAgo = now - 60 * MIN;
  const opensLastHour = {};
  for (const s of sessions) {
    if (s.start >= hourAgo) opensLastHour[s.app] = (opensLastHour[s.app] ?? 0) + 1;
  }

  const recent = sessions
    .filter((s) => localDateKey(s.start, tz) === today.date)
    .slice(-15)
    .map((s) => ({
      app: s.app,
      at: localTime(s.start, tz).label,
      minutes: minutes(s.end - s.start),
      ongoing: s.ongoing,
    }));

  const t = localTime(now, tz);
  return {
    now: { date: today.date, time: t.label, weekday: localWeekday(now, tz), timezone: tz },
    today,
    week: days,
    current,
    opensLastHour,
    recentSessions: recent,
    trackingSince: store.events.length ? localDateKey(store.events[0].ts, tz) : null,
  };
}
