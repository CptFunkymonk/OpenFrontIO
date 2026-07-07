/**
 * Real-engine end-to-end test for the diplomatic-seal escape.
 *
 * Reproduces the classic FFA trap on the actual OpenFront engine (real
 * GameImpl / GameRunner / GameView, real alliance + expiry mechanics):
 * the bot is boxed in by two ALLIED neighbours covering every land border,
 * with zero terra nullius left. Before the fix the bot would sit there
 * until it betrayed someone (traitor debuff) or lost.
 *
 * The test drives the real per-tick brain (runModulesForTick) against the
 * live GameView and verifies the whole escape pipeline:
 *   1. computeThreats flags landFrontierOpen=false + diplomaticallySealed.
 *   2. The release valve arms: exactly one planned lapse, targeting the
 *      WEAKEST adjacent ally.
 *   3. The bot renews the alliance it wants to keep but withholds the
 *      extension for the release-valve ally.
 *   4. The alliance EXPIRES naturally on the engine side — and the bot is
 *      NOT marked as a traitor (the whole point: escape without betrayal).
 *   5. After expiry the seal lifts and the ex-ally shows up as a normal
 *      adjacent enemy for the planner to work with.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

import { AllianceRequestExecution } from "../src/core/execution/alliance/AllianceRequestExecution";
import { Executor } from "../src/core/execution/ExecutionManager";
import { SpawnExecution } from "../src/core/execution/SpawnExecution";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
  PlayerInfo,
  PlayerType,
} from "../src/core/game/Game";
import { createGame } from "../src/core/game/GameImpl";
import { GameView } from "../src/core/game/GameView";
import {
  genTerrainFromBin,
  MapManifest,
} from "../src/core/game/TerrainMapLoader";
import { UserSettings } from "../src/core/game/UserSettings";
import { GameRunner } from "../src/core/GameRunner";
import { GameConfig } from "../src/core/Schemas";
import { TestConfig } from "./util/TestConfig";
import { TestServerConfig } from "./util/TestServerConfig";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SCRIPT_PATH = path.join(ROOT, "tampermonkey-superhuman-bot.js");

function loadUserscript() {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  const win: any = (globalThis as any).window;
  win.WebSocket = win.WebSocket ?? class {};
  win.Worker = win.Worker ?? class {};
  win.__SUPERBOT_TEST_MODE = true;
  new Function(source).call(win);
  return win.__superhumanBotRuntime;
}

async function loadMap(mapName: string) {
  const base = path.join(ROOT, "tests/testdata/maps", mapName);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(base, "manifest.json"), "utf8"),
  ) as MapManifest;
  const gameMap = await genTerrainFromBin(
    manifest.map,
    fs.readFileSync(path.join(base, "map.bin")),
  );
  const miniGameMap = await genTerrainFromBin(
    manifest.map4x,
    fs.readFileSync(path.join(base, "map4x.bin")),
  );
  return { manifest, gameMap, miniGameMap };
}

describe("diplomatic seal escape on the real engine", () => {
  it(
    "boxed in by allies, the bot lapses (not betrays) an alliance and reopens its border",
    { timeout: 180_000 },
    async () => {
      const clientID = "superbot-client";
      const gameID = "seal-e2e";
      const { manifest, gameMap, miniGameMap } = await loadMap("plains");

      const gameConfig: GameConfig = {
        gameMap: GameMapType.World,
        gameMapSize: GameMapSize.Normal,
        gameMode: GameMode.FFA,
        gameType: GameType.Singleplayer,
        difficulty: Difficulty.Medium,
        nations: "disabled",
        donateGold: false,
        donateTroops: false,
        bots: 0,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
        randomSpawn: false,
      } as GameConfig;
      const config = new TestConfig(
        new TestServerConfig(),
        gameConfig,
        new UserSettings(),
        false,
      );

      const botInfo = new PlayerInfo(
        "SuperBot",
        PlayerType.Human,
        clientID,
        "superbot-id",
        true,
      );
      // Puppet humans: no AI executions, fully deterministic neighbours.
      const weakInfo = new PlayerInfo(
        "AllyWeak",
        PlayerType.Human,
        null,
        "ally-weak",
      );
      const strongInfo = new PlayerInfo(
        "AllyStrong",
        PlayerType.Human,
        null,
        "ally-strong",
      );

      const game = createGame(
        [botInfo, weakInfo, strongInfo],
        [],
        gameMap,
        miniGameMap,
        config,
      );

      let gameView: GameView | null = null;
      const onUpdate = (gu: any) => {
        if (gu && "errMsg" in gu) {
          throw new Error(`engine error: ${gu.errMsg}`);
        }
        if (gameView) gameView.update(gu);
      };
      const gr = new GameRunner(
        game,
        new Executor(game, gameID, clientID),
        onUpdate,
      );
      gr.init();

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
      gameView = new GameView(
        workerShim,
        config,
        { nations: manifest.nations ?? [], gameMap, miniGameMap } as any,
        clientID,
        "SuperBot",
        null,
        gameID,
        [botInfo] as any,
      );

      // --- Wire the userscript to the live GameView + intent bridge. ---
      const runtime = loadUserscript();
      runtime.enabled = true;
      runtime.mode = "balanced";
      const win: any = (globalThis as any).window;
      const pendingIntents: any[] = [];
      const allIntents: any[] = [];
      win.__openFrontLocalTransport = {
        isLocal: true,
        send: (msg: any) => {
          if (msg && msg.type === "intent" && msg.intent) {
            pendingIntents.push({ ...msg.intent, clientID });
            allIntents.push(msg.intent);
          }
        },
        addMessageListener: () => () => {},
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

      let turnNumber = 0;
      const engineTick = () => {
        gr.addTurn({
          turnNumber: turnNumber++,
          intents: pendingIntents.splice(0),
        });
        expect(gr.executeNextTick()).toBe(true);
      };

      // --- Spawn the three players, then finish the spawn phase. ---
      engineTick();
      const spawnAt = (info: PlayerInfo, x: number, y: number) =>
        game.addExecution(
          new SpawnExecution(
            gameID,
            game.player(info.id).info(),
            game.ref(x, y),
          ),
        );
      spawnAt(botInfo, 50, 50);
      spawnAt(weakInfo, 10, 50);
      spawnAt(strongInfo, 90, 50);
      while (game.inSpawnPhase()) engineTick();

      const bot = game.player("superbot-id") as Player;
      const weak = game.player("ally-weak") as Player;
      const strong = game.player("ally-strong") as Player;

      // --- Paint the trap: bot boxed in the center, allies owning ALL
      // remaining land. No terra nullius anywhere on the map. ---
      for (let x = 0; x < gameMap.width(); x++) {
        for (let y = 0; y < gameMap.height(); y++) {
          const tile = game.ref(x, y);
          if (!game.isLand(tile)) continue;
          const inBotBox = x >= 40 && x < 60 && y >= 40 && y < 60;
          const owner = inBotBox ? bot : x < 50 ? weak : strong;
          if (game.owner(tile) !== owner) (owner as any).conquer(tile);
        }
      }
      // Weak ally must be under RELEASE_VALVE_MAX_TROOP_RATIO (1.1x) of the
      // bot; strong ally far above it so it is never the release valve.
      (bot as any).setTroops(30_000);
      (weak as any).setTroops(20_000);
      (strong as any).setTroops(90_000);

      // --- Form both alliances (mutual requests auto-accept). ---
      game.addExecution(new AllianceRequestExecution(bot, weak.id()));
      game.addExecution(new AllianceRequestExecution(bot, strong.id()));
      engineTick();
      game.addExecution(new AllianceRequestExecution(weak, bot.id()));
      game.addExecution(new AllianceRequestExecution(strong, bot.id()));
      engineTick();
      expect(bot.isAlliedWith(weak)).toBe(true);
      expect(bot.isAlliedWith(strong)).toBe(true);

      // --- Phase 1: run the brain; the seal must be detected and the
      // release valve armed. ---
      for (let i = 0; i < 30; i++) {
        engineTick();
        await internals.runModulesForTick();
      }

      const threats = runtime.world.threats;
      expect(threats.landFrontierOpen).toBe(false);
      expect(threats.diplomaticallySealed).not.toBeNull();
      expect(threats.diplomaticallySealed.alliedNeighborCount).toBe(2);
      expect(threats.adjacentEnemies).toHaveLength(0);

      expect(runtime.intel.plannedLapses.size).toBe(1);
      const lapse = Array.from(runtime.intel.plannedLapses.values())[0] as any;
      expect(lapse.smallID).toBe(weak.smallID());

      // --- Phase 2: fast-forward through the alliance duration. The bot
      // must renew the alliance it keeps, withhold the release valve's
      // extension, and let the engine expire it. ---
      const weakAlliance = bot.allianceWith(weak)!;
      const expiresAt = weakAlliance.expiresAt();
      while (game.ticks() <= expiresAt + 2) {
        engineTick();
        if (game.ticks() % 5 === 0) {
          await internals.runModulesForTick();
        }
      }

      const extensions = allIntents.filter(
        (i) => i.type === "allianceExtension",
      );
      expect(extensions.some((i) => i.recipient === strong.id())).toBe(true);
      expect(extensions.some((i) => i.recipient === weak.id())).toBe(false);

      // The trap is escaped WITHOUT betrayal: the alliance lapsed
      // naturally, no breakAlliance intent was ever sent, and the bot
      // carries no traitor debuff.
      expect(bot.isAlliedWith(weak)).toBe(false);
      expect(bot.isTraitor()).toBe(false);
      expect(allIntents.filter((i) => i.type === "breakAlliance")).toHaveLength(
        0,
      );

      // --- Phase 3: the border is open again — the ex-ally is now a
      // normal adjacent enemy and the seal is gone. ---
      for (let i = 0; i < 10; i++) {
        engineTick();
        await internals.runModulesForTick();
      }
      expect(runtime.world.threats.diplomaticallySealed).toBeNull();
      expect(runtime.intel.plannedLapses.size).toBe(0);
      expect(
        runtime.world.threats.adjacentEnemies.some(
          (e: any) => e.smallID === weak.smallID(),
        ),
      ).toBe(true);
    },
  );
});
