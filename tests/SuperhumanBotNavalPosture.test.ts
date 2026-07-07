/**
 * Regression tests for the superhuman userscript's naval posture — the fix
 * for "sitting with open water, no warships, no invasions".
 *
 * Covered behaviours:
 *   1. Warship fleet target: a standing coastal screen hull once a port +
 *      gold cushion exist, an island floor of 2, and parity with enemy
 *      warships (capped) — parity is what unblocks isNavalInvasionSafe for
 *      our own transports.
 *   2. Cross-water prey: hostile players under NAVAL_PREY_TROOP_RATIO of
 *      our troops keep NAVAL_LAND_GRAB alive even when nobody is a
 *      SOFT_TARGET.
 *   3. Payload scaling: the boat payload grows to saturate the defender
 *      (1.1x their troops) instead of being silently capped at 30k, so big
 *      armies can actually launch invasions.
 *   4. runGoal_WarshipDefense dispatches a real build_unit intent.
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
  win.WebSocket = win.WebSocket ?? class {};
  win.Worker = win.Worker ?? class {};
  win.localStorage = win.localStorage ?? {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  new Function(source).call(win);
  cachedRuntime = win.__superhumanBotRuntime;
  return cachedRuntime;
}

function installWorld(runtime: any, overrides: any = {}) {
  const { UnitType } = runtime.test.internals;
  const me = {
    smallID: 1,
    name: "Me",
    id: "player-1",
    isMe: true,
    isFriendly: true,
    isAdjacent: false,
    troops: 60_000,
    maxTroops: 200_000,
    troopRatio: 0.3,
    tiles: 2_000,
    gold: 600_000,
    incomingTroops: 0,
    outgoingTroops: 0,
    structures: { [UnitType.Port]: 1, [UnitType.City]: 4 },
    structureLevels: {},
    ...(overrides.me ?? {}),
  };
  runtime.world = {
    ...runtime.world,
    tick: 5000,
    archetype: "CONTINENTAL",
    me,
    meSmallID: 1,
    everyone: [me, ...(overrides.others ?? [])],
    bySmallID: new Map(
      [me, ...(overrides.others ?? [])].map((e: any) => [e.smallID, e]),
    ),
    threats: {
      crownSmallID: null,
      crown: null,
      risingStars: [],
      softTargets: [],
      collapsingTargets: [],
      mirvCapable: [],
      adjacentEnemies: [],
      narrowWaterNeighbors: [],
      activeInvaders: [],
      brewingInvaders: [],
      invasionTroopsInbound: 0,
      inboundTroopTotal: 0,
      overwhelmingNeighbor: null,
      earlyHumanOvermatch: null,
      landFrontierOpen: true,
      diplomaticallySealed: null,
      ...(overrides.threats ?? {}),
    },
  };
  return runtime.world;
}

describe("computeWarshipFleetTarget", () => {
  it("keeps a standing screen hull for a coastal economy with gold to spare", () => {
    const runtime = loadUserscript();
    const { computeWarshipFleetTarget, UnitType } = runtime.test.internals;
    installWorld(runtime);
    const me = {
      structures: { [UnitType.Port]: 1, [UnitType.City]: 2 },
      gold: 500_000, // exactly 2x the first-warship cost
    };
    expect(computeWarshipFleetTarget(me, 0, 0)).toEqual({
      target: 1,
      reason: "screen",
    });
  });

  it("withholds the screen without a port, enough cities, or the gold cushion", () => {
    const runtime = loadUserscript();
    const { computeWarshipFleetTarget, UnitType } = runtime.test.internals;
    installWorld(runtime);
    const noPort = {
      structures: { [UnitType.Port]: 0, [UnitType.City]: 4 },
      gold: 900_000,
    };
    const oneCity = {
      structures: { [UnitType.Port]: 1, [UnitType.City]: 1 },
      gold: 900_000,
    };
    const broke = {
      structures: { [UnitType.Port]: 1, [UnitType.City]: 4 },
      gold: 499_999,
    };
    expect(computeWarshipFleetTarget(noPort, 0, 0).target).toBe(0);
    expect(computeWarshipFleetTarget(oneCity, 0, 0).target).toBe(0);
    expect(computeWarshipFleetTarget(broke, 0, 0).target).toBe(0);
  });

  it("scales the gold cushion with the escalating warship cost curve", () => {
    const runtime = loadUserscript();
    const { computeWarshipFleetTarget, estimateNextWarshipCost, UnitType } =
      runtime.test.internals;
    installWorld(runtime);
    // Second hull costs 500k -> cushion is 1M. (Mirrors DefaultConfig's
    // min(1M, (n+1) x 250k) curve.)
    expect(estimateNextWarshipCost(0)).toBe(250_000);
    expect(estimateNextWarshipCost(1)).toBe(500_000);
    expect(estimateNextWarshipCost(4)).toBe(1_000_000);
    const me = {
      structures: { [UnitType.Port]: 1, [UnitType.City]: 4 },
      gold: 999_999,
    };
    // weHave=1: cushion for hull #2 is 1M -> no screen top-up...
    expect(computeWarshipFleetTarget(me, 1, 0).target).toBe(0);
    // ...but parity with an enemy navy still applies regardless of gold.
    expect(computeWarshipFleetTarget(me, 1, 2)).toEqual({
      target: 2,
      reason: "parity",
    });
  });

  it("matches enemy warships up to the fleet cap and floors ISLAND maps at 2", () => {
    const runtime = loadUserscript();
    const { computeWarshipFleetTarget, WARSHIP_FLEET_CAP, UnitType } =
      runtime.test.internals;
    const world = installWorld(runtime);
    const me = {
      structures: { [UnitType.Port]: 1, [UnitType.City]: 4 },
      gold: 600_000,
    };
    expect(computeWarshipFleetTarget(me, 0, 8)).toEqual({
      target: WARSHIP_FLEET_CAP,
      reason: "parity",
    });
    world.archetype = "ISLAND";
    expect(computeWarshipFleetTarget(me, 0, 0)).toEqual({
      target: 2,
      reason: "island",
    });
  });
});

describe("findNavalPreyTargets", () => {
  it("returns weakest-first hostiles under the prey ratio, skipping friendly/adjacent/dead", () => {
    const runtime = loadUserscript();
    const { findNavalPreyTargets, NAVAL_PREY_TROOP_RATIO } =
      runtime.test.internals;
    expect(NAVAL_PREY_TROOP_RATIO).toBe(0.3);
    const world = installWorld(runtime, {
      others: [
        {
          smallID: 2,
          name: "Mid",
          isFriendly: false,
          isAdjacent: false,
          tiles: 500,
          troops: 15_000,
        },
        {
          smallID: 3,
          name: "Tiny",
          isFriendly: false,
          isAdjacent: false,
          tiles: 200,
          troops: 4_000,
        },
        {
          smallID: 4,
          name: "TooBig",
          isFriendly: false,
          isAdjacent: false,
          tiles: 900,
          troops: 30_000,
        },
        {
          smallID: 5,
          name: "Ally",
          isFriendly: true,
          isAdjacent: false,
          tiles: 500,
          troops: 1_000,
        },
        {
          smallID: 6,
          name: "LandNeighbor",
          isFriendly: false,
          isAdjacent: true,
          tiles: 500,
          troops: 1_000,
        },
        {
          smallID: 7,
          name: "Dead",
          isFriendly: false,
          isAdjacent: false,
          tiles: 0,
          troops: 1_000,
        },
      ],
    });
    const prey = findNavalPreyTargets(world.me); // me.troops = 60k -> cutoff 18k
    expect(prey.map((p: any) => p.name)).toEqual(["Tiny", "Mid"]);
  });
});

describe("runGoal_NavalLandGrab payload scaling", () => {
  // Grid: 40x20. Our island on the left (x<=12), water strip, prey island
  // on the right (x>=25). All prey tiles owned by smallID 2.
  const W = 40;
  const H = 20;
  const ref = (x: number, y: number) => y * W + x;
  const xOf = (t: number) => t % W;
  const yOf = (t: number) => Math.floor(t / W);

  function stubGameView(runtime: any, me: any) {
    runtime.hooks.gameView = {
      ticks: () => 6000,
      myPlayer: () => me,
      width: () => W,
      height: () => H,
      numLandTiles: () => 500,
      isValidCoord: (x: number, y: number) =>
        x >= 0 && y >= 0 && x < W && y < H,
      ref,
      x: xOf,
      y: yOf,
      isLand: (t: number) => xOf(t) <= 12 || xOf(t) >= 25,
      ownerID: (t: number) => (xOf(t) <= 12 ? 1 : xOf(t) >= 25 ? 2 : 0),
      manhattanDist: (a: number, b: number) =>
        Math.abs(xOf(a) - xOf(b)) + Math.abs(yOf(a) - yOf(b)),
      euclideanDistSquared: (a: number, b: number) => {
        const dx = xOf(a) - xOf(b);
        const dy = yOf(a) - yOf(b);
        return dx * dx + dy * dy;
      },
      neighbors: (t: number) => {
        const out: number[] = [];
        const x = xOf(t);
        const y = yOf(t);
        if (x > 0) out.push(ref(x - 1, y));
        if (x < W - 1) out.push(ref(x + 1, y));
        if (y > 0) out.push(ref(x, y - 1));
        if (y < H - 1) out.push(ref(x, y + 1));
        return out;
      },
      nearbyUnits: () => [], // no enemy warships on the route
      config: () => ({
        numSpawnPhaseTurns: () => 100,
        boatMaxNumber: () => 3,
        maxTroops: () => 400_000,
        isUnitDisabled: () => false,
      }),
    };
  }

  it("ships a saturation payload (1.1x defender) instead of capping at 30k", async () => {
    const runtime = loadUserscript();
    const { runGoal_NavalLandGrab } = runtime.test.internals;

    const me: any = {
      smallID: () => 1,
      isAlive: () => true,
      troops: () => 200_000,
      numTilesOwned: () => 2_000,
      gold: () => 100_000,
      isFriendly: () => false,
      unitCount: () => 1,
      units: () => [], // no transports in flight
      bestTransportShipSpawn: async (dst: number) => ref(12, yOf(dst)),
    };
    stubGameView(runtime, me);
    const preyPlayer = { units: () => [] };
    installWorld(runtime, {
      me: { troops: 200_000, maxTroops: 400_000, tiles: 2_000 },
      others: [
        {
          smallID: 2,
          name: "OverseasPrey",
          isFriendly: false,
          isAdjacent: false,
          tiles: 600,
          troops: 40_000, // 0.2x our troops: prey, but above the old 30k cap
          player: preyPlayer,
        },
      ],
    });

    const sent: any[] = [];
    const win: any = (globalThis as any).window;
    const priorHarness = win.__SUPERBOT_TEST_MODE;
    const priorSocket = runtime.hooks.socket;
    const priorBridge = runtime.hooks.localBridge;
    const priorLastSig = runtime.state.lastIntentSignature;
    win.__SUPERBOT_TEST_MODE = true;
    runtime.hooks.socket = null;
    runtime.hooks.localBridge = { send: (msg: any) => sent.push(msg) };
    runtime.state.lastIntentSignature = "";
    runtime.state.cooldowns.naval = -999;
    runtime.state.routeCooldowns = new Map();
    runtime.state.sentBoats = new Map();
    runtime.state.lostBoatBySmallID = new Map();

    try {
      const acted = await runGoal_NavalLandGrab(me);
      expect(acted).toBe(true);
      const boats = sent.filter((m) => m?.intent?.type === "boat");
      expect(boats).toHaveLength(1);
      // Saturation payload: 1.1 x 40k = 44k (old behaviour: hard 30k cap
      // -> the guard `payload < defender troops` skipped this target).
      expect(boats[0].intent.troops).toBe(44_000);
      // The destination is on the prey's island.
      expect(xOf(boats[0].intent.dst)).toBeGreaterThanOrEqual(25);
    } finally {
      win.__SUPERBOT_TEST_MODE = priorHarness;
      runtime.hooks.socket = priorSocket;
      runtime.hooks.localBridge = priorBridge;
      runtime.state.lastIntentSignature = priorLastSig;
    }
  });
});

describe("runGoal_WarshipDefense", () => {
  it("dispatches a warship build near our port", async () => {
    const runtime = loadUserscript();
    const { runGoal_WarshipDefense, UnitType } = runtime.test.internals;

    const W = 20;
    const ref = (x: number, y: number) => y * W + x;
    const portTile = ref(5, 5);
    const oceanTile = ref(8, 5);

    const portUnit = {
      type: () => UnitType.Port,
      tile: () => portTile,
      isActive: () => true,
      isUnderConstruction: () => false,
    };
    const me: any = {
      smallID: () => 1,
      isAlive: () => true,
      troops: () => 50_000,
      gold: () => 600_000,
      units: (t: string) => (t === UnitType.Port ? [portUnit] : []),
      buildables: async (tile: number, units: string[]) =>
        units.map((u) => ({
          type: u,
          canBuild: u === UnitType.Warship ? tile : false,
          canUpgrade: false,
          cost: 250_000,
        })),
    };
    runtime.hooks.gameView = {
      ticks: () => 6000,
      myPlayer: () => me,
      config: () => ({
        isUnitDisabled: () => false,
        maxTroops: () => 200_000,
      }),
      circleSearch: (_center: number, _radius: number) =>
        new Set([oceanTile, ref(9, 5), ref(10, 5)]),
      isOcean: (t: number) => t >= ref(8, 5),
    };
    installWorld(runtime);

    const sent: any[] = [];
    const win: any = (globalThis as any).window;
    const priorHarness = win.__SUPERBOT_TEST_MODE;
    const priorSocket = runtime.hooks.socket;
    const priorBridge = runtime.hooks.localBridge;
    const priorLastSig = runtime.state.lastIntentSignature;
    win.__SUPERBOT_TEST_MODE = true;
    runtime.hooks.socket = null;
    runtime.hooks.localBridge = { send: (msg: any) => sent.push(msg) };
    runtime.state.lastIntentSignature = "";
    runtime.state.cooldowns.warship = -999;

    try {
      const acted = await runGoal_WarshipDefense(me);
      expect(acted).toBe(true);
      const builds = sent.filter(
        (m) =>
          m?.intent?.type === "build_unit" &&
          m.intent.unit === UnitType.Warship,
      );
      expect(builds).toHaveLength(1);
    } finally {
      win.__SUPERBOT_TEST_MODE = priorHarness;
      runtime.hooks.socket = priorSocket;
      runtime.hooks.localBridge = priorBridge;
      runtime.state.lastIntentSignature = priorLastSig;
    }
  });
});

describe("maybeMaintainWarshipFleet (always-on upkeep pass)", () => {
  function makeSetup(runtime: any, opts: { buildable: boolean }) {
    const { UnitType } = runtime.test.internals;
    const W = 20;
    const ref = (x: number, y: number) => y * W + x;
    const portTile = ref(5, 5);
    const portUnit = {
      type: () => UnitType.Port,
      tile: () => portTile,
      isActive: () => true,
      isUnderConstruction: () => false,
    };
    const me: any = {
      smallID: () => 1,
      isAlive: () => true,
      troops: () => 50_000,
      gold: () => 600_000,
      units: (t: string) => (t === UnitType.Port ? [portUnit] : []),
      buildables: async (tile: number, units: string[]) =>
        units.map((u) => ({
          type: u,
          canBuild: opts.buildable && u === UnitType.Warship ? tile : false,
          canUpgrade: false,
          cost: 250_000,
        })),
    };
    runtime.hooks.gameView = {
      ticks: () => 6000,
      myPlayer: () => me,
      config: () => ({
        isUnitDisabled: () => false,
        maxTroops: () => 200_000,
      }),
      circleSearch: () => new Set([ref(8, 5), ref(9, 5)]),
      isOcean: () => true,
    };
    installWorld(runtime); // world.me has Port 1, City 4, gold 600k
    return me;
  }

  it("floats a hull when under the fleet target, and no-ops once it is met", async () => {
    const runtime = loadUserscript();
    const { maybeMaintainWarshipFleet, UnitType } = runtime.test.internals;
    const me = makeSetup(runtime, { buildable: true });

    const sent: any[] = [];
    const win: any = (globalThis as any).window;
    const priorHarness = win.__SUPERBOT_TEST_MODE;
    const priorSocket = runtime.hooks.socket;
    const priorBridge = runtime.hooks.localBridge;
    const priorLastSig = runtime.state.lastIntentSignature;
    win.__SUPERBOT_TEST_MODE = true;
    runtime.hooks.socket = null;
    runtime.hooks.localBridge = { send: (msg: any) => sent.push(msg) };
    runtime.state.lastIntentSignature = "";
    runtime.state.cooldowns.warship = -999;

    try {
      // Deficit (0/1 screen hull) -> builds.
      expect(await maybeMaintainWarshipFleet(me)).toBe(true);
      expect(
        sent.filter(
          (m) =>
            m?.intent?.type === "build_unit" &&
            m.intent.unit === UnitType.Warship,
        ),
      ).toHaveLength(1);

      // Fleet target met -> cheap no-op (cooldown reset to allow the call).
      runtime.state.cooldowns.warship = -999;
      const warship = {
        type: () => UnitType.Warship,
        isActive: () => true,
        isUnderConstruction: () => false,
      };
      const priorUnits = me.units;
      me.units = (t: string) =>
        t === UnitType.Warship ? [warship] : priorUnits(t);
      expect(await maybeMaintainWarshipFleet(me)).toBe(false);
    } finally {
      win.__SUPERBOT_TEST_MODE = priorHarness;
      runtime.hooks.socket = priorSocket;
      runtime.hooks.localBridge = priorBridge;
      runtime.state.lastIntentSignature = priorLastSig;
    }
  });

  it("backs off for a maintenance interval when no ocean tile is buildable", async () => {
    const runtime = loadUserscript();
    const { maybeMaintainWarshipFleet } = runtime.test.internals;
    const me = makeSetup(runtime, { buildable: false });
    runtime.state.cooldowns.warship = -999;
    expect(await maybeMaintainWarshipFleet(me)).toBe(false);
    // Failure arms the cooldown so the next tick is a cheap no-op.
    expect(runtime.state.cooldowns.warship).toBe(6000);
  });
});

describe("planner naval scenarios (scripted suite)", () => {
  it("passes the built-in warship/prey selection scenarios", () => {
    const runtime = loadUserscript();
    const summary = runtime.test.runSuite();
    const names = [
      "coastal port + gold cushion + no hulls -> WARSHIP_DEFENSE",
      "enemy warships -> WARSHIP_DEFENSE parity",
      "warship parity note reports fleet target 0/2",
      "cross-water overmatch prey -> NAVAL_LAND_GRAB",
      "warship fleet tiers",
    ];
    for (const prefix of names) {
      const result = summary.results.find((r: any) =>
        r.name.startsWith(prefix),
      );
      expect(result, `scenario "${prefix}" should be in suite`).toBeDefined();
      expect(
        result.pass,
        `scenario "${prefix}": expected=${result.expected}, actual=${result.actual}`,
      ).toBe(true);
    }
  });
});
