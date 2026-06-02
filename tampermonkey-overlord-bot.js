// ==UserScript==
// @name         OpenFront.io Overlord Bot
// @namespace    http://tampermonkey.net/
// @version      3.0.0
// @description  Calculated, lookahead-driven OpenFront bot. Uses the game's exact source math for optimal attack ratios, build ROI and betrayal timing; a forward simulator for chess-engine-style planning; preemptive defense and anti-overgrowth diplomacy. Optimized for public FFA.
// @author       Cursor (Overlord)
// @match        https://openfront.io/*
// @match        http://localhost:*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * ============================================================================
 * Overlord — design notes (see /opt/cursor/artifacts/PLAN.md for full plan)
 * ============================================================================
 *
 * The decisive edge of this bot is that we have the game's source code, so we
 * mirror its exact balance math (src/core/configuration/DefaultConfig.ts) and
 * compute mathematically optimal moves instead of using hand-tuned fudge
 * factors. Everything in the MATH module below is a faithful, unit-tested port
 * of the engine. A parity test (tests/OverlordBotMath.test.ts) asserts these
 * functions return values numerically identical to the real DefaultConfig.
 *
 * Module map (all inside one IIFE, no external deps):
 *   A. Net/IO            — WebSocket hook, server-msg router, intent senders, GameView discovery
 *   B. MATH              — exact engine-math port (this phase)
 *   C. WORLD             — per-tick world snapshot (shares, velocities, alliance graph)
 *   D. SIM               — forward simulator (projects troops/gold/tiles)
 *   E. Threats           — preemption (brewing invaders, inbound boats/nukes, coalitions)
 *   F. Tactics           — sizing + execution primitives
 *   G. Diplomacy         — alliances, betrayal, coalition break, anti-overgrowth
 *   H. Planner           — goal specs + selection + run loop
 *   I. Stealth           — configurable human-like intent pacing
 *   J. Observability     — UI overlay + light decision log
 *   K. Bootstrap         — init + hotkeys + runtime exposure for tests
 *
 * Troop values are internal = 10x the displayed value (renderTroops divides by
 * 10). Gold/tiles are raw. We never mix units.
 */

