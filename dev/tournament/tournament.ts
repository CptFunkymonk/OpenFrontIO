/**
 * Headless Overlord tournament.
 *
 * Runs the REAL Overlord userscript bot (loaded into a Node-side fake window)
 * against Impossible-difficulty Nation AIs in a full FFA game on the core
 * engine — no rendering, no tick gating — so we can play many games fast and
 * tally wins/losses/placement.
 *
 * The bot reads a GameView and emits intents; here we adapt the core Game/Player
 * into the GameView/PlayerView shape the bot expects, and convert its intents
 * into core Executions.
 *
 * Usage: npx tsx dev/tournament/tournament.ts [numGames] [numNations] [map]
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  Cell,
  Difficulty,
  GameMapType,
  GameMode,
  GameType,
  Nation,
  PlayerInfo,
  PlayerType,
} from "../../src/core/game/Game";
import { DefaultConfig } from "../../src/core/configuration/DefaultConfig";
import { AttackExecution } from "../../src/core/execution/AttackExecution";
import { ConstructionExecution } from "../../src/core/execution/ConstructionExecution";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import { TransportShipExecution } from "../../src/core/execution/TransportShipExecution";
import { TargetPlayerExecution } from "../../src/core/execution/TargetPlayerExecution";
import { EmbargoExecution } from "../../src/core/execution/EmbargoExecution";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import { BreakAllianceExecution } from "../../src/core/execution/alliance/BreakAllianceExecution";
import { NationExecution } from "../../src/core/execution/NationExecution";
import { WinCheckExecution } from "../../src/core/execution/WinCheckExecution";
import { setup } from "../../tests/util/Setup";
import { TestConfig } from "../../tests/util/TestConfig";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");

// Real-math config: extend DefaultConfig (NOT the stubbed TestConfig) so
// attackLogic / maxTroops / samRange / costs are the true engine values. We
// only skip the nav-mesh (boat pathfinding) to keep the headless run light.
class TournamentConfig extends DefaultConfig {
  disableNavMesh(): boolean {
    return true;
  }
}

// ── Load the real Overlord userscript into a Node-side fake window. ──
function loadBot(): any {
  const src = readFileSync(path.join(REPO, "tampermonkey-overlord-bot.js"), "utf8");
  const win: any = { __OVERLORD_TEST_MODE: true };
  (globalThis as any).window = win;
  // No document / no WebSocket -> UI + WS hook stay dormant; we drive directly.
  new Function(src).call(win);
  return win.__overlordBotRuntime;
}

// ── Game→GameView / Player→PlayerView adapter ──────────────────────────────
function makeAdapter(game: any, ourCore: any, gameID: string) {
  const playerCache = new Map<any, any>();
  const unwrap = (o: any) => (o && o.__core ? o.__core : o);

  function wrapUnit(u: any) {
    return {
      __core: u,
      type: () => u.type(),
      level: () => (u.level ? u.level() : 1),
      isUnderConstruction: () => (u.isUnderConstruction ? u.isUnderConstruction() : false),
      isActive: () => u.isActive(),
      tile: () => u.tile(),
      targetTile: () => (u.targetTile ? u.targetTile() : undefined),
      owner: () => wrapPlayer(u.owner()),
      health: () => (u.health ? u.health() : 0),
      missileReadinesss: () => (u.missileReadinesss ? u.missileReadinesss() : 1),
    };
  }

  function mapAttacks(attacks: any[], asIncoming: boolean) {
    const out: any[] = [];
    if (!attacks) return out;
    for (const a of attacks) {
      try {
        const tgt = a.target();
        out.push({
          attackerID: a.attacker().smallID(),
          targetID: tgt && tgt.isPlayer && tgt.isPlayer() ? tgt.smallID() : 0,
          troops: a.troops(),
          id: a.id(),
          retreating: a.retreating(),
        });
      } catch (_) {
        /* ignore */
      }
    }
    return out;
  }

  function wrapPlayer(cp: any): any {
    if (!cp) return null;
    const cached = playerCache.get(cp);
    if (cached) return cached;
    const w: any = {
      __core: cp,
      smallID: () => cp.smallID(),
      id: () => cp.id(),
      name: () => cp.name(),
      type: () => cp.type(),
      team: () => cp.team(),
      isAlive: () => cp.isAlive(),
      isPlayer: () => true,
      isMe: () => cp === ourCore,
      troops: () => cp.troops(),
      gold: () => cp.gold(),
      numTilesOwned: () => cp.numTilesOwned(),
      isTraitor: () => cp.isTraitor(),
      isDisconnected: () => cp.isDisconnected(),
      hasSpawned: () => cp.hasSpawned(),
      getTraitorRemainingTicks: () => 0,
      isFriendly: (o: any) => cp.isFriendly(unwrap(o)),
      isAlliedWith: (o: any) => cp.isAlliedWith(unwrap(o)),
      isOnSameTeam: (o: any) => cp.isOnSameTeam(unwrap(o)),
      allies: () => cp.allies().map(wrapPlayer),
      alliances: () => cp.alliances(),
      targets: () => cp.targets().map(wrapPlayer),
      hasEmbargoAgainst: (o: any) => cp.hasEmbargoAgainst(unwrap(o)),
      isRequestingAllianceWith: (o: any) => {
        try {
          return cp.outgoingAllianceRequests().some((r: any) => r.recipient() === unwrap(o));
        } catch (_) {
          return false;
        }
      },
      incomingAttacks: () => mapAttacks(safe(() => cp.incomingAttacks(), []), true),
      outgoingAttacks: () => mapAttacks(safe(() => cp.outgoingAttacks(), []), false),
      units: (...types: any[]) => cp.units(...types).map(wrapUnit),
      totalUnitLevels: (t: any) =>
        cp.units(t).reduce((s: number, u: any) => s + (u.level ? u.level() : 1), 0),
      borderTiles: async () => ({ borderTiles: cp.borderTiles() }),
      bestTransportShipSpawn: async () => false,
    };
    playerCache.set(cp, w);
    return w;
  }

  const cfg = game.config();
  const gv: any = {
    ticks: () => game.ticks(),
    inSpawnPhase: () => game.inSpawnPhase(),
    numLandTiles: () => game.numLandTiles(),
    width: () => game.width(),
    height: () => game.height(),
    ref: (x: number, y: number) => game.ref(x, y),
    x: (r: number) => game.x(r),
    y: (r: number) => game.y(r),
    isValidCoord: (x: number, y: number) => game.isValidCoord(x, y),
    isLand: (r: number) => game.isLand(r),
    isOcean: (r: number) => game.isOcean(r),
    isOceanShore: (r: number) => safe(() => game.isOceanShore(r), false),
    hasOwner: (r: number) => game.hasOwner(r),
    ownerID: (r: number) => game.ownerID(r),
    hasFallout: (r: number) => safe(() => game.hasFallout(r), false),
    neighbors: (r: number) => game.neighbors(r),
    manhattanDist: (a: number, b: number) => game.manhattanDist(a, b),
    nearbyUnits: (t: number, range: number, type: any) =>
      safe(() => game.nearbyUnits(t, range, type), []).map((o: any) => ({
        unit: wrapUnit(o.unit),
        distSquared: o.distSquared,
      })),
    numTilesWithFallout: () => safe(() => game.numTilesWithFallout(), 0),
    myPlayer: () => wrapPlayer(ourCore),
    players: () => game.players().map(wrapPlayer),
    playerViews: () => game.players().map(wrapPlayer),
    playerBySmallID: (sid: number) => {
      const p = game.playerBySmallID(sid);
      return p && p.isPlayer && p.isPlayer() ? wrapPlayer(p) : { isPlayer: () => false };
    },
    units: (...types: any[]) => game.units(...types).map(wrapUnit),
    unit: (id: number) => {
      const u = game.unit(id);
      return u ? wrapUnit(u) : undefined;
    },
    config: () => ({
      gameConfig: () => cfg.gameConfig(),
      maxTroops: (p: any) => cfg.maxTroops(unwrap(p)),
      boatMaxNumber: () => cfg.boatMaxNumber(),
      isUnitDisabled: (t: any) => cfg.isUnitDisabled(t),
      samRange: (l: number) => cfg.samRange(l),
      maxSamRange: () => cfg.maxSamRange(),
      defensePostRange: () => cfg.defensePostRange(),
      percentageTilesOwnedToWin: () => cfg.percentageTilesOwnedToWin(),
    }),
    // reset per-tick caches not needed: methods read live state.
    _resetCache: () => playerCache.clear(),
  };

  // Intent → Execution sink (the bot's "socket").
  function applyIntent(intent: any) {
    try {
      switch (intent.type) {
        case "spawn":
          game.addExecution(new SpawnExecution(gameID, ourCore.info(), intent.tile));
          break;
        case "attack":
          game.addExecution(
            new AttackExecution(
              intent.troops,
              ourCore,
              intent.targetID === null ? game.terraNullius().id() : intent.targetID,
            ),
          );
          break;
        case "build_unit":
          game.addExecution(new ConstructionExecution(ourCore, intent.unit, intent.tile));
          break;
        case "boat":
          game.addExecution(new TransportShipExecution(ourCore, intent.dst, intent.troops));
          break;
        case "allianceRequest":
          game.addExecution(new AllianceRequestExecution(ourCore, intent.recipient));
          break;
        case "breakAlliance":
          game.addExecution(new BreakAllianceExecution(ourCore, intent.recipient));
          break;
        case "embargo":
          game.addExecution(new EmbargoExecution(ourCore, intent.targetID, intent.action));
          break;
        case "targetPlayer":
          game.addExecution(new TargetPlayerExecution(ourCore, intent.target));
          break;
        default:
          // upgrade_structure / donate / cancel / move_warship / delete_unit: skip
          break;
      }
    } catch (_) {
      /* ignore malformed intents */
    }
  }

  return { gv, applyIntent, wrapPlayer };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

