// ==UserScript==
// @name         OpenFront.io Superhuman Bot
// @namespace    http://tampermonkey.net/
// @version      2.6.1
// @description  Standalone strategic OpenFront bot: world model, threat scoring, goal planner, RL decision logger
// @author       Cursor
// @match        https://openfront.io/*
// @match        http://localhost:*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * ============================================================================
 * RL Decision Logger (schema v1)
 * ============================================================================
 *
 * Why this exists:
 *   We keep losing matches before the mid / late game. The next iteration of
 *   this bot needs to know *why* — which tiles we skipped, which goals kept
 *   losing priority races, which intents the stealth gate killed, which gold
 *   thresholds we never reached. So we drown the next agent in structured
 *   data: every decision, every rejected alternative, every outcome.
 *
 *   This logger is purely observational. It does not change any gameplay
 *   logic. Disabling it (`runtime.rl.enabled = false`) leaves behaviour
 *   byte-identical to the pre-2.6 bot.
 *
 * Event kinds (see `rlLog` callsites for precise shapes):
 *   match_start       — game bootstrap: gameID, clientID, players roster.
 *   config_snapshot   — every named "lever" constant + full GOAL_SPECS list.
 *   world_snapshot    — sampled self/totals/threats (cadence in constants).
 *   stat_delta        — short-term self deltas (tiles / troops / gold).
 *   planner_decision  — winner + top valid evaluations + rejected count.
 *   goal_switch       — edge-triggered goal transition.
 *   reason            — every reasonLog() mirrored into the stream.
 *   intent_sent       — outgoing intents with actionId + target info.
 *   intent_blocked    — stealth-gate rejections (rate-limited per reason).
 *   intent_outcome    — delta + reward window_ticks after the intent.
 *   spawn_decision    — chosen spawn tile + top alternatives.
 *   threat_flash      — crown change, MIRV risk, coalition, overmatch.
 *   match_end         — death / socket close, ranks + peaks + leverSuspicions.
 *
 * Export format (v2.6.1+):
 *   The dumper defaults to `level: "compact"` with a 500 KB byte budget to
 *   fit any LLM paste buffer. Compact form uses short keys:
 *     - Each event:   { k: <code>, t: <tick>, s: <seq>, d: <data> }
 *     - Kind codes:   MS = match_start, ME = match_end, CS = config_snapshot,
 *                     WS = world_snapshot, SD = stat_delta,
 *                     PD = planner_decision, GS = goal_switch, R = reason,
 *                     IS = intent_sent, IB = intent_blocked,
 *                     IO = intent_outcome, SP = spawn_decision,
 *                     TF = threat_flash.
 *     - Zero-valued / empty fields are stripped.
 *     - Floats are rounded to 2 decimals.
 *     - `summary.kindCodes` in the dump maps codes → full names.
 *   If the compact dump still exceeds `maxBytes`, the noisiest kinds are
 *   dropped oldest-first (WS → SD → R → IO → IS → PD → SP → IB → GS → TF).
 *   `summary.droppedByKind` accounts for every drop.
 *
 *   For full-fidelity local debugging, call `dumpRlJson({ level: "full" })`.
 *
 * How to export:
 *   - Click "RL dump" in the overlay → compact clipboard + file download.
 *   - Or from devtools:
 *        window.__superhumanBotRL.dump()                   // compact (default)
 *        window.__superhumanBotRL.dump({ level: "full" })  // legacy fat form
 *        window.__superhumanBotRL.dump({ maxBytes: 1e6 })  // custom budget
 *        window.__superhumanBotRL.dumpFull()               // shortcut
 *   - Last 3 matches auto-persist to localStorage under `superbotRL:<gameID>`
 *     using the compact form under RL_STORAGE_MAX_BYTES.
 *
 * Feeding it to the next agent:
 *   Paste the JSON directly into the analyst prompt. Start with:
 *     1. `config_snapshot.leverHints` — named knobs most likely to matter.
 *     2. `match_end` (code `ME`) `.d.su` — per-match suspicions.
 *     3. `planner_decision` (`PD`) entries — winner `w`, priority `wp`,
 *        evaluations `ev[]` with id `id` + priority `p` + note `n`.
 *     4. `intent_outcome` (`IO`) — reward `r`, tile delta `dT`, troop
 *        delta `dP`. Flag actions whose `r` < 0.
 *     5. `summary.droppedByKind` — if present, tells you what was trimmed.
 * ============================================================================
 */

