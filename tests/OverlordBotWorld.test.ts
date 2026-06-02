/**
 * Phase 2 tests — the Overlord WORLD snapshot model.
 *
 * Drives runtime.test.buildWorld(mockGameView) directly (no live socket) and
 * asserts shares, crown detection, rankings, structure counts, maxTroops and
 * velocity tracking are computed correctly.
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

const UnitType = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  DefensePost: "Defense Post",
  MissileSilo: "Missile Silo",
  SAMLauncher: "SAM Launcher",
};
const PlayerType = { Bot: "BOT", Human: "HUMAN", Nation: "NATION" };

function unit(type: string, level = 1, underConstruction = false) {
  return {
    type: () => type,
    level: () => level,
    isUnderConstruction: () => underConstruction,
    isActive: () => true,
  };
}

function makePlayer(o: any) {
  const allies: any[] = o.allies || [];
  return {
    _o: o,
    smallID: () => o.smallID,
    id: () => o.id,
    name: () => o.name,
    type: () => o.type || PlayerType.Human,
    team: () => o.team ?? null,
    isAlive: () => o.alive !== false,
    isPlayer: () => true,
    troops: () => o.troops || 0,
    gold: () => o.gold || 0,
    numTilesOwned: () => o.tiles || 0,
    isTraitor: () => o.traitor || false,
    isDisconnected: () => o.disconnected || false,
    isFriendly: (other: any) => allies.includes(other._o?.smallID ?? other),
    alliances: () => o.alliances || [],
    incomingAttacks: () => o.incomingAttacks || [],
    outgoingAttacks: () => o.outgoingAttacks || [],
    units: (t: string) => (o.units || []).filter((u: any) => u.type() === t),
  };
}

function makeGameView(opts: any) {
  const players = opts.players;
  return {
    ticks: () => opts.tick,
    numLandTiles: () => opts.totalLand,
    config: () => ({
      gameConfig: () => ({
        difficulty: opts.difficulty || "Medium",
        gameMode: opts.gameMode || "FFA",
        goldMultiplier: opts.goldMultiplier || 1,
      }),
      maxTroops: (_p: any) => opts.maxTroops ?? 0,
    }),
    myPlayer: () => opts.myPlayer,
    playerViews: () => players,
  };
}

describe("Overlord WORLD snapshot", () => {
  it("computes shares, crown, rankings, structures and maxTroops", () => {
    const me = makePlayer({
      smallID: 1,
      id: "me",
      name: "Me",
      type: PlayerType.Human,
      tiles: 1000,
      troops: 50000,
      gold: 100000,
      units: [
        unit(UnitType.City, 2),
        unit(UnitType.City, 1),
        unit(UnitType.Port, 1),
        unit(UnitType.DefensePost, 1),
        unit(UnitType.City, 1, true), // under construction -> excluded
      ],
    });
    const crown = makePlayer({
      smallID: 2,
      id: "crown",
      name: "Crown",
      type: PlayerType.Nation,
      tiles: 5000,
      troops: 300000,
      gold: 500000,
    });
    const bot = makePlayer({
      smallID: 3,
      id: "bot",
      name: "Botty",
      type: PlayerType.Bot,
      tiles: 200,
      troops: 8000,
    });

    const gv = makeGameView({
      tick: 1000,
      totalLand: 10000,
      difficulty: "Impossible",
      gameMode: "FFA",
      myPlayer: me,
      players: [me, crown, bot],
    });

    const world = runtime.test.buildWorld(gv);
    expect(world).toBeTruthy();
    expect(world.tick).toBe(1000);
    expect(world.totals.alivePlayers).toBe(3);
    expect(world.totals.humanCount).toBe(1);
    expect(world.totals.nationCount).toBe(1);
    expect(world.totals.botCount).toBe(1);
    expect(world.totals.totalLand).toBe(10000);

    // shares
    expect(world.totals.myShare).toBeCloseTo(0.1, 6);
    expect(world.totals.crownShare).toBeCloseTo(0.5, 6);
    expect(world.totals.secondShare).toBeCloseTo(0.1, 6);

    // crown is the nation with most tiles
    expect(world.threats.crown.smallID).toBe(2);
    expect(world.rankings.byTiles[0].smallID).toBe(2);
    expect(world.rankings.byTroops[0].smallID).toBe(2);

    // me structures (excluding under-construction city)
    expect(world.me.structures[UnitType.City]).toBe(2);
    expect(world.me.structures[UnitType.Port]).toBe(1);
    expect(world.me.structures[UnitType.DefensePost]).toBe(1);
    expect(world.me.cityLevelsSum).toBe(3); // levels 2 + 1
    // maxTroops via MATH (gameView.config().maxTroops returns 0 -> fallback)
    const expectedMax = runtime.math.maxTroops({
      tiles: 1000,
      cityLevelsSum: 3,
      type: PlayerType.Human,
      difficulty: "Impossible",
    });
    expect(world.me.maxTroops).toBeCloseTo(expectedMax, 4);
    expect(world.me.troopRatio).toBeCloseTo(50000 / expectedMax, 6);

    // relations
    expect(world.bySmallID.get(2).isEnemy).toBe(true);
    expect(world.bySmallID.get(1).isMe).toBe(true);
  });

  it("tracks velocity across ticks", () => {
    const mk = (tick: number, tiles: number) => {
      const me = makePlayer({
        smallID: 9,
        id: "v",
        name: "V",
        type: PlayerType.Human,
        tiles,
        troops: 10000,
      });
      return makeGameView({
        tick,
        totalLand: 100000,
        myPlayer: me,
        players: [me],
      });
    };
    // First snapshot seeds history.
    runtime.test.buildWorld(mk(0, 1000));
    // 60 ticks later we gained 600 tiles -> 600/60*600 = 6000 tiles/min.
    const w = runtime.test.buildWorld(mk(60, 1600));
    expect(w.me.tilesPerMin).toBeCloseTo(6000, 2);
  });
});
