/**
 * Phase 3 tests — the Overlord TACTICS decision functions.
 *
 * These verify calculated sizing (expansion/attack troops via exact math),
 * the attack-target strategy ladder, and the ROI-ranked build picker. We build
 * lightweight world stubs matching the shape TACTICS reads.
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
let MATH: any;
let TACTICS: any;
beforeAll(() => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const win: any = (globalThis as any).window;
  win.__OVERLORD_TEST_MODE = true;
  win.WebSocket = win.WebSocket ?? class {};
  new Function(source).call(win);
  runtime = win.__overlordBotRuntime;
  MATH = runtime.math;
  TACTICS = runtime.tactics;
});

const PlayerType = { Bot: "BOT", Human: "HUMAN", Nation: "NATION" };
const UnitType = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  DefensePost: "Defense Post",
  MissileSilo: "Missile Silo",
  SAMLauncher: "SAM Launcher",
};

function emptyStructures(over: any = {}) {
  return {
    [UnitType.City]: 0,
    [UnitType.Port]: 0,
    [UnitType.Factory]: 0,
    [UnitType.DefensePost]: 0,
    [UnitType.MissileSilo]: 0,
    [UnitType.SAMLauncher]: 0,
    ...over,
  };
}

function makeWorld(opts: any) {
  const everyone = opts.everyone || [];
  const bySmallID = new Map();
  for (const e of everyone) bySmallID.set(e.smallID, e);
  const me = opts.me;
  if (me) bySmallID.set(me.smallID, me);
  return {
    tick: opts.tick || 1000,
    gameConfig: { difficulty: opts.difficulty || "Impossible", isTeam: false },
    me,
    bySmallID,
    everyone,
    totals: {
      myShare: opts.myShare ?? 0.1,
      crownShare: opts.crownShare ?? 0.3,
      totalLand: 100000,
    },
  };
}

describe("TACTICS sizing", () => {
  it("expands while small but keeps a standing defensive army", () => {
    const me = {
      smallID: 1,
      troops: 100000,
      maxTroops: 200000,
      troopRatio: 0.5,
      incomingTroops: 0,
      incomingAttacks: [],
      structures: emptyStructures(),
      gold: 0,
    };
    const world = makeWorld({ me, myShare: 0.03 });
    const reserve = TACTICS.reserveForExpansion(world);
    // Cap-based reserve: keep a fraction of the pop-cap home so repeated
    // expansion can't drain the army to zero (the glass-cannon failure).
    expect(reserve).toBeGreaterThanOrEqual(0.15);
    expect(reserve).toBeLessThanOrEqual(0.3);
    const troops = TACTICS.expansionTroops(world);
    expect(troops).toBe(Math.floor(100000 - 200000 * reserve));
    expect(troops).toBeGreaterThan(0);
    expect(troops).toBeLessThan(100000); // never commit everything
  });

  it("holds more in reserve under invasion pressure", () => {
    const me = {
      smallID: 1,
      troops: 100000,
      maxTroops: 200000,
      troopRatio: 0.5,
      incomingTroops: 70000,
      incomingAttacks: [],
      structures: emptyStructures(),
      gold: 0,
    };
    const world = makeWorld({ me, myShare: 0.03 });
    expect(TACTICS.reserveForExpansion(world)).toBeGreaterThanOrEqual(0.5);
  });

  it("sizes a player attack at the optimal saturation point", () => {
    const me = {
      smallID: 1,
      troops: 500000,
      maxTroops: 600000,
      troopRatio: 0.83,
      incomingTroops: 0,
      incomingAttacks: [],
      structures: emptyStructures(),
      gold: 0,
    };
    const enemy = { smallID: 2, troops: 100000, type: PlayerType.Human };
    const world = makeWorld({ me, everyone: [enemy] });
    const t = TACTICS.attackTroops(world, enemy, {});
    // available = 500000 - 600000*reserve(<=0.25 since share .1, ratio .83) = >=350000.
    // Enemy 100k -> ideal ~166667. available >> ideal so send ~85% of available.
    expect(t).toBeGreaterThanOrEqual(Math.ceil(100000 * MATH.ATK_RATIO_MIN_LOSS));
  });
});

describe("TACTICS target selection ladder", () => {
  const me = {
    smallID: 1,
    troops: 100000,
    maxTroops: 200000,
    troopRatio: 0.5,
    incomingTroops: 0,
    incomingAttacks: [] as any[],
    structures: emptyStructures(),
    gold: 0,
  };

  it("retaliates against the biggest non-bot incoming attacker", () => {
    const attacker = { smallID: 5, troops: 80000, type: PlayerType.Human };
    const other = { smallID: 6, troops: 20000, type: PlayerType.Human };
    const meR = { ...me, incomingAttacks: [{ attackerID: 5, troops: 40000 }] };
    const world = makeWorld({ me: meR, everyone: [attacker, other] });
    const pick = TACTICS.selectAttackTarget(world, [attacker, other]);
    expect(pick.entry.smallID).toBe(5);
    expect(pick.reason).toBe("retaliate");
    expect(pick.retaliating).toBe(true);
  });

  it("prefers weak bots over weak humans", () => {
    const bot = { smallID: 7, troops: 9000, type: PlayerType.Bot };
    const human = { smallID: 8, troops: 5000, type: PlayerType.Human };
    const world = makeWorld({ me, everyone: [bot, human] });
    const pick = TACTICS.selectAttackTarget(world, [bot, human]);
    expect(pick.entry.smallID).toBe(7);
    expect(pick.reason).toBe("farm bot");
  });

  it("targets very weak enemies (<15% of own max, <1.2x us)", () => {
    // tiles small so their max is small; troops below 15% of it.
    const weak = { smallID: 9, troops: 1000, type: PlayerType.Human, tiles: 500, incomingTroops: 0 };
    const world = makeWorld({ me, everyone: [weak] });
    const pick = TACTICS.selectAttackTarget(world, [weak]);
    expect(pick.entry.smallID).toBe(9);
    expect(["very weak", "weakest"]).toContain(pick.reason);
  });

  it("returns null when the only candidate is stronger than us", () => {
    const strong = { smallID: 10, troops: 300000, type: PlayerType.Human, tiles: 50000, incomingTroops: 0, isTraitor: false, isDisconnected: false };
    const world = makeWorld({ me, everyone: [strong] });
    const pick = TACTICS.selectAttackTarget(world, [strong]);
    expect(pick).toBeNull();
  });
});

describe("TACTICS build picker (ROI / economy-first)", () => {
  function meWith(gold: number, structures: any) {
    return {
      smallID: 1,
      troops: 50000,
      maxTroops: 100000,
      troopRatio: 0.5,
      incomingTroops: 0,
      incomingAttacks: [],
      structures: emptyStructures(structures),
      gold,
    };
  }

  it("builds a city first when affordable", () => {
    const world = makeWorld({ me: meWith(200000, {}) });
    const pick = TACTICS.pickBuild(world, { coastAvailable: false, mapShare: 0.05 });
    expect(pick.type).toBe(UnitType.City);
    expect(pick.affordable).toBe(true);
  });

  it("recommends saving for a city when broke", () => {
    const world = makeWorld({ me: meWith(10000, {}) });
    const pick = TACTICS.pickBuild(world, { coastAvailable: false });
    expect(pick.affordable).toBe(false);
    expect(pick.type).toBe(UnitType.City);
  });

  it("builds a port when coast available and we have a city", () => {
    // Make cities cap out so port/factory rank in; give lots of gold.
    const world = makeWorld({
      me: meWith(50_000_000, { [UnitType.City]: 12 }),
    });
    const pick = TACTICS.pickBuild(world, { coastAvailable: true, mapShare: 0.1 });
    expect([UnitType.Port, UnitType.Factory, UnitType.DefensePost]).toContain(
      pick.type,
    );
  });

  it("prioritizes defense posts under threat", () => {
    const world = makeWorld({
      me: meWith(50_000_000, { [UnitType.City]: 12, [UnitType.Port]: 3 }),
    });
    const pick = TACTICS.pickBuild(world, {
      coastAvailable: true,
      underThreat: true,
      mapShare: 0.1,
    });
    // With cities capped & ports full, defense posts (underThreat -> want many) should win.
    expect(pick.type).toBe(UnitType.DefensePost);
  });

  it("builds SAM when a nuke threat is present", () => {
    const world = makeWorld({
      me: meWith(50_000_000, {
        [UnitType.City]: 12,
        [UnitType.Port]: 3,
        [UnitType.Factory]: 6,
        [UnitType.DefensePost]: 14,
      }),
    });
    const pick = TACTICS.pickBuild(world, {
      coastAvailable: true,
      nukeThreat: true,
      mapShare: 0.2,
    });
    expect([UnitType.SAMLauncher, UnitType.MissileSilo]).toContain(pick.type);
  });
});