function resetBotState(runtime: any) {
  runtime.world = null;
  runtime.planner.activeGoalId = null;
  runtime.hooks.gameView = null;
  runtime.hooks.localBridge = null;
  runtime.hooks.socket = null;
  runtime.hooks.tick = 0;
  runtime.hooks.isLocal = true;
  runtime.state.history = new Map();
  runtime.state.cooldowns = {};
  runtime.state.intentsSent = 0;
  runtime.state.intentsConfirmed = 0;
  runtime.state.lastIntentSignature = null;
  runtime.state._spawned = false;
  runtime.state._spawnSentTick = null;
  runtime.state._lastSpawnTile = null;
  runtime.state._borderCache = null;
  runtime.state._breaksUsed = 0;
}

function spreadCells(width: number, height: number, n: number): Cell[] {
  const cells: Cell[] = [];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  let k = 0;
  for (let r = 0; r < rows && k < n; r++) {
    for (let c = 0; c < cols && k < n; c++) {
      const x = Math.floor(((c + 0.5) / cols) * width);
      const y = Math.floor(((r + 0.5) / rows) * height);
      cells.push(new Cell(x, y));
      k++;
    }
  }
  return cells;
}

async function runOneGame(
  runtime: any,
  gameIndex: number,
  numNations: number,
  mapName: string,
): Promise<any> {
  const gameID = "tourney-" + gameIndex;
  const game: any = await setup(
    mapName,
    {
      gameMap: GameMapType.Asia, // overridden by mapName file load
      difficulty: Difficulty.Impossible,
      gameMode: GameMode.FFA,
      gameType: GameType.Singleplayer,
      nations: "disabled",
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
      goldMultiplier: Number(process.env.GOLDX || "10"),
    },
    [],
    REPO + "/tests/util",
    TournamentConfig as unknown as typeof TestConfig,
  );

  // Our bot (human) + N Impossible nations.
  const overlordInfo = new PlayerInfo("Overlord", PlayerType.Human, null, "overlord");
  game.addPlayer(overlordInfo);

  const cells = spreadCells(game.width(), game.height(), numNations);
  for (let i = 0; i < numNations; i++) {
    const info = new PlayerInfo("Nation" + (i + 1), PlayerType.Nation, null, "nation-" + i);
    const nation = new Nation(cells[i], info);
    game.addExecution(new NationExecution(gameID, nation));
  }
  game.addExecution(new WinCheckExecution());

  const ourCore = game.player("overlord");
  const { gv, applyIntent } = makeAdapter(game, ourCore, gameID);

  resetBotState(runtime);
  runtime.hooks.gameView = gv;
  runtime.hooks.localBridge = {
    isLocal: true,
    send: (msg: any) => {
      if (msg && msg.intent) applyIntent(msg.intent);
    },
    addMessageListener: () => () => {},
  };

  const MAX_TICKS = 20000;
  let spawnFallbackDone = false;
  let peakTiles = 0;
  let spawnedAtTick = -1;

  while (game.ticks() < MAX_TICKS) {
    runtime.hooks.tick = game.ticks();
    gv._resetCache();
    try {
      await runtime.test.runModulesForTick();
    } catch (_) {
      /* keep going */
    }
    game.executeNextTick();
    const tnow = safe(() => ourCore.numTilesOwned(), 0);
    if (tnow > peakTiles) peakTiles = tnow;
    if (spawnedAtTick < 0 && tnow > 0) spawnedAtTick = game.ticks();

    // Spawn fallback: if spawn phase ended and our bot never claimed land,
    // force a spawn so it isn't dead on arrival.
    if (!spawnFallbackDone && !game.inSpawnPhase()) {
      spawnFallbackDone = true;
      if (safe(() => ourCore.numTilesOwned(), 0) === 0 && ourCore.isAlive()) {
        // find any unowned land tile
        for (let t = 0; t < game.width() * game.height(); t += 7) {
          if (game.isLand(t) && !game.hasOwner(t)) {
            game.addExecution(new SpawnExecution(gameID, overlordInfo, t));
            break;
          }
        }
      }
    }

    if (process.env.TIMELINE && game.ticks() % 100 === 0) {
      const inc = safe(() => ourCore.incomingAttacks().reduce((a: number, x: any) => a + x.troops(), 0), 0);
      console.log(
        `  t=${game.ticks()} tiles=${safe(() => ourCore.numTilesOwned(), 0)} ` +
          `troops=${Math.round(safe(() => ourCore.troops(), 0) / 10)} ` +
          `goal=${runtime.planner.activeGoalId} inc=${Math.round(inc / 10)} ` +
          `alive=${game.players().filter((p: any) => p.isAlive()).length} ` +
          `intents=${runtime.state.intentsSent}`,
      );
    }
    const winner = game.getWinner();
    if (winner !== null) {
      return finishResult(game, ourCore, winner, gameIndex, false, { peakTiles, spawnedAtTick, runtime });
    }
    if (!ourCore.isAlive() && !game.inSpawnPhase()) {
      return finishResult(game, ourCore, game.getWinner(), gameIndex, true, { peakTiles, spawnedAtTick, runtime });
    }
  }
  return finishResult(game, ourCore, game.getWinner(), gameIndex, !ourCore.isAlive(), { peakTiles, spawnedAtTick, runtime });
}

