/**
 * Regression tests for the RL Decision Logger (v2.6.0+).
 *
 * Mirrors the jsdom-loader pattern from SuperhumanBotPlanner.test.ts:
 * load the userscript source inside a jsdom window, invoke the IIFE, then
 * exercise the RL helpers exposed via `runtime.test.internals`.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { beforeEach, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(
  __dirname,
  "..",
  "tampermonkey-superhuman-bot.js",
);

let cachedRuntime: any = null;
function loadUserscript() {
  if (cachedRuntime) return cachedRuntime;
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const win: any = (globalThis as any).window;
  win.WebSocket = win.WebSocket ?? class {};
  win.Worker = win.Worker ?? class {};
  win.localStorage = win.localStorage ?? {
    _store: new Map<string, string>(),
    get length() {
      return this._store.size;
    },
    key(i: number) {
      return Array.from(this._store.keys())[i] ?? null;
    },
    getItem(k: string) {
      return this._store.has(k) ? this._store.get(k) : null;
    },
    setItem(k: string, v: string) {
      this._store.set(k, v);
    },
    removeItem(k: string) {
      this._store.delete(k);
    },
    clear() {
      this._store.clear();
    },
  };
  new Function(source).call(win);
  cachedRuntime = win.__superhumanBotRuntime;
  return cachedRuntime;
}

/**
 * Reset the RL ring buffer + tracking state before each test so assertions
 * about counts / contents aren't polluted by prior suites. We keep the
 * cached runtime because re-importing the 250KB userscript per test is
 * wastefully slow and the planner tests already proved the IIFE can be
 * cached safely.
 */
function resetRl(runtime: any) {
  const rl = runtime.rl;
  rl.enabled = true;
  rl.events.length = 0;
  rl.seq = 0;
  rl.pendingOutcomes.length = 0;
  rl.totalIntentsSent = 0;
  rl.totalIntentsBlocked = 0;
  rl.lastActionId = 0;
  rl.matchEnded = false;
  rl.lastIsAlive = false;
  rl.firstActiveTick = -1;
  rl.peakSelfStats = null;
  rl.prevSelfStats = null;
  rl.lastWorldSnapshotTick = -999;
  rl.lastStatDeltaTick = -999;
  rl.lastPlannerEmitTick = -999;
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
}

describe("tampermonkey-superhuman-bot RL Decision Logger — primitives", () => {
  beforeEach(() => {
    resetRl(loadUserscript());
  });

  it("exposes rlLog and appends structured events with monotonic seq", () => {
    const runtime = loadUserscript();
    const { rlLog } = runtime.test.internals;
    expect(rlLog).toBeTypeOf("function");

    const before = runtime.rl.events.length;
    rlLog("world_snapshot", { tiles: 10 });
    rlLog("goal_switch", { prev: "-", next: "TERRA_NULLIUS_RUSH" });
    expect(runtime.rl.events.length).toBe(before + 2);

    const first = runtime.rl.events[runtime.rl.events.length - 2];
    const second = runtime.rl.events[runtime.rl.events.length - 1];
    expect(first.kind).toBe("world_snapshot");
    expect(first.data.tiles).toBe(10);
    expect(typeof first.tick).toBe("number");
    expect(typeof first.wallMs).toBe("number");
    expect(second.seq).toBe(first.seq + 1);
  });

  it("short-circuits when rl.enabled === false", () => {
    const runtime = loadUserscript();
    const { rlLog } = runtime.test.internals;
    runtime.rl.enabled = false;
    const before = runtime.rl.events.length;
    const result = rlLog("world_snapshot", { x: 1 });
    expect(result).toBeNull();
    expect(runtime.rl.events.length).toBe(before);
    runtime.rl.enabled = true;
  });

  it("enforces the MAX_RL_EVENTS ring-buffer cap", () => {
    const runtime = loadUserscript();
    const { rlLog, MAX_RL_EVENTS } = runtime.test.internals;
    // Push MAX_RL_EVENTS + 50 entries. We expect the buffer to stabilise at
    // MAX_RL_EVENTS, and the newest seq to be 50 past the max.
    for (let i = 0; i < MAX_RL_EVENTS + 50; i++) {
      rlLog("reason", { i });
    }
    expect(runtime.rl.events.length).toBe(MAX_RL_EVENTS);
    const latest = runtime.rl.events[runtime.rl.events.length - 1];
    expect(latest.data.i).toBe(MAX_RL_EVENTS + 50 - 1);
    // The oldest surviving event should be i = 50 (we dropped the first 50).
    const oldest = runtime.rl.events[0];
    expect(oldest.data.i).toBe(50);
  });
});

