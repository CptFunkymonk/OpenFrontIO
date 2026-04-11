// ==UserScript==
// @name         OpenFront.io AI Opponent Bot
// @namespace    http://tampermonkey.net/
// @version      1.0.0
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

  const BOT_VERSION = "1.0.0";

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
    lastBoatTick: -999,
    lastBuildTick: -999,
    lastNukeTick: -999,
    lastAllianceTick: -999,
    lastUpgradeTick: -999,

    // Adaptive parameters
    attackRate: 35,
    reserveRatio: 0.35,
    expandRatio: 0.15,

    log: [],
    currentAction: "Initializing...",
    strategy: "Waiting for game",
    statsSnapshot: null,
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  LOGGING
  // ═══════════════════════════════════════════════════════════════════════

  function botLog(msg) {
    const ts = new Date().toLocaleTimeString();
    bot.log.push("[" + ts + "] " + msg);
    if (bot.log.length > 300) bot.log.shift();
    console.log("[OFBot] " + msg);
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
  // ═══════════════════════════════════════════════════════════════════════

  function sendRaw(obj) {
    if (!bot.socket || bot.socket.readyState !== NativeWebSocket.OPEN) return false;
    bot.socket.send(JSON.stringify(obj));
    return true;
  }

  function sendIntent(intent) {
    if (!bot.enabled) return false;
    return sendRaw({ type: "intent", intent });
  }

  // Typed intent senders
  function doAttack(targetID, troops) {
    if (sendIntent({ type: "attack", targetID, troops: Math.max(1, Math.floor(troops)) })) {
      bot.lastAttackTick = bot.tick;
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
      botLog("Game started!");
    } else if (data.type === "turn") {
      bot.tick = data.turn.turnNumber;
      // Check if we spawned via our own intent
      if (!bot.spawned && data.turn.intents) {
        for (const intent of data.turn.intents) {
          if (intent.clientID === bot.myClientID && intent.type === "spawn") {
            bot.spawned = true;
            botLog("Spawned successfully!");
          }
        }
      }
      // Run the AI brain on every turn
      if (bot.enabled && bot.gameStarted) {
        try { runAI(); } catch (e) { console.error("[OFBot] AI error:", e); }
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
  //  Modeled after NationExecution + AiAttackBehavior but tuned for
  //  maximum aggression ("Impossible" difficulty style).
  // ═══════════════════════════════════════════════════════════════════════

  function runAI() {
    const g = gv();
    if (!g) {
      // Keep trying to find GameView
      bot.gameView = findGameView();
      bot.currentAction = "Searching for game state...";
      return;
    }

    const myP = me();
    if (!myP) {
      bot.currentAction = "Waiting for player...";
      bot.strategy = "Pre-game";
      return;
    }

    bot.spawned = true; // If we can see ourselves, we've spawned

    // Snapshot stats for UI
    bot.statsSnapshot = {
      troops: myTroops(),
      gold: myGold(),
      tiles: myTiles(),
      maxTroops: maxTroopsEstimate(),
      structures: myStructures().length,
      allies: allies().length,
      enemies: enemies().length,
    };

    // ── Distribute AI work across ticks to avoid lag ──
    const phase = bot.tick % 5;
    switch (phase) {
      case 0: aiCombat(); break;
      case 1: aiEconomy(); break;
      case 2: aiDiplomacy(); break;
      case 3: aiNukes(); break;
      case 4: aiNaval(); break;
    }

    // Always check for emergency responses
    aiEmergency();
  }

  // ──────────────────────────────────────────────────────────────────────
  //  COMBAT — land attacks
  //  Priority order mirrors Impossible difficulty from AiAttackBehavior:
  //   retaliate > expand > veryWeak > assist > bots > victim >
  //   hated > traitor > afk > weakest > betray
  // ──────────────────────────────────────────────────────────────────────

  function aiCombat() {
    bot.strategy = "Combat";
    if (bot.tick - bot.lastAttackTick < bot.attackRate) return;

    const troops = myTroops();
    const maxT = maxTroopsEstimate();
    const ratio = troops / Math.max(1, maxT);
    const enems = enemies();

    // Always try to expand into empty land first
    if (ratio > bot.expandRatio) {
      // Check if any border is TerraNullius (unowned)
      // We attack null (server maps null targetID → terraNullius)
      const expandTroops = Math.floor(troops * 0.25);
      if (expandTroops > 100) {
        doAttack(null, expandTroops);
        bot.currentAction = "Expanding territory";
        botLog("Expanding into unclaimed land (" + fmt(expandTroops) + " troops)");
        return;
      }
    }

    if (ratio < bot.reserveRatio) {
      bot.currentAction = "Building troop reserves (" + Math.round(ratio * 100) + "%)";
      return;
    }

    // Strategy 1: Retaliate against incoming attacks
    const myIncoming = me().incomingAttacks();
    if (myIncoming && myIncoming.length > 0) {
      const biggest = myIncoming.reduce((a, b) => ((b.troops || 0) > (a.troops || 0) ? b : a), myIncoming[0]);
      if (biggest && biggest.attackerID) {
        const g = gv();
        try {
          const attacker = g.playerBySmallID(biggest.attackerID);
          if (attacker && attacker.isPlayer && attacker.isPlayer()) {
            const sendTroops = Math.floor(troops * 0.6);
            doAttack(attacker.id(), sendTroops);
            bot.currentAction = "Retaliating against " + safePlayerName(attacker);
            bot.strategy = "Retaliation";
            botLog("Retaliating against " + safePlayerName(attacker) + " (" + fmt(sendTroops) + ")");
            return;
          }
        } catch (_) {}
      }
    }

    if (enems.length === 0) {
      bot.currentAction = "No enemies in range";
      return;
    }

    // Sort enemies by various criteria
    const sorted = [...enems].sort((a, b) => a.troops() - b.troops());

    // Strategy 2: Attack very weak enemies (post-nuke or collapsing)
    for (const e of sorted) {
      if (e.troops() < maxT * 0.15 && e.troops() < troops * 1.2) {
        const sendTroops = Math.floor(troops - maxT * bot.reserveRatio);
        if (sendTroops > 0) {
          doAttack(e.id(), sendTroops);
          bot.currentAction = "Finishing off " + safePlayerName(e);
          bot.strategy = "Elimination";
          botLog("Attacking weak target: " + safePlayerName(e));
          return;
        }
      }
    }

    // Strategy 3: Attack traitors
    for (const e of sorted) {
      try {
        if (e.isTraitor() && e.troops() < troops * 1.2) {
          const sendTroops = Math.floor(troops - maxT * bot.reserveRatio);
          if (sendTroops > 0) {
            doAttack(e.id(), sendTroops);
            bot.currentAction = "Punishing traitor " + safePlayerName(e);
            bot.strategy = "Traitor Punishment";
            botLog("Attacking traitor: " + safePlayerName(e));
            return;
          }
        }
      } catch (_) {}
    }

    // Strategy 4: Attack disconnected (AFK) players
    for (const e of sorted) {
      try {
        if (e.isDisconnected() && e.troops() < troops * 3) {
          const sendTroops = Math.floor(troops - maxT * bot.reserveRatio);
          if (sendTroops > 0) {
            doAttack(e.id(), sendTroops);
            bot.currentAction = "Absorbing AFK " + safePlayerName(e);
            bot.strategy = "AFK Cleanup";
            botLog("Attacking AFK: " + safePlayerName(e));
            return;
          }
        }
      } catch (_) {}
    }

    // Strategy 5: Attack victim (enemy under heavy attack by others)
    for (const e of sorted) {
      try {
        const eIncoming = e.incomingAttacks();
        if (eIncoming && eIncoming.length > 0) {
          const totalIncoming = eIncoming.reduce((s, a) => s + (a.troops || 0), 0);
          if (totalIncoming > e.troops() * 0.5 && e.troops() < troops * 1.2) {
            const sendTroops = Math.floor(troops - maxT * bot.reserveRatio);
            if (sendTroops > 0) {
              doAttack(e.id(), sendTroops);
              bot.currentAction = "Piling on " + safePlayerName(e);
              bot.strategy = "Opportunistic Attack";
              botLog("Attacking distressed target: " + safePlayerName(e));
              return;
            }
          }
        }
      } catch (_) {}
    }

    // Strategy 6: Attack weakest enemy if we're stronger
    const weakest = sorted[0];
    if (weakest && weakest.troops() < troops) {
      const sendTroops = Math.floor(troops - maxT * bot.reserveRatio);
      if (sendTroops > 0) {
        doAttack(weakest.id(), sendTroops);
        bot.currentAction = "Attacking " + safePlayerName(weakest);
        bot.strategy = "Weakest Target";
        botLog("Attacking weakest: " + safePlayerName(weakest) + " (" + fmt(weakest.troops()) + " troops)");
        return;
      }
    }

    bot.currentAction = "Holding position, building strength";
  }

  // ──────────────────────────────────────────────────────────────────────
  //  ECONOMY — build/upgrade structures
  //  Priority: City > Factory > Port > DefensePost > MissileSilo > SAM
  //  Mirrors NationStructureBehavior logic with aggressive build cadence
  // ──────────────────────────────────────────────────────────────────────

  function aiEconomy() {
    bot.strategy = "Economy";
    if (bot.tick - bot.lastBuildTick < 30) return;

    const gold = myGold();
    const structures = myStructures();

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
      if (b.condition && gold >= b.cost) {
        const tile = findBuildTile(STRUCTURE_MIN_DIST);
        if (tile !== null) {
          doBuild(b.type, tile);
          bot.currentAction = "Building " + b.type;
          botLog("Building " + b.type + " (cost: " + fmt(b.cost) + ")");
          return;
        }
      }
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
    if (bot.tick - bot.lastAllianceTick < 100) return;

    const myP = me();
    if (!myP) return;
    const enems = enemies();
    const alls = allies();

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
    if (bot.tick - bot.lastNukeTick < 80) return;

    const gold = myGold();
    const silos = myUnits(UnitType.MissileSilo).filter(s => !s.isUnderConstruction());
    if (silos.length === 0) return;

    const enems = enemies();
    if (enems.length === 0) return;

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
  //  EMERGENCY — always-active responses to urgent threats
  // ──────────────────────────────────────────────────────────────────────

  function aiEmergency() {
    const myP = me();
    if (!myP) return;

    // Accept incoming alliance requests (if from strong players)
    // The game doesn't expose pending requests via GameView directly,
    // so we rely on our diplomatic strategy instead.

    // Adjust attack rate based on troop ratio
    const ratio = troopRatio();
    if (ratio > 0.8) {
      bot.attackRate = 20; // Very aggressive when full
      bot.reserveRatio = 0.25;
    } else if (ratio > 0.5) {
      bot.attackRate = 35;
      bot.reserveRatio = 0.35;
    } else {
      bot.attackRate = 60; // Conservative when low
      bot.reserveRatio = 0.5;
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
          <div class="ofbot-row"><span class="ofbot-lbl">Attack Rate</span><span class="ofbot-val" id="ofbot-arate">—</span></div>
        </div>

        <div class="ofbot-sec">
          <div class="ofbot-sec-title">My Stats</div>
          <div class="ofbot-row"><span class="ofbot-lbl">Troops</span><span class="ofbot-val trp" id="ofbot-trp">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Max Troops</span><span class="ofbot-val" id="ofbot-mtrp">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Gold</span><span class="ofbot-val gold" id="ofbot-gld">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Tiles</span><span class="ofbot-val" id="ofbot-tls">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Structures</span><span class="ofbot-val" id="ofbot-str">0</span></div>
          <div class="ofbot-row"><span class="ofbot-lbl">Allies</span><span class="ofbot-val" id="ofbot-als">0</span></div>
        </div>

        <div class="ofbot-sec">
          <div class="ofbot-sec-title">Enemies (<span id="ofbot-ecnt">0</span>)</div>
          <div class="ofbot-enemies" id="ofbot-elist">
            <div class="ofbot-erow"><span class="ofbot-ename">Scanning...</span></div>
          </div>
        </div>

        <div class="ofbot-sec">
          <div class="ofbot-sec-title">Log</div>
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
    set("ofbot-arate", "every " + bot.attackRate + " ticks");

    if (s) {
      set("ofbot-trp", fmt(s.troops));
      set("ofbot-mtrp", fmt(s.maxTroops));
      set("ofbot-gld", fmt(s.gold));
      set("ofbot-tls", fmt(s.tiles));
      set("ofbot-str", String(s.structures));
      set("ofbot-als", String(s.allies));
      set("ofbot-ecnt", String(s.enemies));
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

    // Log
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
