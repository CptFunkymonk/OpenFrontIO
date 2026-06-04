/**
 * Headless real-format FFA harness for the Superhuman Bot.
 *
 * Runs a COMPLETE Free-For-All game on the real OpenFront engine (real
 * `GameRunner` / `GameImpl`, real Nation + Tribe AIs, real FFA win condition)
 * and drives `tampermonkey-superhuman-bot.js` against it through the same
 * `window.__openFrontLocalTransport` bridge the browser singleplayer path uses.
 *
 * This is the foundation for iterating on the bot's strategy: it is fully
 * headless (no canvas / WebGL / browser), deterministic per game seed, and
 * reports the outcome (win/loss, rank, death tick, economy curve) plus the
 * bot's own RL decision dump.
 *
 * Usage:
 *   GAME_ENV=prod npx tsx scripts/ffa-harness.ts \
 *      --map plains --bots 20 --nations default --seed abc --maxTicks 8000 \
 *      --mode balanced --games 1 --rl
 *
 * All flags are optional; see DEFAULTS below.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";

import { Executor } from "../src/core/execution/ExecutionManager";
import { RecomputeRailClusterExecution } from "../src/core/execution/RecomputeRailClusterExecution";
import { WinCheckExecution } from "../src/core/execution/WinCheckExecution";
import { getGameLogicConfig } from "../src/core/configuration/ConfigLoader";
import { createGame } from "../src/core/game/GameImpl";
import { GameRunner } from "../src/core/GameRunner";
import { GameView } from "../src/core/game/GameView";
import { GameUpdateType } from "../src/core/game/GameUpdates";
import {
  Cell,
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Nation,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../src/core/game/Game";
import {
  genTerrainFromBin,
  MapManifest,
} from "../src/core/game/TerrainMapLoader";
import { UserSettings } from "../src/core/game/UserSettings";
import { GameConfig } from "../src/core/Schemas";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface HarnessOptions {
  map: string;
  bots: number;
  nations: "default" | "disabled" | number;
  seed: string;
  maxTicks: number;
  mode: string;
  games: number;
  rl: boolean;
  quiet: boolean;
}

const DEFAULTS: HarnessOptions = {
  map: "plains",
  bots: 20,
  nations: "default",
  seed: "ffa-0",
  maxTicks: 8000,
  mode: "balanced",
  games: 1,
  rl: false,
  quiet: false,
};

function parseArgs(argv: string[]): HarnessOptions {
  const opts: HarnessOptions = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--map":
        opts.map = next();
        break;
      case "--bots":
        opts.bots = parseInt(next(), 10);
        break;
      case "--nations": {
        const value = next();
        if (value === "default" || value === "disabled") {
          opts.nations = value;
        } else {
          opts.nations = parseInt(value, 10);
        }
        break;
      }
      case "--seed":
        opts.seed = next();
        break;
      case "--maxTicks":
        opts.maxTicks = parseInt(next(), 10);
        break;
      case "--mode":
        opts.mode = next();
        break;
      case "--games":
        opts.games = parseInt(next(), 10);
        break;
      case "--rl":
        opts.rl = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Map loading (mirrors tests/util/Setup.ts)
// ---------------------------------------------------------------------------

async function loadMap(mapName: string) {
  const base = path.join(ROOT, "tests/testdata/maps", mapName);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(base, "manifest.json"), "utf8"),
  ) as MapManifest;
  const mapBin = fs.readFileSync(path.join(base, "map.bin"));
  const miniBin = fs.readFileSync(path.join(base, "map4x.bin"));
  const gameMap = await genTerrainFromBin(manifest.map, mapBin);
  const miniGameMap = await genTerrainFromBin(manifest.map4x, miniBin);
  return { manifest, gameMap, miniGameMap };
}

// ---------------------------------------------------------------------------
// Bot loading inside a jsdom window
// ---------------------------------------------------------------------------

let cachedBotSource: string | null = null;
function botSource(): string {
  if (cachedBotSource === null) {
    cachedBotSource = fs.readFileSync(
      path.join(ROOT, "tampermonkey-superhuman-bot.js"),
      "utf8",
    );
  }
  return cachedBotSource;
}

/**
 * Load the userscript into a fresh jsdom window and return its runtime.
 * `setInterval` is stubbed during the IIFE so the bot's auto loop / overlay /
 * discovery timers never fire — the harness drives every tick deterministically.
 */