describe("tampermonkey-superhuman-bot RL Decision Logger — config snapshot", () => {
  beforeEach(() => resetRl(loadUserscript()));

  it("enumerates every lever named in the plan", () => {
    const runtime = loadUserscript();
    const { buildConfigSnapshot } = runtime.test.internals;
    const snap = buildConfigSnapshot();

    expect(snap.botVersion).toBe("2.8.0");
    expect(snap.schemaVersion).toBeGreaterThanOrEqual(1);

    // Must include every critical lever constant the downstream analyst
    // would reasonably want to tweak.
    const required = [
      "THREAT_CROWN_THRESHOLD",
      "THREAT_CROWN_HYSTERESIS",
      "ATOM_GOLD_THRESHOLD",
      "HYDRO_GOLD_THRESHOLD",
      "MIRV_GOLD_THRESHOLD",
      "HISTORY_WINDOW_TICKS",
      "HISTORY_SAMPLE_EVERY",
      "LOOP_INTERVAL_MS",
      "STEALTH_MAX_MAJOR_PER_2S",
      "STEALTH_MAX_ATTACKS_PER_SEC",
      "STEALTH_MAX_BUILDS_PER_SEC",
      "STEALTH_SPAWN_THINK_MS",
      "STEALTH_PER_PLAYER_DIVERSITY_CAP",
      "RL_OUTCOME_WINDOW_TICKS",
      "RL_STAT_DELTA_EVERY",
      "RL_WORLD_SNAPSHOT_EVERY",
      "MAX_RL_EVENTS",
    ];
    for (const key of required) {
      expect(snap.constants).toHaveProperty(key);
      expect(typeof snap.constants[key]).toBe("number");
    }

    // Reward weights and build order must be included for the analyst.
    expect(snap.rewardWeights).toHaveProperty("tiles");
    expect(Array.isArray(snap.buildPriority)).toBe(true);
    expect(snap.buildPriority.length).toBeGreaterThan(0);

    // Every goal defined in GOAL_SPECS should round-trip into snap.goals
    // with an id + horizonTicks. Check at least a representative set.
    const ids = snap.goals.map((g: any) => g.id);
    for (const expected of [
      "TERRA_NULLIUS_RUSH",
      "NUKE_CROWN",
      "DEFENSIVE_TURTLE",
      "EASY_NATION_GRAB",
      "IDLE",
    ]) {
      expect(ids).toContain(expected);
    }

    // leverHints is authored; must be non-empty so the downstream agent has
    // at least one named knob to consider.
    expect(Array.isArray(snap.leverHints)).toBe(true);
    expect(snap.leverHints.length).toBeGreaterThanOrEqual(3);
    for (const hint of snap.leverHints) {
      expect(typeof hint.name).toBe("string");
      expect(typeof hint.hint).toBe("string");
    }
  });
});

describe("tampermonkey-superhuman-bot RL Decision Logger — reward", () => {
  beforeEach(() => resetRl(loadUserscript()));

  it("rewards pure tile gains linearly (weight=0.25)", () => {
    const runtime = loadUserscript();
    const { rlComputeReward } = runtime.test.internals;
    const reward = rlComputeReward({ tiles: 100, troops: 0, gold: 0, structures: {} }, false);
    expect(reward).toBeCloseTo(25, 3);
  });

  it("applies the died penalty additively", () => {
    const runtime = loadUserscript();
    const { rlComputeReward, RL_REWARD_WEIGHTS } = runtime.test.internals;
    const alive = rlComputeReward({ tiles: 0, troops: 0, gold: 0, structures: {} }, false);
    const dead = rlComputeReward({ tiles: 0, troops: 0, gold: 0, structures: {} }, true);
    expect(dead).toBeCloseTo(alive - RL_REWARD_WEIGHTS.diedPenalty, 3);
  });

  it("scores city builds heavier than defense-posts", () => {
    const runtime = loadUserscript();
    const { rlComputeReward, UnitType } = runtime.test.internals;
    const cityReward = rlComputeReward(
      { tiles: 0, troops: 0, gold: 0, structures: { [UnitType.City]: 1 } },
      false,
    );
    const dpReward = rlComputeReward(
      { tiles: 0, troops: 0, gold: 0, structures: { [UnitType.DefensePost]: 1 } },
      false,
    );
    expect(cityReward).toBeGreaterThan(dpReward);
  });
});

