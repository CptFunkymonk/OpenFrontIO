#!/usr/bin/env node
const http = require("http");
const WebSocket = require("ws");
const EXPR = process.argv[2];
http.get("http://127.0.0.1:9223/json", (res) => {
  let d = "";
  res.on("data", (c) => (d += c));
  res.on("end", () => {
    const page = JSON.parse(d).find(
      (t) => t.type === "page" && t.url.includes("localhost:9000"),
    );
    if (!page) { console.log("no page"); process.exit(1); }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: EXPR, returnByValue: true, awaitPromise: true } }));
    });
    ws.on("message", (m) => {
      const r = JSON.parse(m);
      if (r.id === 1) {
        console.log(JSON.stringify(r.result.result ? r.result.result.value : r.result));
        ws.close(); process.exit(0);
      }
    });
    setTimeout(() => process.exit(2), 10000);
  });
});