function loadBotRuntime(mode: string): {
  win: any;
  runtime: any;
  dom: JSDOM;
} {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const win: any = dom.window;
  win.__SUPERBOT_TEST_MODE = true;
  win.WebSocket = class {};
  win.Worker = class {};

  // Expose jsdom globals so the userscript's bare `window` / `document`
  // references resolve correctly inside `new Function`. We deliberately do NOT
  // expose `performance` — the bot uses the bare `performance` global which
  // resolves to Node's (non-recursive) perf_hooks implementation; jsdom's
  // patched `performance.now` recurses infinitely when used as a global.
  const prevGlobals: Record<string, any> = {};
  const globalKeys = [
    "window",
    "document",
    "navigator",
    "localStorage",
    "HTMLElement",
    "CustomEvent",
    "Node",
    "getComputedStyle",
  ];
  for (const key of globalKeys) {
    prevGlobals[key] = (globalThis as any)[key];
    try {
      (globalThis as any)[key] = win[key];
    } catch {
      // Some globals (e.g. navigator in Node 22) are read-only getters.
      try {
        Object.defineProperty(globalThis, key, {
          value: win[key],
          configurable: true,
          writable: true,
        });
      } catch {
        // Give up on this one; the bot only touches it on UI interactions.
      }
    }
  }

  // Stub setInterval during IIFE so the bot's timers don't auto-fire.
  const realSetInterval = globalThis.setInterval;
  const winSetInterval = win.setInterval;
  (globalThis as any).setInterval = () => 0 as any;
  win.setInterval = () => 0;

  try {
    new Function(botSource()).call(win);
  } finally {
    (globalThis as any).setInterval = realSetInterval;
    win.setInterval = winSetInterval;
    // Restore Node globals we temporarily overrode (keep window/document for
    // the bot's DOM overlay calls during the run).
    for (const key of globalKeys) {
      if (key === "window" || key === "document" || key === "localStorage") {
        continue;
      }
      try {
        (globalThis as any)[key] = prevGlobals[key];
      } catch {
        // Ignore restore failures for read-only globals.
      }
    }
  }

  const runtime = win.__superhumanBotRuntime;
  if (!runtime) {
    throw new Error("bot runtime did not initialize");
  }
  runtime.enabled = true;
  runtime.mode = mode;
  return { win, runtime, dom };
}

// ---------------------------------------------------------------------------
// Single-game outcome
// ---------------------------------------------------------------------------

interface GameOutcome {
  result: "win" | "loss" | "timeout";
  rankByTiles: number;
  alivePlayersAtEnd: number;
  totalPlayers: number;
  endTick: number;
  deathTick: number | null;
  peakTiles: number;
  peakTroops: number;
  peakGold: number;
  finalTiles: number;
  structuresAtDeathOrEnd: Record<string, number>;
  lastGoal: string | null;
  goalsAdopted: string[];
  winnerKind: string | null;
  winnerIsBot: boolean;
  seed: string;
  map: string;
  mode: string;
  durationMs: number;
}

const STRUCTURE_TYPES: [string, UnitType][] = [
  ["City", UnitType.City],
  ["Factory", UnitType.Factory],
  ["Port", UnitType.Port],
  ["DefensePost", UnitType.DefensePost],
  ["MissileSilo", UnitType.MissileSilo],
  ["SAMLauncher", UnitType.SAMLauncher],
];

function structureCounts(player: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, type] of STRUCTURE_TYPES) {
    try {
      out[name] = player.units(type).length;
    } catch {
      out[name] = 0;
    }
  }
  return out;
}

