# Live-testing the Overlord bot

Two ways to load `tampermonkey-overlord-bot.js` into a live game.

## A. Local dev server (recommended — no Cloudflare, fully self-contained)

OpenFront runs its game simulation **client-side**, so a Singleplayer game runs
entirely in the browser against bots/nations — perfect for validating the bot.

```bash
# 1. Start the dev client+server (client is served on http://localhost:9000)
SKIP_BROWSER_OPEN=true npm run dev

# 2. Build the unpacked extension wrapper (copies the userscript in)
dev/build-extension.sh

# 3. Launch Chrome with the extension loaded, pointed at the local client
google-chrome \
  --load-extension="$PWD/dev/overlord-extension" \
  --user-data-dir=/tmp/overlord-chrome \
  http://localhost:9000/
```

Then in the page: **Single Player → pick a map/difficulty → Start**. The Overlord
overlay appears top-right (goal, stats, threats, decisions). Hotkeys: `O` toggle
overlay, `B` toggle bot.

> The dev *server* logs some `/maps/*` 500s and "lobby polling" errors — those are
> for the server's auto-created *public* games and are unrelated to Singleplayer
> (the client loads maps from :9000 and runs core locally).

## B. Production (openfront.io) with Tampermonkey/Firefox

Install Tampermonkey (Chrome or Firefox), add `tampermonkey-overlord-bot.js`, then
open https://openfront.io. **Caveat:** the public site is behind Cloudflare bot
protection (Turnstile), so automated/headless play is blocked; this path is for a
human-driven browser session.

## The extension wrapper

`dev/overlord-extension/` is a minimal MV3 extension whose only job is to inject
the userscript at `document_start` in the page's `MAIN` world (so it can hook
`window.WebSocket` before the game connects and read the live `GameView`) — i.e.
exactly what Tampermonkey does, but reproducible from the CLI. `overlord.js` is a
generated copy of the root userscript (run `dev/build-extension.sh` after edits).
