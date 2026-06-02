/**
 * Phase 9 — end-to-end integration test.
 *
 * Drives the REAL per-tick loop (runtime.test.runModulesForTick) against a
 * full grid-based mock GameView and a fake socket that records sent intents.
 * Verifies the wired bot actually: spawns in the spawn phase, expands into
 * unclaimed land, builds economy when it has gold, and attacks an adjacent
 * weaker enemy when boxed in. This exercises Net/IO -> WORLD -> THREATS ->
 * planner -> goal run() -> IO end to end.
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
  "tampermonkey-overlord-bot.js",
);

const UnitType = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  DefensePost: "Defense Post",
  MissileSilo: "Missile Silo",
  SAMLauncher: "SAM Launcher",
};
const PlayerType = { Bot: "BOT", Human: "HUMAN", Nation: "NATION" };

const W = 24;
const H = 24;

/**
 * Grid world: ownership[ref] = smallID (0 = unclaimed land). All tiles are
 * land unless in `water`. Players are described by an owner-id map.
 */
function buildMockGame(opts: any) {
  const ownership: number[] = opts.ownership;
  const water: Set<number> = opts.water || new Set();
  const ref = (x: number, y: number) => y * W + x;

  const players: any[] = [];
  function makePlayer(p: any) {
    const cities = p.cities || 0;
    const units: any[] = [];
    for (let i = 0; i < cities; i++)
      units.push({
        type: () => UnitType.City,
        level: () => 1,
        isUnderConstruction: () => false,
        isActive: () => true,
        tile: () => p.structureTiles?.[i] ?? null,
      });
    const obj: any = {
      _p: p,
      smallID: () => p.smallID,
      id: () => p.id,
      name: () => p.name,
      type: () => p.type || PlayerType.Human,
      team: () => null,
      isAlive: () => true,
      isPlayer: () => true,
      troops: () => p.troops,
      gold: () => p.gold || 0,
      numTilesOwned: () =>
        ownership.reduce((n, o) => (o === p.smallID ? n + 1 : n), 0),
      isTraitor: () => false,
      isDisconnected: () => false,
      isFriendly: () => false,
      isRequestingAllianceWith: () => false,
      allies: () => [],
      targets: () => [],
      alliances: () => [],
      incomingAttacks: () => p.incomingAttacks || [],
      outgoingAttacks: () => p.outgoingAttacks || [],
      units: (...types: string[]) =>
        types.length
          ? units.filter((u) => types.includes(u.type()))
          : units.slice(),
      borderTiles: async () => {
        const set = new Set<number>();
        for (let i = 0; i < ownership.length; i++) {
          if (ownership[i] !== p.smallID) continue;
          const x = i % W;
          const y = Math.floor(i / W);
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const nref = ref(nx, ny);
            if (ownership[nref] !== p.smallID) {
              set.add(i);
              break;
            }
          }
        }
        return { borderTiles: set };
      },
      bestTransportShipSpawn: async () => false,
    };
    return obj;
  }

  for (const p of opts.players) players.push(makePlayer(p));
  const meObj = players.find((pl) => pl._p.smallID === opts.meSmallID);

  const gv: any = {
    ticks: () => opts.tick ?? 500,
    inSpawnPhase: () => !!opts.spawnPhase,
    width: () => W,
    height: () => H,
    numLandTiles: () => W * H - water.size,
    ref,
    x: (r: number) => r % W,
    y: (r: number) => Math.floor(r / W),
    isValidCoord: (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H,
    isLand: (r: number) => !water.has(r),
    isOcean: (r: number) => water.has(r),
    isOceanShore: () => false,
    ownerID: (r: number) => ownership[r] ?? 0,
    hasOwner: (r: number) => (ownership[r] ?? 0) !== 0,
    hasFallout: () => false,
    neighbors: (r: number) => {
      const x = r % W;
      const y = Math.floor(r / W);
      const out: number[] = [];
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H) out.push(ref(nx, ny));
      }
      return out;
    },
    manhattanDist: (a: number, b: number) =>
      Math.abs((a % W) - (b % W)) + Math.abs(Math.floor(a / W) - Math.floor(b / W)),
    nearbyUnits: () => [],
    config: () => ({
      gameConfig: () => ({
        difficulty: "Impossible",
        gameMode: "FFA",
        goldMultiplier: 1,
      }),
      maxTroops: () => 0, // force MATH fallback in buildWorld
    }),
    myPlayer: () => meObj,
    playerViews: () => players,
    playerBySmallID: (sid: number) =>
      players.find((pl) => pl._p.smallID === sid) || { isPlayer: () => false },
    units: () => [],
  };
  return gv;
}

function fillBlock(
  ownership: number[],
  sid: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) ownership[y * W + x] = sid;
}

let runtime: any;
let captured: any[];

