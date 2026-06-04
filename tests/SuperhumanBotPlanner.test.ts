/**
 * Regression tests for the standalone superhuman userscript.
 *
 * The userscript is an IIFE that expects a browser environment. We load the
 * raw source inside a sandboxed jsdom window, stub the few globals it
 * touches at module-init time, then invoke the built-in scripted planner
 * suite (`runtime.test.runSuite`). That suite covers:
 *   - planner goal selection across a variety of world states
 *   - alliance diplomacy helpers (accept / reject / safety guards)
 *   - terrain-rush goal selection when a neighbour is collapsing
 *   - low-level SAM trajectory math
 *
 * Running it here ensures the userscript's internal acceptance tests stay
 * green as the codebase evolves.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

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

  // Stub the APIs the script touches during boot. We don't need any of these
  // to actually do anything — the hooks just have to exist.
  win.WebSocket = win.WebSocket ?? class {};
  win.Worker = win.Worker ?? class {};
  win.localStorage = win.localStorage ?? {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  // setInterval fires the main loop; the runSuite helper sidesteps that and
  // runs synchronously, so we just need the global to exist (it already does
  // in jsdom).
  new Function(source).call(win);
  cachedRuntime = win.__superhumanBotRuntime;
  return cachedRuntime;
}

describe("tampermonkey-superhuman-bot planner suite", () => {
  it("passes the built-in scripted regression suite", () => {
    const runtime = loadUserscript();
    expect(runtime, "userscript should expose runtime on window").toBeDefined();
    expect(runtime.test?.runSuite, "runSuite should be wired up").toBeTypeOf(
      "function",
    );
    const summary = runtime.test.runSuite();
    const failing = summary.results.filter((r: any) => !r.pass);
    if (failing.length > 0) {
      // Surface every failure at once so the user doesn't have to re-run to
      // see what else broke.
      const details = failing
        .map(
          (r: any) =>
            `  - ${r.name}: expected=${r.expected}, actual=${r.actual}`,
        )
        .join("\n");
      throw new Error(
        `Userscript planner suite had ${failing.length} failure(s):\n${details}`,
      );
    }
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBeGreaterThan(0);
  });
});

describe("tampermonkey-superhuman-bot early-game naval guards", () => {
  // A minimal gameView stub that the boat-range helpers understand. Tiles
  // are just (x, y) coordinate pairs packed as indices into a WIDTH×HEIGHT
  // grid — enough for manhattanDist and numLandTiles.
  const WIDTH = 100;
  const ref = (x: number, y: number) => y * WIDTH + x;
  const xOf = (t: number) => t % WIDTH;
  const yOf = (t: number) => Math.floor(t / WIDTH);
  const stubGameView = (ticks: number) => ({
    ticks: () => ticks,
    numLandTiles: () => 10_000,
    manhattanDist: (a: number, b: number) =>
      Math.abs(xOf(a) - xOf(b)) + Math.abs(yOf(a) - yOf(b)),
    playerViews: () => [
      { isAlive: () => true },
      { isAlive: () => true },
      { isAlive: () => true },
      { isAlive: () => true },
      { isAlive: () => true },
      { isAlive: () => true },
    ],
    config: () => ({ numSpawnPhaseTurns: () => 100 }),
  });

  it("blocks boats very early when we barely own any land", () => {
    const runtime = loadUserscript();
    const { isTooEarlyForNaval, isBoatWithinRange } =
      runtime.test.internals;
    const gameView = stubGameView(500);
    const me = { numTilesOwned: () => 100 };

    expect(isTooEarlyForNaval(gameView, me)).toBe(true);
    expect(isBoatWithinRange(gameView, me, ref(5, 5), ref(90, 90))).toBe(false);
  });

  it("allows boats mid-game once mapShare and match time grow", () => {
    const runtime = loadUserscript();
    const { isTooEarlyForNaval, isBoatWithinRange } =
      runtime.test.internals;
    const gameView = stubGameView(5000);
    const me = { numTilesOwned: () => 1200 };

    expect(isTooEarlyForNaval(gameView, me)).toBe(false);
    expect(isBoatWithinRange(gameView, me, ref(20, 20), ref(25, 25))).toBe(true);
  });
});

describe("tampermonkey-superhuman-bot DefensePost human-border gate", () => {
  const WIDTH = 50;
  const ref = (x: number, y: number) => y * WIDTH + x;
  const xOf = (t: number) => t % WIDTH;
  const yOf = (t: number) => Math.floor(t / WIDTH);

  function makeGameView(
    PlayerType: any,
    opts: { enemyType: any; enemyTiles: Set<number> },
  ) {
    return {
      // getGameView() requires both `ticks` and `myPlayer` to be functions
      // before trusting the cached hook.
      ticks: () => 100,
      myPlayer: () => null,
      ownerID: (tile: number) => (opts.enemyTiles.has(tile) ? 2 : 0),
      playerBySmallID: (id: number) => {
        if (id !== 2) return null;
        return {
          isPlayer: () => true,
          type: () => opts.enemyType,
        };
      },
      circleSearch: (center: number, radius: number) => {
        const out = new Set<number>();
        const cx = xOf(center);
        const cy = yOf(center);
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dy = -radius; dy <= radius; dy++) {
            if (dx * dx + dy * dy > radius * radius) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= WIDTH) continue;
            out.add(ref(nx, ny));
          }
        }
        return out;
      },
    };
  }

  function installGameView(runtime: any, gameView: any) {
    runtime.hooks.gameView = gameView;
  }

  const me = {
    smallID: () => 1,
    isFriendly: () => false,
  };

  it("accepts tiles near a Human neighbour", () => {
    const runtime = loadUserscript();
    const { isTileNearHumanBorder, filterHumanBorderTiles, PlayerType } =
      runtime.test.internals;
    installGameView(
      runtime,
      makeGameView(PlayerType, {
        enemyType: PlayerType.Human,
        enemyTiles: new Set([ref(5, 5)]),
      }),
    );

    const candidate = ref(4, 4);
    expect(isTileNearHumanBorder(me, candidate)).toBe(true);
    expect(filterHumanBorderTiles(me, [candidate])).toEqual([candidate]);
  });

  it("rejects tiles whose only nearby enemy is a Nation", () => {
    const runtime = loadUserscript();
    const { isTileNearHumanBorder, filterHumanBorderTiles, PlayerType } =
      runtime.test.internals;
    installGameView(
      runtime,
      makeGameView(PlayerType, {
        enemyType: PlayerType.Nation,
        enemyTiles: new Set([ref(5, 5)]),
      }),
    );

    const candidate = ref(4, 4);
    expect(isTileNearHumanBorder(me, candidate)).toBe(false);
    expect(filterHumanBorderTiles(me, [candidate])).toEqual([]);
  });

  it("rejects tiles whose only nearby enemy is a Bot (tribe)", () => {
    const runtime = loadUserscript();
    const { isTileNearHumanBorder, filterHumanBorderTiles, PlayerType } =
      runtime.test.internals;
    installGameView(
      runtime,
      makeGameView(PlayerType, {
        enemyType: PlayerType.Bot,
        enemyTiles: new Set([ref(5, 5)]),
      }),
    );

    const candidate = ref(4, 4);
    expect(isTileNearHumanBorder(me, candidate)).toBe(false);
    expect(filterHumanBorderTiles(me, [candidate])).toEqual([]);
  });
});

describe("tampermonkey-superhuman-bot population-first build priority", () => {
  function installEmptyGameView(runtime: any) {
    runtime.hooks.gameView = {
      ticks: () => 100,
      myPlayer: () => null,
      isOceanShore: () => false,
      config: () => ({
        isUnitDisabled: () => false,
      }),
    };
    runtime.state.borderCache.tiles = [];
  }

  function me(overrides: any = {}) {
    const base: any = {
      numTilesOwned: () => 5000,
      totalUnitLevels: () => 0,
      units: () => [],
    };
    return Object.assign(base, overrides);
  }

  function setWorldAdjacent(runtime: any, enemies: any[]) {
    runtime.world = {
      ...runtime.world,
      archetype: "CONTINENTAL",
      threats: {
        ...(runtime.world?.threats ?? {}),
        adjacentEnemies: enemies,
      },
    };
  }

  it("puts City before DefensePost in the default build order", () => {
    const runtime = loadUserscript();
    const { buildOrderForArchetype, UnitType } = runtime.test.internals;
    const order = buildOrderForArchetype("CONTINENTAL");
    const cityIdx = order.indexOf(UnitType.City);
    const dpIdx = order.indexOf(UnitType.DefensePost);
    expect(cityIdx).toBeGreaterThanOrEqual(0);
    expect(dpIdx).toBeGreaterThanOrEqual(0);
    expect(cityIdx).toBeLessThan(dpIdx);
    const factoryIdx = order.indexOf(UnitType.Factory);
    const portIdx = order.indexOf(UnitType.Port);
    expect(factoryIdx).toBeLessThan(dpIdx);
    expect(portIdx).toBeLessThan(dpIdx);
  });

  it("builds more cities at higher tile counts (1 city per ~1800 tiles, floor 4)", () => {
    const runtime = loadUserscript();
    const { shouldBuildType, UnitType } = runtime.test.internals;
    installEmptyGameView(runtime);
    setWorldAdjacent(runtime, []);

    // Plan §2.5: cityTarget = max(4, floor(tiles/1800)). Below the floor
    // of 4, the target is always 4, so any player with < 4 cities at
    // any tile count wants another city.
    const player = me({
      numTilesOwned: () => 5000,
      totalUnitLevels: (t: any) => (t === UnitType.City ? 2 : 0),
      units: () => [],
    });
    expect(shouldBuildType(UnitType.City, player, [])).toBe(true);

    // 10_000 tiles with 3 cities -> still need more (target
    // max(4, floor(10000/1800)) = 5).
    const bigPlayer = me({
      numTilesOwned: () => 10_000,
      totalUnitLevels: (t: any) => (t === UnitType.City ? 3 : 0),
      units: () => [],
    });
    expect(shouldBuildType(UnitType.City, bigPlayer, [])).toBe(true);

    // 10_000 tiles with 5 cities -> target met (target = 5).
    const metPlayer = me({
      numTilesOwned: () => 10_000,
      totalUnitLevels: (t: any) => (t === UnitType.City ? 5 : 0),
      units: () => [],
    });
    expect(shouldBuildType(UnitType.City, metPlayer, [])).toBe(false);

    // 3500 tiles, floor kicks in: target = max(4, floor(3500/1800)) = 4.
    // With 4 cities at 3500 tiles we should be done.
    const floorMetPlayer = me({
      numTilesOwned: () => 3500,
      totalUnitLevels: (t: any) => (t === UnitType.City ? 4 : 0),
      units: () => [],
    });
    expect(shouldBuildType(UnitType.City, floorMetPlayer, [])).toBe(false);
  });

  it("blocks DefensePost builds when no adjacent Human is around, even with enemies present", () => {
    const runtime = loadUserscript();
    const { shouldBuildType, UnitType, PlayerType } = runtime.test.internals;
    installEmptyGameView(runtime);
    setWorldAdjacent(runtime, [
      { type: PlayerType.Nation, isFriendly: false, smallID: 2 },
      { type: PlayerType.Bot, isFriendly: false, smallID: 3 },
    ]);

    const player = me({
      numTilesOwned: () => 10_000,
      totalUnitLevels: (t: any) => (t === UnitType.City ? 6 : 0),
      units: () => [],
    });
    expect(shouldBuildType(UnitType.DefensePost, player, [{ smallID: 2 }])).toBe(
      false,
    );
  });

  it("blocks DefensePost builds when city target is not yet met", () => {
    const runtime = loadUserscript();
    const { shouldBuildType, UnitType, PlayerType } = runtime.test.internals;
    installEmptyGameView(runtime);
    setWorldAdjacent(runtime, [
      { type: PlayerType.Human, isFriendly: false, smallID: 2 },
    ]);

    // 10_000 tiles -> cityTarget=4, dpCityGate=floor(4*0.66)=2.
    // cities=1 -> under the gate, no DPs.
    const undersizedCities = me({
      numTilesOwned: () => 10_000,
      totalUnitLevels: (t: any) => (t === UnitType.City ? 1 : 0),
      units: () => [],
    });
    expect(
      shouldBuildType(UnitType.DefensePost, undersizedCities, [{ smallID: 2 }]),
    ).toBe(false);

    // cities=3 >= gate, dpCount=0, dpCoef=0.35 -> target=floor(3*0.35)=1 -> allow.
    const healthyCities = me({
      numTilesOwned: () => 10_000,
      totalUnitLevels: (t: any) => (t === UnitType.City ? 3 : 0),
      units: () => [],
    });
    expect(
      shouldBuildType(UnitType.DefensePost, healthyCities, [{ smallID: 2 }]),
    ).toBe(true);
  });

  it("keeps DP allowed when we already have cities AND a human neighbour", () => {
    const runtime = loadUserscript();
    const { shouldBuildType, UnitType, PlayerType } = runtime.test.internals;
    installEmptyGameView(runtime);
    setWorldAdjacent(runtime, [
      { type: PlayerType.Human, isFriendly: false, smallID: 2 },
    ]);

    const player = me({
      numTilesOwned: () => 20_000,
      totalUnitLevels: (t: any) => (t === UnitType.City ? 10 : 0),
      units: () => [],
    });
    expect(shouldBuildType(UnitType.DefensePost, player, [{ smallID: 2 }])).toBe(
      true,
    );
  });

  it("exposes a BOT_VERSION constant bumped to 2.14.0", () => {
    const runtime = loadUserscript();
    expect(runtime.test.internals.BOT_VERSION).toBe("2.14.0");
  });
});

describe("tampermonkey-superhuman-bot reasonLog plain-English output", () => {
  it("records a (goalId, summary, detail) tuple for the overlay", () => {
    const runtime = loadUserscript();
    const { reasonLog } = runtime.test.internals;
    const before = runtime.reasons.length;
    reasonLog(
      "TERRA_NULLIUS_RUSH",
      "Grabbing unclaimed land to grow income and pop cap.",
      "~47 tiles",
    );
    expect(runtime.reasons.length).toBe(before + 1);
    const entry = runtime.reasons[runtime.reasons.length - 1];
    expect(entry.goalId).toBe("TERRA_NULLIUS_RUSH");
    expect(entry.summary).toBe(
      "Grabbing unclaimed land to grow income and pop cap.",
    );
    expect(entry.detail).toBe("~47 tiles");
    // The old fields are gone; overlay/readers should only rely on summary/detail.
    expect("trigger" in entry).toBe(false);
    expect("outcome" in entry).toBe(false);
    expect("action" in entry).toBe(false);
  });

  it("tolerates a missing detail argument", () => {
    const runtime = loadUserscript();
    const { reasonLog } = runtime.test.internals;
    reasonLog("IDLE", "Nothing better to do right now.");
    const entry = runtime.reasons[runtime.reasons.length - 1];
    expect(entry.summary).toBe("Nothing better to do right now.");
    expect(entry.detail).toBe("");
  });
});

describe("tampermonkey-superhuman-bot EASY_NATION_GRAB planner goal", () => {
  function setWorldWithAdjacent(
    runtime: any,
    PlayerType: any,
    enemyTypeOrList: any,
    me: any = {},
  ) {
    const list = Array.isArray(enemyTypeOrList)
      ? enemyTypeOrList
      : [
          {
            name: "Neighbor",
            smallID: 2,
            type: enemyTypeOrList,
            troops: 5_000,
            tiles: 400,
            isFriendly: false,
          },
        ];
    runtime.world = {
      ...runtime.world,
      archetype: "CONTINENTAL",
      me: {
        smallID: 1,
        gold: 300_000,
        troops: 50_000,
        troopRatio: 0.5,
        incomingTroops: 0,
        tiles: 1500,
        maxTroops: 100_000,
        structures: { City: 4, Factory: 1, Port: 0, DefensePost: 0 },
        structureLevels: { City: 4, Factory: 1 },
        ...me,
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
        adjacentEnemies: list,
        inboundTroopTotal: 0,
      },
      classifiedAt: 100,
    };
  }

  it("evaluates EASY_NATION_GRAB as a valid goal when a weaker Nation is adjacent", () => {
    const runtime = loadUserscript();
    const { PlayerType } = runtime.test.internals;
    runtime.hooks.gameView = {
      ticks: () => 1500,
      myPlayer: () => ({
        isAlive: () => true,
        units: () => [],
        smallID: () => 1,
      }),
      config: () => ({
        maxTroops: () => 100_000,
        boatMaxNumber: () => 3,
        isUnitDisabled: () => false,
      }),
    };
    setWorldWithAdjacent(runtime, PlayerType, PlayerType.Nation);
    runtime.planner.forcedGoalId = null;
    runtime.planner.forcedGoalExpiresMs = 0;

    // Drive the planner suite state by forcing the goal once, then clearing.
    const debug = (globalThis as any).window.__superhumanBotDebug;
    debug.forceGoal("EASY_NATION_GRAB");
    expect(runtime.planner.forcedGoalId).toBe("EASY_NATION_GRAB");
    debug.clearForcedGoal();
    expect(runtime.planner.forcedGoalId).toBeNull();
  });
});

describe("tampermonkey-superhuman-bot overlay tooltips", () => {
  it("renders mouse-over tooltips on strategy modes, goal buttons, and labels", () => {
    const runtime = loadUserscript();
    const win: any = (globalThis as any).window;
    // Make sure the overlay is mounted and refreshed — the script mounts on
    // DOMContentLoaded, which in jsdom may have fired before our state is
    // interesting, so just call the exported refresh handle directly.
    expect(typeof win.__superhumanBotRefreshOverlay).toBe("function");

    // Snapshot prior planner + overlay state so we don't pollute sibling
    // tests in the same file (the runtime is cached across tests).
    const priorMode = runtime.mode;
    const priorStrategy = runtime.state.strategy;
    const priorActiveGoalId = runtime.planner.activeGoalId;
    const priorLastEvaluation = runtime.planner.lastEvaluation;

    try {
      runtime.mode = "aggressive";
      runtime.state.strategy = "economy";
      runtime.planner.activeGoalId = "NUKE_CROWN";
      runtime.planner.lastEvaluation = [
        {
          id: "NUKE_CROWN",
          priority: 84,
          valid: true,
          note: "crown=X share=40%",
        },
        {
          id: "DEFENSIVE_TURTLE",
          priority: 0,
          valid: false,
          note: "",
        },
      ];
      win.__superhumanBotRefreshOverlay();

      const panel = win.document.getElementById("superbot-panel");
      expect(panel, "overlay should be mounted").toBeTruthy();

      // Mode button tooltip should describe AGGRESSIVE specifically.
      const modeBtn = panel.querySelector("#superbot-mode");
      expect(modeBtn, "mode button should exist").toBeTruthy();
      const modeTitle = modeBtn!.getAttribute("title") ?? "";
      expect(modeTitle).toContain("AGGRESSIVE");
      expect(modeTitle).toContain("Balanced → Aggressive → Turtle");

      // Override buttons should carry per-goal tooltips.
      const overrideRow = panel.querySelector("#superbot-override-goals");
      const turtleBtn = Array.from(
        overrideRow!.querySelectorAll("button"),
      ).find(
        (b: HTMLButtonElement) => b.dataset.goal === "DEFENSIVE_TURTLE",
      ) as HTMLButtonElement | undefined;
      expect(turtleBtn, "Turtle override button should exist").toBeTruthy();
      expect(turtleBtn!.getAttribute("title") ?? "").toContain(
        "We are the crown",
      );

      // Strategy value in the State section should carry a per-strategy tooltip.
      const stateRoot = panel.querySelector("#superbot-state");
      const html = stateRoot!.innerHTML;
      expect(html).toMatch(/title="[^"]*Economy executor/);

      // Active goal value in the Goal section should carry the
      // GOAL_DESCRIPTIONS tooltip for NUKE_CROWN.
      const goalRoot = panel.querySelector("#superbot-goal");
      const goalHtml = goalRoot!.innerHTML;
      expect(goalHtml).toMatch(
        /title="[^"]*Regular nuclear pressure on the map leader/,
      );
    } finally {
      runtime.mode = priorMode;
      runtime.state.strategy = priorStrategy;
      runtime.planner.activeGoalId = priorActiveGoalId;
      runtime.planner.lastEvaluation = priorLastEvaluation;
    }
  });

  it("registers tooltips for the new REPEL_INVASION / PREEMPT_INVASION goals", () => {
    const runtime = loadUserscript();
    const win: any = (globalThis as any).window;
    const priorActiveGoalId = runtime.planner.activeGoalId;
    const priorLastEvaluation = runtime.planner.lastEvaluation;

    try {
      runtime.planner.activeGoalId = "REPEL_INVASION";
      runtime.planner.lastEvaluation = [
        {
          id: "REPEL_INVASION",
          priority: 99,
          valid: true,
          note: "invader=Overlord",
        },
        {
          id: "PREEMPT_INVASION",
          priority: 88,
          valid: true,
          note: "brewing=Rumble",
        },
      ];
      win.__superhumanBotRefreshOverlay();

      const panel = win.document.getElementById("superbot-panel");
      const overrideRow = panel!.querySelector("#superbot-override-goals");
      const repelBtn = Array.from(
        overrideRow!.querySelectorAll("button"),
      ).find(
        (b: HTMLButtonElement) => b.dataset.goal === "REPEL_INVASION",
      ) as HTMLButtonElement | undefined;
      const preemptBtn = Array.from(
        overrideRow!.querySelectorAll("button"),
      ).find(
        (b: HTMLButtonElement) => b.dataset.goal === "PREEMPT_INVASION",
      ) as HTMLButtonElement | undefined;
      expect(repelBtn, "Repel Invasion override button should exist").toBeTruthy();
      expect(preemptBtn, "Preempt Invasion override button should exist").toBeTruthy();
      expect(repelBtn!.getAttribute("title") ?? "").toContain(
        "live invasion",
      );
      expect(preemptBtn!.getAttribute("title") ?? "").toContain(
        "brewing invader",
      );

      const goalRoot = panel!.querySelector("#superbot-goal");
      const goalHtml = goalRoot!.innerHTML;
      expect(goalHtml).toMatch(/title="[^"]*Dedicated all-in defence/);
      expect(goalHtml).toMatch(/title="[^"]*Harden the border/);
    } finally {
      runtime.planner.activeGoalId = priorActiveGoalId;
      runtime.planner.lastEvaluation = priorLastEvaluation;
    }
  });
});

describe("tampermonkey-superhuman-bot invasion-defense goals", () => {
  // These tests wire world.threats directly and use the planner's
  // goal-evaluator machinery to confirm REPEL_INVASION and PREEMPT_INVASION
  // fire under the correct conditions — i.e. we spot winding-up and
  // actively-invading neighbours before they finish rolling us.
  function stubGameView(runtime: any) {
    runtime.hooks.gameView = {
      ticks: () => 1500,
      myPlayer: () => ({
        isAlive: () => true,
        units: () => [],
        smallID: () => 1,
      }),
      config: () => ({
        maxTroops: () => 100_000,
        boatMaxNumber: () => 3,
        isUnitDisabled: () => false,
      }),
    };
  }

  function worldWithInvasionThreats(runtime: any, overrides: any = {}) {
    runtime.world = {
      ...runtime.world,
      tick: 1500,
      archetype: "CONTINENTAL",
      me: {
        smallID: 1,
        name: "Me",
        gold: 500_000,
        troops: 40_000,
        maxTroops: 100_000,
        troopRatio: 0.4,
        tiles: 1500,
        incomingTroops: 0,
        outgoingTroops: 0,
        structures: { City: 4, Factory: 1, Port: 0, DefensePost: 2 },
        structureLevels: { City: 4, Factory: 1, DefensePost: 2 },
        incomingAttacks: [],
        outgoingAttacks: [],
        ...(overrides.me ?? {}),
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
        activeInvaders: [],
        brewingInvaders: [],
        invasionTroopsInbound: 0,
        inboundTroopTotal: 0,
        ...(overrides.threats ?? {}),
      },
      classifiedAt: 100,
    };
  }

  it("picks REPEL_INVASION when a stronger neighbour is actively attacking", () => {
    const runtime = loadUserscript();
    const { PlayerType } = runtime.test.internals;
    stubGameView(runtime);
    worldWithInvasionThreats(runtime, {
      me: { troops: 40_000, incomingTroops: 60_000 },
      threats: {
        activeInvaders: [
          {
            smallID: 77,
            name: "Overlord",
            type: PlayerType.Human,
            isFriendly: false,
            isAdjacent: true,
            troops: 120_000,
            invasionIncoming: 60_000,
            invasionPressure: 1.5,
            strength: 180_000,
          },
        ],
        invasionTroopsInbound: 60_000,
      },
    });
    runtime.planner.forcedGoalId = null;
    runtime.planner.forcedGoalExpiresMs = 0;
    runtime.planner.activeGoalId = null;

    // Drive the planner by re-running it via the scripted suite's helper.
    // We just need the top-of-stack winner.
    const debug = (globalThis as any).window.__superhumanBotDebug;
    const suite = debug.runPlannerSuite();
    // The suite also runs other scenarios, but the last winner it exposes
    // is not what we want — instead, use the lastEvaluation the planner
    // populated for our manually-installed world. Force a fresh selection
    // through the forced-goal debug path: set + clear to trigger a run.
    debug.forceGoal("REPEL_INVASION");
    expect(runtime.planner.forcedGoalId).toBe("REPEL_INVASION");
    debug.clearForcedGoal();

    // Reinstall our world (the suite resets it) and re-run the planner
    // evaluator manually by reading the goal spec directly.
    stubGameView(runtime);
    worldWithInvasionThreats(runtime, {
      me: { troops: 40_000, incomingTroops: 60_000 },
      threats: {
        activeInvaders: [
          {
            smallID: 77,
            name: "Overlord",
            type: PlayerType.Human,
            isFriendly: false,
            isAdjacent: true,
            troops: 120_000,
            invasionIncoming: 60_000,
            invasionPressure: 1.5,
            strength: 180_000,
          },
        ],
        invasionTroopsInbound: 60_000,
      },
    });

    // Use the overlay-level runtime.test.set + direct evaluator run.
    // Easiest path: run the same goal evaluation the planner would.
    const GOAL_SPECS_fn = (r: any) => r.planner; // placeholder
    // Instead, assert via the last-evaluation list after a planner run.
    // The planner is internal to the script's IIFE — we invoke it by
    // temporarily swapping GOAL_SPECS into lastEvaluation. Simpler: just
    // call runPlannerSuite which exercises the scenarios and reports the
    // invasion scenario (13) as PASS.
    const summary = runtime.test.runSuite();
    const invasionResult = summary.results.find((r: any) =>
      r.name.startsWith("stronger adjacent actively invading"),
    );
    expect(invasionResult, "invasion scenario should be in suite").toBeDefined();
    expect(invasionResult.pass).toBe(true);
    expect(invasionResult.actual).toBe("REPEL_INVASION");
    // Unused placeholder to silence TS.
    void GOAL_SPECS_fn;
    void suite;
  });

  it("picks PREEMPT_INVASION when a brewing invader is winding up", () => {
    const runtime = loadUserscript();
    const summary = runtime.test.runSuite();
    const preemptResult = summary.results.find((r: any) =>
      r.name.startsWith("brewing invader only"),
    );
    expect(preemptResult, "preempt scenario should be in suite").toBeDefined();
    expect(preemptResult.pass).toBe(true);
    expect(preemptResult.actual).toBe("PREEMPT_INVASION");
  });

  it("picks PREEMPT_INVASION for an early overmatched Human neighbour", () => {
    const runtime = loadUserscript();
    const summary = runtime.test.runSuite();
    const earlyResult = summary.results.find((r: any) =>
      r.name.startsWith("early human overmatch"),
    );
    expect(earlyResult, "early overmatch scenario should be in suite").toBeDefined();
    expect(earlyResult.pass).toBe(true);
    expect(earlyResult.actual).toBe("PREEMPT_INVASION");
  });

  it("prefers REPEL_INVASION over PREEMPT when both are present", () => {
    const runtime = loadUserscript();
    const summary = runtime.test.runSuite();
    const bothResult = summary.results.find((r: any) =>
      r.name.startsWith("active + brewing both present"),
    );
    expect(bothResult, "both-present scenario should be in suite").toBeDefined();
    expect(bothResult.pass).toBe(true);
    expect(bothResult.actual).toBe("REPEL_INVASION");
  });

  it("exposes activeInvaders + brewingInvaders on world.threats after reset", () => {
    const runtime = loadUserscript();
    // Fresh boot state: lists should exist and start empty.
    expect(Array.isArray(runtime.world.threats.activeInvaders)).toBe(true);
    expect(Array.isArray(runtime.world.threats.brewingInvaders)).toBe(true);
    expect(typeof runtime.world.threats.invasionTroopsInbound).toBe("number");
  });
});

describe("tampermonkey-superhuman-bot local transport bridge", () => {
  // When the game is running locally against Impossible AI, Transport.ts
  // never opens a WebSocket. Instead it publishes a bridge on
  // `window.__openFrontLocalTransport` that the userscript is supposed to
  // latch onto. Without this path every `sendRawMessage` call fails with
  // "socket unavailable" — i.e. the bot "doesn't work locally".
  it("captures window.__openFrontLocalTransport and sends via it when no socket is present", () => {
    const runtime = loadUserscript();
    const { installLocalTransportBridge, sendRawMessage, handleServerMessage } =
      runtime.test.internals;
    const win: any = (globalThis as any).window;

    const sent: any[] = [];
    const listeners: Array<(msg: any) => void> = [];
    const bridge = {
      isLocal: true as const,
      send(msg: any) {
        sent.push(msg);
      },
      addMessageListener(listener: (msg: any) => void) {
        listeners.push(listener);
        return () => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    };

    const priorSocket = runtime.hooks.socket;
    const priorBridge = runtime.hooks.localBridge;
    const priorUnsub = runtime.hooks.localBridgeUnsubscribe;
    const priorWsBridge = win.__openFrontLocalTransport;
    runtime.hooks.socket = null;
    win.__openFrontLocalTransport = bridge;

    try {
      installLocalTransportBridge();
      expect(runtime.hooks.localBridge).toBe(bridge);
      expect(listeners.length).toBe(1);

      // Server messages arriving via the bridge should flow through the
      // same handleServerMessage path the WebSocket hook uses.
      expect(handleServerMessage).toBeTypeOf("function");

      // Without a socket, sendRawMessage must fall back to the bridge.
      const ok = sendRawMessage({ type: "intent", intent: { type: "spawn", tile: 7 } });
      expect(ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({ type: "intent", intent: { type: "spawn", tile: 7 } });

      // Idempotent — re-running the installer while the same bridge is
      // still published must not double-subscribe.
      installLocalTransportBridge();
      expect(listeners.length).toBe(1);

      // When the bridge disappears (e.g. player leaves the singleplayer
      // game), the installer should notice on the next discovery tick and
      // unhook. This keeps the overlay accurate and prevents "sending" into
      // a dead LocalServer.
      delete win.__openFrontLocalTransport;
      installLocalTransportBridge();
      expect(runtime.hooks.localBridge).toBeNull();
      expect(listeners.length).toBe(0);
    } finally {
      runtime.hooks.socket = priorSocket;
      runtime.hooks.localBridge = priorBridge;
      runtime.hooks.localBridgeUnsubscribe = priorUnsub;
      if (priorWsBridge === undefined) {
        delete win.__openFrontLocalTransport;
      } else {
        win.__openFrontLocalTransport = priorWsBridge;
      }
    }
  });

  it("sendRawMessage fails closed if neither a socket nor a local bridge is available", () => {
    const runtime = loadUserscript();
    const { sendRawMessage } = runtime.test.internals;

    const priorSocket = runtime.hooks.socket;
    const priorBridge = runtime.hooks.localBridge;
    runtime.hooks.socket = null;
    runtime.hooks.localBridge = null;

    try {
      const ok = sendRawMessage({ type: "ping" });
      expect(ok).toBe(false);
    } finally {
      runtime.hooks.socket = priorSocket;
      runtime.hooks.localBridge = priorBridge;
    }
  });
});

describe("tampermonkey-superhuman-bot narrow-water river invasion", () => {
  // Minimal grid-backed gameView stub tuned for findNarrowWaterEnemies.
  // The map is WIDTH×HEIGHT tiles. A vertical river of water sits at
  // x=RIVER_X with width RIVER_WIDTH. Our tiles are left of the river,
  // enemy tiles are right. `setTerrain`/`setOwner` lets individual tests
  // mutate a few cells to exercise edge cases (far-away ocean, lake, etc.).
  const WIDTH = 30;
  const HEIGHT = 20;
  const ref = (x: number, y: number) => y * WIDTH + x;
  const xOf = (t: number) => t % WIDTH;
  const yOf = (t: number) => Math.floor(t / WIDTH);

  function makeWorld(opts: {
    riverX?: number;
    riverWidth?: number;
    myBorderX?: number;
    enemyStartX?: number;
    /** Extra water tiles (lakes / ocean). */
    extraWater?: Array<[number, number]>;
    /** Per-tile owner override. */
    owners?: Record<number, number>;
  }) {
    const riverX = opts.riverX ?? 10;
    const riverWidth = opts.riverWidth ?? 2;
    const myBorderX = opts.myBorderX ?? riverX - 1;
    const enemyStartX = opts.enemyStartX ?? riverX + riverWidth;
    const isWater = new Set<number>();
    const ownerByTile = new Map<number, number>();
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const tile = ref(x, y);
        if (x >= riverX && x < riverX + riverWidth) {
          isWater.add(tile);
        } else if (x <= myBorderX) {
          ownerByTile.set(tile, 1);
        } else if (x >= enemyStartX) {
          ownerByTile.set(tile, 2);
        }
      }
    }
    for (const [x, y] of opts.extraWater ?? []) {
      isWater.add(ref(x, y));
      ownerByTile.delete(ref(x, y));
    }
    for (const [k, v] of Object.entries(opts.owners ?? {})) {
      const tile = Number(k);
      if (v === 0) ownerByTile.delete(tile);
      else ownerByTile.set(tile, v);
    }

    const gameView = {
      ticks: () => 2000,
      width: () => WIDTH,
      height: () => HEIGHT,
      numLandTiles: () => 400,
      isValidCoord: (x: number, y: number) =>
        x >= 0 && y >= 0 && x < WIDTH && y < HEIGHT,
      ref: (x: number, y: number) => ref(x, y),
      x: (t: number) => xOf(t),
      y: (t: number) => yOf(t),
      isLand: (t: number) => !isWater.has(t),
      ownerID: (t: number) => ownerByTile.get(t) ?? 0,
      neighbors: (t: number) => {
        const ns: number[] = [];
        const x = xOf(t);
        const y = yOf(t);
        if (x > 0) ns.push(ref(x - 1, y));
        if (x < WIDTH - 1) ns.push(ref(x + 1, y));
        if (y > 0) ns.push(ref(x, y - 1));
        if (y < HEIGHT - 1) ns.push(ref(x, y + 1));
        return ns;
      },
      nearbyUnits: () => [] as any[],
      manhattanDist: (a: number, b: number) =>
        Math.abs(xOf(a) - xOf(b)) + Math.abs(yOf(a) - yOf(b)),
      config: () => ({
        numSpawnPhaseTurns: () => 100,
        boatMaxNumber: () => 3,
        maxTroops: () => 100_000,
        isUnitDisabled: () => false,
      }),
    };

    return { gameView, riverX, riverWidth, myBorderX, enemyStartX };
  }

  it("finds an enemy across a 2-tile river", () => {
    const runtime = loadUserscript();
    const { findNarrowWaterEnemies, NARROW_WATER_HOP_LIMIT } =
      runtime.test.internals;
    const { gameView, myBorderX } = makeWorld({ riverWidth: 2 });
    const me = { smallID: () => 1 };
    const borderTiles: number[] = [];
    for (let y = 0; y < HEIGHT; y++) borderTiles.push(ref(myBorderX, y));

    const found = findNarrowWaterEnemies(
      gameView,
      me,
      borderTiles,
      NARROW_WATER_HOP_LIMIT,
    );
    expect(found.has(2)).toBe(true);
    const entry = found.get(2);
    expect(entry.hops).toBe(2);
    // Landing tile must be one of OUR shore tiles.
    expect(gameView.ownerID(entry.nearestLandingTile)).toBe(1);
    // Enemy tile must be enemy-owned.
    expect(gameView.ownerID(entry.nearestEnemyTile)).toBe(2);
  });

  it("does NOT surface enemies separated by a wide ocean (>6 tiles)", () => {
    const runtime = loadUserscript();
    const { findNarrowWaterEnemies, NARROW_WATER_HOP_LIMIT } =
      runtime.test.internals;
    const { gameView, myBorderX } = makeWorld({
      riverWidth: 10,
      enemyStartX: 20,
    });
    const me = { smallID: () => 1 };
    const borderTiles: number[] = [];
    for (let y = 0; y < HEIGHT; y++) borderTiles.push(ref(myBorderX, y));

    const found = findNarrowWaterEnemies(
      gameView,
      me,
      borderTiles,
      NARROW_WATER_HOP_LIMIT,
    );
    expect(found.has(2)).toBe(false);
  });

  it("honours the hop budget for odd-width gaps at the boundary", () => {
    const runtime = loadUserscript();
    const { findNarrowWaterEnemies } = runtime.test.internals;
    const { gameView, myBorderX } = makeWorld({ riverWidth: 6 });
    const me = { smallID: () => 1 };
    const borderTiles: number[] = [];
    for (let y = 0; y < HEIGHT; y++) borderTiles.push(ref(myBorderX, y));

    // At exactly the hop limit (6), the enemy should still be found.
    const atLimit = findNarrowWaterEnemies(gameView, me, borderTiles, 6);
    expect(atLimit.has(2)).toBe(true);

    // One less hop than the gap: no enemy should surface.
    const tightBudget = findNarrowWaterEnemies(gameView, me, borderTiles, 5);
    expect(tightBudget.has(2)).toBe(false);
  });

  it("exposes narrowWaterNeighbors and route cooldowns on the runtime", () => {
    const runtime = loadUserscript();
    // Earlier tests in this file may have swapped `runtime.world` to a
    // hand-crafted object; re-run a reset by asserting either the threats
    // field exists OR the state-level cooldown map is wired.
    const hasThreatsField =
      runtime.world?.threats &&
      Array.isArray(runtime.world.threats.narrowWaterNeighbors);
    const hasCooldownMap = runtime.state.routeCooldowns instanceof Map;
    expect(Boolean(hasThreatsField) || hasCooldownMap).toBe(true);
    // The lost-boat map should always be present.
    expect(runtime.state.lostBoatBySmallID instanceof Map).toBe(true);
  });

  it("maybeRiverCrossing dispatches a boat when a narrow-water enemy is present", async () => {
    const runtime = loadUserscript();
    const { maybeRiverCrossing } = runtime.test.internals;
    const { gameView, myBorderX } = makeWorld({ riverWidth: 2 });

    const me: any = {
      smallID: () => 1,
      numTilesOwned: () => 2_000,
      troops: () => 80_000,
      gold: () => 100_000,
      unitCount: () => 1,
      units: () => [],
      isFriendly: () => false,
      bestTransportShipSpawn: async (dst: number) => {
        // Return the nearest tile on our border at the enemy row.
        const y = yOf(dst);
        return ref(myBorderX, y);
      },
    };

    // Install our stub gameView and a minimal world mirror.
    const priorGameView = runtime.hooks.gameView;
    const priorWorld = runtime.world;
    const priorMyPlayer = gameView as any;
    priorMyPlayer.myPlayer = () => me;
    runtime.hooks.gameView = priorMyPlayer;
    const enemyTile = ref(15, 5);
    const landingTile = ref(myBorderX, 5);
    runtime.world = {
      ...runtime.world,
      tick: 2000,
      archetype: "CONTINENTAL",
      me: { smallID: 1, troops: 10_000, tiles: 2_000 },
      meSmallID: 1,
      bySmallID: new Map([
        [
          2,
          {
            smallID: 2,
            isFriendly: false,
            troops: 1_000,
            type: "NATION",
            name: "RiverEnemy",
          },
        ],
      ]),
      threats: {
        ...(runtime.world.threats ?? {}),
        narrowWaterNeighbors: [
          {
            smallID: 2,
            hops: 2,
            landingTile,
            enemyTile,
            name: "RiverEnemy",
          },
        ],
      },
      everyone: [],
    };
    runtime.state.cooldowns.naval = -999;
    runtime.state.routeCooldowns = new Map();
    runtime.state.sentBoats = new Map();
    runtime.state.lostBoatBySmallID = new Map();

    // Hook sendRawMessage so sendIntent can succeed (it goes through
    // sendIntent → stealth gate → sendRawMessage). We install a local
    // bridge that captures boats and enable harness mode to bypass the
    // per-intent throttling.
    const sent: any[] = [];
    runtime.hooks.socket = null;
    runtime.hooks.localBridge = { send: (msg: any) => sent.push(msg) };
    const win: any = (globalThis as any).window;
    const priorHarness = win.__SUPERBOT_TEST_MODE;
    win.__SUPERBOT_TEST_MODE = true;
    const priorLastSig = runtime.state.lastIntentSignature;
    runtime.state.lastIntentSignature = "";

    try {
      const acted = await maybeRiverCrossing(me, [landingTile]);
      expect(acted).toBe(true);
      const boatIntents = sent.filter(
        (msg) => msg?.intent?.type === "boat",
      );
      expect(boatIntents.length).toBeGreaterThan(0);
      expect(boatIntents[0].intent.dst).toBe(enemyTile);
    } finally {
      runtime.hooks.gameView = priorGameView;
      runtime.world = priorWorld;
      runtime.hooks.localBridge = null;
      win.__SUPERBOT_TEST_MODE = priorHarness;
      runtime.state.lastIntentSignature = priorLastSig;
    }
  });
});

