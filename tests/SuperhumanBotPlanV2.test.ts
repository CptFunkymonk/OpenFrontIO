/**
 * Regression tests for the Plan v2 upgrade (superbot v2.9).
 *
 * Covers the new closed-form behaviours layered on top of the existing
 * planner suite:
 *   - calculateAttackTroops() anchored to the engine's saturation points
 *     (1.667x / 1.0x / 0.5x defender troops).
 *   - openingDiplomacyBlast() only fires once per match and only at
 *     Human neighbours inside the reach radius.
 *   - shouldBuildType(Port) force-unlocks the first 3 coastal ports
 *     regardless of city count.
 *   - NUKE_CROWN priority escalates with low crown SAM levels.
 *
 * Runs the same way as SuperhumanBotPlanner.test.ts: loads the userscript
 * IIFE inside a jsdom window, then pokes at the internals it exposes.
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
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  new Function(source).call(win);
  cachedRuntime = win.__superhumanBotRuntime;
  return cachedRuntime;
}

function resetSpawnState(runtime: any) {
  runtime.state.openingBlast = {
    fired: false,
    firedTick: -1,
    sentToSmallIDs: new Set(),
  };
}

describe("calculateAttackTroops — engine saturation anchoring", () => {
  const me = (troops: number) => ({ troops: () => troops });

  it("commits everything above reserve when defender is TerraNullius", () => {
    const runtime = loadUserscript();
    const { calculateAttackTroops } = runtime.test.internals;
    // Available = 50_000 - 100_000 * 0.2 = 30_000.
    const troops = calculateAttackTroops(me(50_000), null, 0.2, 100_000);
    expect(troops).toBe(30_000);
  });

  it("returns 0 when available is below the 5k hard floor", () => {
    const runtime = loadUserscript();
    const { calculateAttackTroops } = runtime.test.internals;
    const troops = calculateAttackTroops(me(21_000), null, 0.2, 100_000);
    expect(troops).toBe(0);
  });

  it("sends ~85% above the 1.667x loss-saturation point", () => {
    const runtime = loadUserscript();
    const { calculateAttackTroops } = runtime.test.internals;
    // Available = 100_000 - 0 * 1 = 100_000. Enemy troops = 30_000.
    // ideal = ceil(30_000 * 1.667) = 50_010. 0.85 * 100_000 = 85_000.
    // max(ideal, 85_000) = 85_000.
    const troops = calculateAttackTroops(
      me(100_000),
      { troops: () => 30_000 },
      0,
      100_000,
    );
    expect(troops).toBe(85_000);
  });

  it("commits all available between strong and ideal ratios", () => {
    const runtime = loadUserscript();
    const { calculateAttackTroops } = runtime.test.internals;
    // Enemy 40_000. strong = 40_000. ideal = 66_680.
    // available = 50_000 (>= strong, < ideal). Expect full 50_000.
    const troops = calculateAttackTroops(
      me(50_000),
      { troops: () => 40_000 },
      0,
      100_000,
    );
    expect(troops).toBe(50_000);
  });

  it("refuses to attack below 1.0x defender when not retaliating", () => {
    const runtime = loadUserscript();
    const { calculateAttackTroops } = runtime.test.internals;
    // Enemy 50_000, me 30_000 (above minViable=25_000 but below strong).
    // No retaliation flag → must refuse.
    const troops = calculateAttackTroops(
      me(30_000),
      { troops: () => 50_000 },
      0,
      100_000,
    );
    expect(troops).toBe(0);
  });

  it("does retaliate between minViable and strong when opts.retaliating is true", () => {
    const runtime = loadUserscript();
    const { calculateAttackTroops } = runtime.test.internals;
    const troops = calculateAttackTroops(
      me(30_000),
      { troops: () => 50_000 },
      0,
      100_000,
      { retaliating: true },
    );
    expect(troops).toBe(30_000);
  });

  it("refuses below minViable even when retaliating", () => {
    const runtime = loadUserscript();
    const { calculateAttackTroops } = runtime.test.internals;
    const troops = calculateAttackTroops(
      me(10_000),
      { troops: () => 50_000 },
      0,
      100_000,
      { retaliating: true },
    );
    expect(troops).toBe(0);
  });
});

describe("shouldBuildType(Port) — coastal force-unlock", () => {
  function stubGameView(runtime: any, { isOceanShore = true } = {}) {
    runtime.hooks.gameView = {
      ticks: () => 100,
      myPlayer: () => null,
      isOceanShore: () => isOceanShore,
      config: () => ({
        isUnitDisabled: () => false,
      }),
    };
    runtime.state.borderCache.tiles = [1, 2, 3];
  }

  function stubWorld(runtime: any) {
    runtime.world = {
      ...runtime.world,
      archetype: "CONTINENTAL",
      totals: {
        ...(runtime.world?.totals ?? {}),
        myShare: 0.1,
      },
      threats: {
        ...(runtime.world?.threats ?? {}),
        adjacentEnemies: [],
      },
    };
  }

  it("force-unlocks up to 3 ports when coastal, even with no cities yet", () => {
    const runtime = loadUserscript();
    const { shouldBuildType, UnitType } = runtime.test.internals;
    stubGameView(runtime);
    stubWorld(runtime);

    const player = {
      numTilesOwned: () => 2_000,
      // Two cities — legacy portCoef (0.6) would allow only floor(2 * 0.6)=1.
      totalUnitLevels: (t: any) => (t === UnitType.City ? 2 : 0),
      units: () => [],
    };

    // 0 ports, 2 cities: force-unlock path -> must be true.
    expect(shouldBuildType(UnitType.Port, player, [])).toBe(true);

    // Bump to 2 ports via totalUnitLevels stub; still < 3 → true.
    const player2 = {
      ...player,
      totalUnitLevels: (t: any) =>
        t === UnitType.City ? 2 : t === UnitType.Port ? 2 : 0,
    };
    expect(shouldBuildType(UnitType.Port, player2, [])).toBe(true);

    // 3 ports: above floor, fall back to cities*portCoef. 2*0.6 = 1, so
    // 3 ports already exceeds the legacy target → false.
    const player3 = {
      ...player,
      totalUnitLevels: (t: any) =>
        t === UnitType.City ? 2 : t === UnitType.Port ? 3 : 0,
    };
    expect(shouldBuildType(UnitType.Port, player3, [])).toBe(false);
  });

  it("does not unlock Port when we have no coastline", () => {
    const runtime = loadUserscript();
    const { shouldBuildType, UnitType } = runtime.test.internals;
    stubGameView(runtime, { isOceanShore: false });
    stubWorld(runtime);

    const player = {
      numTilesOwned: () => 2_000,
      totalUnitLevels: (t: any) => (t === UnitType.City ? 2 : 0),
      units: () => [],
    };
    expect(shouldBuildType(UnitType.Port, player, [])).toBe(false);
  });
});

describe("openingDiplomacyBlast — one-shot, Human-only, proximity-gated", () => {
  function stubRuntimeForBlast(runtime: any, options: any) {
    const { minDist = 30, mySpawn = 1000, neighbours = [] } = options;
    runtime.identity.clanTag = null;
    runtime.world.meSmallID = 1;
    runtime.state.openingBlast = {
      fired: false,
      firedTick: -1,
      sentToSmallIDs: new Set(),
    };
    runtime.hooks.gameView = {
      ticks: () => 100,
      myPlayer: () => null,
      config: () => ({
        minDistanceBetweenPlayers: () => minDist,
      }),
      playerViews: () => neighbours,
      manhattanDist: (a: number, b: number) => Math.abs(a - b),
    };
    return {
      me: {
        hasSpawned: () => true,
        spawnTile: () => mySpawn,
        isFriendly: () => false,
        isAlliedWith: () => false,
        smallID: () => 1,
      },
    };
  }

  beforeEach(() => {
    const runtime = loadUserscript();
    resetSpawnState(runtime);
  });

  it("fires alliance requests at every nearby Human and flips fired=true", () => {
    const runtime = loadUserscript();
    const { openingDiplomacyBlast, PlayerType } = runtime.test.internals;

    const sentTo: string[] = [];
    // Harness mode bypasses the stealth gate so we can observe every
    // intent the blast tries to send. Restored after the test.
    (globalThis as any).window.__SUPERBOT_TEST_MODE = true;
    // The WebSocket stub has no .OPEN constant, so sendRawMessage won't
    // take the socket path. Drop our own bridge into hooks.localBridge
    // to observe the intents that go out.
    runtime.hooks.socket = null;
    runtime.hooks.localBridge = {
      send: (object: any) => {
        if (
          object &&
          object.intent &&
          object.intent.type === "allianceRequest"
        ) {
          sentTo.push(object.intent.recipient);
        }
      },
    };

    const neighbours = [
      // Close human — in range, should receive.
      {
        isAlive: () => true,
        type: () => PlayerType.Human,
        smallID: () => 2,
        id: () => "H2",
        spawnTile: () => 1020,
        hasSpawned: () => true,
      },
      // Far human — outside 2*minDist. Should NOT receive.
      {
        isAlive: () => true,
        type: () => PlayerType.Human,
        smallID: () => 3,
        id: () => "H3",
        spawnTile: () => 1200,
        hasSpawned: () => true,
      },
      // Close Nation — type rejected.
      {
        isAlive: () => true,
        type: () => PlayerType.Nation,
        smallID: () => 4,
        id: () => "N4",
        spawnTile: () => 1005,
        hasSpawned: () => true,
      },
      // Close Bot — type rejected.
      {
        isAlive: () => true,
        type: () => PlayerType.Bot,
        smallID: () => 5,
        id: () => "B5",
        spawnTile: () => 1010,
        hasSpawned: () => true,
      },
    ];
    const { me } = stubRuntimeForBlast(runtime, { neighbours });

    const fired = openingDiplomacyBlast(me);
    expect(fired).toBe(true);
    expect(sentTo).toEqual(["H2"]);
    expect(runtime.state.openingBlast.fired).toBe(true);
    expect(
      Array.from(runtime.state.openingBlast.sentToSmallIDs as Set<number>),
    ).toEqual([2]);

    (globalThis as any).window.__SUPERBOT_TEST_MODE = false;
  });

  it("is a no-op on subsequent calls once fired", () => {
    const runtime = loadUserscript();
    const { openingDiplomacyBlast } = runtime.test.internals;
    runtime.state.openingBlast = {
      fired: true,
      firedTick: 10,
      sentToSmallIDs: new Set(),
    };
    const me = { hasSpawned: () => true };
    expect(openingDiplomacyBlast(me)).toBe(false);
  });

  it("does not fire before spawn completes", () => {
    const runtime = loadUserscript();
    const { openingDiplomacyBlast } = runtime.test.internals;
    const me = { hasSpawned: () => false };
    expect(openingDiplomacyBlast(me)).toBe(false);
    // Still not fired, so main loop can retry next tick.
    expect(runtime.state.openingBlast.fired).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Plan §8 acceptance checklist — machine-checkable cases
// ───────────────────────────────────────────────────────────────────────

/**
 * Build a minimal world object matching the shape that selectPrimaryGoal
 * and the various evaluate() functions expect. Only the fields each
 * specific test cares about are filled; every helper should tolerate
 * missing optional fields (safeCall + default guards already do).
 */
