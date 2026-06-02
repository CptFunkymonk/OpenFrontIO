const http = require("http");
const WebSocket = require("ws");
const EXPR = `(function(){
  var r=window.__overlordBotRuntime; if(!r) return "NO RUNTIME";
  var w=r.world||{}; var t=w.threats||{}; var me=w.me||{};
  return JSON.stringify({
    goal:r.planner.activeGoalId, isLocal:r.hooks.isLocal, hasGV:!!r.hooks.gameView,
    tick:w.tick, intentsSent:r.state.intentsSent, intentsConfirmed:r.state.intentsConfirmed,
    myShare:w.totals&&w.totals.myShare, crownShare:w.totals&&w.totals.crownShare,
    alive:w.totals&&w.totals.alivePlayers,
    meTiles:me.tiles, meTroops:me.troops, meMax:me.maxTroops, meRatio:me.troopRatio, meGold:me.gold,
    incoming:me.incomingTroops, outgoing:me.outgoingTroops,
    activeInvaders:(t.activeInvaders||[]).length, brewing:(t.brewingInvaders||[]).length,
    coalition:t.coalitionAgainstMe, adjacent:(t.adjacentEnemies||[]).length,
    earlyOvermatch: t.earlyHumanOvermatch? t.earlyHumanOvermatch.ratio : null,
    bordersTN: w.scan && w.scan.bordersTN,
    decisions: r.state.decisionLog.slice(-12)
  });
})()`;
http.get("http://127.0.0.1:9222/json", (r) => {
  let d = ""; r.on("data", (c) => (d += c));
  r.on("end", () => {
    const pages = JSON.parse(d).filter((t) => t.type === "page");
    const page = pages.find((t) => t.url.includes("/game/")) || pages[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0;
    ws.on("open", () => { id++; ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: EXPR, returnByValue: true } })); });
    ws.on("message", (m) => { const x = JSON.parse(m); console.log((x.result && x.result.result && x.result.result.value) || JSON.stringify(x)); ws.close(); process.exit(0); });
  });
});
setTimeout(() => process.exit(1), 8000);