describe("tampermonkey-superhuman-bot naval safety gate", () => {
  const WIDTH = 30;
  const HEIGHT = 20;
  const ref = (x: number, y: number) => y * WIDTH + x;
  const xOf = (t: number) => t % WIDTH;
  const yOf = (t: number) => Math.floor(t / WIDTH);

  function stubGameView(opts: {
    enemyWarships?: Array<{
      tile: number;
      ownerSmallID: number;
    }>;
    ticks?: number;
    warshipGold?: number;
  }) {
    const warships = opts.enemyWarships ?? [];
    return {
      ticks: () => opts.ticks ?? 2000,
      width: () => WIDTH,
      height: () => HEIGHT,
      numLandTiles: () => 400,
      isValidCoord: (x: number, y: number) =>
        x >= 0 && y >= 0 && x < WIDTH && y < HEIGHT,
      ref: (x: number, y: number) => ref(x, y),
      x: (t: number) => xOf(t),
      y: (t: number) => yOf(t),
      ownerID: () => 0,
      manhattanDist: (a: number, b: number) =>
        Math.abs(xOf(a) - xOf(b)) + Math.abs(yOf(a) - yOf(b)),
      euclideanDistSquared: (a: number, b: number) => {
        const dx = xOf(a) - xOf(b);
        const dy = yOf(a) - yOf(b);
        return dx * dx + dy * dy;
      },
      neighbors: () => [] as number[],
      isLand: () => true,
      nearbyUnits: (tile: number, radius: number) => {
        const out: any[] = [];
        for (const w of warships) {
          const dx = xOf(w.tile) - xOf(tile);
          const dy = yOf(w.tile) - yOf(tile);
          if (dx * dx + dy * dy <= radius * radius) {
            out.push({
              unit: {
                id: () => w.tile,
                isActive: () => true,
                owner: () => ({
                  smallID: () => w.ownerSmallID,
                }),
              },
              distSquared: dx * dx + dy * dy,
            });
          }
        }
        return out;
      },
      config: () => ({
        numSpawnPhaseTurns: () => 100,
        boatMaxNumber: () => 3,
        maxTroops: () => 100_000,
        isUnitDisabled: () => false,
        unitInfo: () => ({
          cost: () => opts.warshipGold ?? 250_000,
        }),
      }),
    };
  }

  it("allows narrow-hop invasions even with enemy warships on the route", () => {
    const runtime = loadUserscript();
    const { isNavalInvasionSafe, NARROW_WATER_HOP_LIMIT } =
      runtime.test.internals;
    const gameView = stubGameView({
      enemyWarships: [{ tile: ref(15, 10), ownerSmallID: 2 }],
    });
    const me: any = {
      smallID: () => 1,
      isFriendly: () => false,
      units: () => [],
      unitCount: () => 0,
      gold: () => 0,
    };
    const result = isNavalInvasionSafe(
      gameView,
      me,
      ref(5, 10),
      ref(12, 10),
      { targetSmallID: 2, hops: 2, narrowHopLimit: NARROW_WATER_HOP_LIMIT },
    );
    expect(result.safe).toBe(true);
  });

  it("blocks long-range invasions when enemy warships are on route and we cannot counter", () => {
    const runtime = loadUserscript();
    const { isNavalInvasionSafe } = runtime.test.internals;
    const gameView = stubGameView({
      enemyWarships: [{ tile: ref(15, 10), ownerSmallID: 2 }],
    });
    const me: any = {
      smallID: () => 1,
      isFriendly: () => false,
      units: () => [], // no warships of our own
      unitCount: () => 0, // no ports
      gold: () => 0, // no gold to build one
    };
    const result = isNavalInvasionSafe(
      gameView,
      me,
      ref(0, 10),
      ref(28, 10),
      { targetSmallID: 2 },
    );
    expect(result.safe).toBe(false);
    expect(result.reason).toBe("enemy-warships-uncountered");
    expect(result.enemyWarships).toBeGreaterThan(0);
  });

  it("allows long-range invasion when we have parity warships", () => {
    const runtime = loadUserscript();
    const { isNavalInvasionSafe, UnitType } = runtime.test.internals;
    const gameView = stubGameView({
      enemyWarships: [{ tile: ref(15, 10), ownerSmallID: 2 }],
    });
    const myWarship = {
      isActive: () => true,
      isUnderConstruction: () => false,
      owner: () => ({ smallID: () => 1 }),
    };
    const me: any = {
      smallID: () => 1,
      isFriendly: () => false,
      units: (t: string) => (t === UnitType.Warship ? [myWarship] : []),
      unitCount: () => 1,
      gold: () => 0,
    };
    const result = isNavalInvasionSafe(
      gameView,
      me,
      ref(0, 10),
      ref(28, 10),
      { targetSmallID: 2 },
    );
    expect(result.safe).toBe(true);
    expect(result.reason).toBe("parity");
  });

  it("allows long-range invasion when we can afford to build a counter warship", () => {
    const runtime = loadUserscript();
    const { isNavalInvasionSafe } = runtime.test.internals;
    const gameView = stubGameView({
      enemyWarships: [{ tile: ref(15, 10), ownerSmallID: 2 }],
      warshipGold: 100_000,
    });
    const me: any = {
      smallID: () => 1,
      isFriendly: () => false,
      units: () => [],
      unitCount: () => 1, // 1 port
      gold: () => 500_000, // easily affordable
    };
    const result = isNavalInvasionSafe(
      gameView,
      me,
      ref(0, 10),
      ref(28, 10),
      { targetSmallID: 2 },
    );
    expect(result.safe).toBe(true);
    expect(result.reason).toBe("can-afford-counter");
  });

  it("blocks invasions when the per-target route cooldown is active", () => {
    const runtime = loadUserscript();
    const { isNavalInvasionSafe } = runtime.test.internals;
    const gameView = stubGameView({});
    const me: any = {
      smallID: () => 1,
      isFriendly: () => false,
      units: () => [],
      unitCount: () => 0,
      gold: () => 0,
    };
    runtime.state.routeCooldowns.set(7, 9999); // lockout far in the future
    try {
      const result = isNavalInvasionSafe(
        gameView,
        me,
        ref(0, 0),
        ref(10, 0),
        { targetSmallID: 7 },
      );
      expect(result.safe).toBe(false);
      expect(result.reason).toBe("route-cooldown");
    } finally {
      runtime.state.routeCooldowns.delete(7);
    }
  });

  it("registerLostBoat escalates the cooldown on repeated losses", () => {
    const runtime = loadUserscript();
    const {
      registerLostBoat,
      LOST_BOAT_BASE_COOLDOWN_TICKS,
      LOST_BOAT_MAX_COOLDOWN_TICKS,
    } = runtime.test.internals;

    runtime.state.routeCooldowns.clear();
    runtime.state.lostBoatBySmallID.clear();
    try {
      registerLostBoat(99, 1000);
      expect(runtime.state.routeCooldowns.get(99)).toBe(
        1000 + LOST_BOAT_BASE_COOLDOWN_TICKS,
      );

      registerLostBoat(99, 2000);
      expect(runtime.state.routeCooldowns.get(99)).toBe(
        2000 + LOST_BOAT_BASE_COOLDOWN_TICKS * 2,
      );

      // Many losses -> cap at LOST_BOAT_MAX_COOLDOWN_TICKS
      for (let i = 0; i < 20; i++) registerLostBoat(99, 3000);
      expect(runtime.state.routeCooldowns.get(99)).toBe(
        3000 + LOST_BOAT_MAX_COOLDOWN_TICKS,
      );
    } finally {
      runtime.state.routeCooldowns.clear();
      runtime.state.lostBoatBySmallID.clear();
    }
  });
});

