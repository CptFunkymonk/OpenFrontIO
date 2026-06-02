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
  //  F. TACTICS — calculated sizing + target/build selection.
  //
  //  These are pure decision functions over the WORLD snapshot. They size
  //  attacks/expansions from the exact engine math (MATH.*) and pick targets
  //  using a strategy ladder modeled on the engine's Impossible-difficulty
  //  nation AI (AiAttackBehavior) but grounded in our optimal-ratio math.
  //  Execution (tile finding, async border queries, sending) lives in the
  //  goal run() functions (Phase 6); here we only DECIDE.
  // ═══════════════════════════════════════════════════════════════════════

  const TACTICS = (function () {
    function clamp01(v, min, max) {
      return Math.min(Math.max(v, min), max);
    }

    /**
     * Reserve ratio to keep when EXPANDING into TerraNullius. TN attacks cost
     * a flat loss per tile regardless of troop count (proven in MATH), so
     * expansion can never "waste" troops — we keep only a thin defensive pool.
     * This is the central fix for the v2 under-expansion failure: we expand
     * aggressively while small instead of hoarding behind a high reserve.
     */
    function reserveForExpansion(world) {
      const me = world.me;
      if (!me) return 0.3;
      const ratio = me.troopRatio;
      const share = world.totals.myShare;

      let reserve = 0.15;
      if (share < 0.05) reserve = 0.08;
      else if (share < 0.1) reserve = 0.1;
      else if (share < 0.25) reserve = 0.15;
      else reserve = 0.22;

      const pressure = me.incomingTroops / Math.max(1, me.troops);
      if (pressure > 0.5) reserve = Math.max(reserve, 0.4);
      else if (pressure > 0.25) reserve = Math.max(reserve, 0.3);

      if (ratio < 0.15) reserve = Math.max(reserve, 0.25);

      return clamp01(reserve, 0.05, 0.7);
    }

    /**
     * Reserve ratio when ATTACKING a player. Higher than expansion because PvP
     * troops can be lost to retreat/over-extension; we keep a defensive pool.
     */
    function reserveForCombat(world) {
      const me = world.me;
      if (!me) return 0.35;
      const ratio = me.troopRatio;
      const share = world.totals.myShare;

      let reserve = 0.35;
      if (ratio < 0.2) reserve = 0.5;
      else if (ratio < 0.4) reserve = 0.42;
      else if (ratio > 0.8) reserve = 0.25;

      if (share > 0.4) reserve = Math.min(reserve, 0.25);
      return clamp01(reserve, 0.12, 0.7);
    }

    function availableTroops(world, reserveRatio) {
      const me = world.me;
      if (!me) return 0;
      return Math.floor(me.troops - me.maxTroops * reserveRatio);
    }

    /** Troops to commit to a TerraNullius expansion this tick. */
    function expansionTroops(world) {
      const avail = availableTroops(world, reserveForExpansion(world));
      return avail > 0 ? avail : 0;
    }

    /**
     * Troops to commit to attacking a specific enemy entry, using the exact
     * saturation-point math. Returns 0 when not worth it.
     */
    function attackTroops(world, enemyEntry, opts) {
      opts = opts || {};
      const reserve =
        opts.reserveRatio != null
          ? opts.reserveRatio
          : reserveForCombat(world);
      const avail = availableTroops(world, reserve);
      return MATH.optimalAttackTroops(avail, enemyEntry.troops, {
        retaliating: !!opts.retaliating,
        minAbsolute: opts.minAbsolute,
      });
    }

    function estimateMaxTroops(world, entry) {
      // We can't see enemy city levels; approximate from tiles + their type.
      return MATH.maxTroops({
        tiles: entry.tiles,
        cityLevelsSum: 0,
        type: entry.type,
        difficulty: world.gameConfig.difficulty,
      });
    }

    /**
     * Select the best attack target from a candidate list (adjacent enemies +
     * bordering bots). Strategy ladder mirrors the engine's Impossible nation
     * AI ordering, refined with our math:
     *   retaliate > weak bots > very weak > traitor > AFK > victim > weakest.
     * Returns { entry, reason, retaliating } or null.
     */
    function selectAttackTarget(world, candidates) {
      const me = world.me;
      if (!me || !candidates || candidates.length === 0) return null;
      const myTroops = me.troops;

      const sorted = candidates.slice().sort((a, b) => a.troops - b.troops);

      // 1) Retaliate: biggest non-bot incoming attacker that is adjacent.
      let biggestAttacker = null;
      let biggestTroops = 0;
      for (const a of me.incomingAttacks || []) {
        if (a.troops <= biggestTroops) continue;
        const atkEntry = world.bySmallID.get(a.attackerID);
        if (!atkEntry) continue;
        if (atkEntry.type === PlayerType.Bot) continue;
        if (!candidates.some((c) => c.smallID === atkEntry.smallID)) continue;
        biggestTroops = a.troops;
        biggestAttacker = atkEntry;
      }
      if (biggestAttacker) {
        return {
          entry: biggestAttacker,
          reason: "retaliate",
          retaliating: true,
        };
      }

      // 2) Weak bots.
      const bots = sorted.filter((c) => c.type === PlayerType.Bot);
      if (bots.length > 0) {
        return { entry: bots[0], reason: "farm bot", retaliating: false };
      }

      // 3) Very weak enemy: < 15% of their own maxTroops AND < 1.2x us.
      for (const c of sorted) {
        const cMax = estimateMaxTroops(world, c);
        if (c.troops < cMax * 0.15 && c.troops < myTroops * 1.2) {
          return { entry: c, reason: "very weak", retaliating: false };
        }
      }

      // 4) Traitor not much stronger than us.
      for (const c of sorted) {
        if (c.isTraitor && c.troops < myTroops * 1.2) {
          return { entry: c, reason: "traitor", retaliating: false };
        }
      }

      // 5) AFK / disconnected < 3x us.
      for (const c of sorted) {
        if (c.isDisconnected && c.troops < myTroops * 3) {
          return { entry: c, reason: "afk", retaliating: false };
        }
      }

      // 6) Victim: under 50%+ of their troops in incoming attacks & < 1.2x us.
      for (const c of sorted) {
        if (c.troops > myTroops * 1.2) continue;
        if ((c.incomingTroops || 0) > c.troops * 0.5) {
          return { entry: c, reason: "victim", retaliating: false };
        }
      }

      // 7) Weakest enemy strictly weaker than us.
      if (sorted[0] && sorted[0].troops < myTroops) {
        return { entry: sorted[0], reason: "weakest", retaliating: false };
      }
      return null;
    }

    /**
     * Choose the next structure to build by ROI, given current counts, gold
     * and situational flags. Each candidate carries a numeric priority (lower
     * = build sooner). Threat flags reprioritize: a nuke threat makes SAMs
     * top priority; a ground threat lifts DefensePosts above economy.
     *
     * flags: { coastAvailable, underThreat, crownRising, nukeThreat, mapShare }
     * Returns { type, cost, reason, affordable } or null.
     */
    function pickBuild(world, flags) {
      const me = world.me;
      if (!me) return null;
      flags = flags || {};
      const gold = me.gold;
      const s = me.structures || {};
      const cities = s[UnitType.City] || 0;
      const ports = s[UnitType.Port] || 0;
      const factories = s[UnitType.Factory] || 0;
      const dps = s[UnitType.DefensePost] || 0;
      const silos = s[UnitType.MissileSilo] || 0;
      const sams = s[UnitType.SAMLauncher] || 0;
      const pf = ports + factories;

      const candidates = [];

      // City — best early ROI (raises pop cap + troop income). Cheap until #4.
      if (cities < 12) {
        candidates.push({
          type: UnitType.City,
          cost: MATH.cityCost(cities),
          reason: "city #" + (cities + 1) + " (cap+income)",
          prio: 20,
        });
      }
      // Port — trade-ship gold (huge). Needs a coast.
      if (flags.coastAvailable && ports < 3 && cities >= 1) {
        candidates.push({
          type: UnitType.Port,
          cost: MATH.portCost(pf),
          reason: "port #" + (ports + 1) + " (trade gold)",
          prio: 30,
        });
      }
      // Factory — train gold; pair with cities.
      if (factories < Math.max(1, Math.floor(cities / 2)) && cities >= 2) {
        candidates.push({
          type: UnitType.Factory,
          cost: MATH.factoryCost(pf),
          reason: "factory #" + (factories + 1) + " (train gold)",
          prio: 40,
        });
      }
      // Defense posts — ×5 defense. Reactive/preemptive.
      const wantDPs = flags.underThreat ? cities + 2 : Math.floor(cities / 2);
      if (dps < wantDPs) {
        candidates.push({
          type: UnitType.DefensePost,
          cost: MATH.defensePostCost(dps),
          reason: "defense post (x5 hold)",
          // Under a real ground threat, fortifying beats another economy
          // building (DPs are cheap and multiply our hold ×5).
          prio: flags.underThreat ? 15 : 50,
        });
      }
      // Missile silos — needed to launch nukes; build as the crown rises.
      if ((flags.crownRising || (flags.mapShare || 0) > 0.15) && silos < 3) {
        candidates.push({
          type: UnitType.MissileSilo,
          cost: MATH.missileSiloCost(),
          reason: "silo (nuke capability)",
          prio: flags.crownRising ? 35 : 60,
        });
      }
      // SAM launchers — defend vs incoming nukes / pre-crown wall.
      const wantSams = flags.nukeThreat ? 2 : Math.floor(cities / 3);
      if (
        (flags.nukeThreat || flags.crownRising) &&
        sams < Math.max(1, wantSams)
      ) {
        candidates.push({
          type: UnitType.SAMLauncher,
          cost: MATH.samCost(sams),
          reason: "SAM (nuke defense)",
          // An inbound nuke is an emergency — SAM jumps to the top.
          prio: flags.nukeThreat ? 5 : 70,
        });
      }

      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.prio - b.prio);

      // Highest-priority affordable build wins.
      for (const b of candidates) {
        if (gold >= b.cost)
          return {
            type: b.type,
            cost: b.cost,
            reason: b.reason,
            affordable: true,
          };
      }
      // Otherwise advise banking for the highest-priority build.
      const top = candidates[0];
      return {
        type: top.type,
        cost: top.cost,
        reason: "save for " + top.reason,
        affordable: false,
      };
    }

    return {
      reserveForExpansion,
      reserveForCombat,
      availableTroops,
      expansionTroops,
      attackTroops,
      selectAttackTarget,
      estimateMaxTroops,
      pickBuild,
    };
  })();

  runtime.tactics = TACTICS;
  runtime.test.tactics = TACTICS;


  // ═══════════════════════════════════════════════════════════════════════
  //  D. SIM — forward simulator (chess-engine-style lookahead).
  //
  //  A lightweight deterministic projector (NOT a full re-sim of the game). It
  //  integrates the engine's exact troop-growth math forward, grows tiles by
  //  measured velocity, and accrues gold by measured/known income. The planner
  //  and threat engine query it to reason about FUTURE board states:
  //    - when can a neighbour invade us viably?
  //    - will the crown reach the win threshold before we can stop them?
  //    - if we commit X troops now, what is our defensive trough?
  //
  //  All functions are pure over the inputs (no GameView calls), so they are
  //  unit-tested directly.
  // ═══════════════════════════════════════════════════════════════════════

  const SIM = (function () {
    const DEFAULT_HORIZON = 600; // ticks (~60s) default lookahead
    const MAX_HORIZON = 1800; // hard cap for perf

    /**
     * Estimate a player's reserve fraction (troops they keep back rather than
     * committing to attacks). We can't read enemy intent, so we use a typical
     * Impossible-nation value; for ourselves the planner passes the real one.
     */
    function assumedReserveRatio(entry) {
      if (!entry) return 0.35;
      // Bots commit almost everything; humans/nations hold a reserve.
      return entry.type === PlayerType.Bot ? 0.1 : 0.35;
    }

    /**
     * Per-tick gold income estimate for a player. Prefer measured velocity
     * (gold/min from history), fall back to the passive base rate.
     */
    function goldIncomePerTick(entry, gameConfigInfo) {
      const perMin = entry.goldPerMin;
      if (typeof perMin === "number" && perMin > 0) {
        return perMin / 600;
      }
      const mult = (gameConfigInfo && gameConfigInfo.goldMultiplier) || 1;
      return MATH.goldAdditionRate(entry.type, mult);
    }

    /**
     * Project a single player forward `ticks` ticks. Tiles grow linearly by
     * measured velocity (clamped to [0, totalLand]); maxTroops is recomputed
     * from projected tiles each step; troops integrate via the exact
     * troopIncrease math; gold accrues by income.
     *
     * @returns time series endpoints {troops, tiles, gold, maxTroops}
     */
    function projectPlayer(entry, ticks, ctx) {
      ctx = ctx || {};
      ticks = Math.min(Math.max(0, Math.floor(ticks)), MAX_HORIZON);
      const type = entry.type;
      const difficulty = ctx.difficulty || Difficulty.Medium;
      const totalLand = ctx.totalLand || Infinity;
      const cityLevelsSum = entry.cityLevelsSum || 0; // known only for self
      const tilesPerTick = (entry.tilesPerMin || 0) / 600;
      const goldPerTick = goldIncomePerTick(entry, {
        goldMultiplier: ctx.goldMultiplier,
      });

      let troops = entry.troops || 0;
      let tiles = entry.tiles || 0;
      let gold = entry.gold || 0;

      const maxAt = (tl) =>
        ctx.maxTroopsOverride != null
          ? ctx.maxTroopsOverride
          : MATH.maxTroops({
              tiles: Math.max(0, tl),
              cityLevelsSum,
              type,
              difficulty,
            });

      // Step per tick (bounded by MAX_HORIZON). Cheap: a handful of players.
      for (let i = 0; i < ticks; i++) {
        tiles = Math.min(totalLand, Math.max(0, tiles + tilesPerTick));
        const max = maxAt(tiles);
        troops += MATH.troopIncrease({ troops, max, type, difficulty });
        gold += goldPerTick;
      }
      return { troops, tiles, gold, maxTroops: maxAt(tiles) };
    }

    /** Convenience: a player's projected troops after `ticks`. */
    function troopsAfter(entry, ticks, ctx) {
      return projectPlayer(entry, ticks, ctx).troops;
    }

    /** A player's currently committable troops (above their assumed reserve). */
    function committableTroops(entry, ctx) {
      const max =
        (ctx && ctx.maxTroopsOverride) ||
        MATH.maxTroops({
          tiles: entry.tiles || 0,
          cityLevelsSum: entry.cityLevelsSum || 0,
          type: entry.type,
          difficulty: (ctx && ctx.difficulty) || Difficulty.Medium,
        });
      const reserve =
        entry.reserveRatio != null
          ? entry.reserveRatio
          : assumedReserveRatio(entry);
      return Math.max(0, (entry.troops || 0) - max * reserve);
    }

    /**
     * How many ticks until `enemy` can invade `me` viably — i.e. their
     * committable troops reach `factor`× my defending troops. Projects both
     * forward tick-by-tick. Returns 0 if already true, Infinity if never
     * within the horizon.
     *
     * factor defaults to 1.0 (the engine's max-conquest-speed saturation point
     * vs a defender: atkTroops >= defenderTroops).
     */
    function ticksUntilInvadable(me, enemy, ctx) {
      ctx = ctx || {};
      const horizon = Math.min(ctx.horizon || DEFAULT_HORIZON, MAX_HORIZON);
      const factor = ctx.factor != null ? ctx.factor : 1.0;
      const difficulty = ctx.difficulty || Difficulty.Medium;
      const totalLand = ctx.totalLand || Infinity;

      // Local mutable copies.
      let meTroops = me.troops || 0;
      let meTiles = me.tiles || 0;
      const meMax = (tl) =>
        me.maxTroops != null && tl === (me.tiles || 0)
          ? me.maxTroops
          : MATH.maxTroops({
              tiles: Math.max(0, tl),
              cityLevelsSum: me.cityLevelsSum || 0,
              type: me.type || PlayerType.Human,
              difficulty,
            });
      const meTilesPerTick = (me.tilesPerMin || 0) / 600;

      let enTroops = enemy.troops || 0;
      let enTiles = enemy.tiles || 0;
      const enReserve =
        enemy.reserveRatio != null
          ? enemy.reserveRatio
          : assumedReserveRatio(enemy);
      const enTilesPerTick = (enemy.tilesPerMin || 0) / 600;
      const enMax = (tl) =>
        MATH.maxTroops({
          tiles: Math.max(0, tl),
          cityLevelsSum: 0,
          type: enemy.type || PlayerType.Human,
          difficulty,
        });

      const enCommittable = () => Math.max(0, enTroops - enMax(enTiles) * enReserve);

      if (enCommittable() >= meTroops * factor) return 0;

      for (let t = 1; t <= horizon; t++) {
        meTiles = Math.min(totalLand, Math.max(0, meTiles + meTilesPerTick));
        enTiles = Math.min(totalLand, Math.max(0, enTiles + enTilesPerTick));
        meTroops += MATH.troopIncrease({
          troops: meTroops,
          max: meMax(meTiles),
          type: me.type || PlayerType.Human,
          difficulty,
        });
        enTroops += MATH.troopIncrease({
          troops: enTroops,
          max: enMax(enTiles),
          type: enemy.type || PlayerType.Human,
          difficulty,
        });
        if (enCommittable() >= meTroops * factor) return t;
      }
      return Infinity;
    }

    /**
     * Ticks until the crown reaches the win tile-threshold at their measured
     * tile velocity. Infinity if not growing toward it.
     */
    function crownWinEta(world) {
      const crown = world.threats && world.threats.crown;
      if (!crown) return Infinity;
      const winPct = MATH.percentageTilesOwnedToWin(world.gameConfig.isTeam);
      const targetTiles = (winPct / 100) * world.totals.totalLand;
      if (crown.tiles >= targetTiles) return 0;
      const perTick = (crown.tilesPerMin || 0) / 600;
      if (perTick <= 0) return Infinity;
      return Math.ceil((targetTiles - crown.tiles) / perTick);
    }

    /**
     * Given we want to commit `commitTroops` to an offensive action, compute
     * our defensive trough and whether the most dangerous adjacent enemy could
     * exploit it within their reaction window. Returns:
     *   { trough, dangerousEnemy, safe, recommendedMax }
     * where recommendedMax is the largest commit that keeps trough above the
     * danger threshold.
     */
    function safeCommit(world, commitTroops, ctx) {
      ctx = ctx || {};
      const me = world.me;
      if (!me) return { trough: 0, safe: false, recommendedMax: 0 };
      const adjacents = (world.threats && world.threats.adjacentEnemies) || [];
      // The biggest immediate striker among adjacent enemies.
      let danger = null;
      let dangerCommittable = 0;
      for (const e of adjacents) {
        const c = committableTroops(e, {
          difficulty: world.gameConfig.difficulty,
        });
        if (c > dangerCommittable) {
          dangerCommittable = c;
          danger = e;
        }
      }
      // We must keep enough troops that an adjacent enemy can't conquer us at
      // max speed, i.e. keep troops >= dangerCommittable (the 1.0× point).
      const defenseFloor = dangerCommittable;
      const trough = (me.troops || 0) - commitTroops;
      const safe = trough >= defenseFloor;
      const recommendedMax = Math.max(0, (me.troops || 0) - defenseFloor);
      return { trough, dangerousEnemy: danger, defenseFloor, safe, recommendedMax };
    }

    return {
      DEFAULT_HORIZON,
      MAX_HORIZON,
      assumedReserveRatio,
      goldIncomePerTick,
      projectPlayer,
      troopsAfter,
      committableTroops,
      ticksUntilInvadable,
      crownWinEta,
      safeCommit,
    };
  })();

  runtime.sim = SIM;
  runtime.test.sim = SIM;


  // ═══════════════════════════════════════════════════════════════════════
  //  E. THREATS — preemption-first threat engine.
  //
  //  Augments world.threats using the world snapshot + adjacency/inbound info
  //  gathered from the live GameView (border scan, unit scan) which the
  //  per-tick loop passes in (Phase 6). Pure & testable: given the inputs, it
  //  classifies active/brewing invaders, rising stars, coalitions, and inbound
  //  nukes/boats, each annotated with SIM-derived time-to-impact.
  // ═══════════════════════════════════════════════════════════════════════

  const THREATS = (function () {
    const BREW_HORIZON = 400; // ticks: look this far ahead for brewing invaders
    const EARLY_OVERMATCH_TICK = 900; // "early game" window for human overmatch

    function compute(world, info) {
      info = info || {};
      const me = world.me;
      const t = world.threats; // crown already set by buildWorld
      if (!me) return t;

      const adjacent = (info.adjacentEnemies || []).slice();
      t.adjacentEnemies = adjacent;

      const ctx = {
        difficulty: world.gameConfig.difficulty,
        totalLand: world.totals.totalLand,
        horizon: BREW_HORIZON,
      };

      // ── Active invaders: adjacent hostiles currently attacking us. ──
      const adjBySid = new Map(adjacent.map((e) => [e.smallID, e]));
      const activeInvaders = [];
      let invasionInbound = 0;
      for (const a of me.incomingAttacks || []) {
        const atk = world.bySmallID.get(a.attackerID);
        if (!atk || atk.isMe || atk.isAlly) continue;
        invasionInbound += a.troops || 0;
        // Bots are noise unless large; track players & big bot pushes.
        if (atk.type === PlayerType.Bot && (a.troops || 0) < me.troops * 0.15)
          continue;
        if (!activeInvaders.some((x) => x.smallID === atk.smallID))
          activeInvaders.push(atk);
      }
      activeInvaders.sort((x, y) => y.troops - x.troops);
      t.activeInvaders = activeInvaders;
      t.invasionTroopsInbound = invasionInbound;

      // ── Brewing invaders: adjacent hostiles not yet attacking who SIM says
      //    can invade us within the horizon and are accumulating troops. ──
      const brewing = [];
      for (const e of adjacent) {
        if (activeInvaders.some((x) => x.smallID === e.smallID)) continue;
        if (e.isAlly) continue;
        const eta = SIM.ticksUntilInvadable(me, e, ctx);
        // Accumulating (or already capable) and a real contender.
        const accumulating = (e.troopsPerMin || 0) >= 0;
        const contender = e.troops >= me.troops * 0.8;
        if (eta < BREW_HORIZON && accumulating && contender) {
          brewing.push({ entry: e, etaTicks: eta, smallID: e.smallID, name: e.name, id: e.id, troops: e.troops, troopsPerMin: e.troopsPerMin });
        }
      }
      brewing.sort((x, y) => x.etaTicks - y.etaTicks);
      t.brewingInvaders = brewing;

      // ── Early human overmatch: an adjacent human ≥1.5× our troops early. ──
      t.earlyHumanOvermatch = null;
      if (world.tick <= EARLY_OVERMATCH_TICK) {
        for (const e of adjacent) {
          if (e.type === PlayerType.Human && e.troops >= me.troops * 1.5) {
            const ratio = e.troops / Math.max(1, me.troops);
            if (
              !t.earlyHumanOvermatch ||
              ratio > t.earlyHumanOvermatch.ratio
            ) {
              t.earlyHumanOvermatch = { enemy: e, ratio };
            }
          }
        }
      }

      // ── Rising stars: fast-growing non-allied players we can still beat. ──
      const rising = [];
      for (const e of world.everyone) {
        if (e.isMe || e.isAlly) continue;
        if ((e.tilesPerMin || 0) <= 0) continue;
        if (e.troops > me.troops * 1.2) continue; // beatable
        rising.push(e);
      }
      rising.sort((x, y) => (y.tilesPerMin || 0) - (x.tilesPerMin || 0));
      t.risingStars = rising.slice(0, 5);

      // ── Coalition against me: a bloc of mutually-allied non-allies whose
      //    combined share dwarfs ours, OR several players targeting us. ──
      t.coalitionAgainstMe = false;
      t.coalition = null;
      const targeters = info.targetedByCount || 0;
      // Bloc detection from passed alliance edges (smallID -> Set(smallID)).
      const blocs = detectBlocs(world, me);
      let biggest = null;
      for (const bloc of blocs) {
        const share = bloc.reduce((s, sid) => {
          const en = world.bySmallID.get(sid);
          return s + (en ? en.share : 0);
        }, 0);
        if (!biggest || share > biggest.share) biggest = { members: bloc, share };
      }
      if (
        (biggest && biggest.share > world.totals.myShare * 1.5 && biggest.members.length >= 2) ||
        targeters >= 3
      ) {
        t.coalitionAgainstMe = true;
        t.coalition = biggest;
      }

      // ── Inbound nukes / boats (passed from the unit scan). ──
      t.inboundNukes = info.inboundNukes || [];
      t.inboundBoats = info.inboundBoats || [];

      return t;
    }

    /**
     * Find connected components ("blocs") among non-me players using the
     * alliance edges in world.allianceGraph.edges (Map smallID->Set). Only
     * blocs excluding us are returned.
     */
    function detectBlocs(world, me) {
      const edges = (world.allianceGraph && world.allianceGraph.edges) || new Map();
      const seen = new Set();
      const blocs = [];
      for (const [sid] of edges) {
        if (sid === me.smallID || seen.has(sid)) continue;
        const stack = [sid];
        const comp = [];
        while (stack.length) {
          const cur = stack.pop();
          if (seen.has(cur) || cur === me.smallID) continue;
          seen.add(cur);
          comp.push(cur);
          const nbrs = edges.get(cur);
          if (nbrs) for (const n of nbrs) if (!seen.has(n) && n !== me.smallID) stack.push(n);
        }
        if (comp.length >= 2) blocs.push(comp);
      }
      return blocs;
    }

    return { BREW_HORIZON, compute, detectBlocs };
  })();

  runtime.threats = THREATS;
  runtime.test.threats = THREATS;

  // ═══════════════════════════════════════════════════════════════════════
  //  G. DIPLOMACY — make powerful allies, never let them surpass us.
  //
  //  Pure decision functions modeled on the engine's Impossible nation
  //  alliance logic (NationAllianceBehavior) and extended with an
  //  anti-overgrowth rule grounded in the SIM projector: we refuse to empower
  //  (or we betray) any ally projected to surpass us, when it's safe to do so.
  // ═══════════════════════════════════════════════════════════════════════

  const DIPLO = (function () {
    const OVERGROW_HORIZON = 600; // ticks to project ally/our share
    const THREAT_RATIO = 1.5; // a partner this much stronger is a "threat"

    function nonBotCount(world) {
      return world.totals.humanCount + world.totals.nationCount;
    }

    function estMax(world, entry) {
      return MATH.maxTroops({
        tiles: entry.tiles,
        cityLevelsSum: 0,
        type: entry.type,
        difficulty: world.gameConfig.difficulty,
      });
    }

    /** Will `entry` overtake our map share within the horizon (by velocity)? */
    function projectedToOvertake(world, entry, horizon) {
      horizon = horizon || OVERGROW_HORIZON;
      const ctx = {
        difficulty: world.gameConfig.difficulty,
        totalLand: world.totals.totalLand,
      };
      const myFuture = SIM.projectPlayer(
        Object.assign({}, world.me, { reserveRatio: undefined }),
        horizon,
        Object.assign({}, ctx, { maxTroopsOverride: world.me.maxTroops }),
      );
      const theirFuture = SIM.projectPlayer(entry, horizon, ctx);
      // Compare projected tiles (map share proxy).
      return theirFuture.tiles > myFuture.tiles;
    }

    function isThreat(world, entry) {
      const me = world.me;
      return (
        entry.troops > me.troops * THREAT_RATIO ||
        estMax(world, entry) > me.maxTroops * THREAT_RATIO ||
        entry.tiles > me.tiles * THREAT_RATIO
      );
    }

    /**
     * Should we ACCEPT an incoming alliance request from `req`?
     * Returns { accept, reason }.
     */
    function shouldAcceptAlliance(world, req) {
      const me = world.me;
      if (!me) return { accept: false, reason: "no me" };
      if (req.isTraitor) return { accept: false, reason: "traitor" };

      const nb = nonBotCount(world);
      // Don't feed the crown: reject players already allied to a big fraction
      // of the field (mirrors Impossible nation logic).
      if (nb >= 4 && req.allianceCount >= 0.25 * nb) {
        return { accept: false, reason: "feeding crown" };
      }
      // Appease genuine threats — allying the strong avoids being their target.
      if (isThreat(world, req)) {
        return { accept: true, reason: "appease threat" };
      }
      // Anti-overgrowth: don't empower a non-threat who will pass us.
      if (projectedToOvertake(world, req, OVERGROW_HORIZON)) {
        return { accept: false, reason: "would overgrow us" };
      }
      // Early game: alliances reduce fronts; accept peers readily.
      if (world.tick < 1200) {
        return { accept: true, reason: "early peer alliance" };
      }
      // Otherwise accept a reasonably-sized peer (a useful shield).
      if (req.troops >= me.troops * 0.4) {
        return { accept: true, reason: "peer shield" };
      }
      return { accept: false, reason: "too weak to matter" };
    }

    /**
     * Pick the best player to REQUEST an alliance with: strong enough to be a
     * real shield, not already friendly, not a traitor, not projected to
     * overgrow us, and not already over-allied. Returns the entry or null.
     */
    function pickAllianceRequestTarget(world) {
      const me = world.me;
      if (!me) return null;
      const nb = nonBotCount(world);
      const candidates = world.everyone.filter((e) => {
        if (e.isMe || e.isAlly) return false;
        if (e.type === PlayerType.Bot) return false;
        if (e.isTraitor) return false;
        if (nb >= 4 && e.allianceCount >= 0.25 * nb) return false; // crown-feeder
        if (projectedToOvertake(world, e, OVERGROW_HORIZON)) return false;
        return true;
      });
      // Prefer the strongest acceptable peer (best shield) that isn't so strong
      // they're a runaway. Sort by troops desc, then tiles.
      candidates.sort((a, b) => b.troops - a.troops || b.tiles - a.tiles);
      return candidates[0] || null;
    }

    /**
     * Is it safe to break an alliance right now? Breaking incurs the traitor
     * debuff (defense ×0.5 for 30s), so it's unsafe under heavy incoming
     * pressure or when the ally is our only buffer against a stronger field.
     */
    function safeToBreak(world, ally, opts) {
      opts = opts || {};
      const me = world.me;
      const pressure = me.incomingTroops / Math.max(1, me.troops);
      if (pressure > 0.25) return false;
      // Respect a break budget to avoid diplomacy thrash.
      if (opts.breaksUsed != null && opts.maxBreaks != null) {
        if (opts.breaksUsed >= opts.maxBreaks) return false;
      }
      // Don't break our only shield against a clearly stronger neighbour.
      const adjacent = (world.threats && world.threats.adjacentEnemies) || [];
      const strongAdjacent = adjacent.filter((e) => e.troops > me.troops);
      if (strongAdjacent.length >= 2) return false;
      return true;
    }

    /**
     * Should we BETRAY `ally`? Returns { betray, reason }.
     * Triggers: weak/MIRV'd ally we can absorb, traitor ally, or anti-overgrowth
     * (ally projected to surpass us) when it's safe to break.
     */
    function shouldBetrayAlly(world, ally, opts) {
      const me = world.me;
      if (!me) return { betray: false, reason: "no me" };

      // Weak / MIRV'd ally we can absorb (mirrors engine maybeBetray).
      const aMax = estMax(world, ally);
      const aOutgoing = ally.outgoingTroops || 0;
      if (
        ally.troops + aOutgoing < aMax * 0.2 &&
        ally.troops < me.troops &&
        safeToBreak(world, ally, opts)
      ) {
        return { betray: true, reason: "weak/MIRV'd ally — absorb" };
      }
      // Traitor ally not much stronger than us.
      if (ally.isTraitor && ally.troops < me.troops * 1.2 && safeToBreak(world, ally, opts)) {
        return { betray: true, reason: "traitor ally" };
      }
      // Anti-overgrowth: ally will surpass us -> cut them down before they win.
      if (projectedToOvertake(world, ally, OVERGROW_HORIZON) && safeToBreak(world, ally, opts)) {
        return { betray: true, reason: "anti-overgrowth (ally surpassing us)" };
      }
      return { betray: false, reason: "keep ally" };
    }

    /**
     * Response to a coalition forming against us: embargo the bloc & crown,
     * and ally the crown's strongest rival to split the field. Returns
     * { embargoTargets:[ids], allyTarget:entry|null }.
     */
    function coalitionResponse(world) {
      const me = world.me;
      const t = world.threats;
      const embargoTargets = [];
      let allyTarget = null;
      if (!t || !t.coalitionAgainstMe) return { embargoTargets, allyTarget };

      const crown = t.crown;
      if (crown && !crown.isMe && !crown.isAlly) {
        if (crown.id) embargoTargets.push(crown.id);
      }
      if (t.coalition && t.coalition.members) {
        for (const sid of t.coalition.members) {
          const en = world.bySmallID.get(sid);
          if (en && en.id && !en.isMe && !en.isAlly) embargoTargets.push(en.id);
        }
      }
      // Ally the strongest player who is NOT in the bloc and NOT the crown.
      const blocSet = new Set((t.coalition && t.coalition.members) || []);
      const rivals = world.everyone.filter(
        (e) =>
          !e.isMe &&
          !e.isAlly &&
          e.type !== PlayerType.Bot &&
          !blocSet.has(e.smallID) &&
          (!crown || e.smallID !== crown.smallID),
      );
      rivals.sort((a, b) => b.troops - a.troops);
      allyTarget = rivals[0] || null;
      return { embargoTargets, allyTarget };
    }

    return {
      OVERGROW_HORIZON,
      THREAT_RATIO,
      projectedToOvertake,
      isThreat,
      shouldAcceptAlliance,
      pickAllianceRequestTarget,
      safeToBreak,
      shouldBetrayAlly,
      coalitionResponse,
    };
  })();

  runtime.diplo = DIPLO;
  runtime.test.diplo = DIPLO;


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
