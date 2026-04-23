import { vi } from "vitest";
import { NationAllianceBehavior } from "../src/core/execution/nation/NationAllianceBehavior";
import { NationEmojiBehavior } from "../src/core/execution/nation/NationEmojiBehavior";
import { AiAttackBehavior } from "../src/core/execution/utils/AiAttackBehavior";
import {
  Difficulty,
  Game,
  Player,
  PlayerInfo,
  PlayerType,
} from "../src/core/game/Game";
import { PseudoRandom } from "../src/core/PseudoRandom";
import { setup } from "./util/Setup";

describe("AiAttackBehavior stalls against overwhelming neighbors", () => {
  let game: Game;
  let nation: Player;
  let human: Player;
  let attackBehavior: AiAttackBehavior;

  async function setupGame(
    nationTroops: number,
    humanTroops: number,
  ): Promise<void> {
    game = await setup("big_plains", {
      infiniteGold: true,
      instantBuild: true,
      difficulty: Difficulty.Hard,
    });

    const nationInfo = new PlayerInfo(
      "nation_test",
      PlayerType.Nation,
      null,
      "nation_test",
    );
    const humanInfo = new PlayerInfo(
      "human_test",
      PlayerType.Human,
      null,
      "human_test",
    );
    game.addPlayer(nationInfo);
    game.addPlayer(humanInfo);

    nation = game.player("nation_test");
    human = game.player("human_test");

    // Cover every land tile, split evenly between the two players. This
    // guarantees they border each other and there is no TerraNullius left
    // (so the maybeAttack() flow falls through to attackBestTarget, where
    // the stall check lives).
    let count = 0;
    game.map().forEachTile((tile) => {
      if (!game.map().isLand(tile)) return;
      (count++ % 2 === 0 ? nation : human).conquer(tile);
    });

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }

    nation.setTroops(nationTroops);
    human.setTroops(humanTroops);

    const random = new PseudoRandom(42);
    const emojiBehavior = new NationEmojiBehavior(random, game, nation);
    const allianceBehavior = new NationAllianceBehavior(
      random,
      game,
      nation,
      emojiBehavior,
    );
    attackBehavior = new AiAttackBehavior(
      random,
      game,
      nation,
      0.5,
      0.5,
      0.2,
      allianceBehavior,
      emojiBehavior,
    );
  }

  // Pick troop counts comfortably above the reserve ratio so the only
  // thing that can block an attack is the stall check under test.
  const NATION_TROOPS = 1_000_000;
  const HUMAN_TROOPS_OVERWHELMING = 5_000_000;
  const HUMAN_TROOPS_COMPARABLE = 2_000_000;

  function countAttackExecutions(spy: {
    mock: { calls: unknown[][] };
  }): number {
    return spy.mock.calls.reduce<number>(
      (sum, call) =>
        sum +
        ((call[0] as { constructor: { name: string } }).constructor.name ===
        "AttackExecution"
          ? 1
          : 0),
      0,
    );
  }

  test("stalls when a bordering enemy has more than 2.5x our troops", async () => {
    await setupGame(NATION_TROOPS, HUMAN_TROOPS_OVERWHELMING);
    expect(human.troops()).toBeGreaterThan(nation.troops() * 2.5);

    const spy = vi.spyOn(game, "addExecution");
    // Call maybeAttack many times: with a massive neighbor we expect zero
    // attack executions regardless of the internal RNG outcomes (no
    // strategy should fire).
    for (let i = 0; i < 20; i++) {
      attackBehavior.maybeAttack();
    }

    expect(countAttackExecutions(spy)).toBe(0);
    spy.mockRestore();
  });

  test("does not stall when the bordering enemy is within 2.5x of our troops", async () => {
    // Nation is slightly stronger so the weakest-enemy strategy can fire
    // once the stall check is bypassed.
    await setupGame(HUMAN_TROOPS_COMPARABLE, NATION_TROOPS);
    expect(human.troops()).toBeLessThanOrEqual(nation.troops() * 2.5);

    const spy = vi.spyOn(game, "addExecution");
    // Call maybeAttack multiple times to smooth over the probabilistic
    // boat-attack branch and alliance-request branches inside maybeAttack.
    for (let i = 0; i < 20; i++) {
      attackBehavior.maybeAttack();
    }

    expect(countAttackExecutions(spy)).toBeGreaterThan(0);
    spy.mockRestore();
  });

  test("still retaliates against an active incoming attack while stalling", async () => {
    await setupGame(NATION_TROOPS, HUMAN_TROOPS_OVERWHELMING);
    expect(human.troops()).toBeGreaterThan(nation.troops() * 2.5);

    // Human creates an attack targeting the nation. We call createAttack
    // directly on the player so we have an in-progress incoming attack
    // without going through AttackExecution's init (which cancels out
    // opposing attacks and would hide the incoming attack on retaliation).
    human.createAttack(nation, 100_000, null, new Set());

    expect(nation.incomingAttacks().length).toBeGreaterThan(0);
    expect(attackBehavior.findIncomingAttackPlayer()).toBe(human);

    const spy = vi.spyOn(game, "addExecution");
    // Call maybeAttack multiple times to smooth over the probabilistic
    // boat-attack branch inside maybeAttack.
    for (let i = 0; i < 20; i++) {
      attackBehavior.maybeAttack();
    }

    // Retaliation attack should have been queued despite the stall state.
    expect(countAttackExecutions(spy)).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