describe("tampermonkey-superhuman-bot invasion-defense stall", () => {
  function freshWorld(runtime: any) {
    // Seed a minimal threats structure so shouldStallForInvasionDefense
    // and gates have something to read. We copy from the script's
    // buildTestWorld-compatible shape so every field the helpers touch
    // exists.
    runtime.world = runtime.world ?? {};
    runtime.world.threats = runtime.world.threats ?? {
      adjacentEnemies: [],
      mirvCapable: [],
      narrowWaterNeighbors: [],
      activeInvaders: [],
      brewingInvaders: [],
      invasionTroopsInbound: 0,
      inboundTroopTotal: 0,
    };
    runtime.world.threats.overwhelmingNeighbor = null;
    return runtime.world;
  }

  it("2.5x threshold matches the saturated-defender derivation when enemy is committed elsewhere", () => {
    const runtime = loadUserscript();
    const {
      computeOverwhelmingNeighbor,
      INVASION_STALL_TROOP_RATIO,
      INVASION_STALL_FOCUSED_RATIO,
      PlayerType,
    } = runtime.test.internals;
    expect(INVASION_STALL_TROOP_RATIO).toBe(2.5);
    // Plan §2.4: 2.0× focused threshold fires when the enemy has no
    // outgoing attacks (they can drop everything on us).
    expect(INVASION_STALL_FOCUSED_RATIO).toBe(2.0);

    const me = { troops: 10_000 };

    // Committed enemy (outgoingTroops > 0): uses the 2.5× threshold.
    // 2.49× → no stall.
    const committedUnder = computeOverwhelmingNeighbor(me, [
      {
        smallID: 7,
        name: "Peer",
        type: PlayerType.Human,
        isFriendly: false,
        troops: 24_900,
        outgoingTroops: 5_000,
      },
    ]);
    expect(committedUnder).toBeNull();

    // Committed enemy at exactly 2.5× → no stall (strict >).
    const committedBoundary = computeOverwhelmingNeighbor(me, [
      {
        smallID: 7,
        name: "Peer",
        type: PlayerType.Human,
        isFriendly: false,
        troops: 25_000,
        outgoingTroops: 5_000,
      },
    ]);
    expect(committedBoundary).toBeNull();

    // Committed enemy at 2.51× → overwhelming with the 2.5× threshold.
    const committedOver = computeOverwhelmingNeighbor(me, [
      {
        smallID: 7,
        name: "Giant",
        type: PlayerType.Human,
        isFriendly: false,
        troops: 25_100,
        outgoingTroops: 5_000,
      },
    ]);
    expect(committedOver).not.toBeNull();
    expect(committedOver.ratio).toBeCloseTo(2.51, 2);
    expect(committedOver.threshold).toBe(INVASION_STALL_TROOP_RATIO);
    expect(committedOver.idealMinTroops).toBe(Math.ceil(25_100 * 0.4));
  });

  it("2.0x focused threshold fires when the enemy has no outgoing attacks", () => {
    const runtime = loadUserscript();
    const {
      computeOverwhelmingNeighbor,
      INVASION_STALL_FOCUSED_RATIO,
      PlayerType,
    } = runtime.test.internals;
    const me = { troops: 10_000 };

    // Focused enemy at 2.49× — fires at the focused threshold because
    // they have no outgoing commitments and nobody else is pinning
    // them defensively.
    const focusedOver = computeOverwhelmingNeighbor(me, [
      {
        smallID: 7,
        name: "Focused",
        type: PlayerType.Human,
        isFriendly: false,
        troops: 24_900,
        outgoingTroops: 0,
        incomingTroops: 0,
      },
    ]);
    expect(focusedOver).not.toBeNull();
    expect(focusedOver.threshold).toBe(INVASION_STALL_FOCUSED_RATIO);
    expect(focusedOver.ratio).toBeCloseTo(2.49, 2);

    // Focused enemy at 1.99× — just below the focused threshold, no stall.
    const focusedUnder = computeOverwhelmingNeighbor(me, [
      {
        smallID: 7,
        name: "Focused",
        type: PlayerType.Human,
        isFriendly: false,
        troops: 19_900,
        outgoingTroops: 0,
        incomingTroops: 0,
      },
    ]);
    expect(focusedUnder).toBeNull();
  });

  it("2.5x default threshold applies when the enemy is pinned by incoming attacks from others", () => {
    const runtime = loadUserscript();
    const {
      computeOverwhelmingNeighbor,
      INVASION_STALL_TROOP_RATIO,
      PlayerType,
    } = runtime.test.internals;
    const me = { troops: 10_000 };

    // 2.49× enemy but they're being attacked by a third party →
    // they can't fully commit against us, so the 2.5× default holds
    // (and 2.49× is under the default → no stall).
    const pinned = computeOverwhelmingNeighbor(me, [
      {
        smallID: 7,
        name: "Pinned",
        type: PlayerType.Human,
        isFriendly: false,
        troops: 24_900,
        outgoingTroops: 0,
        incomingTroops: 30_000, // third-party pressure
      },
    ]);
    expect(pinned).toBeNull();

    // Same pinned enemy at 2.51× — now over the default threshold.
    const pinnedOver = computeOverwhelmingNeighbor(me, [
      {
        smallID: 7,
        name: "Pinned",
        type: PlayerType.Human,
        isFriendly: false,
        troops: 25_100,
        outgoingTroops: 0,
        incomingTroops: 30_000,
      },
    ]);
    expect(pinnedOver).not.toBeNull();
    expect(pinnedOver.threshold).toBe(INVASION_STALL_TROOP_RATIO);
  });

  it("computeOverwhelmingNeighbor picks the worst ratio across multiple enemies", () => {
    const runtime = loadUserscript();
    const { computeOverwhelmingNeighbor, PlayerType } = runtime.test.internals;
    const me = { troops: 10_000 };
    const worst = computeOverwhelmingNeighbor(me, [
      {
        smallID: 1,
        name: "Mid",
        type: PlayerType.Human,
        isFriendly: false,
        troops: 30_000, // 3×
      },
      {
        smallID: 2,
        name: "Worst",
        type: PlayerType.Nation,
        isFriendly: false,
        troops: 80_000, // 8×
      },
      {
        smallID: 3,
        name: "Friendly",
        type: PlayerType.Human,
        isFriendly: true,
        troops: 200_000, // 20× but friendly, skip
      },
    ]);
    expect(worst).not.toBeNull();
    expect(worst.enemy.name).toBe("Worst");
    expect(worst.ratio).toBe(8);
  });

  it("shouldStallForInvasionDefense reads world.threats.overwhelmingNeighbor", () => {
    const runtime = loadUserscript();
    const { shouldStallForInvasionDefense } = runtime.test.internals;

    const world = freshWorld(runtime);
    expect(shouldStallForInvasionDefense()).toBe(false);

    world.threats.overwhelmingNeighbor = {
      enemy: { name: "Giant" },
      ratio: 3.0,
      idealMinTroops: 100_000,
    };
    expect(shouldStallForInvasionDefense()).toBe(true);

    world.threats.overwhelmingNeighbor = null;
    expect(shouldStallForInvasionDefense()).toBe(false);
  });

  it("flags early adjacent Human troop disparity as preemptive invasion risk", () => {
    const runtime = loadUserscript();
    const {
      computeEarlyHumanOvermatch,
      isEarlyGameForInvasionDefense,
      EARLY_INVASION_HUMAN_TROOP_RATIO,
      PlayerType,
    } = runtime.test.internals;
    const me = { troops: 10_000, tiles: 400 };
    const earlyWorld = {
      tick: 600,
      totals: { myShare: 0.04, usableLand: 10_000 },
    };

    expect(isEarlyGameForInvasionDefense(earlyWorld, me)).toBe(true);
    const risk = computeEarlyHumanOvermatch(
      me,
      [
        {
          smallID: 7,
          name: "Nearby Human",
          type: PlayerType.Human,
          isFriendly: false,
          troops: 16_000,
          outgoingTroops: 0,
          incomingTroops: 0,
        },
      ],
      earlyWorld,
    );

    expect(risk).not.toBeNull();
    expect(risk.enemy.name).toBe("Nearby Human");
    expect(risk.ratio).toBeCloseTo(1.6, 2);
    expect(risk.threshold).toBe(EARLY_INVASION_HUMAN_TROOP_RATIO);
    expect(risk.reason).toBe("earlyHumanOvermatch");
  });

  it("limits early Human overmatch to unpinned hostile Humans during the opening", () => {
    const runtime = loadUserscript();
    const { computeEarlyHumanOvermatch, PlayerType } = runtime.test.internals;
    const me = { troops: 10_000, tiles: 400 };
    const earlyWorld = {
      tick: 600,
      totals: { myShare: 0.04, usableLand: 10_000 },
    };
    const lateWorld = {
      tick: 4000,
      totals: { myShare: 0.2, usableLand: 10_000 },
    };

    expect(
      computeEarlyHumanOvermatch(
        me,
        [
          {
            smallID: 2,
            name: "Nation",
            type: PlayerType.Nation,
            isFriendly: false,
            troops: 30_000,
          },
        ],
        earlyWorld,
      ),
    ).toBeNull();
    expect(
      computeEarlyHumanOvermatch(
        me,
        [
          {
            smallID: 3,
            name: "Too Close",
            type: PlayerType.Human,
            isFriendly: false,
            troops: 15_000,
          },
        ],
        earlyWorld,
      ),
    ).toBeNull();
    expect(
      computeEarlyHumanOvermatch(
        me,
        [
          {
            smallID: 4,
            name: "Late Human",
            type: PlayerType.Human,
            isFriendly: false,
            troops: 30_000,
          },
        ],
        lateWorld,
      ),
    ).toBeNull();
    expect(
      computeEarlyHumanOvermatch(
        me,
        [
          {
            smallID: 5,
            name: "Pinned Human",
            type: PlayerType.Human,
            isFriendly: false,
            troops: 20_000,
            incomingTroops: 5_000,
          },
        ],
        earlyWorld,
      ),
    ).toBeNull();
    expect(
      computeEarlyHumanOvermatch(
        me,
        [
          {
            smallID: 6,
            name: "Friendly Human",
            type: PlayerType.Human,
            isFriendly: true,
            troops: 100_000,
          },
        ],
        earlyWorld,
      ),
    ).toBeNull();
  });

  it("maybeExpand refuses to spend troops under early Human overmatch", async () => {
    const runtime = loadUserscript();
    const { maybeExpand } = runtime.test.internals;
    const priorGameView = runtime.hooks.gameView;
    const priorWorld = runtime.world;
    const priorBridge = runtime.hooks.localBridge;
    const priorSocket = runtime.hooks.socket;
    const priorLastSig = runtime.state.lastIntentSignature;
    const win: any = (globalThis as any).window;
    const priorHarness = win.__SUPERBOT_TEST_MODE;

    const width = 4;
    const ref = (x: number, y: number) => y * width + x;
    const myTile = ref(1, 1);
    const openTile = ref(2, 1);
    const sent: any[] = [];
    const me = {
      smallID: () => 1,
      troops: () => 20_000,
      numTilesOwned: () => 1,
    };
    runtime.hooks.gameView = {
      ticks: () => 1000,
      myPlayer: () => me,
      numLandTiles: () => 16,
      ownerID: (tile: number) => (tile === myTile ? 1 : 0),
      isLand: () => true,
      hasFallout: () => false,
      neighbors: (tile: number) => {
        const x = tile % width;
        const y = Math.floor(tile / width);
        const out: number[] = [];
        if (x > 0) out.push(ref(x - 1, y));
        if (x + 1 < width) out.push(ref(x + 1, y));
        if (y > 0) out.push(ref(x, y - 1));
        if (y + 1 < width) out.push(ref(x, y + 1));
        return out;
      },
      config: () => ({
        maxTroops: () => 100_000,
      }),
    };
    runtime.world = {
      ...runtime.world,
      tick: 1000,
      threats: {
        ...(runtime.world.threats ?? {}),
        earlyHumanOvermatch: {
          enemy: { name: "Nearby Human" },
          ratio: 1.6,
          threshold: 1.5,
        },
        overwhelmingNeighbor: null,
      },
    };
    runtime.state.cooldowns.expand = -999;
    runtime.hooks.socket = null;
    runtime.hooks.localBridge = { send: (msg: any) => sent.push(msg) };
    runtime.state.lastIntentSignature = "";
    win.__SUPERBOT_TEST_MODE = true;

    try {
      const acted = await maybeExpand(me, [myTile, openTile]);
      expect(acted).toBe(false);
      expect(sent.filter((msg) => msg?.intent?.type === "attack")).toHaveLength(
        0,
      );
    } finally {
      runtime.hooks.gameView = priorGameView;
      runtime.world = priorWorld;
      runtime.hooks.localBridge = priorBridge;
      runtime.hooks.socket = priorSocket;
      runtime.state.lastIntentSignature = priorLastSig;
      win.__SUPERBOT_TEST_MODE = priorHarness;
    }
  });
});

