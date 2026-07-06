#!/usr/bin/env node
/*
 * Persistent CDP injector for local live-testing of the SUPERHUMAN bot.
 *
 * Same mechanism as inject-overlord.cjs: connects to a Chrome instance
 * started with --remote-debugging-port and keeps
 * tampermonkey-superhuman-bot.js injected into the OpenFront page at
 * document-start (MAIN world) across reloads/navigations — which matters
 * for the v2.16 auto-queue flow, where the bot navigates match → homepage
 * → next match and must re-attach on every page.
 *
 * Usage:
 *   DISPLAY=:1 google-chrome --no-sandbox --remote-debugging-port=9223 \
 *     --user-data-dir=/tmp/superbot-chrome http://localhost:9000/ &
 *   node dev/inject-superbot.cjs [debugPort=9223] [urlSubstr=localhost:9000]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.argv[2] || "9223";
const URL_MATCH = process.argv[3] || "localhost:9000";
const SRC = fs.readFileSync(
  path.resolve(__dirname, "..", "tampermonkey-superhuman-bot.js"),
  "utf8",
);

function getPage() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}/json`, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            const page = JSON.parse(d).find(
              (t) => t.type === "page" && (t.url || "").includes(URL_MATCH),
            );
            resolve(page || null);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function main() {
  let page = null;
  for (let i = 0; i < 30 && !page; i++) {
    page = await getPage().catch(() => null);
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!page) {
    console.error("No matching page found on :" + PORT);
    process.exit(1);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params) => {
    id++;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return id;
  };
  const inject = () =>
    send("Runtime.evaluate", {
      expression:
        "if(!window.__superhumanBotRuntime){" + SRC + "\n}",
      returnByValue: false,
    });

  ws.on("open", () => {
    send("Page.enable");
    send("Runtime.enable");
    // document-start injection for future navigations
    send("Page.addScriptToEvaluateOnNewDocument", { source: SRC });
    // and inject into the current document immediately
    inject();
    console.log("[injector] attached + injected into", page.url);
  });
  ws.on("message", (m) => {
    const r = JSON.parse(m);
    // Re-inject after every navigation/load just in case.
    if (r.method === "Page.loadEventFired" || r.method === "Page.frameNavigated") {
      setTimeout(inject, 300);
    }
  });
  ws.on("close", () => {
    console.log("[injector] disconnected; reconnecting in 2s");
    setTimeout(main, 2000);
  });
  ws.on("error", (e) => {
    console.error("[injector] error", e.message);
    try { ws.close(); } catch (_) {}
  });
}
main();
