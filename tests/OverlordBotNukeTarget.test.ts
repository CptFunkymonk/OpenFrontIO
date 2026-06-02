/**
 * Plan §10/E1 — value-weighted nuke targeting. Verifies bestNukeTargetTile
 * aims at the enemy's densest structure cluster (cities weighted highest) and
 * respects SAM-clear paths.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { beforeAll, describe, expect, it } from "vitest";

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname2, "..", "tampermonkey-overlord-bot.js");
const W = 100;
const ref = (x: number, y: number) => y * W + x;
const City = "City";
const Port = "Port";
const HydrogenBomb = "Hydrogen Bomb";

let runtime: any;
beforeAll(() => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const win: any = (globalThis as any).window;
  win.__OVERLORD_TEST_MODE = true;
  win.WebSocket = win.WebSocket ?? class {};
  new Function(source).call(win);
  runtime = win.__overlordBotRuntime;
});

function gvWith(opts: any) {
  return {
    x: (r: number) => r % W,
    y: (r: number) => Math.floor(r / W),
    ref,
    isValidCoord: (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < W,
    myPlayer: () => ({ isFriendly: () => false, smallID: () => 99 }),
    nearbyUnits: (pt: number) => {
      const sam = opts.samTile;
      if (sam == null) return [];
      const dx = (pt % W) - (sam % W);
      const dy = Math.floor(pt / W) - Math.floor(sam / W);
      return [
        { distSquared: dx * dx + dy * dy, unit: { owner: () => ({ isMe: () => false }), level: () => 1 } },
      ];
    },
  };
}

function targetPlayer(structs: Array<{ tile: number; type: string }>) {
  return {
    smallID: () => 2,
    units: (...types: string[]) =>
      structs
        .filter((s) => types.length === 0 || types.includes(s.type))
        .map((s) => ({ tile: () => s.tile, type: () => s.type })),
  };
}

describe("value-weighted nuke targeting", () => {
  it("targets the dense city cluster, not an isolated structure", () => {
    // A tight cluster of 3 cities near (50,50) and one lone port far at (10,10).
    const structs = [
      { tile: ref(50, 50), type: City },
      { tile: ref(51, 50), type: City },
      { tile: ref(50, 51), type: City },
      { tile: ref(10, 10), type: Port },
    ];
    const gv = gvWith({ samTile: null });
    const choice = runtime.test.bestNukeTargetTile(
      gv,
      targetPlayer(structs),
      HydrogenBomb,
      ref(0, 0),
    );
    // Chosen tile should be inside the city cluster (x,y near 50).
    expect(Math.abs((choice.tile % W) - 50)).toBeLessThanOrEqual(1);
    expect(choice.clear).toBe(true);
  });

  it("avoids a SAM-covered cluster when a clear alternative exists", () => {
    // Two clusters: one at (50,50) covered by a SAM, one clear at (50,90).
    const structs = [
      { tile: ref(50, 12), type: City },
      { tile: ref(51, 12), type: City },
      { tile: ref(50, 95), type: City },
      { tile: ref(51, 95), type: City },
    ];
    const gv = gvWith({ samTile: ref(50, 10) }); // SAM (range ~70) covers (50,12)
    const choice = runtime.test.bestNukeTargetTile(
      gv,
      targetPlayer(structs),
      HydrogenBomb,
      ref(50, 99), // silo near the clear cluster so its path stays clear
    );
    expect(choice.clear).toBe(true);
    // Clear pick should be the (50,95) cluster, far from the SAM at (50,10).
    expect(Math.floor(choice.tile / W)).toBeGreaterThan(70);
  });
});