async function runOneGame(opts: HarnessOptions): Promise<GameOutcome> {
  const startedAt = Date.now();
  const { manifest, gameMap, miniGameMap } = await loadMap(opts.map);
  const manifestNations = manifest.nations ?? [];

  const clientID = "superbot-client";
  const gameID = `ffa-${opts.seed}`;

  const gameConfig: GameConfig = {
    gameMap: GameMapType.World,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Hard,
    nations: opts.nations,
    donateGold: false,
    donateTroops: false,
    bots: opts.bots,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
  } as GameConfig;

  const config = await getGameLogicConfig(gameConfig, new UserSettings());

  const humanInfo = new PlayerInfo(
    "SuperBot",
    PlayerType.Human,
    clientID,
    "superbot-id",
    true,
  );

  // Build Nation players from the map manifest (real AI opponents).
  const nationPlayers: Nation[] =
    opts.nations === "disabled"
      ? []
      : manifestNations.map(
          (n) =>
            new Nation(
              new Cell(n.coordinates[0], n.coordinates[1]),
              new PlayerInfo(n.name, PlayerType.Nation, null, `nation-${n.name}`),
            ),
        );

  const game = createGame(
    [humanInfo],
    nationPlayers,
    gameMap,
    miniGameMap,
    config,
    manifest.teamGameSpawnAreas,
  );

  // Win + last update capture; gameView assigned just below (closure).
  let gameView: GameView | null = null;
  let winner: any = null;
  const onUpdate = (gu: any) => {
    if (gu && "errMsg" in gu) {
      throw new Error(`engine error: ${gu.errMsg}\n${gu.stack ?? ""}`);
    }
    if (gameView) {
      gameView.update(gu);
    }
    const wins = gu.updates?.[GameUpdateType.Win];
    if (wins && wins.length > 0) {
      winner = wins[0].winner ?? null;
    }
  };

  const executor = new Executor(game, gameID, clientID);
  const gr = new GameRunner(game, executor, onUpdate);
  gr.init();

  // Minimal in-process worker shim: GameView's PlayerView calls these.
  const workerShim: any = {
    playerInteraction: (id: string, x?: number, y?: number, units?: any) =>
      Promise.resolve(gr.playerActions(id, x, y, units)),
    playerBuildables: (id: string, x?: number, y?: number, units?: any) =>
      Promise.resolve(gr.playerBuildables(id, x, y, units)),
    playerBorderTiles: (id: string) =>
      Promise.resolve(gr.playerBorderTiles(id)),
    attackClusteredPositions: (smallID: number, attackID?: string) =>
      Promise.resolve(gr.attackClusteredPositions(smallID, attackID)),
    playerProfile: (smallID: number) =>
      Promise.resolve(gr.playerProfile(smallID)),
    transportShipSpawn: (id: string, targetTile: number) =>
      Promise.resolve(gr.bestTransportShipSpawn(id, targetTile)),
    sendTurn: () => {},
    start: () => {},
    initialize: () => Promise.resolve(),
    cleanup: () => {},
  };

  const mapData = {
    nations: manifestNations,
    gameMap,
    miniGameMap,
  } as any;

  gameView = new GameView(
    workerShim,
    config,
    mapData,
    clientID,
    "SuperBot",
    null,
    gameID,
    [humanInfo] as any,
  );

  // Load the bot and wire it to our gameView + bridge.
  const { runtime } = loadBotRuntime(opts.mode);
  const win: any = globalThis.window;

  const pendingIntents: any[] = [];
  const listeners: Array<(msg: any) => void> = [];
  win.__openFrontLocalTransport = {
    isLocal: true,
    send: (msg: any) => {
      if (msg && msg.type === "intent" && msg.intent) {
        pendingIntents.push({ ...msg.intent, clientID });
      }
    },
    addMessageListener: (listener: (msg: any) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };

  runtime.hooks.gameView = gameView;
  const internals = runtime.test.internals;
  internals.installLocalTransportBridge();
  internals.handleServerMessage({
    type: "start",
    myClientID: clientID,
    gameStartInfo: {
      gameID,
      config: gameConfig,
      players: [{ clientID, username: "SuperBot" }],
    },
  });

  // Metrics
  let peakTiles = 0;
  let peakTroops = 0;
  let peakGold = 0;
  let deathTick: number | null = null;
  let botWasAlive = false;
  let endTick = 0;
  let structuresSnapshot: Record<string, number> = {};

  const botPlayer = () => {
    try {
      return game.playerByClientID(clientID);
    } catch {
      return null;
    }
  };

  for (let t = 0; t < opts.maxTicks; t++) {
    // Apply intents collected from the bot last tick as this turn.
    gr.addTurn({ turnNumber: t, intents: pendingIntents.splice(0) });
    const ok = gr.executeNextTick();
    if (!ok) {
      break;
    }
    endTick = game.ticks();

    // Drive the bot brain for this tick.
    await internals.runModulesForTick();

    const bp = botPlayer();
    if (bp) {
      const alive = bp.isAlive();
      if (alive) {
        botWasAlive = true;
        const tiles = bp.numTilesOwned();
        const troops = bp.troops();
        const gold = Number(bp.gold?.() ?? 0);
        if (tiles > peakTiles) peakTiles = tiles;
        if (troops > peakTroops) peakTroops = troops;
        if (gold > peakGold) peakGold = gold;
        structuresSnapshot = structureCounts(bp);
      } else if (botWasAlive && deathTick === null) {
        deathTick = game.ticks();
        structuresSnapshot = structureCounts(bp);
      }
    }

    if (winner) {
      break;
    }
    // Stop a bit after the bot dies (let it record), to save time.
    if (deathTick !== null && game.ticks() > deathTick + 5) {
      break;
    }
  }

  // Rankings + outcome
  const allPlayers = game
    .players()
    .filter((p: any) => p.isPlayer && p.isPlayer());
  const sortedByTiles = [...allPlayers].sort(
    (a: any, b: any) => b.numTilesOwned() - a.numTilesOwned(),
  );
  const bp = botPlayer();
  const rankByTiles =
    bp !== null
      ? sortedByTiles.findIndex((p: any) => p.smallID() === bp.smallID()) + 1
      : -1;
  const alivePlayersAtEnd = allPlayers.filter((p: any) => p.isAlive()).length;

  const winnerKind = winner ? winner[0] : null;
  // makeWinner() returns ["player", clientID, ...] for human winners.
  const winnerIsBot =
    winner !== null && winner[0] === "player" && winner[1] === clientID;

  let result: "win" | "loss" | "timeout";
  if (winnerIsBot) {
    result = "win";
  } else if (winner !== null || (bp !== null && !bp.isAlive())) {
    result = "loss";
  } else {
    result = "timeout";
  }

  const lastGoal = runtime.planner?.activeGoalId ?? null;
  const goalsAdopted = Array.from(
    runtime.rl?.tracking?.goalsEverAdopted ?? [],
  ) as string[];

  return {
    result,
    rankByTiles,
    alivePlayersAtEnd,
    totalPlayers: allPlayers.length,
    endTick,
    deathTick,
    peakTiles,
    peakTroops,
    peakGold,
    finalTiles: bp !== null ? bp.numTilesOwned() : 0,
    structuresAtDeathOrEnd: structuresSnapshot,
    lastGoal,
    goalsAdopted,
    winnerKind,
    winnerIsBot,
    seed: opts.seed,
    map: opts.map,
    mode: opts.mode,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Suppress the bot's and engine's chatty per-tick logging so batch output is
// readable. Harness/summary lines are printed via the saved `realLog`.
const realLog = console.log.bind(console);
function installLogFilter() {
  const NOISE = ["[SuperBot", "[GameImpl", "using default", "local server"];
  console.log = (...args: any[]) => {
    const first = args.length > 0 ? String(args[0]) : "";
    if (NOISE.some((p) => first.startsWith(p))) return;
    realLog(...args);
  };
  console.debug = () => {};
}

async function main() {
  if (!process.env.GAME_ENV) {
    process.env.GAME_ENV = "prod";
  }
  const opts = parseArgs(process.argv.slice(2));
  installLogFilter();
  const outcomes: GameOutcome[] = [];

  for (let g = 0; g < opts.games; g++) {
    const gameOpts =
      opts.games === 1 ? opts : { ...opts, seed: `${opts.seed}-${g}` };
    const outcome = await runOneGame(gameOpts);
    outcomes.push(outcome);
    if (!opts.quiet) {
      console.log(
        `[game ${g + 1}/${opts.games}] ${outcome.result.toUpperCase()} ` +
          `rank=${outcome.rankByTiles}/${outcome.totalPlayers} ` +
          `endTick=${outcome.endTick} deathTick=${outcome.deathTick ?? "-"} ` +
          `peakTiles=${outcome.peakTiles} finalTiles=${outcome.finalTiles} ` +
          `peakTroops=${outcome.peakTroops} ` +
          `structs=${JSON.stringify(outcome.structuresAtDeathOrEnd)} ` +
          `lastGoal=${outcome.lastGoal} ` +
          `goals=${outcome.goalsAdopted.join(",")} ` +
          `(${(outcome.durationMs / 1000).toFixed(1)}s)`,
      );
    }
  }

  const wins = outcomes.filter((o) => o.result === "win").length;
  console.log(
    `\n=== SUMMARY: ${wins}/${outcomes.length} wins ` +
      `(${((wins / outcomes.length) * 100).toFixed(0)}%) ` +
      `map=${opts.map} bots=${opts.bots} nations=${opts.nations} mode=${opts.mode} ===`,
  );

  // Write outcomes to rl-exports for later analysis.
  const outDir = path.join(ROOT, "rl-exports");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(outDir, `ffa-harness-${stamp}.json`),
    JSON.stringify({ opts, outcomes }, null, 2),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
