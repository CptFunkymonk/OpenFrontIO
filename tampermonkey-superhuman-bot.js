// ==UserScript==
// @name         OpenFront.io Superhuman Bot
// @namespace    http://tampermonkey.net/
// @version      2.0.1
// @description  Standalone legality-aware OpenFront bot built from repo source
// @author       Cursor
// @match        https://openfront.io/*
// @match        http://localhost:*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const BOT_VERSION = "2.0.1";
  const TROOP_DISPLAY_DIVISOR = 10;
  const MAX_LOG_ENTRIES = 250;
  const MAX_DECISION_ENTRIES = 180;
  const LOOP_INTERVAL_MS = 140;
  const DISCOVERY_INTERVAL_MS = 400;

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
      },
      cooldowns: {
        expand: -999,
        combat: -999,
        economy: -999,
        naval: -999,
        nuke: -999,
        diplomacy: -999,
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
    },
    statsSnapshot: null,
    logs: [],
    decisions: [],
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

  function sendIntent(intent) {
    if (!runtime.enabled) return false;
    const signature = intent.type + ":" + JSON.stringify(intent);
    if (runtime.state.lastIntentSignature === signature) {
      return false;
    }
    const success = sendRawMessage({ type: "intent", intent });
    if (success) {
      runtime.state.lastIntentSignature = signature;
      runtime.state.intentsSent += 1;
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
        oceanPenalty += 0.5;
      }
    }

    const localOpen = countUnownedLandNear(center, 12);
    const flood = floodScoreFrom(center, 220);
    const terrainPoints =
      plains * 1000 + highland * 100 + mountain + spawnTiles.length;
    const strategic = localOpen * 2 + flood * 3 - ownedPenalty - oceanPenalty;
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

    if (gameView.config().isRandomSpawn()) {
      if (runtime.state.spawn.randomSpawnIntentSent) {
        runtime.state.lastAction = "waiting for random spawn confirm";
        runtime.state.strategy = "random-spawn";
        return false;
      }

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

      if (!runtime.state.spawn.sortedCandidates) {
        runtime.state.spawn.sortedCandidates = Array.from(
          runtime.state.spawn.candidateByCenter.values(),
        ).sort((a, b) => b.score - a.score);
        runtime.state.spawn.finalIndex = 0;
      }

      const list = runtime.state.spawn.sortedCandidates;
      while (runtime.state.spawn.finalIndex < list.length) {
        const cand = list[runtime.state.spawn.finalIndex];
        runtime.state.spawn.finalIndex += 1;
        const fresh = computeSpawnCenterScore(gameView, cand.center);
        if (fresh === null) {
          continue;
        }
        const ok = sendSpawn(cand.center);
        if (ok) {
          runtime.state.spawn.randomSpawnIntentSent = true;
          runtime.state.spawn.attempted = true;
          decisionLog(
            "random spawn intent " +
              gameView.x(cand.center) +
              "," +
              gameView.y(cand.center) +
              " score~" +
              fresh.toFixed(0),
          );
          botLog(
            "Spawn (random override) -> (" +
              gameView.x(cand.center) +
              "," +
              gameView.y(cand.center) +
              ")",
          );
          return true;
        }
      }

      for (let attempt = 0; attempt < 48; attempt++) {
        const sampled = trySampleSpawnCandidate(gameView);
        if (!sampled) continue;
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
    for (const type of BuildPriority) {
      if (!shouldBuildType(type, me, enemies)) continue;
      const built = await tryBuildStructure(type, candidateTiles);
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

    const enemies = getEnemies().sort((a, b) => a.troops() - b.troops());
    for (const enemy of enemies.slice(0, 4)) {
      const structureTiles = gatherStructureTiles(enemy);
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

        const reserveRatio = computeReserveRatio(
          me,
          gameView.config().maxTroops(me),
        );
        const available = Math.floor(
          me.troops() - gameView.config().maxTroops(me) * reserveRatio,
        );
        if (available < 8000) continue;

        const troops = clamp(
          Math.floor(available * 0.28),
          8000,
          Math.floor(me.troops() * 0.35),
        );
        const success = sendBoat(candidate, troops);
        if (!success) continue;

        runtime.state.cooldowns.naval = tick;
        runtime.state.lastAction =
          "naval invasion -> " + enemy.displayName() + " " + fmtTroops(troops);
        runtime.state.strategy = "naval";
        botLog("Boat -> " + enemy.displayName() + " " + fmtTroops(troops));
        return true;
      }
    }

    decisionLog("naval: no legal invasion path");
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
        const samRisk = lineIntersectsEnemySam(spawnTile, candidate, false)
          ? 50
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

  async function maybeDiplomacy(me) {
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
    updateSnapshot(me, borderTiles);

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
      runtime.state.spawn.attempted = false;
      runtime.state.spawn.lastAttemptTick = -999;
      runtime.state.spawn.candidateByCenter = null;
      runtime.state.spawn.sortedCandidates = null;
      runtime.state.spawn.finalIndex = 0;
      runtime.state.spawn.randomSpawnIntentSent = false;
      runtime.state.profileCache.clear();
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

  function overlayHtml() {
    return `
      <style>
        #superbot-panel {
          position: fixed;
          top: 12px;
          right: 12px;
          width: 340px;
          max-height: 76vh;
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
        .superbot-body {
          overflow: auto;
          padding: 10px;
        }
        .superbot-section {
          margin-bottom: 10px;
        }
        .superbot-section:last-child {
          margin-bottom: 0;
        }
        .superbot-section-title {
          text-transform: uppercase;
          font-size: 10px;
          letter-spacing: 0.08em;
          color: rgba(164, 190, 255, 0.74);
          margin-bottom: 4px;
          font-weight: 700;
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
          max-height: 118px;
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
        .superbot-log-line:last-child {
          margin-bottom: 0;
        }
      </style>
      <div class="superbot-header">
        <div class="superbot-title">Superhuman Bot v${BOT_VERSION}</div>
        <div class="superbot-controls">
          <button id="superbot-toggle">ON</button>
          <button id="superbot-mode">BAL</button>
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
          <div class="superbot-section-title">Decisions</div>
          <div id="superbot-decisions" class="superbot-log"></div>
        </div>
        <div class="superbot-section">
          <div class="superbot-section-title">Activity</div>
          <div id="superbot-activity" class="superbot-log"></div>
        </div>
      </div>
    `;
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
    const collapseButton = panel.querySelector("#superbot-collapse");

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

    collapseButton.addEventListener("click", () => {
      panel.classList.toggle("collapsed");
    });

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

  function refreshOverlay() {
    ensureOverlay();
    if (!runtime.overlay.root) return;

    const hooksRoot = runtime.overlay.root.querySelector("#superbot-hooks");
    const stateRoot = runtime.overlay.root.querySelector("#superbot-state");
    const statsRoot = runtime.overlay.root.querySelector("#superbot-stats");
    const decisionsRoot = runtime.overlay.root.querySelector(
      "#superbot-decisions",
    );
    const activityRoot =
      runtime.overlay.root.querySelector("#superbot-activity");
    const toggleButton = runtime.overlay.root.querySelector("#superbot-toggle");
    const modeButton = runtime.overlay.root.querySelector("#superbot-mode");

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

    if (decisionsRoot) {
      decisionsRoot.innerHTML = runtime.decisions
        .slice(-14)
        .map((entry) => '<div class="superbot-log-line">' + entry + "</div>")
        .join("");
      decisionsRoot.scrollTop = decisionsRoot.scrollHeight;
    }

    if (activityRoot) {
      activityRoot.innerHTML = runtime.logs
        .slice(-18)
        .map((entry) => '<div class="superbot-log-line">' + entry + "</div>")
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