(function () {
  "use strict";

  const BOT_VERSION = "3.0.0";

  // Test-mode detection: when loaded by vitest/jsdom we must not start the
  // game loop or hook globals destructively. The test harness sets this flag.
  const TEST_MODE =
    typeof window !== "undefined" &&
    (window.__OVERLORD_TEST_MODE === true ||
      window.__SUPERBOT_TEST_MODE === true);

  // ═══════════════════════════════════════════════════════════════════════
  //  ENUMS / CONSTANTS (mirrored from src/core/game/Game.ts)
  // ═══════════════════════════════════════════════════════════════════════

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

  const Difficulty = Object.freeze({
    Easy: "Easy",
    Medium: "Medium",
    Hard: "Hard",
    Impossible: "Impossible",
  });

  const TerrainType = Object.freeze({
    Plains: "Plains",
    Highland: "Highland",
    Mountain: "Mountain",
  });

  const STRUCTURE_TYPES = Object.freeze([
    UnitType.City,
    UnitType.Factory,
    UnitType.Port,
    UnitType.DefensePost,
    UnitType.MissileSilo,
    UnitType.SAMLauncher,
  ]);
  const STRUCTURE_SET = new Set(STRUCTURE_TYPES);

  const NUKE_TYPES = Object.freeze([
    UnitType.AtomBomb,
    UnitType.HydrogenBomb,
    UnitType.MIRV,
    UnitType.MIRVWarhead,
  ]);
  const NUKE_SET = new Set(NUKE_TYPES);

  // Internal troop -> displayed troop divisor (renderTroops in client/Utils.ts).
  const TROOP_DISPLAY_DIVISOR = 10;

  // ═══════════════════════════════════════════════════════════════════════
  //  B. MATH — exact port of src/core/configuration/DefaultConfig.ts
  //
  //  These are pure functions of scalar inputs (no Game/Player objects) so
  //  they can be unit-tested against the real engine. Constants and formulas
  //  are copied verbatim from the source; see citations in comments.
  // ═══════════════════════════════════════════════════════════════════════

  // --- shared helpers (src/core/Util.ts) ---
  function within(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
  function sigmoid(value, decayRate, midpoint) {
    return 1 / (1 + Math.exp(-decayRate * (value - midpoint)));
  }

  const MATH = (function () {
    // DefaultConfig constants (top of file).
    const DEFENSE_DEBUFF_MIDPOINT = 150_000;
    const DEFENSE_DEBUFF_DECAY_RATE = Math.LN2 / 50000;

    const TRAITOR_DEFENSE_DEBUFF = 0.5; // traitorDefenseDebuff()
    const TRAITOR_SPEED_DEBUFF = 0.8; // traitorSpeedDebuff()
    const DEFENSE_POST_DEFENSE_BONUS = 5; // defensePostDefenseBonus()
    const DEFENSE_POST_SPEED_BONUS = 3; // defensePostSpeedBonus()
    const DEFENSE_POST_RANGE = 30; // defensePostRange()
    const CITY_TROOP_INCREASE = 250_000; // cityTroopIncrease()
    const MAX_SAM_RANGE = 150; // maxSamRange()

    // Nation difficulty multipliers for maxTroops / troopIncreaseRate.
    const NATION_MAXTROOP_MULT = {
      [Difficulty.Easy]: 0.5,
      [Difficulty.Medium]: 0.75,
      [Difficulty.Hard]: 1,
      [Difficulty.Impossible]: 1.25,
    };
    const NATION_TROOPINC_MULT = {
      [Difficulty.Easy]: 0.9,
      [Difficulty.Medium]: 0.95,
      [Difficulty.Hard]: 1,
      [Difficulty.Impossible]: 1.05,
    };

    function terrainMagSpeed(terrainType) {
      switch (terrainType) {
        case TerrainType.Plains:
          return { mag: 80, speed: 16.5 };
        case TerrainType.Highland:
          return { mag: 100, speed: 20 };
        case TerrainType.Mountain:
          return { mag: 120, speed: 25 };
        default:
          throw new Error("terrain type " + terrainType + " not supported");
      }
    }

    function falloutDefenseModifier(falloutRatio) {
      // 5 - falloutRatio*2, falloutRatio in [0,1] -> [3,5] (source comment says [5,2.5])
      return 5 - falloutRatio * 2;
    }

    /**
     * Exact port of DefaultConfig.attackLogic(). Inputs are scalars/flags
     * equivalent to what the engine derives from Game/Player objects.
     *
     * @returns {attackerTroopLoss, defenderTroopLoss, tilesPerTickUsed}
     */
    function attackLogic(p) {
      const {
        terrainType,
        attackTroops,
        attackerType, // PlayerType.*
        defenderIsPlayer, // bool (false => TerraNullius)
        defenderTroops = 0,
        defenderTiles = 1,
        defenderType = null, // PlayerType.* when defenderIsPlayer
        defenderHasDefensePost = false,
        defenderDisconnected = false,
        attackerDefenderSameTeam = false,
        defenderIsTraitor = false,
        attackerTiles = 0,
        hasFallout = false,
        falloutRatio = 0,
      } = p;

      let { mag, speed } = terrainMagSpeed(terrainType);

      if (defenderIsPlayer && defenderHasDefensePost) {
        mag *= DEFENSE_POST_DEFENSE_BONUS;
        speed *= DEFENSE_POST_SPEED_BONUS;
      }

      if (hasFallout) {
        const fm = falloutDefenseModifier(falloutRatio);
        mag *= fm;
        speed *= fm;
      }

      const attackerIsPlayer =
        attackerType === PlayerType.Human ||
        attackerType === PlayerType.Bot ||
        attackerType === PlayerType.Nation;

      if (attackerIsPlayer && defenderIsPlayer) {
        if (defenderDisconnected && attackerDefenderSameTeam) {
          mag = 0;
        }
        if (
          attackerType === PlayerType.Human &&
          defenderType === PlayerType.Bot
        ) {
          mag *= 0.8;
        }
        if (
          attackerType === PlayerType.Nation &&
          defenderType === PlayerType.Bot
        ) {
          mag *= 0.8;
        }
      }

      if (defenderIsPlayer) {
        const defenseSig =
          1 -
          sigmoid(
            defenderTiles,
            DEFENSE_DEBUFF_DECAY_RATE,
            DEFENSE_DEBUFF_MIDPOINT,
          );
        const largeDefenderSpeedDebuff = 0.7 + 0.3 * defenseSig;
        const largeDefenderAttackDebuff = 0.7 + 0.3 * defenseSig;

        let largeAttackBonus = 1;
        if (attackerTiles > 100_000) {
          largeAttackBonus = Math.sqrt(100_000 / attackerTiles) ** 0.7;
        }
        let largeAttackerSpeedBonus = 1;
        if (attackerTiles > 100_000) {
          largeAttackerSpeedBonus = (100_000 / attackerTiles) ** 0.6;
        }

        const defenderTroopLoss = defenderTroops / defenderTiles;
        const traitorMod = defenderIsTraitor ? TRAITOR_DEFENSE_DEBUFF : 1;
        const currentAttackerLoss =
          within(defenderTroops / attackTroops, 0.6, 2) *
          mag *
          0.8 *
          largeDefenderAttackDebuff *
          largeAttackBonus *
          traitorMod;
        const altAttackerLoss =
          1.3 * defenderTroopLoss * (mag / 100) * traitorMod;
        const attackerTroopLoss =
          0.7 * currentAttackerLoss + 0.3 * altAttackerLoss;

        return {
          attackerTroopLoss,
          defenderTroopLoss,
          tilesPerTickUsed:
            within(defenderTroops / (5 * attackTroops), 0.2, 1.5) *
            speed *
            largeDefenderSpeedDebuff *
            largeAttackerSpeedBonus *
            (defenderIsTraitor ? TRAITOR_SPEED_DEBUFF : 1),
        };
      } else {
        return {
          attackerTroopLoss:
            attackerType === PlayerType.Bot ? mag / 10 : mag / 5,
          defenderTroopLoss: 0,
          tilesPerTickUsed: within(
            (2000 * Math.max(10, speed)) / attackTroops,
            5,
            100,
          ),
        };
      }
    }

    /** Exact port of DefaultConfig.attackTilesPerTick(). */
    function attackTilesPerTick(
      attackTroops,
      defenderIsPlayer,
      defenderTroops,
      numAdjacentTilesWithEnemy,
    ) {
      if (defenderIsPlayer) {
        return (
          within(((5 * attackTroops) / defenderTroops) * 2, 0.01, 0.5) *
          numAdjacentTilesWithEnemy *
          3
        );
      }
      return numAdjacentTilesWithEnemy * 2;
    }

    /** Exact port of DefaultConfig.maxTroops(). */
    function maxTroops(p) {
      const {
        tiles,
        cityLevelsSum = 0,
        type,
        difficulty = Difficulty.Medium,
        infiniteTroops = false,
      } = p;
      if (type === PlayerType.Human && infiniteTroops) {
        return 1_000_000_000;
      }
      const base =
        2 * (Math.pow(tiles, 0.6) * 1000 + 50000) +
        cityLevelsSum * CITY_TROOP_INCREASE;
      if (type === PlayerType.Bot) return base / 3;
      if (type === PlayerType.Human) return base;
      // Nation
      return base * NATION_MAXTROOP_MULT[difficulty];
    }

    /** Exact port of DefaultConfig.troopIncreaseRate(). Returns the delta added this tick. */
    function troopIncrease(p) {
      const { troops, max, type, difficulty = Difficulty.Medium } = p;
      let toAdd = 10 + Math.pow(troops, 0.73) / 4;
      const ratio = 1 - troops / max;
      toAdd *= ratio;
      if (type === PlayerType.Bot) toAdd *= 0.6;
      else if (type === PlayerType.Nation) toAdd *= NATION_TROOPINC_MULT[difficulty];
      return Math.min(troops + toAdd, max) - troops;
    }

    /** goldAdditionRate (passive per-tick gold, before trade/train). */
    function goldAdditionRate(type, goldMultiplier = 1) {
      const baseRate = type === PlayerType.Bot ? 50 : 100;
      return Math.floor(baseRate * goldMultiplier);
    }

    // --- structure / unit costs (DefaultConfig.unitInfo cost fns) ---
    // City / Factory / Port: 2^n * 125000 capped 1,000,000.
    // For City n = number of cities; for Factory/Port n = combined Port+Factory count.
    function exponentialBuildCost(n) {
      return Math.min(1_000_000, Math.pow(2, n) * 125_000);
    }
    const cityCost = (numCities) => exponentialBuildCost(numCities);
    const portCost = (numPortsPlusFactories) =>
      exponentialBuildCost(numPortsPlusFactories);
    const factoryCost = (numPortsPlusFactories) =>
      exponentialBuildCost(numPortsPlusFactories);
    const defensePostCost = (numDP) => Math.min(250_000, (numDP + 1) * 50_000);
    const samCost = (numSAM) => Math.min(3_000_000, (numSAM + 1) * 1_500_000);
    const warshipCost = (numWarships) =>
      Math.min(1_000_000, (numWarships + 1) * 250_000);
    const missileSiloCost = () => 1_000_000;
    const atomBombCost = () => 750_000;
    const hydrogenBombCost = () => 5_000_000;
    const mirvCost = (numMirvsLaunched) =>
      25_000_000 + numMirvsLaunched * 15_000_000;

    /** Generic cost lookup by unit type (returns Number). */
    function unitCost(type, counts) {
      counts = counts || {};
      const pf = (counts.ports || 0) + (counts.factories || 0);
      switch (type) {
        case UnitType.City:
          return cityCost(counts.cities || 0);
        case UnitType.Port:
          return portCost(pf);
        case UnitType.Factory:
          return factoryCost(pf);
        case UnitType.DefensePost:
          return defensePostCost(counts.defensePosts || 0);
        case UnitType.SAMLauncher:
          return samCost(counts.sams || 0);
        case UnitType.Warship:
          return warshipCost(counts.warships || 0);
        case UnitType.MissileSilo:
          return missileSiloCost();
        case UnitType.AtomBomb:
          return atomBombCost();
        case UnitType.HydrogenBomb:
          return hydrogenBombCost();
        case UnitType.MIRV:
          return mirvCost(counts.mirvsLaunched || 0);
        default:
          return Infinity;
      }
    }

    // --- SAM / nuke (DefaultConfig) ---
    function samRange(level) {
      return MAX_SAM_RANGE - 480 / (level + 5);
    }
    function nukeMagnitude(type) {
      switch (type) {
        case UnitType.MIRVWarhead:
          return { inner: 12, outer: 18 };
        case UnitType.AtomBomb:
          return { inner: 12, outer: 30 };
        case UnitType.HydrogenBomb:
          return { inner: 80, outer: 100 };
        default:
          throw new Error("Unknown nuke type: " + type);
      }
    }

    // --- economy income (DefaultConfig) ---
    function tradeShipGold(dist, goldMultiplier = 1) {
      const debuff = 300; // tradeShipShortRangeDebuff()
      const baseGold =
        75_000 / (1 + Math.exp(-0.03 * (dist - debuff))) + 50 * dist;
      return Math.floor(baseGold * goldMultiplier);
    }
    function trainGold(rel, citiesVisited, goldMultiplier = 1) {
      citiesVisited = Math.max(0, citiesVisited - 9);
      let baseGold;
      switch (rel) {
        case "ally":
          baseGold = 35_000;
          break;
        case "self":
          baseGold = 10_000;
          break;
        default: // team / other
          baseGold = 25_000;
          break;
      }
      const distPenalty = citiesVisited * 5_000;
      const gold = Math.max(5000, baseGold - distPenalty);
      return Math.floor(gold * goldMultiplier);
    }

    function percentageTilesOwnedToWin(isTeam) {
      return isTeam ? 95 : 80;
    }

    // ───────────────────────────────────────────────────────────────────
    //  DERIVED OPTIMIZERS (not in source — this is our calculated edge)
    // ───────────────────────────────────────────────────────────────────

    // Attack saturation points derived from attackLogic():
    //   - within(defT/atkT, 0.6, 2): min (0.6) reached at atkT >= defT/0.6 = 1.6667*defT
    //   - within(defT/(5*atkT), 0.2, 1.5): min (0.2) reached at atkT >= defT  (1.0*defT)
    //   - below atkT = defT/2 the loss multiplier saturates at 2.0 (wasteful)
    const ATK_RATIO_MIN_LOSS = 1 / 0.6; // 1.6667 -> cheapest blood
    const ATK_RATIO_MAX_SPEED = 1.0; // fastest conquest
    const ATK_RATIO_MIN_VIABLE = 0.5; // below this loss mult caps at 2.0

    /**
     * Choose the mathematically best attack size against a player given how
     * many troops we can spare. Returns the size at the best affordable
     * saturation point, or 0 if not worth it.
     *
     * @param available troops we may commit (already net of reserve)
     * @param defenderTroops target's troops
     * @param opts.retaliating if true, accept sub-viable ratios to defend
     * @param opts.minAbsolute floor to bother sending (default 5000 internal)
     */
    function optimalAttackTroops(available, defenderTroops, opts) {
      opts = opts || {};
      const minAbsolute = opts.minAbsolute == null ? 5000 : opts.minAbsolute;
      if (available <= 0) return 0;
      if (defenderTroops <= 0) {
        // TerraNullius: flat loss, commit everything above reserve.
        return Math.floor(available);
      }
      if (available < minAbsolute) return 0;

      const ideal = Math.ceil(defenderTroops * ATK_RATIO_MIN_LOSS);
      const strong = Math.ceil(defenderTroops * ATK_RATIO_MAX_SPEED);
      const minViable = Math.ceil(defenderTroops * ATK_RATIO_MIN_VIABLE);

      if (available >= ideal) {
        // Keep a small follow-up buffer but never drop below the ideal point.
        return Math.max(ideal, Math.floor(available * 0.85));
      }
      if (available >= strong) return Math.floor(available);
      if (available >= minViable) return opts.retaliating ? Math.floor(available) : 0;
      return opts.retaliating && available >= minAbsolute ? Math.floor(available) : 0;
    }

    /**
     * Estimate ticks of growth needed for a player's troops to climb from
     * `troops` to `target` (integrating troopIncrease). Capped iterations.
     */
    function ticksToReachTroops(troops, target, params) {
      if (target <= troops) return 0;
      let t = troops;
      let ticks = 0;
      const cap = params.max;
      const safeTarget = Math.min(target, cap);
      while (t < safeTarget && ticks < 100000) {
        const inc = troopIncrease({
          troops: t,
          max: cap,
          type: params.type,
          difficulty: params.difficulty,
        });
        if (inc <= 1e-6) break; // asymptote
        t += inc;
        ticks++;
      }
      return t >= safeTarget ? ticks : Infinity;
    }

    /** Ticks to afford a cost given current gold and per-tick income. */
    function ticksToAfford(gold, income, cost) {
      if (gold >= cost) return 0;
      if (income <= 0) return Infinity;
      return Math.ceil((cost - gold) / income);
    }

    return {
      // constants exposed for tests/tuning
      DEFENSE_DEBUFF_MIDPOINT,
      DEFENSE_DEBUFF_DECAY_RATE,
      MAX_SAM_RANGE,
      ATK_RATIO_MIN_LOSS,
      ATK_RATIO_MAX_SPEED,
      ATK_RATIO_MIN_VIABLE,
      // engine ports
      terrainMagSpeed,
      falloutDefenseModifier,
      attackLogic,
      attackTilesPerTick,
      maxTroops,
      troopIncrease,
      goldAdditionRate,
      exponentialBuildCost,
      cityCost,
      portCost,
      factoryCost,
      defensePostCost,
      samCost,
      warshipCost,
      missileSiloCost,
      atomBombCost,
      hydrogenBombCost,
      mirvCost,
      unitCost,
      samRange,
      nukeMagnitude,
      tradeShipGold,
      trainGold,
      percentageTilesOwnedToWin,
      // derived optimizers
      optimalAttackTroops,
      ticksToReachTroops,
      ticksToAfford,
    };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  CONFIG (tunable levers — retuned in Phase 8)
  // ═══════════════════════════════════════════════════════════════════════

  const CONFIG = {
    // World-model sampling.
    historyMaxSamples: 64, // per-player ring buffer length
    velocityWindowTicks: 300, // window for tiles/min & troops/min
    ticksPerMinute: 600, // 10 ticks/sec * 60

    // Stealth (Phase 7) — placeholders; populated later.
    stealth: {
      enabled: true,
      minIntentGapMs: 90,
      maxMajorPer2s: 6,
    },
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  RUNTIME (grows across phases). Exposed on window for tests/devtools.
  // ═══════════════════════════════════════════════════════════════════════

  const runtime = {
    version: BOT_VERSION,
    enabled: true,
    testMode: TEST_MODE,
    math: MATH,
    config: CONFIG,
    enums: { UnitType, PlayerType, Difficulty, TerrainType },

    world: null,
    planner: { activeGoalId: null },
    hooks: {
      socket: null,
      gameView: null,
      myClientID: null,
      gameStarted: false,
      tick: 0,
    },
    state: {
      history: new Map(), // smallID -> [{tick, tiles, troops, gold}]
      cooldowns: {},
      intentsSent: 0,
      intentsConfirmed: 0,
      lastIntentSignature: null,
      log: [],
      decisionLog: [],
      processing: false,
    },
    stats: {
      gameConfigCache: null,
    },
    test: {
      math: MATH,
      runSuite: null, // wired in Phase 6
      // exposed so tests can drive modules without a live socket:
      buildWorld: null,
      findGameView: null,
    },
  };

  if (typeof window !== "undefined") {
    window.__overlordBotRuntime = runtime;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  SHARED HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  function safeCall(fn, fallback) {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  function fmt(n) {
    if (n == null) return "0";
    n = Number(n);
    const sign = n < 0 ? "-" : "";
    n = Math.abs(n);
    if (n >= 1e9) return sign + (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return sign + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return sign + (n / 1e3).toFixed(1) + "K";
    return sign + String(Math.round(n));
  }

  function fmtTroops(n) {
    return fmt(Number(n || 0) / TROOP_DISPLAY_DIVISOR);
  }

  function botLog(msg) {
    const entry = "[Overlord] " + msg;
    runtime.state.log.push(entry);
    if (runtime.state.log.length > 300) runtime.state.log.shift();
    if (!TEST_MODE && typeof console !== "undefined") console.log(entry);
  }

  function decisionLog(msg) {
    const entry = "T" + runtime.hooks.tick + " " + msg;
    runtime.state.decisionLog.push(entry);
    if (runtime.state.decisionLog.length > 200)
      runtime.state.decisionLog.shift();
  }

  function isStructureType(t) {
    return STRUCTURE_SET.has(t);
  }
  function isNukeType(t) {
    return NUKE_SET.has(t);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  A. NET / IO — WebSocket hook, message router, GameView discovery,
  //     intent senders. (Intent gate/stealth attaches in Phase 7.)
  // ═══════════════════════════════════════════════════════════════════════

  const NativeWebSocket =
    typeof window !== "undefined" ? window.WebSocket : null;

  function installWebSocketHook() {
    if (typeof window === "undefined" || !window.WebSocket) return;
    const Native = window.WebSocket;
    function Wrapped(url, protocols) {
      const ws = protocols ? new Native(url, protocols) : new Native(url);
      const urlStr = typeof url === "string" ? url : String(url);
      const isGameSocket =
        !urlStr.includes("/lobbies") && !urlStr.includes("/matchmaking");
      if (isGameSocket) {
        botLog("Game socket intercepted: " + urlStr);
        runtime.hooks.socket = ws;
        ws.addEventListener("message", (event) => {
          let data;
          try {
            data = JSON.parse(event.data);
          } catch (_) {
            return; // binary / non-JSON
          }
          handleServerMessage(data);
        });
        ws.addEventListener("close", () => {
          if (runtime.hooks.socket === ws) {
            runtime.hooks.socket = null;
            runtime.hooks.gameStarted = false;
            botLog("Game socket closed");
          }
        });
      }
      return ws;
    }
    Wrapped.prototype = Native.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      try {
        Object.defineProperty(Wrapped, k, { value: Native[k] });
      } catch (_) {}
    }
    window.WebSocket = Wrapped;
  }

  function handleServerMessage(data) {
    if (!data || typeof data !== "object") return;
    if (data.type === "lobby_info") {
      runtime.hooks.myClientID = data.myClientID || runtime.hooks.myClientID;
    } else if (data.type === "start") {
      runtime.hooks.gameStarted = true;
      runtime.hooks.tick = 0;
      runtime.hooks.myClientID = data.myClientID || runtime.hooks.myClientID;
      runtime.state.history = new Map();
      botLog("Game started. clientID=" + runtime.hooks.myClientID);
    } else if (data.type === "turn") {
      const turn = data.turn || {};
      if (typeof turn.turnNumber === "number")
        runtime.hooks.tick = turn.turnNumber;
      if (Array.isArray(turn.intents)) {
        for (const intent of turn.intents) {
          if (intent && intent.clientID === runtime.hooks.myClientID) {
            runtime.state.intentsConfirmed++;
          }
        }
      }
      // Phase 6 wires the planner here. Until then this is a no-op tick.
      if (typeof runtime._onTurn === "function") {
        safeCall(() => runtime._onTurn(), null);
      }
    }
  }

  // --- GameView discovery (multi-strategy, validated). ---
  function isGameViewLike(v) {
    return (
      v &&
      typeof v === "object" &&
      typeof v.ticks === "function" &&
      typeof v.myPlayer === "function" &&
      (typeof v.playerViews === "function" || typeof v.players === "function")
    );
  }

  function findGameView() {
    const cached = runtime.hooks.gameView;
    if (cached) {
      if (safeCall(() => (cached.ticks(), true), false)) return cached;
      runtime.hooks.gameView = null;
    }
    if (typeof document === "undefined") return null;

    // 1) canvas-attached references
    try {
      for (const c of document.querySelectorAll("canvas")) {
        for (const key of Object.keys(c)) {
          const val = c[key];
          if (isGameViewLike(val)) {
            runtime.hooks.gameView = val;
            botLog("GameView found via canvas property");
            return val;
          }
          if (val && typeof val === "object" && isGameViewLike(val.gameView)) {
            runtime.hooks.gameView = val.gameView;
            return val.gameView;
          }
        }
      }
    } catch (_) {}

    // 2) window globals
    try {
      for (const key of ["__gameView", "gameView", "__gv", "game"]) {
        if (isGameViewLike(window[key])) {
          runtime.hooks.gameView = window[key];
          botLog("GameView found on window." + key);
          return window[key];
        }
      }
    } catch (_) {}

    // 3) walk DOM elements + shadow roots
    try {
      for (const el of document.querySelectorAll("*")) {
        const sources = el.shadowRoot ? [el, el.shadowRoot] : [el];
        for (const src of sources) {
          for (const k of Object.getOwnPropertyNames(src)) {
            const v = safeCall(() => src[k], null);
            if (isGameViewLike(v)) {
              runtime.hooks.gameView = v;
              botLog("GameView found via DOM element");
              return v;
            }
            if (v && typeof v === "object" && isGameViewLike(v.gameView)) {
              runtime.hooks.gameView = v.gameView;
              return v.gameView;
            }
          }
        }
      }
    } catch (_) {}

    return null;
  }

  function getGameView() {
    return findGameView();
  }

  // --- intent senders (Phase 7 adds the stealth gate in front of sendIntent) ---
  function rawSend(obj) {
    const sock = runtime.hooks.socket;
    if (!sock) return false;
    if (NativeWebSocket && sock.readyState !== NativeWebSocket.OPEN) {
      // In harness, FakeWebSocket.OPEN === 1 and readyState === 1.
      if (sock.readyState !== 1) return false;
    }
    safeCall(() => sock.send(JSON.stringify(obj)), null);
    return true;
  }

  function sendIntent(intent) {
    if (!runtime.enabled) return false;
    const signature = intent.type + ":" + JSON.stringify(intent);
    if (runtime.state.lastIntentSignature === signature) return false;
    // Phase 7: stealth gate hook.
    if (typeof runtime._stealthBlocks === "function") {
      if (runtime._stealthBlocks(intent)) return false;
    }
    const ok = rawSend({ type: "intent", intent });
    if (ok) {
      runtime.state.intentsSent++;
      runtime.state.lastIntentSignature = signature;
      if (typeof runtime._recordIntent === "function")
        safeCall(() => runtime._recordIntent(intent), null);
      decisionLog("SENT " + intent.type);
    }
    return ok;
  }

  const IO = {
    sendSpawn: (tile) => sendIntent({ type: "spawn", tile }),
    sendAttack: (targetID, troops) =>
      sendIntent({
        type: "attack",
        targetID: targetID,
        troops: Math.max(1, Math.floor(troops)),
      }),
    sendBoat: (dst, troops) =>
      sendIntent({
        type: "boat",
        troops: Math.max(1, Math.floor(troops)),
        dst,
      }),
    sendBuild: (unit, tile, rocketDirectionUp) => {
      const intent = { type: "build_unit", unit, tile };
      if (rocketDirectionUp !== undefined)
        intent.rocketDirectionUp = rocketDirectionUp;
      return sendIntent(intent);
    },
    sendUpgrade: (unitId, unit) =>
      sendIntent({ type: "upgrade_structure", unit, unitId }),
    sendAllianceRequest: (recipient) =>
      sendIntent({ type: "allianceRequest", recipient }),
    sendAllianceReject: (requestor) =>
      sendIntent({ type: "allianceReject", requestor }),
    sendBreakAlliance: (recipient) =>
      sendIntent({ type: "breakAlliance", recipient }),
    sendAllianceExtension: (recipient) =>
      sendIntent({ type: "allianceExtension", recipient }),
    sendTargetPlayer: (target) => sendIntent({ type: "targetPlayer", target }),
    sendEmbargo: (targetID, action) =>
      sendIntent({ type: "embargo", targetID, action }),
    sendEmbargoAll: (action) => sendIntent({ type: "embargo_all", action }),
    sendDonateGold: (recipient, gold) =>
      sendIntent({ type: "donate_gold", recipient, gold: Math.floor(gold) }),
    sendDonateTroops: (recipient, troops) =>
      sendIntent({
        type: "donate_troops",
        recipient,
        troops: Math.floor(troops),
      }),
    sendCancelAttack: (attackID) =>
      sendIntent({ type: "cancel_attack", attackID }),
    sendCancelBoat: (unitID) => sendIntent({ type: "cancel_boat", unitID }),
    sendMoveWarship: (unitId, tile) =>
      sendIntent({ type: "move_warship", unitId, tile }),
    sendDeleteUnit: (unitId) => sendIntent({ type: "delete_unit", unitId }),
  };
  runtime.io = IO;

  // ═══════════════════════════════════════════════════════════════════════
  //  C. WORLD — per-tick snapshot of the board (shares, velocities,
  //     alliance graph, rankings). Threats (E) augment this in Phase 5.
  // ═══════════════════════════════════════════════════════════════════════

  function getGameConfigInfo(gameView) {
    // Difficulty / team-mode / goldMultiplier from the live config when present.
    const cfg = safeCall(() => gameView.config(), null);
    const gc = cfg ? safeCall(() => cfg.gameConfig(), null) : null;
    return {
      difficulty: (gc && gc.difficulty) || Difficulty.Medium,
      isTeam:
        gc && gc.gameMode
          ? gc.gameMode === "Team" || gc.gameMode === "team"
          : false,
      goldMultiplier: (gc && gc.goldMultiplier) || 1,
    };
  }

  function cityLevelsSum(player) {
    const cities = safeCall(() => player.units(UnitType.City), []) || [];
    let sum = 0;
    for (const c of cities) {
      if (safeCall(() => c.isUnderConstruction(), false)) continue;
      sum += safeCall(() => c.level(), 1);
    }
    return sum;
  }

  function countStructures(player) {
    const counts = {};
    const levels = {};
    for (const t of STRUCTURE_TYPES) {
      const units = safeCall(() => player.units(t), []) || [];
      let n = 0;
      let lvl = 0;
      for (const u of units) {
        if (safeCall(() => u.isUnderConstruction(), false)) continue;
        n++;
        lvl += safeCall(() => u.level(), 1);
      }
      counts[t] = n;
      levels[t] = lvl;
    }
    return { counts, levels };
  }

  function sumAttackTroops(attacks) {
    let s = 0;
    if (!attacks) return 0;
    for (const a of attacks) s += a.troops || 0;
    return s;
  }

  function recordHistory(smallID, tick, tiles, troops, gold) {
    let arr = runtime.state.history.get(smallID);
    if (!arr) {
      arr = [];
      runtime.state.history.set(smallID, arr);
    }
    arr.push({ tick, tiles, troops, gold });
    if (arr.length > CONFIG.historyMaxSamples) arr.shift();
  }

  function velocity(smallID, tick, field) {
    const arr = runtime.state.history.get(smallID);
    if (!arr || arr.length < 2) return 0;
    // Find oldest sample within the velocity window.
    let oldest = arr[0];
    for (const s of arr) {
      if (tick - s.tick <= CONFIG.velocityWindowTicks) {
        oldest = s;
        break;
      }
    }
    const last = arr[arr.length - 1];
    const dt = last.tick - oldest.tick;
    if (dt <= 0) return 0;
    return ((last[field] - oldest[field]) / dt) * CONFIG.ticksPerMinute;
  }

  /**
   * Build the world snapshot from a (live or mock) GameView. Pure w.r.t. the
   * gameView; mutates runtime.state.history for velocity tracking.
   */
  function buildWorld(gameView) {
    if (!gameView) return null;
    const tick = safeCall(() => gameView.ticks(), runtime.hooks.tick) || 0;
    const gcInfo = getGameConfigInfo(gameView);
    const myPlayer = safeCall(() => gameView.myPlayer(), null);

    const playersRaw =
      safeCall(() => gameView.playerViews(), null) ||
      safeCall(() => gameView.players(), []) ||
      [];
    const players = playersRaw.filter((p) => safeCall(() => p.isAlive(), false));

    const totalLand = Math.max(1, safeCall(() => gameView.numLandTiles(), 1));

    let humanCount = 0;
    let nationCount = 0;
    let botCount = 0;

    const everyone = [];
    const bySmallID = new Map();

    for (const p of players) {
      const smallID = safeCall(() => p.smallID(), -1);
      const type = safeCall(() => p.type(), PlayerType.Human);
      if (type === PlayerType.Human) humanCount++;
      else if (type === PlayerType.Nation) nationCount++;
      else if (type === PlayerType.Bot) botCount++;

      const tiles = safeCall(() => p.numTilesOwned(), 0);
      const troops = safeCall(() => p.troops(), 0);
      const gold = Number(safeCall(() => p.gold(), 0) || 0);
      const isMe = myPlayer
        ? safeCall(() => p.smallID() === myPlayer.smallID(), false)
        : false;
      const isAlly =
        myPlayer && !isMe
          ? safeCall(() => myPlayer.isFriendly(p), false)
          : false;

      recordHistory(smallID, tick, tiles, troops, gold);

      const entry = {
        player: p,
        smallID,
        id: safeCall(() => p.id(), null),
        name: safeCall(() => p.name(), "?"),
        type,
        team: safeCall(() => p.team(), null),
        isMe,
        isAlly,
        isEnemy: !isMe && !isAlly,
        tiles,
        troops,
        gold,
        share: tiles / totalLand,
        tilesPerMin: velocity(smallID, tick, "tiles"),
        troopsPerMin: velocity(smallID, tick, "troops"),
        isTraitor: safeCall(() => p.isTraitor(), false),
        isDisconnected: safeCall(() => p.isDisconnected(), false),
        incomingAttacks: safeCall(() => p.incomingAttacks(), []) || [],
        outgoingAttacks: safeCall(() => p.outgoingAttacks(), []) || [],
        allianceCount: safeCall(() => (p.alliances() || []).length, 0),
      };
      entry.incomingTroops = sumAttackTroops(entry.incomingAttacks);
      entry.outgoingTroops = sumAttackTroops(entry.outgoingAttacks);
      everyone.push(entry);
      bySmallID.set(smallID, entry);
    }

    // me summary (with structures + maxTroops via MATH)
    let me = null;
    if (myPlayer) {
      const mySid = safeCall(() => myPlayer.smallID(), -1);
      const meEntry = bySmallID.get(mySid);
      const { counts, levels } = countStructures(myPlayer);
      const cls = cityLevelsSum(myPlayer);
      const maxTroops =
        safeCall(() => gameView.config().maxTroops(myPlayer), 0) ||
        MATH.maxTroops({
          tiles: meEntry ? meEntry.tiles : 0,
          cityLevelsSum: cls,
          type: PlayerType.Human,
          difficulty: gcInfo.difficulty,
        });
      me = Object.assign({}, meEntry, {
        maxTroops,
        troopRatio: maxTroops > 0 ? meEntry.troops / maxTroops : 0,
        structures: counts,
        structureLevels: levels,
        cityLevelsSum: cls,
      });
      bySmallID.set(mySid, me);
    }

    // totals / shares
    const sortedByTiles = everyone.slice().sort((a, b) => b.tiles - a.tiles);
    const sortedByTroops = everyone.slice().sort((a, b) => b.troops - a.troops);
    const crown = sortedByTiles[0] || null;
    const second = sortedByTiles[1] || null;
    const myShare = me ? me.share : 0;

    const world = {
      tick,
      gameConfig: gcInfo,
      me,
      meSmallID: me ? me.smallID : -1,
      everyone,
      bySmallID,
      totals: {
        alivePlayers: players.length,
        humanCount,
        nationCount,
        botCount,
        totalLand,
        myShare,
        crownShare: crown ? crown.share : 0,
        secondShare: second ? second.share : 0,
      },
      rankings: {
        byTiles: sortedByTiles,
        byTroops: sortedByTroops,
      },
      // Augmented by the threat engine (Phase 5).
      threats: {
        crown,
        crownSmallID: crown ? crown.smallID : null,
        risingStars: [],
        adjacentEnemies: [],
        activeInvaders: [],
        brewingInvaders: [],
        inboundNukes: [],
        inboundBoats: [],
        coalitionAgainstMe: false,
      },
      allianceGraph: { edges: new Map(), coalitionThreat: false },
    };
    return world;
  }

  runtime.test.buildWorld = buildWorld;
  runtime.test.findGameView = findGameView;
  runtime._buildWorld = buildWorld;

  // ═══════════════════════════════════════════════════════════════════════
  //  K. BOOTSTRAP
  // ═══════════════════════════════════════════════════════════════════════

  function init() {
    installWebSocketHook();
    if (!TEST_MODE && typeof console !== "undefined") {
      botLog("v" + BOT_VERSION + " loaded (Phase 2: net/IO + world model).");
    }
    // The per-tick planner loop is wired in Phase 6. We do not start any
    // setInterval until then; turns drive the brain via runtime._onTurn.
  }

  init();
})();
