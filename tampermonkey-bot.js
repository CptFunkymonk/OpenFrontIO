// ==UserScript==
// @name         OpenFront.io AI Opponent Bot
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  Autonomous AI bot for OpenFront.io with full game-state awareness and strategic decision-making
// @author       OpenFront Bot
// @match        https://openfront.io/*
// @match        http://localhost:*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════
  //  CONSTANTS & ENUMS (mirrored from src/core/game/Game.ts)
  // ═══════════════════════════════════════════════════════════════════════

  const BOT_VERSION = "1.2.0";

  const UnitType = Object.freeze({
    TransportShip: "Transport",
    Warship: "Warship",
    Shell: "Shell",
    SAMMissile: "SAMMissile",
    Port: "Port",
    AtomBomb: "Atom Bomb",
    HydrogenBomb: "Hydrogen Bomb",
    TradeShip: "Trade Ship",
    MissileSilo: "Missile Silo",
    DefensePost: "Defense Post",
    SAMLauncher: "SAM Launcher",
    City: "City",
    MIRV: "MIRV",
    MIRVWarhead: "MIRV Warhead",
    Train: "Train",
    Factory: "Factory",
  });

  const STRUCTURES = new Set([
    UnitType.City,
    UnitType.DefensePost,
    UnitType.SAMLauncher,
    UnitType.MissileSilo,
    UnitType.Port,
    UnitType.Factory,
  ]);

  const NUKE_TYPES = new Set([
    UnitType.AtomBomb,
    UnitType.HydrogenBomb,
    UnitType.MIRV,
    UnitType.MIRVWarhead,
  ]);

  // Cost helpers mirrored from DefaultConfig.ts
  function cityCost(numCities) {
    return Math.min(1_000_000, Math.pow(2, numCities) * 125_000);
  }
  function defensePostCost(numDP) {
    return Math.min(250_000, (numDP + 1) * 50_000);
  }
  function samCost(numSAM) {
    return Math.min(3_000_000, (numSAM + 1) * 1_500_000);
  }
  function warshipCost(numWarships) {
    return Math.min(1_000_000, (numWarships + 1) * 250_000);
  }

  const ATOM_COST = 750_000;
  const HYDROGEN_COST = 5_000_000;
  const SILO_COST = 1_000_000;
  const STRUCTURE_MIN_DIST = 15;

  // ═══════════════════════════════════════════════════════════════════════
  //  TROOP MATH — derived from DefaultConfig.ts attackLogic()
  //
  //  PvP attacker loss per tile:
  //    clamp(defTroops / atkTroops, 0.6, 2) * mag * 0.8 * debuffs
  //  The clamp ratio bottoms out at 0.6 when atkTroops >= defTroops/0.6
  //  i.e. when atkTroops >= ~1.67x defender troops.
  //
  //  PvP tiles-per-tick cost:
  //    clamp(defTroops / (5 * atkTroops), 0.2, 1.5) * speed * debuffs
  //  Conquest speed maxes out when atkTroops >= defTroops/1.0
  //  (at that point the term becomes 0.2, the minimum).
  //
  //  TerraNullius attacker loss per tile:
  //    mag/5 = 16 on plains (constant — does not depend on troop count)
  //  TerraNullius tiles-per-tick cost:
  //    clamp(33000 / atkTroops, 5, 100)
  //  More troops → faster expansion with the same flat loss per tile.
  //
  //  KEY INSIGHT: Attacks to the same target auto-merge (AttackExecution
  //  init() combines outgoing attacks to the same target). So sending
  //  multiple smaller attacks is fine — they become one big attack.
  //
  //  OPTIMAL RATIOS:
  //  - vs TerraNullius: send as many as possible above reserve — speed
  //    scales linearly with troops, loss is flat.
  //  - vs Player: send >= 1.67x their troops to minimise the loss
  //    multiplier. Below that, loss per tile rises steeply.
  //  - Minimum useful PvP attack: ~0.5x defender troops (below this,
  //    loss multiplier caps at 2x and speed collapses).
  // ═══════════════════════════════════════════════════════════════════════

  function calcOptimalAttackTroops(myTroops, myMaxTroops, defenderTroops, reserveRatio) {
    const reserve = myMaxTroops * reserveRatio;
    const available = myTroops - reserve;
    if (available <= 0) return { troops: 0, reason: "below reserve" };

    if (defenderTroops <= 0) {
      // TerraNullius: send everything above reserve for max speed
      return { troops: Math.floor(available), reason: "TN: all available (flat loss)" };
    }

    // Ideal: 1.67x defender troops gives minimum loss multiplier (0.6)
    const ideal = Math.ceil(defenderTroops * 1.67);
    // Strong: 1.0x gives near-max conquest speed
    const strong = Math.ceil(defenderTroops * 1.0);
    // Minimum viable: 0.5x — below this, loss multiplier is capped at 2x
    const minViable = Math.ceil(defenderTroops * 0.5);

    if (available >= ideal) {
      // Send the ideal amount, keep the rest growing
      const send = Math.min(available, Math.max(ideal, Math.floor(available * 0.8)));
      return { troops: Math.floor(send), reason: "optimal (1.67x def, loss mult 0.6)" };
    }
    if (available >= strong) {
      return { troops: Math.floor(available), reason: "strong (1x+ def, fast conquest)" };
    }
    if (available >= minViable) {
      return { troops: Math.floor(available), reason: "viable (0.5x+ def, high loss)" };
    }
    // Below minimum viable — still send if we have any margin
    if (available > 1000) {
      return { troops: Math.floor(available), reason: "weak (" + (available / defenderTroops * 100).toFixed(0) + "% def, max loss)" };
    }
    return { troops: 0, reason: "insufficient (" + fmt(available) + " vs " + fmt(defenderTroops) + " def)" };
  }

  function calcExpandTroops(myTroops, myMaxTroops, reserveRatio) {
    // TerraNullius: flat 16 loss/tile on plains, speed = clamp(33000/troops, 5, 100)
    // At 6600 troops: speed = 5 (fastest). Below: speed rises = slower.
    // So we want at least 6600 troops for max expansion speed.
    const reserve = myMaxTroops * reserveRatio;
    const available = myTroops - reserve;
    if (available <= 0) return { troops: 0, reason: "below reserve" };

    // Send enough for fast expansion but keep reserve intact
    // Since attacks merge, we can send smaller repeated waves safely
    const send = Math.max(500, Math.floor(available * 0.35));
    const speedEstimate = Math.min(100, Math.max(5, 33000 / send));
    return {
      troops: send,
      reason: "expand " + fmt(send) + " (speed~" + speedEstimate.toFixed(0) + " tiles/tick cost)"
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  BOT STATE
  // ═══════════════════════════════════════════════════════════════════════

  const bot = {
    enabled: true,
    socket: null,
    gameView: null,
    myClientID: null,
    gameStarted: false,
    spawned: false,
    tick: 0,

    // Cooldown tracking (in ticks)
    lastAttackTick: -999,
    lastExpandTick: -999,
    lastBoatTick: -999,
    lastBuildTick: -999,
    lastNukeTick: -999,
    lastAllianceTick: -999,
    lastUpgradeTick: -999,

    // Adaptive parameters
    attackRate: 15,
    expandRate: 8,
    reserveRatio: 0.30,
    expandReserve: 0.15,

    // Intent tracking
    intentsSent: 0,
    intentsConfirmed: 0,
    lastSentIntentTypes: [],

    log: [],
    decisionLog: [],
    currentAction: "Initializing...",
    strategy: "Waiting for game",
    statsSnapshot: null,
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  LOGGING — two channels: action log (what happened) and decision log
  //  (why the bot chose what it did, including skipped branches)
  // ═══════════════════════════════════════════════════════════════════════

  function botLog(msg) {
    const ts = new Date().toLocaleTimeString();
    bot.log.push("[" + ts + "] " + msg);
    if (bot.log.length > 400) bot.log.shift();
    console.log("[OFBot] " + msg);
  }

  function decisionLog(msg) {
    const entry = "T" + bot.tick + " " + msg;
    bot.decisionLog.push(entry);
    if (bot.decisionLog.length > 200) bot.decisionLog.shift();
    console.log("[OFBot:decision] " + entry);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  WEBSOCKET INTERCEPTION
  //  We hook the native WebSocket to capture the game-protocol socket.
  //  The game connects to a path like /w/<gameID> for the game itself;
  //  lobby/matchmaking sockets are excluded.
  // ═══════════════════════════════════════════════════════════════════════

  const NativeWebSocket = window.WebSocket;

  window.WebSocket = function (url, protocols) {
    const ws = protocols
      ? new NativeWebSocket(url, protocols)
      : new NativeWebSocket(url);

    const urlStr = typeof url === "string" ? url : url.toString();
    const isGameSocket =
      !urlStr.includes("/lobbies") && !urlStr.includes("/matchmaking");

    if (isGameSocket) {
      botLog("Game socket intercepted: " + urlStr);
      bot.socket = ws;

      ws.addEventListener("message", function (event) {
        try {
          handleServerMessage(JSON.parse(event.data));
        } catch (_) {
          /* binary / non-JSON frame */
        }
      });

      ws.addEventListener("close", function () {
        if (bot.socket === ws) {
          bot.socket = null;
          bot.gameStarted = false;
          botLog("Game socket closed");
        }
      });
    }

    return ws;
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  Object.defineProperty(window.WebSocket, "CONNECTING", {
    value: NativeWebSocket.CONNECTING,
  });
  Object.defineProperty(window.WebSocket, "OPEN", {
    value: NativeWebSocket.OPEN,
  });
  Object.defineProperty(window.WebSocket, "CLOSING", {
    value: NativeWebSocket.CLOSING,
  });
  Object.defineProperty(window.WebSocket, "CLOSED", {
    value: NativeWebSocket.CLOSED,
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  GAME VIEW DISCOVERY
  //  The client creates a GameView that is passed to the GameRenderer.
  //  We hook HTMLCanvasElement.getContext so that when the renderer grabs
  //  a 2D context we can later walk its owner to find the GameView.
  //  As a backup we also poll for the GameView via internal module caches.
  // ═══════════════════════════════════════════════════════════════════════

  let discoveredGameView = null;

  function findGameView() {
    if (discoveredGameView) {
      // Validate it's still alive
      try {
        discoveredGameView.ticks();
        return discoveredGameView;
      } catch (_) {
        discoveredGameView = null;
      }
    }

    // Strategy: The GameRenderer stores `game: GameView` as a private field.
    // Lit components or Pixi containers may also hold references.
    // We walk live objects reachable from the DOM.

    // Try 1: Look for the game canvas element and inspect __pixi or similar
    try {
      const canvases = document.querySelectorAll("canvas");
      for (const c of canvases) {
        // Walk properties that Vite/bundler might have attached
        for (const key of Object.keys(c)) {
          const val = c[key];
          if (val && typeof val === "object" && typeof val.ticks === "function" && typeof val.myPlayer === "function") {
            discoveredGameView = val;
            botLog("GameView found via canvas property");
            return val;
          }
        }
      }
    } catch (_) {}

    // Try 2: Scan for exported module references on window
    try {
      for (const key of ["__gameView", "gameView", "__gv"]) {
        if (window[key] && typeof window[key].ticks === "function") {
          discoveredGameView = window[key];
          botLog("GameView found on window." + key);
          return window[key];
        }
      }
    } catch (_) {}

    // Try 3: Search all reachable objects from Lit elements
    try {
      const els = document.querySelectorAll("*");
      for (const el of els) {
        // Check shadow roots and regular properties up to 2 levels
        const sources = [el];
        if (el.shadowRoot) sources.push(el.shadowRoot);
        for (const src of sources) {
          for (const k of Object.getOwnPropertyNames(src)) {
            try {
              const v = src[k];
              if (v && typeof v === "object") {
                // Direct GameView
                if (typeof v.ticks === "function" && typeof v.myPlayer === "function" && typeof v.playerViews === "function") {
                  discoveredGameView = v;
                  botLog("GameView found via DOM element");
                  return v;
                }
                // One level deeper (e.g. gameRunner.gameView)
                if (typeof v.gameView === "object" && v.gameView && typeof v.gameView.ticks === "function") {
                  discoveredGameView = v.gameView;
                  botLog("GameView found via nested property");
                  return v.gameView;
                }
              }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  INTENT HELPERS — send JSON messages over the game WebSocket
  //  Every send is logged so we can see exactly what the bot is doing.
  // ═══════════════════════════════════════════════════════════════════════

  function sendRaw(obj) {
    if (!bot.socket) {
      decisionLog("SEND FAIL: no socket reference");
      return false;
    }
    if (bot.socket.readyState !== NativeWebSocket.OPEN) {
      decisionLog("SEND FAIL: socket not OPEN (state=" + bot.socket.readyState + ")");
      return false;
    }
    bot.socket.send(JSON.stringify(obj));
    return true;
  }

  function sendIntent(intent) {
    if (!bot.enabled) {
      decisionLog("SEND SKIP: bot disabled");
      return false;
    }
    const ok = sendRaw({ type: "intent", intent });
    if (ok) {
      bot.intentsSent++;
      bot.lastSentIntentTypes.push(intent.type);
      if (bot.lastSentIntentTypes.length > 30) bot.lastSentIntentTypes.shift();
      decisionLog("SENT intent: " + intent.type + " " + JSON.stringify(intent).substring(0, 120));
    }
    return ok;
  }

  // Typed intent senders
  function doAttack(targetID, troops) {
    const t = Math.max(1, Math.floor(troops));
    decisionLog("doAttack → target=" + (targetID || "TerraNullius") + " troops=" + fmt(t));
    if (sendIntent({ type: "attack", targetID, troops: t })) {
      bot.lastAttackTick = bot.tick;
      if (targetID === null) bot.lastExpandTick = bot.tick;
      return true;
    }
    return false;
  }

  function doBoatAttack(dstTile, troops) {
    if (sendIntent({ type: "boat", troops: Math.max(1, Math.floor(troops)), dst: dstTile })) {
      bot.lastBoatTick = bot.tick;
      return true;
    }
    return false;
  }

  function doBuild(unit, tile, rocketDirUp) {
    const intent = { type: "build_unit", unit, tile };
    if (rocketDirUp !== undefined) intent.rocketDirectionUp = rocketDirUp;
    if (sendIntent(intent)) {
      bot.lastBuildTick = bot.tick;
      return true;
    }
    return false;
  }

  function doUpgrade(unitId, unitType) {
    if (sendIntent({ type: "upgrade_structure", unit: unitType, unitId })) {
      bot.lastUpgradeTick = bot.tick;
      return true;
    }
    return false;
  }

  function doAllianceRequest(recipientID) {
    if (sendIntent({ type: "allianceRequest", recipient: recipientID })) {
      bot.lastAllianceTick = bot.tick;
      return true;
    }
    return false;
  }

  function doBreakAlliance(recipientID) {
    return sendIntent({ type: "breakAlliance", recipient: recipientID });
  }

  function doEmbargo(targetID, action) {
    return sendIntent({ type: "embargo", targetID, action });
  }

  function doDonateTroops(recipientID, troops) {
    return sendIntent({ type: "donate_troops", recipient: recipientID, troops: Math.floor(troops) });
  }

  function doDonateGold(recipientID, gold) {
    return sendIntent({ type: "donate_gold", recipient: recipientID, gold: Math.floor(gold) });
  }

  function doTargetPlayer(targetID) {
    return sendIntent({ type: "targetPlayer", target: targetID });
  }

  function doMoveWarship(unitId, tile) {
    return sendIntent({ type: "move_warship", unitId, tile });
  }

  function doCancelAttack(attackID) {
    return sendIntent({ type: "cancel_attack", attackID });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  SERVER MESSAGE HANDLER
  // ═══════════════════════════════════════════════════════════════════════

  function handleServerMessage(data) {
    if (data.type === "lobby_info") {
      bot.myClientID = data.myClientID;
      botLog("Assigned clientID: " + bot.myClientID);
    } else if (data.type === "start") {
      bot.gameStarted = true;
      bot.spawned = false;
      bot.tick = 0;
      bot.myClientID = data.myClientID || bot.myClientID;
      botLog("Game started! myClientID=" + bot.myClientID);
    } else if (data.type === "turn") {
      bot.tick = data.turn.turnNumber;
      // Track our own intents appearing in turns (confirms server received them)
      if (data.turn.intents) {
        for (const intent of data.turn.intents) {
          if (intent.clientID === bot.myClientID) {
            bot.intentsConfirmed++;
            decisionLog("CONFIRMED intent in turn: " + intent.type);
            if (intent.type === "spawn") {
              bot.spawned = true;
              botLog("Spawned successfully!");
            }
          }
        }
      }
      // Run the AI brain on every turn
      if (bot.enabled && bot.gameStarted) {
        try { runAI(); } catch (e) {
          console.error("[OFBot] AI error:", e);
          decisionLog("AI ERROR: " + e.message);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  GAME STATE READERS  (extract data from live GameView)
  // ═══════════════════════════════════════════════════════════════════════

  function gv() {
    if (!bot.gameView) bot.gameView = findGameView();
    return bot.gameView;
  }

  function me() {
    const g = gv();
    if (!g) return null;
    try {
      const p = g.myPlayer();
      return p && p.isAlive() ? p : null;
    } catch (_) { return null; }
  }

  function allPlayers() {
    const g = gv();
    if (!g) return [];
    try { return g.playerViews().filter(p => p.isAlive()); } catch (_) { return []; }
  }

  function enemies() {
    const myP = me();
    if (!myP) return [];
    return allPlayers().filter(p => {
      if (p.smallID() === myP.smallID()) return false;
      try { return !myP.isFriendly(p); } catch (_) { return true; }
    });
  }

  function allies() {
    const myP = me();
    if (!myP) return [];
    return allPlayers().filter(p => {
      if (p.smallID() === myP.smallID()) return false;
      try { return myP.isFriendly(p); } catch (_) { return false; }
    });
  }

  function myUnits(...types) {
    const g = gv();
    const myP = me();
    if (!g || !myP) return [];
    try {
      const all = types.length > 0 ? g.units(...types) : g.units();
      return all.filter(u => u.isActive() && u.owner().smallID() === myP.smallID());
    } catch (_) { return []; }
  }

  function myStructures() {
    return myUnits().filter(u => STRUCTURES.has(u.type()));
  }

  function countMyUnits(type) {
    return myUnits(type).length;
  }

  function myTroops() {
    const p = me(); return p ? p.troops() : 0;
  }

  function myGold() {
    const p = me(); return p ? Number(p.gold()) : 0;
  }

  function myTiles() {
    const p = me(); return p ? p.numTilesOwned() : 0;
  }

  function maxTroopsEstimate() {
    const tiles = myTiles();
    const cityLevels = myUnits(UnitType.City)
      .filter(u => !u.isUnderConstruction())
      .reduce((s, u) => s + u.level(), 0);
    return 2 * (Math.pow(tiles, 0.6) * 1000 + 50000) + cityLevels * 250_000;
  }

  function troopRatio() {
    const max = maxTroopsEstimate();
    return max > 0 ? myTroops() / max : 0;
  }

  /** Pick a random tile within our territory. */
  function randomOwnedTile(attempts) {
    const g = gv();
    const myP = me();
    if (!g || !myP) return null;
    const w = g.width();
    const h = g.height();
    const sid = myP.smallID();
    for (let i = 0; i < (attempts || 150); i++) {
      const x = Math.floor(Math.random() * w);
      const y = Math.floor(Math.random() * h);
      if (!g.isValidCoord(x, y)) continue;
      const ref = g.ref(x, y);
      if (!g.isLand(ref)) continue;
      if (g.ownerID(ref) !== sid) continue;
      return ref;
    }
    return null;
  }

  /** Pick a random tile within our territory that is far enough from existing structures. */
  function findBuildTile(minDist) {
    const g = gv();
    if (!g) return null;
    const existing = myStructures();
    for (let attempt = 0; attempt < 200; attempt++) {
      const tile = randomOwnedTile(1);
      if (tile === null) continue;
      let ok = true;
      for (const s of existing) {
        try {
          if (g.manhattanDist(tile, s.tile()) < (minDist || STRUCTURE_MIN_DIST)) {
            ok = false;
            break;
          }
        } catch (_) {}
      }
      if (ok) return tile;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  AI BRAIN — runs every turn (100ms)
  //  Expansion and combat are checked EVERY tick (separate cooldowns).
  //  Economy/diplomacy/nukes/naval rotate on remaining ticks.
  // ═══════════════════════════════════════════════════════════════════════

  function runAI() {
    const g = gv();
    if (!g) {
      bot.gameView = findGameView();
      if (!bot.gameView) {
        bot.currentAction = "Searching for GameView...";
        decisionLog("GameView not found yet");
      }
      return;
    }

    const myP = me();
    if (!myP) {
      bot.currentAction = "Waiting for player (GameView found but myPlayer is null)";
      bot.strategy = "Pre-game";
      decisionLog("myPlayer() returned null — not spawned or dead");
      return;
    }

    bot.spawned = true;

    // Snapshot stats for UI
    const troops = myTroops();
    const gold = myGold();
    const tiles = myTiles();
    const maxT = maxTroopsEstimate();
    const ratio = maxT > 0 ? troops / maxT : 0;
    const enems = enemies();
    const alls = allies();
    const structs = myStructures();
    const outAtk = myP.outgoingAttacks();
    const inAtk = myP.incomingAttacks();

    bot.statsSnapshot = {
      troops, gold, tiles, maxTroops: maxT,
      structures: structs.length,
      allies: alls.length,
      enemies: enems.length,
      outgoingAttacks: outAtk.length,
      incomingAttacks: inAtk.length,
      troopRatio: ratio,
      intentsSent: bot.intentsSent,
      intentsConfirmed: bot.intentsConfirmed,
    };

    // Log a diagnostic snapshot every 50 ticks
    if (bot.tick % 50 === 0) {
      decisionLog(
        "SNAPSHOT: troops=" + fmt(troops) + " max=" + fmt(maxT) +
        " ratio=" + (ratio * 100).toFixed(0) + "%" +
        " gold=" + fmt(gold) + " tiles=" + fmt(tiles) +
        " structs=" + structs.length +
        " enemies=" + enems.length + " allies=" + alls.length +
        " outAtk=" + outAtk.length + " inAtk=" + inAtk.length +
        " sent=" + bot.intentsSent + " confirmed=" + bot.intentsConfirmed
      );
      // Log optimal attack analysis for each enemy
      if (enems.length > 0) {
        const top = [...enems].sort((a, b) => a.troops() - b.troops()).slice(0, 3);
        for (const e of top) {
          const calc = calcOptimalAttackTroops(troops, maxT, e.troops(), bot.reserveRatio);
          const atkRatio = e.troops() > 0 ? (calc.troops / e.troops()).toFixed(2) : "inf";
          decisionLog(
            "  vs " + safePlayerName(e) + ": def=" + fmt(e.troops()) +
            " → send=" + fmt(calc.troops) + " (" + atkRatio + "x) [" + calc.reason + "]"
          );
        }
      }
    }

    // ── EXPANSION: checked every tick on its own cooldown ──
    aiExpand(troops, maxT, ratio);

    // ── COMBAT: checked every tick on its own cooldown ──
    aiCombat(troops, maxT, ratio, enems, inAtk);

    // ── SECONDARY SYSTEMS: rotate through remaining phases ──
    const phase = bot.tick % 4;
    switch (phase) {
      case 0: aiEconomy(); break;
      case 1: aiDiplomacy(); break;
      case 2: aiNukes(); break;
      case 3: aiNaval(); break;
    }

    // Adaptive parameters every tick
    aiAdaptParameters(ratio);
  }

  // ──────────────────────────────────────────────────────────────────────
  //  EXPANSION — conquer unowned (TerraNullius) land
  //  This is the #1 priority — always grow. Checked every tick.
  //  Sends attack with targetID=null which the server maps to TerraNullius.
  // ──────────────────────────────────────────────────────────────────────

  function aiExpand(troops, maxT, ratio) {
    const expandCd = bot.tick - bot.lastExpandTick;
    if (expandCd < bot.expandRate) return;

    const calc = calcExpandTroops(troops, maxT, bot.expandReserve);
    if (calc.troops <= 0) {
      decisionLog("EXPAND SKIP: " + calc.reason + " (troops=" + fmt(troops) + " max=" + fmt(maxT) + " ratio=" + (ratio * 100).toFixed(0) + "%)");
      return;
    }

    bot.strategy = "Expansion";
    bot.currentAction = "Expanding → " + fmt(calc.troops) + " troops";
    if (doAttack(null, calc.troops)) {
      botLog("Expand → " + fmt(calc.troops) + " [" + calc.reason + "]");
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  //  COMBAT — land attacks against other players
  //  Runs every tick on its own cooldown (separate from expansion).
  //  Priority: retaliate > veryWeak > traitor > AFK > victim > weakest
  // ──────────────────────────────────────────────────────────────────────

  function aiCombat(troops, maxT, ratio, enems, incomingAttacks) {
    const combatCd = bot.tick - bot.lastAttackTick;
    if (combatCd < bot.attackRate) return;

    if (enems.length === 0) {
      decisionLog("COMBAT: no enemies alive");
      bot.currentAction = "No enemies — expanding only";
      return;
    }

    decisionLog(
      "COMBAT EVAL: troops=" + fmt(troops) + " maxT=" + fmt(maxT) +
      " ratio=" + (ratio * 100).toFixed(0) + "% enemies=" + enems.length +
      " incoming=" + incomingAttacks.length
    );

    // Sort enemies weakest first
    const sorted = [...enems].sort((a, b) => a.troops() - b.troops());
    const enemyInfo = sorted.slice(0, 5).map(e => {
      const defT = e.troops();
      const calc = calcOptimalAttackTroops(troops, maxT, defT, bot.reserveRatio);
      return safePlayerName(e) + ":" + fmt(defT) + " →" + fmt(calc.troops) + "(" + calc.reason.split("(")[0].trim() + ")";
    }).join(" | ");
    decisionLog("COMBAT targets: " + enemyInfo);

    // Helper: attempt an attack against a target using optimal troop math
    function tryAttack(target, label, strategyName) {
      const defTroops = target.troops();
      const calc = calcOptimalAttackTroops(troops, maxT, defTroops, bot.reserveRatio);
      decisionLog(
        label + ": " + safePlayerName(target) +
        " def=" + fmt(defTroops) + " → send=" + fmt(calc.troops) +
        " [" + calc.reason + "]"
      );
      if (calc.troops <= 0) {
        decisionLog(label + " SKIP: " + calc.reason);
        return false;
      }
      doAttack(target.id(), calc.troops);
      bot.currentAction = strategyName + " " + safePlayerName(target) + " (" + fmt(calc.troops) + ")";
      bot.strategy = strategyName;
      botLog(strategyName + " → " + safePlayerName(target) + " " + fmt(calc.troops) + " [" + calc.reason + "]");
      return true;
    }

    // ── Strategy 1: Retaliate against incoming attacks ──
    if (incomingAttacks.length > 0) {
      const biggest = incomingAttacks.reduce(
        (a, b) => ((b.troops || 0) > (a.troops || 0) ? b : a),
        incomingAttacks[0]
      );
      if (biggest && biggest.attackerID) {
        try {
          const attacker = gv().playerBySmallID(biggest.attackerID);
          if (attacker && attacker.isPlayer && attacker.isPlayer()) {
            // Retaliation is urgent: send max available to counter
            const defTroops = attacker.troops();
            const calc = calcOptimalAttackTroops(troops, maxT, defTroops, bot.reserveRatio * 0.5);
            if (calc.troops > 0) {
              decisionLog(
                "RETALIATE: " + safePlayerName(attacker) +
                " def=" + fmt(defTroops) + " → " + fmt(calc.troops) + " [" + calc.reason + "]"
              );
              doAttack(attacker.id(), calc.troops);
              bot.currentAction = "RETALIATING vs " + safePlayerName(attacker);
              bot.strategy = "Retaliation";
              botLog("Retaliate → " + safePlayerName(attacker) + " " + fmt(calc.troops) + " [" + calc.reason + "]");
              return;
            }
          }
        } catch (e) { decisionLog("RETALIATE error: " + e.message); }
      }
    }

    // ── Strategy 2: Finish very weak enemies (post-nuke or collapsing) ──
    for (const e of sorted) {
      const eTroops = e.troops();
      if (eTroops < maxT * 0.15 && eTroops < troops * 1.2) {
        if (tryAttack(e, "WEAK TARGET", "Elimination")) return;
      }
    }

    // ── Strategy 3: Attack traitors ──
    for (const e of sorted) {
      try {
        if (e.isTraitor() && e.troops() < troops * 1.5) {
          if (tryAttack(e, "TRAITOR", "Punish Traitor")) return;
        }
      } catch (_) {}
    }

    // ── Strategy 4: Attack AFK (disconnected) players ──
    for (const e of sorted) {
      try {
        if (e.isDisconnected() && e.troops() < troops * 3) {
          if (tryAttack(e, "AFK", "AFK Cleanup")) return;
        }
      } catch (_) {}
    }

    // ── Strategy 5: Pile on enemies under heavy attack ──
    for (const e of sorted) {
      try {
        const eIn = e.incomingAttacks();
        if (eIn && eIn.length > 0) {
          const totalIncoming = eIn.reduce((s, a) => s + (a.troops || 0), 0);
          if (totalIncoming > e.troops() * 0.4 && e.troops() < troops * 1.5) {
            decisionLog("PILE ON candidate: " + safePlayerName(e) + " under " + fmt(totalIncoming) + " incoming");
            if (tryAttack(e, "PILE ON", "Opportunistic")) return;
          }
        }
      } catch (_) {}
    }

    // ── Strategy 6: Attack weakest enemy we can feasibly beat ──
    for (const e of sorted) {
      const defTroops = e.troops();
      // Attack if we'd be sending at least 0.5x their troops (min viable)
      const calc = calcOptimalAttackTroops(troops, maxT, defTroops, bot.reserveRatio);
      if (calc.troops >= defTroops * 0.5) {
        if (tryAttack(e, "BEST TARGET", "Attack")) return;
      } else {
        decisionLog("SKIP " + safePlayerName(e) + ": only " + fmt(calc.troops) + " vs " + fmt(defTroops) + " (need 50%+)");
      }
    }

    // ── Strategy 7: Even below ideal ratio, send partial force ──
    // Attacks merge — even a small wave keeps pressure on and will combine
    // with future waves into a strong attack.
    if (sorted.length > 0) {
      const target = sorted[0];
      const calc = calcOptimalAttackTroops(troops, maxT, target.troops(), bot.reserveRatio);
      if (calc.troops > 1000) {
        decisionLog(
          "PRESSURE: " + safePlayerName(target) +
          " sending " + fmt(calc.troops) + " (will merge with future attacks)"
        );
        doAttack(target.id(), calc.troops);
        bot.currentAction = "Pressure → " + safePlayerName(target);
        bot.strategy = "Pressure";
        botLog("Pressure → " + safePlayerName(target) + " " + fmt(calc.troops) + " [" + calc.reason + "]");
        return;
      }
    }

    decisionLog("COMBAT: no viable target — all too strong, holding");
    bot.currentAction = "Holding — building strength";
  }

  // ──────────────────────────────────────────────────────────────────────
  //  ECONOMY — build/upgrade structures
  //  Priority: City > Factory > Port > DefensePost > MissileSilo > SAM
  //  Mirrors NationStructureBehavior logic with aggressive build cadence
  // ──────────────────────────────────────────────────────────────────────

  function aiEconomy() {
    bot.strategy = "Economy";
    if (bot.tick - bot.lastBuildTick < 30) {
      decisionLog("ECON SKIP: build cooldown (" + (bot.tick - bot.lastBuildTick) + "/30)");
      return;
    }

    const gold = myGold();
    const structures = myStructures();
    decisionLog("ECON EVAL: gold=" + fmt(gold) + " structures=" + structures.length);

    const cities = structures.filter(s => s.type() === UnitType.City && !s.isUnderConstruction());
    const factories = structures.filter(s => s.type() === UnitType.Factory && !s.isUnderConstruction());
    const ports = structures.filter(s => s.type() === UnitType.Port && !s.isUnderConstruction());
    const dps = structures.filter(s => s.type() === UnitType.DefensePost && !s.isUnderConstruction());
    const silos = structures.filter(s => s.type() === UnitType.MissileSilo && !s.isUnderConstruction());
    const sams = structures.filter(s => s.type() === UnitType.SAMLauncher && !s.isUnderConstruction());

    const numCities = cities.length;
    const numFactories = factories.length;
    const numPorts = ports.length;
    const numDP = dps.length;
    const numSilos = silos.length;
    const numSAMs = sams.length;

    // Build priority order
    const builds = [
      { type: UnitType.City, cost: cityCost(numCities), condition: numCities < 8 },
      { type: UnitType.Factory, cost: cityCost(Math.min(numPorts, numFactories)), condition: numFactories < numCities && numFactories < 4 },
      { type: UnitType.Port, cost: cityCost(Math.min(numPorts, numFactories)), condition: numPorts < 2 && numCities >= 1 },
      { type: UnitType.DefensePost, cost: defensePostCost(numDP), condition: numDP < numCities * 2 + 2 },
      { type: UnitType.MissileSilo, cost: SILO_COST, condition: numSilos < Math.max(1, Math.floor(numCities / 2)) },
      { type: UnitType.SAMLauncher, cost: samCost(numSAMs), condition: numSAMs < Math.max(1, Math.floor(numCities / 2)) },
    ];

    for (const b of builds) {
      if (!b.condition) {
        decisionLog("ECON: " + b.type + " condition not met");
        continue;
      }
      if (gold < b.cost) {
        decisionLog("ECON: " + b.type + " too expensive (need " + fmt(b.cost) + ", have " + fmt(gold) + ")");
        continue;
      }
      const tile = findBuildTile(STRUCTURE_MIN_DIST);
      if (tile !== null) {
        doBuild(b.type, tile);
        bot.currentAction = "Building " + b.type;
        botLog("Building " + b.type + " (cost: " + fmt(b.cost) + ")");
        return;
      }
      decisionLog("ECON: " + b.type + " — could not find valid build tile");
    }

    // Upgrade existing structures (cheapest first for rapid value)
    if (bot.tick - bot.lastUpgradeTick < 40) return;
    const upgradable = structures.filter(s => {
      const t = s.type();
      return !s.isUnderConstruction() && (
        t === UnitType.City || t === UnitType.Port ||
        t === UnitType.Factory || t === UnitType.MissileSilo ||
        t === UnitType.SAMLauncher
      );
    });

    // Prioritize upgrading cities and silos
    const upgradeOrder = [UnitType.City, UnitType.MissileSilo, UnitType.SAMLauncher, UnitType.Port, UnitType.Factory];
    for (const targetType of upgradeOrder) {
      for (const s of upgradable) {
        if (s.type() === targetType && gold >= 200_000) {
          doUpgrade(s.id(), s.type());
          bot.currentAction = "Upgrading " + s.type();
          botLog("Upgrading " + s.type() + " (level " + s.level() + ")");
          return;
        }
      }
    }

    bot.currentAction = "Economy stable, gold: " + fmt(gold);
  }

  // ──────────────────────────────────────────────────────────────────────
  //  DIPLOMACY — alliances, embargoes, betrayals
  //  Mirrors NationAllianceBehavior with Impossible-difficulty aggression
  // ──────────────────────────────────────────────────────────────────────

  function aiDiplomacy() {
    bot.strategy = "Diplomacy";
    if (bot.tick - bot.lastAllianceTick < 100) {
      decisionLog("DIPLO SKIP: cooldown (" + (bot.tick - bot.lastAllianceTick) + "/100)");
      return;
    }

    const myP = me();
    if (!myP) return;
    const enems = enemies();
    const alls = allies();
    decisionLog("DIPLO EVAL: enemies=" + enems.length + " allies=" + alls.length);

    // If we have many enemies, try to ally with the strongest one
    if (enems.length >= 3 && alls.length < 2) {
      const strongest = [...enems].sort((a, b) => b.troops() - a.troops())[0];
      if (strongest) {
        doAllianceRequest(strongest.id());
        bot.currentAction = "Requesting alliance with " + safePlayerName(strongest);
        botLog("Alliance request → " + safePlayerName(strongest));
        return;
      }
    }

    // Betray weak allies when we're dominant (mirroring maybeBetray logic)
    if (alls.length > 0 && enems.length <= 1) {
      for (const ally of alls) {
        if (ally.troops() < myP.troops() * 0.15) {
          doBreakAlliance(ally.id());
          bot.currentAction = "Betraying " + safePlayerName(ally);
          bot.strategy = "Betrayal";
          botLog("Breaking alliance with weak ally: " + safePlayerName(ally));
          // Then attack next tick
          return;
        }
      }
    }

    // Embargo hostile players we're not already embargoing
    for (const e of enems) {
      try {
        if (!myP.hasEmbargoAgainst(e)) {
          doEmbargo(e.id(), "start");
          botLog("Embargoed " + safePlayerName(e));
          return;
        }
      } catch (_) {}
    }

    // Donate troops to strong allies in team games
    if (myP.team() && alls.length > 0 && troopRatio() > 0.8) {
      const strongestAlly = [...alls].sort((a, b) => b.troops() - a.troops())[0];
      if (strongestAlly && strongestAlly.troops() > myP.troops() * 0.3) {
        const donation = Math.floor(myP.troops() * 0.15);
        doDonateTroops(strongestAlly.id(), donation);
        bot.currentAction = "Donating to " + safePlayerName(strongestAlly);
        botLog("Donated " + fmt(donation) + " troops to " + safePlayerName(strongestAlly));
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  //  NUKES — build and launch nuclear weapons
  //  Mirrors NationNukeBehavior with aggressive targeting
  // ──────────────────────────────────────────────────────────────────────

  function aiNukes() {
    bot.strategy = "Nuclear";
    if (bot.tick - bot.lastNukeTick < 80) {
      decisionLog("NUKE SKIP: cooldown (" + (bot.tick - bot.lastNukeTick) + "/80)");
      return;
    }

    const gold = myGold();
    const silos = myUnits(UnitType.MissileSilo).filter(s => !s.isUnderConstruction());
    if (silos.length === 0) {
      decisionLog("NUKE SKIP: no silos built");
      return;
    }

    const enems = enemies();
    if (enems.length === 0) {
      decisionLog("NUKE SKIP: no enemies");
      return;
    }
    decisionLog("NUKE EVAL: silos=" + silos.length + " gold=" + fmt(gold));

    // Find the best nuke target — strongest or most threatening enemy
    const target = [...enems].sort((a, b) => b.numTilesOwned() - a.numTilesOwned())[0];
    if (!target) return;

    // Determine nuke type based on gold
    if (gold >= HYDROGEN_COST) {
      // Launch hydrogen bomb for maximum devastation
      const silo = silos[0];
      doBuild(UnitType.HydrogenBomb, silo.tile());
      bot.lastNukeTick = bot.tick;
      bot.currentAction = "Launching H-Bomb at " + safePlayerName(target);
      bot.strategy = "Nuclear Strike (H-Bomb)";
      botLog("H-Bomb launched at " + safePlayerName(target) + "!");
      doTargetPlayer(target.id());
    } else if (gold >= ATOM_COST) {
      const silo = silos[0];
      doBuild(UnitType.AtomBomb, silo.tile());
      bot.lastNukeTick = bot.tick;
      bot.currentAction = "Launching Atom Bomb at " + safePlayerName(target);
      bot.strategy = "Nuclear Strike (Atom)";
      botLog("Atom bomb launched at " + safePlayerName(target) + "!");
      doTargetPlayer(target.id());
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  //  NAVAL — warships and boat invasions
  // ──────────────────────────────────────────────────────────────────────

  function aiNaval() {
    bot.strategy = "Naval";

    const gold = myGold();
    const ports = myUnits(UnitType.Port).filter(u => !u.isUnderConstruction());
    const warships = myUnits(UnitType.Warship);
    decisionLog("NAVAL EVAL: ports=" + ports.length + " warships=" + warships.length + " gold=" + fmt(gold));

    // Build warship if we have a port and no warships
    if (ports.length > 0 && warships.length < 2 && gold >= warshipCost(warships.length)) {
      if (bot.tick - bot.lastBuildTick >= 30) {
        // Find an ocean tile near a port
        const g = gv();
        if (g) {
          const portTile = ports[0].tile();
          const px = g.x(portTile);
          const py = g.y(portTile);
          for (let r = 1; r <= 20; r++) {
            for (let dx = -r; dx <= r; dx++) {
              const dy = r - Math.abs(dx);
              for (const ddy of [dy, -dy]) {
                const nx = px + dx;
                const ny = py + ddy;
                if (!g.isValidCoord(nx, ny)) continue;
                const ref = g.ref(nx, ny);
                if (g.isOcean(ref)) {
                  doBuild(UnitType.Warship, ref);
                  bot.currentAction = "Building Warship";
                  botLog("Building Warship near port");
                  return;
                }
              }
            }
          }
        }
      }
    }

    // Consider boat attacks if we have no land enemies
    if (enemies().length > 0 && bot.tick - bot.lastBoatTick > 150) {
      const g = gv();
      const myP = me();
      if (!g || !myP) return;

      // Find a coastal tile we own
      const enems = enemies();
      const weakEnemy = [...enems].sort((a, b) => a.troops() - b.troops())[0];
      if (weakEnemy && myTroops() > 30000) {
        // This is a simplified boat attempt — we find shore tiles
        bot.currentAction = "Evaluating naval invasion";
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  //  ADAPTIVE PARAMETERS — tune aggression based on troop reserves
  // ──────────────────────────────────────────────────────────────────────

  function aiAdaptParameters(ratio) {
    if (ratio > 0.8) {
      bot.attackRate = 8;
      bot.expandRate = 3;
      bot.reserveRatio = 0.20;
      bot.expandReserve = 0.10;
    } else if (ratio > 0.5) {
      bot.attackRate = 15;
      bot.expandRate = 5;
      bot.reserveRatio = 0.30;
      bot.expandReserve = 0.15;
    } else if (ratio > 0.25) {
      bot.attackRate = 25;
      bot.expandRate = 8;
      bot.reserveRatio = 0.40;
      bot.expandReserve = 0.20;
    } else {
      bot.attackRate = 40;
      bot.expandRate = 10;
      bot.reserveRatio = 0.50;
      bot.expandReserve = 0.30;
    }

    if (bot.tick % 100 === 0) {
      decisionLog(
        "ADAPT: ratio=" + (ratio * 100).toFixed(0) + "%" +
        " → atkRate=" + bot.attackRate + " expRate=" + bot.expandRate +
        " combatRes=" + (bot.reserveRatio * 100).toFixed(0) + "%" +
        " expandRes=" + (bot.expandReserve * 100).toFixed(0) + "%"
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  UTILITY FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════

  function safePlayerName(p) {
    try { return p.name(); } catch (_) { return "???"; }
  }

  function fmt(n) {
    if (n == null) return "0";
    n = Number(n);
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return String(Math.round(n));
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  UI OVERLAY
  // ═══════════════════════════════════════════════════════════════════════

  function createUI() {
    const panel = document.createElement("div");
    panel.id = "ofbot-panel";
    panel.innerHTML = `
      <style>
        #ofbot-panel {
          position: fixed;
          top: 10px;
          right: 10px;
          width: 310px;
          background: rgba(12, 14, 28, 0.94);
          border: 1px solid rgba(90, 130, 255, 0.35);
          border-radius: 10px;
          color: #d0d8f0;
          font-family: 'Segoe UI', system-ui, sans-serif;
          font-size: 12px;
          z-index: 999999;
          backdrop-filter: blur(14px);
          box-shadow: 0 8px 32px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04);
          overflow: hidden;
          user-select: none;
        }
        #ofbot-panel.collapsed .ofbot-body { display: none; }
        #ofbot-panel.collapsed { width: 195px; }

        .ofbot-hdr {
          background: linear-gradient(135deg, #1a2040, #141830);
          padding: 7px 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: move;
          border-bottom: 1px solid rgba(90,130,255,0.15);
        }
        .ofbot-title {
          font-weight: 800;
          font-size: 13px;
          background: linear-gradient(90deg, #6ea8ff, #a78bfa);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .ofbot-ctrls { display: flex; gap: 5px; }
        .ofbot-ctrls button {
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.12);
          color: #a0a8c0;
          border-radius: 4px;
          padding: 1px 8px;
          font-size: 11px;
          cursor: pointer;
          transition: all 0.15s;
        }
        .ofbot-ctrls button:hover { background: rgba(255,255,255,0.12); color: #fff; }
        .ofbot-ctrls .on  { background: rgba(50,200,100,0.2); border-color: rgba(50,200,100,0.4); color: #6fec8a; }
        .ofbot-ctrls .off { background: rgba(255,60,60,0.2); border-color: rgba(255,60,60,0.4); color: #ff8080; }

        .ofbot-body { padding: 9px 11px; max-height: 450px; overflow-y: auto; }
        .ofbot-body::-webkit-scrollbar { width: 3px; }
        .ofbot-body::-webkit-scrollbar-thumb { background: rgba(90,130,255,0.3); border-radius: 2px; }

        .ofbot-strat {
          background: rgba(50,80,200,0.1);
          border: 1px solid rgba(50,80,200,0.2);
          border-radius: 6px;
          padding: 5px 9px;
          margin-bottom: 7px;
        }
        .ofbot-strat-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: rgba(120,150,255,0.5); }
        .ofbot-strat-val { font-size: 14px; font-weight: 700; color: #7eb4ff; }
        .ofbot-act { font-size: 11px; color: #8fd8a0; font-weight: 600; margin-bottom: 6px; }

        .ofbot-sec { margin-bottom: 8px; }
        .ofbot-sec-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.1px; color: rgba(120,150,255,0.5); margin-bottom: 3px; }

        .ofbot-row { display: flex; justify-content: space-between; padding: 1.5px 0; border-bottom: 1px solid rgba(255,255,255,0.025); }
        .ofbot-lbl { color: rgba(190,200,230,0.6); }
        .ofbot-val { font-weight: 600; color: #a0b0e0; }
        .ofbot-val.gold { color: #ffd700; }
        .ofbot-val.trp  { color: #6fec8a; }
        .ofbot-val.warn { color: #ff6b6b; }

        .ofbot-enemies { max-height: 90px; overflow-y: auto; }
        .ofbot-erow { display: flex; justify-content: space-between; font-size: 11px; padding: 1px 0; }
        .ofbot-ename { color: #d0a0a0; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ofbot-etrp  { color: #c0b0b0; font-weight: 600; }

        .ofbot-log {
          max-height: 110px;
          overflow-y: auto;
          font-size: 10px;
          font-family: 'Consolas', 'Monaco', monospace;
          background: rgba(0,0,0,0.25);
          border-radius: 4px;
          padding: 5px 7px;
        }
        .ofbot-log-entry { color: rgba(150,170,210,0.65); line-height: 1.45; word-break: break-all; }
        .ofbot-log-entry:last-child { color: #b0c0e0; }

        .ofbot-ver { text-align: center; font-size: 8px; color: rgba(120,150,255,0.25); padding-top: 3px; }
      </style>
      <div class="ofbot-hdr" id="ofbot-drag">
        <span class="ofbot-title">OpenFront AI Bot</span>
        <div class="ofbot-ctrls">
          <button id="ofbot-tog" class="on">ON</button>
          <button id="ofbot-col">_</button>
        </div>
      </div>
      <div class="ofbot-body">
        <div class="ofbot-strat">
          <div class="ofbot-strat-lbl">Strategy</div>
          <div class="ofbot-strat-val" id="ofbot-strat">Initializing...</div>
        </div>
        <div class="ofbot-act" id="ofbot-act">Waiting...</div>

        <div class="ofbot-sec">
          <div class="ofbot-sec-title">Status</div>
          <div class="ofbot-row"><span class="ofbot-lbl">Tick</span><span class="ofbot-val" id="ofbot-tick">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Game</span><span class="ofbot-val" id="ofbot-game">—</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Atk / Exp Rate</span><span class="ofbot-val" id="ofbot-arate">—</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Intents Sent</span><span class="ofbot-val" id="ofbot-isent">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Intents Confirmed</span><span class="ofbot-val" id="ofbot-iconf">0</span></div>
        </div>

        <div class="ofbot-sec">
          <div class="ofbot-sec-title">My Stats</div>
          <div class="ofbot-row"><span class="ofbot-lbl">Troops</span><span class="ofbot-val trp" id="ofbot-trp">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Max Troops</span><span class="ofbot-val" id="ofbot-mtrp">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Troop %</span><span class="ofbot-val" id="ofbot-tratio">0%</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Gold</span><span class="ofbot-val gold" id="ofbot-gld">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Tiles</span><span class="ofbot-val" id="ofbot-tls">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Structures</span><span class="ofbot-val" id="ofbot-str">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Allies</span><span class="ofbot-val" id="ofbot-als">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Out Attacks</span><span class="ofbot-val" id="ofbot-oatk">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">In Attacks</span><span class="ofbot-val warn" id="ofbot-iatk">0</span></div>
        </div>

        <div class="ofbot-sec">
          <div class="ofbot-sec-title">Enemies (<span id="ofbot-ecnt">0</span>)</div>
          <div class="ofbot-enemies" id="ofbot-elist">
            <div class="ofbot-erow"><span class="ofbot-ename">Scanning...</span></div>
          </div>
        </div>

        <div class="ofbot-sec">
          <div class="ofbot-sec-title">Decision Log</div>
          <div class="ofbot-log" id="ofbot-dlog" style="max-height:100px;">
            <div class="ofbot-log-entry">Waiting for decisions...</div>
          </div>
        </div>

        <div class="ofbot-sec">
          <div class="ofbot-sec-title">Activity Log</div>
          <div class="ofbot-log" id="ofbot-log">
            <div class="ofbot-log-entry">Bot v${BOT_VERSION} loaded</div>
          </div>
        </div>

        <div class="ofbot-ver">OpenFront AI Bot v${BOT_VERSION}</div>
      </div>
    `;
    document.body.appendChild(panel);

    // Toggle
    document.getElementById("ofbot-tog").addEventListener("click", () => {
      bot.enabled = !bot.enabled;
      const btn = document.getElementById("ofbot-tog");
      btn.textContent = bot.enabled ? "ON" : "OFF";
      btn.className = bot.enabled ? "on" : "off";
      botLog(bot.enabled ? "Bot ENABLED" : "Bot DISABLED");
    });

    // Collapse
    document.getElementById("ofbot-col").addEventListener("click", () => {
      panel.classList.toggle("collapsed");
    });

    // Drag
    makeDraggable(panel, document.getElementById("ofbot-drag"));
  }

  function makeDraggable(el, handle) {
    let ox = 0, oy = 0, drag = false;
    handle.addEventListener("mousedown", e => {
      drag = true;
      ox = e.clientX - el.getBoundingClientRect().left;
      oy = e.clientY - el.getBoundingClientRect().top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", e => {
      if (!drag) return;
      el.style.left = (e.clientX - ox) + "px";
      el.style.top = (e.clientY - oy) + "px";
      el.style.right = "auto";
    });
    document.addEventListener("mouseup", () => { drag = false; });
  }

  function refreshUI() {
    const s = bot.statsSnapshot;
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

    set("ofbot-strat", bot.strategy);
    set("ofbot-act", bot.currentAction);
    set("ofbot-tick", String(bot.tick));
    set("ofbot-game", bot.gameStarted ? (bot.spawned ? "Active" : "Spawn Phase") : "Waiting");
    set("ofbot-arate", "atk:" + bot.attackRate + " exp:" + bot.expandRate);
    set("ofbot-isent", String(bot.intentsSent));
    set("ofbot-iconf", String(bot.intentsConfirmed));

    if (s) {
      set("ofbot-trp", fmt(s.troops));
      set("ofbot-mtrp", fmt(s.maxTroops));
      set("ofbot-tratio", (s.troopRatio * 100).toFixed(0) + "%");
      set("ofbot-gld", fmt(s.gold));
      set("ofbot-tls", fmt(s.tiles));
      set("ofbot-str", String(s.structures));
      set("ofbot-als", String(s.allies));
      set("ofbot-ecnt", String(s.enemies));
      set("ofbot-oatk", String(s.outgoingAttacks));
      set("ofbot-iatk", String(s.incomingAttacks));
    }

    // Enemy list
    const elist = document.getElementById("ofbot-elist");
    if (elist) {
      try {
        const enems = enemies();
        if (enems.length > 0) {
          elist.innerHTML = enems
            .sort((a, b) => b.troops() - a.troops())
            .slice(0, 10)
            .map(e => `<div class="ofbot-erow"><span class="ofbot-ename">${escHtml(safePlayerName(e))}</span><span class="ofbot-etrp">${fmt(e.troops())}</span></div>`)
            .join("");
        } else {
          elist.innerHTML = '<div class="ofbot-erow"><span class="ofbot-ename">No enemies</span></div>';
        }
      } catch (_) {}
    }

    // Decision log
    const dlogEl = document.getElementById("ofbot-dlog");
    if (dlogEl) {
      const recent = bot.decisionLog.slice(-20);
      dlogEl.innerHTML = recent.map(l => '<div class="ofbot-log-entry">' + escHtml(l) + '</div>').join("");
      dlogEl.scrollTop = dlogEl.scrollHeight;
    }

    // Activity log
    const logEl = document.getElementById("ofbot-log");
    if (logEl) {
      const recent = bot.log.slice(-25);
      logEl.innerHTML = recent.map(l => '<div class="ofbot-log-entry">' + escHtml(l) + '</div>').join("");
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  // Periodic UI refresh (not on every tick to save perf)
  setInterval(refreshUI, 400);

  // ═══════════════════════════════════════════════════════════════════════
  //  INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  function init() {
    const boot = () => {
      createUI();
      botLog("UI ready — intercepting WebSocket connections");
      botLog("Join a game to activate the bot");
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }

  init();
})();