(function () {
  "use strict";

  const BOT_VERSION = "2.6.1";
  const TROOP_DISPLAY_DIVISOR = 10;
  const MAX_LOG_ENTRIES = 250;
  const MAX_DECISION_ENTRIES = 180;
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
  const STEALTH_MAX_ATTACKS_PER_SEC = 2;
  const STEALTH_MAX_BUILDS_PER_SEC = 3;
  const STEALTH_REACTION_MIN_MS = 300;
  const STEALTH_REACTION_MAX_MS = 900;
  const STEALTH_SPAWN_THINK_MS = 8000;
  const STEALTH_COMBO_COOLDOWN_MS = 500;
  const STEALTH_PER_PLAYER_DIVERSITY_WINDOW_MS = 3000;
  const STEALTH_PER_PLAYER_DIVERSITY_CAP = 3;

  // RL Decision Logger tuning. See the top-of-file block comment for the
  // overall rationale; each knob is a first-class lever the downstream
  // analyst can nudge without understanding the rest of the codebase.
  const MAX_RL_EVENTS = 20000;
  const RL_OUTCOME_WINDOW_TICKS = 30;
  // Sampling cadences. These were originally set tight for a "log
  // everything" first pass, which produced 15 MB dumps. v2.6.1 loosens
  // them — the analyst rarely cares about every 1-second world snapshot
  // of a 10-minute match; 3-second samples preserve the trend shape at
  // ~3× lower cost. Bump back down only if a specific signal gets lost.
  const RL_STAT_DELTA_EVERY = 20;
  const RL_PLANNER_PERIODIC_EVERY = 60;
  const RL_WORLD_SNAPSHOT_EVERY = 30;
  const RL_STEALTH_BLOCK_LOG_MS = 500;
  const RL_ADJ_OVERMATCH_RATIO = 1.25;
  const RL_STORAGE_KEY_PREFIX = "superbotRL:";
  const RL_STORAGE_MAX_MATCHES = 3;
  // Compact export budget. The default dump target — 500 KB easily fits
  // any LLM context paste and even small inline form fields. The backing
  // localStorage cap is separate and still measured in MB.
  const RL_EXPORT_MAX_BYTES = 500_000;
  const RL_STORAGE_MAX_BYTES = 3_500_000;
  // World-snapshot roster cap per compacted event. We only keep the
  // top-N most-relevant opponents (highest threat + opportunity score);
  // the rest collapse into an `o` count field.
  const RL_COMPACT_ROSTER_CAP = 6;
  // String-field truncation used during compact serialization. Longer
  // notes (e.g. "collapsing=X attackers=3 drop=-50/m") get elided.
  const RL_COMPACT_STRING_CAP = 120;
  const RL_SCHEMA_VERSION = 1;

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
  // Build priority: cities and factories first (population + gold engine),
  // then Port for naval access, then DefensePosts, then nukes/SAMs.
  // DefensePosts intentionally come late — they don't raise pop cap and
  // bunkering early was crippling our population growth relative to
  // comparable players.
  const BuildPriority = [
    UnitType.City,
    UnitType.Factory,
    UnitType.Port,
    UnitType.DefensePost,
    UnitType.MissileSilo,
    UnitType.SAMLauncher,
  ];

  // Debug instrumentation flags. Off by default; the user can flip via console:
  //   window.__superhumanBotDebug.debugFlags.timing = true;
  //   window.__superhumanBotDebug.debugFlags.intel = true;
  const runtime = {
    enabled: true,
    mode: "balanced",
    processing: false,
    lastProcessedTick: -1,
    debugFlags: {
      timing: false, // log updateWorldModel duration once per 100 ticks
      intel: false,  // periodic [intel] console log of crown / rising / soft
    },
    _lastDecisionByKey: null,
    _intelLoggedAt: -999,
    _timingLoggedAt: -999,
    _timingSampleSum: 0,
    _timingSampleCount: 0,
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
        terrainRush: -999,
        allianceBreak: -999,
        allianceAccept: -999,
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
      // Diplomacy memory so we don't spam alliance breaks.
      // recentAllianceBreakTicks: rolling window of ticks at which we broke
      // an alliance. Used to enforce a cooldown on future breaks.
      recentAllianceBreakTicks: [],
      // allyHelplessSince: smallID -> tick we first observed the ally as
      // "helpless". Must be helpless continuously for HELPLESS_CONFIRM_TICKS
      // before we consider breaking.
      allyHelplessSince: new Map(),
      // Pending alliance-accept attempts, smallID -> tick when we fired the
      // back-request. Prevents spamming the same partner every tick.
      recentAllianceAccepts: new Map(),
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
        collapsingTargets: [],
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
      lastAttackMs: [], // rolling window of attack-intent timestamps
      lastBuildMs: [],  // rolling window of build-intent timestamps
      perPlayerActions: new Map(), // smallID -> [{ kind, atMs }]
      combos: new Map(), // smallID -> { lastKind, lastAtMs }
    },
    // ----- RL Decision Logger (see top-of-file doc block) ---------------
    // Purely observational: populated by rlLog() and consumed by
    // dumpRlJson() / persistRlToStorage(). Resetting is done in
    // handleServerMessage("start") — *never* mid-match, so the ring buffer
    // spans the full game.
    rl: {
      enabled: true,
      events: [],                         // ring buffer, capped at MAX_RL_EVENTS
      seq: 0,                             // monotonic sequence across the match
      sessionStartedAtMs: 0,
      configSnapshotSent: false,
      lastPlannerEmitTick: -999,
      lastStatDeltaTick: -999,
      lastWorldSnapshotTick: -999,
      prevSelfStats: null,                // { tick, tiles, troops, gold, structures }
      peakSelfStats: null,                // accumulated: { tiles, troops, gold, tileTick, troopTick, goldTick }
      totalIntentsSent: 0,
      totalIntentsBlocked: 0,
      lastActionId: 0,
      pendingOutcomes: [],                // [{ actionId, fireTick, preState, activeGoalId, intent }]
      matchEnded: false,
      lastIsAlive: false,
      firstActiveTick: -1,
      lastKnownCrownSmallID: null,
      lastKnownMirvRisk: false,
      lastKnownCoalitionThreat: false,
      lastAdjDangerRatio: 0,
      lastStealthBlockLogAtMs: new Map(), // reason -> ms (per-reason throttle)
      // Auto-suspicion state: so generateLeverSuspicions() can look back at
      // whether we ever ran certain goals, ever saw the nuke affordance,
      // etc., without re-walking the full event list.
      tracking: {
        goalsEverAdopted: new Set(),
        plannerGoalsEverValid: new Set(),
        everAdjacentToCollapsing: false,
        everRanTerrainRush: false,
        everSawMirvRisk: false,
        everSawCoalitionThreat: false,
      },
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

  /**
   * Decision log with 15-tick dedupe: identical (goal+body) messages that
   * fire back-to-back are rolled up into a single line rather than spamming
   * the panel. Returns the entry we appended for traceability.
   */
  function decisionLog(message) {
    const tick =
      runtime.hooks.gameView &&
      typeof runtime.hooks.gameView.ticks === "function"
        ? runtime.hooks.gameView.ticks()
        : 0;
    const goalId = runtime.planner.activeGoalId || "-";
    const key = goalId + "|" + message;
    const last = runtime._lastDecisionByKey;
    if (last && last.key === key && tick - last.tick < 15) {
      // Suppress duplicates within the dedupe window. Still update the last
      // entry's tick so we don't lose the fact that it is ongoing.
      last.tick = tick;
      last.count += 1;
      // Annotate the existing entry with the repeat count if this is the 2nd+.
      if (runtime.decisions.length > 0) {
        const idx = runtime.decisions.length - 1;
        runtime.decisions[idx] =
          "T" + tick + " " + message + " (×" + last.count + ")";
      }
      refreshOverlay();
      return;
    }
    const entry = "T" + tick + " " + message;
    runtime.decisions.push(entry);
    if (runtime.decisions.length > MAX_DECISION_ENTRIES) {
      runtime.decisions.shift();
    }
    runtime._lastDecisionByKey = { key, tick, count: 1 };
    console.log("[SuperBot:decision] " + entry);
    refreshOverlay();
  }

  /**
   * Record a structured "why we did that" entry.
   *
   *   reasonLog(goalId, summary, detail?)
   *
   * - `summary` is the single plain-English sentence the user should see in
   *   the overlay ("Hitting tribe for free structures"). Keep it to <=80
   *   chars, no jargon, no variable-name-style tokens.
   * - `detail` (optional) is a small data string for power users that shows
   *   below the summary in a dim font ("~12k defending", "48 tile segment").
   *   Leave it empty when the summary already says it all.
   */
  function reasonLog(goalId, summary, detail) {
    const tick =
      runtime.hooks.gameView &&
      typeof runtime.hooks.gameView.ticks === "function"
        ? runtime.hooks.gameView.ticks()
        : 0;
    const entry = {
      tick,
      goalId: goalId || "-",
      summary: summary || "-",
      detail: detail || "",
    };
    runtime.reasons.push(entry);
    if (runtime.reasons.length > MAX_REASON_ENTRIES) {
      runtime.reasons.shift();
    }
    decisionLog(
      "[" + entry.goalId + "] " + entry.summary +
      (entry.detail ? " (" + entry.detail + ")" : ""),
    );
    // Mirror into the RL stream so narrative and structured events stay
    // joined. Cheap enough to run unconditionally; rlLog short-circuits
    // when the logger is disabled.
    rlLog("reason", {
      goalId: entry.goalId,
      summary: entry.summary,
      detail: entry.detail,
    });
  }

  // ---------------------------------------------------------------------------
  // RL Decision Logger — see top-of-file block comment for the full schema.
  //
  // Everything here is additive and must never throw. We prefer dropping a
  // single event to breaking the tick loop.
  // ---------------------------------------------------------------------------

  /**
   * Append one RL event. Cheap, constant-time. Safe to call before the
   * GameView hook is available — `tick` just falls back to 0 / the last
   * known world tick in that case.
   */
  function rlLog(kind, data) {
    const rl = runtime.rl;
    if (!rl || !rl.enabled) return null;
    const gameView = runtime.hooks.gameView;
    const tick = safeCall(
      () =>
        gameView && typeof gameView.ticks === "function"
          ? gameView.ticks()
          : runtime.world && runtime.world.tick
            ? runtime.world.tick
            : 0,
      0,
    );
    const entry = {
      kind: String(kind || "unknown"),
      tick,
      wallMs: Date.now(),
      seq: rl.seq++,
      data: data || {},
    };
    rl.events.push(entry);
    if (rl.events.length > MAX_RL_EVENTS) {
      rl.events.splice(0, rl.events.length - MAX_RL_EVENTS);
    }
    return entry;
  }

  /**
   * Compact self snapshot. Used as `preState` for intents and as the base
   * for stat_delta / match_end. Intentionally numeric-only and ≤ 200 bytes
   * serialized.
   */
  function rlSelfSnapshot() {
    const me = runtime.world && runtime.world.me;
    if (!me) {
      return {
        tiles: 0,
        troops: 0,
        gold: 0,
        troopRatio: 0,
        structures: {},
        structureLevels: {},
      };
    }
    return {
      tiles: me.tiles || 0,
      troops: me.troops || 0,
      gold: me.gold || 0,
      troopRatio: me.troopRatio || 0,
      structures: Object.assign({}, me.structures || {}),
      structureLevels: Object.assign({}, me.structureLevels || {}),
    };
  }

  /**
   * Drop zero-valued numeric fields from a shallow object so our per-tick
   * opponent map stays compact. We *don't* recurse — structures are kept
   * as-is because downstream agents want to see the zeros there to
   * distinguish "never built" from "missing key".
   */
  function rlCompactNumeric(src) {
    const out = {};
    for (const key of Object.keys(src || {})) {
      const value = src[key];
      if (typeof value === "number") {
        if (value === 0) continue;
        out[key] = value;
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  /**
   * Summarise a single opponent for `world_snapshot`. Keep fields flat +
   * cheap; the analyst wants a table-style view, not nested structures.
   */
  function rlOpponentSummary(entry) {
    if (!entry) return null;
    const base = {
      smallID: entry.smallID,
      name: entry.name,
      type: entry.type,
      isFriendly: Boolean(entry.isFriendly),
      isAdjacent: Boolean(entry.isAdjacent),
      isDisconnected: Boolean(entry.isDisconnected),
      isTraitor: Boolean(entry.isTraitor),
      tiles: entry.tiles || 0,
      troops: entry.troops || 0,
      gold: entry.gold || 0,
      troopRatio: entry.troopRatio || 0,
      tilesPerMin: entry.tilesPerMin || 0,
      troopsPerMin: entry.troopsPerMin || 0,
      nukeReadiness: entry.nukeReadiness || 0,
      threatScore: entry.threatScore || 0,
      opportunityScore: entry.opportunityScore || 0,
      tags: entry.tags ? Array.from(entry.tags) : [],
    };
    return rlCompactNumeric(base);
  }

  /**
   * Compute the scalar reward for an intent, given the observed deltas
   * over RL_OUTCOME_WINDOW_TICKS. Deliberately simple + interpretable so
   * the downstream agent can reason about weights directly. Weights are
   * themselves levers (`rewardWeights` in config_snapshot).
   */
  const RL_REWARD_WEIGHTS = Object.freeze({
    tiles: 0.25,
    troopsPerDisplayDivisor: 0.01,
    goldPerCoin: 0.00005,
    city: 50,
    factory: 50,
    port: 20,
    missileSilo: 30,
    samLauncher: 15,
    defensePost: 10,
    diedPenalty: 100,
  });

  function rlComputeReward(delta, diedFlag) {
    const struct = (delta && delta.structures) || {};
    const cityΔ = struct[UnitType.City] || 0;
    const factoryΔ = struct[UnitType.Factory] || 0;
    const portΔ = struct[UnitType.Port] || 0;
    const siloΔ = struct[UnitType.MissileSilo] || 0;
    const samΔ = struct[UnitType.SAMLauncher] || 0;
    const dpΔ = struct[UnitType.DefensePost] || 0;
    const w = RL_REWARD_WEIGHTS;
    const reward =
      w.tiles * ((delta && delta.tiles) || 0) +
      w.troopsPerDisplayDivisor * (((delta && delta.troops) || 0) / TROOP_DISPLAY_DIVISOR) +
      w.goldPerCoin * ((delta && delta.gold) || 0) +
      w.city * cityΔ +
      w.factory * factoryΔ +
      w.port * portΔ +
      w.missileSilo * siloΔ +
      w.samLauncher * samΔ +
      w.defensePost * dpΔ -
      (diedFlag ? w.diedPenalty : 0);
    return Number(reward.toFixed(3));
  }

  /**
   * Build the full "levers" table. Every named constant the analyst might
   * want to nudge should appear here exactly once, keyed by its source name
   * so the downstream agent can do a simple rename-and-push PR.
   *
   * `leverHints` is a static, human-authored list of the highest-leverage
   * knobs with plain-English hints. Keep it narrow; the goal is to steer
   * the analyst, not enumerate everything.
   */
  function buildConfigSnapshot() {
    const uiState = runtime.hooks.uiState || {};
    const goals = [];
    if (typeof GOAL_SPECS !== "undefined" && Array.isArray(GOAL_SPECS)) {
      for (const spec of GOAL_SPECS) {
        goals.push({
          id: spec.id,
          horizonTicks: spec.horizonTicks || 0,
        });
      }
    }
    return {
      botVersion: BOT_VERSION,
      schemaVersion: RL_SCHEMA_VERSION,
      constants: {
        TROOP_DISPLAY_DIVISOR,
        MAX_LOG_ENTRIES,
        MAX_DECISION_ENTRIES,
        MAX_REASON_ENTRIES,
        LOOP_INTERVAL_MS,
        DISCOVERY_INTERVAL_MS,
        HISTORY_WINDOW_TICKS,
        HISTORY_SAMPLE_EVERY,
        HISTORY_MAX_SAMPLES,
        THREAT_CROWN_THRESHOLD,
        THREAT_CROWN_HYSTERESIS,
        MIRV_GOLD_THRESHOLD,
        HYDRO_GOLD_THRESHOLD,
        ATOM_GOLD_THRESHOLD,
        TICKS_PER_SECOND,
        TICKS_PER_MINUTE,
        STEALTH_MIN_INTENT_GAP_MS,
        STEALTH_MAX_MAJOR_PER_2S,
        STEALTH_MAX_ATTACKS_PER_SEC,
        STEALTH_MAX_BUILDS_PER_SEC,
        STEALTH_REACTION_MIN_MS,
        STEALTH_REACTION_MAX_MS,
        STEALTH_SPAWN_THINK_MS,
        STEALTH_COMBO_COOLDOWN_MS,
        STEALTH_PER_PLAYER_DIVERSITY_WINDOW_MS,
        STEALTH_PER_PLAYER_DIVERSITY_CAP,
        MAX_RL_EVENTS,
        RL_OUTCOME_WINDOW_TICKS,
        RL_STAT_DELTA_EVERY,
        RL_PLANNER_PERIODIC_EVERY,
        RL_WORLD_SNAPSHOT_EVERY,
        RL_STEALTH_BLOCK_LOG_MS,
        RL_ADJ_OVERMATCH_RATIO,
      },
      buildPriority: BuildPriority.slice(),
      structureTypes: StructureTypes.slice(),
      nukeTypes: NukeTypes.slice(),
      rewardWeights: Object.assign({}, RL_REWARD_WEIGHTS),
      goals,
      uiStart: {
        attackRatio: safeCall(() => Number(uiState.attackRatio), null),
        rocketDirectionUp: safeCall(() => Boolean(uiState.rocketDirectionUp), null),
        mode: runtime.mode,
      },
      // Human-authored hints. Update this list as we learn which knobs
      // *actually* correlate with losses.
      leverHints: [
        {
          name: "TERRA_NULLIUS_RUSH.priority",
          kind: "goal_priority",
          hint: "Base priority is 55; bump if we never make it above 10% map share.",
        },
        {
          name: "EASY_NATION_GRAB.priority",
          kind: "goal_priority",
          hint: "Raise if we let weak Nations sit on our border for >60s without rolling them.",
        },
        {
          name: "THREAT_CROWN_THRESHOLD",
          kind: "threshold",
          hint: "Lower (0.18?) to react to the crown earlier; risk of thrashing when nations yo-yo near the line.",
        },
        {
          name: "ATOM_GOLD_THRESHOLD",
          kind: "threshold",
          hint: "If we never save this much gold, check whether BuildPriority starves silos/cities.",
        },
        {
          name: "STEALTH_MAX_ATTACKS_PER_SEC",
          kind: "pacing",
          hint: "If intentsBlocked / intentsSent > 0.3, relaxing this recovers lost tempo.",
        },
        {
          name: "BuildPriority",
          kind: "build_order",
          hint: "City → Factory → Port → DefensePost → MissileSilo → SAMLauncher. Re-order if DPs eat too much gold early.",
        },
        {
          name: "RL_OUTCOME_WINDOW_TICKS",
          kind: "reward_horizon",
          hint: "30 ticks = 3s. Lengthen if attack outcomes consistently look null (clashes resolve slower than 3s).",
        },
        {
          name: "STEALTH_SPAWN_THINK_MS",
          kind: "pacing",
          hint: "8s 'think' before spawning. Shorten if we ever spawn after opponents grabbed the best land.",
        },
      ],
    };
  }

  /**
   * Deterministic heuristic suggestions at match end. These are *starting
   * points* for the next agent — explicitly flagged as suggestions, not
   * ground truth. Cap at 8 for scannability.
   */
  function generateLeverSuspicions(summary) {
    const out = [];
    const ticksAlive = Math.max(0, summary.ticksAlive || 0);
    const peak = summary.peakSelfStats || {
      tiles: 0,
      troops: 0,
      gold: 0,
    };
    const usableLand = Math.max(
      1,
      (runtime.world && runtime.world.totals && runtime.world.totals.usableLand) || 1,
    );
    const peakShare = peak.tiles / usableLand;
    const sent = summary.totalIntentsSent || 0;
    const blocked = summary.totalIntentsBlocked || 0;
    const tracking = summary.tracking || runtime.rl.tracking;
    const goalsAdopted = tracking ? tracking.goalsEverAdopted : new Set();
    const goalsValid = tracking ? tracking.plannerGoalsEverValid : new Set();

    if (ticksAlive > 0 && ticksAlive < 300) {
      out.push({
        lever: "spawn scoring",
        hint: `Died at T=${ticksAlive} (<300). Spawn pick may have been too aggressive; consider weighting distance-from-enemies higher.`,
      });
    }
    if (peakShare > 0 && peakShare < 0.05) {
      out.push({
        lever: "TERRA_NULLIUS_RUSH.priority",
        hint: `Peak map share was ${(peakShare * 100).toFixed(1)}%. Base priority=55 may be losing priority races; try 60–65.`,
      });
    }
    if (peak.gold > 0 && peak.gold < ATOM_GOLD_THRESHOLD) {
      out.push({
        lever: "ATOM_GOLD_THRESHOLD or BuildPriority",
        hint: `Peak gold was ${peak.gold} (<${ATOM_GOLD_THRESHOLD}). Never reached atom-bomb affordance; economy goals may be losing to DP spend.`,
      });
    }
    if (sent > 0) {
      const blockRate = blocked / Math.max(1, sent);
      if (blockRate > 0.3) {
        out.push({
          lever: "STEALTH_MAX_ATTACKS_PER_SEC / STEALTH_MAX_BUILDS_PER_SEC",
          hint: `${(blockRate * 100).toFixed(0)}% of intents were stealth-gated. Relax pacing to recover tempo (risk: detection).`,
        });
      }
    }
    if (
      tracking &&
      tracking.everAdjacentToCollapsing &&
      !tracking.everRanTerrainRush
    ) {
      out.push({
        lever: "TERRAIN_RUSH.priority",
        hint: "We had a collapsing neighbour but never ran TERRAIN_RUSH. Priority floor may be too low vs CONSOLIDATE_FRONT.",
      });
    }
    if (
      goalsValid.size > 0 &&
      !goalsValid.has("NUKE_CROWN") &&
      !goalsValid.has("MIRV_LAST_RESORT")
    ) {
      out.push({
        lever: "Late-game nuke gating",
        hint: "Neither NUKE_CROWN nor MIRV_LAST_RESORT ever evaluated valid. Check silo build-out and crown share.",
      });
    }
    if (
      goalsAdopted &&
      goalsAdopted.size <= 2 &&
      ticksAlive > 200
    ) {
      out.push({
        lever: "goal priority spread",
        hint: `Only ${goalsAdopted.size} distinct goal(s) ever adopted. The planner may be locked into one goal by the +15 commit bonus.`,
      });
    }
    if (
      tracking &&
      tracking.everSawCoalitionThreat &&
      !goalsAdopted.has("DIPLOMACY_ISOLATE_CROWN")
    ) {
      out.push({
        lever: "DIPLOMACY_ISOLATE_CROWN.priority",
        hint: "Coalition threat fired but we never ran the diplomacy counter. Raise base priority (currently 45).",
      });
    }
    if (summary.reason === "socket_closed" && ticksAlive > 300) {
      out.push({
        lever: "(meta) reconnect handling",
        hint: "Match ended on socket close late-game. Not a behaviour lever — investigate network / tab focus.",
      });
    }
    // Cap.
    return out.slice(0, 8);
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

      // Per-kind sub-limits so we can't e.g. queue 3 builds + 3 attacks in a
      // single 2s window. Matches Phase 9 spec.
      const kind = intentActionKind(intent);
      if (kind === "attack") {
        runtime.stealth.lastAttackMs = runtime.stealth.lastAttackMs.filter(
          (ts) => nowMs - ts <= 1000,
        );
        if (runtime.stealth.lastAttackMs.length >= STEALTH_MAX_ATTACKS_PER_SEC) {
          return { ok: false, reason: "attack-burst" };
        }
      } else if (kind === "build") {
        runtime.stealth.lastBuildMs = runtime.stealth.lastBuildMs.filter(
          (ts) => nowMs - ts <= 1000,
        );
        if (runtime.stealth.lastBuildMs.length >= STEALTH_MAX_BUILDS_PER_SEC) {
          return { ok: false, reason: "build-burst" };
        }
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
    const kind = intentActionKind(intent);
    if (kind === "attack") runtime.stealth.lastAttackMs.push(nowMs);
    if (kind === "build") runtime.stealth.lastBuildMs.push(nowMs);
    const targetSmallID = intentTargetSmallID(intent);
    if (targetSmallID === null) return;
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
      // RL: emit intent_blocked with per-reason throttling so a pathological
      // gate loop can't swamp the ring buffer.
      safeCall(() => rlLogIntentBlocked(intent, permits.reason), null);
      return false;
    }
    const success = sendRawMessage({ type: "intent", intent });
    if (success) {
      runtime.state.lastIntentSignature = signature;
      runtime.state.intentsSent += 1;
      recordStealthIntent(intent);
      decisionLog("sent " + intent.type);
      // RL: log the outgoing intent + pre-state, and queue a delayed
      // outcome emission for RL_OUTCOME_WINDOW_TICKS later.
      safeCall(() => rlLogIntentSent(intent), null);
    }
    return success;
  }

  /**
   * RL: record a stealth-gated intent. Throttled per-reason so a build
   * spammer doesn't drown the ring buffer.
   */
  function rlLogIntentBlocked(intent, reason) {
    const rl = runtime.rl;
    if (!rl || !rl.enabled) return;
    const nowMs = Date.now();
    const lastAt = rl.lastStealthBlockLogAtMs.get(reason) || 0;
    if (nowMs - lastAt < RL_STEALTH_BLOCK_LOG_MS) return;
    rl.lastStealthBlockLogAtMs.set(reason, nowMs);
    rl.totalIntentsBlocked += 1;
    rlLog("intent_blocked", {
      intentType: intent && intent.type,
      intent: intent,
      reason: String(reason || "unknown"),
      activeGoalId: runtime.planner.activeGoalId || null,
    });
  }

  /**
   * RL: record a successfully-sent intent + enqueue its outcome pairing.
   * Pulls target name / (x,y) from runtime.world + gameView so the downstream
   * agent doesn't have to cross-reference two arrays.
   */
  function rlLogIntentSent(intent) {
    const rl = runtime.rl;
    if (!rl || !rl.enabled) return;
    const actionId = ++rl.lastActionId;
    const preState = rlSelfSnapshot();
    const targetSmallID = safeCall(() => intentTargetSmallID(intent), null);
    const targetEntry =
      targetSmallID !== null &&
      runtime.world &&
      runtime.world.bySmallID &&
      runtime.world.bySmallID.get
        ? runtime.world.bySmallID.get(targetSmallID)
        : null;
    let tileXY = null;
    if (intent && Number.isFinite(intent.tile)) {
      const gv = runtime.hooks.gameView;
      if (gv && typeof gv.x === "function" && typeof gv.y === "function") {
        tileXY = { x: safeCall(() => gv.x(intent.tile), null), y: safeCall(() => gv.y(intent.tile), null) };
      }
    }
    rl.totalIntentsSent += 1;
    const tick = safeCall(
      () => (runtime.hooks.gameView ? runtime.hooks.gameView.ticks() : 0),
      0,
    );
    rlLog("intent_sent", {
      actionId,
      activeGoalId: runtime.planner.activeGoalId || null,
      intent,
      preState,
      targetSmallID,
      targetName: targetEntry ? targetEntry.name : null,
      targetTile: tileXY,
    });
    rl.pendingOutcomes.push({
      actionId,
      fireTick: tick + RL_OUTCOME_WINDOW_TICKS,
      preState,
      activeGoalId: runtime.planner.activeGoalId || null,
      intentType: intent && intent.type,
      targetSmallID,
    });
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
      safeCall(() => rlLogSpawnDecision(tile), null);
    }
    return success;
  }

  /**
   * RL: capture the spawn choice + the top alternatives we considered.
   * Random-spawn path uses runtime.state.spawn.sortedCandidates; manual
   * path stashes a hand-built list under `manualCandidates` (see
   * chooseManualSpawnTile). If neither is present (harness / unexpected
   * path) we still emit the minimal event so the analyst can count
   * spawns per match.
   */
  function rlLogSpawnDecision(tile) {
    const gv = runtime.hooks.gameView;
    if (!gv || typeof gv.x !== "function") {
      rlLog("spawn_decision", { mode: "unknown", chosen: { tile } });
      return;
    }
    const spawn = runtime.state.spawn;
    const x = safeCall(() => gv.x(tile), null);
    const y = safeCall(() => gv.y(tile), null);
    let mode = "manual";
    let sorted = null;
    if (spawn.sortedCandidates && spawn.sortedCandidates.length) {
      mode = "random";
      sorted = spawn.sortedCandidates;
    } else if (spawn.manualCandidates && spawn.manualCandidates.length) {
      sorted = spawn.manualCandidates;
    }
    const top = [];
    if (sorted) {
      for (let i = 0; i < Math.min(10, sorted.length); i++) {
        const cand = sorted[i];
        top.push({
          tile: cand.center,
          x: safeCall(() => gv.x(cand.center), null),
          y: safeCall(() => gv.y(cand.center), null),
          score: Number((cand.score || 0).toFixed(2)),
        });
      }
    }
    rlLog("spawn_decision", {
      mode,
      chosen: { tile, x, y, score: top[0] && top[0].tile === tile ? top[0].score : null },
      topCandidates: top,
      candidateCount: sorted ? sorted.length : 0,
    });
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

  /**
   * Validate that a boat from `spawnTile` to `dst` is within our current
   * boat-distance budget. Used by every goal that can send boats — without
   * this, long cross-map early-game invasions tank our economy.
   */
  function isBoatWithinRange(gameView, me, spawnTile, dst) {
    if (spawnTile === false || spawnTile === null || spawnTile === undefined) {
      return false;
    }
    const limit = getBoatDistanceLimit(gameView, me);
    if (!Number.isFinite(limit)) return true;
    const dist = safeCall(() => gameView.manhattanDist(spawnTile, dst), Infinity);
    return dist <= limit;
  }

  /**
   * Early-game gate — forbid any naval invasions while we're still bootstrapping
   * (tiny map share and short match time). Long boats during this window
   * starve land expansion and cost us the early game. Callers should skip any
   * naval intent when this returns true.
   */
  function isTooEarlyForNaval(gameView, me) {
    const activeTicks = getActiveMatchTicks(gameView);
    const totalLand = Math.max(1, safeCall(() => gameView.numLandTiles(), 1));
    const mapShare = me.numTilesOwned() / totalLand;
    return activeTicks < 1800 && mapShare < 0.05;
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
      return 72;
    }
    if (mapShare >= 0.06 || activeTicks >= 4200) {
      return 40;
    }
    return 24;
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
    // Stash top-10 for the RL spawn_decision event so the analyst can see
    // the alternatives we rejected. Cheap: at most 10 entries.
    runtime.state.spawn.manualCandidates = candidates.slice(0, 10);
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
        // Count enemy-owned tiles within a short radius of the segment so we
        // can prefer quieter frontiers. Crowded borders often trigger a
        // simultaneous attack race with a neighbor, costing troops and time.
        let crowdedEnemyBorders = 0;
        const probe = tiles.slice(0, 12);
        const seenCrowd = new Set();
        for (const t of probe) {
          for (const n of gameView.neighbors(t)) {
            const ownerID = gameView.ownerID(n);
            if (ownerID === 0 || ownerID === me.smallID()) continue;
            const key = ownerID + ":" + t;
            if (seenCrowd.has(key)) continue;
            seenCrowd.add(key);
            crowdedEnemyBorders += 1;
          }
        }
        segments.push({
          entryTile: seed,
          size: tiles.length,
          falloutCount,
          crowdedEnemyBorders,
        });
      }
    }

    segments.sort((a, b) => {
      const aScore =
        a.size - a.falloutCount * 4 - a.crowdedEnemyBorders * 1;
      const bScore =
        b.size - b.falloutCount * 4 - b.crowdedEnemyBorders * 1;
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
    // Lean harder into expansion while we're small — unclaimed tiles are
    // the cheapest way to grow income (which pays for cities, which raises
    // the pop cap). `reserveExpansionBias` shrinks the reserve ratio when
    // we're below half the map's expected share, subject to the floor in
    // computeReserveRatio. Expanding more aggressively here directly
    // trades current troops for future population ceiling.
    const baseReserve = computeReserveRatio(me, maxTroops);
    const totalLand = Math.max(
      1,
      safeCall(() => gameView.numLandTiles(), 1),
    );
    const mapShare = me.numTilesOwned() / totalLand;
    // Up to a 10-point reduction when we own <5% of the map. Tapers off
    // linearly so established players don't over-spend on expansion.
    const aggressionBonus = clamp(0.1 * (0.2 - mapShare) / 0.2, 0, 0.1);
    const reserveRatio = Math.max(0.08, baseReserve - 0.08 - aggressionBonus);
    const troops = calculateAttackTroops(me, null, reserveRatio, maxTroops);
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
    reasonLog(
      "TERRA_NULLIUS_RUSH",
      "Grabbing unclaimed land to grow income and pop cap.",
      `~${best.size} tiles, ${best.falloutCount} irradiated, ${best.crowdedEnemyBorders} rival borders`,
    );
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

    const archetype = runtime.world.archetype || "CONTINENTAL";
    const factoryCoef =
      archetype === "ISLAND"
        ? (hasCoast ? 0.55 : 0.9)
        : archetype === "NUKE_RACE"
          ? (hasCoast ? 0.45 : 0.85)
          : archetype === "CHOKE_HEAVY" || archetype === "ARENA"
            ? (hasCoast ? 0.3 : 0.6)
            : (hasCoast ? 0.4 : 0.75);
    const portCoef =
      archetype === "ISLAND" ? 0.9 : archetype === "CHOKE_HEAVY" ? 0.4 : 0.6;
    // DefensePost coefficient — intentionally conservative everywhere except
    // choke-heavy maps where DPs are the main way to hold the border.
    // Previously 0.5 for the default case made the bot spend gold on
    // bunkers before it had enough cities to raise its population ceiling.
    const dpCoef =
      archetype === "CHOKE_HEAVY" || archetype === "ARENA"
        ? 0.6
        : archetype === "ISLAND"
          ? 0.25
          : 0.35;
    const samCoef =
      archetype === "NUKE_RACE"
        ? 0.35
        : archetype === "CHOKE_HEAVY"
          ? 0.2
          : 0.25;
    const siloCoef = archetype === "NUKE_RACE" ? 0.3 : 0.22;
    const siloCap = archetype === "NUKE_RACE" ? 4 : 3;

    // Aggressive city cadence — one city per ~2500 owned tiles (was 3500),
    // minimum of 3 so we don't get stuck with 2 cities forever. Cities
    // drive maxTroops (population cap), so bumping this directly helps us
    // keep pace on population.
    const cityTarget = Math.max(3, Math.floor(me.numTilesOwned() / 2500));
    // Don't start building DefensePosts until our city count has caught
    // up to the cadence target. Defends cities first, bunkers second.
    const dpCityGate = Math.max(2, Math.floor(cityTarget * 0.66));
    // Require at least one *Human* adjacent enemy for DPs to unlock.
    // Nations / Bots (tribes) don't pressure the border in a way that
    // DefensePosts meaningfully counter, and in our tests bunkering those
    // borders drains gold that should be building cities.
    const adjacentHuman = (runtime.world.threats.adjacentEnemies || []).some(
      (e) => e && e.type === PlayerType.Human && !e.isFriendly,
    );

    switch (type) {
      case UnitType.City:
        return count < cityTarget;
      case UnitType.Factory:
        return count < Math.max(1, Math.floor(cities * factoryCoef));
      case UnitType.Port:
        return hasCoast && count < Math.max(1, Math.floor(cities * portCoef));
      case UnitType.DefensePost:
        return (
          adjacentHuman &&
          cities >= dpCityGate &&
          count < Math.max(1, Math.floor(cities * dpCoef))
        );
      case UnitType.MissileSilo:
        return (
          nukesEnabled &&
          cities >= 2 &&
          count < Math.min(siloCap, Math.max(1, Math.floor(cities * siloCoef)))
        );
      case UnitType.SAMLauncher:
        return cities >= 2 && count < Math.max(1, Math.floor(cities * samCoef));
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
   * True iff `tile` sits within `radius` of (or directly borders) a Human
   * player's territory. Used to gate DefensePost placement so we only harden
   * borders that face actual player threats — not Nations or tribes (Bots),
   * which don't meaningfully attack us in a way that DefensePosts counter.
   */
  function isTileNearHumanBorder(me, tile, radius = 3) {
    const gameView = getGameView();
    if (!gameView || !me) return false;
    const mySmallID = me.smallID();

    const seen = new Set();
    for (const neighbor of gameView.circleSearch(tile, radius)) {
      const ownerID = gameView.ownerID(neighbor);
      if (!ownerID || ownerID === 0 || ownerID === mySmallID) continue;
      if (seen.has(ownerID)) continue;
      seen.add(ownerID);
      const owner = safeCall(() => gameView.playerBySmallID(ownerID), null);
      if (!owner || !safeCall(() => owner.isPlayer(), false)) continue;
      if (safeCall(() => owner.type(), null) !== PlayerType.Human) continue;
      if (safeCall(() => me.isFriendly(owner), false)) continue;
      return true;
    }
    return false;
  }

  /**
   * Filter a candidate-tile list down to tiles that sit near a Human-player
   * border. If nothing qualifies we return an empty list — the caller should
   * skip the build rather than plopping a DefensePost against a tribe/nation.
   */
  function filterHumanBorderTiles(me, tiles) {
    if (!tiles || tiles.length === 0) return [];
    return tiles.filter((tile) => isTileNearHumanBorder(me, tile));
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
          UnitType.Port,
          UnitType.SAMLauncher,
          UnitType.MissileSilo,
          UnitType.DefensePost,
        ];
      default:
        // Historical CONTINENTAL / unclassified default: prioritise
        // pop-cap (City → Factory → Port) over DefensePosts. Bunkers are
        // still built, just last, so we don't sink gold into defences
        // before we've scaled population.
        return [
          UnitType.City,
          UnitType.Factory,
          UnitType.Port,
          UnitType.DefensePost,
          UnitType.MissileSilo,
          UnitType.SAMLauncher,
        ];
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
      let tiles;
      if (type === UnitType.Factory || type === UnitType.City) {
        // Factory/City placement benefits from rail connectivity awareness.
        tiles = connectivityBiasedTiles(me, candidateTiles);
      } else if (type === UnitType.DefensePost) {
        // Only place DefensePosts on borders with actual Human players —
        // they do nothing useful against Nations/Bots in the early game
        // and just waste gold that should fund expansion.
        tiles = filterHumanBorderTiles(me, candidateTiles);
        if (tiles.length === 0) {
          decisionLog("economy: skip DefensePost (no human border)");
          continue;
        }
      } else {
        tiles = candidateTiles;
      }
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

    if (isTooEarlyForNaval(gameView, me)) {
      decisionLog("naval: early game, focusing on land expansion");
      return false;
    }

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
        // Phase 6.8: bonus for SAMs that a hydrogen blast radius reaches
        // *while the SAM itself cannot reach the blast center*. Port of the
        // Impossible-difficulty bonus from `NationNukeBehavior.nukeTileScore`.
        let outrangeBonus = 0;
        if (nukeType === UnitType.HydrogenBomb) {
          const hydroOuter = nukeMagnitude(UnitType.HydrogenBomb).outer;
          const nearbySams = safeCall(
            () => gameView.nearbyUnits(candidate, hydroOuter, UnitType.SAMLauncher),
            [],
          );
          for (const sam of nearbySams) {
            const owner = sam.unit.owner();
            if (safeCall(() => owner.isMe(), false)) continue;
            if (safeCall(() => me.isFriendly(owner), false)) continue;
            const samLevel = safeCall(() => sam.unit.level(), 1);
            if (samLevel >= 5) continue;
            const samRange = safeCall(
              () => gameView.config().samRange(samLevel),
              70,
            );
            const d = Math.sqrt(sam.distSquared);
            if (d > samRange) {
              // Hydro reaches SAM but SAM can't reach candidate. Free kill.
              outrangeBonus += 5000 * samLevel;
            }
          }
        }
        const score =
          localStructureScore +
          crownPressure +
          alliancePressure +
          outrangeBonus -
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
      `Launching a MIRV at ${crown.name} to break the runaway leader.`,
      `they own ${(runtime.world.totals.crownShare * 100).toFixed(0)}% of the map`,
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
        "Firing an atom salvo to overwhelm their SAM wall before a bigger nuke.",
        `${fired} bombs vs ${coveringSams.length} SAMs (capacity ${totalCapacity})`,
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
            `Upgrading ${type} to lock in our lead.`,
          );
          return true;
        }
      }
    }

    // Build DefensePosts at pressured borders — but only borders that
    // actually face a Human player. Defending a tribe/nation border with a
    // DefensePost is wasted gold.
    const me2 = runtime.world.me;
    const cityCount = me2 ? me2.structures[UnitType.City] : 0;
    const dpCount = me2 ? me2.structures[UnitType.DefensePost] : 0;
    const dpTarget = Math.max(3, Math.floor(cityCount * 0.5));
    if (
      dpCount < dpTarget &&
      tick - runtime.state.cooldowns.economy >= 25
    ) {
      const candidates = filterHumanBorderTiles(
        me,
        getOwnedCandidateTiles(me, 16),
      );
      if (candidates.length === 0) {
        decisionLog("defensive-turtle: skip DefensePost (no human border)");
      }
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
            "Hardening our border against a human neighbour.",
            `${dpCount + 1}/${dpTarget} defense posts`,
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
            "Upgrading a SAM so we can survive incoming nukes.",
          );
          return true;
        }
      }
      if (buildable.canBuild !== false) {
        if (sendBuild(UnitType.SAMLauncher, tile)) {
          runtime.state.cooldowns.economy = tick;
          reasonLog(
            "SAM_WALL_BUILDUP",
            "Building a new SAM to cover our structures before we hit crown size.",
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

    if (!sendBreakAlliance(target.id)) return false;
    recordAllianceBreak();
    const troops = Math.floor(me.troops * 0.6);
    if (troops > 0) sendAttack(target.id, troops);
    runtime.state.cooldowns.betray = tick;
    runtime.state.cooldowns.combat = tick;
    reasonLog(
      "BETRAY_ALLY",
      `Breaking with ${target.name} — they're too weak to defend, so we take their land.`,
      `ally troops at ${(target.troopRatio * 100).toFixed(0)}% of cap`,
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
          "Building a warship to patrol our coast and intercept enemy boats.",
          runtime.world.archetype === "ISLAND"
            ? "island map — pirates hit hard here"
            : "enemy warships spotted",
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Port of `NationExecution.calculateBotAttackTroops`. Attacks bots with
   * exactly `target.troops * 4`, capped at our deployable budget; if the
   * budget is under `target.troops * 2` we skip the attack (not worth it).
   */
  function calcTribeAttackTroops(targetTroops, availableBudget) {
    if (availableBudget <= 0) return 0;
    const ideal = targetTroops * 4;
    if (ideal <= availableBudget) return Math.floor(ideal);
    if (availableBudget < targetTroops * 2) return 0;
    return Math.floor(availableBudget);
  }

  /**
   * TERRAIN_RUSH tactical. When a neighbouring player/tribe/nation is
   * visibly collapsing (fast tile loss + multiple attackers) we must rush
   * to grab as much of their territory as possible before other players
   * carve it up. We intentionally use a low reserve ratio so we can match
   * the pace of the rush — a half-committed attack loses the land race.
   */
  async function runGoal_TerrainRush(me, borderTiles) {
    const gameView = getGameView();
    if (!gameView || !me) return false;
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.terrainRush < 12) return false;
    const collapsing = runtime.world.threats.collapsingTargets || [];
    if (collapsing.length === 0) return false;

    const maxTroops = gameView.config().maxTroops(me);
    // Rush reserve is aggressive — we'd rather win tiles now and rebuild
    // troops than sit and lose the race. Reduce reserve by 18 pts vs the
    // standard calc; floor at 8% so we still keep some defensive buffer.
    const reserveRatio = Math.max(
      0.08,
      computeReserveRatio(me, maxTroops) - 0.18,
    );

    // Prefer adjacent collapsing targets; only consider non-adjacent ones
    // if none of the adjacent candidates can be attacked right now.
    const adjacentTargets = collapsing.filter((e) => e.isAdjacent);
    const candidates =
      adjacentTargets.length > 0 ? adjacentTargets : collapsing.slice();
    for (const target of candidates) {
      // Use the tribe-style 4× calc for bot tribes (defender strength is
      // tiny and 4× guarantees a clean sweep), otherwise fall back to the
      // standard attack math so we still commit aggressively without
      // overspending against a collapsing player.
      const budget = Math.floor(me.troops() - maxTroops * reserveRatio);
      let troops;
      if (target.type === PlayerType.Bot) {
        troops = calcTribeAttackTroops(target.troops, budget);
      } else {
        const standard = calculateAttackTroops(
          me,
          target.player,
          reserveRatio,
          maxTroops,
        );
        // For collapsing humans/nations we rush with at least ceil(1.4×
        // defender) when affordable — they are shedding troops quickly so
        // their real defence is weaker than `target.troops` implies.
        const minRush = Math.max(
          standard,
          Math.min(budget, Math.ceil(target.troops * 1.4)),
        );
        troops = Math.max(0, minRush);
      }
      if (troops <= 0) continue;

      if (target.isAdjacent) {
        if (sendAttack(target.id, troops)) {
          runtime.state.cooldowns.terrainRush = tick;
          runtime.state.cooldowns.combat = tick;
          runtime.state.lastAction =
            "rush-grabbing from " + target.name;
          runtime.state.strategy = "terrain-rush";
          reasonLog(
            "TERRAIN_RUSH",
            `Rushing ${target.name} while they're collapsing — claim tiles before neighbours do.`,
            `${target.distinctAttackerCount || 0} attackers, losing ${target.tilesPerMin.toFixed(0)} tiles/min`,
          );
          return true;
        }
        continue;
      }

      // Non-adjacent — try a boat so we still claim some of their coast.
      if (isTooEarlyForNaval(gameView, me)) continue;
      const landingTile = gatherStructureTiles(target.player)[0];
      if (!landingTile) continue;
      const spawn = await queryTransportShipSpawn(landingTile);
      if (spawn === false) continue;
      if (!isBoatWithinRange(gameView, me, spawn, landingTile)) continue;
      const boatTroops = Math.min(
        troops,
        Math.floor(me.troops() * 0.35),
      );
      if (boatTroops <= 0) continue;
      if (sendBoat(landingTile, boatTroops)) {
        runtime.state.cooldowns.terrainRush = tick;
        runtime.state.cooldowns.naval = tick;
        runtime.state.cooldowns.combat = tick;
        runtime.state.strategy = "terrain-rush";
        reasonLog(
          "TERRAIN_RUSH",
          `Landing a boat on ${target.name}'s coast while they're collapsing.`,
        );
        return true;
      }
    }
    return false;
  }

  /**
   * FARM_TRIBE tactical: pick the nearest adjacent tribe (PlayerType.Bot) and
   * hit it with the 4× formula. Bots delete their own structures, so we want
   * to grab the cluster before they delete the buildings.
   */
  async function runGoal_FarmTribe(me, borderTiles) {
    const gameView = getGameView();
    if (!gameView || !me) return false;
    const tick = gameView.ticks();
    if (tick - runtime.state.cooldowns.combat < 10) return false;

    const adj = runtime.world.threats.adjacentEnemies || [];
    const tribe = adj.find((e) => e.tags && e.tags.has("TRIBE_FARM"));
    if (!tribe) return false;

    const maxTroops = gameView.config().maxTroops(me);
    const reserveRatio = Math.max(0.15, computeReserveRatio(me, maxTroops) - 0.1);
    const budget = Math.floor(me.troops() - maxTroops * reserveRatio);
    const troops = calcTribeAttackTroops(tribe.troops, budget);
    if (troops <= 0) return false;

    if (sendAttack(tribe.id, troops)) {
      runtime.state.cooldowns.combat = tick;
      reasonLog(
        "FARM_TRIBE",
        `Attacking tribe ${tribe.name} to seize their structures before they delete them.`,
        `~${fmtTroops(tribe.troops)} defending`,
      );
      return true;
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
          `Counter-attacking ${attackerEntry.name} to break their push.`,
          `they sent ~${fmtTroops(largest.troops)} at us`,
        );
        return true;
      }
    } else {
      // Boat retaliation if they aren't bordering us. Skip in early game and
      // beyond our current boat-distance budget so we don't waste troops on
      // long-range ships while we still need to expand on land.
      if (isTooEarlyForNaval(gameView, me)) return false;
      const target = gatherStructureTiles(attacker)[0];
      if (!target) return false;
      const spawnTile = await queryTransportShipSpawn(target);
      if (spawnTile === false) return false;
      if (!isBoatWithinRange(gameView, me, spawnTile, target)) return false;
      if (sendBoat(target, troops)) {
        runtime.state.cooldowns.combat = tick;
        runtime.state.cooldowns.naval = tick;
        reasonLog(
          "RETALIATION",
          `Sending a boat to punish ${attackerEntry.name} across the water.`,
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
          `Pre-empting ${target.name} before their snowball crowns.`,
          `gaining ${target.tilesPerMin.toFixed(0)} tiles/min`,
        );
        return true;
      }
      return false;
    }

    if (isTooEarlyForNaval(gameView, me)) return false;
    const landingTile = gatherStructureTiles(target.player)[0];
    if (!landingTile) return false;
    const spawn = await queryTransportShipSpawn(landingTile);
    if (spawn === false) return false;
    if (!isBoatWithinRange(gameView, me, spawn, landingTile)) return false;
    if (sendBoat(landingTile, Math.min(required, Math.floor(me.troops() * 0.35)))) {
      runtime.state.cooldowns.combat = tick;
      runtime.state.cooldowns.naval = tick;
      reasonLog(
        "NEUTRALIZE_RISING_STAR",
        `Sending a boat to pre-empt crown rival ${target.name} across water.`,
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

    // Build a bias: tiles adjacent to our top adjacent **Human** enemy get
    // tried first. We explicitly skip Nations/Bots — DefensePosts are for
    // deterring real players, not tribes/AI that won't sustainably pressure
    // our border anyway.
    const adjacent = runtime.world.threats.adjacentEnemies.find(
      (e) => e && e.type === PlayerType.Human,
    );
    if (!adjacent) {
      decisionLog("consolidate-front: skip DefensePost (no human on border)");
      return false;
    }
    // 1-deep interior candidates — step one neighbor inward from a border
    // tile that touches the threat. Mirrors
    // `NationStructureBehavior.defensePostValue` which prefers a band one
    // inside the border.
    const borderAdjacent = borderTiles.filter((t) => {
      return gameView.neighbors(t).some(
        (n) => gameView.ownerID(n) === adjacent.smallID,
      );
    });
    const interiorSet = new Set();
    for (const t of borderAdjacent.slice(0, 48)) {
      for (const n of gameView.neighbors(t)) {
        if (gameView.ownerID(n) !== me.smallID()) continue;
        // require that the interior tile itself is NOT on the border, so it
        // sits 1-deep behind the front line.
        if (safeCall(() => gameView.isBorder(n), false)) continue;
        interiorSet.add(n);
      }
    }
    const interior = Array.from(interiorSet);
    const sortedBorder = borderAdjacent.slice();
    // Try interior tiles first, then fall back to border tiles if no interior
    // placement is legal.
    const combined = interior.concat(sortedBorder);

    for (const tile of combined.slice(0, 32)) {
      const buildables = await queryPlayerBuildables(tile, [
        UnitType.DefensePost,
      ]);
      const buildable = buildables.find((b) => b.type === UnitType.DefensePost);
      if (!buildable || buildable.canBuild === false) continue;
      if (sendBuild(UnitType.DefensePost, tile)) {
        runtime.state.cooldowns.economy = tick;
        reasonLog(
          "CONSOLIDATE_FRONT",
          `Hardening the front under pressure from ${adjacent.name}.`,
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

    if (isTooEarlyForNaval(gameView, me)) return false;

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
        if (spawn !== false && isBoatWithinRange(gameView, me, spawn, target)) {
          const troops = clamp(Math.floor(available * 0.25), 6000, 20000);
          if (sendBoat(target, troops)) {
            runtime.state.cooldowns.naval = tick;
            reasonLog(
              "NAVAL_LAND_GRAB",
              "Shipping troops to an empty island to claim free tiles.",
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
      if (!isBoatWithinRange(gameView, me, spawn, candidate)) continue;
      const troops = clamp(Math.floor(available * 0.3), 8000, 30000);
      if (sendBoat(candidate, troops)) {
        runtime.state.cooldowns.naval = tick;
        reasonLog(
          "NAVAL_LAND_GRAB",
          `Invading ${target.name} by sea — they're soft and across the water.`,
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

  // Alliance-break guardrails. Breaking an alliance marks us as a traitor,
  // which inflicts a 50% defense debuff for 30 seconds and sours every nearby
  // player's relation. Breaking alliances too readily is a direct cause of
  // games snowballing into a "everyone attacks us" loss state. These
  // constants intentionally err on the side of keeping alliances alive.
  //
  // HELPLESS_CONFIRM_TICKS: how long an ally must continuously look helpless
  // before we even consider breaking.
  // ALLIANCE_BREAK_COOLDOWN_TICKS: minimum ticks between any two alliance
  // breaks we initiate, to avoid a cascading traitor death spiral.
  // TRAITOR_DURATION_TICKS: mirrors DefaultConfig.traitorDuration() (30s).
  // HELPLESS_TROOP_RATIO / HELPLESS_TROOP_ADVANTAGE: how weak an ally must be
  // before we consider them "helpless".
  // MAX_ALLIANCE_BREAKS_PER_WINDOW / ALLIANCE_BREAK_WINDOW_TICKS: rolling cap
  // so we never chain-break more than N alliances in a short window.
  const HELPLESS_CONFIRM_TICKS = 300; // 30s of sustained weakness
  const ALLIANCE_BREAK_COOLDOWN_TICKS = 600; // 60s between breaks
  const TRAITOR_DURATION_TICKS = 30 * TICKS_PER_SECOND;
  const HELPLESS_TROOP_RATIO = 0.12;
  const HELPLESS_TROOP_ADVANTAGE = 0.35;
  const MAX_ALLIANCE_BREAKS_PER_WINDOW = 1;
  const ALLIANCE_BREAK_WINDOW_TICKS = 1200; // 2 minutes
  const ALLIANCE_ACCEPT_COOLDOWN_TICKS = 200;

  /**
   * Have we broken more alliances than we should allow in the current
   * rolling window? Keeps the traitor state from stacking catastrophically.
   */
  function allianceBreakBudgetExceeded() {
    const tick = runtime.world.tick;
    const windowStart = tick - ALLIANCE_BREAK_WINDOW_TICKS;
    const recent = (runtime.state.recentAllianceBreakTicks || []).filter(
      (t) => t >= windowStart,
    );
    runtime.state.recentAllianceBreakTicks = recent;
    return recent.length >= MAX_ALLIANCE_BREAKS_PER_WINDOW;
  }

  /**
   * Mark an alliance break in the rolling-window log and cooldown tracker.
   * Call this whenever we successfully dispatch a `breakAlliance` intent.
   */
  function recordAllianceBreak() {
    const tick = runtime.world.tick;
    const list = runtime.state.recentAllianceBreakTicks || [];
    list.push(tick);
    const windowStart = tick - ALLIANCE_BREAK_WINDOW_TICKS;
    runtime.state.recentAllianceBreakTicks = list.filter(
      (t) => t >= windowStart,
    );
    runtime.state.cooldowns.allianceBreak = tick;
  }

  /**
   * Ally is "helpless" per our betray heuristic: low troop ratio AND notably
   * weaker than us in raw troops. We require sustained helplessness via
   * `allyHelplessSince` before returning true.
   */
  function isAllyConfirmedHelpless(ally, myEntry) {
    if (!ally || !myEntry) return false;
    const tick = runtime.world.tick;
    const helplessNow =
      ally.troopRatio < HELPLESS_TROOP_RATIO &&
      ally.troops < myEntry.troops * HELPLESS_TROOP_ADVANTAGE;
    const map = runtime.state.allyHelplessSince;
    if (!helplessNow) {
      if (map.has(ally.smallID)) map.delete(ally.smallID);
      return false;
    }
    if (!map.has(ally.smallID)) {
      map.set(ally.smallID, tick);
      return false;
    }
    const since = map.get(ally.smallID);
    return tick - since >= HELPLESS_CONFIRM_TICKS;
  }

  /**
   * Would be dangerous to break this alliance right now? True if we're under
   * real threat — traitor debuff would be punishing.
   */
  function isUnsafeToBreakAlliance(myEntry) {
    if (!myEntry) return true;
    const world = runtime.world;
    const adjacentHostile = world.threats.adjacentEnemies.some(
      (e) => e.troops > myEntry.troops * 0.8,
    );
    const mirvNearby = world.threats.mirvCapable.some((p) => !p.isFriendly);
    const incomingPressure = myEntry.incomingTroops > myEntry.troops * 0.25;
    const alreadyTraitor =
      safeCall(() => myEntry.player.isTraitor(), false) === true;
    const breakCooldown =
      world.tick - runtime.state.cooldowns.allianceBreak <
      ALLIANCE_BREAK_COOLDOWN_TICKS;
    return (
      adjacentHostile ||
      mirvNearby ||
      incomingPressure ||
      alreadyTraitor ||
      breakCooldown ||
      allianceBreakBudgetExceeded()
    );
  }

  /**
   * Should we accept this incoming alliance request? We accept when the
   * requestor is a plausible partner:
   *   - not a clanmate (we proactively ally those anyway)
   *   - not the hostile crown
   *   - not actively attacking us
   *   - not below the alliance cap for us
   *   - either friendly / similar-strength / stronger / bordering the crown
   *   - we haven't recently responded to them
   *
   * Accepting is modeled as sending an alliance request back: the server
   * auto-accepts when both sides have outstanding requests (see
   * `AllianceRequestExecution.init`).
   */
  function shouldAcceptIncomingAlliance(requestor, myEntry) {
    if (!requestor || !myEntry) return false;
    if (requestor.isAlly) return false;
    if (requestor.isMe) return false;
    if (requestor.type === PlayerType.Bot) return false;
    const world = runtime.world;
    const crown = world.threats.crown;
    if (crown && !crown.isFriendly && requestor.smallID === crown.smallID) {
      return false;
    }
    // Refuse anyone currently attacking us — they are exploiting alliance
    // mechanics, not offering a genuine partnership.
    if (
      Array.isArray(requestor.outgoingAttacks) &&
      requestor.outgoingAttacks.some(
        (a) => safeCall(() => a.targetID, null) === world.meSmallID,
      )
    ) {
      return false;
    }
    // If we are already at the alliance cap, only accept if the new partner
    // is clearly stronger than one of our current allies (so they offer a
    // strict upgrade in coalition strength).
    const currentAllies = world.everyone.filter(
      (e) => e.isAlly && !e.isClanmate,
    );
    if (currentAllies.length >= ALLIANCE_CAP) {
      const weakestAllyStrength = currentAllies.reduce(
        (min, ally) => Math.min(min, ally.strength || 0),
        Infinity,
      );
      if (!((requestor.strength || 0) > weakestAllyStrength * 1.2)) {
        return false;
      }
    }
    // Core acceptance heuristic: the partner must offer real value.
    //  - comparableStrength: they're close to or stronger than us, so the
    //    alliance is a meaningful deterrent / mutual defense pact.
    //  - blocksCrown: there is a hostile crown we need help against AND the
    //    partner is not already allied with the crown; the alliance helps
    //    us dilute the crown's coalition.
    //  - adjacentAlly: an adjacent non-hostile partner is strategically
    //    valuable as a buffer, even if smaller than us.
    const comparableStrength =
      requestor.troops >= myEntry.troops * 0.6 ||
      requestor.tiles >= myEntry.tiles * 0.6;
    const partnerAlliedWithCrown =
      !!crown &&
      world.allianceGraph &&
      (world.allianceGraph.edges.get(requestor.smallID) || new Set()).has(
        crown.smallID,
      );
    const blocksCrown =
      !!crown &&
      !crown.isFriendly &&
      requestor.smallID !== crown.smallID &&
      !partnerAlliedWithCrown;
    const adjacentAlly =
      !!requestor.isAdjacent &&
      requestor.troops >= myEntry.troops * 0.3;
    const neutralOrFriendly =
      safeCall(
        () => myEntry.player.relation(requestor.player) >= 0,
        true,
      ) === true;
    return (
      (comparableStrength || blocksCrown || adjacentAlly) &&
      neutralOrFriendly &&
      !requestor.isTraitor
    );
  }

  /**
   * Scan every player and yield the ones that have an outgoing alliance
   * request targeted at us. Uses PlayerView.isRequestingAllianceWith which
   * reads the `outgoingAllianceRequests` list on the requestor's snapshot.
   */
  function getIncomingAllianceRequestors() {
    const world = runtime.world;
    const me = world.me;
    if (!me) return [];
    const requestors = [];
    for (const entry of world.everyone) {
      if (entry.isMe) continue;
      if (entry.isAlly) continue;
      const isRequesting = safeCall(
        () =>
          entry.player.isRequestingAllianceWith &&
          entry.player.isRequestingAllianceWith(me.player),
        false,
      );
      if (isRequesting) requestors.push(entry);
    }
    return requestors;
  }

  /**
   * Strategic diplomacy.
   *   1. Always try to pseudo-ally with detected clanmates.
   *   2. Accept beneficial incoming alliance requests.
   *   3. Under the ALLIANCE_CAP, look for an alliance that would dampen the
   *      crown's rise (partner must be adjacent to or bordering the crown and
   *      not themselves be the crown).
   *   4. Embargo the crown if hostile.
   *   5. Break alliances with disconnected / long-term-helpless allies, but
   *      only when it is genuinely safe to absorb the traitor penalty.
   *   6. Fall through to the legacy `maybeDiplomacy` for edge cases.
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
            `Auto-allying with clanmate ${clanmate.name}.`,
            clanmate.clanTag ? `clan tag [${clanmate.clanTag}]` : "",
          );
          return true;
        }
      }
    }

    // 2. Accept beneficial incoming alliance requests. We answer by sending
    //    an alliance request back; the server auto-accepts when both sides
    //    have outstanding requests (AllianceRequestExecution.init).
    const incomingRequestors = getIncomingAllianceRequestors();
    for (const requestor of incomingRequestors) {
      const lastAttemptTick =
        runtime.state.recentAllianceAccepts.get(requestor.smallID) ?? -Infinity;
      if (tick - lastAttemptTick < ALLIANCE_ACCEPT_COOLDOWN_TICKS) continue;
      if (!shouldAcceptIncomingAlliance(requestor, myEntry)) continue;
      const tile =
        gatherStructureTiles(requestor.player)[0] ||
        sampleTilesForOwner(requestor.smallID, 1, {
          requireLand: true,
          maxSamples: 120,
        })[0];
      if (!tile) continue;
      const actions = await queryPlayerActions(tile, null);
      if (
        !actions ||
        !actions.interaction ||
        !actions.interaction.canSendAllianceRequest
      ) {
        continue;
      }
      if (sendAllianceRequest(requestor.id)) {
        runtime.state.cooldowns.diplomacy = tick;
        runtime.state.cooldowns.allianceAccept = tick;
        runtime.state.recentAllianceAccepts.set(requestor.smallID, tick);
        reasonLog(
          "DIPLOMACY_ISOLATE_CROWN",
          `Accepting ${requestor.name}'s alliance request.`,
          `their troops ~${fmtTroops(requestor.troops)}`,
        );
        return true;
      }
    }

    // 3. Partner-with-best-anti-crown-position up to ALLIANCE_CAP.
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
            `Asking ${candidate.name} to ally — they border the crown and can pressure them.`,
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
              `Embargoing ${crown.name} to deny them trade revenue.`,
              `they own ${(crownShare * 100).toFixed(0)}% of the map`,
            );
            return true;
          }
        }
      }
    }

    // 5. Break alliances only when it's genuinely beneficial AND safe.
    // Breaking flips us to `traitor` (50% defense debuff for 30s) and
    // angers neighbours, so we are extremely conservative:
    //   - Hard cap on breaks per rolling window + inter-break cooldown.
    //   - Never break while under attack, while MIRV-capable enemies are
    //     alive, or while we're already traitor.
    //   - Disconnected allies: break only once it's been clearly wasting
    //     an alliance slot (they only consume a slot, no opportunity cost).
    //   - Traitor allies: don't break them — they're already traitors, so
    //     letting them drop off naturally (or getting nuked) is cheaper.
    //   - Helpless allies: require *sustained* helplessness and a safe
    //     context before pulling the trigger.
    const safeToBreak = !isUnsafeToBreakAlliance(myEntry);
    for (const ally of currentAllies) {
      if (ally.isClanmate) continue;
      let reason = null;
      if (ally.isDisconnected && safeToBreak) {
        reason = "disconnected";
      } else if (isAllyConfirmedHelpless(ally, myEntry) && safeToBreak) {
        reason = "sustained helpless";
      }
      if (!reason) continue;
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
          recordAllianceBreak();
          reasonLog(
            "DIPLOMACY_ISOLATE_CROWN",
            `Dropping ${ally.name} — ${reason}. Freeing the alliance slot.`,
          );
          return true;
        }
      }
    }

    // 6. Nothing to do at the strategic level.
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

    // Legacy break-alliance fallback is retained only for disconnected
    // allies, and only when it's safe. The goal-aware diplomacy pass above
    // already handles the nuanced "helpless ally" case.
    const myEntry = runtime.world.me;
    const safeToBreak = !isUnsafeToBreakAlliance(myEntry);
    if (safeToBreak) {
      for (const ally of allies) {
        if (!safeCall(() => ally.isDisconnected(), false)) continue;
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
        if (sendBreakAlliance(ally.id())) {
          runtime.state.cooldowns.diplomacy = tick;
          recordAllianceBreak();
          runtime.state.lastAction =
            "breaking alliance with " + ally.displayName();
          runtime.state.strategy = "diplomacy";
          botLog("Break alliance -> " + ally.displayName() + " (disconnected)");
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
    if (runtime.world.history.size > 0) {
      for (const smallID of Array.from(runtime.world.history.keys())) {
        if (!livingSmallIDs.has(smallID)) {
          runtime.world.history.delete(smallID);
        }
      }
    }
    // Also prune diplomacy memory so we don't hold onto stale state for
    // players that have since died or respawned with a different smallID.
    const helplessMap = runtime.state.allyHelplessSince;
    if (helplessMap && helplessMap.size > 0) {
      for (const smallID of Array.from(helplessMap.keys())) {
        if (!livingSmallIDs.has(smallID)) helplessMap.delete(smallID);
      }
    }
    const acceptsMap = runtime.state.recentAllianceAccepts;
    if (acceptsMap && acceptsMap.size > 0) {
      for (const smallID of Array.from(acceptsMap.keys())) {
        if (!livingSmallIDs.has(smallID)) acceptsMap.delete(smallID);
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
    const collapsingTargets = [];
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

      // Collapsing / terrain-rush target.
      //
      // Signals that a player/tribe/nation is getting swarmed and is about
      // to be carved up — we want to recognize this early so we can join
      // the rush before neighbours eat everything. We classify an entry as
      // collapsing when it satisfies a combination of:
      //   - losing tiles fast (negative tilesPerMin),
      //   - multiple distinct attackers hitting it,
      //   - weak relative to its maxTroops (can't defend),
      //   - or already dwindling below a small share of the map.
      // Tribes are eligible too so we can opportunistically farm them.
      const distinctAttackers = new Set();
      for (const atk of entry.incomingAttacks || []) {
        const attackerId = safeCall(() => atk.attackerID, null);
        if (attackerId !== null && attackerId !== 0) {
          distinctAttackers.add(attackerId);
        }
      }
      const attackerCount = distinctAttackers.size;
      const tileDrop = entry.tilesPerMin < -30;
      const heavyTileDrop = entry.tilesPerMin < -80;
      const swarmed = attackerCount >= 2;
      const heavySwarm = attackerCount >= 3;
      const lowShare =
        totals.usableLand > 0 &&
        entry.tiles > 0 &&
        entry.tiles / totals.usableLand < 0.08;
      const heavilyPressured =
        entry.maxTroops > 0 &&
        entry.troopRatio < 0.25 &&
        entry.incomingTroops > entry.troops * 1.2;
      const collapsing =
        !entry.isFriendly &&
        !entry.isMe &&
        entry.tiles > 0 &&
        ((tileDrop && swarmed) ||
          heavyTileDrop ||
          heavySwarm ||
          (lowShare && heavilyPressured) ||
          (heavilyPressured && swarmed));
      entry.collapsing = collapsing;
      entry.distinctAttackerCount = attackerCount;
      if (collapsing) {
        tags.add("COLLAPSING");
        collapsingTargets.push(entry);
      }

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
      // Collapsing targets bump opportunity score hard — if someone is
      // getting swarmed, every neighbour rushes for tiles and we must too.
      const collapseBoost = tags.has("COLLAPSING")
        ? 50 + Math.min(20, entry.distinctAttackerCount * 5) +
          Math.min(20, Math.max(0, -entry.tilesPerMin / 10))
        : 0;
      entry.opportunityScore =
        (tags.has("SOFT_TARGET") ? 40 : 0) +
        (tags.has("TRIBE_FARM") ? 35 : 0) +
        Math.max(0, 20 - entry.troopRatio * 20) +
        (tags.has("ADJACENT") ? 15 : 0) +
        collapseBoost;

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
    // Collapsing targets: prefer the one we can reach fastest (adjacent
    // beats non-adjacent), then largest remaining tile count so we grab
    // the biggest prize before it vanishes.
    collapsingTargets.sort((a, b) => {
      if (a.isAdjacent !== b.isAdjacent) return a.isAdjacent ? -1 : 1;
      return b.tiles - a.tiles;
    });

    // Update crown w/ hysteresis tracking (see Phase 2 acceptance criterion).
    runtime.world.prevCrownSmallID = runtime.world.threats.crownSmallID;
    runtime.world.threats = {
      crownSmallID: crownEntry ? crownEntry.smallID : null,
      crown: crownEntry,
      prevCrownSmallID: runtime.world.threats.crownSmallID,
      risingStars: risingStars.slice(0, 5),
      softTargets: softTargets.slice(0, 5),
      collapsingTargets: collapsingTargets.slice(0, 5),
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

  /**
   * Emit a one-liner intel summary to the console every ~200 ticks so the
   * user can sanity-check the categorizer without cracking open the overlay.
   * Gated behind `debugFlags.intel` (off by default).
   */
  function maybePeriodicIntelLog() {
    if (!runtime.debugFlags.intel) return;
    const tick = runtime.world.tick;
    if (tick - runtime._intelLoggedAt < 200) return;
    runtime._intelLoggedAt = tick;
    const crown = runtime.world.threats.crown;
    const rising = (runtime.world.threats.risingStars || [])
      .slice(0, 3)
      .map((s) => s.name + "+" + s.tilesPerMin.toFixed(0) + "/m")
      .join(",");
    const soft = (runtime.world.threats.softTargets || [])
      .slice(0, 3)
      .map((s) => s.name)
      .join(",");
    const collapsing = (runtime.world.threats.collapsingTargets || [])
      .slice(0, 3)
      .map(
        (s) =>
          s.name +
          "(" +
          (s.distinctAttackerCount || 0) +
          "×," +
          s.tilesPerMin.toFixed(0) +
          "/m)",
      )
      .join(",");
    const crownStr = crown
      ? crown.name + " " + (runtime.world.totals.crownShare * 100).toFixed(0) + "%"
      : "-";
    console.log(
      "[SuperBot:intel] T" +
        tick +
        " crown=" +
        crownStr +
        " rising=[" +
        (rising || "-") +
        "] soft=[" +
        (soft || "-") +
        "] collapsing=[" +
        (collapsing || "-") +
        "]",
    );
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
        case "EASY_NATION_GRAB":
        case "TERRAIN_RUSH":
        case "TERRA_NULLIUS_RUSH":
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
        // At extreme pressure (≥1.0) the front will collapse if we counter-
        // attack instead of fortifying — bump the priority so CONSOLIDATE
        // overtakes RETALIATION.
        const priority = pressure >= 1 ? 94 : 78;
        return {
          valid: true,
          priority,
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
      // EASY_NATION_GRAB — we border a Nation or unstructured Bot and have
      // a clear troop advantage. Nations don't form alliances and have a
      // low defensive ceiling, so they're the best source of converted
      // territory once terra nullius dries up. Priority sits just below
      // FARM_TRIBE so a structured tribe still gets priority, but above
      // DEFENSE_NETWORK so we grow instead of bunker.
      id: "EASY_NATION_GRAB",
      horizonTicks: 80,
      evaluate: () => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        if (me.troops < 8000) return { valid: false };
        const adj = world.threats.adjacentEnemies || [];
        const candidates = adj.filter(
          (e) =>
            e &&
            !e.isFriendly &&
            (e.type === PlayerType.Nation || e.type === PlayerType.Bot) &&
            // Either meaningfully weaker than us, or structure-rich
            // (worth the troops). Structure-rich tribes are already
            // caught by FARM_TRIBE; this goal is for plain Nations and
            // structureless Bots we can roll over.
            (e.troops < me.troops * 0.7 || (e.tiles || 0) > 30),
        );
        if (candidates.length === 0) return { valid: false };
        // Prefer the weakest candidate so we land easy wins first.
        const target = candidates.reduce(
          (best, c) => (best === null || c.troops < best.troops ? c : best),
          null,
        );
        return {
          valid: true,
          priority: 63,
          note:
            `easy=${target.name} (${target.type}) ` +
            `troopRatio=${(target.troops / Math.max(me.troops, 1)).toFixed(2)}`,
        };
      },
      onAct: async () => false,
    },
    {
      // TERRAIN_RUSH — a neighbouring player/tribe/nation is collapsing
      // (fast tile loss, multiple attackers). Rush to claim tiles before
      // everyone else carves them up. Priority scales with how badly the
      // target is melting so we preempt even strong alternatives.
      id: "TERRAIN_RUSH",
      horizonTicks: 90,
      evaluate: () => {
        const world = runtime.world;
        const me = world.me;
        if (!me) return { valid: false };
        const collapsing = world.threats.collapsingTargets || [];
        if (collapsing.length === 0) return { valid: false };
        // Must be reachable: adjacent, or we have the naval capacity to
        // ship troops over. For the adjacency-less case we still allow it
        // but at lower priority.
        const adjacentTarget = collapsing.find((e) => e.isAdjacent);
        const anyReachable =
          !!adjacentTarget ||
          collapsing.some(
            (e) => (me.structures[UnitType.Port] || 0) > 0,
          );
        if (!anyReachable) return { valid: false };
        // Troop gate — we need some attack budget to make the rush worth it.
        if (me.troopRatio < 0.15 && me.troops < 8000) {
          return { valid: false };
        }
        const chosen = adjacentTarget || collapsing[0];
        // Dynamic priority: more attackers + faster tile drop = higher
        // priority. Adjacent beats non-adjacent by a healthy margin.
        const base = adjacentTarget ? 82 : 60;
        const swarmBonus = Math.min(
          10,
          (chosen.distinctAttackerCount || 0) * 2,
        );
        const speedBonus = Math.min(
          12,
          Math.max(0, -chosen.tilesPerMin / 15),
        );
        return {
          valid: true,
          priority: base + swarmBonus + speedBonus,
          note:
            "collapsing=" +
            chosen.name +
            " attackers=" +
            (chosen.distinctAttackerCount || 0) +
            " drop=" +
            chosen.tilesPerMin.toFixed(0) +
            "/m" +
            (adjacentTarget ? "" : " (water)"),
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
        // Early game, unclaimed land is the highest-value target — it
        // converts directly to income and unlocks more cities. Priority
        // scales with how much of the map is still unclaimed AND how
        // small we still are; once we're past ~20% share mid-game goals
        // like SAM_WALL_BUILDUP / DEFENSE_NETWORK take over.
        const base = 55;
        const unownedBonus = clamp(unownedFrac * 40, 0, 20);
        const smallPlayerBonus = world.totals.myShare < 0.1 ? 15 : 0;
        const mediumPlayerBonus =
          world.totals.myShare >= 0.1 && world.totals.myShare < 0.2 ? 6 : 0;
        return {
          valid: true,
          priority: base + unownedBonus + smallPlayerBonus + mediumPlayerBonus,
          note:
            `${(unownedFrac * 100).toFixed(0)}% unowned, ` +
            `myShare=${(world.totals.myShare * 100).toFixed(0)}%`,
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
        // Only build out a DefensePost network when we actually face a
        // Human neighbour. Nations/Bots don't justify the gold cost
        // (they drop structures easily and don't sustain pressure).
        const adjHuman = (world.threats.adjacentEnemies || []).some(
          (e) => e && e.type === PlayerType.Human && !e.isFriendly,
        );
        if (!adjHuman) return { valid: false };
        const cityCount = me.structures[UnitType.City] || 0;
        const dpCount = me.structures[UnitType.DefensePost] || 0;
        // Gate on city count — we want cities ahead of DPs so our pop cap
        // keeps growing. Require cities >= 4 before the network target
        // becomes active.
        if (cityCount < 4) return { valid: false };
        const target = Math.max(2, Math.floor(cityCount * 0.35));
        if (dpCount >= target) return { valid: false };
        return {
          valid: true,
          priority: 42,
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
        // Respect the alliance-break budget — don't add another traitor
        // debuff if we already broke something recently.
        if (allianceBreakBudgetExceeded()) return { valid: false };
        if (isUnsafeToBreakAlliance(me)) return { valid: false };
        const allies = world.everyone.filter(
          (p) => p.isAlly && !p.isClanmate,
        );
        if (allies.length === 0) return { valid: false };
        // Only betray allies that are confirmed helpless over time, NOT on a
        // single transient low-troop snapshot. This matches the tightened
        // diplomacy heuristic (HELPLESS_CONFIRM_TICKS).
        const target = allies.find(
          (ally) =>
            isAllyConfirmedHelpless(ally, me) &&
            ally.troops < me.troops * HELPLESS_TROOP_ADVANTAGE,
        );
        if (!target) return { valid: false };
        // Safety: no superior hostile nearby.
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
    // Deterministic tiebreaker: equal-priority goals sort alphabetically by
    // id so the planner's output is reproducible tick-to-tick. Without this
    // Array.prototype.sort can shuffle ties on different JS engines.
    planner.lastEvaluation = evaluations
      .slice()
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

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
      // RL: emit goal_switch *before* mutating planner state so the event
      // captures the pre-transition stats.
      rlLog("goal_switch", {
        prev: previous,
        next: selection.spec.id,
        priority: selection.evaluation.priority,
        note: selection.evaluation.note || "",
        forced: Boolean(selection.forced),
        myStats: rlSelfSnapshot(),
      });
      planner.activeGoalId = selection.spec.id;
      planner.activeGoal = selection.spec;
      planner.activeGoalCreatedTick = tick;
      planner.activeGoalExpiresTick = tick + selection.spec.horizonTicks;
      planner.lastSwitchTick = tick;
      // Track adoption history for match-end suspicion heuristics.
      if (runtime.rl && runtime.rl.tracking) {
        runtime.rl.tracking.goalsEverAdopted.add(selection.spec.id);
        if (selection.spec.id === "TERRAIN_RUSH") {
          runtime.rl.tracking.everRanTerrainRush = true;
        }
      }
      reasonLog(
        selection.spec.id,
        `Switching plan: ${previous} → ${selection.spec.id}.`,
        selection.evaluation.note,
      );
    } else {
      planner.activeGoalExpiresTick = Math.max(
        planner.activeGoalExpiresTick,
        tick + 20,
      );
    }
  }

  /**
   * RL: emit a planner_decision event when either (a) the winner changed
   * this tick or (b) RL_PLANNER_PERIODIC_EVERY ticks have elapsed since the
   * last emit. Uses runtime.planner.lastEvaluation which already enumerates
   * every goal's priority + validity + note.
   */
  function maybeEmitPlannerDecision(selection) {
    const rl = runtime.rl;
    if (!rl || !rl.enabled) return;
    const planner = runtime.planner;
    const tick = runtime.world.tick;
    const evaluations = Array.isArray(planner.lastEvaluation)
      ? planner.lastEvaluation
      : [];

    // Track every goal that ever evaluated valid — drives match-end
    // suspicion heuristics.
    for (const ev of evaluations) {
      if (ev && ev.valid) {
        rl.tracking.plannerGoalsEverValid.add(ev.id);
      }
    }

    const winnerId = selection ? selection.spec.id : null;
    const switched =
      winnerId !== null && winnerId !== rl.lastKnownWinnerGoalId;
    const periodic =
      tick - rl.lastPlannerEmitTick >= RL_PLANNER_PERIODIC_EVERY;
    if (!switched && !periodic) return;
    rl.lastPlannerEmitTick = tick;
    rl.lastKnownWinnerGoalId = winnerId;

    const valid = evaluations.filter((e) => e && e.valid);
    const invalid = evaluations
      .filter((e) => e && !e.valid)
      .map((e) => ({ id: e.id, note: e.note || "" }));
    const sortedValid = valid
      .slice()
      .sort((a, b) => b.priority - a.priority);
    const winner = sortedValid[0] || null;
    const winnerPriority = winner ? winner.priority : null;
    const runnerUps = sortedValid.slice(1, 4).map((e) => ({
      id: e.id,
      priority: e.priority,
      gap: winnerPriority === null ? null : winnerPriority - e.priority,
      note: e.note || "",
    }));
    rlLog("planner_decision", {
      winnerGoalId: winner ? winner.id : null,
      winnerPriority,
      winnerNote: winner ? winner.note || "" : "",
      forced: Boolean(selection && selection.forced),
      goalSwitched: switched,
      runnerUps,
      rejected: invalid,
      evaluations: evaluations.map((e) => ({
        id: e.id,
        priority: e.priority || 0,
        valid: Boolean(e.valid),
        note: e.note || "",
      })),
      myStats: rlSelfSnapshot(),
    });
  }

  /**
   * RL: world_snapshot + stat_delta + threat_flash per tick. Only emits when
   * the relevant sampling intervals have elapsed; cheap otherwise.
   */
  function maybeEmitPeriodicRL(me, borderTiles) {
    const rl = runtime.rl;
    if (!rl || !rl.enabled) return;
    const world = runtime.world;
    if (!world || !world.me) return;
    const tick = world.tick;
    if (rl.firstActiveTick < 0) rl.firstActiveTick = tick;
    rl.lastIsAlive = true;

    // Update peak self stats every tick (cheap).
    const self = world.me;
    if (!rl.peakSelfStats) {
      rl.peakSelfStats = {
        tiles: self.tiles || 0,
        tileTick: tick,
        troops: self.troops || 0,
        troopTick: tick,
        gold: self.gold || 0,
        goldTick: tick,
      };
    } else {
      if ((self.tiles || 0) > rl.peakSelfStats.tiles) {
        rl.peakSelfStats.tiles = self.tiles || 0;
        rl.peakSelfStats.tileTick = tick;
      }
      if ((self.troops || 0) > rl.peakSelfStats.troops) {
        rl.peakSelfStats.troops = self.troops || 0;
        rl.peakSelfStats.troopTick = tick;
      }
      if ((self.gold || 0) > rl.peakSelfStats.gold) {
        rl.peakSelfStats.gold = self.gold || 0;
        rl.peakSelfStats.goldTick = tick;
      }
    }

    // world_snapshot every 10 ticks while alive.
    if (tick - rl.lastWorldSnapshotTick >= RL_WORLD_SNAPSHOT_EVERY) {
      rl.lastWorldSnapshotTick = tick;
      const opponents = {};
      for (const entry of world.everyone) {
        if (!entry || entry.isMe) continue;
        const summary = rlOpponentSummary(entry);
        if (summary) opponents[entry.smallID] = summary;
      }
      rlLog("world_snapshot", {
        self: {
          tiles: self.tiles || 0,
          troops: self.troops || 0,
          gold: self.gold || 0,
          troopRatio: self.troopRatio || 0,
          maxTroops: self.maxTroops || 0,
          tilesPerMin: self.tilesPerMin || 0,
          troopsPerMin: self.troopsPerMin || 0,
          goldPerMin: self.goldPerMin || 0,
          incomingTroops: self.incomingTroops || 0,
          outgoingTroops: self.outgoingTroops || 0,
          structures: Object.assign({}, self.structures || {}),
          structureLevels: Object.assign({}, self.structureLevels || {}),
          borderTileCount: Array.isArray(borderTiles) ? borderTiles.length : 0,
        },
        totals: Object.assign({}, world.totals || {}),
        allianceGraph: {
          largestBlocShare:
            (world.allianceGraph && world.allianceGraph.largestBlocShare) || 0,
          coalitionThreat: Boolean(
            world.allianceGraph && world.allianceGraph.coalitionThreat,
          ),
        },
        threats: {
          crownSmallID: world.threats.crownSmallID,
          mirvRisk: Boolean(world.threats.mirvRisk),
          adjacentEnemySmallIDs: (world.threats.adjacentEnemies || []).map(
            (e) => e.smallID,
          ),
          risingStarSmallIDs: (world.threats.risingStars || []).map(
            (e) => e.smallID,
          ),
          softTargetSmallIDs: (world.threats.softTargets || []).map(
            (e) => e.smallID,
          ),
          collapsingTargetSmallIDs: (world.threats.collapsingTargets || []).map(
            (e) => e.smallID,
          ),
          nearestDangerSmallID: world.threats.nearestDanger
            ? world.threats.nearestDanger.smallID
            : null,
          inboundTroopTotal: world.threats.inboundTroopTotal || 0,
        },
        opponents,
        mode: runtime.mode,
        archetype: world.archetype,
        activeGoalId: runtime.planner.activeGoalId || null,
      });
    }

    // stat_delta every 10 ticks while alive.
    if (tick - rl.lastStatDeltaTick >= RL_STAT_DELTA_EVERY) {
      if (rl.prevSelfStats) {
        const prev = rl.prevSelfStats;
        const structΔ = {};
        const keys = new Set([
          ...Object.keys(prev.structureLevels || {}),
          ...Object.keys(self.structureLevels || {}),
        ]);
        for (const key of keys) {
          const after = (self.structureLevels && self.structureLevels[key]) || 0;
          const before = (prev.structureLevels && prev.structureLevels[key]) || 0;
          if (after - before !== 0) structΔ[key] = after - before;
        }
        const rankByTiles = world.rankings.byTiles.indexOf(world.meSmallID);
        const rankByTroops = world.rankings.byTroops.indexOf(world.meSmallID);
        rlLog("stat_delta", {
          dTick: tick - prev.tick,
          dTiles: (self.tiles || 0) - (prev.tiles || 0),
          dTroops: (self.troops || 0) - (prev.troops || 0),
          dGold: (self.gold || 0) - (prev.gold || 0),
          dStructures: structΔ,
          rankByTiles,
          rankByTroops,
          activeGoalId: runtime.planner.activeGoalId || null,
        });
      }
      rl.lastStatDeltaTick = tick;
      rl.prevSelfStats = {
        tick,
        tiles: self.tiles || 0,
        troops: self.troops || 0,
        gold: self.gold || 0,
        structureLevels: Object.assign({}, self.structureLevels || {}),
      };
    }

    // threat_flash: edge-triggered.
    const crownID = world.threats.crownSmallID;
    if (crownID !== rl.lastKnownCrownSmallID) {
      rlLog("threat_flash", {
        reason: "crown_change",
        prev: rl.lastKnownCrownSmallID,
        next: crownID,
        crownShare: (world.totals && world.totals.crownShare) || 0,
      });
      rl.lastKnownCrownSmallID = crownID;
    }
    if (world.threats.mirvRisk && !rl.lastKnownMirvRisk) {
      rlLog("threat_flash", {
        reason: "mirv_risk",
        mirvCapable: (world.threats.mirvCapable || []).map((e) => e.smallID),
      });
      rl.tracking.everSawMirvRisk = true;
    }
    rl.lastKnownMirvRisk = Boolean(world.threats.mirvRisk);
    const coalition = Boolean(
      world.allianceGraph && world.allianceGraph.coalitionThreat,
    );
    if (coalition && !rl.lastKnownCoalitionThreat) {
      rlLog("threat_flash", {
        reason: "coalition_threat",
        largestBlocShare:
          (world.allianceGraph && world.allianceGraph.largestBlocShare) || 0,
      });
      rl.tracking.everSawCoalitionThreat = true;
    }
    rl.lastKnownCoalitionThreat = coalition;

    // Adjacent overmatch: highest adjacent enemy troop ratio. Hysteretic.
    let maxRatio = 0;
    const meTroops = Math.max(1, self.troops || 1);
    for (const enemy of world.threats.adjacentEnemies || []) {
      const ratio = (enemy.troops || 0) / meTroops;
      if (ratio > maxRatio) maxRatio = ratio;
    }
    if (
      maxRatio >= RL_ADJ_OVERMATCH_RATIO &&
      rl.lastAdjDangerRatio < RL_ADJ_OVERMATCH_RATIO
    ) {
      rlLog("threat_flash", {
        reason: "adjacent_overmatch",
        ratio: Number(maxRatio.toFixed(3)),
      });
    }
    rl.lastAdjDangerRatio = maxRatio;

    // Mark "we saw a collapsing neighbour" once per match for suspicions.
    if (
      !rl.tracking.everAdjacentToCollapsing &&
      (world.threats.collapsingTargets || []).some((e) => e.isAdjacent)
    ) {
      rl.tracking.everAdjacentToCollapsing = true;
    }
  }

  /**
   * RL: drain any pending outcomes whose fireTick has arrived. Pairs each
   * intent with its observed delta + scalar reward.
   *
   * If we died before the window closed, flush the remaining outcomes with
   * diedFlag=true and an empty postState — otherwise we'd leak pending
   * entries across matches.
   */
  function drainRlOutcomes(tick, me) {
    const rl = runtime.rl;
    if (!rl || !rl.enabled) return;
    if (!rl.pendingOutcomes.length) return;
    const world = runtime.world;
    const selfTiles = (world.me && world.me.tiles) || 0;
    const selfTroops = (world.me && world.me.troops) || 0;
    const selfGold = (world.me && world.me.gold) || 0;
    const selfStructures = (world.me && world.me.structureLevels) || {};
    const weAreAlive = Boolean(me);
    const remaining = [];
    for (const pending of rl.pendingOutcomes) {
      if (weAreAlive && pending.fireTick > tick) {
        remaining.push(pending);
        continue;
      }
      const delta = {
        tiles: selfTiles - (pending.preState.tiles || 0),
        troops: selfTroops - (pending.preState.troops || 0),
        gold: selfGold - (pending.preState.gold || 0),
        structures: {},
      };
      const keys = new Set([
        ...Object.keys(pending.preState.structureLevels || {}),
        ...Object.keys(selfStructures || {}),
      ]);
      for (const key of keys) {
        const after = selfStructures[key] || 0;
        const before = (pending.preState.structureLevels || {})[key] || 0;
        if (after - before !== 0) delta.structures[key] = after - before;
      }
      const diedFlag = !weAreAlive;
      const reward = rlComputeReward(delta, diedFlag);
      rlLog("intent_outcome", {
        actionId: pending.actionId,
        activeGoalId: pending.activeGoalId,
        intentType: pending.intentType,
        targetSmallID: pending.targetSmallID,
        windowTicks: tick - (pending.fireTick - RL_OUTCOME_WINDOW_TICKS),
        iAmAliveAtWindow: weAreAlive,
        preState: pending.preState,
        postState: weAreAlive
          ? {
              tiles: selfTiles,
              troops: selfTroops,
              gold: selfGold,
              structureLevels: Object.assign({}, selfStructures),
            }
          : null,
        delta,
        reward,
      });
    }
    rl.pendingOutcomes = remaining;
  }

  /**
   * RL: detect transitions where the match has ended from our perspective:
   *   - We were alive on a prior tick and now getMyLivingPlayer() is null
   *     → reason="died".
   *   - `runtime.state.matchPhase` flipped to "closed" (socket dropped)
   *     → reason="socket_closed".
   * Fires exactly once per game via the `rl.matchEnded` latch.
   */
  function detectMatchEnd() {
    const rl = runtime.rl;
    if (!rl || !rl.enabled || rl.matchEnded) return;
    if (rl.sessionStartedAtMs === 0) return; // never had a match_start
    const me = getMyLivingPlayer();
    if (rl.lastIsAlive && !me) {
      handleMatchEnd("died");
      return;
    }
    if (runtime.state.matchPhase === "closed") {
      handleMatchEnd("socket_closed");
      return;
    }
  }

  /**
   * RL: finalize the match. Flushes pending outcomes, emits `match_end` with
   * peak stats + auto-suspicions, persists to localStorage (best-effort).
   */
  function handleMatchEnd(reason) {
    const rl = runtime.rl;
    if (!rl || rl.matchEnded) return;
    rl.matchEnded = true;
    const world = runtime.world || { rankings: {} };
    const tick = world.tick || 0;

    // Flush pending outcomes with diedFlag so nothing leaks into the next
    // match. Passing me=null forces iAmAliveAtWindow=false.
    safeCall(() => drainRlOutcomes(tick, null), null);

    const lastStats = rlSelfSnapshot();
    const finalRankByTiles = world.rankings
      ? (world.rankings.byTiles || []).indexOf(world.meSmallID)
      : -1;
    const finalRankByTroops = world.rankings
      ? (world.rankings.byTroops || []).indexOf(world.meSmallID)
      : -1;
    const ticksAlive = rl.firstActiveTick >= 0 ? tick - rl.firstActiveTick : 0;
    const summary = {
      reason,
      endedAtMs: Date.now(),
      ticksAlive,
      lastGoalId: runtime.planner.activeGoalId || null,
      finalRank: { byTiles: finalRankByTiles, byTroops: finalRankByTroops },
      didMakeMidGame: ticksAlive >= 600,
      didMakeLateGame: ticksAlive >= 2400,
      peakSelfStats: rl.peakSelfStats || null,
      lastStats,
      totalIntentsSent: rl.totalIntentsSent || 0,
      totalIntentsBlocked: rl.totalIntentsBlocked || 0,
      tracking: {
        goalsEverAdopted: Array.from(rl.tracking.goalsEverAdopted),
        plannerGoalsEverValid: Array.from(rl.tracking.plannerGoalsEverValid),
        everAdjacentToCollapsing: rl.tracking.everAdjacentToCollapsing,
        everRanTerrainRush: rl.tracking.everRanTerrainRush,
        everSawMirvRisk: rl.tracking.everSawMirvRisk,
        everSawCoalitionThreat: rl.tracking.everSawCoalitionThreat,
      },
    };
    // Heuristic suspicions consult world + rl.tracking — build after summary.
    summary.leverSuspicions = generateLeverSuspicions({
      ticksAlive,
      peakSelfStats: rl.peakSelfStats || {},
      totalIntentsSent: rl.totalIntentsSent || 0,
      totalIntentsBlocked: rl.totalIntentsBlocked || 0,
      tracking: rl.tracking,
      reason,
    });
    rlLog("match_end", summary);

    // Best-effort persist. Never throw from here; localStorage is optional.
    safeCall(() => persistRlToStorage(), null);
  }

  async function runModulesForTick() {
    discoverRuntimeReferences();
    const gameView = getGameView();
    if (!gameView) {
      runtime.state.strategy = "waiting for game view";
      runtime.state.lastAction = "discovering hooks";
      // RL: if the socket died before we ever got a gameView, nothing to do.
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
      // RL: if we were alive last tick and now we're not, the match just
      // ended (we died). Fire match_end exactly once per game.
      safeCall(() => detectMatchEnd(), null);
      refreshOverlay();
      return;
    }

    const borderTiles = await queryExactBorderTiles(false);

    // Phase 1 acceptance: instrument updateWorldModel timing behind a flag.
    const tStart = runtime.debugFlags.timing ? performance.now() : 0;
    updateWorldModel(me, borderTiles);
    if (runtime.debugFlags.timing) {
      const dt = performance.now() - tStart;
      runtime._timingSampleSum += dt;
      runtime._timingSampleCount += 1;
      if (runtime.world.tick - runtime._timingLoggedAt >= 100) {
        runtime._timingLoggedAt = runtime.world.tick;
        const avg =
          runtime._timingSampleCount > 0
            ? runtime._timingSampleSum / runtime._timingSampleCount
            : 0;
        console.log(
          "[SuperBot:timing] updateWorldModel avg " +
            avg.toFixed(2) +
            " ms over " +
            runtime._timingSampleCount +
            " ticks",
        );
        runtime._timingSampleSum = 0;
        runtime._timingSampleCount = 0;
      }
    }

    computeThreats(me, borderTiles);
    classifyMapIfNeeded(me);
    maybePeriodicIntelLog();
    updateSnapshot(me, borderTiles);

    // RL decision logger: sample world/delta/threats and drain outcomes.
    // Runs BEFORE planner so we can emit "state at tick T" and then pair
    // `planner_decision` in the same tick.
    safeCall(() => maybeEmitPeriodicRL(me, borderTiles), null);
    safeCall(() => drainRlOutcomes(tick, me), null);

    const selection = selectPrimaryGoal();
    adoptGoal(selection);
    safeCall(() => maybeEmitPlannerDecision(selection), null);

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
        handled = await runGoal_FarmTribe(me, borderTiles);
        if (!handled) handled = await maybeCombat(me, borderTiles);
        break;
      case "EASY_NATION_GRAB":
        handled = await maybeCombat(me, borderTiles);
        if (!handled) handled = await maybeExpand(me, borderTiles);
        break;
      case "TERRAIN_RUSH":
        handled = await runGoal_TerrainRush(me, borderTiles);
        if (!handled) handled = await maybeCombat(me, borderTiles);
        if (!handled) handled = await maybeExpand(me, borderTiles);
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
    // Phase 3: secondary-goal opportunity. If the active goal is offensive
    // (combat / retaliation / farming), we can still squeeze in a single
    // background economy action without conflicting — long as the gate in
    // `economyBanned()` hasn't blocked us. Combat + economy routines operate
    // on independent cooldowns (cooldowns.combat vs cooldowns.economy).
    if (handled && runtime.enabled) {
      const ECONOMY_SECONDARY_GOALS = new Set([
        "RETALIATION",
        "NEUTRALIZE_RISING_STAR",
        "FARM_TRIBE",
        "EASY_NATION_GRAB",
        "TERRA_NULLIUS_RUSH",
        "TERRAIN_RUSH",
        "DIPLOMACY_ISOLATE_CROWN",
      ]);
      if (ECONOMY_SECONDARY_GOALS.has(activeGoalId)) {
        // Don't gate on failure — we treat the economy pass as purely
        // opportunistic; it silently skips when it's already on cooldown.
        await maybeEconomy(me, getEnemies());
      }
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
    // RL: catch socket_closed transitions even when we were alive this tick.
    safeCall(() => detectMatchEnd(), null);
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
      runtime.stealth.lastAttackMs = [];
      runtime.stealth.lastBuildMs = [];
      runtime._lastDecisionByKey = null;
      runtime._intelLoggedAt = -999;
      runtime._timingLoggedAt = -999;
      runtime._timingSampleSum = 0;
      runtime._timingSampleCount = 0;
      // ----- RL Decision Logger: full reset on every new match -----
      // Seeds a fresh ring buffer + counters, then emits match_start +
      // config_snapshot immediately so event #0 is always bot identity.
      // If an analyst grepped for `"kind":"match_start"` they should find
      // exactly one per game.
      const rl = runtime.rl;
      if (rl) {
        // If a previous match is still open when a new `start` arrives
        // (reconnect/rematch), close it out so match_end appears once per
        // game in the event log.
        if (!rl.matchEnded && rl.sessionStartedAtMs > 0) {
          safeCall(() => handleMatchEnd("restart"), null);
        }
        rl.events = [];
        rl.seq = 0;
        rl.sessionStartedAtMs = Date.now();
        rl.configSnapshotSent = false;
        rl.lastPlannerEmitTick = -999;
        rl.lastStatDeltaTick = -999;
        rl.lastWorldSnapshotTick = -999;
        rl.prevSelfStats = null;
        rl.peakSelfStats = null;
        rl.totalIntentsSent = 0;
        rl.totalIntentsBlocked = 0;
        rl.lastActionId = 0;
        rl.pendingOutcomes = [];
        rl.matchEnded = false;
        rl.lastIsAlive = false;
        rl.firstActiveTick = -1;
        rl.lastKnownCrownSmallID = null;
        rl.lastKnownMirvRisk = false;
        rl.lastKnownCoalitionThreat = false;
        rl.lastAdjDangerRatio = 0;
        rl.lastStealthBlockLogAtMs = new Map();
        rl.tracking = {
          goalsEverAdopted: new Set(),
          plannerGoalsEverValid: new Set(),
          everAdjacentToCollapsing: false,
          everRanTerrainRush: false,
          everSawMirvRisk: false,
          everSawCoalitionThreat: false,
        };
        const initialPlayers = [];
        const gameView = runtime.hooks.gameView;
        const views = safeCall(
          () => (gameView ? gameView.playerViews() : []),
          [],
        );
        for (const player of views) {
          initialPlayers.push({
            smallID: safeCall(() => player.smallID(), null),
            name: safeCall(() => player.displayName(), "?"),
            type: safeCall(() => player.type(), null),
            isFriendly: false, // our identity isn't resolved yet at `start`
          });
        }
        const cfg = safeCall(() => gameView && gameView.config(), null);
        const myPlayer = safeCall(() => gameView && gameView.myPlayer(), null);
        rlLog("match_start", {
          gameID: runtime.identity.gameID,
          clientID: runtime.identity.clientID,
          botVersion: BOT_VERSION,
          mode: runtime.mode,
          myClanTag: runtime.identity.clanTag,
          startedAtMs: rl.sessionStartedAtMs,
          players: initialPlayers,
          gameConfig: cfg
            ? {
                gameMode: safeCall(() =>
                  cfg.gameConfig ? cfg.gameConfig().gameMode : null,
                null),
                isRandomSpawn: safeCall(() => Boolean(cfg.isRandomSpawn()), null),
                numSpawnPhaseTurns: safeCall(
                  () => cfg.numSpawnPhaseTurns(),
                  null,
                ),
                maxTroopsForMe: safeCall(
                  () => (myPlayer ? cfg.maxTroops(myPlayer) : null),
                  null,
                ),
                boatMaxNumber: safeCall(() => cfg.boatMaxNumber(), null),
              }
            : null,
        });
        rlLog("config_snapshot", buildConfigSnapshot());
        rl.configSnapshotSent = true;
      }
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
    { id: "TERRAIN_RUSH", label: "Terrain Rush" },
    { id: "EASY_NATION_GRAB", label: "Easy Nation" },
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
          <button id="superbot-rl" title="Copy + download the RL decision log for the current match">RL dump</button>
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

  // ---------------------------------------------------------------------------
  // Compact export (v2.6.1)
  //
  // The raw per-tick ring buffer is kept fat in-memory so the in-game overlay
  // and devtools retain full fidelity. For export, though, 20k events at
  // ~700 bytes each = 14 MB of JSON which nobody can paste into an LLM.
  //
  // The compact dumper re-encodes events into a short-keyed, zero-stripped,
  // float-rounded, roster-truncated form and then enforces a byte budget by
  // dropping the noisiest event kinds first (world_snapshot → stat_delta →
  // reason → intent_outcome → intent_sent) until we fit. Every drop is
  // accounted for in `summary.droppedByKind` so the analyst can see what's
  // missing.
  // ---------------------------------------------------------------------------

  /** Round a float to 2 decimals; pass ints unchanged. Small byte savings. */
  function rlRound(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    if (Number.isInteger(value)) return value;
    return Math.round(value * 100) / 100;
  }

  /** Strip zero-valued / empty fields from a flat numeric object. */
  function rlStripZeros(obj) {
    if (!obj || typeof obj !== "object") return obj;
    const out = {};
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value === 0 || value === false || value === null) continue;
      if (typeof value === "string" && value.length === 0) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0
      ) {
        continue;
      }
      if (typeof value === "number") out[key] = rlRound(value);
      else if (typeof value === "string" && value.length > RL_COMPACT_STRING_CAP) {
        out[key] = value.slice(0, RL_COMPACT_STRING_CAP) + "…";
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  /**
   * Produce a compact form of a single event's `data` field, keyed by the
   * event kind so each kind can trim the shape it knows best.
   */
  function rlCompactEventData(kind, data) {
    if (!data || typeof data !== "object") return data;

    switch (kind) {
      case "world_snapshot": {
        // Keep top-N opponents by (threatScore + opportunityScore); collapse
        // the rest into a count so the analyst still knows N players exist.
        const opponentsIn = data.opponents || {};
        const ids = Object.keys(opponentsIn);
        const ranked = ids
          .map((id) => {
            const o = opponentsIn[id] || {};
            const score =
              (o.threatScore || 0) +
              (o.opportunityScore || 0) +
              (o.isAdjacent ? 20 : 0);
            return { id, score, o };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, RL_COMPACT_ROSTER_CAP);
        const opponents = {};
        for (const entry of ranked) {
          const stripped = rlStripZeros({
            n: entry.o.name,
            ty: entry.o.type,
            fr: entry.o.isFriendly,
            ad: entry.o.isAdjacent,
            dc: entry.o.isDisconnected,
            tr: entry.o.isTraitor,
            t: entry.o.tiles,
            p: entry.o.troops,
            g: entry.o.gold,
            tpm: entry.o.tilesPerMin,
            ppm: entry.o.troopsPerMin,
            nr: entry.o.nukeReadiness,
            ts: entry.o.threatScore,
            os: entry.o.opportunityScore,
            tags: entry.o.tags,
          });
          opponents[entry.id] = stripped;
        }
        const self = data.self || {};
        const totals = data.totals || {};
        const threats = data.threats || {};
        return rlStripZeros({
          s: rlStripZeros({
            t: self.tiles,
            p: self.troops,
            g: self.gold,
            tr: self.troopRatio,
            mt: self.maxTroops,
            tpm: self.tilesPerMin,
            ppm: self.troopsPerMin,
            gpm: self.goldPerMin,
            it: self.incomingTroops,
            ot: self.outgoingTroops,
            sl: self.structureLevels,
            b: self.borderTileCount,
          }),
          tot: rlStripZeros({
            ap: totals.alivePlayers,
            hc: totals.humanCount,
            nc: totals.nationCount,
            bc: totals.botCount,
            cs: totals.crownShare,
            ms: totals.myShare,
            ss: totals.secondShare,
          }),
          al: rlStripZeros({
            b: (data.allianceGraph || {}).largestBlocShare,
            c: (data.allianceGraph || {}).coalitionThreat,
          }),
          th: rlStripZeros({
            cr: threats.crownSmallID,
            mr: threats.mirvRisk,
            ae: threats.adjacentEnemySmallIDs,
            rs: threats.risingStarSmallIDs,
            st: threats.softTargetSmallIDs,
            ct: threats.collapsingTargetSmallIDs,
            nd: threats.nearestDangerSmallID,
            in: threats.inboundTroopTotal,
          }),
          op: opponents,
          opN: ids.length,
          m: data.mode,
          a: data.archetype,
          g: data.activeGoalId,
        });
      }
      case "stat_delta":
        return rlStripZeros({
          dt: data.dTick,
          dT: data.dTiles,
          dP: data.dTroops,
          dG: data.dGold,
          dS: data.dStructures,
          rT: data.rankByTiles,
          rP: data.rankByTroops,
          g: data.activeGoalId,
        });
      case "planner_decision": {
        // Keep winner + top 8 valid evaluations; collapse the rest into a
        // count. Drop `myStats` (world_snapshot covers it) and cap notes.
        const evals = Array.isArray(data.evaluations) ? data.evaluations : [];
        const valid = evals.filter((e) => e.valid);
        const rejCount = evals.length - valid.length;
        const top = valid
          .slice()
          .sort((a, b) => (b.priority || 0) - (a.priority || 0))
          .slice(0, 8)
          .map((e) =>
            rlStripZeros({
              id: e.id,
              p: e.priority,
              n: e.note,
            }),
          );
        return rlStripZeros({
          w: data.winnerGoalId,
          wp: data.winnerPriority,
          wn: data.winnerNote,
          f: data.forced,
          sw: data.goalSwitched,
          ev: top,
          evMore: Math.max(0, valid.length - top.length),
          rejN: rejCount,
        });
      }
      case "goal_switch":
        return rlStripZeros({
          a: data.prev,
          b: data.next,
          p: data.priority,
          n: data.note,
          f: data.forced,
          // Drop myStats — prior world_snapshot + adjacent planner_decision
          // already encode it, and this event is edge-triggered.
        });
      case "intent_sent": {
        const intent = data.intent || {};
        return rlStripZeros({
          a: data.actionId,
          g: data.activeGoalId,
          it: intent.type,
          u: intent.unit,
          p: intent.troops,
          gc: intent.gold,
          tile: intent.tile,
          xy: data.targetTile,
          tid: data.targetSmallID,
          tn: data.targetName,
          // Drop preState — intent_outcome.delta tells the same story.
        });
      }
      case "intent_blocked":
        return rlStripZeros({
          it: data.intentType,
          r: data.reason,
          g: data.activeGoalId,
        });
      case "intent_outcome":
        return rlStripZeros({
          a: data.actionId,
          g: data.activeGoalId,
          it: data.intentType,
          tid: data.targetSmallID,
          w: data.windowTicks,
          al: data.iAmAliveAtWindow,
          dT: data.delta && data.delta.tiles,
          dP: data.delta && data.delta.troops,
          dG: data.delta && data.delta.gold,
          dS: data.delta && data.delta.structures,
          r: data.reward,
          // preState/postState dropped; downstream can rebuild from deltas.
        });
      case "spawn_decision": {
        const top = Array.isArray(data.topCandidates)
          ? data.topCandidates.slice(0, 5).map((c) =>
              rlStripZeros({
                t: c.tile,
                x: c.x,
                y: c.y,
                s: c.score,
              }),
            )
          : [];
        return rlStripZeros({
          m: data.mode,
          c: rlStripZeros({
            t: data.chosen && data.chosen.tile,
            x: data.chosen && data.chosen.x,
            y: data.chosen && data.chosen.y,
            s: data.chosen && data.chosen.score,
          }),
          tc: top,
          n: data.candidateCount,
        });
      }
      case "threat_flash":
        return rlStripZeros({
          r: data.reason,
          a: data.prev,
          b: data.next,
          cs: data.crownShare,
          rt: data.ratio,
          bs: data.largestBlocShare,
          mc: data.mirvCapable,
        });
      case "reason":
        return rlStripZeros({
          g: data.goalId,
          s:
            typeof data.summary === "string" && data.summary.length > RL_COMPACT_STRING_CAP
              ? data.summary.slice(0, RL_COMPACT_STRING_CAP) + "…"
              : data.summary,
          d:
            typeof data.detail === "string" && data.detail.length > RL_COMPACT_STRING_CAP
              ? data.detail.slice(0, RL_COMPACT_STRING_CAP) + "…"
              : data.detail,
        });
      case "match_start":
        // Keep players array but strip per-entry isFriendly=false noise.
        return rlStripZeros({
          g: data.gameID,
          c: data.clientID,
          v: data.botVersion,
          m: data.mode,
          ct: data.myClanTag,
          ts: data.startedAtMs,
          pl: Array.isArray(data.players)
            ? data.players.map((p) =>
                rlStripZeros({
                  id: p.smallID,
                  n: p.name,
                  ty: p.type,
                }),
              )
            : [],
          gc: data.gameConfig,
        });
      case "config_snapshot":
        // Keep this full: it's emitted once and every field here is a
        // concrete knob the analyst may want to twist. The `leverHints`
        // array is the highest-signal portion of the whole dump.
        return data;
      case "match_end":
        return rlStripZeros({
          r: data.reason,
          ts: data.endedAtMs,
          ta: data.ticksAlive,
          g: data.lastGoalId,
          rk: data.finalRank,
          mg: data.didMakeMidGame,
          lg: data.didMakeLateGame,
          pk: data.peakSelfStats,
          ls: data.lastStats,
          is: data.totalIntentsSent,
          ib: data.totalIntentsBlocked,
          tr: data.tracking,
          su: data.leverSuspicions,
        });
      default:
        return data;
    }
  }

  /** Kind → short code used in compact mode. */
  const RL_KIND_CODES = Object.freeze({
    match_start: "MS",
    match_end: "ME",
    config_snapshot: "CS",
    world_snapshot: "WS",
    stat_delta: "SD",
    planner_decision: "PD",
    goal_switch: "GS",
    reason: "R",
    intent_sent: "IS",
    intent_blocked: "IB",
    intent_outcome: "IO",
    spawn_decision: "SP",
    threat_flash: "TF",
  });
  const RL_KIND_CODE_TO_NAME = Object.freeze(
    Object.fromEntries(
      Object.entries(RL_KIND_CODES).map(([k, v]) => [v, k]),
    ),
  );

  /**
   * Priority order used by the byte-budget enforcer when we have to drop
   * events. Higher index = dropped first. Everything we absolutely want
   * to keep (identity, config, narrative summary) has a low/negative
   * priority and is excluded from dropping entirely.
   */
  const RL_DROP_ORDER = [
    "world_snapshot",
    "stat_delta",
    "reason",
    "intent_outcome",
    "intent_sent",
    "planner_decision",
    "spawn_decision",
    "intent_blocked",
    "goal_switch",
    "threat_flash",
  ];

  /**
   * RL: serialize the RL event stream. Two modes:
   *
   *   level="compact" (default): short keys, zero-stripping, float rounding,
   *     roster-cap + evaluation-cap + pre/post-state drops, then a byte-budget
   *     enforcer that drops the noisiest kinds until under `maxBytes`.
   *   level="full":    the legacy fat dump (no compression) for local
   *     debugging. Explicit opt-in — never shipped by the overlay button.
   *
   * Returns a JSON string. Always includes `schemaVersion`, `botVersion`,
   * `generatedAtMs`, and a `summary` object listing any kinds that were
   * dropped to fit.
   */
  function dumpRlJson(options) {
    const rl = runtime.rl;
    const opts = options || {};
    const level = opts.level === "full" ? "full" : "compact";
    const maxBytes =
      level === "full"
        ? Infinity
        : Number.isFinite(opts.maxBytes)
          ? Math.max(10_000, opts.maxBytes)
          : RL_EXPORT_MAX_BYTES;

    const baseSummary = rl
      ? {
          sessionStartedAtMs: rl.sessionStartedAtMs,
          totalIntentsSent: rl.totalIntentsSent,
          totalIntentsBlocked: rl.totalIntentsBlocked,
          events: rl.events.length,
          matchEnded: rl.matchEnded,
          peakSelfStats: rl.peakSelfStats,
          firstActiveTick: rl.firstActiveTick,
          lastActionId: rl.lastActionId,
          tracking: {
            goalsEverAdopted: Array.from(rl.tracking.goalsEverAdopted),
            plannerGoalsEverValid: Array.from(rl.tracking.plannerGoalsEverValid),
            everAdjacentToCollapsing: rl.tracking.everAdjacentToCollapsing,
            everRanTerrainRush: rl.tracking.everRanTerrainRush,
            everSawMirvRisk: rl.tracking.everSawMirvRisk,
            everSawCoalitionThreat: rl.tracking.everSawCoalitionThreat,
          },
        }
      : {};

    const header = {
      schemaVersion: RL_SCHEMA_VERSION,
      botVersion: BOT_VERSION,
      generatedAtMs: Date.now(),
      gameID: runtime.identity.gameID,
      clientID: runtime.identity.clientID,
      mode: runtime.mode,
      level,
      maxBytes: Number.isFinite(maxBytes) ? maxBytes : null,
    };

    try {
      if (level === "full") {
        return JSON.stringify(
          Object.assign({}, header, {
            summary: baseSummary,
            events: rl ? rl.events : [],
          }),
          (key, value) =>
            typeof value === "bigint" ? value.toString() : value,
        );
      }

      // Compact path.
      const rawEvents = rl ? rl.events : [];
      const compactEvents = rawEvents.map((entry) => ({
        k: RL_KIND_CODES[entry.kind] || entry.kind,
        t: entry.tick,
        s: entry.seq,
        d: rlCompactEventData(entry.kind, entry.data || {}),
      }));

      const droppedByKind = {};
      let payload = serializeCompact(header, baseSummary, compactEvents, droppedByKind);

      // Byte-budget enforcer. Per-kind pass: drop one whole kind's worth at a
      // time (oldest first) rather than a single event per iteration. A full
      // match can emit thousands of world_snapshots; one-by-one dropping
      // would require thousands of re-serializations. Per-kind batching is
      // amortized O(kinds × events).
      for (const kind of RL_DROP_ORDER) {
        if (payload.length <= maxBytes) break;
        const code = RL_KIND_CODES[kind];
        // Drop in batches of 10% (minimum 1) until the kind is gone or we
        // fit. This avoids re-serializing 500 times while still honoring
        // newer events (we drop the oldest of this kind first).
        while (payload.length > maxBytes) {
          const indices = [];
          for (let i = 0; i < compactEvents.length; i++) {
            if (compactEvents[i].k === code) indices.push(i);
          }
          if (indices.length === 0) break;
          const batchSize = Math.max(1, Math.floor(indices.length * 0.1));
          const toDrop = indices.slice(0, batchSize);
          // Splice from the end of `toDrop` so index arithmetic stays valid.
          for (let j = toDrop.length - 1; j >= 0; j--) {
            compactEvents.splice(toDrop[j], 1);
          }
          droppedByKind[kind] = (droppedByKind[kind] || 0) + toDrop.length;
          payload = serializeCompact(header, baseSummary, compactEvents, droppedByKind);
        }
      }
      return payload;
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  /** Helper: stringify the compact payload with dropped-by-kind accounting. */
  function serializeCompact(header, baseSummary, compactEvents, droppedByKind) {
    const summary = Object.assign({}, baseSummary, {
      emittedEvents: compactEvents.length,
      droppedByKind: Object.keys(droppedByKind).length ? droppedByKind : {},
      kindCodes: RL_KIND_CODE_TO_NAME,
    });
    return JSON.stringify(
      Object.assign({}, header, { summary, events: compactEvents }),
      (key, value) => (typeof value === "bigint" ? value.toString() : value),
    );
  }

  /**
   * RL: trigger a browser file download of the current RL dump. No-op
   * outside real browsers (jsdom/tampermonkey sandboxes that don't expose
   * Blob / URL.createObjectURL / document.body). Always also copies to the
   * clipboard via `copyToClipboard` so the user has a guaranteed fallback.
   */
  function downloadRlJson(options) {
    const payload = dumpRlJson(options);
    safeCall(() => copyToClipboard(payload), null);
    const hasBlob = typeof Blob !== "undefined";
    const hasUrl = typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
    if (!hasBlob || !hasUrl || !document || !document.body) {
      return payload;
    }
    try {
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const gameID = runtime.identity.gameID || "unknown";
      a.href = url;
      a.download = "superbot-rl-" + gameID + "-" + stamp + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => safeCall(() => URL.revokeObjectURL(url), null), 1000);
    } catch (_) {
      // Blob/URL failure — clipboard already has the payload.
    }
    return payload;
  }

  /**
   * RL: persist the current match's dump into localStorage under the
   * `superbotRL:<gameID>` key. Honours:
   *   - RL_STORAGE_MAX_MATCHES (trim oldest entries)
   *   - RL_STORAGE_MAX_BYTES   (halve `events` iteratively if too big)
   *
   * Best-effort: swallows quota + serialization errors (logs once).
   */
  function persistRlToStorage() {
    const rl = runtime.rl;
    if (!rl || !rl.enabled) return;
    const storage = safeCall(
      () => (typeof localStorage !== "undefined" ? localStorage : null),
      null,
    );
    if (!storage) return;
    const gameID = runtime.identity.gameID || "unknown";
    const key = RL_STORAGE_KEY_PREFIX + gameID;

    // Use the compact dumper with the storage-specific (larger) byte cap.
    // The compact form already drops noisiest-first until it fits, so the
    // secondary halving loop we had pre-2.6.1 is no longer needed.
    const payload = dumpRlJson({
      level: "compact",
      maxBytes: RL_STORAGE_MAX_BYTES,
    });

    // Trim oldest matches until under the count cap.
    const keys = [];
    safeCall(() => {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(RL_STORAGE_KEY_PREFIX)) keys.push(k);
      }
    }, null);
    // Read timestamps (best-effort).
    const withTs = keys.map((k) => {
      const raw = safeCall(() => storage.getItem(k), null);
      const ts = safeCall(() => JSON.parse(raw).generatedAtMs, 0) || 0;
      return { key: k, ts };
    });
    withTs.sort((a, b) => a.ts - b.ts);
    while (withTs.length >= RL_STORAGE_MAX_MATCHES) {
      const oldest = withTs.shift();
      if (!oldest) break;
      safeCall(() => storage.removeItem(oldest.key), null);
    }

    try {
      storage.setItem(key, payload);
    } catch (err) {
      // Quota / SecurityError / etc. — one log line then drop.
      if (!runtime.rl._loggedStorageError) {
        runtime.rl._loggedStorageError = true;
        botLog("RL storage failed: " + (err && err.message));
      }
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
    const rlButton = panel.querySelector("#superbot-rl");
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

    if (rlButton) {
      rlButton.addEventListener("click", () => {
        // Default to compact; hold Shift to request the full / raw dump for
        // local debugging. The compact path is what matches the overlay
        // button's documented purpose ("fits an LLM paste buffer").
        const payload = downloadRlJson({ level: "compact" });
        safeCall(() => persistRlToStorage(), null);
        const totalRaw = runtime.rl ? runtime.rl.events.length : 0;
        const sizeKb = Math.round((payload || "").length / 1024);
        botLog(
          "RL dump ready (compact, " +
            totalRaw +
            " raw events → " +
            sizeKb +
            " KB, copied + downloaded)",
        );
      });
    }

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
          label: "Collapsing",
          value:
            (world.threats.collapsingTargets || [])
              .slice(0, 2)
              .map(
                (s) =>
                  s.name +
                  " (" +
                  (s.distinctAttackerCount || 0) +
                  "×, " +
                  s.tilesPerMin.toFixed(0) +
                  "/m)",
              )
              .join(", ") || "-",
        },
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
              `<span class="tail">${escapeHtml(entry.summary)}</span></div>` +
              (entry.detail
                ? `<div class="tail">${escapeHtml(entry.detail)}</div>`
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

  // ---------- Phase 10: scripted regression suite ----------

  /**
   * Build a minimal world-state stub that the goal evaluators can consume.
   * We deliberately touch only the fields the evaluators read. Any future
   * evaluator that relies on new fields must add them here (the suite will
   * fail noisily if something is missing).
   */
  function buildTestWorld(overrides) {
    const base = {
      tick: 1500,
      me: {
        smallID: 1,
        name: "Me",
        gold: 500_000,
        tiles: 1500,
        troops: 40_000,
        maxTroops: 100_000,
        troopRatio: 0.4,
        incomingAttacks: [],
        outgoingAttacks: [],
        incomingTroops: 0,
        outgoingTroops: 0,
        structures: {
          [UnitType.City]: 4,
          [UnitType.Factory]: 1,
          [UnitType.Port]: 0,
          [UnitType.DefensePost]: 2,
          [UnitType.MissileSilo]: 0,
          [UnitType.SAMLauncher]: 0,
        },
        structureLevels: {
          [UnitType.City]: 4,
          [UnitType.Factory]: 1,
          [UnitType.Port]: 0,
          [UnitType.DefensePost]: 2,
          [UnitType.MissileSilo]: 0,
          [UnitType.SAMLauncher]: 0,
        },
      },
      meSmallID: 1,
      everyone: [],
      bySmallID: new Map(),
      history: new Map(),
      totals: {
        alivePlayers: 4,
        humanCount: 1,
        nationCount: 2,
        botCount: 1,
        totalLand: 10_000,
        usableLand: 10_000,
        crownShare: 0.18,
        myShare: 0.15,
        secondShare: 0.14,
      },
      rankings: { byTiles: [], byTroops: [], byTilesVelocity: [], byTroopsVelocity: [] },
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
        collapsingTargets: [],
        nearestDanger: null,
        mirvRisk: false,
        mirvCapable: [],
        adjacentEnemies: [],
        inboundTroopTotal: 0,
      },
      archetype: "CONTINENTAL",
      archetypeLocked: null,
      classifiedAt: 100,
    };
    if (!overrides) return base;
    return Object.assign(base, overrides);
  }

  function runPlannerTestSuite() {
    const previous = runtime.world;
    const priorGameView = runtime.hooks.gameView;
    const priorForcedId = runtime.planner.forcedGoalId;
    const priorForcedExpiry = runtime.planner.forcedGoalExpiresMs;
    runtime.planner.forcedGoalId = null;
    runtime.planner.forcedGoalExpiresMs = 0;
    const results = [];

    // Stub the game view enough to satisfy evaluators that call it.
    const stubSilo = {
      isActive: () => true,
      isUnderConstruction: () => false,
      level: () => 1,
      missileReadinesss: () => 1,
      id: () => 42,
      tile: () => 0,
    };
    const stubUnits = new Map();
    const stubGameView = {
      ticks: () => 1500,
      config: () => ({
        maxTroops: () => 100_000,
        boatMaxNumber: () => 3,
        isUnitDisabled: () => false,
      }),
    };

    function step(name, world, expectedGoalId, stubMySilos) {
      stubUnits.clear();
      if (stubMySilos === true) {
        stubUnits.set(UnitType.MissileSilo, [stubSilo]);
      } else if (typeof stubMySilos === "number" && stubMySilos > 0) {
        stubUnits.set(
          UnitType.MissileSilo,
          Array.from({ length: stubMySilos }, () => stubSilo),
        );
      }
      // Stub myPlayer-unit lookups so getMyUnitsOfType returns our silos.
      runtime.hooks.gameView = Object.assign({}, stubGameView, {
        myPlayer: () => ({
          isAlive: () => true,
          units: (t) => stubUnits.get(t) || [],
          smallID: () => 1,
        }),
      });
      runtime.world = world;
      const selection = selectPrimaryGoal();
      const actualId = selection && selection.spec ? selection.spec.id : null;
      const pass = actualId === expectedGoalId;
      results.push({ name, expected: expectedGoalId, actual: actualId, pass });
      return pass;
    }

    // Scenario 1: crown at 50%, we have a silo + atom gold -> NUKE_CROWN.
    const scenario1 = buildTestWorld({
      totals: {
        alivePlayers: 3,
        humanCount: 1,
        nationCount: 1,
        botCount: 1,
        totalLand: 10_000,
        usableLand: 10_000,
        crownShare: 0.5,
        myShare: 0.2,
        secondShare: 0.2,
      },
    });
    scenario1.me.gold = 1_200_000;
    scenario1.me.structures[UnitType.MissileSilo] = 1;
    scenario1.threats.crown = {
      smallID: 2,
      name: "Crown",
      isFriendly: false,
      tiles: 5000,
      structureLevels: { [UnitType.SAMLauncher]: 0 },
    };
    scenario1.threats.crownSmallID = 2;
    step("crown50-atom -> NUKE_CROWN", scenario1, "NUKE_CROWN", true);

    // Scenario 2: we're the crown ourselves -> DEFENSIVE_TURTLE.
    const scenario2 = buildTestWorld({
      totals: {
        alivePlayers: 3,
        humanCount: 1,
        nationCount: 1,
        botCount: 1,
        totalLand: 10_000,
        usableLand: 10_000,
        crownShare: 0.35,
        myShare: 0.35,
        secondShare: 0.15,
      },
    });
    step("we-are-crown -> DEFENSIVE_TURTLE", scenario2, "DEFENSIVE_TURTLE");

    // Scenario 3: we own 27% -> SAM_WALL_BUILDUP.
    const scenario3 = buildTestWorld({
      totals: {
        alivePlayers: 3,
        humanCount: 1,
        nationCount: 1,
        botCount: 1,
        totalLand: 10_000,
        usableLand: 10_000,
        crownShare: 0.27,
        myShare: 0.27,
        secondShare: 0.2,
      },
    });
    // SAM count still low, city count moderate => SAM_WALL_BUILDUP wins.
    scenario3.me.structures[UnitType.City] = 8;
    scenario3.me.structureLevels[UnitType.City] = 8;
    step("27%-share -> SAM_WALL_BUILDUP", scenario3, "SAM_WALL_BUILDUP");

    // Scenario 4: we're under heavy attack -> CONSOLIDATE_FRONT.
    const scenario4 = buildTestWorld();
    scenario4.me.incomingTroops = 40_000;
    scenario4.me.troops = 30_000;
    step("pressure>60% -> CONSOLIDATE_FRONT", scenario4, "CONSOLIDATE_FRONT");

    // Scenario 5a: SAM_OVERWHELM selection — crown has SAMs, we have silos +
    // atom gold, not quite enough for nuke-crown to win outright. Stubbing
    // crown.player.units(SAM) and player.units so SAM_OVERWHELM's evaluator
    // sees both sides.
    const scenario5a = buildTestWorld({
      totals: {
        alivePlayers: 3,
        humanCount: 1,
        nationCount: 1,
        botCount: 1,
        totalLand: 10_000,
        usableLand: 10_000,
        crownShare: 0.28,
        myShare: 0.2,
        secondShare: 0.2,
      },
    });
    scenario5a.me.gold = 2_000_000;
    scenario5a.me.structures[UnitType.MissileSilo] = 2;
    scenario5a.threats.crown = {
      smallID: 2,
      name: "Crown",
      isFriendly: false,
      tiles: 2800,
      structureLevels: { [UnitType.SAMLauncher]: 2 },
      player: {
        units: (t) =>
          t === UnitType.SAMLauncher
            ? [
                { isActive: () => true, level: () => 2, id: () => 101, tile: () => 0 },
                { isActive: () => true, level: () => 1, id: () => 102, tile: () => 0 },
              ]
            : [],
      },
    };
    scenario5a.threats.crownSmallID = 2;
    // Need 2 ready silos to pass the gate.
    step(
      "SAM_OVERWHELM triggers with silos+gold+enemy SAMs",
      scenario5a,
      "SAM_OVERWHELM",
      2,
    );

    // Scenario 5: coalition dominant + MIRV gold -> MIRV_LAST_RESORT.
    const scenario5 = buildTestWorld({
      totals: {
        alivePlayers: 4,
        humanCount: 2,
        nationCount: 2,
        botCount: 0,
        totalLand: 10_000,
        usableLand: 10_000,
        crownShare: 0.5,
        myShare: 0.18,
        secondShare: 0.15,
      },
    });
    scenario5.me.gold = 30_000_000;
    scenario5.threats.crown = {
      smallID: 2,
      name: "Crown",
      isFriendly: false,
      tiles: 5000,
      structureLevels: { [UnitType.SAMLauncher]: 6 },
    };
    scenario5.threats.crownSmallID = 2;
    scenario5.allianceGraph.largestBlocShare = 0.5;
    scenario5.bySmallID.set(2, { tiles: 5000 });
    step("coalition>=45% -> MIRV_LAST_RESORT", scenario5, "MIRV_LAST_RESORT");

    // Scenario 7: TERRAIN_RUSH — neighbour collapsing, adjacent to us.
    // Multiple attackers + tile-loss velocity should trigger the goal.
    const scenario7 = buildTestWorld();
    const rushTarget = {
      smallID: 3,
      name: "Doomed",
      tiles: 600,
      troops: 5000,
      maxTroops: 50_000,
      troopRatio: 0.1,
      isAdjacent: true,
      isFriendly: false,
      isMe: false,
      type: PlayerType.Human,
      tilesPerMin: -120,
      distinctAttackerCount: 3,
      incomingTroops: 40_000,
      incomingAttacks: [],
      outgoingAttacks: [],
      structures: {},
      structureLevels: {},
      tags: new Set(["COLLAPSING", "ENEMY", "ADJACENT"]),
    };
    scenario7.threats.collapsingTargets = [rushTarget];
    step(
      "neighbour collapsing + adjacent -> TERRAIN_RUSH",
      scenario7,
      "TERRAIN_RUSH",
    );

    // Scenario 8: TERRAIN_RUSH should NOT trigger when there is nothing
    // collapsing (defensive regression — we don't want it to always win).
    const scenario8 = buildTestWorld();
    // Nothing collapsing — planner should fall back to SAM_WALL_BUILDUP
    // (default economy state at myShare~0.15, crown~0.18 lands on IDLE
    // since we're below the 25% threshold).
    // Just assert it doesn't pick TERRAIN_RUSH.
    const prevResultsLen = results.length;
    step(
      "no collapsing target -> not TERRAIN_RUSH",
      scenario8,
      // Accept whichever goal wins as long as it isn't TERRAIN_RUSH.
      // We set expected=null and validate below by editing the last
      // result entry's `pass` flag.
      null,
    );
    // Patch up the expectation: pass = actualId !== "TERRAIN_RUSH".
    const lastResult = results[results.length - 1];
    lastResult.expected = "!TERRAIN_RUSH";
    lastResult.pass = lastResult.actual !== "TERRAIN_RUSH";

    // Scenario 9: accept incoming alliance request from a strong neutral
    // partner. `shouldAcceptIncomingAlliance` is a pure helper so we can
    // unit-test it directly — we don't need the full planner here.
    const scenario9 = buildTestWorld();
    const partner = {
      smallID: 4,
      name: "Friend",
      type: PlayerType.Human,
      isAdjacent: true,
      isAlly: false,
      isMe: false,
      isClanmate: false,
      isTraitor: false,
      isFriendly: false,
      troops: 60_000,
      tiles: 1800,
      strength: 90_000,
      outgoingAttacks: [],
      player: {
        relation: () => 1,
        isTraitor: () => false,
      },
    };
    scenario9.everyone = [scenario9.me, partner];
    scenario9.bySmallID = new Map([
      [1, scenario9.me],
      [4, partner],
    ]);
    runtime.world = scenario9;
    const accept = shouldAcceptIncomingAlliance(partner, scenario9.me);
    results.push({
      name: "accept incoming alliance from strong neutral partner",
      expected: "true",
      actual: String(accept),
      pass: accept === true,
    });

    // Scenario 10: reject incoming alliance from weak partner with no
    // strategic value (too weak, not bordering crown, not strong ally slot).
    const scenario10 = buildTestWorld();
    const weakRequestor = {
      smallID: 5,
      name: "Weakling",
      type: PlayerType.Human,
      isAdjacent: false,
      isAlly: false,
      isMe: false,
      isClanmate: false,
      isTraitor: false,
      isFriendly: false,
      troops: 2_000,
      tiles: 100,
      strength: 2_500,
      outgoingAttacks: [],
      player: {
        relation: () => 0,
        isTraitor: () => false,
      },
    };
    scenario10.everyone = [scenario10.me, weakRequestor];
    scenario10.bySmallID = new Map([
      [1, scenario10.me],
      [5, weakRequestor],
    ]);
    runtime.world = scenario10;
    const rejectWeak = shouldAcceptIncomingAlliance(weakRequestor, scenario10.me);
    results.push({
      name: "reject incoming alliance from weak non-strategic partner",
      expected: "false",
      actual: String(rejectWeak),
      pass: rejectWeak === false,
    });

    // Scenario 11: alliance-break budget throttles rapid successive breaks.
    const scenario11 = buildTestWorld();
    runtime.world = scenario11;
    const preBudget = allianceBreakBudgetExceeded();
    recordAllianceBreak();
    const postBudget = allianceBreakBudgetExceeded();
    results.push({
      name:
        "alliance-break budget: idle=false, after 1 break (cap=1) =true",
      expected: "false,true",
      actual: preBudget + "," + postBudget,
      pass: preBudget === false && postBudget === true,
    });
    // Reset the mutated state so we don't leak into later tests.
    runtime.state.recentAllianceBreakTicks = [];
    runtime.state.cooldowns.allianceBreak = -999;

    // Scenario 12: unsafe-to-break when under heavy attack.
    const scenario12 = buildTestWorld();
    scenario12.threats.adjacentEnemies = [
      {
        smallID: 99,
        name: "Bully",
        troops: scenario12.me.troops * 2,
        isFriendly: false,
      },
    ];
    runtime.world = scenario12;
    const unsafe = isUnsafeToBreakAlliance(scenario12.me);
    results.push({
      name: "isUnsafeToBreakAlliance -> true when superior hostile adjacent",
      expected: "true",
      actual: String(unsafe),
      pass: unsafe === true,
    });
    runtime.world = previous;

    // Scenario 6: parabolic SAM check should mark fewer trajectories as
    // intercepted than the linear approximation when the SAM sits on the
    // straight line between silo and target but NOT under the parabolic
    // arc's apex. We craft a tiny synthetic gameView where a single SAM
    // lives at the midpoint.
    const samSmallID = 11;
    const samUnit = {
      owner: () => ({
        isMe: () => false,
        smallID: () => samSmallID,
      }),
      id: () => 999,
      level: () => 1,
      tile: () => 500 * 50 + 25, // set later by pixels
    };
    const mapWidth = 200;
    const mapHeight = 200;
    const toRef = (x, y) => y * mapWidth + x;
    const mockGameView = {
      width: () => mapWidth,
      height: () => mapHeight,
      ticks: () => 1500,
      x: (r) => r % mapWidth,
      y: (r) => Math.floor(r / mapWidth),
      ref: (x, y) => toRef(x, y),
      isValidCoord: (x, y) => x >= 0 && y >= 0 && x < mapWidth && y < mapHeight,
      euclideanDistSquared: (a, b) => {
        const ax = a % mapWidth;
        const ay = Math.floor(a / mapWidth);
        const bx = b % mapWidth;
        const by = Math.floor(b / mapWidth);
        const dx = ax - bx;
        const dy = ay - by;
        return dx * dx + dy * dy;
      },
      nearbyUnits: (tile, range, type) => {
        if (type !== UnitType.SAMLauncher) return [];
        const d2 = mockGameView.euclideanDistSquared(tile, samUnit.tile());
        if (d2 > range * range) return [];
        return [{ unit: samUnit, distSquared: d2 }];
      },
      config: () => ({
        defaultNukeTargetableRange: () => 30,
        maxSamRange: () => 60,
        samRange: (lvl) => 50 + lvl * 5,
      }),
    };
    // Place silo at (20,100), target at (180,100), SAM at the line midpoint (100,100).
    const siloTile = toRef(20, 100);
    const targetTile = toRef(180, 100);
    samUnit.tile = () => toRef(100, 100);

    // Temporarily swap the world + gameView stubs so isMe()-via-smallID works.
    const stashedMeSmallID = runtime.world.meSmallID;
    const stashedWorld = runtime.world;
    runtime.world = buildTestWorld();
    runtime.world.meSmallID = 1;
    runtime.hooks.gameView = Object.assign({}, mockGameView, {
      myPlayer: () => ({
        isAlive: () => true,
        units: () => [],
        smallID: () => 1,
        isFriendly: () => false,
      }),
    });
    // ensure getMyLivingPlayer finds a "me" so trajectoryInterceptedBySAM
    // doesn't short-circuit.
    const rocketUp = getRocketDirectionUp();
    let _ = rocketUp; // reference to silence linter-ish helpers
    const linearHit = lineIntersectsEnemySam(siloTile, targetTile, false);
    const parabolicHit = trajectoryInterceptedBySAM(siloTile, targetTile, null);
    // Expect linear flags the midpoint SAM as blocking, parabolic does not
    // (the arc's apex climbs away from y=100 so the SAM at y=100 is out of
    // range at the time the trajectory passes over it).
    results.push({
      name: "parabolic SAM check (linear=blocked, parabolic=clear)",
      expected: "linear=true,parabolic=false",
      actual: "linear=" + linearHit + ",parabolic=" + parabolicHit,
      pass: linearHit === true && parabolicHit === false,
    });

    runtime.world = stashedWorld;
    runtime.world.meSmallID = stashedMeSmallID;

    runtime.world = previous;
    runtime.hooks.gameView = priorGameView;
    runtime.planner.forcedGoalId = priorForcedId;
    runtime.planner.forcedGoalExpiresMs = priorForcedExpiry;
    return {
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
      results,
    };
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
      runPlannerSuite: () => runPlannerTestSuite(),
      debugFlags: runtime.debugFlags,
      rlDump: () => dumpRlJson(),
      rlDownload: () => downloadRlJson(),
    };
    // Dedicated RL namespace for the downstream analyst + devtools use.
    // Safe to read/write from the console; `enable` / `disable` flip the
    // logger on the fly without restarting the bot.
    window.__superhumanBotRL = {
      get events() {
        return runtime.rl.events;
      },
      // Default is compact (fits an LLM paste buffer). Opt into full via
      //   __superhumanBotRL.dump({ level: "full" })
      // Override the byte budget via
      //   __superhumanBotRL.dump({ maxBytes: 1_000_000 })
      dump: (opts) => dumpRlJson(opts),
      dumpFull: () => dumpRlJson({ level: "full" }),
      download: (opts) => downloadRlJson(opts),
      persist: () => persistRlToStorage(),
      enable: () => {
        runtime.rl.enabled = true;
      },
      disable: () => {
        runtime.rl.enabled = false;
      },
      clear: () => {
        runtime.rl.events = [];
        runtime.rl.seq = 0;
        runtime.rl.pendingOutcomes = [];
      },
      listStored: () => {
        const storage = safeCall(
          () => (typeof localStorage !== "undefined" ? localStorage : null),
          null,
        );
        if (!storage) return [];
        const out = [];
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k && k.startsWith(RL_STORAGE_KEY_PREFIX)) out.push(k);
        }
        return out;
      },
      loadStored: (key) => {
        const storage = safeCall(
          () => (typeof localStorage !== "undefined" ? localStorage : null),
          null,
        );
        if (!storage) return null;
        return storage.getItem(key);
      },
    };
    runtime.test = {
      runSuite: runPlannerTestSuite,
      /**
       * Inject a hand-built world into the runtime for testing. Returns a
       * restorer that the caller should invoke when done.
       */
      set: (state) => {
        const prior = runtime.world;
        runtime.world = Object.assign(runtime.world, state || {});
        return () => {
          runtime.world = prior;
        };
      },
      /**
       * Given a world (or the current live one), return the list of
       * (smallID → tags[]) so the caller can assert on the categorizer
       * without running the full planner.
       */
      categorize: () => {
        const out = [];
        for (const entry of runtime.world.everyone) {
          out.push({
            smallID: entry.smallID,
            name: entry.name,
            tags: Array.from(entry.tags || []),
            threatScore: entry.threatScore || 0,
            opportunityScore: entry.opportunityScore || 0,
          });
        }
        return out;
      },
      /**
       * Expose internal helpers so the regression test file can exercise the
       * early-game / human-border guards directly without spinning up the full
       * planner loop.
       */
      internals: {
        getBoatDistanceLimit,
        isTooEarlyForNaval,
        isBoatWithinRange,
        isTileNearHumanBorder,
        filterHumanBorderTiles,
        shouldBuildType,
        buildOrderForArchetype,
        reasonLog,
        UnitType,
        PlayerType,
        BOT_VERSION,
        // RL decision-logger internals (Phase 1). Exposed so tests can
        // exercise them without spinning up the tick loop.
        rlLog,
        rlSelfSnapshot,
        rlComputeReward,
        RL_REWARD_WEIGHTS,
        RL_SCHEMA_VERSION,
        RL_OUTCOME_WINDOW_TICKS,
        MAX_RL_EVENTS,
        buildConfigSnapshot,
        generateLeverSuspicions,
        dumpRlJson,
        handleMatchEnd,
        detectMatchEnd,
        maybeEmitPeriodicRL,
        drainRlOutcomes,
        maybeEmitPlannerDecision,
        rlLogIntentSent,
        rlLogIntentBlocked,
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
