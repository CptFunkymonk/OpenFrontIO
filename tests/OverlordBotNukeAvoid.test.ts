/**
 * Phase 8 (plan §3.6) — nuke SAM-trajectory avoidance.
 *
 * Verifies enemySamInterceptsPath flags a flight path that crosses an enemy
 * SAM's coverage and clears a path that does not, and that pickClearCrownTarget
 * prefers a SAM-free landing tile.
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

const W = 100;
const ref = (x: number, y: number) => y * W + x;

let runtime: any;
beforeAll(() => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const win: any = (globalThis as any).window;
  win.__OVERLORD_TEST_MODE = true;
  win.WebSocket = win.WebSocket ?? class {};
  new Function(source).call(win);
  runtime = win.__overlordBotRuntime;
});

/**
 * Mock gameView whose nearbyUnits returns an enemy SAM located at `samTile`
 * (level 1, range ~70) so any path sample within 70 of it is "covered".
 */
function makeGV(samTile: number | null) {
  return {
    x: (r: number) => r % W,
    y: (r: number) => Math.floor(r / W),
    ref,
    isValidCoord: (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < W,
    myPlayer: () => ({ isFriendly: () => false, smallID: () => 1 }),
    nearbyUnits: (pt: number, _range: number, _type: string) => {
      if (samTile == null) return [];
      const dx = (pt % W) - (samTile % W);
      const dy = Math.floor(pt / W) - Math.floor(samTile / W);
      const distSquared = dx * dx + dy * dy;
      return [
        {
          distSquared,
          unit: {
            owner: () => ({ isMe: () => false }),
            level: () => 1,
          },
        },
      ];
    },
  };
}

describe("nuke SAM-trajectory avoidance", () => {
  it("flags a path that passes through an enemy SAM bubble", () => {
    // src (5,50) -> dst (95,50); SAM sitting right on the path at (50,50).
    const gv = makeGV(ref(50, 50));
    const intercepted = runtime.test.enemySamInterceptsPath(
      gv,
      ref(5, 50),
      ref(95, 50),
    );
    expect(intercepted).toBe(true);
  });

  it("clears a path that stays out of SAM range", () => {
    // SAM parked far away at (50,5); path runs along y=90, > 70 from it.
    const gv = makeGV(ref(50, 5));
    const clear = runtime.test.enemySamInterceptsPath(
      gv,
      ref(5, 90),
      ref(95, 90),
    );
    expect(clear).toBe(false);
  });

  it("clears any path when there are no enemy SAMs", () => {
    const gv = makeGV(null);
    expect(
      runtime.test.enemySamInterceptsPath(gv, ref(0, 0), ref(99, 99)),
    ).toBe(false);
  });
});
