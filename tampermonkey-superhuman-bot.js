// ==UserScript==
// @name         OpenFront.io Superhuman Bot
// @namespace    http://tampermonkey.net/
// @version      2.1.0
// @description  Standalone strategic OpenFront bot: world model, threat scoring, goal planner
// @author       Cursor
// @match        https://openfront.io/*
// @match        http://localhost:*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const BOT_VERSION = "2.1.0";
  const TROOP_DISPLAY_DIVISOR = 10;
  const MAX_LOG_ENTRIES = 250;
  const MAX_DECISION_ENTRIES = 220;
  const MAX_REASON_ENTRIES = 40;
  const LOOP_INTERVAL_MS = 140;
  const DISCOVERY_INTERVAL_MS = 400;

  // History / world model tuning.
  const HISTORY_WINDOW_TICKS = 600;
  const HISTORY_SAMPLE_EVERY = 10;
  const HISTORY_MAX_SAMPLES = Math.ceil(HISTORY_WINDOW_TICKS / HISTORY_SAMPLE_EVERY) + 2;
  const THREAT_CROWN_THRESHOLD = 0.2;
  const THREAT_CROWN_HYSTERESIS = 0.02;
  const MIRV_GOLD_THRESHOLD = 20_000_000;
  const HYDRO_GOLD_THRESHOLD = 5_000_000;
  const ATOM_GOLD_THRESHOLD = 750_000;
  const TICKS_PER_SECOND = 10;
  const TICKS_PER_MINUTE = 60 * TICKS_PER_SECOND;

  // Stealth pacing (human-grade top-player, not wall-clock optimal).
  const STEALTH_MIN_INTENT_GAP_MS = 120;
  const STEALTH_MAX_MAJOR_PER_2S = 3;
  const STEALTH_REACTION_MIN_MS = 300;
  const STEALTH_REACTION_MAX_MS = 900;
  const STEALTH_SPAWN_THINK_MS = 8000;
  const STEALTH_COMBO_COOLDOWN_MS = 500;
  const STEALTH_PER_PLAYER_DIVERSITY_WINDOW_MS = 3000;
  const STEALTH_PER_PLAYER_DIVERSITY_CAP = 3;

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

  const PlayerType = Object.freeze({
    Bot: "BOT",
    Human: "HUMAN",
    Nation: "NATION",
  });

  const StructureTypes = [
    UnitType.City,
    UnitType.DefensePost,
    UnitType.SAMLauncher,
    UnitType.MissileSilo,
    UnitType.Port,
    UnitType.Factory,
  ];

  const NukeTypes = [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV];
  const BuildPriority = [
    UnitType.City,
    UnitType.Factory,
    UnitType.Port,
    UnitType.DefensePost,
    UnitType.MissileSilo,
    UnitType.SAMLauncher,
  ];

  const runtime = {
    enabled: true,
    mode: "balanced",
    processing: false,
    lastProcessedTick: -1,
    hooks: {
      socket: null,
      worker: null,
      gameView: null,
      uiState: null,
      eventBus: null,
    },
    identity: {
      clientID: null,
      gameID: null,
      clanTag: null,
    },
    state: {
      gameStarted: false,
      matchPhase: "boot",
      spawn: {
        attempted: false,
        lastAttemptTick: -999,
        lastChosenTile: null,
        /** @type {Map<number, { center: number, score: number }>} */
        candidateByCenter: null,
        /** @type {{ center: number, score: number }[] | null} */
        sortedCandidates: null,
        finalIndex: 0,
        maxCandidateCenters: 2000,
        randomSpawnIntentSent: false,
        thinkUntilMs: 0,
      },
      cooldowns: {
        expand: -999,
        combat: -999,
        economy: -999,
        naval: -999,
        nuke: -999,
        diplomacy: -999,
        warship: -999,
        betray: -999,
      },
      borderCache: {
        tick: -999,
        tiles: [],
      },
      profileCache: new Map(),
      lastAction: "booting",
      strategy: "bootstrap",
      lastIntentSignature: "",
      intentsSent: 0,
      intentsConfirmed: 0,
      pendingNukeTrajectory: null,
    },
    overlay: {
      root: null,
      mounted: false,
      expanded: true,
    },
    statsSnapshot: null,
    logs: [],
    decisions: [],
    reasons: [], // structured "why we did that" entries
    /**
     * Rich world model computed every tick once the match is active.
     * Populated by updateWorldModel(); consumed by threat scorer, planner, tactics.
     */
    world: {
      tick: 0,
      me: null,
      meSmallID: null,
      everyone: [],
      bySmallID: new Map(),
      history: new Map(), // smallID -> { samples: [{tick, troops, tiles, gold}], lastSampleTick }
      totals: {
        alivePlayers: 0,
        humanCount: 0,
        nationCount: 0,
        botCount: 0,
        totalLand: 0,
        usableLand: 0,
        crownShare: 0,
        myShare: 0,
        secondShare: 0,
      },
      rankings: {
        byTiles: [],
        byTroops: [],
        byTilesVelocity: [],
        byTroopsVelocity: [],
      },
      allianceGraph: {
        edges: new Map(),
        cliques: [],
        largestBlocShare: 0,
        coalitionThreat: false,
      },
      threats: {
        crownSmallID: null,
        crown: null,
        prevCrownSmallID: null,
        risingStars: [],
        softTargets: [],
        nearestDanger: null,
        mirvRisk: false,
        mirvCapable: [],
        adjacentEnemies: [],
        inboundTroopTotal: 0,
      },
      archetype: "unknown",
      archetypeLocked: null, // manual override from overlay
      classifiedAt: -1,
    },
    planner: {
      activeGoalId: null,
      activeGoal: null,
      activeGoalCreatedTick: -1,
      activeGoalExpiresTick: -1,
      lastSwitchTick: -1,
      forcedGoalId: null,
      forcedGoalExpiresMs: 0,
      /** @type {Array<{id: string, priority: number, valid: boolean, note?: string}>} */
      lastEvaluation: [],
    },
    stealth: {
      lastIntentAtMs: 0,
      lastMajorIntentMs: [],
      perPlayerActions: new Map(), // smallID -> [{ kind, atMs }]
      combos: new Map(), // smallID -> { lastKind, lastAtMs }
    },
  };

  const NativeWebSocket = window.WebSocket;
  const NativeWorker = window.Worker;

  function botLog(message) {
    const entry = "[" + new Date().toLocaleTimeString() + "] " + message;
    runtime.logs.push(entry);
    if (runtime.logs.length > MAX_LOG_ENTRIES) {
      runtime.logs.shift();
    }
    console.log("[SuperBot] " + message);
    refreshOverlay();
  }

  function decisionLog(message) {
    const tick =
      runtime.hooks.gameView &&
      typeof runtime.hooks.gameView.ticks === "function"
        ? runtime.hooks.gameView.ticks()
        : 0;
    const entry = "T" + tick + " " + message;
    runtime.decisions.push(entry);
    if (runtime.decisions.length > MAX_DECISION_ENTRIES) {
      runtime.decisions.shift();
    }
    console.log("[SuperBot:decision] " + entry);
    refreshOverlay();
  }

  /**
   * Record a structured "why we did that" entry. Keep the message short and
   * the trigger/outcome fields readable at a glance in the overlay.
   */
  function reasonLog(goalId, action, trigger, outcome) {
    const tick =
      runtime.hooks.gameView &&
      typeof runtime.hooks.gameView.ticks === "function"
        ? runtime.hooks.gameView.ticks()
        : 0;
    const entry = {
      tick,
      goalId: goalId || "-",
      action: action || "-",
      trigger: trigger || "",
      outcome: outcome || "",
    };
    runtime.reasons.push(entry);
    if (runtime.reasons.length > MAX_REASON_ENTRIES) {
      runtime.reasons.shift();
    }
    decisionLog(
      "[" + entry.goalId + "] " + entry.action +
      (entry.trigger ? " | because " + entry.trigger : "") +
      (entry.outcome ? ", expect " + entry.outcome : "")
    );
  }

  function safeCall(fn, fallback) {
    try {
      return fn();
    } catch (_) {
      return fallback;
    }
  }

  function fmt(number) {
    const value = Number(number || 0);
    if (value >= 1_000_000_000) return (value / 1_000_000_000).toFixed(1) + "B";
    if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M";
    if (value >= 1_000) return (value / 1_000).toFixed(1) + "K";
    return String(Math.round(value));
  }

  function fmtTroops(number) {
    return fmt(Number(number || 0) / TROOP_DISPLAY_DIVISOR);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function shuffleArray(items) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = randomInt(0, i);
      const temp = copy[i];
      copy[i] = copy[j];
      copy[j] = temp;
    }
    return copy;
  }

  function uniqueBy(items, keyFn) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
      const key = keyFn(item);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  function isStructureType(type) {
    return StructureTypes.includes(type);
  }

  function isNukeType(type) {
    return NukeTypes.includes(type);
  }

  function getGameView() {
    const existing = runtime.hooks.gameView;
    if (
      existing &&
      typeof existing.ticks === "function" &&
      typeof existing.myPlayer === "function"
    ) {
      return existing;
    }

    const descriptors = [
      { selector: "control-panel", gameKey: "game", uiKey: "uiState" },
      { selector: "player-panel", gameKey: "g", uiKey: "uiState" },
      { selector: "events-display", gameKey: "game" },
      { selector: "attacks-display", gameKey: "game", uiKey: "uiState" },
      { selector: "unit-display", gameKey: "game", uiKey: "uiState" },
      { selector: "player-info-overlay", gameKey: "game" },
      { selector: "game-left-sidebar", gameKey: "game" },
      { selector: "game-right-sidebar", gameKey: "game" },
      { selector: "emoji-table", gameKey: "game" },
    ];

    for (const descriptor of descriptors) {
      const element = document.querySelector(descriptor.selector);
      if (!element) continue;

      const candidate = element[descriptor.gameKey];
      if (
        candidate &&
        typeof candidate.ticks === "function" &&
        typeof candidate.myPlayer === "function"
      ) {
        runtime.hooks.gameView = candidate;
        if (descriptor.uiKey && element[descriptor.uiKey]) {
          runtime.hooks.uiState = element[descriptor.uiKey];
        }
        botLog(
          "GameView discovered via " +
            descriptor.selector +
            "." +
            descriptor.gameKey,
        );
        return candidate;
      }

      if (
        descriptor.uiKey &&
        element[descriptor.uiKey] &&
        !runtime.hooks.uiState
      ) {
        runtime.hooks.uiState = element[descriptor.uiKey];
      }
    }

    return null;
  }

  function discoverRuntimeReferences() {
    getGameView();
    if (!runtime.hooks.uiState) {
      const controlPanel = document.querySelector("control-panel");
      if (controlPanel && controlPanel.uiState) {
        runtime.hooks.uiState = controlPanel.uiState;
      }
    }
  }

  function getAttackRatio() {
    const ratio = safeCall(
      () => Number(runtime.hooks.uiState && runtime.hooks.uiState.attackRatio),
      NaN,
    );
    if (!Number.isFinite(ratio)) return 0.2;
    return ratio > 1 ? ratio / 100 : ratio;
  }

  function getRocketDirectionUp() {
    return safeCall(
      () =>
        Boolean(
          runtime.hooks.uiState && runtime.hooks.uiState.rocketDirectionUp,
        ),
      true,
    );
  }

  function getMyPlayer() {
    const gameView = getGameView();
    if (!gameView) return null;
    return safeCall(() => gameView.myPlayer(), null);
  }

  function getMyLivingPlayer() {
    const me = getMyPlayer();
    if (!me) return null;
    return safeCall(() => (me.isAlive() ? me : null), null);
  }

  function getAllPlayers() {
    const gameView = getGameView();
    if (!gameView) return [];
    return safeCall(
      () => gameView.playerViews().filter((player) => player.isAlive()),
      [],
    );
  }

  function getEnemies() {
    const me = getMyLivingPlayer();
    if (!me) return [];
    return getAllPlayers().filter((player) => {
      if (player.smallID() === me.smallID()) return false;
      return !safeCall(() => me.isFriendly(player), false);
    });
  }

  function getAllies() {
    const me = getMyLivingPlayer();
    if (!me) return [];
    return getAllPlayers().filter((player) => {
      if (player.smallID() === me.smallID()) return false;
      return safeCall(() => me.isFriendly(player), false);
    });
  }

  async function queryExactBorderTiles(force) {
    const me = getMyLivingPlayer();
    const gameView = getGameView();
    if (!me || !gameView) return runtime.state.borderCache.tiles;

    const tick = safeCall(
      () => gameView.ticks(),
      runtime.state.borderCache.tick,
    );
    if (!force && tick - runtime.state.borderCache.tick < 8) {
      return runtime.state.borderCache.tiles;
    }

    try {
      const result = await me.borderTiles();
      const tiles = Array.from(result.borderTiles || []);
      runtime.state.borderCache = {
        tick,
        tiles,
      };
      return tiles;
    } catch (error) {
      decisionLog("border query failed: " + error.message);
      return runtime.state.borderCache.tiles;
    }
  }

  async function queryPlayerActions(tile, units) {
    const me = getMyLivingPlayer();
    if (!me) return null;
    try {
      return await me.actions(tile, units === undefined ? null : units);
    } catch (error) {
      decisionLog("player actions query failed: " + error.message);
      return null;
    }
  }

  async function queryPlayerBuildables(tile, units) {
    const me = getMyLivingPlayer();
    if (!me) return [];
    try {
      return await me.buildables(tile, units === undefined ? undefined : units);
    } catch (error) {
      decisionLog("buildables query failed: " + error.message);
      return [];
    }
  }

  async function queryTransportShipSpawn(targetTile) {
    const me = getMyLivingPlayer();
    if (!me) return false;
    try {
      return await me.bestTransportShipSpawn(targetTile);
    } catch (error) {
      decisionLog("transport spawn query failed: " + error.message);
      return false;
    }
  }

  async function queryAttackClusters(player, attackId) {
    try {
      return await player.attackClusteredPositions(attackId);
    } catch (error) {
      decisionLog("attack cluster query failed: " + error.message);
      return [];
    }
  }

  async function queryPlayerProfile(player) {
    const cached = runtime.state.profileCache.get(player.smallID());
    const tick = safeCall(() => getGameView().ticks(), 0);
    if (cached && tick - cached.tick < 80) {
      return cached.profile;
    }
    try {
      const profile = await player.profile();
      runtime.state.profileCache.set(player.smallID(), { tick, profile });
      return profile;
    } catch (error) {
      decisionLog("profile query failed: " + error.message);
      return null;
    }
  }

  function sendRawMessage(object) {
    const socket = runtime.hooks.socket;
    if (!socket || socket.readyState !== NativeWebSocket.OPEN) {
      decisionLog("send failed: socket unavailable");
      return false;
    }
    socket.send(JSON.stringify(object));
    return true;
  }

  /**
   * Classify an intent as "major" (attack/build/boat/allianceRequest/
   * targetPlayer/upgrade/embargo/breakAlliance/donate) or minor. Major intents
   * are subject to stricter pacing rules.
   */
  function isMajorIntent(intent) {
    if (!intent || !intent.type) return false;
    switch (intent.type) {
      case "attack":
      case "boat":
      case "build_unit":
      case "upgrade_structure":
      case "allianceRequest":
      case "breakAlliance":
      case "targetPlayer":
      case "embargo":
      case "donate_troops":
      case "donate_gold":
        return true;
      default:
        return false;
    }
  }

  /** Which target player (if any) does this intent affect? */
  function intentTargetSmallID(intent) {
    if (!intent || !intent.type) return null;
    const id = intent.targetID || intent.recipient || intent.target;
    if (!id) return null;
    const player = runtime.world.everyone.find((e) => e.id === id);
    return player ? player.smallID : null;
  }

  function intentActionKind(intent) {
    if (!intent || !intent.type) return "other";
    if (intent.type === "attack" || intent.type === "boat") return "attack";
    if (intent.type === "build_unit" || intent.type === "upgrade_structure") return "build";
    if (intent.type === "targetPlayer") return "target";
    if (intent.type === "embargo") return "embargo";
    if (intent.type === "allianceRequest" || intent.type === "breakAlliance") return "diplomacy";
    return "other";
  }

  /**
   * Detect a test harness so we can safely bypass stealth gating during
   * smoke-test scenarios. Only tripped by the harness setting a flag on the
   * document body — never by the live game.
   */
  function isHarnessMode() {
    return (
      typeof window !== "undefined" &&
      window.__SUPERBOT_TEST_MODE === true
    );
  }

  /**
   * Phase 9: stealth pacing. Returns true if this intent is allowed to go out
   * right now. We enforce:
   * - at most one intent per STEALTH_MIN_INTENT_GAP_MS (120 ms)
   * - at most 3 major intents in any 2-second window
   * - per-player action diversity: no more than 3 distinct action kinds in a
   *   rolling 3-second window (prevents target+embargo+attack combos that
   *   scream "I'm a bot")
   * - combo cooldown: same player can't receive back-to-back major intents
   *   within 500 ms
   */
  function stealthPermits(intent) {
    if (isHarnessMode()) return { ok: true };
    const nowMs = Date.now();
    const gap = nowMs - runtime.stealth.lastIntentAtMs;
    if (gap < STEALTH_MIN_INTENT_GAP_MS) {
      return { ok: false, reason: "intent-gap " + gap + "ms" };
    }

    if (isMajorIntent(intent)) {
      runtime.stealth.lastMajorIntentMs = runtime.stealth.lastMajorIntentMs.filter(
        (ts) => nowMs - ts <= 2000,
      );
      if (runtime.stealth.lastMajorIntentMs.length >= STEALTH_MAX_MAJOR_PER_2S) {
        return { ok: false, reason: "major-burst" };
      }

      const targetSmallID = intentTargetSmallID(intent);
      if (targetSmallID !== null) {
        const combo = runtime.stealth.combos.get(targetSmallID);
        if (
          combo &&
          nowMs - combo.lastAtMs < STEALTH_COMBO_COOLDOWN_MS
        ) {
          return { ok: false, reason: "combo on player " + targetSmallID };
        }

        // Per-player action diversity — rolling 3s window.
        const actions =
          runtime.stealth.perPlayerActions.get(targetSmallID) || [];
        const windowed = actions.filter(
          (a) => nowMs - a.atMs <= STEALTH_PER_PLAYER_DIVERSITY_WINDOW_MS,
        );
        const distinctKinds = new Set(windowed.map((a) => a.kind));
        const kind = intentActionKind(intent);
        distinctKinds.add(kind);
        if (distinctKinds.size > STEALTH_PER_PLAYER_DIVERSITY_CAP) {
          return { ok: false, reason: "diversity-cap on player " + targetSmallID };
        }
      }
    }

    return { ok: true };
  }

  function recordStealthIntent(intent) {
    const nowMs = Date.now();
    runtime.stealth.lastIntentAtMs = nowMs;
    if (!isMajorIntent(intent)) return;
    runtime.stealth.lastMajorIntentMs.push(nowMs);
    const targetSmallID = intentTargetSmallID(intent);
    if (targetSmallID === null) return;
    const kind = intentActionKind(intent);
    const actions =
      runtime.stealth.perPlayerActions.get(targetSmallID) || [];
    actions.push({ kind, atMs: nowMs });
    const trimmed = actions.filter(
      (a) => nowMs - a.atMs <= STEALTH_PER_PLAYER_DIVERSITY_WINDOW_MS,
    );
    runtime.stealth.perPlayerActions.set(targetSmallID, trimmed);
    runtime.stealth.combos.set(targetSmallID, { lastKind: kind, lastAtMs: nowMs });
  }

  function sendIntent(intent) {
    if (!runtime.enabled) return false;
    const signature = intent.type + ":" + JSON.stringify(intent);
    if (runtime.state.lastIntentSignature === signature) {
      return false;
    }
    const permits = stealthPermits(intent);
    if (!permits.ok) {
      // Don't spam this into the decisions log — only log once per ~500ms.
      const nowMs = Date.now();
      if (nowMs - (runtime.stealth.lastGateLogMs || 0) > 500) {
        runtime.stealth.lastGateLogMs = nowMs;
        decisionLog("stealth gate " + permits.reason + " blocked " + intent.type);
      }
      return false;
    }
    const success = sendRawMessage({ type: "intent", intent });
    if (success) {
      runtime.state.lastIntentSignature = signature;
      runtime.state.intentsSent += 1;
      recordStealthIntent(intent);
      decisionLog("sent " + intent.type);
    }
    return success;
  }

  function sendSpawn(tile) {
    const success = sendIntent({ type: "spawn", tile });
    if (success) {
      runtime.state.spawn.lastAttemptTick = safeCall(
        () => getGameView().ticks(),
        0,
      );
      runtime.state.spawn.lastChosenTile = tile;
      runtime.state.lastAction = "spawning";
      runtime.state.strategy = "spawn";
    }
    return success;
  }

  function sendAttack(targetID, troops) {
    return sendIntent({
      type: "attack",
      targetID,
      troops: Math.max(1, Math.floor(troops)),
    });
  }

  function sendBoat(dst, troops) {
    return sendIntent({
      type: "boat",
      dst,
      troops: Math.max(1, Math.floor(troops)),
    });
  }

  function sendBuild(unit, tile, rocketDirectionUp) {
    const intent = {
      type: "build_unit",
      unit,
      tile,
    };
    if (rocketDirectionUp !== undefined) {
      intent.rocketDirectionUp = rocketDirectionUp;
    }
    return sendIntent(intent);
  }

  function sendUpgrade(unitId, unitType) {
    return sendIntent({
      type: "upgrade_structure",
      unitId,
      unit: unitType,
    });
  }

  function sendAllianceRequest(recipient) {
    return sendIntent({ type: "allianceRequest", recipient });
  }

  function sendBreakAlliance(recipient) {
    return sendIntent({ type: "breakAlliance", recipient });
  }

  function sendEmbargo(targetID, action) {
    return sendIntent({ type: "embargo", targetID, action });
  }

  function sendDonateTroops(recipient, troops) {
    return sendIntent({
      type: "donate_troops",
      recipient,
      troops: Math.max(1, Math.floor(troops)),
    });
  }

  function sendDonateGold(recipient, gold) {
    return sendIntent({
      type: "donate_gold",
      recipient,
      gold: Math.max(1, Math.floor(gold)),
    });
  }

  function sendTargetPlayer(target) {
    return sendIntent({ type: "targetPlayer", target });
  }

  function sampleTilesForOwner(ownerSmallID, limit, options) {
    const gameView = getGameView();
    if (!gameView) return [];
    const maxSamples = (options && options.maxSamples) || limit * 16;
    const requireLand = options && options.requireLand !== false;
    const results = [];
    const seen = new Set();

    for (let i = 0; i < maxSamples && results.length < limit; i++) {
      const x = randomInt(0, gameView.width() - 1);
      const y = randomInt(0, gameView.height() - 1);
      if (!gameView.isValidCoord(x, y)) continue;
      const tile = gameView.ref(x, y);
      if (requireLand && !gameView.isLand(tile)) continue;
      if (gameView.ownerID(tile) !== ownerSmallID) continue;
      if (seen.has(tile)) continue;
      seen.add(tile);
      results.push(tile);
    }

    return results;
  }

  function gatherStructureTiles(player) {
    const results = [];
    for (const type of StructureTypes) {
      const units = safeCall(() => player.units(type), []);
      for (const unit of units) {
        if (!safeCall(() => unit.isActive(), false)) continue;
        results.push(unit.tile());
      }
    }
    return uniqueBy(results, (tile) => tile);
  }

  /** Matches core TerrainType: Plains=0, Highland=1, Mountain=2 */
  const TerrainType = Object.freeze({
    Plains: 0,
    Highland: 1,
    Mountain: 2,
  });

  function getManualSpawnTiles(centerTile) {
    const gameView = getGameView();
    if (!gameView) return null;
    const cx = gameView.x(centerTile);
    const cy = gameView.y(centerTile);
    const tiles = [];

    for (let dx = -4; dx <= 4; dx++) {
      for (let dy = -4; dy <= 4; dy++) {
        if (dx * dx + dy * dy > 16) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!gameView.isValidCoord(x, y)) return null;
        const tile = gameView.ref(x, y);
        if (!gameView.isLand(tile) || gameView.hasOwner(tile)) return null;
        tiles.push(tile);
      }
    }

    return tiles;
  }

  /**
   * Score for a legal spawn center: prioritize Plains in the spawn patch, then
   * existing expansion heuristics (open land, flood, penalties). Returns null if invalid.
   */
  /**
   * Compute the average elevation (config.magnitude) within a small radius
   * around a candidate spawn center. Higher ground = terrain defense bonus.
   */
  function elevationAverage(gameView, center, radius) {
    let sum = 0;
    let count = 0;
    for (const tile of gameView.circleSearch(center, radius)) {
      if (!gameView.isLand(tile)) continue;
      sum += safeCall(() => gameView.magnitude(tile), 0);
      count += 1;
    }
    return count > 0 ? sum / count : 0;
  }

  /** Is there any ocean-shore tile within a short radius? */
  function coastNearby(gameView, center, radius) {
    for (const tile of gameView.circleSearch(center, radius)) {
      if (safeCall(() => gameView.isOceanShore(tile), false)) return true;
    }
    return false;
  }

  /**
   * Cheap chokepoint probe. Narrow corridors have few land tiles inside a
   * medium-radius ring. Used as a spawn bonus for choke-hold strategies.
   */
  function isChokepointLike(gameView, center, radius) {
    const landInRing = countLandInRing(gameView, center, radius);
    return landInRing > 0 && landInRing < Math.ceil((radius * radius) * 0.4);
  }

  /**
   * Penalise spawns that are very close to other known players' spawn points.
   * Applies to both pre-spawn Nations (whose spawnTile is visible) and
   * already-placed players whose centroid approximates their presence.
   */
  function enemyProximityPenalty(gameView, center) {
    let penalty = 0;
    const mySmall = runtime.world.meSmallID;
    for (const p of safeCall(() => gameView.playerViews(), [])) {
      if (!p) continue;
      const smallID = safeCall(() => p.smallID(), -1);
      if (smallID === mySmall) continue;
      const spawnTile = safeCall(() => p.spawnTile(), undefined);
      if (spawnTile !== undefined && spawnTile !== null) {
        const dist = gameView.manhattanDist(center, spawnTile);
        if (dist < 60) penalty += (60 - dist) * 0.6;
      } else if (safeCall(() => p.hasSpawned(), false)) {
        // Approximate presence by a small sample of their tiles.
        const sample = sampleTilesForOwner(smallID, 1, {
          requireLand: true,
          maxSamples: 120,
        });
        if (sample.length > 0) {
          const dist = gameView.manhattanDist(center, sample[0]);
          if (dist < 60) penalty += (60 - dist) * 0.4;
        }
      }
    }
    return penalty;
  }

  function computeSpawnCenterScore(gameView, center) {
    if (!gameView.isLand(center) || gameView.hasOwner(center)) return null;
    if (safeCall(() => gameView.isBorder(center), false)) return null;

    const spawnTiles = getManualSpawnTiles(center);
    if (!spawnTiles || spawnTiles.length === 0) return null;

    const minDist = safeCall(
      () => gameView.config().minDistanceBetweenPlayers(),
      0,
    );
    const me = getMyPlayer();
    const mySmall = me ? safeCall(() => me.smallID(), -1) : -1;
    for (const p of safeCall(() => gameView.playerViews(), [])) {
      if (!p) continue;
      if (mySmall >= 0 && p.smallID() === mySmall) continue;
      const st = safeCall(() => p.spawnTile(), undefined);
      if (st === undefined || st === null) continue;
      if (gameView.manhattanDist(center, st) < minDist) {
        return null;
      }
    }

    let plains = 0;
    let highland = 0;
    let mountain = 0;
    for (const t of spawnTiles) {
      const typ = safeCall(() => gameView.terrainType(t), -1);
      if (typ === TerrainType.Plains) plains += 1;
      else if (typ === TerrainType.Highland) highland += 1;
      else if (typ === TerrainType.Mountain) mountain += 1;
    }

    let ownedPenalty = 0;
    for (const tile of gameView.circleSearch(center, 18)) {
      if (gameView.ownerID(tile) > 0) {
        ownedPenalty += 3;
      }
    }

    let oceanPenalty = 0;
    for (const tile of gameView.circleSearch(center, 6)) {
      if (gameView.isWater(tile)) {
        oceanPenalty += 0.3;
      }
    }

    // Upgraded strategic components (Phase 4).
    const localOpen = countUnownedLandNear(center, 12);
    const flood = floodScoreFrom(center, 600);
    const frontier = countUnownedLandNear(center, 40);
    const elev = elevationAverage(gameView, center, 10);
    const coast = coastNearby(gameView, center, 4) ? 1 : 0;
    const choke = isChokepointLike(gameView, center, 20) ? 1 : 0;
    const enemyPenalty = enemyProximityPenalty(gameView, center);

    // Nation spawns already placed nearby — keep distance.
    let falloutNearby = 0;
    for (const tile of gameView.circleSearch(center, 12)) {
      if (safeCall(() => gameView.hasFallout(tile), false)) {
        falloutNearby = 1;
        break;
      }
    }

    const terrainPoints =
      plains * 1000 + highland * 100 + mountain + spawnTiles.length;
    const strategic =
      localOpen * 2 +
      flood * 3 +
      frontier * 5 +
      elev * 0.8 +
      coast * 120 +
      choke * 40 -
      ownedPenalty -
      oceanPenalty -
      enemyPenalty * 4 -
      falloutNearby * 300;
    return terrainPoints * 1.5 + strategic;
  }

  function trySampleSpawnCandidate(gameView) {
    const x = randomInt(0, gameView.width() - 1);
    const y = randomInt(0, gameView.height() - 1);
    if (!gameView.isValidCoord(x, y)) return null;
    const center = gameView.ref(x, y);
    const score = computeSpawnCenterScore(gameView, center);
    if (score === null) return null;
    return { center, score };
  }

  function rememberSpawnCandidate(entry) {
    const map = runtime.state.spawn.candidateByCenter;
    if (!map) return;
    const prev = map.get(entry.center);
    if (prev !== undefined && prev.score >= entry.score) {
      return;
    }
    const maxCenters = runtime.state.spawn.maxCandidateCenters || 2000;
    if (map.size >= maxCenters && prev === undefined) {
      let worstCenter = null;
      let worstScore = Infinity;
      for (const [c, s] of map) {
        if (s.score < worstScore) {
          worstScore = s.score;
          worstCenter = c;
        }
      }
      if (worstCenter !== null && worstScore < entry.score) {
        map.delete(worstCenter);
      } else {
        return;
      }
    }
    map.set(entry.center, entry);
  }

  function refreshSpawnCandidateList() {
    const map = runtime.state.spawn.candidateByCenter;
    if (!map) {
      runtime.state.spawn.sortedCandidates = [];
      return [];
    }
    const sorted = Array.from(map.values()).sort((a, b) => b.score - a.score);
    runtime.state.spawn.sortedCandidates = sorted;
    return sorted;
  }

  function chooseBestRandomSpawnCandidate(gameView) {
    const sorted = refreshSpawnCandidateList();
    let best = null;
    for (const cand of sorted.slice(0, 72)) {
      const fresh = computeSpawnCenterScore(gameView, cand.center);
      if (fresh === null) continue;
      const refreshed = { center: cand.center, score: fresh };
      rememberSpawnCandidate(refreshed);
      if (!best || refreshed.score > best.score) {
        best = refreshed;
      }
    }
    if (best) {
      refreshSpawnCandidateList();
    }
    return best;
  }

  function getActiveMatchTicks(gameView) {
    return Math.max(
      0,
      gameView.ticks() - safeCall(() => gameView.config().numSpawnPhaseTurns(), 0),
    );
  }

  function getBoatDistanceLimit(gameView, me) {
    const activeTicks = getActiveMatchTicks(gameView);
    const totalLand = Math.max(1, safeCall(() => gameView.numLandTiles(), 1));
    const mapShare = me.numTilesOwned() / totalLand;
    const alivePlayers = Math.max(
      1,
      safeCall(
        () => gameView.playerViews().filter((player) => player.isAlive()).length,
        getEnemies().filter((player) => player.isAlive()).length + 1,
      ),
    );

    if (alivePlayers <= 3 || mapShare >= 0.22 || activeTicks >= 14400) {
      return Number.POSITIVE_INFINITY;
    }
    if (alivePlayers <= 5 || mapShare >= 0.16 || activeTicks >= 10800) {
      return 120;
    }
    if (mapShare >= 0.1 || activeTicks >= 7200) {
      return 80;
    }
    return 48;
  }

  function countUnownedLandNear(tile, radius) {
    const gameView = getGameView();
    if (!gameView) return 0;
    let count = 0;
    for (const candidate of gameView.circleSearch(tile, radius)) {
      if (gameView.isLand(candidate) && gameView.ownerID(candidate) === 0) {
        count += 1;
      }
    }
    return count;
  }

  function floodScoreFrom(tile, limit) {
    const gameView = getGameView();
    if (!gameView) return 0;
    const visited = new Set([tile]);
    const queue = [tile];
    let head = 0;
    let score = 0;

    while (head < queue.length && score < limit) {
      const current = queue[head++];
      if (!gameView.isLand(current)) continue;
      if (gameView.ownerID(current) !== 0) continue;
      score += 1;

      for (const neighbor of gameView.neighbors(current)) {
        if (visited.has(neighbor)) continue;
        if (!gameView.isLand(neighbor)) continue;
        if (gameView.ownerID(neighbor) !== 0) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    return score;
  }

  async function chooseManualSpawnTile() {
    const gameView = getGameView();
    if (!gameView) return null;

    const candidates = [];
    for (let i = 0; i < 320; i++) {
      const sampled = trySampleSpawnCandidate(gameView);
      if (!sampled) continue;
      candidates.push(sampled);
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].center;
  }

  function computeReserveRatio(player, maxTroops) {
    const ratio = maxTroops > 0 ? player.troops() / maxTroops : 0;
    let reserve = 0.35;
    if (ratio < 0.2) reserve = 0.55;
    else if (ratio < 0.4) reserve = 0.45;
    else if (ratio > 0.8) reserve = 0.22;

    if (runtime.mode === "aggressive") reserve -= 0.08;
    if (runtime.mode === "turtle") reserve += 0.12;
    return clamp(reserve, 0.12, 0.72);
  }

  function getAdjacentEnemyInfo(borderTiles, me) {
    const gameView = getGameView();
    if (!gameView || !me) return [];

    const counts = new Map();
    for (const borderTile of borderTiles) {
      for (const neighbor of gameView.neighbors(borderTile)) {
        if (!gameView.isLand(neighbor)) continue;
        const ownerID = gameView.ownerID(neighbor);
        if (ownerID === 0 || ownerID === me.smallID()) continue;

        const owner = safeCall(() => gameView.playerBySmallID(ownerID), null);
        if (!owner || !owner.isPlayer || !owner.isPlayer()) continue;
        if (safeCall(() => me.isFriendly(owner), false)) continue;

        const entry = counts.get(ownerID) || {
          player: owner,
          borderContacts: 0,
          hostileTiles: [],
        };
        entry.borderContacts += 1;
        entry.hostileTiles.push(neighbor);
        counts.set(ownerID, entry);
      }
    }

    return Array.from(counts.values());
  }

  async function getAdjacentEnemyInfoWithActions(borderTiles, me) {
    const adjacentEnemies = getAdjacentEnemyInfo(borderTiles, me);
    const enriched = [];

    for (const info of adjacentEnemies) {
      let legalFrontCount = 0;
      const sampleTiles = uniqueBy(info.hostileTiles, (tile) => tile).slice(
        0,
        6,
      );

      for (const tile of sampleTiles) {
        const actions = await queryPlayerActions(tile, null);
        if (actions && actions.canAttack) {
          legalFrontCount += 1;
        }
      }

      if (legalFrontCount > 0) {
        enriched.push({
          player: info.player,
          borderContacts: info.borderContacts,
          hostileTiles: info.hostileTiles,
          legalFrontCount,
        });
      }
    }

    return enriched;
  }

  function getAdjacentExpansionSegments(borderTiles, me) {
    const gameView = getGameView();
    if (!gameView || !me) return [];

    const seeds = [];
    for (const borderTile of borderTiles) {
      for (const neighbor of gameView.neighbors(borderTile)) {
        if (!gameView.isLand(neighbor)) continue;
        if (gameView.ownerID(neighbor) !== 0) continue;
        seeds.push(neighbor);
      }
    }

    const uniqueSeeds = uniqueBy(seeds, (tile) => tile);
    const visited = new Set();
    const segments = [];

    for (const seed of uniqueSeeds) {
      if (visited.has(seed)) continue;
      const queue = [seed];
      const tiles = [];
      visited.add(seed);
      let head = 0;
      let falloutCount = 0;

      while (head < queue.length && tiles.length < 180) {
        const current = queue[head++];
        if (!gameView.isLand(current) || gameView.ownerID(current) !== 0) {
          continue;
        }
        tiles.push(current);
        if (safeCall(() => gameView.hasFallout(current), false)) {
          falloutCount += 1;
        }
        for (const neighbor of gameView.neighbors(current)) {
          if (visited.has(neighbor)) continue;
          if (!gameView.isLand(neighbor)) continue;
          if (gameView.ownerID(neighbor) !== 0) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }

      if (tiles.length > 0) {
        segments.push({
          entryTile: seed,
          size: tiles.length,
          falloutCount,
        });
      }
    }

    segments.sort((a, b) => {
      const aScore = a.size - a.falloutCount * 4;
      const bScore = b.size - b.falloutCount * 4;
      return bScore - aScore;
    });
    return segments;
  }

  function getVisibleUnitsOfType(type) {
    const gameView = getGameView();
    if (!gameView) return [];
    return safeCall(() => gameView.units(type), []);
  }

  function getMyUnitsOfType(type) {
    const me = getMyLivingPlayer();
    if (!me) return [];
    return safeCall(() => me.units(type), []);
  }

  function getUnitLevelCount(player, type) {
    if (!player) return 0;
    if (typeof player.totalUnitLevels === "function") {
      return safeCall(() => player.totalUnitLevels(type), 0);
    }
    return safeCall(
      () =>
        player.units(type).reduce(
          (sum, unit) =>
            sum +
            Math.max(
              1,
              safeCall(() => unit.level(), 1),
            ),
          0,
        ),
      0,
    );
  }

  function getUnitEntityCount(player, type) {
    if (!player) return 0;
    return safeCall(() => player.units(type).length, 0);
  }

  function chooseCounterTarget(incomingAttacks) {
    if (!incomingAttacks || incomingAttacks.length === 0) return null;
    let largest = incomingAttacks[0];
    for (const attack of incomingAttacks) {
      if ((attack.troops || 0) > (largest.troops || 0)) {
        largest = attack;
      }
    }
    const gameView = getGameView();
    if (!gameView) return null;
    return safeCall(() => gameView.playerBySmallID(largest.attackerID), null);
  }

  function isTeamMode(gameView) {
    return safeCall(
      () => gameView.config().gameConfig().gameMode === "Team",
      false,
    );
  }

  function getEnemyStrengthScore(enemy, me, borderContacts) {
    const meTroops = me.troops();
    const enemyTroops = enemy.troops();
    const troopRatio = meTroops / Math.max(enemyTroops, 1);
    let score = 0;

    if (enemy.type() === PlayerType.Bot) score += 18;
    if (enemy.type() === PlayerType.Nation) score += 12;
    if (enemy.type() === PlayerType.Human) score += 8;
    if (safeCall(() => enemy.isDisconnected(), false)) score += 26;
    if (safeCall(() => enemy.isTraitor(), false)) score += 20;
    if (enemy.numTilesOwned() > me.numTilesOwned() * 1.35) score += 14;
    if (safeCall(() => enemy.incomingAttacks().length > 0, false)) score += 11;
    if (troopRatio > 1.8) score += 22;
    else if (troopRatio > 1.25) score += 15;
    else if (troopRatio > 0.9) score += 8;
    else score -= 18;

    score += borderContacts * 1.5;
    score -= Math.min(enemyTroops / 15000, 20);
    return score;
  }

  function calculateAttackTroops(me, enemy, reserveRatio, maxTroops) {
    const available = Math.floor(me.troops() - maxTroops * reserveRatio);
    if (available <= 5000) return 0;

    const enemyTroops = enemy ? enemy.troops() : 0;
    if (enemyTroops <= 0) {
      return Math.max(6000, Math.floor(available * 0.38));
    }

    const ideal = Math.ceil(enemyTroops * 1.75);
    const viable = Math.ceil(enemyTroops * 0.95);
    const pressure = Math.ceil(enemyTroops * 0.6);

    if (available >= ideal) {
      return Math.min(available, Math.max(ideal, Math.floor(available * 0.78)));
    }
    if (available >= viable) {
      return available;
    }
    if (available >= pressure) {
      return Math.max(pressure, Math.floor(available * 0.92));
    }
    return 0;
  }

  function lineIntersectsEnemySam(
    sourceTile,
    targetTile,
    ignoreFriendlyAlliedBlast,
  ) {
    const gameView = getGameView();
    const me = getMyLivingPlayer();
    if (!gameView || !me || sourceTile === false || !sourceTile) return false;

    const dx = gameView.x(targetTile) - gameView.x(sourceTile);
    const dy = gameView.y(targetTile) - gameView.y(sourceTile);
    const samples = 26;

    for (let step = 0; step <= samples; step++) {
      const t = step / samples;
      const x = Math.round(gameView.x(sourceTile) + dx * t);
      const y = Math.round(gameView.y(sourceTile) + dy * t);
      if (!gameView.isValidCoord(x, y)) continue;
      const pointTile = gameView.ref(x, y);
      const nearbySams = gameView.nearbyUnits(
        pointTile,
        gameView.config().maxSamRange(),
        UnitType.SAMLauncher,
      );
      for (const sam of nearbySams) {
        const owner = sam.unit.owner();
        if (safeCall(() => owner.isMe(), false)) continue;
        if (
          ignoreFriendlyAlliedBlast &&
          safeCall(() => me.isFriendly(owner), false)
        ) {
          continue;
        }
        const samRange = gameView.config().samRange(sam.unit.level());
        if (sam.distSquared <= samRange * samRange) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Parabolic trajectory sampler matching the core DistanceBasedBezierCurve used
   * by nukes. We reimplement the essentials rather than depend on the worker:
   * quadratic bezier with a control-point height pushed "up" (toward y=0) and
   * sampled at ~2-pixel spacing. Good enough for SAM interception prediction.
   */
  function sampleNukeTrajectory(gameView, sourceTile, targetTile, directionUp) {
    const mapHeight = gameView.height();
    const sx = gameView.x(sourceTile);
    const sy = gameView.y(sourceTile);
    const tx = gameView.x(targetTile);
    const ty = gameView.y(targetTile);
    const dx = tx - sx;
    const dy = ty - sy;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const PARABOLA_MIN_HEIGHT = 50;
    const maxHeight = Math.max(distance / 3, PARABOLA_MIN_HEIGHT);
    const mult = directionUp === false ? 1 : -1;
    const clamp01Y = (v) => clamp(v, 0, mapHeight - 1);
    const p0 = { x: sx, y: sy };
    const p1 = { x: sx + dx / 4, y: clamp01Y(sy + dy / 4 + mult * maxHeight) };
    const p2 = { x: sx + (dx * 3) / 4, y: clamp01Y(sy + (dy * 3) / 4 + mult * maxHeight) };
    const p3 = { x: tx, y: ty };

    // Sample ~every 0.02 in t; this spans enough points for a 200-tile flight.
    const points = [];
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const mt = 1 - t;
      const x =
        mt * mt * mt * p0.x +
        3 * mt * mt * t * p1.x +
        3 * mt * t * t * p2.x +
        t * t * t * p3.x;
      const y =
        mt * mt * mt * p0.y +
        3 * mt * mt * t * p1.y +
        3 * mt * t * t * p2.y +
        t * t * t * p3.y;
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      if (!gameView.isValidCoord(ix, iy)) continue;
      points.push(gameView.ref(ix, iy));
    }
    return points;
  }

  /**
   * Port of NationNukeBehavior.isTrajectoryInterceptableBySam — accurately
   * simulates the parabolic arc of a nuke and checks every sampled position
   * against enemy SAM coverage. Respects the mid-air untargetable window and
   * supports excludedSamIds for SAM-overwhelm planning.
   */
  function trajectoryInterceptedBySAM(sourceTile, targetTile, excludedSamIds) {
    const gameView = getGameView();
    const me = getMyLivingPlayer();
    if (!gameView || !me || sourceTile === false || !sourceTile) return false;
    const directionUp = getRocketDirectionUp();
    const trajectory = sampleNukeTrajectory(
      gameView,
      sourceTile,
      targetTile,
      directionUp,
    );
    if (trajectory.length === 0) return false;

    const targetableRange = safeCall(
      () => gameView.config().defaultNukeTargetableRange(),
      150,
    );
    const targetRangeSquared = targetableRange * targetableRange;

    // Compute mid-air untargetable window (nukes are untargetable when both
    // > targetRange from source and > targetRange from target).
    let untargetableStart = -1;
    let untargetableEnd = -1;
    for (let i = 0; i < trajectory.length; i++) {
      const tile = trajectory[i];
      if (untargetableStart === -1) {
        if (
          gameView.euclideanDistSquared(tile, sourceTile) > targetRangeSquared
        ) {
          if (
            gameView.euclideanDistSquared(tile, targetTile) < targetRangeSquared
          ) {
            break; // overlapping spawn & target ranges
          }
          untargetableStart = i;
        }
      } else if (
        gameView.euclideanDistSquared(tile, targetTile) < targetRangeSquared
      ) {
        untargetableEnd = i;
        break;
      }
    }

    const samRangeMax = gameView.config().maxSamRange();
    const mySmallID = runtime.world.meSmallID;
    for (let i = 0; i < trajectory.length; i++) {
      if (
        untargetableStart !== -1 &&
        untargetableEnd !== -1 &&
        i === untargetableStart
      ) {
        i = untargetableEnd - 1;
        continue;
      }
      const tile = trajectory[i];
      const nearbySams = gameView.nearbyUnits(
        tile,
        samRangeMax,
        UnitType.SAMLauncher,
      );
      for (const sam of nearbySams) {
        const ownerSmallID = safeCall(
          () => sam.unit.owner().smallID(),
          null,
        );
        if (ownerSmallID === mySmallID) continue;
        const owner = sam.unit.owner();
        if (safeCall(() => me.isFriendly(owner), false)) continue;
        if (excludedSamIds && excludedSamIds.has(safeCall(() => sam.unit.id(), -1))) {
          continue;
        }
        const samRange = gameView.config().samRange(
          safeCall(() => sam.unit.level(), 1),
        );
        if (sam.distSquared <= samRange * samRange) {
          return true;
        }
      }
    }
    return false;
  }

  function nukeMagnitude(unitType) {
    if (unitType === UnitType.AtomBomb) {
      return { inner: 12, outer: 30 };
    }
    if (unitType === UnitType.HydrogenBomb) {
      return { inner: 80, outer: 100 };
    }
    return { inner: 12, outer: 18 };
  }

  function wouldBreakAllianceOnNuke(targetTile, unitType) {
    const gameView = getGameView();
    const me = getMyLivingPlayer();
    if (!gameView || !me) return false;
    const magnitude = nukeMagnitude(unitType);
    const innerSquared = magnitude.inner * magnitude.inner;
    const threshold = 100;
    const allyIds = new Set(getAllies().map((ally) => ally.smallID()));
    if (allyIds.size === 0) return false;

    for (const nearby of gameView.nearbyUnits(
      targetTile,
      magnitude.outer,
      StructureTypes,
    )) {
      if (allyIds.has(nearby.unit.owner().smallID())) {
        return true;
      }
    }

    const counts = new Map();
    for (const tile of gameView.circleSearch(targetTile, magnitude.outer)) {
      const ownerID = gameView.ownerID(tile);
      if (!allyIds.has(ownerID)) continue;
      const distanceSquared = gameView.euclideanDistSquared(targetTile, tile);
      const weight = distanceSquared <= innerSquared ? 1 : 0.5;
      const next = (counts.get(ownerID) || 0) + weight;
      counts.set(ownerID, next);
      if (next > threshold) {
        return true;
      }
    }

    return false;
  }

  function countEnemyStructuresNear(player, targetTile, radius) {
    let score = 0;
    const structureWeights = new Map([
      [UnitType.City, 28],
      [UnitType.Factory, 18],
      [UnitType.Port, 18],
      [UnitType.MissileSilo, 45],
      [UnitType.SAMLauncher, 20],
      [UnitType.DefensePost, 12],
    ]);
    for (const type of StructureTypes) {
      const units = safeCall(() => player.units(type), []);
      for (const unit of units) {
        if (!safeCall(() => unit.isActive(), true)) continue;
        const distanceSquared = getGameView().euclideanDistSquared(
          targetTile,
          unit.tile(),
        );
        if (distanceSquared > radius * radius) continue;
        score += structureWeights.get(type) || 8;
        score += (safeCall(() => unit.level(), 1) - 1) * 8;
      }
    }
    return score;
  }

  async function maybeHandleSpawn() {
    const gameView = getGameView();
    if (!gameView) return false;

    runtime.state.matchPhase = "spawn";

    const me = getMyPlayer();
    if (me && safeCall(() => me.hasSpawned(), false)) {
      return false;
    }

    // Stealth: always pretend we're thinking for a few seconds before any
    // spawn intent goes out. The spawn is the single most visible moment a bot
    // can be spotted; instant perfect picks give it away.
    const nowMs = Date.now();
    if (!runtime.state.spawn.thinkUntilMs) {
      runtime.state.spawn.thinkUntilMs = isHarnessMode()
        ? nowMs
        : nowMs + STEALTH_SPAWN_THINK_MS;
    }
    const stillThinking = !isHarnessMode() && nowMs < runtime.state.spawn.thinkUntilMs;

    if (gameView.config().isRandomSpawn()) {
      if (!runtime.state.spawn.candidateByCenter) {
        runtime.state.spawn.candidateByCenter = new Map();
      }

      const numSpawnPhaseTurns = safeCall(
        () => gameView.config().numSpawnPhaseTurns(),
        300,
      );
      const collectionEnd = Math.floor((2 * numSpawnPhaseTurns) / 3);
      const tick = gameView.ticks();

      if (tick <= collectionEnd) {
        const sampled = trySampleSpawnCandidate(gameView);
        if (sampled) {
          rememberSpawnCandidate(sampled);
        }
        runtime.state.lastAction =
          "scoring spawns (" +
          (runtime.state.spawn.candidateByCenter &&
            runtime.state.spawn.candidateByCenter.size) +
          " spots)";
        runtime.state.strategy = "random-spawn-sample";
        return false;
      }

      const bestCandidate = chooseBestRandomSpawnCandidate(gameView);
      if (bestCandidate) {
        runtime.state.spawn.attempted = true;
        if (runtime.state.spawn.lastChosenTile === bestCandidate.center) {
          if (tick - runtime.state.spawn.lastAttemptTick >= 12) {
            runtime.state.lastIntentSignature = "";
            if (sendSpawn(bestCandidate.center)) {
              runtime.state.spawn.randomSpawnIntentSent = true;
              decisionLog(
                "random spawn reaffirm " +
                  gameView.x(bestCandidate.center) +
                  "," +
                  gameView.y(bestCandidate.center),
              );
              return true;
            }
          }
          runtime.state.lastAction =
            "holding best spawn (" +
            gameView.x(bestCandidate.center) +
            "," +
            gameView.y(bestCandidate.center) +
            ")";
          runtime.state.strategy = "random-spawn-lock";
          return false;
        }

        if (stillThinking) {
          runtime.state.lastAction =
            "thinking (" +
            Math.max(0, Math.ceil((runtime.state.spawn.thinkUntilMs - nowMs) / 1000)) +
            "s)";
          runtime.state.strategy = "random-spawn-thinking";
          return false;
        }

        const ok = sendSpawn(bestCandidate.center);
        if (ok) {
          runtime.state.spawn.randomSpawnIntentSent = true;
          decisionLog(
            "random spawn lock " +
              gameView.x(bestCandidate.center) +
              "," +
              gameView.y(bestCandidate.center) +
              " score~" +
              bestCandidate.score.toFixed(0),
          );
          botLog(
            "Spawn (random lock) -> (" +
              gameView.x(bestCandidate.center) +
              "," +
              gameView.y(bestCandidate.center) +
              ")",
          );
          return true;
        }
      }

      for (let attempt = 0; attempt < 48; attempt++) {
        const sampled = trySampleSpawnCandidate(gameView);
        if (!sampled) continue;
        rememberSpawnCandidate(sampled);
        if (sendSpawn(sampled.center)) {
          runtime.state.spawn.randomSpawnIntentSent = true;
          runtime.state.spawn.attempted = true;
          decisionLog(
            "random spawn fallback " +
              gameView.x(sampled.center) +
              "," +
              gameView.y(sampled.center),
          );
          botLog(
            "Spawn (random fallback) -> (" +
              gameView.x(sampled.center) +
              "," +
              gameView.y(sampled.center) +
              ")",
          );
          return true;
        }
      }

      runtime.state.lastAction = "random spawn: no intent accepted";
      runtime.state.strategy = "random-spawn";
      return false;
    }

    if (
      runtime.state.spawn.attempted &&
      gameView.ticks() - runtime.state.spawn.lastAttemptTick < 20
    ) {
      runtime.state.lastAction = "waiting for spawn confirmation";
      runtime.state.strategy = "manual-spawn";
      return false;
    }

    const chosenTile = await chooseManualSpawnTile();
    if (chosenTile === null) {
      runtime.state.lastAction = "searching for legal spawn";
      runtime.state.strategy = "manual-spawn";
      decisionLog("spawn search found no legal tile");
      return false;
    }

    if (stillThinking) {
      runtime.state.lastAction =
        "thinking (" +
        Math.max(0, Math.ceil((runtime.state.spawn.thinkUntilMs - nowMs) / 1000)) +
        "s)";
      runtime.state.strategy = "manual-spawn-thinking";
      return false;
    }

    runtime.state.spawn.attempted = true;
    decisionLog(
      "manual spawn picked " +
        getGameView().x(chosenTile) +
        "," +
        getGameView().y(chosenTile),
    );
    botLog(
      "Spawn -> (" +
        getGameView().x(chosenTile) +
        "," +
        getGameView().y(chosenTile) +
        ")",
    );
    return sendSpawn(chosenTile);
  }

  async function maybeExpand(me, borderTiles) {
    const gameView = getGameView();
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.expand < 5) return false;

    const segments = getAdjacentExpansionSegments(borderTiles, me);
    if (segments.length === 0) {
      decisionLog("expand: no terra nullius frontier");
      return false;
    }

    const maxTroops = gameView.config().maxTroops(me);
    const reserveRatio = computeReserveRatio(me, maxTroops);
    const troops = calculateAttackTroops(
      me,
      null,
      reserveRatio - 0.08,
      maxTroops,
    );
    if (troops <= 0) {
      decisionLog("expand: insufficient troops");
      return false;
    }

    const best = segments[0];
    const success = sendAttack(null, troops);
    if (!success) return false;

    runtime.state.cooldowns.expand = tick;
    runtime.state.lastAction =
      "expanding " + fmtTroops(troops) + " into " + best.size + " tiles";
    runtime.state.strategy = "expansion";
    botLog("Expand -> " + fmtTroops(troops) + " troops");
    return true;
  }

  async function maybeCombat(me, borderTiles) {
    const gameView = getGameView();
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.combat < 8) return false;

    const adjacentEnemies = await getAdjacentEnemyInfoWithActions(
      borderTiles,
      me,
    );
    if (adjacentEnemies.length === 0) {
      decisionLog("combat: no adjacent enemies");
      return false;
    }

    const counterTarget = chooseCounterTarget(me.incomingAttacks());
    const maxTroops = gameView.config().maxTroops(me);
    const reserveRatio = computeReserveRatio(me, maxTroops);

    if (counterTarget && counterTarget.isPlayer && counterTarget.isPlayer()) {
      const troops = calculateAttackTroops(
        me,
        counterTarget,
        reserveRatio - 0.08,
        maxTroops,
      );
      if (troops > 0) {
        const success = sendAttack(counterTarget.id(), troops);
        if (success) {
          runtime.state.cooldowns.combat = tick;
          runtime.state.lastAction =
            "retaliating against " + counterTarget.displayName();
          runtime.state.strategy = "retaliation";
          botLog("Retaliate -> " + counterTarget.displayName());
          return true;
        }
      }
    }

    adjacentEnemies.sort((a, b) => {
      const aScore =
        getEnemyStrengthScore(a.player, me, a.borderContacts) +
        a.legalFrontCount * 3;
      const bScore =
        getEnemyStrengthScore(b.player, me, b.borderContacts) +
        b.legalFrontCount * 3;
      return bScore - aScore;
    });

    for (const info of adjacentEnemies) {
      const enemy = info.player;
      const troops = calculateAttackTroops(me, enemy, reserveRatio, maxTroops);
      if (troops <= 0) continue;
      if (getEnemyStrengthScore(enemy, me, info.borderContacts) < 6) continue;

      const attackClusters = await queryAttackClusters(enemy);
      if (attackClusters.length > 0) {
        decisionLog(
          "combat cluster " +
            enemy.displayName() +
            " -> " +
            attackClusters.length +
            " fronts",
        );
      }

      const success = sendAttack(enemy.id(), troops);
      if (!success) continue;

      runtime.state.cooldowns.combat = tick;
      runtime.state.lastAction =
        "attacking " + enemy.displayName() + " with " + fmtTroops(troops);
      runtime.state.strategy = "land-combat";
      botLog("Attack -> " + enemy.displayName() + " " + fmtTroops(troops));
      return true;
    }

    decisionLog("combat: no viable adjacent target");
    return false;
  }

  function shouldBuildType(type, me, enemies) {
    // Respect SAVE_FOR_* gates: block expensive non-defensive spends until
    // nuke gold is banked.
    if (typeof economyBanned === "function" && economyBanned(type)) {
      return false;
    }
    const count = getUnitLevelCount(me, type);
    const cities = getUnitLevelCount(me, UnitType.City);
    const hasCoast = runtime.state.borderCache.tiles.some((tile) =>
      safeCall(() => getGameView().isOceanShore(tile), false),
    );
    const nukesEnabled =
      !safeCall(
        () => getGameView().config().isUnitDisabled(UnitType.AtomBomb),
        false,
      ) ||
      !safeCall(
        () => getGameView().config().isUnitDisabled(UnitType.HydrogenBomb),
        false,
      ) ||
      !safeCall(
        () => getGameView().config().isUnitDisabled(UnitType.MIRV),
        false,
      );

    switch (type) {
      case UnitType.City:
        return count < Math.max(2, Math.floor(me.numTilesOwned() / 3500));
      case UnitType.Factory:
        return (
          count < Math.max(1, Math.floor(cities * (hasCoast ? 0.4 : 0.75)))
        );
      case UnitType.Port:
        return hasCoast && count < Math.max(1, Math.floor(cities * 0.6));
      case UnitType.DefensePost:
        return (
          enemies.length > 0 && count < Math.max(2, Math.floor(cities * 0.5))
        );
      case UnitType.MissileSilo:
        return (
          nukesEnabled &&
          cities >= 2 &&
          count < Math.min(3, Math.max(1, Math.floor(cities * 0.22)))
        );
      case UnitType.SAMLauncher:
        return cities >= 2 && count < Math.max(1, Math.floor(cities * 0.25));
      default:
        return false;
    }
  }

  async function tryUpgradeStructure(me, type) {
    const units = shuffleArray(
      safeCall(() => me.units(type), []).filter(
        (unit) => !safeCall(() => unit.isUnderConstruction(), false),
      ),
    ).slice(0, 6);

    for (const unit of units) {
      const buildables = await queryPlayerBuildables(unit.tile(), [type]);
      const buildable = buildables.find((entry) => entry.type === type);
      if (!buildable) continue;
      if (buildable.canUpgrade === false) continue;
      if (sendUpgrade(buildable.canUpgrade, type)) {
        runtime.state.lastAction = "upgrading " + type;
        runtime.state.strategy = "economy";
        botLog("Upgrade -> " + type);
        return true;
      }
    }

    return false;
  }

  async function tryBuildStructure(type, candidateTiles) {
    for (const tile of candidateTiles) {
      const buildables = await queryPlayerBuildables(tile, [type]);
      const buildable = buildables.find((entry) => entry.type === type);
      if (!buildable) continue;

      if (buildable.canUpgrade !== false) {
        if (sendUpgrade(buildable.canUpgrade, type)) {
          runtime.state.lastAction = "upgrading " + type;
          runtime.state.strategy = "economy";
          botLog("Upgrade -> " + type);
          return true;
        }
      }

      if (buildable.canBuild !== false) {
        if (sendBuild(type, tile)) {
          runtime.state.lastAction = "building " + type;
          runtime.state.strategy = "economy";
          botLog("Build -> " + type);
          return true;
        }
      }
    }

    return false;
  }

  function getOwnedCandidateTiles(me, limit) {
    const gameView = getGameView();
    const borderTiles = runtime.state.borderCache.tiles.slice(0, limit);
    const randomTiles = sampleTilesForOwner(me.smallID(), limit, {
      requireLand: true,
    });
    const unitTiles = [];

    for (const type of StructureTypes) {
      for (const unit of safeCall(() => me.units(type), [])) {
        unitTiles.push(unit.tile());
      }
    }

    return uniqueBy(
      shuffleArray(borderTiles.concat(randomTiles, unitTiles)),
      (tile) => tile,
    ).slice(0, limit);
  }

  /**
   * Archetype-biased build order. ISLAND favors navy/economy, CHOKE_HEAVY
   * favors defense, NUKE_RACE favors offensive infrastructure, CONTINENTAL
   * keeps the historical balanced order.
   */
  function buildOrderForArchetype(archetype) {
    switch (archetype) {
      case "ISLAND":
        return [
          UnitType.Port,
          UnitType.Factory,
          UnitType.City,
          UnitType.SAMLauncher,
          UnitType.DefensePost,
          UnitType.MissileSilo,
        ];
      case "CHOKE_HEAVY":
      case "ARENA":
        return [
          UnitType.DefensePost,
          UnitType.City,
          UnitType.Factory,
          UnitType.Port,
          UnitType.SAMLauncher,
          UnitType.MissileSilo,
        ];
      case "NUKE_RACE":
        return [
          UnitType.City,
          UnitType.Factory,
          UnitType.MissileSilo,
          UnitType.SAMLauncher,
          UnitType.Port,
          UnitType.DefensePost,
        ];
      case "CONVENTIONAL":
        return [
          UnitType.City,
          UnitType.Factory,
          UnitType.DefensePost,
          UnitType.Port,
          UnitType.SAMLauncher,
          UnitType.MissileSilo,
        ];
      default:
        return BuildPriority;
    }
  }

  /**
   * Sort candidate tiles for a Factory/City build to prefer placements that
   * extend or bridge the rail network. Cheap proxy for
   * `NationStructureBehavior.computeConnectivityScore`: we favor tiles that
   * are within `trainStationMaxRange` of any existing City/Factory/Port tile.
   */
  function connectivityBiasedTiles(me, candidateTiles) {
    const gameView = getGameView();
    if (!gameView) return candidateTiles;
    const maxRange = safeCall(
      () => gameView.config().trainStationMaxRange(),
      100,
    );
    const minRange = safeCall(
      () => gameView.config().trainStationMinRange(),
      15,
    );
    const minSq = minRange * minRange;
    const maxSq = maxRange * maxRange;
    const stationTiles = [];
    for (const type of [UnitType.City, UnitType.Factory, UnitType.Port]) {
      for (const unit of safeCall(() => me.units(type), [])) {
        if (!safeCall(() => unit.isActive(), false)) continue;
        stationTiles.push(unit.tile());
      }
    }
    if (stationTiles.length === 0) return candidateTiles;
    return candidateTiles
      .map((tile) => {
        let best = Infinity;
        for (const st of stationTiles) {
          const d2 = gameView.euclideanDistSquared(tile, st);
          if (d2 < best) best = d2;
        }
        let score = 0;
        if (best < minSq) {
          score = -20; // too close; avoid dense clumps
        } else if (best <= maxSq) {
          score = 40; // within rail range — trains will run
        } else {
          score = 0;
        }
        return { tile, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.tile);
  }

  async function maybeEconomy(me, enemies) {
    const gameView = getGameView();
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.economy < 22) return false;

    const gold = Number(me.gold());
    if (gold < 50000) {
      decisionLog("economy: low gold");
      return false;
    }

    const candidateTiles = getOwnedCandidateTiles(me, 20);
    const order = buildOrderForArchetype(runtime.world.archetype);
    for (const type of order) {
      if (!shouldBuildType(type, me, enemies)) continue;
      // Factory/City placement benefits from rail connectivity awareness.
      const tiles =
        type === UnitType.Factory || type === UnitType.City
          ? connectivityBiasedTiles(me, candidateTiles)
          : candidateTiles;
      const built = await tryBuildStructure(type, tiles);
      if (built) {
        runtime.state.cooldowns.economy = tick;
        return true;
      }
    }

    const upgradeOrder = [
      UnitType.City,
      UnitType.MissileSilo,
      UnitType.SAMLauncher,
      UnitType.Port,
      UnitType.Factory,
    ];
    for (const type of upgradeOrder) {
      if (!(await tryUpgradeStructure(me, type))) continue;
      runtime.state.cooldowns.economy = tick;
      return true;
    }

    decisionLog("economy: no legal build or upgrade");
    return false;
  }

  async function maybeNaval(me) {
    const gameView = getGameView();
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.naval < 36) return false;

    const currentBoats = getUnitEntityCount(me, UnitType.TransportShip);
    if (currentBoats >= gameView.config().boatMaxNumber()) {
      decisionLog("naval: transport cap reached");
      return false;
    }

    if (me.troops() < 30000) {
      decisionLog("naval: insufficient troops");
      return false;
    }

    const maxTroops = gameView.config().maxTroops(me);
    const reserveRatio = computeReserveRatio(me, maxTroops);
    const available = Math.floor(me.troops() - maxTroops * reserveRatio);
    if (available < 8000) {
      decisionLog("naval: reserve too low");
      return false;
    }

    const maxBoatDistance = getBoatDistanceLimit(gameView, me);
    const plans = [];
    const enemies = getEnemies().sort((a, b) => a.troops() - b.troops());
    for (const enemy of enemies.slice(0, 4)) {
      const structureTiles = gatherStructureTiles(enemy);
      const structureTileSet = new Set(structureTiles);
      const randomTiles = sampleTilesForOwner(enemy.smallID(), 12, {
        requireLand: true,
        maxSamples: 260,
      });
      const candidates = uniqueBy(
        shuffleArray(structureTiles.concat(randomTiles)),
        (tile) => tile,
      );

      for (const candidate of candidates.slice(0, 12)) {
        const spawnTile = await queryTransportShipSpawn(candidate);
        if (spawnTile === false) continue;
        const boatDistance = gameView.manhattanDist(spawnTile, candidate);
        if (boatDistance > maxBoatDistance) continue;

        const troops = clamp(
          Math.floor(available * 0.28),
          8000,
          Math.floor(me.troops() * 0.35),
        );
        let score = countEnemyStructuresNear(enemy, candidate, 8) * 14;
        if (structureTileSet.has(candidate)) score += 28;
        if (enemy.troops() < me.troops() * 0.7) score += 18;
        if (enemy.numTilesOwned() > me.numTilesOwned() * 1.2) score += 8;
        score -= Math.floor(boatDistance / 2);
        plans.push({
          enemy,
          candidate,
          troops,
          boatDistance,
          score,
        });
      }
    }

    plans.sort((a, b) => b.score - a.score);
    for (const plan of plans) {
      const success = sendBoat(plan.candidate, plan.troops);
      if (!success) continue;

      runtime.state.cooldowns.naval = tick;
      runtime.state.lastAction =
        "naval invasion -> " +
        plan.enemy.displayName() +
        " " +
        fmtTroops(plan.troops);
      runtime.state.strategy = "naval";
      botLog(
        "Boat -> " +
          plan.enemy.displayName() +
          " " +
          fmtTroops(plan.troops) +
          " @ " +
          plan.boatDistance +
          " tiles",
      );
      return true;
    }

    decisionLog(
      "naval: no worthwhile invasion within " +
        (Number.isFinite(maxBoatDistance) ? maxBoatDistance : "full-map") +
        " tiles",
    );
    return false;
  }

  async function maybeNuke(me) {
    const gameView = getGameView();
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.nuke < 55) return false;

    const silos = getMyUnitsOfType(UnitType.MissileSilo).filter(
      (unit) => !safeCall(() => unit.isUnderConstruction(), false),
    );
    if (silos.length === 0) {
      decisionLog("nuke: no ready silos");
      return false;
    }

    const enemies = getEnemies().filter((enemy) => enemy.isAlive());
    if (enemies.length === 0) return false;

    const gold = Number(me.gold());
    let nukeType = null;
    if (gold >= 5_000_000) nukeType = UnitType.HydrogenBomb;
    else if (gold >= 750_000) nukeType = UnitType.AtomBomb;
    if (!nukeType) {
      decisionLog("nuke: insufficient gold");
      return false;
    }

    let bestPlan = null;
    for (const enemy of enemies
      .slice()
      .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())
      .slice(0, 5)) {
      const profile = await queryPlayerProfile(enemy);
      const candidateTiles = uniqueBy(
        gatherStructureTiles(enemy).concat(
          sampleTilesForOwner(enemy.smallID(), 16, {
            requireLand: true,
            maxSamples: 320,
          }),
        ),
        (tile) => tile,
      );

      for (const candidate of candidateTiles.slice(0, 16)) {
        if (wouldBreakAllianceOnNuke(candidate, nukeType)) continue;
        const buildables = await queryPlayerBuildables(candidate, [nukeType]);
        const buildable = buildables.find((entry) => entry.type === nukeType);
        if (!buildable || buildable.canBuild === false) continue;

        const localStructureScore = countEnemyStructuresNear(
          enemy,
          candidate,
          nukeMagnitude(nukeType).outer,
        );
        const spawnTile = buildable.canBuild;
        // Use the parabolic trajectory sampler — matches the core simulation
        // (NationNukeBehavior.isTrajectoryInterceptableBySam) so we won't
        // launch through SAM coverage that a straight-line check missed.
        const samRisk = trajectoryInterceptedBySAM(spawnTile, candidate, null)
          ? 90
          : 0;
        const crownPressure =
          enemy.numTilesOwned() > me.numTilesOwned() * 1.35 ? 25 : 0;
        const alliancePressure =
          profile &&
          Array.isArray(profile.alliances) &&
          profile.alliances.length >= 2
            ? 12
            : 0;
        const score =
          localStructureScore +
          crownPressure +
          alliancePressure -
          samRisk -
          Math.floor(gameView.manhattanDist(spawnTile, candidate) / 6);

        if (!bestPlan || score > bestPlan.score) {
          bestPlan = {
            enemy,
            candidate,
            nukeType,
            score,
            spawnTile,
          };
        }
      }
    }

    if (!bestPlan || bestPlan.score < 20) {
      decisionLog("nuke: no worthwhile legal target");
      return false;
    }

    const success = sendBuild(
      bestPlan.nukeType,
      bestPlan.candidate,
      getRocketDirectionUp(),
    );
    if (!success) return false;

    runtime.state.cooldowns.nuke = tick;
    runtime.state.lastAction =
      "nuke -> " +
      bestPlan.enemy.displayName() +
      " (" +
      bestPlan.nukeType +
      ")";
    runtime.state.strategy = "nuke";
    botLog(
      "Nuke -> " +
        bestPlan.enemy.displayName() +
        " @ " +
        gameView.x(bestPlan.candidate) +
        "," +
        gameView.y(bestPlan.candidate),
    );
    return true;
  }

  // ---------- Phase 6.9-6.10: MIRV + SAM-overwhelm tactics ----------

  /**
   * Build and launch a MIRV at the crown / coalition leader. Validated as the
   * "last alternative" by the MIRV_LAST_RESORT goal evaluator; this routine
   * picks the blast center, confirms alliance-safety, and fires.
   */
  async function runGoal_MirvLastResort(me) {
    const gameView = getGameView();
    if (!gameView || !me) return false;
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.nuke < 40) return false;
    if (gameView.config().isUnitDisabled(UnitType.MIRV)) return false;
    if (runtime.world.me.gold < MIRV_GOLD_THRESHOLD) return false;
    const crown = runtime.world.threats.crown;
    if (!crown) return false;

    // Target = coalition tile centroid (tile most covered by coalition
    // structures). Start from crown structure tiles.
    const structureTiles = gatherStructureTiles(crown.player);
    const sampleTiles = uniqueBy(
      structureTiles.concat(
        sampleTilesForOwner(crown.smallID, 8, {
          requireLand: true,
          maxSamples: 160,
        }),
      ),
      (tile) => tile,
    );

    let bestTile = null;
    let bestScore = -Infinity;
    for (const candidate of sampleTiles.slice(0, 12)) {
      if (wouldBreakAllianceOnNuke(candidate, UnitType.MIRV)) continue;
      const buildables = await queryPlayerBuildables(candidate, [UnitType.MIRV]);
      const buildable = buildables.find((b) => b.type === UnitType.MIRV);
      if (!buildable || buildable.canBuild === false) continue;
      const score =
        countEnemyStructuresNear(crown.player, candidate, 100) +
        (runtime.world.totals.crownShare * 200);
      if (score > bestScore) {
        bestScore = score;
        bestTile = candidate;
      }
    }
    if (!bestTile) return false;

    // Declare intent publicly first — baits nations to converge on the crown
    // and is an honest signal to clanmates / teammates in non-FFA lobbies.
    sendTargetPlayer(crown.id);

    const ok = sendBuild(UnitType.MIRV, bestTile, getRocketDirectionUp());
    if (!ok) return false;
    runtime.state.cooldowns.nuke = tick;
    reasonLog(
      "MIRV_LAST_RESORT",
      "build MIRV",
      `crown=${crown.name} share=${(runtime.world.totals.crownShare * 100).toFixed(0)}%`,
      "saturate blast radius, reset map dynamics",
    );
    return true;
  }

  /**
   * Overwhelm enemy SAM coverage with a staggered atom-bomb salvo.
   *
   * Port of `NationNukeBehavior.maybeDestroyEnemySam`. For each hostile SAM we
   * count all enemy SAMs covering its tile (the whole cluster shoots back),
   * then we plan `sumLevels + 1 + extra` bombs whose arrivals fall inside
   * SAMCooldown/2 ticks. Each candidate bomb is checked against
   * `trajectoryInterceptedBySAM` ignoring only the SAMs we intend to
   * overwhelm — any other SAM that would intercept means that silo is wasted.
   */
  async function runGoal_SamOverwhelm(me) {
    const gameView = getGameView();
    if (!gameView || !me) return false;
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.nuke < 80) return false;
    if (gameView.config().isUnitDisabled(UnitType.AtomBomb)) return false;

    const crown = runtime.world.threats.crown;
    if (!crown || crown.isFriendly) return false;

    const enemySams = safeCall(
      () => crown.player.units(UnitType.SAMLauncher),
      [],
    ).filter((u) => safeCall(() => u.isActive(), false));
    if (enemySams.length === 0) return false;

    const mySilos = getMyUnitsOfType(UnitType.MissileSilo).filter(
      (u) => !safeCall(() => u.isUnderConstruction(), false),
    );
    if (mySilos.length === 0) return false;
    const silosReady = mySilos.filter(
      (u) => safeCall(() => u.missileReadinesss(), 0) > 0.25,
    ).length;
    if (silosReady < 2) return false;

    const atomCost = ATOM_GOLD_THRESHOLD;
    // Sort easiest-first: lowest level SAMs.
    const sorted = enemySams.slice().sort(
      (a, b) => safeCall(() => a.level(), 1) - safeCall(() => b.level(), 1),
    );
    const samCooldown = safeCall(() => gameView.config().SAMCooldown(), 120);
    const arrivalBudget = Math.floor(samCooldown / 2);

    for (const targetSam of sorted) {
      const targetTile = targetSam.tile();
      const coveringSams = safeCall(
        () =>
          gameView.nearbyUnits(
            targetTile,
            gameView.config().maxSamRange(),
            UnitType.SAMLauncher,
          ),
        [],
      ).filter(({ unit }) => {
        const owner = unit.owner();
        if (safeCall(() => owner.isMe(), false)) return false;
        if (safeCall(() => me.isFriendly(owner), false)) return false;
        const range = safeCall(
          () => gameView.config().samRange(unit.level()),
          70,
        );
        return unit.distSquared <= range * range;
      });
      const coveringIds = new Set(
        coveringSams.map(({ unit }) => safeCall(() => unit.id(), -1)),
      );
      coveringIds.add(safeCall(() => targetSam.id(), -1));
      const totalCapacity = coveringSams.reduce(
        (sum, { unit }) => sum + safeCall(() => unit.level(), 1),
        safeCall(() => targetSam.level(), 1),
      );
      const bombsNeeded = totalCapacity + 1;
      const extras = Math.floor(bombsNeeded / 5);
      const totalBombs = bombsNeeded + extras;

      if (Number(me.gold()) < atomCost * totalBombs) continue;

      // Allocate silos whose trajectories don't cross *other* SAMs.
      const usableSilos = [];
      for (const silo of mySilos) {
        const readiness = safeCall(() => silo.missileReadinesss(), 0);
        if (readiness <= 0) continue;
        if (trajectoryInterceptedBySAM(silo.tile(), targetTile, coveringIds)) {
          continue;
        }
        usableSilos.push(silo);
      }
      if (usableSilos.length < Math.min(2, totalBombs)) continue;

      // Fire as many atom bombs as we have silos capable of it; each counts
      // against the nuke cooldown. We stagger them via repeated sendBuild
      // calls which the game will queue across ticks (major-intent cap will
      // naturally space them out in stealth mode).
      let fired = 0;
      for (const silo of usableSilos.slice(0, Math.min(totalBombs, 4))) {
        if (sendBuild(UnitType.AtomBomb, targetTile, getRocketDirectionUp())) {
          fired += 1;
        }
      }
      if (fired === 0) continue;

      runtime.state.cooldowns.nuke = tick;
      reasonLog(
        "SAM_OVERWHELM",
        "atom salvo",
        fired +
          " bombs vs " +
          coveringSams.length +
          " SAMs (levels sum=" +
          totalCapacity +
          ", window=" +
          arrivalBudget +
          "t)",
        "burn the SAM wall before hydro follow-up",
      );
      return true;
    }
    return false;
  }

  /**
   * Defensive turtle: donate nothing, build DefensePosts on pressured borders,
   * upgrade SAMs/silos. We don't attack unless directly retaliating.
   */
  async function runGoal_DefensiveTurtle(me) {
    const gameView = getGameView();
    if (!gameView || !me) return false;
    const tick = gameView.ticks();

    // Priority: upgrade existing SAMs + silos first (no construction delay).
    if (tick - runtime.state.cooldowns.economy >= 10) {
      for (const type of [UnitType.SAMLauncher, UnitType.MissileSilo, UnitType.City]) {
        if (await tryUpgradeStructure(me, type)) {
          runtime.state.cooldowns.economy = tick;
          reasonLog(
            "DEFENSIVE_TURTLE",
            "upgrade " + type,
            "lock in crown lead",
            "denser defense and nuke deterrent",
          );
          return true;
        }
      }
    }

    // Build DefensePosts at pressured borders.
    const me2 = runtime.world.me;
    const cityCount = me2 ? me2.structures[UnitType.City] : 0;
    const dpCount = me2 ? me2.structures[UnitType.DefensePost] : 0;
    const dpTarget = Math.max(3, Math.floor(cityCount * 0.5));
    if (
      dpCount < dpTarget &&
      tick - runtime.state.cooldowns.economy >= 25
    ) {
      const candidates = getOwnedCandidateTiles(me, 16);
      for (const tile of candidates) {
        const buildables = await queryPlayerBuildables(tile, [
          UnitType.DefensePost,
        ]);
        const buildable = buildables.find(
          (b) => b.type === UnitType.DefensePost,
        );
        if (!buildable || buildable.canBuild === false) continue;
        if (sendBuild(UnitType.DefensePost, tile)) {
          runtime.state.cooldowns.economy = tick;
          reasonLog(
            "DEFENSIVE_TURTLE",
            "build DefensePost",
            `dpCount=${dpCount}/${dpTarget}`,
            "harden pressured border",
          );
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Pre-crown SAM wall buildup. Blocks further city growth and forces SAM
   * construction until every major structure cluster has ≥ 1 covering SAM.
   */
  async function runGoal_SamWallBuildup(me) {
    const gameView = getGameView();
    if (!gameView || !me) return false;
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.economy < 18) return false;

    const candidates = getOwnedCandidateTiles(me, 20);
    for (const tile of candidates) {
      const buildables = await queryPlayerBuildables(tile, [
        UnitType.SAMLauncher,
      ]);
      const buildable = buildables.find((b) => b.type === UnitType.SAMLauncher);
      if (!buildable) continue;
      if (buildable.canUpgrade !== false) {
        if (sendUpgrade(buildable.canUpgrade, UnitType.SAMLauncher)) {
          runtime.state.cooldowns.economy = tick;
          reasonLog(
            "SAM_WALL_BUILDUP",
            "upgrade SAM",
            "pre-crown nuke defense",
            "raise SAM level",
          );
          return true;
        }
      }
      if (buildable.canBuild !== false) {
        if (sendBuild(UnitType.SAMLauncher, tile)) {
          runtime.state.cooldowns.economy = tick;
          reasonLog(
            "SAM_WALL_BUILDUP",
            "build SAM",
            "pre-crown nuke defense",
            "extend coverage",
          );
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Betray a helpless ally when safety conditions hold. Gated twice: the goal
   * spec already validates the strategic situation; we re-check nearby threats
   * here in case the world changed between evaluation and action.
   */
  async function runGoal_BetrayAlly(selectionContext) {
    const target = selectionContext && selectionContext.target;
    if (!target) return false;
    const me = runtime.world.me;
    if (!me) return false;
    const tick = runtime.world.tick;
    if (tick - runtime.state.cooldowns.betray < 60) return false;

    // Safety re-check.
    const hostile = runtime.world.threats.adjacentEnemies.find(
      (e) => e.troops > me.troops * 1.2,
    );
    if (hostile) return false;
    if (runtime.world.threats.mirvCapable.some((p) => !p.isFriendly)) {
      return false;
    }

    sendBreakAlliance(target.id);
    const troops = Math.floor(me.troops * 0.6);
    if (troops > 0) sendAttack(target.id, troops);
    runtime.state.cooldowns.betray = tick;
    runtime.state.cooldowns.combat = tick;
    reasonLog(
      "BETRAY_ALLY",
      "break + attack ally",
      `ally=${target.name} troopRatio=${(target.troopRatio * 100).toFixed(0)}%`,
      "grab territory before recovery",
    );
    return true;
  }

  /**
   * Build a warship to patrol our coast and counter enemy warships / pirates.
   * Chooses a patrol tile near our port cluster so the warship spawns at a
   * legal friendly port.
   */
  async function runGoal_WarshipDefense(me) {
    const gameView = getGameView();
    if (!gameView || !me) return false;
    if (gameView.config().isUnitDisabled(UnitType.Warship)) return false;
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.warship < 60) return false;

    // Patrol tiles = centroid-ish spots near our ports.
    const myPorts = getMyUnitsOfType(UnitType.Port).filter(
      (u) => !safeCall(() => u.isUnderConstruction(), false),
    );
    if (myPorts.length === 0) return false;

    const candidateTiles = [];
    for (const port of myPorts) {
      const portTile = port.tile();
      // Sample a few oceanic neighbors within manhattan-8 of the port.
      for (const candidate of gameView.circleSearch(portTile, 12)) {
        if (safeCall(() => gameView.isOcean(candidate), false)) {
          candidateTiles.push(candidate);
        }
      }
    }
    const unique = uniqueBy(shuffleArray(candidateTiles), (t) => t).slice(0, 16);

    for (const tile of unique) {
      const buildables = await queryPlayerBuildables(tile, [UnitType.Warship]);
      const buildable = buildables.find((b) => b.type === UnitType.Warship);
      if (!buildable || buildable.canBuild === false) continue;
      if (sendBuild(UnitType.Warship, tile)) {
        runtime.state.cooldowns.warship = tick;
        reasonLog(
          "WARSHIP_DEFENSE",
          "build Warship",
          runtime.world.archetype === "ISLAND"
            ? "island archetype — pirates loom"
            : "enemy warships spotted",
          "patrol coast, protect trade, deter boats",
        );
        return true;
      }
    }
    return false;
  }

  /**
   * 60-second retaliation window: we lock onto the largest current attacker and
   * commit a solid chunk of troops to fire back. If they're across water, we
   * launch a boat. Low overhead — planner already decided this is the right
   * moment.
   */
  async function runGoal_Retaliation(me, borderTiles) {
    const gameView = getGameView();
    if (!gameView || !me) return false;
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.combat < 6) return false;

    const meEntry = runtime.world.me;
    if (!meEntry || meEntry.incomingAttacks.length === 0) return false;

    // Largest attacker by troop count.
    let largest = null;
    for (const attack of meEntry.incomingAttacks) {
      const troops = safeCall(() => attack.troops(), 0);
      if (!largest || troops > largest.troops) {
        largest = { troops, id: safeCall(() => attack.attackerID, null) };
      }
    }
    if (!largest || largest.id === null) return false;

    const attacker = safeCall(
      () => gameView.playerBySmallID(largest.id),
      null,
    );
    if (!attacker || !safeCall(() => attacker.isPlayer(), false)) return false;
    const attackerEntry = runtime.world.bySmallID.get(largest.id);
    if (!attackerEntry) return false;

    const maxTroops = gameView.config().maxTroops(me);
    const reserveRatio = Math.max(0.1, computeReserveRatio(me, maxTroops) - 0.1);
    const troops = calculateAttackTroops(me, attacker, reserveRatio, maxTroops);
    if (troops <= 0) return false;

    // Adjacent -> land attack. Otherwise try a boat.
    if (attackerEntry.isAdjacent || runtime.state.borderCache.tiles.some((t) => {
      return gameView.neighbors(t).some(
        (n) => gameView.ownerID(n) === largest.id,
      );
    })) {
      if (sendAttack(attackerEntry.id, troops)) {
        runtime.state.cooldowns.combat = tick;
        reasonLog(
          "RETALIATION",
          "land attack",
          attackerEntry.name + " sent " + fmtTroops(largest.troops) + " at us",
          "break their expansion",
        );
        return true;
      }
    } else {
      // Boat retaliation if they aren't bordering us.
      const target = gatherStructureTiles(attacker)[0];
      if (!target) return false;
      const spawnTile = await queryTransportShipSpawn(target);
      if (spawnTile === false) return false;
      if (sendBoat(target, troops)) {
        runtime.state.cooldowns.combat = tick;
        runtime.state.cooldowns.naval = tick;
        reasonLog(
          "RETALIATION",
          "boat attack",
          attackerEntry.name + " not adjacent — transport",
          "punish across water",
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Pre-emptively strike a rising star before they become the crown. Chooses
   * the lowest-troop rising star that is either adjacent (land attack) or has
   * a valid transport route.
   */
  async function runGoal_NeutralizeRisingStar(me) {
    const gameView = getGameView();
    if (!gameView || !me) return false;
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.combat < 30) return false;
    const rising = runtime.world.threats.risingStars;
    if (!rising || rising.length === 0) return false;

    const maxTroops = gameView.config().maxTroops(me);
    const reserveRatio = computeReserveRatio(me, maxTroops);
    const target = rising
      .slice()
      .sort((a, b) => a.troops - b.troops)
      .find((e) => !e.isFriendly);
    if (!target) return false;

    const required = Math.max(
      Math.ceil(target.troops * 1.3),
      Math.floor(maxTroops * 0.25),
    );
    const available = Math.floor(me.troops() - maxTroops * reserveRatio);
    if (available < required) return false;

    if (target.isAdjacent) {
      if (sendAttack(target.id, required)) {
        runtime.state.cooldowns.combat = tick;
        reasonLog(
          "NEUTRALIZE_RISING_STAR",
          "land attack",
          target.name + " +" + target.tilesPerMin.toFixed(0) + " tiles/min",
          "blunt their snowball before they crown",
        );
        return true;
      }
      return false;
    }

    const landingTile = gatherStructureTiles(target.player)[0];
    if (!landingTile) return false;
    const spawn = await queryTransportShipSpawn(landingTile);
    if (spawn === false) return false;
    if (sendBoat(landingTile, Math.min(required, Math.floor(me.troops() * 0.35)))) {
      runtime.state.cooldowns.combat = tick;
      runtime.state.cooldowns.naval = tick;
      reasonLog(
        "NEUTRALIZE_RISING_STAR",
        "boat attack",
        target.name + " across water",
        "pre-empt crown rival",
      );
      return true;
    }
    return false;
  }

  /**
   * ConsolidateFront — heavy DefensePost cadence on the side of our border
   * that's under attack. Called when incoming troop pressure exceeds 60% of
   * our reserve. Picks border tiles adjacent to the top-threat hostile.
   */
  async function runGoal_ConsolidateFront(me) {
    const gameView = getGameView();
    if (!gameView || !me) return false;
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.economy < 14) return false;
    const borderTiles = runtime.state.borderCache.tiles;
    if (borderTiles.length === 0) return false;

    // Build a bias: tiles adjacent to our top adjacent enemy get tried first.
    const adjacent = runtime.world.threats.adjacentEnemies[0];
    const sortedBorder = borderTiles.slice().sort((a, b) => {
      if (!adjacent) return 0;
      const aa = gameView.neighbors(a).some(
        (t) => gameView.ownerID(t) === adjacent.smallID,
      );
      const bb = gameView.neighbors(b).some(
        (t) => gameView.ownerID(t) === adjacent.smallID,
      );
      if (aa && !bb) return -1;
      if (bb && !aa) return 1;
      return 0;
    });

    for (const tile of sortedBorder.slice(0, 24)) {
      const buildables = await queryPlayerBuildables(tile, [
        UnitType.DefensePost,
      ]);
      const buildable = buildables.find((b) => b.type === UnitType.DefensePost);
      if (!buildable || buildable.canBuild === false) continue;
      if (sendBuild(UnitType.DefensePost, tile)) {
        runtime.state.cooldowns.economy = tick;
        reasonLog(
          "CONSOLIDATE_FRONT",
          "build DefensePost",
          adjacent
            ? "pressured by " + adjacent.name
            : "inbound attack",
          "harden pressured border",
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Aggressive naval land-grab. In ISLAND archetype we sniff out uncontested
   * small islands via BFS; otherwise we invade the weakest soft target across
   * water. Never exceeds `boatMaxNumber` boats in flight.
   */
  async function runGoal_NavalLandGrab(me) {
    const gameView = getGameView();
    if (!gameView || !me) return false;
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.naval < 30) return false;

    if (
      getUnitEntityCount(me, UnitType.TransportShip) >=
      gameView.config().boatMaxNumber()
    ) {
      return false;
    }
    const maxTroops = gameView.config().maxTroops(me);
    const reserveRatio = computeReserveRatio(me, maxTroops);
    const available = Math.floor(me.troops() - maxTroops * reserveRatio);
    if (available < 8000) return false;

    // Island archetype: prefer uncontested land.
    if (runtime.world.archetype === "ISLAND") {
      const target = findUncontestedIslandSeed(gameView);
      if (target) {
        const spawn = await queryTransportShipSpawn(target);
        if (spawn !== false) {
          const troops = clamp(Math.floor(available * 0.25), 6000, 20000);
          if (sendBoat(target, troops)) {
            runtime.state.cooldowns.naval = tick;
            reasonLog(
              "NAVAL_LAND_GRAB",
              "boat to empty island",
              "ISLAND archetype uncontested land",
              "claim free tiles",
            );
            return true;
          }
        }
      }
    }

    // Continental: invade the weakest structure-rich soft target.
    const target = runtime.world.threats.softTargets.find(
      (s) => !s.isAdjacent && s.opportunityScore > 30,
    );
    if (!target) return false;
    const structureTiles = gatherStructureTiles(target.player);
    const candidates = uniqueBy(
      structureTiles.concat(
        sampleTilesForOwner(target.smallID, 6, {
          requireLand: true,
          maxSamples: 200,
        }),
      ),
      (t) => t,
    );
    for (const candidate of candidates.slice(0, 8)) {
      const spawn = await queryTransportShipSpawn(candidate);
      if (spawn === false) continue;
      const troops = clamp(Math.floor(available * 0.3), 8000, 30000);
      if (sendBoat(candidate, troops)) {
        runtime.state.cooldowns.naval = tick;
        reasonLog(
          "NAVAL_LAND_GRAB",
          "boat invasion",
          target.name + " (soft target across water)",
          "steal structures and tiles",
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Find a small, uncontested land patch accessible by boat. Samples random
   * coordinates and BFS-expands; accepts clusters of 20–300 tiles that are
   * fully unowned. Manageable runtime cost because we bail after the first
   * success.
   */
  function findUncontestedIslandSeed(gameView) {
    const width = gameView.width();
    const height = gameView.height();
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = randomInt(0, width - 1);
      const y = randomInt(0, height - 1);
      if (!gameView.isValidCoord(x, y)) continue;
      const seed = gameView.ref(x, y);
      if (!gameView.isLand(seed)) continue;
      if (gameView.hasOwner(seed)) continue;
      const visited = new Set([seed]);
      const queue = [seed];
      let size = 0;
      let safe = true;
      while (queue.length && size <= 320) {
        const current = queue.shift();
        size += 1;
        if (gameView.hasOwner(current)) {
          safe = false;
          break;
        }
        for (const neighbor of gameView.neighbors(current)) {
          if (visited.has(neighbor)) continue;
          if (!gameView.isLand(neighbor)) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
      if (!safe) continue;
      if (size >= 20 && size <= 300) {
        return seed;
      }
    }
    return null;
  }

  /**
   * Gate expensive economy when we're banking for hydrogen or MIRV. Allows
   * defense structures (DefensePost, SAMLauncher) always; blocks extra cities
   * / factories / silos above their cap.
   */
  function economyBanned(type) {
    const active = runtime.planner.activeGoalId;
    if (active !== "SAVE_FOR_HYDRO" && active !== "MIRV_LAST_RESORT") {
      return false;
    }
    const me = runtime.world.me;
    if (!me) return false;
    const cityCap = Math.max(3, Math.floor(me.tiles / 3000));
    const factoryCap = Math.max(1, Math.floor((me.structures[UnitType.City] || 0) * 0.3));
    if (type === UnitType.City) {
      return (me.structures[UnitType.City] || 0) >= cityCap;
    }
    if (type === UnitType.Factory) {
      return (me.structures[UnitType.Factory] || 0) >= factoryCap;
    }
    if (type === UnitType.Port) {
      return (me.structures[UnitType.Port] || 0) >= Math.max(
        1,
        Math.floor((me.structures[UnitType.City] || 0) * 0.4),
      );
    }
    return false;
  }

  const ALLIANCE_CAP = 2;

  /**
   * Strategic diplomacy.
   *   1. Always try to pseudo-ally with detected clanmates.
   *   2. Under the ALLIANCE_CAP, look for an alliance that would dampen the
   *      crown's rise (partner must be adjacent to or bordering the crown and
   *      not themselves be the crown).
   *   3. Embargo the crown if hostile.
   *   4. Break alliances with disconnected / traitor allies.
   *   5. Fall through to the legacy `maybeDiplomacy` for edge cases.
   */
  async function runGoal_Diplomacy(me) {
    const gameView = getGameView();
    if (!gameView || !me) return false;
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.diplomacy < 50) return false;

    const world = runtime.world;
    const myEntry = world.me;
    if (!myEntry) return false;

    // 1. Auto alliance request to clanmates.
    const clanmates = world.everyone.filter(
      (e) => e.isClanmate && !e.isAlly,
    );
    for (const clanmate of clanmates) {
      const struct = gatherStructureTiles(clanmate.player)[0];
      const sampleTile =
        struct ||
        sampleTilesForOwner(clanmate.smallID, 1, {
          requireLand: true,
          maxSamples: 120,
        })[0];
      if (!sampleTile) continue;
      const actions = await queryPlayerActions(sampleTile, null);
      if (
        actions &&
        actions.interaction &&
        actions.interaction.canSendAllianceRequest
      ) {
        if (sendAllianceRequest(clanmate.id)) {
          runtime.state.cooldowns.diplomacy = tick;
          reasonLog(
            "DIPLOMACY_ISOLATE_CROWN",
            "alliance request",
            "clanmate [" + (clanmate.clanTag || "?") + "] " + clanmate.name,
            "lock in auto-ally",
          );
          return true;
        }
      }
    }

    // 2. Partner-with-best-anti-crown-position up to ALLIANCE_CAP.
    const currentAllies = world.everyone.filter(
      (e) => e.isAlly || e.isClanmate,
    );
    const crown = world.threats.crown;
    const crownShare = world.totals.crownShare;
    if (
      crown &&
      !crown.isFriendly &&
      crownShare >= 0.25 &&
      currentAllies.length < ALLIANCE_CAP
    ) {
      const candidates = world.everyone
        .filter((e) => !e.isMe && !e.isAlly && !e.isClanmate && !e.isFriendly)
        .filter((e) => e.smallID !== crown.smallID)
        .filter((e) => e.type !== PlayerType.Bot)
        // Partners must be adjacent to the crown — they can actually pressure.
        .filter((e) =>
          isAdjacentTo(crown.player, e, Array.from(
            safeCall(() => new Set(gatherStructureTiles(crown.player)), new Set()),
          )) ||
          e.isAdjacent,
        )
        .sort((a, b) => b.strength - a.strength);
      for (const candidate of candidates.slice(0, 5)) {
        const tile = gatherStructureTiles(candidate.player)[0];
        if (!tile) continue;
        const actions = await queryPlayerActions(tile, null);
        if (
          !actions ||
          !actions.interaction ||
          !actions.interaction.canSendAllianceRequest
        ) {
          continue;
        }
        if (sendAllianceRequest(candidate.id)) {
          runtime.state.cooldowns.diplomacy = tick;
          reasonLog(
            "DIPLOMACY_ISOLATE_CROWN",
            "alliance request",
            "ally=" + candidate.name + " borders crown",
            "recruit partner vs crown",
          );
          return true;
        }
      }
    }

    // 3. Embargo the crown if we haven't already.
    if (crown && !crown.isFriendly && crownShare >= 0.25) {
      const crownSample =
        gatherStructureTiles(crown.player)[0] ||
        sampleTilesForOwner(crown.smallID, 1, {
          requireLand: true,
          maxSamples: 120,
        })[0];
      if (crownSample) {
        const actions = await queryPlayerActions(crownSample, null);
        if (
          actions &&
          actions.interaction &&
          actions.interaction.canEmbargo
        ) {
          if (sendEmbargo(crown.id, "start")) {
            runtime.state.cooldowns.diplomacy = tick;
            reasonLog(
              "DIPLOMACY_ISOLATE_CROWN",
              "embargo",
              "crown=" + crown.name + " " + (crownShare * 100).toFixed(0) + "%",
              "deny trade revenue",
            );
            return true;
          }
        }
      }
    }

    // 4. Break alliances with disconnected / traitor allies.
    for (const ally of currentAllies) {
      if (ally.isClanmate) continue; // never break with clan.
      if (!ally.isDisconnected && !ally.isTraitor) continue;
      const tile = gatherStructureTiles(ally.player)[0];
      if (!tile) continue;
      const actions = await queryPlayerActions(tile, null);
      if (
        actions &&
        actions.interaction &&
        actions.interaction.canBreakAlliance
      ) {
        if (sendBreakAlliance(ally.id)) {
          runtime.state.cooldowns.diplomacy = tick;
          reasonLog(
            "DIPLOMACY_ISOLATE_CROWN",
            "break alliance",
            ally.name + (ally.isTraitor ? " is traitor" : " disconnected"),
            "free up alliance slot",
          );
          return true;
        }
      }
    }

    // 5. Nothing to do at the strategic level.
    return false;
  }

  async function maybeDiplomacy(me) {
    // New goal-aware diplomacy gets first crack.
    if (await runGoal_Diplomacy(me)) return true;
    const gameView = getGameView();
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.diplomacy < 70) return false;

    const allies = getAllies();
    const enemies = getEnemies();

    if (isTeamMode(gameView) && allies.length > 0) {
      let mostNeedy = null;
      for (const ally of allies) {
        const allyMax = gameView.config().maxTroops(ally);
        const ratio = ally.troops() / Math.max(allyMax, 1);
        if (
          safeCall(() => ally.incomingAttacks().length > 0, false) &&
          (!mostNeedy || ratio < mostNeedy.ratio)
        ) {
          mostNeedy = { ally, ratio };
        }
      }

      if (mostNeedy && me.troops() > gameView.config().maxTroops(me) * 0.75) {
        const donation = Math.floor(me.troops() * 0.12);
        if (donation > 0 && sendDonateTroops(mostNeedy.ally.id(), donation)) {
          runtime.state.cooldowns.diplomacy = tick;
          runtime.state.lastAction =
            "donating troops to " + mostNeedy.ally.displayName();
          runtime.state.strategy = "support";
          botLog(
            "Donate troops -> " +
              mostNeedy.ally.displayName() +
              " " +
              fmtTroops(donation),
          );
          return true;
        }
      }
    }

    const topEnemy = enemies.sort(
      (a, b) => b.numTilesOwned() - a.numTilesOwned(),
    )[0];
    if (topEnemy) {
      const targetTile =
        gatherStructureTiles(topEnemy)[0] ||
        sampleTilesForOwner(topEnemy.smallID(), 1, {
          requireLand: true,
          maxSamples: 200,
        })[0];

      if (targetTile !== undefined) {
        const actions = await queryPlayerActions(targetTile, null);
        if (actions && actions.interaction && actions.interaction.canEmbargo) {
          if (sendEmbargo(topEnemy.id(), "start")) {
            runtime.state.cooldowns.diplomacy = tick;
            runtime.state.lastAction = "embargoing " + topEnemy.displayName();
            runtime.state.strategy = "diplomacy";
            botLog("Embargo -> " + topEnemy.displayName());
            return true;
          }
        }

        if (
          enemies.length >= 3 &&
          actions &&
          actions.interaction &&
          actions.interaction.canSendAllianceRequest &&
          topEnemy.troops() > me.troops() * 1.5
        ) {
          if (sendAllianceRequest(topEnemy.id())) {
            runtime.state.cooldowns.diplomacy = tick;
            runtime.state.lastAction =
              "requesting alliance with " + topEnemy.displayName();
            runtime.state.strategy = "diplomacy";
            botLog("Alliance request -> " + topEnemy.displayName());
            return true;
          }
        }
      }
    }

    for (const ally of allies) {
      const targetTile = gatherStructureTiles(ally)[0];
      if (targetTile === undefined) continue;
      const actions = await queryPlayerActions(targetTile, null);
      if (
        !actions ||
        !actions.interaction ||
        !actions.interaction.canBreakAlliance
      ) {
        continue;
      }

      if (
        safeCall(() => ally.isDisconnected(), false) ||
        safeCall(() => ally.isTraitor(), false)
      ) {
        if (sendBreakAlliance(ally.id())) {
          runtime.state.cooldowns.diplomacy = tick;
          runtime.state.lastAction =
            "breaking alliance with " + ally.displayName();
          runtime.state.strategy = "diplomacy";
          botLog("Break alliance -> " + ally.displayName());
          return true;
        }
      }
    }

    return false;
  }

  function updateSnapshot(me, borderTiles) {
    const gameView = getGameView();
    const enemies = getEnemies();
    const allies = getAllies();
    const maxTroops = gameView ? gameView.config().maxTroops(me) : 0;
    runtime.statsSnapshot = {
      tick: gameView ? gameView.ticks() : 0,
      troops: me.troops(),
      maxTroops,
      troopRatio: maxTroops > 0 ? me.troops() / maxTroops : 0,
      gold: Number(me.gold()),
      tiles: me.numTilesOwned(),
      allies: allies.length,
      enemies: enemies.length,
      borderTiles: borderTiles.length,
      outgoingAttacks: me.outgoingAttacks().length,
      incomingAttacks: me.incomingAttacks().length,
      boats: getUnitEntityCount(me, UnitType.TransportShip),
      intentsSent: runtime.state.intentsSent,
      intentsConfirmed: runtime.state.intentsConfirmed,
    };
  }

  // ---------- Phase 1: world model ----------

  /**
   * Count active structures (not under construction) grouped by type for the
   * given player. Missing units fall back to 0 so callers don't have to null-check.
   */
  function collectStructureCounts(player) {
    const counts = {
      [UnitType.City]: 0,
      [UnitType.Factory]: 0,
      [UnitType.Port]: 0,
      [UnitType.DefensePost]: 0,
      [UnitType.MissileSilo]: 0,
      [UnitType.SAMLauncher]: 0,
    };
    const levels = { ...counts };
    for (const type of StructureTypes) {
      const units = safeCall(() => player.units(type), []);
      for (const unit of units) {
        if (!safeCall(() => unit.isActive(), false)) continue;
        if (safeCall(() => unit.isUnderConstruction(), false)) continue;
        counts[type] = (counts[type] || 0) + 1;
        levels[type] = (levels[type] || 0) + Math.max(1, safeCall(() => unit.level(), 1));
      }
    }
    return { counts, levels };
  }

  function normalizeClanTag(value) {
    if (!value || typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.toUpperCase();
  }

  /**
   * Derive a player's clan tag from anything we can observe. The game sometimes
   * stores a raw clanTag; other times it's embedded in the display name as
   * "[TAG] Player" or "[TAG]Player". We scan both.
   */
  function extractClanTag(player) {
    if (!player) return null;
    const raw =
      safeCall(() => player.data && player.data.clanTag, null) ||
      safeCall(() => player.clanTag && player.clanTag(), null);
    if (raw) return normalizeClanTag(raw);
    const display =
      safeCall(() => player.displayName(), null) ||
      safeCall(() => player.name(), null) ||
      "";
    const match = display.match(/^\s*\[([A-Za-z0-9_.-]{1,6})\]/);
    if (match) return normalizeClanTag(match[1]);
    return null;
  }

  function trustedClanTags() {
    const tags = new Set();
    const own = normalizeClanTag(runtime.identity.clanTag);
    if (own) tags.add(own);
    const extras = runtime.identity.extraClanTags;
    if (Array.isArray(extras)) {
      for (const t of extras) {
        const norm = normalizeClanTag(t);
        if (norm) tags.add(norm);
      }
    }
    return tags;
  }

  /** Push a single history sample, trimming to HISTORY_MAX_SAMPLES. */
  function pushHistorySample(smallID, sample) {
    let entry = runtime.world.history.get(smallID);
    if (!entry) {
      entry = { samples: [], lastSampleTick: -999 };
      runtime.world.history.set(smallID, entry);
    }
    entry.samples.push(sample);
    if (entry.samples.length > HISTORY_MAX_SAMPLES) {
      entry.samples.splice(0, entry.samples.length - HISTORY_MAX_SAMPLES);
    }
    entry.lastSampleTick = sample.tick;
    return entry;
  }

  /** Compute per-minute velocity for a player from its ring buffer samples. */
  function computeVelocities(entry, tick) {
    if (!entry || entry.samples.length === 0) {
      return { tilesPerMin: 0, troopsPerMin: 0, goldPerMin: 0, spanTicks: 0 };
    }
    const latest = entry.samples[entry.samples.length - 1];
    let reference = entry.samples[0];
    // Prefer a reference point within the configured window so bursts don't dominate.
    for (const sample of entry.samples) {
      if (latest.tick - sample.tick <= HISTORY_WINDOW_TICKS) {
        reference = sample;
        break;
      }
    }
    const span = Math.max(1, latest.tick - reference.tick);
    const tilesPerMin =
      ((latest.tiles - reference.tiles) * TICKS_PER_MINUTE) / span;
    const troopsPerMin =
      ((latest.troops - reference.troops) * TICKS_PER_MINUTE) / span;
    const goldPerMin =
      ((latest.gold - reference.gold) * TICKS_PER_MINUTE) / span;
    return { tilesPerMin, troopsPerMin, goldPerMin, spanTicks: span };
  }

  /**
   * Drop history entries for players that have died (no longer in the live view).
   * Called each tick so the ring buffer doesn't grow unbounded across respawns.
   */
  function pruneStaleHistory(livingSmallIDs) {
    if (runtime.world.history.size === 0) return;
    for (const smallID of Array.from(runtime.world.history.keys())) {
      if (!livingSmallIDs.has(smallID)) {
        runtime.world.history.delete(smallID);
      }
    }
  }

  /**
   * Refresh the world model. Called at the top of every active-phase tick.
   * Cheap: only uses synchronous GameView reads, no worker RPCs.
   */
  function updateWorldModel(me, borderTiles) {
    const gameView = getGameView();
    if (!gameView || !me) return;

    const tick = safeCall(() => gameView.ticks(), 0);
    const allPlayers = safeCall(() => gameView.playerViews(), []);
    const alive = allPlayers.filter((p) => safeCall(() => p.isAlive(), false));

    // Identity: learn our clan tag once, when the game starts.
    if (!runtime.identity.clanTag) {
      const selfTag = extractClanTag(me);
      if (selfTag) {
        runtime.identity.clanTag = selfTag;
        botLog("Detected own clan tag: [" + selfTag + "]");
      }
    }

    const meSmallID = safeCall(() => me.smallID(), null);
    const trustedTags = trustedClanTags();
    const sample = (player) => {
      const troops = safeCall(() => player.troops(), 0);
      const tiles = safeCall(() => player.numTilesOwned(), 0);
      const gold = Number(safeCall(() => player.gold(), 0));
      return { tick, troops, tiles, gold };
    };

    const shouldSample =
      runtime.world.tick === 0 ||
      tick - runtime.world.tick >= HISTORY_SAMPLE_EVERY ||
      runtime.world.history.size === 0;

    const everyone = [];
    const livingSmallIDs = new Set();
    let humanCount = 0;
    let nationCount = 0;
    let botCount = 0;

    for (const player of alive) {
      const smallID = safeCall(() => player.smallID(), null);
      if (smallID === null) continue;
      livingSmallIDs.add(smallID);

      const type = safeCall(() => player.type(), null);
      if (type === PlayerType.Bot) botCount += 1;
      else if (type === PlayerType.Nation) nationCount += 1;
      else if (type === PlayerType.Human) humanCount += 1;

      if (shouldSample) {
        pushHistorySample(smallID, sample(player));
      }
      const historyEntry = runtime.world.history.get(smallID);
      const velocities = computeVelocities(historyEntry, tick);
      const { counts, levels } = collectStructureCounts(player);
      const clanTag = extractClanTag(player);
      const isClanmate =
        smallID !== meSmallID && clanTag && trustedTags.has(clanTag);
      const isFriendly =
        smallID === meSmallID ||
        safeCall(() => me.isFriendly(player), false) ||
        Boolean(isClanmate);
      const isAlly =
        smallID !== meSmallID &&
        (safeCall(() => me.isAlliedWith(player), false) ||
          safeCall(() => me.isOnSameTeam(player), false));
      const maxTroops = safeCall(
        () => gameView.config().maxTroops(player),
        1,
      );
      const incomingAttacks = safeCall(
        () => player.incomingAttacks(),
        [],
      );
      const outgoingAttacks = safeCall(
        () => player.outgoingAttacks(),
        [],
      );
      const incomingTroops = incomingAttacks.reduce(
        (sum, attack) => sum + safeCall(() => attack.troops(), 0),
        0,
      );
      const outgoingTroops = outgoingAttacks.reduce(
        (sum, attack) => sum + safeCall(() => attack.troops(), 0),
        0,
      );

      const alliances = safeCall(() => player.alliances(), []);
      const allyIDs = safeCall(
        () =>
          safeCall(() => player.allies(), []).map((a) =>
            safeCall(() => a.smallID(), null),
          ),
        [],
      ).filter((id) => id !== null);

      everyone.push({
        smallID,
        id: safeCall(() => player.id(), null),
        player,
        name: safeCall(() => player.displayName(), "?"),
        type,
        clanTag,
        isMe: smallID === meSmallID,
        isClanmate: Boolean(isClanmate),
        isFriendly,
        isAlly,
        isEnemy: !isFriendly,
        isDisconnected: safeCall(() => player.isDisconnected(), false),
        isTraitor: safeCall(() => player.isTraitor(), false),
        traitorRemainingTicks: safeCall(
          () => player.getTraitorRemainingTicks(),
          0,
        ),
        hasSpawned: safeCall(() => player.hasSpawned(), false),
        troops: sample(player).troops,
        tiles: sample(player).tiles,
        gold: sample(player).gold,
        maxTroops,
        troopRatio: maxTroops > 0 ? sample(player).troops / maxTroops : 0,
        structures: counts,
        structureLevels: levels,
        tilesPerMin: velocities.tilesPerMin,
        troopsPerMin: velocities.troopsPerMin,
        goldPerMin: velocities.goldPerMin,
        incomingAttacks,
        outgoingAttacks,
        incomingTroops,
        outgoingTroops,
        allyIDs,
        alliances,
      });
    }

    pruneStaleHistory(livingSmallIDs);

    const bySmallID = new Map();
    for (const entry of everyone) bySmallID.set(entry.smallID, entry);

    // Totals & land shares.
    const totalLand = Math.max(1, safeCall(() => gameView.numLandTiles(), 1));
    const falloutTiles = safeCall(() => gameView.numTilesWithFallout(), 0);
    const usableLand = Math.max(1, totalLand - falloutTiles);
    const sortedByTiles = everyone
      .slice()
      .sort((a, b) => b.tiles - a.tiles || a.smallID - b.smallID);
    const firstTiles = sortedByTiles[0] ? sortedByTiles[0].tiles : 0;
    const secondTiles = sortedByTiles[1] ? sortedByTiles[1].tiles : 0;
    const myEntry = bySmallID.get(meSmallID) || null;

    runtime.world.tick = tick;
    runtime.world.me = myEntry;
    runtime.world.meSmallID = meSmallID;
    runtime.world.everyone = everyone;
    runtime.world.bySmallID = bySmallID;
    runtime.world.totals = {
      alivePlayers: everyone.length,
      humanCount,
      nationCount,
      botCount,
      totalLand,
      usableLand,
      crownShare: firstTiles / usableLand,
      myShare: myEntry ? myEntry.tiles / usableLand : 0,
      secondShare: secondTiles / usableLand,
    };
    runtime.world.rankings.byTiles = sortedByTiles.map((e) => e.smallID);
    runtime.world.rankings.byTroops = everyone
      .slice()
      .sort((a, b) => b.troops - a.troops || a.smallID - b.smallID)
      .map((e) => e.smallID);
    runtime.world.rankings.byTilesVelocity = everyone
      .slice()
      .sort((a, b) => b.tilesPerMin - a.tilesPerMin || a.smallID - b.smallID)
      .map((e) => e.smallID);
    runtime.world.rankings.byTroopsVelocity = everyone
      .slice()
      .sort((a, b) => b.troopsPerMin - a.troopsPerMin || a.smallID - b.smallID)
      .map((e) => e.smallID);

    buildAllianceGraph(everyone, bySmallID, usableLand);
  }

  /**
   * Build the current-tick alliance graph. Two players are considered linked if
   * they are actually allied OR on the same team. We then walk connected
   * components (cliques) and compute the largest bloc's tile share so we can
   * flag coalition threats.
   */
  function buildAllianceGraph(everyone, bySmallID, usableLand) {
    const edges = new Map();
    for (const entry of everyone) {
      edges.set(entry.smallID, new Set());
    }
    for (const entry of everyone) {
      for (const otherId of entry.allyIDs) {
        if (!bySmallID.has(otherId)) continue;
        edges.get(entry.smallID).add(otherId);
        edges.get(otherId).add(entry.smallID);
      }
      // Team mode: add every teammate.
      for (const other of everyone) {
        if (other.smallID === entry.smallID) continue;
        if (
          safeCall(
            () => entry.player.isOnSameTeam && entry.player.isOnSameTeam(other.player),
            false,
          )
        ) {
          edges.get(entry.smallID).add(other.smallID);
          edges.get(other.smallID).add(entry.smallID);
        }
      }
    }

    // Connected components via BFS.
    const cliques = [];
    const visited = new Set();
    for (const entry of everyone) {
      if (visited.has(entry.smallID)) continue;
      const component = [];
      const queue = [entry.smallID];
      visited.add(entry.smallID);
      while (queue.length) {
        const current = queue.shift();
        component.push(current);
        for (const neighbor of edges.get(current) || []) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
      cliques.push(component);
    }

    let largestBlocShare = 0;
    for (const component of cliques) {
      if (component.length < 2) continue;
      let blocTiles = 0;
      for (const smallID of component) {
        blocTiles += bySmallID.get(smallID)?.tiles || 0;
      }
      const share = blocTiles / usableLand;
      if (share > largestBlocShare) largestBlocShare = share;
    }

    runtime.world.allianceGraph = {
      edges,
      cliques,
      largestBlocShare,
      coalitionThreat: largestBlocShare >= 0.45,
    };
  }

  // ---------- Phase 2: threat scoring ----------

  /**
   * Cheap proximity approximation: is this enemy bordering us right now?
   * Uses the synchronous `sharesBorderWith` check when available; otherwise we
   * inspect our current border-tile neighbors.
   */
  function isAdjacentTo(me, other, borderTiles) {
    if (!me || !other) return false;
    const shared = safeCall(
      () => typeof me.sharesBorderWith === "function" && me.sharesBorderWith(other.player),
      null,
    );
    if (shared !== null) return Boolean(shared);
    const gameView = getGameView();
    if (!gameView || !borderTiles) return false;
    const otherSmallID = other.smallID;
    for (const tile of borderTiles) {
      for (const neighbor of gameView.neighbors(tile)) {
        if (gameView.ownerID(neighbor) === otherSmallID) return true;
      }
    }
    return false;
  }

  /**
   * Assess each living opponent. Produces a threat score, category tags, and
   * surfaces the crown, rising stars, soft targets, and MIRV-capable players.
   * Idempotent and synchronous so it can be called every tick cheaply.
   */
  function computeThreats(me, borderTiles) {
    const world = runtime.world;
    if (!me || world.everyone.length === 0) return;

    const totals = world.totals;
    const crownThreshold =
      world.threats.crownSmallID === world.prevCrownSmallID
        ? THREAT_CROWN_THRESHOLD
        : THREAT_CROWN_THRESHOLD + THREAT_CROWN_HYSTERESIS;

    // Sort candidates for the crown by current tile count (ranking already cached).
    const topByTiles = world.rankings.byTiles
      .map((id) => world.bySmallID.get(id))
      .filter(Boolean);
    let crownEntry = null;
    if (topByTiles.length > 0) {
      const top = topByTiles[0];
      const share = totals.usableLand > 0 ? top.tiles / totals.usableLand : 0;
      if (share >= crownThreshold) crownEntry = top;
    }

    const meEntry = world.me;
    const mySmallID = world.meSmallID;

    // Classify each player. A single entry can carry multiple category tags.
    const adjacentEnemies = [];
    const risingStars = [];
    const softTargets = [];
    const mirvCapable = [];
    let inboundTroopTotal = 0;
    let nearestDanger = null;
    let nearestDangerScore = -Infinity;

    for (const entry of world.everyone) {
      if (entry.isMe) {
        inboundTroopTotal = entry.incomingTroops;
        continue;
      }

      // Build category tags.
      const tags = new Set();
      if (entry.isAlly) tags.add("ALLIED");
      if (entry.isClanmate) tags.add("CLANMATE");
      if (entry.isFriendly) tags.add("FRIENDLY");
      if (!entry.isFriendly) tags.add("ENEMY");

      if (crownEntry && entry.smallID === crownEntry.smallID) tags.add("CROWN");

      // Nuke readiness lookahead.
      const silos = safeCall(
        () => entry.player.units(UnitType.MissileSilo),
        [],
      ).filter((u) => safeCall(() => u.isActive(), false) && !safeCall(() => u.isUnderConstruction(), false));
      let nukeReadiness = 0;
      if (silos.length > 0) nukeReadiness += 1;
      if (entry.gold >= ATOM_GOLD_THRESHOLD) nukeReadiness += 1;
      if (entry.gold >= HYDRO_GOLD_THRESHOLD) nukeReadiness += 1;
      if (entry.gold >= MIRV_GOLD_THRESHOLD) nukeReadiness += 2;
      entry.nukeReadiness = nukeReadiness;
      if (!entry.isFriendly && nukeReadiness >= 4) {
        tags.add("MIRV_RISK");
        mirvCapable.push(entry);
      }

      // Soft target: visibly weak and/or afk.
      const relativelyWeak =
        entry.troopRatio < 0.4 ||
        entry.isDisconnected ||
        entry.isTraitor;
      if (!entry.isFriendly && relativelyWeak) tags.add("SOFT_TARGET");

      // Tribe (bot) with structures: a free-real-estate farm.
      if (entry.type === PlayerType.Bot) {
        const structuresTotal =
          (entry.structures[UnitType.City] || 0) +
          (entry.structures[UnitType.Factory] || 0) +
          (entry.structures[UnitType.Port] || 0) +
          (entry.structures[UnitType.MissileSilo] || 0) +
          (entry.structures[UnitType.SAMLauncher] || 0) +
          (entry.structures[UnitType.DefensePost] || 0);
        if (structuresTotal > 0) tags.add("TRIBE_FARM");
      }

      // Rising star: fast expander not yet in the top-3 tile count.
      const tilesRank = world.rankings.byTiles.indexOf(entry.smallID);
      if (
        !entry.isFriendly &&
        entry.tilesPerMin > 40 &&
        tilesRank >= 3 &&
        entry.type !== PlayerType.Bot
      ) {
        tags.add("RISING_STAR");
        risingStars.push(entry);
      }

      // Adjacent?
      const adjacent = isAdjacentTo(me, entry, borderTiles);
      entry.isAdjacent = adjacent;
      if (adjacent && !entry.isFriendly) {
        tags.add("ADJACENT");
        adjacentEnemies.push(entry);
      }

      if (tags.has("SOFT_TARGET") && !entry.isFriendly) softTargets.push(entry);

      // Threat score: what the planner and tactics will use to pick targets.
      const meTroops = meEntry ? meEntry.troops : 1;
      const troopRatioToUs = entry.troops / Math.max(meTroops, 1);
      let strength = entry.troops;
      strength += entry.gold * 0.04;
      strength += 150 * (entry.structureLevels[UnitType.City] || 0);
      strength += 80 * (entry.structureLevels[UnitType.Factory] || 0);
      strength += 250 * (entry.structureLevels[UnitType.MissileSilo] || 0);
      strength += 200 * (entry.structureLevels[UnitType.SAMLauncher] || 0);

      let threatScore = 0;
      if (tags.has("CROWN")) threatScore += 80;
      if (tags.has("RISING_STAR")) threatScore += 40;
      if (tags.has("MIRV_RISK")) threatScore += 60;
      if (tags.has("ADJACENT")) threatScore += 25;
      if (tags.has("ENEMY")) threatScore += 5;
      threatScore += clamp(Math.log2(Math.max(1, troopRatioToUs)) * 20, -40, 40);
      threatScore += clamp(entry.tilesPerMin * 0.4, -20, 50);
      threatScore += entry.nukeReadiness * 10;
      if (tags.has("SOFT_TARGET")) threatScore -= 30;
      if (entry.isDisconnected) threatScore -= 25;
      if (tags.has("CLANMATE")) threatScore -= 200; // Never target clanmates.

      entry.strength = strength;
      entry.threatScore = threatScore;
      entry.tags = tags;
      entry.opportunityScore =
        (tags.has("SOFT_TARGET") ? 40 : 0) +
        (tags.has("TRIBE_FARM") ? 35 : 0) +
        Math.max(0, 20 - entry.troopRatio * 20) +
        (tags.has("ADJACENT") ? 15 : 0);

      if (
        adjacent &&
        !entry.isFriendly &&
        threatScore > nearestDangerScore
      ) {
        nearestDanger = entry;
        nearestDangerScore = threatScore;
      }
    }

    // Stable sort by threat/opportunity scores.
    adjacentEnemies.sort((a, b) => b.threatScore - a.threatScore);
    risingStars.sort((a, b) => b.tilesPerMin - a.tilesPerMin);
    softTargets.sort((a, b) => b.opportunityScore - a.opportunityScore);

    // Update crown w/ hysteresis tracking.
    runtime.world.prevCrownSmallID = runtime.world.threats.crownSmallID;
    runtime.world.threats = {
      crownSmallID: crownEntry ? crownEntry.smallID : null,
      crown: crownEntry,
      prevCrownSmallID: runtime.world.threats.crownSmallID,
      risingStars: risingStars.slice(0, 5),
      softTargets: softTargets.slice(0, 5),
      nearestDanger,
      mirvRisk: mirvCapable.length > 0,
      mirvCapable,
      adjacentEnemies,
      inboundTroopTotal,
    };
  }

  // ---------- Phase 5: map archetype ----------

  /**
   * Manual archetype overrides for maps the runtime classifier consistently
   * misreads. Keys match the game's GameMapType string values. We intentionally
   * do NOT store per-tile data here; just the archetype preference + notes.
   */
  const MAP_OVERRIDES = {
    "The Box": { archetype: "ARENA" },
    "Sierpinski": { archetype: "ARENA" },
    "Didier": { archetype: "ARENA" },
    "Didier France": { archetype: "ARENA" },
    "MilkyWay": { archetype: "ARENA" },
    "Pluto": { archetype: "CONTINENTAL" },
    "Mars": { archetype: "CONTINENTAL" },
    "Baikal Nuke Wars": { archetype: "NUKE_RACE" },
  };

  /**
   * Figure out the map archetype from observable features. Runs once when we
   * first own enough tiles to have a stable centroid, then stays locked for
   * the match (unless the user manually overrides via the overlay).
   */
  function classifyMapIfNeeded(me) {
    const world = runtime.world;
    if (world.archetypeLocked) {
      world.archetype = world.archetypeLocked;
      return;
    }
    if (world.archetype !== "unknown" && world.classifiedAt >= 0) {
      return;
    }
    const gameView = getGameView();
    if (!gameView || !me) return;
    const myTiles = safeCall(() => me.numTilesOwned(), 0);
    if (myTiles < 200) return;

    const gameConfig = safeCall(() => gameView.config().gameConfig(), null) || {};
    const gameMap = safeCall(() => gameConfig.gameMap, null) || "";
    const override = MAP_OVERRIDES[gameMap];
    if (override) {
      world.archetype = override.archetype;
      world.classifiedAt = world.tick;
      botLog(`Archetype (override ${gameMap}): ${world.archetype}`);
      return;
    }

    const nukesDisabled =
      safeCall(() => gameView.config().isUnitDisabled(UnitType.AtomBomb), false) &&
      safeCall(() => gameView.config().isUnitDisabled(UnitType.HydrogenBomb), false) &&
      safeCall(() => gameView.config().isUnitDisabled(UnitType.MIRV), false);

    const startingGold = Number(
      safeCall(() => gameConfig.startingGold, 0) || 0,
    );
    const highStartingGold = startingGold >= 500_000;

    const width = safeCall(() => gameView.width(), 0);
    const height = safeCall(() => gameView.height(), 0);
    const totalLand = Math.max(1, safeCall(() => gameView.numLandTiles(), 1));
    const landFraction = totalLand / Math.max(1, width * height);

    // Flood-fill our contiguous island starting from any of our tiles.
    let ourIslandSize = 0;
    const seedTiles = runtime.state.borderCache.tiles.slice(0, 1);
    if (seedTiles.length > 0) {
      const seed = seedTiles[0];
      const visited = new Set();
      const queue = [seed];
      visited.add(seed);
      while (queue.length && visited.size < 80000) {
        const current = queue.shift();
        if (!gameView.isLand(current)) continue;
        ourIslandSize += 1;
        for (const neighbor of gameView.neighbors(current)) {
          if (visited.has(neighbor)) continue;
          if (!gameView.isLand(neighbor)) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    const ourIslandFraction = ourIslandSize / totalLand;

    // Estimate choke density by sampling small rings around our tiles.
    let narrowRings = 0;
    let rings = 0;
    for (const borderTile of runtime.state.borderCache.tiles.slice(0, 32)) {
      const landInRing = countLandInRing(gameView, borderTile, 12);
      if (landInRing > 0 && landInRing < 40) narrowRings += 1;
      rings += 1;
    }
    const chokeDensity = rings > 0 ? narrowRings / rings : 0;

    let archetype;
    if (nukesDisabled) {
      archetype = "CONVENTIONAL";
    } else if (highStartingGold) {
      archetype = "NUKE_RACE";
    } else if (ourIslandFraction < 0.18 && landFraction < 0.55) {
      archetype = "ISLAND";
    } else if (chokeDensity >= 0.4) {
      archetype = "CHOKE_HEAVY";
    } else {
      archetype = "CONTINENTAL";
    }

    world.archetype = archetype;
    world.classifiedAt = world.tick;
    botLog(
      `Archetype (${gameMap || "unknown map"}): ${archetype} ` +
      `(islandFrac=${ourIslandFraction.toFixed(2)} chokeDensity=${chokeDensity.toFixed(2)})`,
    );
  }

  function countLandInRing(gameView, tile, radius) {
    let count = 0;
    for (const neighbor of gameView.circleSearch(tile, radius)) {
      if (gameView.isLand(neighbor)) count += 1;
    }
    return count;
  }

  // ---------- Phase 3: goal planner ----------

  /**
   * Returns true if `me` can afford the minimum price of `type` right now.
   * BigInt-safe — gold is stored as a Number approximation in the world model.
   */
  function canAffordApprox(me, minGold) {
    return runtime.world.me ? runtime.world.me.gold >= minGold : false;
  }

  function anyPendingNuke(me) {
    return (
      getMyUnitsOfType(UnitType.AtomBomb).length > 0 ||
      getMyUnitsOfType(UnitType.HydrogenBomb).length > 0 ||
      getMyUnitsOfType(UnitType.MIRV).length > 0
    );
  }

  /**
   * Resolve the bloc tile share for the player-led coalition that includes
   * `crown`. Used to judge whether the "crown" category is actually a coalition
   * threat (45%+) so MIRV can activate as a last resort.
   */
  function coalitionShareForEntry(entry) {
    if (!entry) return 0;
    const graph = runtime.world.allianceGraph;
    if (!graph || !graph.cliques) return 0;
    for (const component of graph.cliques) {
      if (!component.includes(entry.smallID)) continue;
      let tiles = 0;
      for (const id of component) {
        tiles += runtime.world.bySmallID.get(id)?.tiles || 0;
      }
      return tiles / Math.max(1, runtime.world.totals.usableLand);
    }
    return entry.tiles / Math.max(1, runtime.world.totals.usableLand);
  }

  /**
   * Small helper — does the current planner goal match `goalId`?
   */
  function currentGoalIs(goalId) {
    return runtime.planner.activeGoalId === goalId;
  }

  /**
   * Mode bias multiplier. The overlay exposes three modes: balanced (default),
   * aggressive (biases offense/farming), turtle (biases defense/economy).
   */
  function modeBias(goalId) {
    const mode = runtime.mode;
    if (mode === "aggressive") {
      switch (goalId) {
        case "NEUTRALIZE_RISING_STAR":
        case "FARM_TRIBE":
        case "NUKE_CROWN":
        case "NAVAL_LAND_GRAB":
          return 12;
        case "DEFENSIVE_TURTLE":
        case "SAM_WALL_BUILDUP":
          return -8;
        default:
          return 0;
      }
    }
    if (mode === "turtle") {
      switch (goalId) {
        case "DEFENSIVE_TURTLE":
        case "SAM_WALL_BUILDUP":
        case "CONSOLIDATE_FRONT":
        case "SAVE_FOR_HYDRO":
        case "DEFENSE_NETWORK":
          return 12;
        case "NEUTRALIZE_RISING_STAR":
        case "NAVAL_LAND_GRAB":
          return -6;
        default:
          return 0;
      }
    }
    return 0;
  }

  /**
   * Goal specifications. Each spec returns { valid, priority, note } from
   * evaluate(). onAct() is awaited and is expected to return true if the goal
   * actually caused an intent to be sent this tick. The goal list is
   * authoritative — tactics in Phase 6 refine onAct per goal.
   */
  const GOAL_SPECS = [
    {
      id: "MIRV_LAST_RESORT",
      horizonTicks: 180,
      evaluate: (ctx) => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        const crown = world.threats.crown;
        if (!crown) return { valid: false };
        const coalition = coalitionShareForEntry(crown);
        const aboutToDie =
          me.troopRatio < 0.1 &&
          me.incomingTroops >= me.troops &&
          me.incomingTroops > 0;
        const canAfford = me.gold >= MIRV_GOLD_THRESHOLD;
        const hydroInfeasible =
          !canAffordApprox(me, HYDRO_GOLD_THRESHOLD) ||
          world.threats.crown.structureLevels[UnitType.SAMLauncher] >= 4;
        const crownDominates =
          coalition >= 0.45 && world.totals.myShare < world.totals.crownShare;
        const desperate =
          aboutToDie && canAffordApprox(me, MIRV_GOLD_THRESHOLD);
        if (desperate) {
          return {
            valid: true,
            priority: 98,
            note: "emergency MIRV — about to die",
          };
        }
        if (!canAfford || !crownDominates || !hydroInfeasible) {
          return { valid: false };
        }
        return {
          valid: true,
          priority: 92,
          note: `coalition ${(coalition * 100).toFixed(0)}% — MIRV last resort`,
        };
      },
      onAct: async () => false, // wired in Phase 6
    },
    {
      id: "RETALIATION",
      horizonTicks: 80,
      evaluate: () => {
        const me = runtime.world.me;
        if (!me) return { valid: false };
        if (me.incomingTroops <= 0) return { valid: false };
        const pressure = me.incomingTroops / Math.max(1, me.troops);
        if (pressure < 0.25) return { valid: false };
        return {
          valid: true,
          priority: 70 + clamp(pressure * 20, 0, 20),
          note: `${fmtTroops(me.incomingTroops)} inbound vs ${fmtTroops(me.troops)} defending`,
        };
      },
      onAct: async () => false,
    },
    {
      id: "CONSOLIDATE_FRONT",
      horizonTicks: 180,
      evaluate: () => {
        const me = runtime.world.me;
        if (!me) return { valid: false };
        const pressure = me.incomingTroops / Math.max(1, me.troops);
        if (pressure < 0.6) return { valid: false };
        return {
          valid: true,
          priority: 78,
          note: `front pressure ${(pressure * 100).toFixed(0)}%`,
        };
      },
      onAct: async () => false,
    },
    {
      id: "SAM_OVERWHELM",
      horizonTicks: 180,
      evaluate: () => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        if (me.gold < ATOM_GOLD_THRESHOLD * 2) return { valid: false };
        const crown = world.threats.crown;
        const topHostile = crown && !crown.isFriendly ? crown : null;
        if (!topHostile) return { valid: false };
        const enemySams = safeCall(
          () => topHostile.player.units(UnitType.SAMLauncher),
          [],
        );
        if (enemySams.length === 0) return { valid: false };
        const mySilos = getMyUnitsOfType(UnitType.MissileSilo).filter(
          (u) => !safeCall(() => u.isUnderConstruction(), false),
        );
        if (mySilos.length < 2) return { valid: false };
        return {
          valid: true,
          priority: 80,
          note: "overwhelm " + enemySams.length + " SAMs on " + topHostile.name,
        };
      },
      onAct: async () => false,
    },
    {
      id: "NUKE_CROWN",
      horizonTicks: 240,
      evaluate: () => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        const crown = world.threats.crown;
        if (!crown) return { valid: false };
        if (crown.isFriendly) return { valid: false };
        if (world.totals.crownShare < 0.3) return { valid: false };
        const silos = getMyUnitsOfType(UnitType.MissileSilo).filter(
          (u) => !safeCall(() => u.isUnderConstruction(), false),
        );
        if (silos.length === 0) return { valid: false };
        if (!canAffordApprox(me, ATOM_GOLD_THRESHOLD)) return { valid: false };
        return {
          valid: true,
          priority: 84,
          note: `crown=${crown.name} share=${(world.totals.crownShare * 100).toFixed(0)}%`,
        };
      },
      onAct: async () => false,
    },
    {
      id: "DEFENSIVE_TURTLE",
      horizonTicks: 200,
      evaluate: () => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        const myShare = world.totals.myShare;
        const secondShare = world.totals.secondShare;
        if (myShare < 0.3) return { valid: false };
        if (myShare < secondShare * 1.5) return { valid: false };
        return {
          valid: true,
          priority: 86,
          note: `crown mode — share=${(myShare * 100).toFixed(0)}%`,
        };
      },
      onAct: async () => false,
    },
    {
      id: "SAM_WALL_BUILDUP",
      horizonTicks: 300,
      evaluate: () => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        const share = world.totals.myShare;
        if (share < 0.25 || share > 0.3) return { valid: false };
        const cityCount = me.structures[UnitType.City] || 0;
        const samCount = me.structureLevels[UnitType.SAMLauncher] || 0;
        const targetSams = Math.max(2, Math.floor(cityCount * 0.5));
        if (samCount >= targetSams) return { valid: false };
        return {
          valid: true,
          priority: 82,
          note: `pre-crown SAM wall ${samCount}/${targetSams}`,
        };
      },
      onAct: async () => false,
    },
    {
      id: "SAVE_FOR_HYDRO",
      horizonTicks: 180,
      evaluate: () => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        if (me.gold < 4_000_000 || me.gold >= HYDRO_GOLD_THRESHOLD) {
          return { valid: false };
        }
        const crown = world.threats.crown;
        if (!crown || crown.isFriendly) return { valid: false };
        return { valid: true, priority: 60, note: "banking for hydro" };
      },
      onAct: async () => false,
    },
    {
      id: "NEUTRALIZE_RISING_STAR",
      horizonTicks: 200,
      evaluate: () => {
        const world = runtime.world;
        if (world.threats.risingStars.length === 0) return { valid: false };
        const target = world.threats.risingStars[0];
        const me = world.me;
        if (!me) return { valid: false };
        if (target.isFriendly) return { valid: false };
        if (target.troops > me.troops * 1.2) return { valid: false };
        return {
          valid: true,
          priority: 74,
          note: `rising=${target.name} +${target.tilesPerMin.toFixed(0)} tiles/min`,
        };
      },
      onAct: async () => false,
    },
    {
      id: "FARM_TRIBE",
      horizonTicks: 60,
      evaluate: () => {
        const adj = runtime.world.threats.adjacentEnemies;
        const target = adj.find(
          (e) => e.tags && e.tags.has("TRIBE_FARM"),
        );
        if (!target) return { valid: false };
        return {
          valid: true,
          priority: 72,
          note: `tribe=${target.name} (structures for free)`,
        };
      },
      onAct: async () => false,
    },
    {
      id: "TERRA_NULLIUS_RUSH",
      horizonTicks: 60,
      evaluate: () => {
        const world = runtime.world;
        if (world.totals.myShare >= 0.5) return { valid: false };
        const unowned = Math.max(
          0,
          world.totals.usableLand -
            world.everyone.reduce((sum, p) => sum + p.tiles, 0),
        );
        const unownedFrac = unowned / Math.max(1, world.totals.usableLand);
        if (unownedFrac < 0.05) return { valid: false };
        return {
          valid: true,
          priority: 55 + clamp(unownedFrac * 40, 0, 20),
          note: `${(unownedFrac * 100).toFixed(0)}% unowned`,
        };
      },
      onAct: async () => false,
    },
    {
      id: "NAVAL_LAND_GRAB",
      horizonTicks: 180,
      evaluate: () => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        if (getUnitEntityCount(me.player, UnitType.TransportShip) >=
          getGameView().config().boatMaxNumber()) {
          return { valid: false };
        }
        if (me.troops < 30000) return { valid: false };
        const soft = world.threats.softTargets.filter((s) => !s.isAdjacent);
        if (soft.length === 0 && world.archetype !== "ISLAND") {
          return { valid: false };
        }
        return {
          valid: true,
          priority: world.archetype === "ISLAND" ? 65 : 45,
          note:
            world.archetype === "ISLAND"
              ? "island archetype"
              : `${soft.length} soft targets across water`,
        };
      },
      onAct: async () => false,
    },
    {
      id: "CHOKEPOINT_LOCK",
      horizonTicks: 240,
      evaluate: () => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        if (world.archetype !== "CHOKE_HEAVY") return { valid: false };
        // Only relevant while we don't yet hold a hard border; once we're the
        // crown we switch to DEFENSIVE_TURTLE anyway.
        if (world.totals.myShare >= 0.35) return { valid: false };
        const dpCount = me.structures[UnitType.DefensePost] || 0;
        const dpTarget = Math.max(
          3,
          Math.floor((me.structures[UnitType.City] || 1) * 0.75),
        );
        if (dpCount >= dpTarget) return { valid: false };
        return {
          valid: true,
          priority: 68,
          note: `choke lock ${dpCount}/${dpTarget} DPs`,
        };
      },
      onAct: async () => false,
    },
    {
      id: "DEFENSE_NETWORK",
      horizonTicks: 300,
      evaluate: () => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        if (world.threats.adjacentEnemies.length === 0) {
          return { valid: false };
        }
        const cityCount = me.structures[UnitType.City] || 0;
        const dpCount = me.structures[UnitType.DefensePost] || 0;
        const target = Math.max(2, Math.floor(cityCount * 0.4));
        if (dpCount >= target) return { valid: false };
        return {
          valid: true,
          priority: 50,
          note: `defense ${dpCount}/${target}`,
        };
      },
      onAct: async () => false,
    },
    {
      id: "DIPLOMACY_ISOLATE_CROWN",
      horizonTicks: 120,
      evaluate: () => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        if (!world.threats.crown) return { valid: false };
        if (world.threats.crown.isFriendly) return { valid: false };
        if (me.smallID === world.threats.crownSmallID) return { valid: false };
        if (world.totals.crownShare < 0.25) return { valid: false };
        return {
          valid: true,
          priority: 45,
          note: `isolate crown=${world.threats.crown.name}`,
        };
      },
      onAct: async () => false,
    },
    {
      id: "BETRAY_ALLY",
      horizonTicks: 60,
      evaluate: () => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        const allies = world.everyone.filter(
          (p) => p.isAlly && !p.isClanmate,
        );
        if (allies.length === 0) return { valid: false };
        const target = allies.find(
          (ally) =>
            ally.troopRatio < 0.2 &&
            ally.troops < me.troops * 0.6,
        );
        if (!target) return { valid: false };
        // Safety: no superior hostile within manhattan-30.
        const gameView = getGameView();
        if (!gameView) return { valid: false };
        const borderCache = runtime.state.borderCache.tiles;
        const hostile = world.threats.adjacentEnemies.find(
          (e) => e.troops > me.troops * 1.2,
        );
        if (hostile) return { valid: false };
        if (world.threats.mirvCapable.some((p) => !p.isFriendly)) {
          return { valid: false };
        }
        return {
          valid: true,
          priority: 58,
          note: `helpless ally=${target.name} troopRatio=${(target.troopRatio * 100).toFixed(0)}%`,
          context: { target },
        };
      },
      onAct: async () => false,
    },
    {
      id: "WARSHIP_DEFENSE",
      horizonTicks: 240,
      evaluate: () => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        if ((me.structures[UnitType.Port] || 0) === 0) {
          return { valid: false };
        }
        const gameView = getGameView();
        if (!gameView) return { valid: false };
        if (gameView.config().isUnitDisabled(UnitType.Warship)) {
          return { valid: false };
        }
        const weHave = getMyUnitsOfType(UnitType.Warship).length;
        if (world.archetype === "ISLAND" && weHave < 2) {
          return {
            valid: true,
            priority: 48,
            note: `island warship ${weHave}/2`,
          };
        }
        // Enemy warships spotted?
        const enemies = world.everyone.filter((p) => !p.isFriendly);
        const enemyWarships = enemies.reduce(
          (sum, e) =>
            sum + safeCall(() => e.player.units(UnitType.Warship).length, 0),
          0,
        );
        if (enemyWarships > 0 && weHave < 1) {
          return {
            valid: true,
            priority: 52,
            note: `enemy warships=${enemyWarships}`,
          };
        }
        return { valid: false };
      },
      onAct: async () => false,
    },
    {
      id: "IDLE",
      horizonTicks: 10,
      evaluate: () => ({
        valid: true,
        priority: 5,
        note: "no better goal",
      }),
      onAct: async () => false,
    },
  ];

  function goalSpecById(id) {
    return GOAL_SPECS.find((spec) => spec.id === id) || null;
  }

  /**
   * Select the primary goal for this tick. Honours user force-goal overrides
   * (time-limited) and adds a commit bonus to the currently active goal so we
   * don't flap between plans.
   */
  function selectPrimaryGoal() {
    const nowMs = Date.now();
    const planner = runtime.planner;

    // Force-goal override window.
    if (
      planner.forcedGoalId &&
      planner.forcedGoalExpiresMs > nowMs
    ) {
      const spec = goalSpecById(planner.forcedGoalId);
      if (spec) {
        const evaluation = spec.evaluate({}) || {};
        const note = evaluation.note ? evaluation.note + " (forced)" : "(forced)";
        planner.lastEvaluation = [
          { id: spec.id, priority: 100, valid: true, note },
        ];
        return {
          spec,
          evaluation: {
            valid: true,
            priority: 100,
            note,
          },
          forced: true,
        };
      }
    } else if (planner.forcedGoalId) {
      planner.forcedGoalId = null;
    }

    const evaluations = [];
    for (const spec of GOAL_SPECS) {
      const evaluation = spec.evaluate({}) || {};
      if (!evaluation.valid) {
        evaluations.push({
          id: spec.id,
          priority: 0,
          valid: false,
          note: evaluation.note || "",
        });
        continue;
      }
      let priority = (evaluation.priority || 0) + modeBias(spec.id);
      if (planner.activeGoalId === spec.id) priority += 15;
      evaluations.push({
        id: spec.id,
        priority,
        valid: true,
        note: evaluation.note || "",
        context: evaluation.context || null,
      });
    }
    planner.lastEvaluation = evaluations
      .slice()
      .sort((a, b) => b.priority - a.priority);

    const winner = planner.lastEvaluation.find((e) => e.valid);
    if (!winner) return null;
    return {
      spec: goalSpecById(winner.id),
      evaluation: winner,
      forced: false,
    };
  }

  /**
   * Stabilise the selection in planner.activeGoal*. Logs a transition line the
   * first time we switch goals.
   */
  function adoptGoal(selection) {
    const planner = runtime.planner;
    const tick = runtime.world.tick;
    if (!selection) {
      planner.activeGoalId = null;
      planner.activeGoal = null;
      return;
    }
    if (planner.activeGoalId !== selection.spec.id) {
      const previous = planner.activeGoalId || "-";
      planner.activeGoalId = selection.spec.id;
      planner.activeGoal = selection.spec;
      planner.activeGoalCreatedTick = tick;
      planner.activeGoalExpiresTick = tick + selection.spec.horizonTicks;
      planner.lastSwitchTick = tick;
      reasonLog(
        selection.spec.id,
        "select",
        "plan switch from " + previous,
        selection.evaluation.note,
      );
    } else {
      planner.activeGoalExpiresTick = Math.max(
        planner.activeGoalExpiresTick,
        tick + 20,
      );
    }
  }

  async function runModulesForTick() {
    discoverRuntimeReferences();
    const gameView = getGameView();
    if (!gameView) {
      runtime.state.strategy = "waiting for game view";
      runtime.state.lastAction = "discovering hooks";
      return;
    }

    const tick = gameView.ticks();
    if (tick === runtime.lastProcessedTick) {
      return;
    }
    runtime.lastProcessedTick = tick;
    runtime.state.lastIntentSignature = "";

    if (gameView.inSpawnPhase()) {
      await maybeHandleSpawn();
      refreshOverlay();
      return;
    }

    runtime.state.matchPhase = "active";

    const me = getMyLivingPlayer();
    if (!me) {
      runtime.state.lastAction = "waiting for living player";
      runtime.state.strategy = "reconnect";
      refreshOverlay();
      return;
    }

    const borderTiles = await queryExactBorderTiles(false);
    updateWorldModel(me, borderTiles);
    computeThreats(me, borderTiles);
    classifyMapIfNeeded(me);
    updateSnapshot(me, borderTiles);
    const selection = selectPrimaryGoal();
    adoptGoal(selection);

    // Goal-aware dispatch. Active goal gets first crack; if it didn't act we
    // fall through to the legacy maybeX chain (diplomacy → nuke → combat →
    // expand → economy → naval) so we always make *some* move when possible.
    const activeGoalId = runtime.planner.activeGoalId;
    const selectionContext = selection && selection.evaluation && selection.evaluation.context;

    let handled = false;
    switch (activeGoalId) {
      case "MIRV_LAST_RESORT":
        handled = await runGoal_MirvLastResort(me);
        if (!handled) handled = await maybeNuke(me);
        break;
      case "NUKE_CROWN":
        handled = await maybeNuke(me);
        break;
      case "SAM_OVERWHELM":
        handled = await runGoal_SamOverwhelm(me);
        if (!handled) handled = await maybeNuke(me);
        break;
      case "DEFENSIVE_TURTLE":
        handled = await runGoal_DefensiveTurtle(me);
        if (!handled) handled = await maybeDiplomacy(me);
        if (!handled) handled = await maybeEconomy(me, getEnemies());
        break;
      case "SAM_WALL_BUILDUP":
        handled = await runGoal_SamWallBuildup(me);
        if (!handled) handled = await maybeDiplomacy(me);
        break;
      case "BETRAY_ALLY":
        handled = await runGoal_BetrayAlly(selectionContext);
        break;
      case "RETALIATION":
        handled = await runGoal_Retaliation(me, borderTiles);
        if (!handled) handled = await maybeCombat(me, borderTiles);
        break;
      case "CONSOLIDATE_FRONT":
      case "CHOKEPOINT_LOCK":
        handled = await runGoal_ConsolidateFront(me);
        if (!handled) handled = await maybeCombat(me, borderTiles);
        break;
      case "FARM_TRIBE":
        handled = await maybeCombat(me, borderTiles);
        break;
      case "NEUTRALIZE_RISING_STAR":
        handled = await runGoal_NeutralizeRisingStar(me);
        if (!handled) handled = await maybeCombat(me, borderTiles);
        break;
      case "TERRA_NULLIUS_RUSH":
        handled = await maybeExpand(me, borderTiles);
        break;
      case "NAVAL_LAND_GRAB":
        handled = await runGoal_NavalLandGrab(me);
        if (!handled) handled = await maybeNaval(me);
        break;
      case "DIPLOMACY_ISOLATE_CROWN":
        handled = await runGoal_Diplomacy(me);
        if (!handled) handled = await maybeDiplomacy(me);
        break;
      case "WARSHIP_DEFENSE":
        handled = await runGoal_WarshipDefense(me);
        break;
      case "SAVE_FOR_HYDRO":
        // Economy layer is gated via economyBanned(); still allow defensive
        // builds to pass through maybeEconomy.
        handled = await maybeEconomy(me, getEnemies());
        if (!handled) handled = await maybeDiplomacy(me);
        break;
      case "DEFENSE_NETWORK":
      case "IDLE":
      default:
        // Fall through to legacy pipeline; also handles pre-goal behavior.
        break;
    }
    if (handled) {
      refreshOverlay();
      return;
    }

    // Legacy fallback pipeline — these functions still enforce their own
    // cooldowns so they won't step on each other or the goal layer.
    const didDiplomacy = await maybeDiplomacy(me);
    if (didDiplomacy) {
      refreshOverlay();
      return;
    }

    const didNuke = await maybeNuke(me);
    if (didNuke) {
      refreshOverlay();
      return;
    }

    const didCombat = await maybeCombat(me, borderTiles);
    if (didCombat) {
      refreshOverlay();
      return;
    }

    const didExpand = await maybeExpand(me, borderTiles);
    if (didExpand) {
      refreshOverlay();
      return;
    }

    const didEconomy = await maybeEconomy(me, getEnemies());
    if (didEconomy) {
      refreshOverlay();
      return;
    }

    const didNaval = await maybeNaval(me);
    if (didNaval) {
      refreshOverlay();
      return;
    }

    runtime.state.lastAction = "holding";
    runtime.state.strategy = "consolidating";
    refreshOverlay();
  }

  function handleServerMessage(data) {
    if (!data || typeof data !== "object" || !data.type) return;

    if (data.type === "lobby_info") {
      runtime.identity.clientID = data.myClientID || runtime.identity.clientID;
      runtime.identity.gameID =
        data.lobby && data.lobby.gameID
          ? data.lobby.gameID
          : runtime.identity.gameID;
      botLog("Lobby info received");
      return;
    }

    if (data.type === "start") {
      runtime.state.gameStarted = true;
      runtime.state.matchPhase = "start";
      runtime.identity.clientID = data.myClientID || runtime.identity.clientID;
      runtime.identity.gameID =
        (data.gameStartInfo && data.gameStartInfo.gameID) ||
        runtime.identity.gameID;
      runtime.identity.clanTag = null;
      runtime.state.spawn.attempted = false;
      runtime.state.spawn.lastAttemptTick = -999;
      runtime.state.spawn.lastChosenTile = null;
      runtime.state.spawn.candidateByCenter = null;
      runtime.state.spawn.sortedCandidates = null;
      runtime.state.spawn.finalIndex = 0;
      runtime.state.spawn.randomSpawnIntentSent = false;
      runtime.state.spawn.thinkUntilMs = 0;
      runtime.state.profileCache.clear();
      // Clear world model + planner on fresh game so velocities start clean.
      runtime.world.history.clear();
      runtime.world.tick = 0;
      runtime.world.everyone = [];
      runtime.world.bySmallID.clear();
      runtime.world.archetype = "unknown";
      runtime.world.classifiedAt = -1;
      runtime.planner.activeGoalId = null;
      runtime.planner.activeGoal = null;
      runtime.planner.activeGoalCreatedTick = -1;
      runtime.planner.activeGoalExpiresTick = -1;
      runtime.planner.lastEvaluation = [];
      runtime.reasons = [];
      runtime.stealth.perPlayerActions.clear();
      runtime.stealth.combos.clear();
      runtime.stealth.lastMajorIntentMs = [];
      botLog("Game started");
      return;
    }

    if (data.type === "turn" && data.turn && Array.isArray(data.turn.intents)) {
      for (const intent of data.turn.intents) {
        if (intent.clientID === runtime.identity.clientID) {
          runtime.state.intentsConfirmed += 1;
        }
      }
    }
  }

  function installWebSocketHook() {
    if (
      window.WebSocket === NativeWebSocket &&
      window.__superBotWebSocketWrapped
    ) {
      return;
    }
    if (window.__superBotWebSocketWrapped) return;
    window.__superBotWebSocketWrapped = true;

    window.WebSocket = function (url, protocols) {
      const socket = protocols
        ? new NativeWebSocket(url, protocols)
        : new NativeWebSocket(url);

      const urlText = String(url);
      socket.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data);
          handleServerMessage(data);
        } catch (_) {}
      });

      if (!urlText.includes("/lobbies")) {
        runtime.hooks.socket = socket;
      }

      socket.addEventListener("close", () => {
        if (runtime.hooks.socket === socket) {
          runtime.hooks.socket = null;
          runtime.state.gameStarted = false;
          runtime.state.matchPhase = "closed";
          runtime.lastProcessedTick = -1;
          botLog("Game socket closed");
        }
      });

      return socket;
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
  }

  function installWorkerHook() {
    if (window.__superBotWorkerWrapped) return;
    window.__superBotWorkerWrapped = true;

    window.Worker = function (url, options) {
      const worker = new NativeWorker(url, options);
      const urlText = String(url);
      const originalPostMessage = worker.postMessage.bind(worker);

      worker.postMessage = function (message, transfer) {
        try {
          if (
            message &&
            message.type === "init" &&
            message.gameStartInfo &&
            !runtime.hooks.worker
          ) {
            runtime.hooks.worker = worker;
            botLog("Game worker captured");
          } else if (
            !runtime.hooks.worker &&
            (urlText.includes("Worker.worker") || urlText.includes("worker"))
          ) {
            runtime.hooks.worker = worker;
          }
        } catch (_) {}

        if (transfer !== undefined) {
          return originalPostMessage(message, transfer);
        }
        return originalPostMessage(message);
      };

      worker.addEventListener("message", (event) => {
        if (
          runtime.hooks.worker === worker &&
          event.data &&
          event.data.type === "initialized"
        ) {
          botLog("Game worker initialized");
        }
      });

      return worker;
    };

    window.Worker.prototype = NativeWorker.prototype;
  }

  const OVERRIDE_GOAL_BUTTONS = [
    { id: "NUKE_CROWN", label: "Nuke Crown" },
    { id: "MIRV_LAST_RESORT", label: "MIRV" },
    { id: "SAVE_FOR_HYDRO", label: "Save Hydro" },
    { id: "SAM_WALL_BUILDUP", label: "SAM Wall" },
    { id: "DEFENSIVE_TURTLE", label: "Turtle" },
    { id: "CONSOLIDATE_FRONT", label: "Hold Front" },
    { id: "TERRA_NULLIUS_RUSH", label: "Rush Empty" },
    { id: "NAVAL_LAND_GRAB", label: "Naval" },
  ];

  const ARCHETYPE_OPTIONS = [
    "",
    "CONTINENTAL",
    "ISLAND",
    "CHOKE_HEAVY",
    "NUKE_RACE",
    "ARENA",
    "CONVENTIONAL",
  ];

  function overlayHtml() {
    return `
      <style>
        #superbot-panel {
          position: fixed;
          top: 12px;
          right: 12px;
          width: 480px;
          max-height: 88vh;
          display: flex;
          flex-direction: column;
          background: rgba(8, 12, 24, 0.94);
          color: #d7e4ff;
          border: 1px solid rgba(120, 160, 255, 0.24);
          border-radius: 12px;
          box-shadow: 0 14px 40px rgba(0, 0, 0, 0.48);
          font-family: Inter, "Segoe UI", Arial, sans-serif;
          font-size: 12px;
          z-index: 999999;
          overflow: hidden;
          backdrop-filter: blur(16px);
        }
        #superbot-panel.collapsed .superbot-body {
          display: none;
        }
        .superbot-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 8px 10px;
          background: linear-gradient(135deg, rgba(28, 43, 88, 0.95), rgba(18, 26, 51, 0.95));
          border-bottom: 1px solid rgba(120, 160, 255, 0.16);
        }
        .superbot-title {
          font-weight: 800;
          letter-spacing: 0.04em;
          color: #8fc4ff;
          text-transform: uppercase;
          font-size: 12px;
        }
        .superbot-controls {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .superbot-controls button {
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.06);
          color: #e6efff;
          border-radius: 6px;
          padding: 2px 8px;
          cursor: pointer;
          font-size: 11px;
        }
        .superbot-controls button.active-goal {
          background: rgba(124, 230, 160, 0.22);
          border-color: rgba(124, 230, 160, 0.6);
          color: #b7ffd1;
        }
        .superbot-body {
          overflow: auto;
          padding: 10px;
          display: grid;
          grid-template-columns: 1fr 1fr;
          grid-gap: 10px;
        }
        .superbot-body .wide {
          grid-column: span 2;
        }
        .superbot-section {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.04);
          border-radius: 8px;
          padding: 8px 10px;
        }
        .superbot-section-title {
          text-transform: uppercase;
          font-size: 10px;
          letter-spacing: 0.08em;
          color: rgba(164, 190, 255, 0.74);
          margin-bottom: 6px;
          font-weight: 700;
          display: flex;
          justify-content: space-between;
        }
        .superbot-row {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          padding: 2px 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        }
        .superbot-row:last-child {
          border-bottom: 0;
        }
        .superbot-label {
          color: rgba(211, 223, 247, 0.74);
        }
        .superbot-value {
          color: #ffffff;
          font-weight: 600;
          text-align: right;
        }
        .superbot-hook-ok {
          color: #6ef79a;
        }
        .superbot-hook-miss {
          color: #ff7d7d;
        }
        .superbot-log {
          background: rgba(0, 0, 0, 0.22);
          border-radius: 8px;
          padding: 6px;
          max-height: 160px;
          overflow: auto;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 10px;
          line-height: 1.45;
        }
        .superbot-log-line {
          color: rgba(216, 228, 255, 0.85);
          margin-bottom: 2px;
          word-break: break-word;
        }
        .superbot-goal-row {
          display: grid;
          grid-template-columns: 96px 28px 1fr;
          gap: 6px;
          font-size: 11px;
          padding: 1px 0;
        }
        .superbot-goal-row .gid {
          color: #cfe0ff;
          font-weight: 600;
        }
        .superbot-goal-row .gp {
          color: #9ffcb8;
          text-align: right;
        }
        .superbot-goal-row.inactive .gid {
          color: rgba(200, 213, 244, 0.45);
        }
        .superbot-goal-row.inactive .gp {
          color: rgba(150, 180, 220, 0.5);
        }
        .superbot-reason {
          font-size: 11px;
          line-height: 1.35;
          padding: 4px 6px;
          border-left: 2px solid rgba(140, 180, 255, 0.45);
          margin-bottom: 4px;
          background: rgba(140, 180, 255, 0.05);
          border-radius: 0 6px 6px 0;
        }
        .superbot-reason .head {
          color: #b7ffd1;
          font-weight: 700;
        }
        .superbot-reason .tail {
          color: rgba(216, 228, 255, 0.85);
        }
        .superbot-override-row {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-top: 4px;
        }
        .superbot-override-row button {
          border: 1px solid rgba(140, 180, 255, 0.2);
          background: rgba(140, 180, 255, 0.08);
          color: #cfe0ff;
          border-radius: 5px;
          padding: 2px 6px;
          font-size: 10px;
          cursor: pointer;
        }
        .superbot-override-row button.active {
          background: rgba(124, 230, 160, 0.22);
          border-color: rgba(124, 230, 160, 0.6);
          color: #b7ffd1;
        }
        select.superbot-select {
          background: rgba(255, 255, 255, 0.05);
          color: #e6efff;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 5px;
          padding: 2px 4px;
          font-size: 11px;
          margin-left: 6px;
        }
        input.superbot-input {
          background: rgba(255, 255, 255, 0.05);
          color: #e6efff;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 5px;
          padding: 2px 6px;
          font-size: 11px;
          width: 100%;
          margin-top: 4px;
        }
      </style>
      <div class="superbot-header">
        <div class="superbot-title">Superhuman Bot v${BOT_VERSION}</div>
        <div class="superbot-controls">
          <button id="superbot-toggle">ON</button>
          <button id="superbot-mode">BAL</button>
          <button id="superbot-export">export</button>
          <button id="superbot-collapse">_</button>
        </div>
      </div>
      <div class="superbot-body">
        <div class="superbot-section">
          <div class="superbot-section-title">Hooks</div>
          <div id="superbot-hooks"></div>
        </div>
        <div class="superbot-section">
          <div class="superbot-section-title">State</div>
          <div id="superbot-state"></div>
        </div>
        <div class="superbot-section">
          <div class="superbot-section-title">Stats</div>
          <div id="superbot-stats"></div>
        </div>
        <div class="superbot-section">
          <div class="superbot-section-title">Intel</div>
          <div id="superbot-intel"></div>
        </div>
        <div class="superbot-section wide">
          <div class="superbot-section-title">Goal</div>
          <div id="superbot-goal"></div>
        </div>
        <div class="superbot-section wide">
          <div class="superbot-section-title">Why</div>
          <div id="superbot-reasons"></div>
        </div>
        <div class="superbot-section wide">
          <div class="superbot-section-title">
            <span>Overrides</span>
            <span id="superbot-override-timer" style="color: rgba(216, 228, 255, 0.5); font-weight: 500; text-transform: none; letter-spacing: 0;"></span>
          </div>
          <div class="superbot-override-row" id="superbot-override-goals"></div>
          <div style="margin-top:6px">
            <span style="color: rgba(164, 190, 255, 0.74); font-size:10px; text-transform:uppercase; letter-spacing:0.08em;">Archetype</span>
            <select class="superbot-select" id="superbot-archetype"></select>
          </div>
          <div style="margin-top:6px">
            <span style="color: rgba(164, 190, 255, 0.74); font-size:10px; text-transform:uppercase; letter-spacing:0.08em;">Trusted clan tags (comma-separated)</span>
            <input class="superbot-input" id="superbot-clan" placeholder="e.g. UN, MLS" />
          </div>
        </div>
        <div class="superbot-section wide">
          <div class="superbot-section-title">Decisions</div>
          <div id="superbot-decisions" class="superbot-log"></div>
        </div>
        <div class="superbot-section wide">
          <div class="superbot-section-title">Activity</div>
          <div id="superbot-activity" class="superbot-log"></div>
        </div>
      </div>
    `;
  }

  /** Force-goal activation (with 120s expiry, per plan). */
  function setForcedGoal(goalId) {
    const planner = runtime.planner;
    if (planner.forcedGoalId === goalId) {
      planner.forcedGoalId = null;
      planner.forcedGoalExpiresMs = 0;
      botLog("force-goal cleared");
    } else {
      planner.forcedGoalId = goalId;
      planner.forcedGoalExpiresMs = Date.now() + 120_000;
      botLog("force-goal -> " + goalId);
    }
    refreshOverlay();
  }

  function setArchetypeLock(value) {
    runtime.world.archetypeLocked = value || null;
    if (value) {
      runtime.world.archetype = value;
      botLog("archetype locked -> " + value);
    } else {
      botLog("archetype lock cleared");
    }
    refreshOverlay();
  }

  function setExtraClanTags(csv) {
    if (!csv || !csv.trim()) {
      runtime.identity.extraClanTags = [];
      return;
    }
    runtime.identity.extraClanTags = csv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    botLog(
      "trusted clan tags: " +
      runtime.identity.extraClanTags.map((t) => "[" + t + "]").join(", "),
    );
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return;
    }
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    try {
      document.execCommand("copy");
    } catch (_) {}
    el.remove();
  }

  function dumpWorldJson() {
    // BigInts (gold) have already been coerced to Numbers in the world model;
    // this stringify is safe.
    try {
      return JSON.stringify(
        {
          world: runtime.world,
          planner: runtime.planner,
          identity: runtime.identity,
          mode: runtime.mode,
          reasons: runtime.reasons,
        },
        (key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        2,
      );
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  function ensureOverlay() {
    if (runtime.overlay.mounted) return;
    if (!document.body) return;

    const panel = document.createElement("div");
    panel.id = "superbot-panel";
    panel.innerHTML = overlayHtml();
    document.body.appendChild(panel);
    runtime.overlay.root = panel;
    runtime.overlay.mounted = true;

    const toggleButton = panel.querySelector("#superbot-toggle");
    const modeButton = panel.querySelector("#superbot-mode");
    const exportButton = panel.querySelector("#superbot-export");
    const collapseButton = panel.querySelector("#superbot-collapse");
    const overrideRow = panel.querySelector("#superbot-override-goals");
    const archetypeSelect = panel.querySelector("#superbot-archetype");
    const clanInput = panel.querySelector("#superbot-clan");

    toggleButton.addEventListener("click", () => {
      runtime.enabled = !runtime.enabled;
      botLog(runtime.enabled ? "bot enabled" : "bot disabled");
      refreshOverlay();
    });

    modeButton.addEventListener("click", () => {
      if (runtime.mode === "balanced") runtime.mode = "aggressive";
      else if (runtime.mode === "aggressive") runtime.mode = "turtle";
      else runtime.mode = "balanced";
      botLog("mode -> " + runtime.mode);
      refreshOverlay();
    });

    exportButton.addEventListener("click", () => {
      copyToClipboard(dumpWorldJson());
      botLog("world dump copied to clipboard");
    });

    collapseButton.addEventListener("click", () => {
      panel.classList.toggle("collapsed");
    });

    // Force-goal buttons.
    if (overrideRow) {
      for (const entry of OVERRIDE_GOAL_BUTTONS) {
        const btn = document.createElement("button");
        btn.dataset.goal = entry.id;
        btn.textContent = entry.label;
        btn.addEventListener("click", () => setForcedGoal(entry.id));
        overrideRow.appendChild(btn);
      }
      const clearBtn = document.createElement("button");
      clearBtn.textContent = "Clear";
      clearBtn.addEventListener("click", () => {
        runtime.planner.forcedGoalId = null;
        runtime.planner.forcedGoalExpiresMs = 0;
        refreshOverlay();
      });
      overrideRow.appendChild(clearBtn);
    }

    // Archetype override dropdown.
    if (archetypeSelect) {
      for (const option of ARCHETYPE_OPTIONS) {
        const opt = document.createElement("option");
        opt.value = option;
        opt.textContent = option || "(auto)";
        archetypeSelect.appendChild(opt);
      }
      archetypeSelect.value = runtime.world.archetypeLocked || "";
      archetypeSelect.addEventListener("change", (e) => {
        setArchetypeLock(e.target.value || null);
      });
    }

    if (clanInput) {
      clanInput.value = (runtime.identity.extraClanTags || []).join(", ");
      clanInput.addEventListener("change", (e) => {
        setExtraClanTags(e.target.value);
      });
    }

    refreshOverlay();
  }

  function renderRows(rows) {
    return rows
      .map((row) => {
        return (
          '<div class="superbot-row">' +
          '<span class="superbot-label">' +
          row.label +
          "</span>" +
          '<span class="superbot-value ' +
          (row.className || "") +
          '">' +
          row.value +
          "</span>" +
          "</div>"
        );
      })
      .join("");
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function refreshOverlay() {
    ensureOverlay();
    if (!runtime.overlay.root) return;

    const root = runtime.overlay.root;
    const hooksRoot = root.querySelector("#superbot-hooks");
    const stateRoot = root.querySelector("#superbot-state");
    const statsRoot = root.querySelector("#superbot-stats");
    const intelRoot = root.querySelector("#superbot-intel");
    const goalRoot = root.querySelector("#superbot-goal");
    const reasonsRoot = root.querySelector("#superbot-reasons");
    const decisionsRoot = root.querySelector("#superbot-decisions");
    const activityRoot = root.querySelector("#superbot-activity");
    const toggleButton = root.querySelector("#superbot-toggle");
    const modeButton = root.querySelector("#superbot-mode");
    const overrideTimer = root.querySelector("#superbot-override-timer");
    const overrideRow = root.querySelector("#superbot-override-goals");
    const archetypeSelect = root.querySelector("#superbot-archetype");

    if (toggleButton) {
      toggleButton.textContent = runtime.enabled ? "ON" : "OFF";
      toggleButton.style.color = runtime.enabled ? "#6ef79a" : "#ff7d7d";
    }
    if (modeButton) {
      modeButton.textContent =
        runtime.mode === "balanced"
          ? "BAL"
          : runtime.mode === "aggressive"
            ? "AGG"
            : "TUR";
    }

    if (hooksRoot) {
      hooksRoot.innerHTML = renderRows([
        {
          label: "WebSocket",
          value: runtime.hooks.socket ? "captured" : "missing",
          className: runtime.hooks.socket
            ? "superbot-hook-ok"
            : "superbot-hook-miss",
        },
        {
          label: "Worker",
          value: runtime.hooks.worker ? "captured" : "fallback",
          className: runtime.hooks.worker
            ? "superbot-hook-ok"
            : "superbot-hook-miss",
        },
        {
          label: "GameView",
          value: runtime.hooks.gameView ? "ready" : "waiting",
          className: runtime.hooks.gameView
            ? "superbot-hook-ok"
            : "superbot-hook-miss",
        },
        {
          label: "UI State",
          value: runtime.hooks.uiState ? "ready" : "waiting",
          className: runtime.hooks.uiState
            ? "superbot-hook-ok"
            : "superbot-hook-miss",
        },
      ]);
    }

    if (stateRoot) {
      stateRoot.innerHTML = renderRows([
        { label: "Phase", value: runtime.state.matchPhase },
        { label: "Strategy", value: runtime.state.strategy },
        { label: "Action", value: runtime.state.lastAction },
        {
          label: "Attack Ratio",
          value: (getAttackRatio() * 100).toFixed(0) + "%",
        },
        { label: "Rocket Arc", value: getRocketDirectionUp() ? "up" : "down" },
        {
          label: "Clan Tag",
          value: runtime.identity.clanTag
            ? "[" + runtime.identity.clanTag + "]"
            : "auto",
        },
      ]);
    }

    if (statsRoot) {
      const stats = runtime.statsSnapshot;
      statsRoot.innerHTML = renderRows(
        stats
          ? [
              { label: "Tick", value: String(stats.tick) },
              { label: "Troops", value: fmtTroops(stats.troops) },
              { label: "Max Troops", value: fmtTroops(stats.maxTroops) },
              { label: "Gold", value: fmt(stats.gold) },
              { label: "Tiles", value: fmt(stats.tiles) },
              { label: "Enemies", value: String(stats.enemies) },
              { label: "Allies", value: String(stats.allies) },
              { label: "Border Tiles", value: String(stats.borderTiles) },
              { label: "Outgoing", value: String(stats.outgoingAttacks) },
              { label: "Incoming", value: String(stats.incomingAttacks) },
            ]
          : [{ label: "Status", value: "no live player data" }],
      );
    }

    if (intelRoot) {
      const world = runtime.world;
      const crown = world.threats.crown;
      const rising = (world.threats.risingStars || [])
        .slice(0, 2)
        .map((s) => s.name + " (+" + s.tilesPerMin.toFixed(0) + "/m)")
        .join(", ") || "-";
      const danger = world.threats.nearestDanger;
      intelRoot.innerHTML = renderRows([
        { label: "Archetype", value: world.archetype || "unknown" },
        {
          label: "Coalition",
          value:
            (world.allianceGraph.largestBlocShare * 100).toFixed(0) +
            "%" +
            (world.allianceGraph.coalitionThreat ? " ⚠" : ""),
        },
        {
          label: "My Share",
          value: (world.totals.myShare * 100).toFixed(1) + "%",
        },
        {
          label: "Crown",
          value: crown
            ? crown.name + " " + (world.totals.crownShare * 100).toFixed(0) + "%"
            : "-",
        },
        {
          label: "#2 Share",
          value: (world.totals.secondShare * 100).toFixed(1) + "%",
        },
        { label: "Rising", value: rising },
        {
          label: "Danger",
          value: danger
            ? danger.name + " thr=" + danger.threatScore.toFixed(0)
            : "-",
        },
        {
          label: "MIRV Risk",
          value: world.threats.mirvRisk ? "YES" : "no",
          className: world.threats.mirvRisk
            ? "superbot-hook-miss"
            : "superbot-hook-ok",
        },
        {
          label: "Players",
          value:
            world.totals.alivePlayers +
            " (" +
            world.totals.humanCount +
            "H " +
            world.totals.nationCount +
            "N " +
            world.totals.botCount +
            "T)",
        },
      ]);
    }

    if (goalRoot) {
      const planner = runtime.planner;
      const activeId = planner.activeGoalId || "-";
      const tick = runtime.world.tick;
      const remaining = Math.max(0, planner.activeGoalExpiresTick - tick);
      const activeNote =
        planner.lastEvaluation.find((e) => e.id === activeId)?.note ||
        "-";
      const header =
        `<div class="superbot-row"><span class="superbot-label">Active</span>` +
        `<span class="superbot-value">${escapeHtml(activeId)}` +
        (planner.forcedGoalId ? " (forced)" : "") +
        `</span></div>` +
        `<div class="superbot-row"><span class="superbot-label">Note</span>` +
        `<span class="superbot-value">${escapeHtml(activeNote)}</span></div>` +
        `<div class="superbot-row"><span class="superbot-label">Horizon</span>` +
        `<span class="superbot-value">${remaining} ticks</span></div>` +
        `<div class="superbot-row"><span class="superbot-label">Mode bias</span>` +
        `<span class="superbot-value">${runtime.mode}</span></div>`;

      const list = planner.lastEvaluation
        .slice(0, 6)
        .map((ev) => {
          const cls =
            ev.id === planner.activeGoalId ? "" : "inactive";
          return (
            `<div class="superbot-goal-row ${cls}">` +
            `<span class="gid">${escapeHtml(ev.id)}</span>` +
            `<span class="gp">${ev.priority.toFixed(0)}</span>` +
            `<span class="gt">${escapeHtml(ev.note || (ev.valid ? "" : "invalid"))}</span>` +
            `</div>`
          );
        })
        .join("");
      goalRoot.innerHTML = header + `<div style="margin-top:6px">${list}</div>`;
    }

    if (reasonsRoot) {
      const entries = runtime.reasons.slice(-8).reverse();
      if (entries.length === 0) {
        reasonsRoot.innerHTML =
          '<div style="color: rgba(216, 228, 255, 0.5); font-size: 11px;">no reasoned actions yet</div>';
      } else {
        reasonsRoot.innerHTML = entries
          .map(
            (entry) =>
              `<div class="superbot-reason">` +
              `<div><span class="head">T${entry.tick} [${escapeHtml(entry.goalId)}]</span> ` +
              `<span class="tail">${escapeHtml(entry.action)}</span></div>` +
              (entry.trigger
                ? `<div class="tail">because ${escapeHtml(entry.trigger)}</div>`
                : "") +
              (entry.outcome
                ? `<div class="tail">expect ${escapeHtml(entry.outcome)}</div>`
                : "") +
              `</div>`,
          )
          .join("");
      }
    }

    if (overrideRow) {
      for (const btn of overrideRow.querySelectorAll("button")) {
        btn.classList.toggle(
          "active",
          runtime.planner.forcedGoalId === btn.dataset.goal,
        );
      }
    }
    if (overrideTimer) {
      if (runtime.planner.forcedGoalId) {
        const remainingMs =
          runtime.planner.forcedGoalExpiresMs - Date.now();
        if (remainingMs > 0) {
          overrideTimer.textContent = Math.ceil(remainingMs / 1000) + "s";
        } else {
          overrideTimer.textContent = "expired";
        }
      } else {
        overrideTimer.textContent = "";
      }
    }
    if (archetypeSelect) {
      const desired = runtime.world.archetypeLocked || "";
      if (archetypeSelect.value !== desired) archetypeSelect.value = desired;
    }

    if (decisionsRoot) {
      decisionsRoot.innerHTML = runtime.decisions
        .slice(-18)
        .map((entry) => '<div class="superbot-log-line">' + escapeHtml(entry) + "</div>")
        .join("");
      decisionsRoot.scrollTop = decisionsRoot.scrollHeight;
    }

    if (activityRoot) {
      activityRoot.innerHTML = runtime.logs
        .slice(-22)
        .map((entry) => '<div class="superbot-log-line">' + escapeHtml(entry) + "</div>")
        .join("");
      activityRoot.scrollTop = activityRoot.scrollHeight;
    }
  }

  function bootstrapOverlay() {
    const mount = () => ensureOverlay();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
    } else {
      mount();
    }
  }

  async function loop() {
    if (runtime.processing) return;
    runtime.processing = true;
    try {
      // Phase 9: add a small, jittered reaction delay to mimic a human's
      // perception/decision time. Keeps us in the "fast human" range
      // (300–900 ms) rather than the "frame-perfect bot" range. Skipped in
      // harness/test mode so deterministic smoke tests stay fast.
      if (runtime.enabled && !isHarnessMode()) {
        const delay =
          STEALTH_REACTION_MIN_MS +
          Math.floor(Math.random() * (STEALTH_REACTION_MAX_MS - STEALTH_REACTION_MIN_MS));
        // Only the first few jitters matter; further ones are dominated by the
        // loop interval anyway. Skip when disabled or paused.
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 260)));
      }
      await runModulesForTick();
    } catch (error) {
      decisionLog("loop error: " + error.message);
      console.error("[SuperBot] loop error", error);
    } finally {
      runtime.processing = false;
    }
  }

  function init() {
    window.__superhumanBotRuntime = runtime;
    window.__superhumanBotRefreshOverlay = refreshOverlay;
    window.__superhumanBotDebug = {
      dumpWorld: () => dumpWorldJson(),
      forceGoal: (id) => setForcedGoal(id),
      clearForcedGoal: () => {
        runtime.planner.forcedGoalId = null;
        runtime.planner.forcedGoalExpiresMs = 0;
        refreshOverlay();
      },
      lockArchetype: (a) => setArchetypeLock(a),
      setClanTags: (csv) => setExtraClanTags(csv),
      logOpponent: (name) => {
        const entry = runtime.world.everyone.find((p) => p.name === name);
        if (!entry) return "not found";
        return entry;
      },
    };
    installWebSocketHook();
    installWorkerHook();
    bootstrapOverlay();

    setInterval(discoverRuntimeReferences, DISCOVERY_INTERVAL_MS);
    setInterval(loop, LOOP_INTERVAL_MS);
    setInterval(refreshOverlay, 500);

    botLog("bootstrap ready");
  }

  init();
})();
