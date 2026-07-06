/**
 * Regression tests for the v2.15 whole-game plan + opponent intel +
 * adaptive spawn upgrades:
 *   - computeGamePlanPhase(): OPENING / EXPANSION / CONSOLIDATION /
 *     ASCENSION / ENDGAME / SURVIVAL transitions.
 *   - scoreCampaignCandidate() / chooseCampaignTarget(): persistent
 *     campaign selection with safety ceilings and crown containment.
 *   - planBias(): phase-driven goal priority nudges (incl. timer crunch).
 *   - updateOpponentIntel() / grudgeScoreFor(): attack memory + decay.
 *   - computeSnowballRisks(): trajectory-based invader prediction.
 *   - pickAppeasementTarget(): who we ask for peace, and who we refuse.
 *   - Spawn: stratified probe coverage, adaptive plains gate on
 *     plains-poor maps, and neighbour-crowding penalties.
 *
 * Runs the same way as SuperhumanBotPlanner.test.ts: loads the userscript
 * IIFE inside a jsdom window, then pokes at the internals it exposes.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { beforeEach, describe, expect, it } from "vitest";

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
  win.WebSocket = win.WebSocket ?? class {};
  win.Worker = win.Worker ?? class {};
  win.localStorage = win.localStorage ?? {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  new Function(source).call(win);
  cachedRuntime = win.__superhumanBotRuntime;
  return cachedRuntime;
}

const TerrainType = {
  Plains: 0,
  Highland: 1,
  Mountain: 2,
};

// ---------------------------------------------------------------------------
// World-model fixture helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: any = {}) {
  return {
    smallID: overrides.smallID ?? 2,
    id: overrides.id ?? String(overrides.smallID ?? 2),
    name: overrides.name ?? "P" + (overrides.smallID ?? 2),
    type: overrides.type ?? "HUMAN",
    isMe: false,
    isFriendly: false,
    isAlly: false,
    isEnemy: true,
    isDisconnected: false,
    isTraitor: false,
    hasSpawned: true,
    troops: overrides.troops ?? 10_000,
    tiles: overrides.tiles ?? 1_000,
    gold: overrides.gold ?? 0,
    maxTroops: overrides.maxTroops ?? 100_000,
    troopRatio: overrides.troopRatio ?? 0.5,
    structures: overrides.structures ?? {},
    structureLevels: overrides.structureLevels ?? {},
    tilesPerMin: overrides.tilesPerMin ?? 0,
    troopsPerMin: overrides.troopsPerMin ?? 0,
    goldPerMin: 0,
    incomingAttacks: overrides.incomingAttacks ?? [],
    outgoingAttacks: [],
    incomingTroops: 0,
    outgoingTroops: 0,
    allyIDs: [],
    alliances: [],
    tags: new Set(),
    player: overrides.player ?? {},
    ...overrides,
  };
}

function installWorld(runtime: any, opts: any = {}) {
  const me = makeEntry({
    smallID: 1,
    isMe: true,
    isFriendly: true,
    isEnemy: false,
    troops: opts.myTroops ?? 50_000,
    tiles: opts.myTiles ?? 5_000,
    maxTroops: opts.myMaxTroops ?? 100_000,
    troopRatio:
      (opts.myTroops ?? 50_000) / Math.max(1, opts.myMaxTroops ?? 100_000),
    tilesPerMin: opts.myTilesPerMin ?? 0,
    troopsPerMin: opts.myTroopsPerMin ?? 0,
    structures: opts.myStructures ?? {},
    incomingAttacks: opts.myIncomingAttacks ?? [],
  });
  const everyone = [me, ...(opts.others ?? [])];
  const bySmallID = new Map(everyone.map((e: any) => [e.smallID, e]));
  const usableLand = opts.usableLand ?? 100_000;
  const sortedByTiles = everyone
    .slice()
    .sort((a: any, b: any) => b.tiles - a.tiles);
  runtime.world.me = me;
  runtime.world.meSmallID = 1;
  runtime.world.tick = opts.tick ?? 3_000;
  runtime.world.everyone = everyone;
  runtime.world.bySmallID = bySmallID;
  runtime.world.totals = {
    alivePlayers: everyone.length,
    humanCount: 1,
    nationCount: everyone.length - 1,
    botCount: 0,
    totalLand: usableLand,
    usableLand,
    crownShare: sortedByTiles[0].tiles / usableLand,
    myShare: me.tiles / usableLand,
    secondShare: (sortedByTiles[1]?.tiles ?? 0) / usableLand,
  };
  runtime.world.rankings = {
    byTiles: sortedByTiles.map((e: any) => e.smallID),
    byTroops: everyone
      .slice()
      .sort((a: any, b: any) => b.troops - a.troops)
      .map((e: any) => e.smallID),
    byTilesVelocity: [],
    byTroopsVelocity: [],
  };
  runtime.world.threats = {
    crownSmallID: opts.crown ? opts.crown.smallID : null,
    crown: opts.crown ?? null,
    risingStars: [],
    softTargets: [],
    collapsingTargets: [],
    nearestDanger: null,
    mirvRisk: false,
    mirvCapable: [],
    adjacentEnemies: opts.adjacentEnemies ?? [],
    narrowWaterNeighbors: [],
    activeInvaders: opts.activeInvaders ?? [],
    brewingInvaders: opts.brewingInvaders ?? [],
    snowballRisks: [],
    invasionTroopsInbound: opts.invasionTroopsInbound ?? 0,
    inboundTroopTotal: 0,
    overwhelmingNeighbor: null,
    earlyHumanOvermatch: null,
  };
  runtime.world.allianceGraph = {
    edges: new Map(),
    cliques: [],
    largestBlocShare: 0,
    coalitionThreat: false,
  };
  return { me, everyone };
}

function resetPlan(runtime: any) {
  runtime.plan.phase = "OPENING";
  runtime.plan.phaseSince = -1;
  runtime.plan.phaseHistory = [];
  runtime.plan.campaign = null;
  runtime.plan.campaignScoredAt = -999;
  runtime.plan.rank = 0;
  runtime.plan.sharePerMin = 0;
  runtime.plan.timerTicksLeft = null;
  runtime.plan.containLeader = false;
}

function resetIntel(runtime: any) {
  runtime.intel.grudges.clear();
  runtime.intel.seenAttackIDs.clear();
  runtime.intel.appeaseAttempts.clear();
}

beforeEach(() => {
  const runtime = loadUserscript();
  resetPlan(runtime);
  resetIntel(runtime);
  runtime.tickCache = null;
});

// ---------------------------------------------------------------------------
// computeGamePlanPhase
// ---------------------------------------------------------------------------

describe("computeGamePlanPhase — long-horizon phase arc", () => {
  it("returns SURVIVAL when invasion pressure is severe", () => {
    const runtime = loadUserscript();
    const { computeGamePlanPhase, GAME_PHASES } = runtime.test.internals;
    const invader = makeEntry({ smallID: 2, troops: 80_000 });
    installWorld(runtime, {
      myTroops: 40_000,
      activeInvaders: [invader],
      invasionTroopsInbound: 20_000, // 50% of our troops
    });
    const result = computeGamePlanPhase(runtime.world, runtime.world.me, 3_000);
    expect(result.phase).toBe(GAME_PHASES.SURVIVAL);
  });

  it("returns ENDGAME when we are the dominant #1", () => {
    const runtime = loadUserscript();
    const { computeGamePlanPhase, GAME_PHASES } = runtime.test.internals;
    installWorld(runtime, {
      myTiles: 35_000, // 35% share
      others: [makeEntry({ smallID: 2, tiles: 20_000 })], // 20% second
      usableLand: 100_000,
    });
    const result = computeGamePlanPhase(runtime.world, runtime.world.me, 6_000);
    expect(result.phase).toBe(GAME_PHASES.ENDGAME);
  });

  it("returns OPENING for a tiny early-game player", () => {
    const runtime = loadUserscript();
    const { computeGamePlanPhase, GAME_PHASES } = runtime.test.internals;
    installWorld(runtime, { myTiles: 500, usableLand: 100_000 });
    const result = computeGamePlanPhase(runtime.world, runtime.world.me, 300);
    expect(result.phase).toBe(GAME_PHASES.OPENING);
  });

  it("returns EXPANSION while terra nullius remains", () => {
    const runtime = loadUserscript();
    const { computeGamePlanPhase, GAME_PHASES } = runtime.test.internals;
    installWorld(runtime, {
      myTiles: 10_000,
      others: [makeEntry({ smallID: 2, tiles: 30_000 })],
      usableLand: 100_000, // 60% unowned
    });
    const result = computeGamePlanPhase(runtime.world, runtime.world.me, 3_000);
    expect(result.phase).toBe(GAME_PHASES.EXPANSION);
  });

  it("returns ASCENSION once the map is carved up and we're not #1", () => {
    const runtime = loadUserscript();
    const { computeGamePlanPhase, GAME_PHASES } = runtime.test.internals;
    installWorld(runtime, {
      myTiles: 30_000,
      others: [
        makeEntry({ smallID: 2, tiles: 40_000 }),
        makeEntry({ smallID: 3, tiles: 28_000 }),
      ],
      usableLand: 100_000, // 2% unowned
    });
    const result = computeGamePlanPhase(runtime.world, runtime.world.me, 6_000);
    expect(result.phase).toBe(GAME_PHASES.ASCENSION);
  });

  it("returns CONSOLIDATION when the army is depleted and tiles are shrinking", () => {
    const runtime = loadUserscript();
    const { computeGamePlanPhase, GAME_PHASES } = runtime.test.internals;
    installWorld(runtime, {
      myTiles: 30_000,
      myTroops: 10_000,
      myMaxTroops: 100_000, // 10% of cap
      myTilesPerMin: -50,
      others: [
        makeEntry({ smallID: 2, tiles: 40_000 }),
        makeEntry({ smallID: 3, tiles: 28_000 }),
      ],
      usableLand: 100_000,
    });
    const result = computeGamePlanPhase(runtime.world, runtime.world.me, 6_000);
    expect(result.phase).toBe(GAME_PHASES.CONSOLIDATION);
  });
});

// ---------------------------------------------------------------------------
// Campaign selection
// ---------------------------------------------------------------------------

describe("campaign targeting — persistent value/cost conquest", () => {
  it("prefers a weak adjacent nation over a strong distant one", () => {
    const runtime = loadUserscript();
    const { chooseCampaignTarget, PlayerType } = runtime.test.internals;
    const weakAdjacent = makeEntry({
      smallID: 2,
      name: "WeakAdjacent",
      type: PlayerType.Nation,
      troops: 20_000,
      tiles: 8_000,
      isAdjacent: true,
    });
    const strongDistant = makeEntry({
      smallID: 3,
      name: "StrongDistant",
      type: PlayerType.Nation,
      troops: 200_000,
      tiles: 30_000,
      isAdjacent: false,
    });
    installWorld(runtime, {
      myTroops: 50_000,
      others: [weakAdjacent, strongDistant],
    });
    const best = chooseCampaignTarget();
    expect(best).not.toBeNull();
    expect(best.entry.smallID).toBe(2);
  });

  it("refuses targets clearly stronger than us", () => {
    const runtime = loadUserscript();
    const { scoreCampaignCandidate, PlayerType } = runtime.test.internals;
    installWorld(runtime, { myTroops: 50_000 });
    const tooStrong = makeEntry({
      smallID: 2,
      type: PlayerType.Nation,
      troops: 80_000, // 1.6× us
      isAdjacent: true,
    });
    expect(
      scoreCampaignCandidate(tooStrong, runtime.world.me, runtime.world),
    ).toBeNull();
  });

  it("allows a stronger crown target under containment", () => {
    const runtime = loadUserscript();
    const { scoreCampaignCandidate, PlayerType } = runtime.test.internals;
    const crown = makeEntry({
      smallID: 2,
      name: "RunawayCrown",
      type: PlayerType.Nation,
      troops: 60_000, // 1.2× us — above the normal 1.05 ceiling
      tiles: 40_000,
      isAdjacent: true,
    });
    installWorld(runtime, {
      myTroops: 50_000,
      others: [crown],
      crown,
      usableLand: 100_000,
    });
    runtime.plan.containLeader = true;
    const scored = scoreCampaignCandidate(crown, runtime.world.me, runtime.world);
    expect(scored).not.toBeNull();
    expect(scored.isCrownContainment).toBe(true);
  });

  it("keeps the same campaign target across re-scores (persistence)", () => {
    const runtime = loadUserscript();
    const { maintainCampaign, PlayerType } = runtime.test.internals;
    const target = makeEntry({
      smallID: 2,
      name: "Victim",
      type: PlayerType.Nation,
      troops: 20_000,
      tiles: 8_000,
      isAdjacent: true,
    });
    const shinier = makeEntry({
      smallID: 3,
      name: "Shinier",
      type: PlayerType.Nation,
      troops: 10_000,
      tiles: 12_000,
      isAdjacent: true,
    });
    installWorld(runtime, { myTroops: 50_000, others: [target] });
    maintainCampaign(runtime.world.me, runtime.world, 3_000);
    expect(runtime.plan.campaign).not.toBeNull();
    expect(runtime.plan.campaign.smallID).toBe(2);

    // A shinier candidate appears; the campaign must NOT flap while the
    // current target is alive and progressing.
    runtime.world.everyone.push(shinier);
    runtime.world.bySmallID.set(3, shinier);
    target.tiles = 7_000; // we made progress against the target
    maintainCampaign(runtime.world.me, runtime.world, 3_100);
    expect(runtime.plan.campaign.smallID).toBe(2);
  });

  it("drops an eliminated campaign target and picks a new one", () => {
    const runtime = loadUserscript();
    const { maintainCampaign, PlayerType } = runtime.test.internals;
    const target = makeEntry({
      smallID: 2,
      type: PlayerType.Nation,
      troops: 20_000,
      tiles: 8_000,
      isAdjacent: true,
    });
    const backup = makeEntry({
      smallID: 3,
      type: PlayerType.Nation,
      troops: 15_000,
      tiles: 5_000,
      isAdjacent: true,
    });
    installWorld(runtime, { myTroops: 50_000, others: [target, backup] });
    maintainCampaign(runtime.world.me, runtime.world, 3_000);
    expect(runtime.plan.campaign.smallID).toBe(2);

    target.tiles = 0; // eliminated
    maintainCampaign(runtime.world.me, runtime.world, 3_100);
    expect(runtime.plan.campaign).not.toBeNull();
    expect(runtime.plan.campaign.smallID).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// planBias
// ---------------------------------------------------------------------------

describe("planBias — phase-driven priority nudges", () => {
  it("boosts CAMPAIGN_CONQUEST in ENDGAME and suppresses it in SURVIVAL", () => {
    const runtime = loadUserscript();
    const { planBias, GAME_PHASES } = runtime.test.internals;
    installWorld(runtime, {});
    runtime.plan.phase = GAME_PHASES.ENDGAME;
    expect(planBias("CAMPAIGN_CONQUEST")).toBeGreaterThan(0);
    runtime.plan.phase = GAME_PHASES.SURVIVAL;
    expect(planBias("CAMPAIGN_CONQUEST")).toBeLessThanOrEqual(-10);
  });

  it("suppresses expansion boosts while an invader is on the board", () => {
    const runtime = loadUserscript();
    const { planBias, GAME_PHASES } = runtime.test.internals;
    installWorld(runtime, {
      myTiles: 5_000, // 5% share — inside the small-player boost window
      brewingInvaders: [makeEntry({ smallID: 2, troops: 90_000 })],
    });
    runtime.plan.phase = GAME_PHASES.EXPANSION;
    expect(planBias("TERRA_NULLIUS_RUSH")).toBe(0);
  });

  it("timer crunch: rank 1 turtles, rank 2 goes all-in", () => {
    const runtime = loadUserscript();
    const { planBias, GAME_PHASES } = runtime.test.internals;
    installWorld(runtime, {});
    runtime.plan.phase = GAME_PHASES.ASCENSION;
    runtime.plan.timerTicksLeft = 600; // 1 minute left
    runtime.plan.rank = 1;
    expect(planBias("DEFENSIVE_TURTLE")).toBeGreaterThanOrEqual(8);
    runtime.plan.rank = 2;
    expect(planBias("CAMPAIGN_CONQUEST")).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Opponent intel: grudges
// ---------------------------------------------------------------------------

describe("opponent intel — grudge memory", () => {
  it("records distinct incoming attacks and scores the aggressor", () => {
    const runtime = loadUserscript();
    const { updateOpponentIntel, grudgeScoreFor } = runtime.test.internals;
    installWorld(runtime, {
      myIncomingAttacks: [
        { id: "atk-1", attackerID: 2, troops: 10_000 },
        { id: "atk-2", attackerID: 2, troops: 15_000 },
        { id: "atk-3", attackerID: 3, troops: 2_000 },
      ],
    });
    updateOpponentIntel(runtime.world.me.player);
    const grudge2 = runtime.intel.grudges.get(2);
    expect(grudge2.attacks).toBe(2);
    expect(grudge2.troops).toBe(25_000);
    expect(grudgeScoreFor(2)).toBeGreaterThan(grudgeScoreFor(3));

    // Same attack ids seen again → no double counting.
    updateOpponentIntel(runtime.world.me.player);
    expect(runtime.intel.grudges.get(2).attacks).toBe(2);
  });

  it("decays grudges over time", () => {
    const runtime = loadUserscript();
    const { updateOpponentIntel, grudgeScoreFor } = runtime.test.internals;
    installWorld(runtime, {
      tick: 1_000,
      myIncomingAttacks: [{ id: "atk-9", attackerID: 2, troops: 30_000 }],
    });
    updateOpponentIntel(runtime.world.me.player);
    const fresh = grudgeScoreFor(2);
    runtime.world.tick = 25_000; // ~40 minutes later
    const stale = grudgeScoreFor(2);
    expect(fresh).toBeGreaterThan(0);
    expect(stale).toBeLessThan(fresh * 0.1);
  });
});

// ---------------------------------------------------------------------------
// Snowball risk detection
// ---------------------------------------------------------------------------

describe("computeSnowballRisks — trajectory-based invader prediction", () => {
  it("flags a neighbour whose growth will badly overtake us", () => {
    const runtime = loadUserscript();
    const { computeSnowballRisks } = runtime.test.internals;
    installWorld(runtime, { myTroops: 50_000, myTroopsPerMin: 2_000 });
    const snowballer = makeEntry({
      smallID: 2,
      troops: 55_000, // 1.1× now
      troopsPerMin: 40_000, // will be ~2.5× in 2 minutes
      isAdjacent: true,
    });
    const risks = computeSnowballRisks(runtime.world.me, [snowballer]);
    expect(risks.length).toBe(1);
    expect(snowballer.tags.has("SNOWBALL_RISK")).toBe(true);
  });

  it("ignores neighbours growing slower than us or already weak", () => {
    const runtime = loadUserscript();
    const { computeSnowballRisks } = runtime.test.internals;
    installWorld(runtime, { myTroops: 50_000, myTroopsPerMin: 5_000 });
    const slowpoke = makeEntry({
      smallID: 2,
      troops: 60_000,
      troopsPerMin: 1_000, // slower than us
      isAdjacent: true,
    });
    const midget = makeEntry({
      smallID: 3,
      troops: 10_000, // 0.2× — far below the 0.8 ratio floor
      troopsPerMin: 20_000,
      isAdjacent: true,
    });
    expect(computeSnowballRisks(runtime.world.me, [slowpoke, midget]).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Appeasement targeting
// ---------------------------------------------------------------------------

describe("pickAppeasementTarget — ally the giants we can't fight", () => {
  it("picks the strongest overmatching neighbour", () => {
    const runtime = loadUserscript();
    const { pickAppeasementTarget, PlayerType } = runtime.test.internals;
    const giant = makeEntry({
      smallID: 2,
      name: "Giant",
      type: PlayerType.Nation,
      troops: 120_000, // 2.4× us
      isAdjacent: true,
    });
    const medium = makeEntry({
      smallID: 3,
      type: PlayerType.Nation,
      troops: 80_000,
      isAdjacent: true,
    });
    installWorld(runtime, {
      myTroops: 50_000,
      adjacentEnemies: [giant, medium],
    });
    const target = pickAppeasementTarget(runtime.world.me);
    expect(target).not.toBeNull();
    expect(target.smallID).toBe(2);
  });

  it("never appeases active invaders or repeat aggressors", () => {
    const runtime = loadUserscript();
    const { pickAppeasementTarget, updateOpponentIntel, PlayerType } =
      runtime.test.internals;
    const invader = makeEntry({
      smallID: 2,
      type: PlayerType.Nation,
      troops: 120_000,
      isAdjacent: true,
    });
    invader.tags.add("INVADING_US");
    const bully = makeEntry({
      smallID: 3,
      type: PlayerType.Nation,
      troops: 110_000,
      isAdjacent: true,
    });
    installWorld(runtime, {
      myTroops: 50_000,
      adjacentEnemies: [invader, bully],
      myIncomingAttacks: [
        { id: "b1", attackerID: 3, troops: 30_000 },
        { id: "b2", attackerID: 3, troops: 30_000 },
        { id: "b3", attackerID: 3, troops: 30_000 },
        { id: "b4", attackerID: 3, troops: 30_000 },
      ],
    });
    updateOpponentIntel(runtime.world.me.player);
    expect(pickAppeasementTarget(runtime.world.me)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CAMPAIGN_CONQUEST goal integration
// ---------------------------------------------------------------------------

describe("CAMPAIGN_CONQUEST goal — never idle with a campaign on the books", () => {
  it("wins the planner race when no reactive goal fires", () => {
    const runtime = loadUserscript();
    const { selectPrimaryGoal, GAME_PHASES, PlayerType } =
      runtime.test.internals;
    const target = makeEntry({
      smallID: 2,
      name: "Victim",
      type: PlayerType.Nation,
      troops: 20_000,
      tiles: 4_000,
      isAdjacent: true,
    });
    installWorld(runtime, {
      myTroops: 50_000,
      myTiles: 30_000,
      others: [
        target,
        makeEntry({ smallID: 3, tiles: 40_000, troops: 90_000 }),
        makeEntry({ smallID: 4, tiles: 25_000, troops: 60_000 }),
      ],
      usableLand: 100_000, // ~1% unowned → no TERRA_NULLIUS_RUSH
    });
    runtime.planner.activeGoalId = null;
    runtime.plan.phase = GAME_PHASES.ASCENSION;
    runtime.plan.campaign = {
      smallID: 2,
      name: "Victim",
      sinceTick: 2_900,
      reason: "test",
      lastProgressTick: 2_900,
      lastTargetTiles: 4_000,
    };
    // Neutralize gates that need a live gameView.
    runtime.hooks.gameView = {
      ticks: () => 3_000,
      myPlayer: () => null,
      config: () => ({
        boatMaxNumber: () => 3,
        isUnitDisabled: () => true,
      }),
      playerViews: () => [],
    };
    const selection = selectPrimaryGoal();
    expect(selection).not.toBeNull();
    expect(selection.spec.id).toBe("CAMPAIGN_CONQUEST");
  });
});

// ---------------------------------------------------------------------------
// Defense floor (v3.1 Overlord merge)
// ---------------------------------------------------------------------------

describe("defense floor — never weak next to a neighbour", () => {
  it("floors at the strongest adjacent hostile's committable troops", () => {
    const runtime = loadUserscript();
    const { computeDefenseFloor, enemyCommittableTroops } =
      runtime.test.internals;
    // Hostile-acting neighbour: full weight. troops 100k, cap 120k →
    // committable = 100k − 0.35×120k = 58k.
    const invader = makeEntry({
      smallID: 2,
      name: "Invader",
      troops: 100_000,
      maxTroops: 120_000,
      isAdjacent: true,
    });
    invader.tags.add("INVADING_US");
    const midget = makeEntry({
      smallID: 3,
      troops: 20_000,
      maxTroops: 40_000,
      isAdjacent: true,
    });
    installWorld(runtime, {
      myTroops: 80_000,
      adjacentEnemies: [invader, midget],
    });
    expect(enemyCommittableTroops(invader)).toBe(58_000);
    const info = computeDefenseFloor();
    expect(info.floor).toBe(58_000);
    expect(info.danger.smallID).toBe(2);
    // Excluding the attack target removes them from the floor.
    const excluded = computeDefenseFloor(2);
    expect(excluded.floor).toBeLessThan(10_000);
  });

  it("discounts peaceful giants but not hostile-acting ones", () => {
    const runtime = loadUserscript();
    const { computeDefenseFloor } = runtime.test.internals;
    const peacefulGiant = makeEntry({
      smallID: 2,
      troops: 200_000,
      maxTroops: 250_000,
      isAdjacent: true,
    });
    installWorld(runtime, {
      myTroops: 80_000,
      adjacentEnemies: [peacefulGiant],
    });
    const peaceful = computeDefenseFloor().floor;
    peacefulGiant.tags.add("SNOWBALL_RISK");
    const hostile = computeDefenseFloor().floor;
    expect(hostile).toBeGreaterThan(peaceful);
    expect(peaceful).toBeCloseTo(hostile * 0.55, 0);
  });

  it("capCommitByDefenseFloor keeps the post-commit garrison at the floor", () => {
    const runtime = loadUserscript();
    const { capCommitByDefenseFloor } = runtime.test.internals;
    const threat = makeEntry({
      smallID: 2,
      troops: 100_000,
      maxTroops: 120_000,
      isAdjacent: true,
    });
    threat.tags.add("INVADING_US"); // full weight → floor 58k
    installWorld(runtime, { myTroops: 80_000, adjacentEnemies: [threat] });
    const me = { troops: () => 80_000 };

    // Wants 60k, but the PvP floor (0.7 × 58k = 40.6k) caps the commit at
    // 80k − 40.6k = 39.4k so the garrison holds.
    expect(capCommitByDefenseFloor(me, 60_000, {})).toBe(39_400);
    // Small commits pass through untouched.
    expect(capCommitByDefenseFloor(me, 10_000, {})).toBe(10_000);
    // Retaliation fights at half floor: 80k − 20.3k = 59.7k.
    expect(capCommitByDefenseFloor(me, 60_000, { retaliating: true })).toBe(
      59_700,
    );
    // A capped PvP commit below the viability point is dropped entirely.
    expect(
      capCommitByDefenseFloor(me, 60_000, { minViableCommit: 45_000 }),
    ).toBe(0);
    // Attacking the threat itself excludes them from the floor.
    expect(capCommitByDefenseFloor(me, 60_000, { targetSmallID: 2 })).toBe(
      60_000,
    );
  });

  it("calculateAttackTroops expansion commits are capped by the floor", () => {
    const runtime = loadUserscript();
    const { calculateAttackTroops } = runtime.test.internals;
    const threat = makeEntry({
      smallID: 2,
      troops: 100_000,
      maxTroops: 120_000,
      isAdjacent: true,
    });
    threat.tags.add("INVADING_US"); // floor 58k
    installWorld(runtime, { myTroops: 80_000, adjacentEnemies: [threat] });
    const me = { troops: () => 80_000, incomingAttacks: () => [] };

    // TN expansion: reserve 0.1×100k leaves 70k available, but the
    // expansion floor (0.5 × 58k = 29k) caps the commit at 80k − 29k =
    // 51k so the garrison holds.
    const tn = calculateAttackTroops(me, null, 0.1, 100_000, {
      retaliating: false,
    });
    expect(tn).toBe(51_000);
  });
});

// ---------------------------------------------------------------------------
// Spawn upgrades
// ---------------------------------------------------------------------------

function makeSpawnGameView(opts: {
  width?: number;
  height?: number;
  terrainType?: (tile: number) => number;
  players?: any[];
}) {
  const width = opts.width ?? 220;
  const height = opts.height ?? 140;
  const players = opts.players ?? [];
  const terrainOf = opts.terrainType ?? (() => TerrainType.Plains);
  const ref = (x: number, y: number) => y * width + x;
  const xOf = (tile: number) => tile % width;
  const yOf = (tile: number) => Math.floor(tile / width);
  return {
    width: () => width,
    height: () => height,
    ref,
    x: xOf,
    y: yOf,
    isValidCoord: (x: number, y: number) =>
      x >= 0 && y >= 0 && x < width && y < height,
    isLand: () => true,
    isWater: () => false,
    isBorder: () => false,
    hasOwner: () => false,
    ownerID: () => 0,
    hasFallout: () => false,
    isOceanShore: () => false,
    magnitude: () => 4,
    terrainType: (tile: number) => terrainOf(tile),
    manhattanDist: (a: number, b: number) =>
      Math.abs(xOf(a) - xOf(b)) + Math.abs(yOf(a) - yOf(b)),
    neighbors: (tile: number) => {
      const x = xOf(tile);
      const y = yOf(tile);
      const out: number[] = [];
      if (x > 0) out.push(ref(x - 1, y));
      if (x + 1 < width) out.push(ref(x + 1, y));
      if (y > 0) out.push(ref(x, y - 1));
      if (y + 1 < height) out.push(ref(x, y + 1));
      return out;
    },
    circleSearch: (center: number, radius: number) => {
      const out: number[] = [];
      const cx = xOf(center);
      const cy = yOf(center);
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (dx * dx + dy * dy > radius * radius) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && y >= 0 && x < width && y < height) {
            out.push(ref(x, y));
          }
        }
      }
      return out;
    },
    playerViews: () => players,
    config: () => ({
      minDistanceBetweenPlayers: () => 20,
      numSpawnPhaseTurns: () => 300,
    }),
  };
}

function playerStub(type: any, smallID: number, tile: number) {
  return {
    smallID: () => smallID,
    type: () => type,
    spawnTile: () => tile,
    hasSpawned: () => true,
  };
}

function installSpawnView(runtime: any, gameView: any) {
  runtime.hooks.gameView = {
    ...gameView,
    ticks: () => 0,
    myPlayer: () => null,
  };
  runtime.world.meSmallID = 1;
  runtime.state.spawn.lastSubScores = null;
  runtime.state.spawn.gate = null;
  runtime.state.spawn.grid = null;
  runtime.tickCache = null;
}

describe("spawn v2.15 — stratified probing, adaptive gate, crowding", () => {
  it("stratified probes cover most of the map's grid cells", () => {
    const runtime = loadUserscript();
    const { nextSpawnProbeCoord } = runtime.test.internals;
    const gameView = makeSpawnGameView({ width: 480, height: 480 });
    installSpawnView(runtime, gameView);

    const seenCells = new Set<string>();
    const cells = 24;
    for (let i = 0; i < cells * cells; i++) {
      const { x, y } = nextSpawnProbeCoord(gameView);
      seenCells.add(
        Math.floor(x / (480 / cells)) + ":" + Math.floor(y / (480 / cells)),
      );
    }
    // A full sweep touches (nearly) every distinct cell; pure random
    // sampling would only cover ~63% in expectation.
    expect(seenCells.size).toBeGreaterThan(cells * cells * 0.85);
  });

  it("relaxes the plains gate on a plains-poor map after enough rejections", () => {
    const runtime = loadUserscript();
    const { computeSpawnCenterScore } = runtime.test.internals;
    // Everything is Highland: the strict gate rejects every candidate.
    const gameView = makeSpawnGameView({
      terrainType: () => TerrainType.Highland,
    });
    installSpawnView(runtime, gameView);

    const center = gameView.ref(110, 70);
    let firstAccepted: number | null = null;
    for (let i = 0; i < 400; i++) {
      const score = computeSpawnCenterScore(gameView, center);
      if (score !== null && firstAccepted === null) firstAccepted = i;
    }
    expect(runtime.state.spawn.gate.relaxed).toBe(true);
    // After relaxation, highland-only patches DO score (not null).
    expect(firstAccepted).not.toBeNull();
    // But a strictly plains map still scores higher than highland.
    const plainsView = makeSpawnGameView({});
    installSpawnView(runtime, plainsView);
    const plainsScore = computeSpawnCenterScore(
      plainsView,
      plainsView.ref(110, 70),
    );
    installSpawnView(runtime, gameView);
    runtime.state.spawn.gate = { checks: 400, rejects: 400, relaxed: true };
    const highlandScore = computeSpawnCenterScore(gameView, center);
    expect(plainsScore).toBeGreaterThan(highlandScore!);
  });

  it("penalises spawn centers crowded by multiple future war fronts", () => {
    const runtime = loadUserscript();
    const { computeSpawnCenterScore, PlayerType } = runtime.test.internals;
    // One human at distance ~100 (both scenarios), plus two more humans
    // within 150 tiles in the crowded scenario.
    const base = 60 * 220 + 40;
    const lonelyView = makeSpawnGameView({
      players: [playerStub(PlayerType.Human, 2, base + 100)],
    });
    const crowdedView = makeSpawnGameView({
      players: [
        playerStub(PlayerType.Human, 2, base + 100),
        playerStub(PlayerType.Human, 3, base + 110),
        playerStub(PlayerType.Human, 4, base - 25 * 220),
      ],
    });
    const center = lonelyView.ref(40, 60);

    installSpawnView(runtime, lonelyView);
    const lonely = computeSpawnCenterScore(lonelyView, center);
    const lonelySubs = { ...runtime.state.spawn.lastSubScores };
    installSpawnView(runtime, crowdedView);
    const crowded = computeSpawnCenterScore(crowdedView, center);
    const crowdedSubs = { ...runtime.state.spawn.lastSubScores };

    expect(lonelySubs.crowding).toBe(0);
    expect(crowdedSubs.crowding).toBeLessThan(0);
    expect(crowded).toBeLessThan(lonely!);
  });

  it("refineSpawnCandidate hill-climbs to a better neighbouring center", () => {
    const runtime = loadUserscript();
    const { refineSpawnCandidate, computeSpawnCenterScore } =
      runtime.test.internals;
    // Mountains on the left half, plains on the right: a candidate at the
    // boundary should hill-climb rightward (toward more plains).
    const width = 220;
    const gameView = makeSpawnGameView({
      terrainType: (tile: number) =>
        tile % width < 100 ? TerrainType.Mountain : TerrainType.Plains,
    });
    installSpawnView(runtime, gameView);
    // Force-relax the gate so the boundary candidate scores at all.
    runtime.state.spawn.gate = { checks: 400, rejects: 400, relaxed: true };

    const boundary = gameView.ref(104, 70);
    const boundaryScore = computeSpawnCenterScore(gameView, boundary);
    expect(boundaryScore).not.toBeNull();
    const refined = refineSpawnCandidate(gameView, {
      center: boundary,
      score: boundaryScore,
      subScores: null,
    });
    expect(refined.score).toBeGreaterThan(boundaryScore!);
    expect(gameView.x(refined.center)).toBeGreaterThan(104);
  });
});
