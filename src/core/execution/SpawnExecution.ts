import {
  Execution,
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  SpawnArea,
  TerrainType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PseudoRandom } from "../PseudoRandom";
import { GameID } from "../Schemas";
import { simpleHash } from "../Util";
import { PlayerExecution } from "./PlayerExecution";
import { TribeExecution } from "./TribeExecution";
import { getSpawnTiles } from "./Util";

type Spawn = { center: TileRef; tiles: TileRef[] };

type ScoredSpawn = Spawn & { score: number };

export class SpawnExecution implements Execution {
  private random: PseudoRandom;
  active: boolean = true;
  private mg: Game;
  private static readonly MAX_SPAWN_TRIES = 1_000;
  /** Avoid unbounded growth while sampling random spawn points each tick. */
  private static readonly MAX_CANDIDATE_CENTERS = 2_000;

  private readonly candidateByCenter = new Map<TileRef, ScoredSpawn>();
  private loggedSpawnFailure = false;

  constructor(
    gameID: GameID,
    private playerInfo: PlayerInfo,
    public tile?: TileRef,
  ) {
    this.random = new PseudoRandom(
      simpleHash(playerInfo.id) + simpleHash(gameID),
    );
  }

  init(mg: Game, ticks: number) {
    this.mg = mg;
  }