describe("tampermonkey-superhuman-bot RL Decision Logger — suspicions", () => {
  beforeEach(() => resetRl(loadUserscript()));

  it("flags a too-early death with a spawn-scoring suspicion", () => {
    const runtime = loadUserscript();
    const { generateLeverSuspicions } = runtime.test.internals;
    const out = generateLeverSuspicions({
      ticksAlive: 180,
      peakSelfStats: { tiles: 50, troops: 1000, gold: 0 },
      totalIntentsSent: 3,
      totalIntentsBlocked: 0,
      tracking: runtime.rl.tracking,
      reason: "died",
    });
    expect(out.length).toBeGreaterThan(0);
    const spawnHint = out.find((h: any) =>
      String(h.lever).toLowerCase().includes("spawn"),
    );
    expect(spawnHint).toBeTruthy();
  });

  it("flags a high stealth-gate block rate", () => {
    const runtime = loadUserscript();
    const { generateLeverSuspicions } = runtime.test.internals;
    const out = generateLeverSuspicions({
      ticksAlive: 1000,
      peakSelfStats: { tiles: 500, troops: 10000, gold: 0 },
      totalIntentsSent: 10,
      totalIntentsBlocked: 6,
      tracking: runtime.rl.tracking,
      reason: "died",
    });
    const blockHint = out.find((h: any) =>
      String(h.lever).includes("STEALTH"),
    );
    expect(blockHint).toBeTruthy();
  });

  it("caps output at 8 entries", () => {
    const runtime = loadUserscript();
    const { generateLeverSuspicions } = runtime.test.internals;
    // Hit every condition at once.
    runtime.rl.tracking.everAdjacentToCollapsing = true;
    runtime.rl.tracking.everSawCoalitionThreat = true;
    const out = generateLeverSuspicions({
      ticksAlive: 200,
      peakSelfStats: { tiles: 20, troops: 100, gold: 100 },
      totalIntentsSent: 10,
      totalIntentsBlocked: 9,
      tracking: runtime.rl.tracking,
      reason: "socket_closed",
    });
    expect(out.length).toBeLessThanOrEqual(8);
  });
});