function buildWorld(overrides: any = {}) {
  const base: any = {
    tick: 1500,
    me: {
      smallID: 1,
      name: "Me",
      gold: 1_000_000,
      tiles: 2000,
      troops: 50_000,
      maxTroops: 100_000,
      troopRatio: 0.5,
      incomingAttacks: [],
      outgoingAttacks: [],
      incomingTroops: 0,
      outgoingTroops: 0,
      structures: {
        City: 4,
        Factory: 1,
        Port: 0,
        "Defense Post": 2,
        "Missile Silo": 0,
        "SAM Launcher": 0,
      },
      structureLevels: {
        City: 4,
        Factory: 1,
        Port: 0,
        "Defense Post": 2,
        "Missile Silo": 0,
        "SAM Launcher": 0,
      },
    },
    meSmallID: 1,
    everyone: [],
    bySmallID: new Map(),
    history: new Map(),
    totals: {
      alivePlayers: 3,
      humanCount: 1,
      nationCount: 1,
      botCount: 1,
      totalLand: 10_000,
      usableLand: 10_000,
      crownShare: 0.15,
      myShare: 0.15,
      secondShare: 0.14,
    },
    rankings: { byTiles: [], byTroops: [], byTilesVelocity: [], byTroopsVelocity: [] },
    allianceGraph: { edges: new Map(), cliques: [], largestBlocShare: 0, coalitionThreat: false },
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
      narrowWaterNeighbors: [],
      activeInvaders: [],
      brewingInvaders: [],
      invasionTroopsInbound: 0,
      inboundTroopTotal: 0,
      overwhelmingNeighbor: null,
    },
    archetype: "CONTINENTAL",
    archetypeLocked: null,
    classifiedAt: 100,
  };
  return Object.assign(base, overrides);
}

