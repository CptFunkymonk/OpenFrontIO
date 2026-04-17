/**
 * Regression tests for the standalone superhuman userscript.
 *
 * The userscript is an IIFE that expects a browser environment. We load the
 * raw source inside a sandboxed jsdom window, stub the few globals it
 * touches at module-init time, then invoke the built-in scripted planner
 * suite (`runtime.test.runSuite`). That suite covers:
 *   - planner goal selection across a variety of world states
 *   - alliance diplomacy helpers (accept / reject / safety guards)
 *   - terrain-rush goal selection when a neighbour is collapsing
 *   - low-level SAM trajectory math
 *
 * Running it here ensures the userscript's internal acceptance tests stay
 * green as the codebase evolves.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(
  __dirname,
  "..",
  "tampermonkey-superhuman-bot.js",
);

let cachedRuntime: any = null;
function loadUserscript() {
  if (cachedRuntime) return cachedRuntime;
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const win: any = (globalThis as any).window;

  // Stub the APIs the script touches during boot. We don't need any of these
  // to actually do anything — the hooks just have to exist.
  win.WebSocket = win.WebSocket ?? class {};
  win.Worker = win.Worker ?? class {};
  win.localStorage = win.localStorage ?? {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  // setInterval fires the main loop; the runSuite helper sidesteps that and
  // runs synchronously, so we just need the global to exist (it already does
  // in jsdom).
  new Function(source).call(win);
  cachedRuntime = win.__superhumanBotRuntime;
  return cachedRuntime;
}

describe("tampermonkey-superhuman-bot planner suite", () => {
  it("passes the built-in scripted regression suite", () => {
    const runtime = loadUserscript();
    expect(runtime, "userscript should expose runtime on window").toBeDefined();
    expect(runtime.test?.runSuite, "runSuite should be wired up").toBeTypeOf(
      "function",
    );
    const summary = runtime.test.runSuite();
    const failing = summary.results.filter((r: any) => !r.pass);
    if (failing.length > 0) {
      // Surface every failure at once so the user doesn't have to re-run to
      // see what else broke.
      const details = failing
        .map(
          (r: any) =>
            `  - ${r.name}: expected=${r.expected}, actual=${r.actual}`,
        )
        .join("\n");
      throw new Error(
        `Userscript planner suite had ${failing.length} failure(s):\n${details}`,
      );
    }
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBeGreaterThan(0);
  });
});

describe("tampermonkey-superhuman-bot early-game naval guards", () => {
  // A minimal gameView stub that the boat-range helpers understand. Tiles
  // are just (x, y) coordinate pairs packed as indices into a WIDTH×HEIGHT
  // grid — enough for manhattanDist and numLandTiles.
  const WIDTH = 100;
  const ref = (x: number, y: number) => y * WIDTH + x;
  const xOf = (t: number) => t % WIDTH;
  const yOf = (t: number) => Math.floor(t / WIDTH);
  const stubGameView = (ticks: number) => ({
    ticks: () => ticks,
    numLandTiles: () => 10_000,
    manhattanDist: (a: number, b: number) =>
      Math.abs(xOf(a) - xOf(b)) + Math.abs(yOf(a) - yOf(b)),
    playerViews: () => [
      { isAlive: () => true },
      { isAlive: () => true },
      { isAlive: () => true },
      { isAlive: () => true },
      { isAlive: () => true },
      { isAlive: () => true },
    ],
    config: () => ({ numSpawnPhaseTurns: () => 100 }),
  });

  it("blocks boats very early when we barely own any land", () => {
    const runtime = loadUserscript();
    const { isTooEarlyForNaval, isBoatWithinRange } =
      runtime.test.internals;
    const gameView = stubGameView(500);
    const me = { numTilesOwned: () => 100 };

    expect(isTooEarlyForNaval(gameView, me)).toBe(true);
    expect(isBoatWithinRange(gameView, me, ref(5, 5), ref(90, 90))).toBe(false);
  });

  it("allows boats mid-game once mapShare and match time grow", () => {
    const runtime = loadUserscript();
    const { isTooEarlyForNaval, isBoatWithinRange } =
      runtime.test.internals;
    const gameView = stubGameView(5000);
    const me = { numTilesOwned: () => 1200 };

    expect(isTooEarlyForNaval(gameView, me)).toBe(false);
    expect(isBoatWithinRange(gameView, me, ref(20, 20), ref(25, 25))).toBe(true);
  });
});

describe("tampermonkey-superhuman-bot DefensePost human-border gate", () => {
  const WIDTH = 50;
  const ref = (x: number, y: number) => y * WIDTH + x;
  const xOf = (t: number) => t % WIDTH;
  const yOf = (t: number) => Math.floor(t / WIDTH);

  function makeGameView(
    PlayerType: any,
    opts: { enemyType: any; enemyTiles: Set<number> },
  ) {
    return {
      // getGameView() requires both `ticks` and `myPlayer` to be functions
      // before trusting the cached hook.
      ticks: () => 100,
      myPlayer: () => null,
      ownerID: (tile: number) => (opts.enemyTiles.has(tile) ? 2 : 0),
      playerBySmallID: (id: number) => {
        if (id !== 2) return null;
        return {
          isPlayer: () => true,
          type: () => opts.enemyType,
        };
      },
      circleSearch: (center: number, radius: number) => {
        const out = new Set<number>();
        const cx = xOf(center);
        const cy = yOf(center);
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dy = -radius; dy <= radius; dy++) {
            if (dx * dx + dy * dy > radius * radius) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= WIDTH) continue;
            out.add(ref(nx, ny));
          }
        }
        return out;
      },
    };
  }

  function installGameView(runtime: any, gameView: any) {
    runtime.hooks.gameView = gameView;
  }

  const me = {
    smallID: () => 1,
    isFriendly: () => false,
  };

  it("accepts tiles near a Human neighbour", () => {
    const runtime = loadUserscript();
    const { isTileNearHumanBorder, filterHumanBorderTiles, PlayerType } =
      runtime.test.internals;
    installGameView(
      runtime,
      makeGameView(PlayerType, {
        enemyType: PlayerType.Human,
        enemyTiles: new Set([ref(5, 5)]),
      }),
    );

    const candidate = ref(4, 4);
    expect(isTileNearHumanBorder(me, candidate)).toBe(true);
    expect(filterHumanBorderTiles(me, [candidate])).toEqual([candidate]);
  });

  it("rejects tiles whose only nearby enemy is a Nation", () => {
    const runtime = loadUserscript();
    const { isTileNearHumanBorder, filterHumanBorderTiles, PlayerType } =
      runtime.test.internals;
    installGameView(
      runtime,
      makeGameView(PlayerType, {
        enemyType: PlayerType.Nation,
        enemyTiles: new Set([ref(5, 5)]),
      }),
    );

    const candidate = ref(4, 4);
    expect(isTileNearHumanBorder(me, candidate)).toBe(false);
    expect(filterHumanBorderTiles(me, [candidate])).toEqual([]);
  });

  it("rejects tiles whose only nearby enemy is a Bot (tribe)", () => {
    const runtime = loadUserscript();
    const { isTileNearHumanBorder, filterHumanBorderTiles, PlayerType } =
      runtime.test.internals;
    installGameView(
      runtime,
      makeGameView(PlayerType, {
        enemyType: PlayerType.Bot,
        enemyTiles: new Set([ref(5, 5)]),
      }),
    );

    const candidate = ref(4, 4);
    expect(isTileNearHumanBorder(me, candidate)).toBe(false);
    expect(filterHumanBorderTiles(me, [candidate])).toEqual([]);
  });
});