describe("tampermonkey-superhuman-bot RL Decision Logger — dump", () => {
  beforeEach(() => resetRl(loadUserscript()));

  it("compact dump uses short kind codes and short field keys", () => {
    const runtime = loadUserscript();
    const { dumpRlJson, rlLog } = runtime.test.internals;
    rlLog("reason", { goalId: "TEST", summary: "hello" });
    const raw = dumpRlJson();
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(parsed.botVersion).toBe("2.8.0");
    expect(parsed.level).toBe("compact");
    expect(typeof parsed.generatedAtMs).toBe("number");
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.kindCodes).toBeDefined();
    expect(parsed.summary.kindCodes.R).toBe("reason");
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events.length).toBeGreaterThanOrEqual(1);
    // Compact events use `.k` (kind code), `.t` (tick), `.s` (seq), `.d`.
    const reasonEntries = parsed.events.filter((e: any) => e.k === "R");
    expect(reasonEntries.length).toBe(1);
    expect(reasonEntries[0].d.s).toBe("hello");
    expect(reasonEntries[0].d.g).toBe("TEST");
  });

  it("full dump keeps the legacy long-form shape", () => {
    const runtime = loadUserscript();
    const { dumpRlJson, rlLog } = runtime.test.internals;
    rlLog("reason", { goalId: "TEST", summary: "hello" });
    const raw = dumpRlJson({ level: "full" });
    const parsed = JSON.parse(raw);
    expect(parsed.level).toBe("full");
    const e = parsed.events.find((ev: any) => ev.kind === "reason");
    expect(e).toBeDefined();
    expect(e.data.summary).toBe("hello");
  });

  it("strips zero-valued fields from compact events", () => {
    const runtime = loadUserscript();
    const { dumpRlJson, rlLog } = runtime.test.internals;
    rlLog("stat_delta", {
      dTick: 10,
      dTiles: 0,
      dTroops: 0,
      dGold: 0,
      dStructures: {},
      rankByTiles: 0,
      rankByTroops: 0,
      activeGoalId: null,
    });
    const parsed = JSON.parse(dumpRlJson());
    const sd = parsed.events.find((e: any) => e.k === "SD");
    expect(sd).toBeDefined();
    // dTick=10 is kept; every zero field got stripped.
    expect(sd.d.dt).toBe(10);
    expect("dT" in sd.d).toBe(false);
    expect("dP" in sd.d).toBe(false);
    expect("dG" in sd.d).toBe(false);
    expect("g" in sd.d).toBe(false);
  });

  it("enforces the compact byte budget by dropping noisy kinds first", () => {
    const runtime = loadUserscript();
    const { dumpRlJson, rlLog } = runtime.test.internals;
    // Stuff the buffer with 500 world_snapshot + 5 match_end-ish events. We
    // expect world_snapshot events to get dropped before anything else.
    for (let i = 0; i < 500; i++) {
      rlLog("world_snapshot", {
        self: { tiles: 100, troops: 5000, gold: 1000 },
        opponents: {
          "2": {
            name: "Enemy" + i,
            type: "HUMAN",
            tiles: 200,
            troops: 8000,
            threatScore: 10,
            opportunityScore: 5,
            tags: ["ENEMY", "ADJACENT"],
          },
        },
        threats: { crownSmallID: 2 },
        totals: { myShare: 0.1, crownShare: 0.2 },
      });
    }
    rlLog("match_end", {
      reason: "died",
      endedAtMs: Date.now(),
      ticksAlive: 500,
      lastGoalId: "TERRA_NULLIUS_RUSH",
    });
    const raw = dumpRlJson({ level: "compact", maxBytes: 20_000 });
    expect(raw.length).toBeLessThanOrEqual(20_000);
    const parsed = JSON.parse(raw);
    expect(parsed.summary.droppedByKind).toBeDefined();
    expect(parsed.summary.droppedByKind.world_snapshot).toBeGreaterThan(0);
    // match_end never gets dropped by the prioritized dropper.
    expect(parsed.events.some((e: any) => e.k === "ME")).toBe(true);
  });
});