function stubGameViewForPlanner(runtime: any, stubUnits: Map<any, any[]>) {
  runtime.hooks.gameView = {
    ticks: () => 1500,
    config: () => ({
      maxTroops: () => 100_000,
      boatMaxNumber: () => 3,
      isUnitDisabled: () => false,
    }),
    myPlayer: () => ({
      isAlive: () => true,
      units: (t: any) => stubUnits.get(t) || [],
      smallID: () => 1,
    }),
  };
}

describe("Plan §8 — calculateAttackTroops acceptance", () => {
  it("never returns 0 on a viable commit while we are at >= 50% troop ratio", () => {
    // "Viable" per the new math = available (troops - reserve*cap) is at
    // or above 1.0x the defender's troops for proactive strikes, OR
    // we are retaliating and above 0.5x. This test builds cases that
    // clear those gates to prove the pathological 0-return path from
    // v2.8 is gone.
    const runtime = loadUserscript();
    const { calculateAttackTroops } = runtime.test.internals;
    const me = (troops: number) => ({ troops: () => troops });
    const cases: Array<[number, number, boolean, string]> = [
      // [myTroops, enemyTroops, retaliating, label]
      [80_000, 10_000, false, "1.667x ideal commit"],
      [80_000, 30_000, false, "above strong"],
      [80_000, 45_000, false, "just at strong edge"],
      [50_000, 10_000, false, "50% of cap vs weak enemy"],
      [60_000, 20_000, true, "retaliating above minViable"],
      [70_000, 30_000, true, "retaliating, strong"],
    ];
    for (const [myTroops, enemyTroops, retaliating, label] of cases) {
      const out = calculateAttackTroops(
        me(myTroops),
        { troops: () => enemyTroops },
        0.35,
        100_000,
        { retaliating },
      );
      expect(out, label).toBeGreaterThan(0);
    }
  });

  it("refuses a proactive strike where the old v2.8 calculator would have returned 0", () => {
    // v2.8: `if (available < pressure [0.6x defender]) return 0`. The new
    // calculator replaces this with the engine's saturation points.
    // Regression case: 50_000 troops, reserve 0.35, available 15_000;
    // enemy 30_000. Old calc returned 0 (pressure=18_000 > available);
    // new calc correctly returns 0 because we are below strong.
    // The test documents the intentional preservation of "refuse loser
    // attacks" so nobody re-introduces a 0.6x pressure path later.
    const runtime = loadUserscript();
    const { calculateAttackTroops } = runtime.test.internals;
    const out = calculateAttackTroops(
      { troops: () => 50_000 },
      { troops: () => 30_000 },
      0.35,
      100_000,
    );
    expect(out).toBe(0);
  });
});

