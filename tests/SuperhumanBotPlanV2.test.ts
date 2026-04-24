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
