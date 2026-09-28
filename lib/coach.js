// The coach itself: a chat that sees your usage, and short phone nudges.
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.COACH_MODEL || "claude-opus-5";
// On a safety decline, let the API retry on Anthropic's recommended fallback model.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
const HISTORY_MESSAGES = 40;
const NUDGE_TIMEOUT_MS = Number(process.env.NUDGE_TIMEOUT_MS || 12000);

let client;
function anthropic() {
  client ??= new Anthropic();
  return client;
}

export function systemPrompt(settings) {
  const apps = settings.apps
    .map((a) => `- ${a.name}: ${a.category}${a.dailyLimitMin ? `, daily limit ${a.dailyLimitMin} min` : ""}`)
    .join("\n");
  return `You are a personal life coach who lives in the user's phone. You can see how they use their iPhone: every time they open or close a tracked app (Rednote/Xiaohongshu, Douyin, Bilibili, YouTube and so on), an iOS Shortcut reports it to you. Your job is to help them notice where their time goes, spend less of it on mindless scrolling and entertainment, and more of it on what they say matters to them.

How to coach:
- Ground everything in the data. Each user message starts with a <usage_snapshot> of their real usage; quote concrete numbers ("42 min on Rednote across 9 opens today") instead of generalities.
- Be ${settings.coachStyle}. Never shame or lecture. Entertainment is fine when it is chosen; the problem is autopilot scrolling that crowds out sleep, goals and people.
- Be curious before prescribing: ask what they were looking for, how they felt after, what triggered the scroll (boredom, stress, avoiding a task, loneliness, tiredness).
- Offer small, specific next steps: a 10-minute task toward a goal, moving the app off the home screen, a phone-free window, charging the phone outside the bedroom.
- Help them set and revisit limits and goals. Celebrate improvement against previous days.
- Keep replies short and conversational, like texting a coach: usually 2-6 sentences. Use a short list only when giving a plan.
- Reply in the language the user writes in (for example, answer Chinese with Chinese).
- Usage data comes only from the apps their Shortcuts report, and a session is estimated from open/close events. If the data looks thin or odd, say so rather than over-interpreting it.
- You are not a therapist. If they mention self-harm, a crisis or serious mental-health struggles, respond with care and encourage them to reach out to people they trust or a local professional or hotline.

About the user:
- Name: ${settings.name || "(not given)"}
- Goals, in their words: ${settings.goals || "(not set yet; ask about them when it fits)"}
- Intended bedtime: ${settings.bedtime}
- Tracked apps:
${apps}`;
}

function snapshotBlock(snap) {
  return `<usage_snapshot>\n${JSON.stringify(snap)}\n</usage_snapshot>`;
}

function textOf(message) {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// Streams a chat reply. `onText` receives text deltas as they arrive.
// Returns the final reply text.
export async function chat({ store, snap, userText, onText }) {
  const history = store.chat.slice(-HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
  // The API needs history to start with a user turn.
  while (history.length && history[0].role !== "user") history.shift();

  const userContent = [
    { type: "text", text: snapshotBlock(snap) },
    { type: "text", text: userText },
  ];

  const stream = anthropic().beta.messages.stream({
    ...FALLBACK,
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    cache_control: { type: "ephemeral" },
    system: systemPrompt(store.settings),
    messages: [...history, { role: "user", content: userContent }],
  });

  stream.on("text", (delta) => onText?.(delta));
  const final = await stream.finalMessage();

  if (final.stop_reason === "refusal") {
    throw new Error("The coach couldn't answer that one. Try rephrasing.");
  }
  const reply = textOf(final);
  store.addChat(
    { role: "user", content: userContent, text: userText, ts: Date.now() },
    { role: "assistant", content: reply || "…", text: reply, ts: Date.now() },
  );
  return reply;
}

// Decide how loudly to react when an app is opened.
export function assessOpen(snap, settings, appName) {
  const app = snap.today.apps.find((a) => a.app.toLowerCase() === appName.toLowerCase());
  const info = settings.apps.find((a) => a.name.toLowerCase() === appName.toLowerCase());
  const category = info?.category ?? "neutral";
  const used = app?.minutes ?? 0;
  const limit = info?.dailyLimitMin ?? 0;
  const opensLastHour = snap.opensLastHour[info?.name ?? appName] ?? 0;

  const [bh, bm] = String(settings.bedtime || "23:30").split(":").map(Number);
  const [nh, nm] = snap.now.time.split(":").map(Number);
  const nowMin = nh * 60 + nm;
  const lateNight = nowMin >= bh * 60 + (bm || 0) || nowMin < 5 * 60;

  const reasons = [];
  if (category === "distraction") {
    if (limit && used >= limit) reasons.push(`over today's ${limit}-min limit (${used} min used)`);
    else if (limit && used >= limit * 0.8) reasons.push(`close to today's ${limit}-min limit (${used} min used)`);
    if (opensLastHour >= 5) reasons.push(`opened ${opensLastHour} times in the last hour`);
    if (lateNight) reasons.push(`it's ${snap.now.time}, past their ${settings.bedtime} bedtime`);
  }
  return {
    app: info?.name ?? appName,
    category,
    used,
    limit,
    level: reasons.length ? "warn" : category === "neutral" ? "none" : "info",
    reasons,
  };
}

export function templateNudge(a, language) {
  const zh = /chinese|中文/i.test(language);
  if (a.category === "productive") {
    return zh ? `📚 ${a.app}：今天已 ${a.used} 分钟，做得好！` : `📚 ${a.app}: ${a.used} min today. Nice choice.`;
  }
  if (a.category !== "distraction") return "";
  const budget = a.limit ? `${a.used}/${a.limit}` : `${a.used}`;
  if (a.level === "warn") {
    return zh
      ? `⏳ ${a.app}：今天已刷 ${budget} 分钟。现在真的想刷吗？`
      : `⏳ ${a.app}: ${budget} min today. Is this really what you want right now?`;
  }
  return zh
    ? `📱 ${a.app}：今天 ${budget} 分钟。这次打开是为了什么？`
    : `📱 ${a.app}: ${budget} min today. What are you opening it for?`;
}

// A one- or two-sentence notification for the moment the user opens an app.
export async function nudge({ store, snap, assessment }) {
  const settings = store.settings;
  const fallback = templateNudge(assessment, settings.language);
  if (assessment.level === "none") return "";
  if (assessment.level === "info") return settings.nudgeMode === "always" ? fallback : "";
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return fallback;

  try {
    const response = await anthropic().beta.messages.create(
      {
        ...FALLBACK,
        model: MODEL,
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        system: systemPrompt(settings),
        messages: [
          {
            role: "user",
            content: `${snapshotBlock(snap)}

[Automatic event, not typed by the user] They just opened ${assessment.app}. Why this matters: ${assessment.reasons.join("; ")}.
Write the lock-screen notification they will see right now: at most 2 short sentences, under 180 characters, in ${settings.language}. Mention one real number, then offer one concrete alternative or question. Plain text only, one emoji at most, no quotation marks.`,
          },
        ],
      },
      { timeout: NUDGE_TIMEOUT_MS, maxRetries: 0 },
    );
    if (response.stop_reason === "refusal") return fallback;
    return textOf(response) || fallback;
  } catch (err) {
    console.error("nudge failed, using template:", err.message);
    return fallback;
  }
}