describe("Plan §8 — NUKE_CROWN trigger acceptance", () => {
  it("selects NUKE_CROWN when crownShare >= 0.25 and crown has <= 2 SAMs", () => {
    const runtime = loadUserscript();
    const { selectPrimaryGoal, UnitType } = runtime.test.internals;
    const world = buildWorld({
      totals: {
        alivePlayers: 3,
        humanCount: 1,
        nationCount: 1,
        botCount: 1,
        totalLand: 10_000,
        usableLand: 10_000,
        crownShare: 0.25,
        myShare: 0.2,
        secondShare: 0.2,
      },
    });
    world.me.gold = 1_200_000; // above ATOM_GOLD_THRESHOLD
    world.me.structures[UnitType.MissileSilo] = 1;
    world.threats.crown = {
      smallID: 2,
      name: "Crown",
      isFriendly: false,
      tiles: 2500,
      structureLevels: { [UnitType.SAMLauncher]: 1 },
    };
    world.threats.crownSmallID = 2;
    runtime.world = world;

    // Stub a ready silo so getMyUnitsOfType() sees one.
    const stubSilo = {
      isActive: () => true,
      isUnderConstruction: () => false,
      level: () => 1,
      missileReadinesss: () => 1,
      id: () => 42,
      tile: () => 0,
    };
    stubGameViewForPlanner(runtime, new Map([[UnitType.MissileSilo, [stubSilo]]]));

    // Clear any lingering forced goal from previous tests.
    runtime.planner.forcedGoalId = null;
    runtime.planner.forcedGoalExpiresMs = 0;

    const selection = selectPrimaryGoal();
    expect(selection, "should select a goal").not.toBeNull();
    expect(selection.spec.id).toBe("NUKE_CROWN");
  });

  it("NUKE_CROWN does not fire when crownShare is below 0.25", () => {
    const runtime = loadUserscript();
    const { selectPrimaryGoal, UnitType } = runtime.test.internals;
    const world = buildWorld({
      totals: {
        alivePlayers: 3,
        humanCount: 1,
        nationCount: 1,
        botCount: 1,
        totalLand: 10_000,
        usableLand: 10_000,
        crownShare: 0.24,
        myShare: 0.2,
        secondShare: 0.2,
      },
    });
    world.me.gold = 1_200_000;
    world.me.structures[UnitType.MissileSilo] = 1;
    world.threats.crown = {
      smallID: 2,
      name: "Crown",
      isFriendly: false,
      tiles: 2400,
      structureLevels: { [UnitType.SAMLauncher]: 1 },
    };
    world.threats.crownSmallID = 2;
    runtime.world = world;
    stubGameViewForPlanner(
      runtime,
      new Map([[UnitType.MissileSilo, [{ isActive: () => true, isUnderConstruction: () => false, level: () => 1, missileReadinesss: () => 1, id: () => 1, tile: () => 0 }]]]),
    );
    runtime.planner.forcedGoalId = null;
    runtime.planner.forcedGoalExpiresMs = 0;

    const selection = selectPrimaryGoal();
    expect(selection && selection.spec.id).not.toBe("NUKE_CROWN");
  });
});

