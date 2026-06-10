/**
 * Plan §10/E2 — border-targeted defense placement. findDefensiveBuildTile must
 * return one of our border tiles that is adjacent to the threatening enemy, so
 * the DefensePost's x5 bonus lands on the hot front.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { beforeAll, describe, expect, it } from "vitest";

const D = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(D, "..", "tampermonkey-overlord-bot.js");
const W = 10;
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

describe("border-targeted defense placement", () => {
  it("returns a border tile adjacent to the threat", () => {
    // me owns 2x2 at (3,3); threat (sid 2) owns the column to the east.
    const own: Record<number, number> = {};
    own[ref(3, 3)] = 1;
    own[ref(4, 3)] = 1;
    own[ref(3, 4)] = 1;
    own[ref(4, 4)] = 1;
    own[ref(5, 3)] = 2;
    own[ref(5, 4)] = 2;
    const gv = {
      x: (r: number) => r % W,
      y: (r: number) => Math.floor(r / W),
      ownerID: (r: number) => own[r] ?? 0,
      neighbors: (r: number) => {
        const x = r % W,
          y = Math.floor(r / W),
          o: number[] = [];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx,
            ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < W) o.push(ref(nx, ny));
        }
        return o;
      },
      manhattanDist: (a: number, b: number) =>
        Math.abs((a % W) - (b % W)) +
        Math.abs(Math.floor(a / W) - Math.floor(b / W)),
    };
    const myPlayer = { smallID: () => 1, units: () => [] };
    // Seed the border cache the function reads.
    runtime.state._borderCache = {
      tick: 0,
      tiles: new Set([ref(3, 3), ref(4, 3), ref(3, 4), ref(4, 4)]),
    };
    const tile = runtime.test.findDefensiveBuildTile(gv as any, myPlayer as any, 2, 1);
    expect(tile).not.toBeNull();
    // The chosen tile must have a neighbour owned by the threat (sid 2).
    const facesThreat = gv
      .neighbors(tile)
      .some((n: number) => gv.ownerID(n) === 2);
    expect(facesThreat).toBe(true);
  });
});
