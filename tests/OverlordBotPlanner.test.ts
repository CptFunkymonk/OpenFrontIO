/**
 * Phase 6 tests — the Overlord goal planner.
 *
 * Loads the userscript in jsdom and runs its built-in scenario suite
 * (runtime.test.runSuite), which asserts the planner selects the correct
 * primary goal across a spread of world states (expansion dominates early,
 * repel under invasion, turtle when dominant, nuke the crown, preempt brewing
 * invaders, isolate coalitions, emergency MIRV, idle fallback).
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
beforeAll(() => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const win: any = (globalThis as any).window;
  win.__OVERLORD_TEST_MODE = true;
  win.WebSocket = win.WebSocket ?? class {};
  win.Worker = win.Worker ?? class {};
  new Function(source).call(win);
  runtime = win.__overlordBotRuntime;
});

describe("Overlord planner scenario suite", () => {
  it("selects the correct primary goal in every scenario", () => {
    expect(runtime.test.runSuite).toBeTypeOf("function");
    const summary = runtime.test.runSuite();
    const failing = summary.results.filter((r: any) => !r.pass);
    if (failing.length > 0) {
      const details = failing
        .map(
          (r: any) =>
            `  - ${r.name}: expected=${r.expected}, actual=${r.actual}`,
        )
        .join("\n");
      throw new Error(`Planner suite failures:\n${details}`);
    }
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBeGreaterThanOrEqual(8);
  });

  it("EXPAND_RUSH outranks ATTACK_WEAKEST early (the v2 under-expansion fix)", () => {
    const select = runtime.test.selectPrimaryGoal;
    const me = {
      smallID: 1,
      troops: 90000,
      maxTroops: 200000,
      troopRatio: 0.45,
      gold: 0,
      tiles: 800,
      incomingTroops: 0,
      incomingAttacks: [],
      outgoingAttacks: [],
      structures: {},
      structureLevels: {},
      share: 0.03,
    };
    const enemy = {
      smallID: 2,
      name: "E",
      type: "HUMAN",
      troops: 40000,
      tiles: 1000,
      isAlly: false,
      incomingTroops: 0,
    };
    const bySmallID = new Map<any, any>([
      [1, me],
      [2, enemy],
    ]);
    const world: any = {
      tick: 400,
      gameConfig: { difficulty: "Impossible", isTeam: false },
      me,
      everyone: [me, enemy],
      bySmallID,
      totals: {
        alivePlayers: 2,
        humanCount: 2,
        nationCount: 0,
        botCount: 0,
        totalLand: 100000,
        myShare: 0.03,
        crownShare: 0.1,
        secondShare: 0.03,
      },
      rankings: { byTiles: [], byTroops: [] },
      scan: { bordersTN: true, hasCoast: false },
      threats: {
        crown: null,
        risingStars: [],
        adjacentEnemies: [enemy],
        activeInvaders: [],
        brewingInvaders: [],
        inboundNukes: [],
        inboundBoats: [],
        coalitionAgainstMe: false,
      },
      allianceGraph: { edges: new Map() },
    };
    const sel = select(world);
    expect(sel.id).toBe("EXPAND_RUSH");
  });
});