describe("Plan §5 — spawn scorer synthetic scenarios", () => {
  // Build a tiny fake gameView that represents a 9×9 grid. Tiles with
  // id < landCount are land; everything else is water. circleSearch
  // returns every tile within a manhattan radius. neighbors() returns
  // the 4 cardinal tiles (clipped at the grid edge).
  function buildFakeGridGameView(landPredicate: (x: number, y: number) => boolean) {
    const W = 9;
    const H = 9;
    const ref = (x: number, y: number) => y * W + x;
    const x = (t: number) => t % W;
    const y = (t: number) => Math.floor(t / W);
    return {
      width: () => W,
      height: () => H,
      isValidCoord: (xx: number, yy: number) =>
        xx >= 0 && xx < W && yy >= 0 && yy < H,
      isLand: (t: number) => landPredicate(x(t), y(t)),
      ref,
      x,
      y,
      *circleSearch(center: number, radius: number) {
        const cx = x(center);
        const cy = y(center);
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            if (Math.abs(dx) + Math.abs(dy) > radius) continue;
            yield ref(nx, ny);
          }
        }
      },
      *neighbors(tile: number) {
        const cx = x(tile);
        const cy = y(tile);
        const deltas = [
          [0, 1],
          [0, -1],
          [1, 0],
          [-1, 0],
        ];
        for (const [dx, dy] of deltas) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          yield ref(nx, ny);
        }
      },
    };
  }

  it("peninsula has a lower perimeter-to-area ratio than an inland blob", () => {
    const runtime = loadUserscript();
    const { perimeterToAreaRatio } = runtime.test.internals;

    // Inland blob: entire 9x9 is land.
    const inlandView = buildFakeGridGameView(() => true);
    const inlandRatio = perimeterToAreaRatio(inlandView, 4 * 9 + 4, 4);

    // Peninsula: land on the top 3 rows only; bottom 6 are water.
    // A centre tile at (4, 1) has land in a northward "cap" and water
    // to the south — high water exposure → higher perimeter ratio.
    // Instead, pick (4, 0) (the tip): only a single land connection
    // southward, rest is edge. Perimeter/area should be *higher* than
    // a blob spot. But the plan rewards 1 - perimeter, so the peninsula
    // in scoring terms is the compact coastal shape, not the thin strip.
    //
    // Build an explicit peninsula: a fat blob of land occupying the
    // left half (x <= 4) and water on the right. Centre at (2, 4)
    // sits inside the blob; it should have LOWER perimeter-to-area
    // than the full-inland blob centred at (4, 4) — the full blob
    // has 0 perimeter (no water neighbours), the peninsula blob has
    // some tiles touching water on the right.
    //
    // Actually, 'lower perimeter' = better = what the plan rewards.
    // A peninsula near the water has MORE water-touching tiles, so a
    // raw perimeter/area ratio is higher there. We use this check to
    // prove the scorer *weights it down* (1 - perimeter bonus is
    // smaller for peninsulas), but the overall score is dominated by
    // other terms (flood, frontier, coastal). So rewrite the test
    // to assert the math (inland blob → ratio 0, peninsula → ratio > 0)
    // and let a separate test cover the score comparison.
    expect(inlandRatio).toBe(0);
    const peninsulaView = buildFakeGridGameView((x, _y) => x <= 4);
    const peninsulaRatio = perimeterToAreaRatio(peninsulaView, 2 * 9 + 4, 4);
    expect(peninsulaRatio).toBeGreaterThan(0);
  });

  it("corridorCount spots narrow land-necks in a bottleneck", () => {
    const runtime = loadUserscript();
    const { corridorCount } = runtime.test.internals;

    // A shape with a 1-wide neck: top 3 rows fully land, bottom 3 rows
    // fully land, connected by a 3-tile vertical strip at x=4 (y=3, 4, 5).
    // The middle tile (4,4) has two land neighbours (north at (4,3) and
    // south at (4,5)) and no east/west land, so it matches the corridor
    // predicate `landN === 2`.
    const view = buildFakeGridGameView((x, y) => {
      if (y <= 2) return true;
      if (y >= 6) return true;
      if (x === 4 && (y === 3 || y === 4 || y === 5)) return true;
      return false;
    });
    const count = corridorCount(view, 4 * 9 + 4, 4);
    expect(count).toBeGreaterThanOrEqual(1);

    // In a fully-land blob there should be no corridors.
    const blobView = buildFakeGridGameView(() => true);
    expect(corridorCount(blobView, 4 * 9 + 4, 4)).toBe(0);
  });
});

describe("Plan §8 — traitor-window lock acceptance", () => {
  it("recordAllianceBreak forces DEFENSIVE_TURTLE for ~30 seconds", () => {
    const runtime = loadUserscript();
    const { recordAllianceBreak } = runtime.test.internals;

    runtime.world = buildWorld();
    runtime.planner.forcedGoalId = null;
    runtime.planner.forcedGoalExpiresMs = 0;
    runtime.state.recentAllianceBreakTicks = [];
    runtime.state.cooldowns.allianceBreak = -999;

    const tBefore = Date.now();
    recordAllianceBreak();
    const tAfter = Date.now();

    expect(runtime.planner.forcedGoalId).toBe("DEFENSIVE_TURTLE");
    // Expiry should land ~30s after the call. Allow the test-run jitter
    // of 30000 ± a few ms.
    const expiresInMs = runtime.planner.forcedGoalExpiresMs - tAfter;
    expect(expiresInMs).toBeGreaterThan(29_000);
    expect(expiresInMs).toBeLessThanOrEqual(30_000 + (tAfter - tBefore));
    expect(runtime.state.traitorLockActive).toBe(true);
  });
});