describe("tampermonkey-superhuman-bot RL Decision Logger — intent lifecycle", () => {
  beforeEach(() => resetRl(loadUserscript()));

  it("rlLogIntentSent records pre-state + queues a pending outcome", () => {
    const runtime = loadUserscript();
    const { rlLogIntentSent } = runtime.test.internals;

    // Seed a minimal world so preState has real numbers.
    runtime.world.me = {
      tiles: 100,
      troops: 5000,
      gold: 10000,
      troopRatio: 0.5,
      structures: {},
      structureLevels: {},
    };
    runtime.world.bySmallID = new Map();
    runtime.hooks.gameView = {
      ticks: () => 120,
      x: (t: number) => t % 50,
      y: (t: number) => Math.floor(t / 50),
    };

    rlLogIntentSent({ type: "attack", targetID: "player-2", troops: 5000 });

    expect(runtime.rl.totalIntentsSent).toBe(1);
    expect(runtime.rl.lastActionId).toBe(1);
    expect(runtime.rl.pendingOutcomes.length).toBe(1);
    const pending = runtime.rl.pendingOutcomes[0];
    expect(pending.fireTick).toBe(120 + 30); // RL_OUTCOME_WINDOW_TICKS
    expect(pending.preState.tiles).toBe(100);

    const last = runtime.rl.events[runtime.rl.events.length - 1];
    expect(last.kind).toBe("intent_sent");
    expect(last.data.intent.type).toBe("attack");
    expect(last.data.actionId).toBe(1);
  });

  it("drainRlOutcomes pairs intent→outcome with a scalar reward", () => {
    const runtime = loadUserscript();
    const { rlLogIntentSent, drainRlOutcomes } = runtime.test.internals;

    runtime.world.me = {
      tiles: 100,
      troops: 5000,
      gold: 10000,
      troopRatio: 0.5,
      structures: {},
      structureLevels: {},
    };
    runtime.world.bySmallID = new Map();
    runtime.hooks.gameView = {
      ticks: () => 100,
      x: (t: number) => t % 50,
      y: (t: number) => Math.floor(t / 50),
    };
    rlLogIntentSent({ type: "attack", targetID: "player-2", troops: 5000 });

    // Advance the world: we gained 40 tiles and 1000 troops.
    runtime.world.me = {
      tiles: 140,
      troops: 6000,
      gold: 10000,
      troopRatio: 0.5,
      structures: {},
      structureLevels: {},
    };
    // Fire window arrives — drain with me still alive.
    const fakeMe = { isAlive: () => true };
    drainRlOutcomes(200, fakeMe);

    expect(runtime.rl.pendingOutcomes.length).toBe(0);
    const outcome = runtime.rl.events
      .filter((e: any) => e.kind === "intent_outcome")
      .pop();
    expect(outcome).toBeDefined();
    expect(outcome.data.delta.tiles).toBe(40);
    expect(outcome.data.delta.troops).toBe(1000);
    expect(outcome.data.iAmAliveAtWindow).toBe(true);
    // 40 tiles × 0.25 + 1000 troops × 0.01 / 10 = 10 + 1 = 11.
    expect(outcome.data.reward).toBeCloseTo(11, 3);
  });

  it("rlLogIntentBlocked throttles per-reason and increments counter", () => {
    const runtime = loadUserscript();
    const { rlLogIntentBlocked } = runtime.test.internals;

    rlLogIntentBlocked({ type: "attack" }, "major-burst");
    rlLogIntentBlocked({ type: "attack" }, "major-burst"); // within throttle
    expect(runtime.rl.totalIntentsBlocked).toBe(1);
    const blockedEvents = runtime.rl.events.filter(
      (e: any) => e.kind === "intent_blocked",
    );
    expect(blockedEvents.length).toBe(1);

    // A different reason fires immediately.
    rlLogIntentBlocked({ type: "build_unit" }, "build-burst");
    expect(runtime.rl.totalIntentsBlocked).toBe(2);
    expect(
      runtime.rl.events.filter((e: any) => e.kind === "intent_blocked").length,
    ).toBe(2);
  });
});

describe("tampermonkey-superhuman-bot RL Decision Logger — match end", () => {
  beforeEach(() => resetRl(loadUserscript()));

  it("handleMatchEnd emits match_end exactly once and latches matchEnded", () => {
    const runtime = loadUserscript();
    const { handleMatchEnd } = runtime.test.internals;
    runtime.rl.sessionStartedAtMs = Date.now() - 10_000;
    runtime.rl.firstActiveTick = 10;
    runtime.world.tick = 300;
    runtime.world.me = {
      tiles: 50,
      troops: 1000,
      gold: 0,
      troopRatio: 0.1,
      structures: {},
      structureLevels: {},
    };
    runtime.world.rankings = { byTiles: [], byTroops: [] };
    runtime.world.meSmallID = 1;

    handleMatchEnd("died");
    const ends = runtime.rl.events.filter((e: any) => e.kind === "match_end");
    expect(ends.length).toBe(1);
    expect(ends[0].data.reason).toBe("died");
    expect(ends[0].data.ticksAlive).toBe(290);
    expect(Array.isArray(ends[0].data.leverSuspicions)).toBe(true);

    // Second call is a no-op (latched).
    handleMatchEnd("died");
    expect(
      runtime.rl.events.filter((e: any) => e.kind === "match_end").length,
    ).toBe(1);
  });
});