  tick(ticks: number) {
    if (!this.mg.inSpawnPhase()) {
      this.active = false;
      return;
    }

    let player: Player | null = null;
    if (this.mg.hasPlayer(this.playerInfo.id)) {
      player = this.mg.player(this.playerInfo.id);
    } else {
      player = this.mg.addPlayer(this.playerInfo);
    }

    // Security: If random spawn is enabled, prevent players from re-rolling their spawn location
    if (this.mg.config().isRandomSpawn() && player.hasSpawned()) {
      return;
    }

    player.tiles().forEach((t) => player.relinquish(t));

    const usePhasedRandomPlains =
      this.tile === undefined &&
      this.mg.config().isRandomSpawn() &&
      this.playerInfo.playerType === PlayerType.Human;

    if (usePhasedRandomPlains) {
      this.active = true;
      const spawnPhaseEnd = this.mg.config().numSpawnPhaseTurns();
      const collectionEnd = Math.floor((2 * spawnPhaseEnd) / 3);

      if (ticks <= collectionEnd) {
        const sampled = this.tryRandomScoredSpawn();
        if (sampled !== undefined) {
          this.rememberCandidate(sampled);
        }
        return;
      }

      const sorted = [...this.candidateByCenter.values()].sort(
        (a, b) => b.score - a.score,
      );
      for (const cand of sorted) {
        if (this.isSpawnStillValid(cand)) {
          this.applySpawn(player, cand);
          this.active = false;
          return;
        }
      }

      let attempts = 0;
      while (attempts < SpawnExecution.MAX_SPAWN_TRIES) {
        attempts++;
        const sampled = this.tryRandomScoredSpawn();
        if (sampled !== undefined && this.isSpawnStillValid(sampled)) {
          this.applySpawn(player, sampled);
          this.active = false;
          return;
        }
      }

      this.logSpawnFailureOnce();
      this.active = false;
      return;
    }

    const spawn = this.getSpawn(this.tile);

    if (!spawn) {
      this.logSpawnFailureOnce();
      return;
    }

    this.applySpawn(player, spawn);
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  private logSpawnFailureOnce() {
    if (this.loggedSpawnFailure) {
      return;
    }
    this.loggedSpawnFailure = true;
    console.warn(`SpawnExecution: cannot spawn ${this.playerInfo.name}`);
  }

  private applySpawn(player: Player, spawn: Spawn) {
    spawn.tiles.forEach((t) => {
      player.conquer(t);
    });

    if (!player.hasSpawned()) {
      this.mg.addExecution(new PlayerExecution(player));
      if (player.type() === PlayerType.Bot) {
        this.mg.addExecution(new TribeExecution(player));
      }
    }

    player.setSpawnTile(spawn.center);
  }

  private rememberCandidate(spawn: ScoredSpawn) {
    const prev = this.candidateByCenter.get(spawn.center);
    if (prev !== undefined && prev.score >= spawn.score) {
      return;
    }
    if (
      this.candidateByCenter.size >= SpawnExecution.MAX_CANDIDATE_CENTERS &&
      prev === undefined
    ) {
      let worstCenter: TileRef | undefined;
      let worstScore = Infinity;
      for (const [c, s] of this.candidateByCenter) {
        if (s.score < worstScore) {
          worstScore = s.score;
          worstCenter = c;
        }
      }
      if (worstCenter !== undefined && worstScore < spawn.score) {
        this.candidateByCenter.delete(worstCenter);
      } else {
        return;
      }
    }
    this.candidateByCenter.set(spawn.center, spawn);
  }

  private scoreSpawnPatch(tiles: TileRef[]): number {
    let plains = 0;
    let highland = 0;
    for (const t of tiles) {
      switch (this.mg.terrainType(t)) {
        case TerrainType.Plains:
          plains++;
          break;
        case TerrainType.Highland:
          highland++;
          break;
        default:
          break;
      }
    }
    // Plains-first: weight plains heavily vs highland; patch size breaks ties.
    return plains * 1000 + highland * 100 + tiles.length;
  }

  private isSpawnStillValid(spawn: Spawn): boolean {
    if (
      !this.mg.isLand(spawn.center) ||
      this.mg.hasOwner(spawn.center) ||
      this.mg.isBorder(spawn.center)
    ) {
      return false;
    }

    const tooClose = this.mg
      .allPlayers()
      .filter((p) => p.id() !== this.playerInfo.id)
      .some((p) => {
        const st = p.spawnTile();
        if (st === undefined) {
          return false;
        }
        return (
          this.mg.manhattanDist(st, spawn.center) <
          this.mg.config().minDistanceBetweenPlayers()
        );
      });

    if (tooClose) {
      return false;
    }

    return getSpawnTiles(this.mg, spawn.center, true) !== null;
  }

  private tryRandomScoredSpawn(): ScoredSpawn | undefined {
    const spawnArea = this.getTeamSpawnArea();
    let tries = 0;

    while (tries < SpawnExecution.MAX_SPAWN_TRIES) {
      tries++;

      const center = this.randTile(spawnArea);

      if (
        !this.mg.isLand(center) ||
        this.mg.hasOwner(center) ||
        this.mg.isBorder(center)
      ) {
        continue;
      }

      const isOtherPlayerSpawnedNearby = this.mg
        .allPlayers()
        .filter((p) => p.id() !== this.playerInfo.id)
        .some((p) => {
          const spawnTile = p.spawnTile();

          if (spawnTile === undefined) {
            return false;
          }

          return (
            this.mg.manhattanDist(spawnTile, center) <
            this.mg.config().minDistanceBetweenPlayers()
          );
        });

      if (isOtherPlayerSpawnedNearby) {
        continue;
      }

      const tiles = getSpawnTiles(this.mg, center, true);
      if (!tiles) {
        continue;
      }

      const score = this.scoreSpawnPatch(tiles);
      return { center, tiles, score };
    }

    return;
  }

  private getSpawn(center?: TileRef): Spawn | undefined {
    if (center !== undefined) {
      const tiles = getSpawnTiles(this.mg, center, false);

      if (!tiles.length) {
        return;
      }

      return { center, tiles };
    }

    const spawnArea = this.getTeamSpawnArea();
    let tries = 0;

    while (tries < SpawnExecution.MAX_SPAWN_TRIES) {
      tries++;

      const center = this.randTile(spawnArea);

      if (
        !this.mg.isLand(center) ||
        this.mg.hasOwner(center) ||
        this.mg.isBorder(center)
      ) {
        continue;
      }

      const isOtherPlayerSpawnedNearby = this.mg
        .allPlayers()
        .filter((player) => player.id() !== this.playerInfo.id)
        .some((player) => {
          const spawnTile = player.spawnTile();

          if (spawnTile === undefined) {
            return false;
          }

          return (
            this.mg.manhattanDist(spawnTile, center) <
            this.mg.config().minDistanceBetweenPlayers()
          );
        });

      if (isOtherPlayerSpawnedNearby) {
        continue;
      }

      const tiles = getSpawnTiles(this.mg, center, true);
      if (!tiles) {
        // if some of the spawn tile is outside of the land, we want to find another spawn tile
        continue;
      }

      return { center, tiles };
    }

    return;
  }

  private randTile(area?: SpawnArea): TileRef {
    if (area) {
      const x = this.random.nextInt(area.x, area.x + area.width);
      const y = this.random.nextInt(area.y, area.y + area.height);
      return this.mg.ref(x, y);
    }
    const x = this.random.nextInt(0, this.mg.width());
    const y = this.random.nextInt(0, this.mg.height());
    return this.mg.ref(x, y);
  }

  private getTeamSpawnArea(): SpawnArea | undefined {
    const player = this.mg.player(this.playerInfo.id);
    const team = player.team();
    if (team === null) {
      return undefined;
    }
    return this.mg.teamSpawnArea(team);
  }
}
