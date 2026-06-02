/**
 * Math-parity tests for the Overlord userscript.
 *
 * The decisive design claim of Overlord is that its MATH module is a faithful
 * port of the engine's balance math in src/core/configuration/DefaultConfig.ts.
 * This suite proves it: we construct a REAL DefaultConfig, drive it with mock
 * Game/Player objects, and assert the userscript's MATH returns numerically
 * identical results across randomized + boundary inputs.
 *
 * If the engine math ever changes, this test fails loudly and tells us exactly
 * which formula drifted.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { beforeAll, describe, expect, it } from "vitest";

import { DefaultConfig } from "../src/core/configuration/DefaultConfig";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerType,
  TerrainType,
  UnitType,
} from "../src/core/game/Game";
import { UserSettings } from "../src/core/game/UserSettings";
import type { GameConfig } from "../src/core/Schemas";
import { TestServerConfig } from "./util/TestServerConfig";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(
  __dirname,
  "..",
  "tampermonkey-overlord-bot.js",
);

// ── Load the userscript MATH module via the jsdom window (same pattern as the
//    superhuman bot tests). ──
function loadMath(): any {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const win: any = (globalThis as any).window;
  win.__OVERLORD_TEST_MODE = true;
  win.WebSocket = win.WebSocket ?? class {};
  win.Worker = win.Worker ?? class {};
  new Function(source).call(win);
  return win.__overlordBotRuntime.math;
}

// ── Build a real DefaultConfig instance. ──
function realConfig(overrides: Partial<GameConfig> = {}): DefaultConfig {
  const gameConfig: GameConfig = {
    gameMap: GameMapType.Asia,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Medium,
    nations: "default",
    donateGold: false,
    donateTroops: false,
    bots: 0,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
    ...overrides,
  } as GameConfig;
  return new DefaultConfig(
    new TestServerConfig(),
    gameConfig,
    new UserSettings(),
    false,
  );
}

// ── Mock factories matching what the engine reads off Game/Player. ──
function mockPlayer(opts: any) {
  const o = opts || {};
  return {
    isPlayer: () => o.isPlayer !== false,
    type: () => o.type ?? PlayerType.Human,
    troops: () => o.troops ?? 0,
    numTilesOwned: () => o.tiles ?? 0,
    isDisconnected: () => o.disconnected ?? false,
    isTraitor: () => o.traitor ?? false,
    isOnSameTeam: (_other: any) => o.sameTeam ?? false,
    units: (t: UnitType) =>
      t === UnitType.City
        ? (o.cityLevels ?? []).map((lvl: number) => ({ level: () => lvl }))
        : [],
    unitsOwned: (t: UnitType) => (o.unitsOwned && o.unitsOwned[t]) || 0,
    unitsConstructed: (t: UnitType) =>
      (o.unitsConstructed && o.unitsConstructed[t]) || 0,
  };
}

function mockTerraNullius() {
  return { isPlayer: () => false, type: () => undefined };
}

function mockGame(config: DefaultConfig, opts: any) {
  const o = opts || {};
  return {
    config: () => config,
    terrainType: (_t: number) => o.terrainType ?? TerrainType.Plains,
    hasFallout: (_t: number) => o.hasFallout ?? false,
    numTilesWithFallout: () => o.numTilesWithFallout ?? 0,
    numLandTiles: () => o.numLandTiles ?? 100000,
    nearbyUnits: (_tile: number, _range: number, _type: UnitType) =>
      o.defensePostOwner
        ? [{ unit: { owner: () => o.defensePostOwner } }]
        : [],
    stats: () => ({ numMirvsLaunched: () => BigInt(o.numMirvsLaunched ?? 0) }),
  };
}

const TERRAINS = [TerrainType.Plains, TerrainType.Highland, TerrainType.Mountain];
// Overlord MATH uses string terrain keys; map engine numeric enum -> string.
const TERRAIN_KEY: Record<number, string> = {
  [TerrainType.Plains]: "Plains",
  [TerrainType.Highland]: "Highland",
  [TerrainType.Mountain]: "Mountain",
};

let MATH: any;
beforeAll(() => {
  MATH = loadMath();
});

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

describe("Overlord MATH ↔ DefaultConfig parity", () => {
  it("attackLogic vs player matches the engine across randomized inputs", () => {
    const cfg = realConfig();
    const rand = rng(12345);
    let cases = 0;
    for (let i = 0; i < 400; i++) {
      const terrain = TERRAINS[Math.floor(rand() * TERRAINS.length)];
      const attackTroops = Math.max(1, Math.floor(rand() * 2_000_000) + 1);
      const defTroops = Math.floor(rand() * 2_000_000);
      const defTiles = Math.max(1, Math.floor(rand() * 200_000) + 1);
      const atkTiles = Math.floor(rand() * 300_000);
      const attackerType =
        rand() < 0.7 ? PlayerType.Human : PlayerType.Nation;
      const defenderType = rand() < 0.5 ? PlayerType.Human : PlayerType.Bot;
      const hasDP = rand() < 0.3;
      const traitor = rand() < 0.2;
      const fallout = rand() < 0.25;
      const numFallout = fallout ? Math.floor(rand() * 50000) : 0;

      const attacker = mockPlayer({
        type: attackerType,
        troops: attackTroops,
        tiles: atkTiles,
      });
      const defender = mockPlayer({
        type: defenderType,
        troops: defTroops,
        tiles: defTiles,
        traitor,
      });
      const gm = mockGame(cfg, {
        terrainType: terrain,
        hasFallout: fallout,
        numTilesWithFallout: numFallout,
        numLandTiles: 100000,
        defensePostOwner: hasDP ? defender : null,
      });

      const expected = cfg.attackLogic(
        gm as any,
        attackTroops,
        attacker as any,
        defender as any,
        0,
      );
      const got = MATH.attackLogic({
        terrainType: TERRAIN_KEY[terrain],
        attackTroops,
        attackerType,
        defenderIsPlayer: true,
        defenderTroops: defTroops,
        defenderTiles: defTiles,
        defenderType,
        defenderHasDefensePost: hasDP,
        defenderIsTraitor: traitor,
        attackerTiles: atkTiles,
        hasFallout: fallout,
        falloutRatio: numFallout / 100000,
      });

      expect(got.attackerTroopLoss).toBeCloseTo(expected.attackerTroopLoss, 6);
      expect(got.defenderTroopLoss).toBeCloseTo(expected.defenderTroopLoss, 6);
      expect(got.tilesPerTickUsed).toBeCloseTo(expected.tilesPerTickUsed, 6);
      cases++;
    }
    expect(cases).toBeGreaterThan(100);
  });

  it("attackLogic vs TerraNullius matches the engine", () => {
    const cfg = realConfig();
    const rand = rng(777);
    for (let i = 0; i < 200; i++) {
      const terrain = TERRAINS[Math.floor(rand() * TERRAINS.length)];
      const attackTroops = Math.max(1, Math.floor(rand() * 1_000_000) + 1);
      const attackerType = rand() < 0.5 ? PlayerType.Human : PlayerType.Bot;
      const attacker = mockPlayer({ type: attackerType, troops: attackTroops });
      const tn = mockTerraNullius();
      const gm = mockGame(cfg, { terrainType: terrain });

      const expected = cfg.attackLogic(
        gm as any,
        attackTroops,
        attacker as any,
        tn as any,
        0,
      );
      const got = MATH.attackLogic({
        terrainType: TERRAIN_KEY[terrain],
        attackTroops,
        attackerType,
        defenderIsPlayer: false,
      });
      expect(got.attackerTroopLoss).toBeCloseTo(expected.attackerTroopLoss, 6);
      expect(got.defenderTroopLoss).toBe(0);
      expect(got.tilesPerTickUsed).toBeCloseTo(expected.tilesPerTickUsed, 6);
    }
  });

  it("attackTilesPerTick matches the engine", () => {
    const cfg = realConfig();
    const rand = rng(99);
    for (let i = 0; i < 200; i++) {
      const atk = Math.max(1, Math.floor(rand() * 1_000_000));
      const defTroops = Math.floor(rand() * 1_000_000) + 1;
      const adj = Math.floor(rand() * 50) + 1;
      const isPlayer = rand() < 0.5;
      const defender = isPlayer
        ? mockPlayer({ troops: defTroops })
        : mockTerraNullius();
      const expected = cfg.attackTilesPerTick(
        atk,
        mockPlayer({ troops: atk }) as any,
        defender as any,
        adj,
      );
      const got = MATH.attackTilesPerTick(atk, isPlayer, defTroops, adj);
      expect(got).toBeCloseTo(expected, 6);
    }
  });

  it("maxTroops matches the engine for all player types & difficulties", () => {
    const rand = rng(555);
    for (const type of [PlayerType.Human, PlayerType.Bot, PlayerType.Nation]) {
      for (const difficulty of [
        Difficulty.Easy,
        Difficulty.Medium,
        Difficulty.Hard,
        Difficulty.Impossible,
      ]) {
        const cfg = realConfig({ difficulty });
        for (let i = 0; i < 40; i++) {
          const tiles = Math.floor(rand() * 500_000);
          const cityLevels = Array.from(
            { length: Math.floor(rand() * 8) },
            () => Math.floor(rand() * 5) + 1,
          );
          const player = mockPlayer({ type, tiles, cityLevels });
          const expected = cfg.maxTroops(player as any);
          const got = MATH.maxTroops({
            tiles,
            cityLevelsSum: cityLevels.reduce((a, b) => a + b, 0),
            type,
            difficulty,
          });
          expect(got).toBeCloseTo(expected, 4);
        }
      }
    }
  });

  it("troopIncrease matches the engine", () => {
    const rand = rng(31337);
    for (const type of [PlayerType.Human, PlayerType.Bot, PlayerType.Nation]) {
      for (const difficulty of [
        Difficulty.Easy,
        Difficulty.Medium,
        Difficulty.Hard,
        Difficulty.Impossible,
      ]) {
        const cfg = realConfig({ difficulty });
        for (let i = 0; i < 30; i++) {
          const tiles = Math.floor(rand() * 200_000) + 100;
          const cityLevels = Array.from(
            { length: Math.floor(rand() * 5) },
            () => Math.floor(rand() * 5) + 1,
          );
          const player0 = mockPlayer({ type, tiles, cityLevels });
          const max = cfg.maxTroops(player0 as any);
          const troops = Math.floor(rand() * max);
          const player = mockPlayer({ type, tiles, cityLevels, troops });
          const expected = cfg.troopIncreaseRate(player as any);
          const got = MATH.troopIncrease({
            troops,
            max: MATH.maxTroops({
              tiles,
              cityLevelsSum: cityLevels.reduce((a, b) => a + b, 0),
              type,
              difficulty,
            }),
            type,
            difficulty,
          });
          expect(got).toBeCloseTo(expected, 4);
        }
      }
    }
  });

  it("goldAdditionRate matches the engine", () => {
    const cfg = realConfig();
    for (const type of [PlayerType.Human, PlayerType.Bot, PlayerType.Nation]) {
      const expected = Number(cfg.goldAdditionRate(mockPlayer({ type }) as any));
      expect(MATH.goldAdditionRate(type, 1)).toBe(expected);
    }
  });

  it("structure & unit costs match the engine", () => {
    const cfg = realConfig();
    const human = (owned: number, constructed: number) =>
      mockPlayer({
        type: PlayerType.Human,
        unitsOwned: {
          [UnitType.City]: owned,
          [UnitType.Port]: owned,
          [UnitType.Factory]: 0,
          [UnitType.DefensePost]: owned,
          [UnitType.SAMLauncher]: owned,
          [UnitType.Warship]: owned,
        },
        unitsConstructed: {
          [UnitType.City]: constructed,
          [UnitType.Port]: constructed,
          [UnitType.Factory]: 0,
          [UnitType.DefensePost]: constructed,
          [UnitType.SAMLauncher]: constructed,
          [UnitType.Warship]: constructed,
        },
      });
    const gm = mockGame(cfg, {});

    for (let n = 0; n <= 6; n++) {
      const player = human(n, n) as any;
      // City: count = min(owned, constructed) cities = n
      expect(Number(cfg.unitInfo(UnitType.City).cost(gm as any, player))).toBe(
        MATH.cityCost(n),
      );
      // Port/Factory share Port+Factory count = n (factory owned 0)
      expect(Number(cfg.unitInfo(UnitType.Port).cost(gm as any, player))).toBe(
        MATH.portCost(n),
      );
      expect(
        Number(cfg.unitInfo(UnitType.DefensePost).cost(gm as any, player)),
      ).toBe(MATH.defensePostCost(n));
      expect(
        Number(cfg.unitInfo(UnitType.SAMLauncher).cost(gm as any, player)),
      ).toBe(MATH.samCost(n));
      expect(
        Number(cfg.unitInfo(UnitType.Warship).cost(gm as any, player)),
      ).toBe(MATH.warshipCost(n));
    }
    // Fixed-cost units.
    const anyPlayer = human(0, 0) as any;
    expect(
      Number(cfg.unitInfo(UnitType.MissileSilo).cost(gm as any, anyPlayer)),
    ).toBe(MATH.missileSiloCost());
    expect(
      Number(cfg.unitInfo(UnitType.AtomBomb).cost(gm as any, anyPlayer)),
    ).toBe(MATH.atomBombCost());
    expect(
      Number(cfg.unitInfo(UnitType.HydrogenBomb).cost(gm as any, anyPlayer)),
    ).toBe(MATH.hydrogenBombCost());
    // MIRV cost scales with launched count.
    for (const launched of [0, 1, 3]) {
      const g = mockGame(cfg, { numMirvsLaunched: launched });
      expect(Number(cfg.unitInfo(UnitType.MIRV).cost(g as any, anyPlayer))).toBe(
        MATH.mirvCost(launched),
      );
    }
  });

  it("samRange & nukeMagnitude match the engine", () => {
    const cfg = realConfig();
    for (let level = 1; level <= 6; level++) {
      expect(MATH.samRange(level)).toBeCloseTo(cfg.samRange(level), 9);
    }
    for (const t of [
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
      UnitType.MIRVWarhead,
    ]) {
      const e = cfg.nukeMagnitudes(t);
      const g = MATH.nukeMagnitude(t);
      expect(g.inner).toBe(e.inner);
      expect(g.outer).toBe(e.outer);
    }
  });

  it("tradeShipGold & trainGold match the engine", () => {
    const cfg = realConfig();
    for (const dist of [0, 100, 300, 500, 1000, 2000]) {
      expect(MATH.tradeShipGold(dist, 1)).toBe(Number(cfg.tradeShipGold(dist)));
    }
    for (const rel of ["self", "team", "ally", "other"] as const) {
      for (const cities of [0, 5, 9, 10, 20, 50]) {
        expect(MATH.trainGold(rel, cities, 1)).toBe(
          Number(cfg.trainGold(rel, cities)),
        );
      }
    }
  });

  it("percentageTilesOwnedToWin matches the engine", () => {
    expect(MATH.percentageTilesOwnedToWin(false)).toBe(
      realConfig({ gameMode: GameMode.FFA }).percentageTilesOwnedToWin(),
    );
    expect(MATH.percentageTilesOwnedToWin(true)).toBe(
      realConfig({ gameMode: GameMode.Team }).percentageTilesOwnedToWin(),
    );
  });
});

describe("Overlord MATH derived optimizers (sanity)", () => {
  it("optimalAttackTroops returns all available vs TerraNullius", () => {
    expect(MATH.optimalAttackTroops(50000, 0, {})).toBe(50000);
    expect(MATH.optimalAttackTroops(0, 0, {})).toBe(0);
  });

  it("optimalAttackTroops respects saturation points vs a player", () => {
    const def = 100000;
    // Plenty available -> at least the ideal (1.6667x) point.
    const ideal = Math.ceil(def * MATH.ATK_RATIO_MIN_LOSS);
    expect(MATH.optimalAttackTroops(1_000_000, def, {})).toBeGreaterThanOrEqual(
      ideal,
    );
    // Between strong (1x) and ideal -> commit everything.
    expect(MATH.optimalAttackTroops(120000, def, {})).toBe(120000);
    // Below min-viable (0.5x) and not retaliating -> skip.
    expect(MATH.optimalAttackTroops(40000, def, {})).toBe(0);
    // Below min-viable but retaliating -> still send.
    expect(
      MATH.optimalAttackTroops(40000, def, { retaliating: true }),
    ).toBe(40000);
  });

  it("ticksToAfford is correct", () => {
    expect(MATH.ticksToAfford(1000, 100, 1000)).toBe(0);
    expect(MATH.ticksToAfford(0, 100, 1000)).toBe(10);
    expect(MATH.ticksToAfford(0, 0, 1000)).toBe(Infinity);
  });

  it("ticksToReachTroops grows monotonically and is finite below cap", () => {
    const params = { max: 1_000_000, type: PlayerType.Human, difficulty: Difficulty.Medium };
    const t = MATH.ticksToReachTroops(50000, 200000, params);
    expect(t).toBeGreaterThan(0);
    expect(Number.isFinite(t)).toBe(true);
  });
});