describe("tampermonkey-superhuman-bot RL Decision Logger — end-to-end smoke", () => {
  beforeEach(() => resetRl(loadUserscript()));

  it("produces every expected event kind over a simulated match lifecycle", () => {
    const runtime = loadUserscript();
    const {
      rlLog,
      buildConfigSnapshot,
      rlLogIntentSent,
      drainRlOutcomes,
      maybeEmitPlannerDecision,
      handleMatchEnd,
      dumpRlJson,
    } = runtime.test.internals;

    // ----- match_start + config_snapshot -----
    runtime.identity.gameID = "SMOKE-1";
    runtime.identity.clientID = "client-smoke";
    runtime.hooks.gameView = {
      ticks: () => 0,
      x: (t: number) => t % 50,
      y: (t: number) => Math.floor(t / 50),
    };
    rlLog("match_start", {
      gameID: runtime.identity.gameID,
      clientID: runtime.identity.clientID,
      botVersion: "2.8.0",
    });
    rlLog("config_snapshot", buildConfigSnapshot());

    // ----- planner_decision (two goals scored) -----
    runtime.planner.lastEvaluation = [
      {
        id: "TERRA_NULLIUS_RUSH",
        priority: 72,
        valid: true,
        note: "12% unowned",
      },
      { id: "EASY_NATION_GRAB", priority: 63, valid: true, note: "weak nation" },
      { id: "NUKE_CROWN", priority: 0, valid: false, note: "no crown" },
    ];
    maybeEmitPlannerDecision({
      spec: { id: "TERRA_NULLIUS_RUSH" },
      evaluation: { priority: 72, note: "12% unowned" },
      forced: false,
    });

    // ----- intent_sent + intent_outcome -----
    runtime.world.me = {
      tiles: 100,
      troops: 5000,
      gold: 100,
      troopRatio: 0.5,
      structures: {},
      structureLevels: {},
    };
    runtime.world.bySmallID = new Map();
    runtime.hooks.gameView.ticks = () => 120;
    rlLogIntentSent({ type: "attack", targetID: "player-2", troops: 3000 });
    // Sim 30 ticks: we grew 30 tiles.
    runtime.world.me = {
      tiles: 130,
      troops: 4800,
      gold: 200,
      troopRatio: 0.48,
      structures: {},
      structureLevels: {},
    };
    drainRlOutcomes(160, { isAlive: () => true });

    // ----- spawn_decision -----
    rlLog("spawn_decision", {
      mode: "manual",
      chosen: { tile: 2550, x: 0, y: 51 },
      topCandidates: [{ tile: 2550, x: 0, y: 51, score: 42 }],
      candidateCount: 10,
    });

    // ----- threat_flash -----
    rlLog("threat_flash", { reason: "crown_change", prev: null, next: 2 });

    // ----- reason -----
    rlLog("reason", { goalId: "TERRA_NULLIUS_RUSH", summary: "grab empty" });

    // ----- goal_switch (manual) -----
    rlLog("goal_switch", {
      prev: "IDLE",
      next: "TERRA_NULLIUS_RUSH",
      priority: 72,
    });

    // ----- match_end -----
    runtime.rl.sessionStartedAtMs = Date.now() - 20_000;
    runtime.rl.firstActiveTick = 10;
    runtime.world.tick = 500;
    runtime.world.rankings = { byTiles: [3, 2, 1], byTroops: [2, 3, 1] };
    runtime.world.meSmallID = 1;
    handleMatchEnd("died");

    // Default dump is compact: uses short kind codes via `.k`.
    const dump = dumpRlJson();
    const parsed = JSON.parse(dump);
    expect(parsed.level).toBe("compact");
    const codes = new Set(parsed.events.map((e: any) => e.k));
    const requiredCodes = [
      "MS", // match_start
      "CS", // config_snapshot
      "PD", // planner_decision
      "IS", // intent_sent
      "IO", // intent_outcome
      "SP", // spawn_decision
      "TF", // threat_flash
      "R", // reason
      "GS", // goal_switch
      "ME", // match_end
    ];
    for (const code of requiredCodes) {
      expect(codes.has(code), `missing kind code: ${code}`).toBe(true);
    }

    const matchEnd = parsed.events.find((e: any) => e.k === "ME");
    expect(matchEnd.d.r).toBe("died");
    expect(matchEnd.d.ta).toBe(490);
    expect(Array.isArray(matchEnd.d.su)).toBe(true);
    expect(matchEnd.d.su.length).toBeGreaterThan(0);

    const outcome = parsed.events.find((e: any) => e.k === "IO");
    expect(Number.isFinite(outcome.d.r)).toBe(true);
    expect(outcome.d.dT).toBe(30);

    // Config snapshot stays full-fidelity so leverHints survive.
    const snap = parsed.events.find((e: any) => e.k === "CS");
    expect(snap.d.leverHints.length).toBeGreaterThanOrEqual(3);

    // Dump is reasonably compact for an LLM analyst to ingest.
    expect(dump.length).toBeLessThan(500_000);
  });

  it("a synthetic 10-minute match stays under the default 500 KB budget", () => {
    const runtime = loadUserscript();
    const { rlLog, buildConfigSnapshot, dumpRlJson, handleMatchEnd } =
      runtime.test.internals;

    runtime.identity.gameID = "VOLUME-1";
    runtime.hooks.gameView = {
      ticks: () => 0,
      x: (t: number) => t % 50,
      y: (t: number) => Math.floor(t / 50),
    };
    rlLog("match_start", { gameID: "VOLUME-1" });
    rlLog("config_snapshot", buildConfigSnapshot());

    // Simulate 600s (6000 ticks) of actual-match cadence with the NEW sampling
    // rates: world_snapshot every 30 ticks (→ 200), stat_delta every 20
    // (→ 300), planner_decision every 60 (→ 100). Plus sprinkle some
    // intents / blocks / threats.
    for (let t = 0; t <= 6000; t += 30) {
      rlLog("world_snapshot", {
        self: { tiles: 100 + t, troops: 5000, gold: t * 10 },
        opponents: {
          "2": {
            name: "Enemy",
            type: "HUMAN",
            tiles: 300 - t * 0.02,
            troops: 8000,
            threatScore: 20,
            opportunityScore: 5,
            tags: ["ENEMY", "ADJACENT"],
          },
          "3": {
            name: "Nation",
            type: "NATION",
            tiles: 80,
            troops: 2000,
            threatScore: 5,
            opportunityScore: 15,
            tags: ["SOFT_TARGET"],
          },
        },
        threats: { crownSmallID: 2, adjacentEnemySmallIDs: [2] },
        totals: { myShare: 0.1 + t / 60000, crownShare: 0.2 },
      });
    }
    for (let t = 0; t <= 6000; t += 20) {
      rlLog("stat_delta", {
        dTick: 20,
        dTiles: 3,
        dTroops: 50,
        dGold: 200,
        dStructures: {},
      });
    }
    for (let t = 0; t <= 6000; t += 60) {
      rlLog("planner_decision", {
        winnerGoalId: "TERRA_NULLIUS_RUSH",
        winnerPriority: 72,
        evaluations: [
          { id: "TERRA_NULLIUS_RUSH", priority: 72, valid: true, note: "12% unowned" },
          { id: "EASY_NATION_GRAB", priority: 63, valid: true, note: "weak nation" },
          { id: "NUKE_CROWN", priority: 0, valid: false, note: "no crown" },
        ],
      });
    }
    // 30 intents over the match, ~1 every 20s.
    for (let i = 0; i < 30; i++) {
      rlLog("intent_sent", {
        actionId: i + 1,
        intent: { type: "attack", targetID: "player-2", troops: 3000 },
        activeGoalId: "TERRA_NULLIUS_RUSH",
      });
      rlLog("intent_outcome", {
        actionId: i + 1,
        intentType: "attack",
        delta: { tiles: 3, troops: -200, gold: 100, structures: {} },
        reward: 0.75,
      });
    }

    runtime.rl.sessionStartedAtMs = Date.now() - 600_000;
    runtime.rl.firstActiveTick = 10;
    runtime.world.tick = 6000;
    runtime.world.rankings = { byTiles: [3, 2, 1], byTroops: [2, 3, 1] };
    runtime.world.meSmallID = 1;
    handleMatchEnd("died");

    const raw = dumpRlJson();
    // The raw buffer is fat (~800+ events) but the compact dump must fit
    // well under 500 KB.
    expect(runtime.rl.events.length).toBeGreaterThan(500);
    expect(raw.length).toBeLessThanOrEqual(500_000);
    // Shape sanity.
    const parsed = JSON.parse(raw);
    expect(parsed.level).toBe("compact");
    expect(parsed.summary.droppedByKind).toBeDefined();
    expect(parsed.events.some((e: any) => e.k === "ME")).toBe(true);
    expect(parsed.events.some((e: any) => e.k === "CS")).toBe(true);
  });
});
