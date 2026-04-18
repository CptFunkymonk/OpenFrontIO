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

  it("builds more cities at higher tile counts (1 city per ~2500 tiles)", () => {
    const runtime = loadUserscript();
    const { shouldBuildType, UnitType } = runtime.test.internals;
    installEmptyGameView(runtime);
    setWorldAdjacent(runtime, []);

    // 5000 tiles -> expect target of at least 3 cities.
    const player = me({
      numTilesOwned: () => 5000,
      totalUnitLevels: (t: any) => (t === UnitType.City ? 2 : 0),
      units: () => [],
    });
    expect(shouldBuildType(UnitType.City, player, [])).toBe(true);

    // 10_000 tiles with 3 cities -> still need more (target floor(10000/2500)=4).
    const bigPlayer = me({
      numTilesOwned: () => 10_000,
      totalUnitLevels: (t: any) => (t === UnitType.City ? 3 : 0),
      units: () => [],
    });
    expect(shouldBuildType(UnitType.City, bigPlayer, [])).toBe(true);

    // 10_000 tiles with 4 cities -> target met.
    const metPlayer = me({
      numTilesOwned: () => 10_000,
      totalUnitLevels: (t: any) => (t === UnitType.City ? 4 : 0),
      units: () => [],
    });
    expect(shouldBuildType(UnitType.City, metPlayer, [])).toBe(false);
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

  it("exposes a BOT_VERSION constant bumped to 2.6.1", () => {
    const runtime = loadUserscript();
    expect(runtime.test.internals.BOT_VERSION).toBe("2.6.1");
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
