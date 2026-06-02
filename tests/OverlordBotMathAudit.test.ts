/**
 * Phase 8 — second-pass MATH audit.
 *
 * The user asked us to "test the math to make sure the assumptions are
 * correct." The parity suite already proves MATH == the engine; here we prove
 * the DERIVED strategic assumptions that drive optimalAttackTroops by sweeping
 * the (proven) attackLogic over attacker:defender ratios and confirming the
 * saturation points we rely on actually hold:
 *
 *   - PvP attacker loss-per-tile bottoms out at ratio >= 1.6667x (min blood).
 *   - PvP conquest speed maxes out at ratio >= 1.0x (min tiles-per-tick cost).
 *   - Below 0.5x the loss multiplier saturates at 2.0 (wasteful).
 *   - TerraNullius loss is FLAT regardless of troop count; expansion speed cost
 *     bottoms at ~6600 troops (so expansion can never "waste" troops).
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

let MATH: any;
beforeAll(() => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const win: any = (globalThis as any).window;
  win.__OVERLORD_TEST_MODE = true;
  win.WebSocket = win.WebSocket ?? class {};
  new Function(source).call(win);
  MATH = win.__overlordBotRuntime.math;
});

const PlayerType = { Bot: "BOT", Human: "HUMAN", Nation: "NATION" };

function pvpAt(ratio: number, D = 100000, DT = 2000) {
  return MATH.attackLogic({
    terrainType: "Plains",
    attackTroops: Math.max(1, Math.round(ratio * D)),
    attackerType: PlayerType.Human,
    defenderIsPlayer: true,
    defenderTroops: D,
    defenderTiles: DT,
    defenderType: PlayerType.Human,
    attackerTiles: 3000,
  });
}

describe("MATH audit — PvP saturation points", () => {
  it("attacker loss-per-tile bottoms out at ratio >= 1.6667x", () => {
    const at1 = pvpAt(1.0).attackerTroopLoss;
    const at167 = pvpAt(1 / 0.6).attackerTroopLoss;
    const at2 = pvpAt(2.0).attackerTroopLoss;
    const at3 = pvpAt(3.0).attackerTroopLoss;
    // Loss keeps falling until 1.6667x, then flattens (within() hits 0.6 clamp).
    expect(at167).toBeLessThan(at1);
    expect(at2).toBeCloseTo(at167, 6);
    expect(at3).toBeCloseTo(at167, 6);
    // MATH's chosen ideal ratio is exactly this saturation point.
    expect(MATH.ATK_RATIO_MIN_LOSS).toBeCloseTo(1 / 0.6, 9);
  });

  it("loss multiplier saturates (caps at 2.0) below 0.5x", () => {
    const at05 = pvpAt(0.5).attackerTroopLoss;
    const at04 = pvpAt(0.4).attackerTroopLoss;
    const at03 = pvpAt(0.3).attackerTroopLoss;
    // At/under 0.5x the within(D/A,0.6,2) factor is pinned to 2.0, so the
    // (dominant) loss component stops rising — extra weakness buys nothing.
    expect(at04).toBeCloseTo(at05, 6);
    expect(at03).toBeCloseTo(at05, 6);
    expect(MATH.ATK_RATIO_MIN_VIABLE).toBeCloseTo(0.5, 9);
  });

  it("conquest speed (low tiles-per-tick cost) maxes out at ratio >= 1.0x", () => {
    const c05 = pvpAt(0.5).tilesPerTickUsed;
    const c1 = pvpAt(1.0).tilesPerTickUsed;
    const c2 = pvpAt(2.0).tilesPerTickUsed;
    // tilesPerTickUsed is a COST; lower = faster. It bottoms (0.2 clamp) at 1x.
    expect(c1).toBeLessThan(c05);
    expect(c2).toBeCloseTo(c1, 6);
    expect(MATH.ATK_RATIO_MAX_SPEED).toBeCloseTo(1.0, 9);
  });
});

describe("MATH audit — TerraNullius expansion", () => {
  it("attacker loss per tile is FLAT regardless of troop count", () => {
    const mk = (A: number) =>
      MATH.attackLogic({
        terrainType: "Plains",
        attackTroops: A,
        attackerType: PlayerType.Human,
        defenderIsPlayer: false,
      }).attackerTroopLoss;
    // Plains human = mag/5 = 80/5 = 16, independent of A.
    expect(mk(1000)).toBeCloseTo(16, 9);
    expect(mk(50000)).toBeCloseTo(16, 9);
    expect(mk(1_000_000)).toBeCloseTo(16, 9);
  });

  it("expansion speed cost bottoms at ~6600 troops (then sending more is free upside on losses, not speed)", () => {
    const cost = (A: number) =>
      MATH.attackLogic({
        terrainType: "Plains",
        attackTroops: A,
        attackerType: PlayerType.Human,
        defenderIsPlayer: false,
      }).tilesPerTickUsed;
    // within(2000*16.5/A, 5, 100): hits the 5 floor at A = 33000/5 = 6600.
    expect(cost(3300)).toBeCloseTo(10, 6);
    expect(cost(6600)).toBeCloseTo(5, 6);
    expect(cost(10000)).toBe(5);
    expect(cost(1_000_000)).toBe(5);
  });
});

describe("MATH audit — optimalAttackTroops honors the saturation math", () => {
  it("commits to >= 1.6667x the defender when affordable", () => {
    const D = 100000;
    const t = MATH.optimalAttackTroops(1_000_000, D, {});
    expect(t).toBeGreaterThanOrEqual(Math.ceil(D / 0.6));
  });
  it("commits everything between 1.0x and 1.6667x (good fight, fast)", () => {
    const D = 100000;
    expect(MATH.optimalAttackTroops(130000, D, {})).toBe(130000);
  });
  it("refuses sub-0.5x non-retaliatory attacks (wasteful) but allows retaliation", () => {
    const D = 100000;
    expect(MATH.optimalAttackTroops(40000, D, {})).toBe(0);
    expect(MATH.optimalAttackTroops(40000, D, { retaliating: true })).toBe(40000);
  });
  it("sends everything above reserve into TerraNullius (flat loss)", () => {
    expect(MATH.optimalAttackTroops(123456, 0, {})).toBe(123456);
  });
});