function finishResult(
  game: any,
  ourCore: any,
  winner: any,
  gameIndex: number,
  died = false,
  dbg: any = {},
) {
  const players = game
    .players()
    .slice()
    .sort((a: any, b: any) => b.numTilesOwned() - a.numTilesOwned());
  const place = players.findIndex((p: any) => p === ourCore) + 1;
  const won =
    winner !== null && winner.isPlayer && winner.isPlayer() && winner === ourCore;
  return {
    game: gameIndex,
    won,
    died,
    place: place || players.length + 1,
    totalPlayers: players.length,
    ourTiles: safe(() => ourCore.numTilesOwned(), 0),
    ourTroops: Math.round(safe(() => ourCore.troops(), 0) / 10),
    ticks: game.ticks(),
    winnerName: winner && winner.isPlayer && winner.isPlayer() ? winner.name() : winner ? String(winner) : "none",
    peakTiles: dbg.peakTiles ?? 0,
    spawnedAtTick: dbg.spawnedAtTick ?? -1,
    intentsSent: dbg.runtime ? dbg.runtime.state.intentsSent : 0,
    lastDecisions: dbg.runtime && process.env.DEBUG ? dbg.runtime.state.decisionLog.slice(-10) : undefined,
  };
}

async function main() {
  const numGames = parseInt(process.argv[2] || "100", 10);
  const numNations = parseInt(process.argv[3] || "6", 10);
  const mapName = process.argv[4] || "plains";

  const runtime = loadBot();
  console.log(
    `Overlord tournament: ${numGames} games vs ${numNations} Impossible nations on '${mapName}'`,
  );

  const results: any[] = [];
  let wins = 0;
  const t0 = Date.now();
  for (let i = 0; i < numGames; i++) {
    const r = await runOneGame(runtime, i, numNations, mapName);
    results.push(r);
    if (r.won) wins++;
    console.log(
      `Game ${i + 1}/${numGames}: ${r.won ? "WIN " : "loss"} place ${r.place}/${r.totalPlayers} ` +
        `tiles=${r.ourTiles} ticks=${r.ticks} winner=${r.winnerName}` +
        (r.died ? " (died)" : ""),
    );
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

  const places = results.map((r) => r.place);
  const avgPlace = (places.reduce((a, b) => a + b, 0) / places.length).toFixed(2);
  const top3 = results.filter((r) => r.place <= 3).length;
  const summary = {
    numGames,
    numNations,
    map: mapName,
    wins,
    winRate: ((wins / numGames) * 100).toFixed(1) + "%",
    top3Finishes: top3,
    avgPlace,
    elapsedSeconds: Number(elapsed),
  };
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));

  const outDir = path.join(REPO, "dev", "tournament");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "results.json"),
    JSON.stringify({ summary, results }, null, 2),
  );
  console.log("Wrote dev/tournament/results.json");
}

main().catch((e) => {
  console.error("tournament error", e);
  process.exit(1);
});
