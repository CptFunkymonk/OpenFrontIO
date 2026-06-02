/**
 * Phase 4 tests — the Overlord forward simulator (SIM).
 *
 * Verifies projections are monotonic/bounded and consistent with the exact
 * troop-growth math, and that the lookahead queries (ticksUntilInvadable,
 * crownWinEta, safeCommit) behave correctly on crafted scenarios.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { beforeAll, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(
  __dirname,
  "..",
  "tampermonkey-overlord-bot.js",
);

let runtime: any;
let SIM: any;
let MATH: any;
beforeAll(() => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const win: any = (globalThis as any).window;
  win.__OVERLORD_TEST_MODE = true;
  win.WebSocket = win.WebSocket ?? class {};
  new Function(source).call(win);
  runtime = win.__overlordBotRuntime;
  SIM = runtime.sim;
  MATH = runtime.math;
});

const PlayerType = { Bot: "BOT", Human: "HUMAN", Nation: "NATION" };

describe("SIM.projectPlayer", () => {
  it("grows troops toward the cap and never exceeds it", () => {
    const entry = {
      type: PlayerType.Human,
      troops: 50000,
      tiles: 1000,
      gold: 0,
      tilesPerMin: 0,
      cityLevelsSum: 0,
    };
    const ctx = { difficulty: "Medium", totalLand: 1000000 };
    const max = MATH.maxTroops({
      tiles: 1000,
      cityLevelsSum: 0,
      type: PlayerType.Human,
      difficulty: "Medium",
    });
    const p100 = SIM.projectPlayer(entry, 100, ctx);
    const p300 = SIM.projectPlayer(entry, 300, ctx);
    expect(p100.troops).toBeGreaterThan(entry.troops);
    expect(p300.troops).toBeGreaterThan(p100.troops);
    expect(p300.troops).toBeLessThanOrEqual(max + 1);
  });

  it("grows tiles by velocity (clamped to totalLand)", () => {
    const entry = {
      type: PlayerType.Human,
      troops: 10000,
      tiles: 1000,
      gold: 0,
      tilesPerMin: 600, // = 1 tile/tick
      cityLevelsSum: 0,
    };
    const p = SIM.projectPlayer(entry, 100, { totalLand: 1000000 });
    expect(p.tiles).toBeCloseTo(1100, 0);
    // clamps to totalLand
    const capped = SIM.projectPlayer(
      { ...entry, tiles: 999950 },
      100,
      { totalLand: 1000000 },
    );
    expect(capped.tiles).toBe(1000000);
  });

  it("accrues gold by income", () => {
    const entry = {
      type: PlayerType.Human,
      troops: 10000,
      tiles: 1000,
      gold: 1000,
      tilesPerMin: 0,
      goldPerMin: 6000, // 10/tick
    };
    const p = SIM.projectPlayer(entry, 100, {});
    expect(p.gold).toBeCloseTo(1000 + 10 * 100, 0);
  });
});

describe("SIM.ticksUntilInvadable", () => {
  const ctx = { difficulty: "Medium", totalLand: 1000000, horizon: 1200 };

  it("returns 0 when an enemy can already invade us", () => {
    const me = { type: PlayerType.Human, troops: 50000, tiles: 1000 };
    const enemy = {
      type: PlayerType.Human,
      troops: 400000,
      tiles: 20000,
      tilesPerMin: 0,
    };
    expect(SIM.ticksUntilInvadable(me, enemy, ctx)).toBe(0);
  });

  it("returns a finite horizon when a bigger-capped enemy out-grows a capped us", () => {
    // We are near our (small) pop cap and stagnant; the enemy has a much
    // larger cap, so their committable troops eventually overtake ours.
    const me = {
      type: PlayerType.Human,
      troops: 90000,
      tiles: 1000,
      tilesPerMin: 0,
    };
    const enemy = {
      type: PlayerType.Human,
      troops: 100000,
      tiles: 6000,
      reserveRatio: 0.2,
      tilesPerMin: 0,
    };
    const t = SIM.ticksUntilInvadable(me, enemy, ctx);
    expect(t).toBeGreaterThan(0);
    expect(Number.isFinite(t)).toBe(true);
  });

  it("returns Infinity for a weak, stagnant enemy", () => {
    const me = {
      type: PlayerType.Human,
      troops: 200000,
      tiles: 10000,
      tilesPerMin: 0,
    };
    const enemy = {
      type: PlayerType.Human,
      troops: 5000,
      tiles: 200,
      tilesPerMin: 0,
    };
    expect(SIM.ticksUntilInvadable(me, enemy, { ...ctx, horizon: 300 })).toBe(
      Infinity,
    );
  });
});

describe("SIM.crownWinEta", () => {
  function world(crownTiles: number, perMin: number, totalLand = 100000) {
    return {
      gameConfig: { isTeam: false },
      totals: { totalLand },
      threats: { crown: { tiles: crownTiles, tilesPerMin: perMin } },
    };
  }
  it("is 0 when the crown already meets the threshold", () => {
    // FFA win = 80%
    expect(SIM.crownWinEta(world(85000, 100))).toBe(0);
  });
  it("is finite when the crown is growing toward the threshold", () => {
    const eta = SIM.crownWinEta(world(40000, 600)); // needs 40000 more, 1 tile/tick
    expect(eta).toBe(40000);
  });
  it("is Infinity when the crown is not growing", () => {
    expect(SIM.crownWinEta(world(40000, 0))).toBe(Infinity);
  });
});

describe("SIM.safeCommit", () => {
  it("flags an unsafe over-commit and caps the recommended size", () => {
    const me = { troops: 100000 };
    const danger = {
      type: PlayerType.Human,
      troops: 90000,
      tiles: 5000,
      reserveRatio: 0.3,
    };
    const world = {
      me,
      gameConfig: { difficulty: "Medium" },
      threats: { adjacentEnemies: [danger] },
    };
    // danger committable = 90000 - max*0.3. Their max (5000 tiles) is large so
    // committable may be small; construct via the function itself.
    const r = SIM.safeCommit(world, 95000);
    expect(r.recommendedMax).toBeLessThanOrEqual(100000);
    // Committing more than recommendedMax must be unsafe.
    const over = SIM.safeCommit(world, r.recommendedMax + 5000);
    expect(over.safe).toBe(false);
  });

  it("is safe when no adjacent enemy can strike", () => {
    const world = {
      me: { troops: 100000 },
      gameConfig: { difficulty: "Medium" },
      threats: { adjacentEnemies: [] },
    };
    const r = SIM.safeCommit(world, 80000);
    expect(r.safe).toBe(true);
    expect(r.defenseFloor).toBe(0);
  });
});
