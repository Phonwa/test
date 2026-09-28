# AI Life Coach

A personal life coach that sees how you use your iPhone and helps you spend less time on autopilot scrolling (Rednote/小红书, Douyin, Bilibili, YouTube…) and more on what matters to you.

- **Watches your app use.** Each time you open or close a tracked app, an iOS Shortcuts automation reports it to your coach server.
- **Nudges you on the spot.** When you open Rednote, a notification shows how long you've spent there today. If you're over your limit, bingeing, or up past bedtime, Claude writes you a personal nudge instead.
- **Talks with you.** A chat you can add to your home screen. The coach sees your real numbers ("42 min on Rednote across 9 opens") and knows your goals, so it can help you understand why you scroll and what to do instead.
- **Shows your day.** Minutes per app against your limits, the last 7 days, time spent after bedtime, and today's sessions.

## How it works

```
iPhone                                   Your server (this repo)                Claude API
┌──────────────────────┐   open/close   ┌──────────────────────────┐   usage +  ┌────────┐
│ Shortcuts automation │ ─────────────▶ │ /api/event               │ ─────────▶ │ coach  │
│ "Rednote is opened"  │ ◀───────────── │  → sessions, daily stats │ ◀───────── │ reply  │
│  → Show Notification │   nudge text   │ /api/chat  (web app)     │            └────────┘
└──────────────────────┘                │ data/coach.json          │
┌──────────────────────┐   chat, stats  │                          │
│ Coach web app        │ ◀────────────▶ │                          │
│ (on home screen)     │                └──────────────────────────┘
└──────────────────────┘
```

iOS doesn't let other apps read Screen Time. The only reliable signal is Shortcuts' **App → Is Opened / Is Closed** automations, so the server estimates each session from those two events. If a "closed" event goes missing, the session is capped at 90 minutes, and opening another app ends the previous session.

## 1. Run the server

You need Node.js 20+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

On startup it prints the **access token** that your phone and the web app use. Set `COACH_TOKEN` to choose your own token; otherwise one is generated and saved to `data/token.txt`.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Needed for chat and AI nudges. Without it, nudges fall back to built-in templates. |
| `COACH_TOKEN` | generated | Shared secret for the phone and the web app |
| `COACH_MODEL` | `claude-opus-5` | Claude model used for chat and nudges |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where `coach.json` (settings, events, chat) is stored |

### Making it reachable from your phone

Your iPhone has to reach the server when an automation runs:

- **At home:** run it on a computer on the same Wi-Fi and use `http://<computer-ip>:3000`. Tracking stops when you leave home or the computer sleeps.
- **Everywhere (recommended):** deploy it to any host that runs Docker or Node with a persistent disk (Render, Railway, Fly.io, a small VPS). Use HTTPS, and mount a volume at `/data` so your history survives restarts.

```bash
docker build -t life-coach .
docker run -d -p 3000:3000 -v coach-data:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... -e COACH_TOKEN=pick-a-long-secret life-coach
```

## 2. Add the coach to your home screen

Open the server URL in Safari, enter the token, then tap **Share → Add to Home Screen**. In **Setup**, fill in your name, goals, bedtime, time zone and the daily limits you want for each app.

## 3. Connect your iPhone with Shortcuts

The **Setup** tab shows these URLs pre-filled with your server address and token. Tap one to copy it.

For each app you want to track (Rednote, Douyin, Bilibili, YouTube…):

1. **Shortcuts → Automation → + → App.** Choose the app, tick **Is Opened** only, and select **Run Immediately**.
2. Add **Get Contents of URL** with
   `https://YOUR-SERVER/api/event?token=YOUR-TOKEN&app=Rednote&type=open`
   and set **Method** to **POST** under *Show More*.
3. Add **If** *Contents of URL* **has any value**, and put **Show Notification** (showing *Contents of URL*) inside it.
4. Create a second automation for the same app with **Is Closed**, calling the same URL with `type=close`. It doesn't need a notification.

The `app=` name must match the name in the coach's app list (case doesn't matter). Apps the coach hasn't seen before are added automatically as "neutral" so you can categorise them later.

> Tip: you can select several apps in a single automation, but then the coach can't tell which one you opened. Use one pair of automations per app.

## Nudges

When you open an app, the server checks today's numbers:

| Situation | Response |
|---|---|
| Entertainment app, over or near (≥80%) its limit | AI nudge from Claude, e.g. *"⏳ 42 min on Rednote today, past your limit. 10 min of IELTS reading instead?"* |
| Opened 5+ times in the last hour | AI nudge |
| After your bedtime (until 5am) | AI nudge |
| Entertainment app, well under its limit | Short template: *"📱 Rednote: 12/30 min today. What are you opening it for?"* (only in "Every time" mode) |
| Productive app (Kindle, Duolingo…) | A short well-done note (only in "Every time" mode) |
| Neutral app (WeChat…) | Nothing |

If Claude takes longer than 12 seconds or fails, the template is used, so the Shortcut never hangs.

## Privacy

Everything (settings, every open/close event, the chat) is stored in one JSON file on **your** server. For a chat reply or an AI nudge, the server sends Claude a usage summary (today, the last 7 days, recent sessions), your goals and your messages. You can download everything or clear the chat in **Setup → Your data**.

The access token protects the API, and it appears inside your Shortcuts URLs, so treat it like a password. Use HTTPS whenever the server is reachable from the internet.

## Development

```bash
npm test        # unit tests for session building, stats and nudge rules
```

- `server.js`: HTTP server, routes and auth
- `lib/usage.js`: turns open/close events into sessions and daily stats (time-zone aware)
- `lib/coach.js`: the coach prompt, streaming chat and nudges (Anthropic SDK)
- `lib/store.js`: JSON-file persistence and settings
- `public/`: the web app (plain HTML/CSS/JS, no build step)