function loadFresh() {
  // Re-evaluate the script fresh so state (history, spawned flag) is clean.
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const win: any = (globalThis as any).window;
  win.__OVERLORD_TEST_MODE = true;
  win.WebSocket = win.WebSocket ?? class {};
  delete win.__overlordBotRuntime;
  new Function(source).call(win);
  runtime = win.__overlordBotRuntime;
  captured = [];
  runtime.hooks.socket = {
    readyState: 1,
    send: (s: string) => {
      const msg = JSON.parse(s);
      captured.push(msg.intent);
    },
  };
}

function setGame(gv: any) {
  runtime.hooks.gameView = gv;
  runtime.hooks.tick = gv.ticks();
}

describe("Overlord end-to-end loop", () => {
  beforeEach(() => loadFresh());

  it("spawns during the spawn phase", async () => {
    const ownership = new Array(W * H).fill(0);
    const gv = buildMockGame({
      tick: 50,
      spawnPhase: true,
      meSmallID: 1,
      players: [{ smallID: 1, id: "me", name: "Me", troops: 25000, gold: 0 }],
      ownership,
    });
    setGame(gv);
    await runtime.test.runModulesForTick();
    const spawn = captured.find((i) => i.type === "spawn");
    expect(spawn).toBeTruthy();
    expect(typeof spawn.tile).toBe("number");
  });

  it("expands into unclaimed land when it has a frontier", async () => {
    const ownership = new Array(W * H).fill(0);
    // Me owns a 3x3 block surrounded by unclaimed land -> TN frontier.
    fillBlock(ownership, 1, 10, 10, 3, 3);
    const gv = buildMockGame({
      tick: 500,
      meSmallID: 1,
      players: [
        { smallID: 1, id: "me", name: "Me", troops: 90000, gold: 50000 },
      ],
      ownership,
    });
    setGame(gv);
    await runtime.test.runModulesForTick();
    const expand = captured.find(
      (i) => i.type === "attack" && i.targetID === null,
    );
    expect(expand, "should send a TerraNullius expansion attack").toBeTruthy();
    expect(expand.troops).toBeGreaterThan(0);
    expect(runtime.planner.activeGoalId).toBe("EXPAND_RUSH");
  });

  it("builds economy (a city) when it has gold and a frontier", async () => {
    const ownership = new Array(W * H).fill(0);
    fillBlock(ownership, 1, 8, 8, 6, 6); // bigger so build tiles exist far from none
    const gv = buildMockGame({
      tick: 600,
      meSmallID: 1,
      players: [
        { smallID: 1, id: "me", name: "Me", troops: 90000, gold: 300000 },
      ],
      ownership,
    });
    setGame(gv);
    await runtime.test.runModulesForTick();
    const build = captured.find(
      (i) => i.type === "build_unit" && i.unit === UnitType.City,
    );
    expect(build, "should build a city as the economy secondary").toBeTruthy();
    expect(typeof build.tile).toBe("number");
  });

  it("attacks an adjacent weaker enemy when boxed in (no TN frontier)", async () => {
    const ownership = new Array(W * H).fill(0);
    // Fill the ENTIRE map with the two players so there is no unclaimed land.
    fillBlock(ownership, 2, 0, 0, W, H); // enemy owns everything first
    fillBlock(ownership, 1, 9, 9, 6, 6); // me carve a block in the middle
    const gv = buildMockGame({
      tick: 800,
      meSmallID: 1,
      players: [
        { smallID: 1, id: "me", name: "Me", troops: 200000, gold: 0 },
        { smallID: 2, id: "foe", name: "Foe", troops: 40000, gold: 0 },
      ],
      ownership,
    });
    setGame(gv);
    await runtime.test.runModulesForTick();
    const atk = captured.find(
      (i) => i.type === "attack" && i.targetID === "foe",
    );
    expect(atk, "should attack the adjacent weaker enemy").toBeTruthy();
    expect(atk.troops).toBeGreaterThan(0);
  });

  it("survives many ticks without throwing", async () => {
    const ownership = new Array(W * H).fill(0);
    fillBlock(ownership, 1, 10, 10, 3, 3);
    fillBlock(ownership, 2, 0, 0, 4, 4);
    const gv = buildMockGame({
      tick: 500,
      meSmallID: 1,
      players: [
        { smallID: 1, id: "me", name: "Me", troops: 90000, gold: 200000 },
        { smallID: 2, id: "foe", name: "Foe", troops: 70000, gold: 0 },
      ],
      ownership,
    });
    setGame(gv);
    for (let t = 0; t < 20; t++) {
      gv.ticks = () => 500 + t;
      runtime.hooks.tick = 500 + t;
      await runtime.test.runModulesForTick();
    }
    expect(captured.length).toBeGreaterThan(0);
  });
});
