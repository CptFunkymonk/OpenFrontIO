/**
 * Regression tests for the superhuman userscript's diplomatic-seal module —
 * the fix for the classic FFA trap: "we allied every neighbouring player and
 * now we're locked in, unable to expand unless we betray".
 *
 * Three coordinated behaviours are covered:
 *   1. PREVENT — allianceWouldSealBorders blocks any convenience alliance
 *      that would close our LAST hostile land border once terra nullius is
 *      gone (checked in appeasement, incoming-accept, opening blast, and
 *      anti-crown recruitment).
 *   2. ESCAPE — when already sealed, maintainPlannedAllianceLapses lets the
 *      least valuable alliance EXPIRE naturally (no traitor debuff) by
 *      withholding the extension request.
 *   3. REROUTE — the planner boosts NAVAL_LAND_GRAB and stops selecting
 *      TERRA_NULLIUS_RUSH while the land frontier is physically closed.
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

function stubGameView(runtime: any, overrides: any = {}) {
  runtime.hooks.gameView = {
    ticks: () => 1500,
    myPlayer: () => ({
      isAlive: () => true,
      units: () => [],
      smallID: () => 1,
    }),
    config: () => ({
      maxTroops: () => 100_000,
      boatMaxNumber: () => 3,
      isUnitDisabled: () => false,
      numSpawnPhaseTurns: () => 100,
    }),
    ...overrides,
  };
}

function neighborEntry(smallID: number, overrides: any = {}) {
  return {
    smallID,
    name: `Player${smallID}`,
    id: `player-${smallID}`,
    type: "NATION",
    isMe: false,
    isAlly: true,
    isClanmate: false,
    isFriendly: true,
    isAdjacent: true,
    isTraitor: false,
    tiles: 800,
    troops: 20_000,
    troopRatio: 0.5,
    outgoingAttacks: [],
    player: { relation: () => 1, isTraitor: () => false },
    ...overrides,
  };
}

function installWorld(runtime: any, overrides: any = {}) {
  const me = {
    smallID: 1,
    name: "Me",
    id: "player-1",
    isMe: true,
    isAlly: false,
    isClanmate: false,
    isFriendly: true,
    isAdjacent: false,
    troops: 40_000,
    maxTroops: 100_000,
    troopRatio: 0.4,
    tiles: 1500,
    gold: 500_000,
    incomingTroops: 0,
    outgoingTroops: 0,
    incomingAttacks: [],
    outgoingAttacks: [],
    alliances: [],
    structures: {},
    structureLevels: {},
    ...(overrides.me ?? {}),
  };
  runtime.world = {
    ...runtime.world,
    tick: 1500,
    archetype: "CONTINENTAL",
    me,
    meSmallID: 1,
    everyone: [me, ...(overrides.others ?? [])],
    bySmallID: new Map(
      [me, ...(overrides.others ?? [])].map((e: any) => [e.smallID, e]),
    ),
    totals: {
      alivePlayers: 4,
      humanCount: 1,
      nationCount: 2,
      botCount: 1,
      totalLand: 10_000,
      usableLand: 10_000,
      crownShare: 0.18,
      myShare: 0.15,
      secondShare: 0.14,
    },
    allianceGraph: {
      edges: new Map(),
      cliques: [],
      largestBlocShare: 0,
      coalitionThreat: false,
    },
    threats: {
      crownSmallID: null,
      crown: null,
      risingStars: [],
      softTargets: [],
      collapsingTargets: [],
      mirvCapable: [],
      adjacentEnemies: [],
      narrowWaterNeighbors: [],
      activeInvaders: [],
      brewingInvaders: [],
      invasionTroopsInbound: 0,
      inboundTroopTotal: 0,
      overwhelmingNeighbor: null,
      earlyHumanOvermatch: null,
      landFrontierOpen: true,
      diplomaticallySealed: null,
      ...(overrides.threats ?? {}),
    },
  };
  return runtime.world;
}

describe("computeLandFrontierOpen", () => {
  // 1-D strip of 6 tiles: [water, mine, mine, X, ally, ally].
  // Tile X (index 3) flips between unowned land (frontier open) and
  // ally-owned (frontier closed).
  function makeStripGameView(runtime: any, ownerOfX: number) {
    stubGameView(runtime, {
      neighbors: (t: number) => [t - 1, t + 1].filter((n) => n >= 0 && n < 6),
      isLand: (t: number) => t !== 0,
      ownerID: (t: number) => {
        if (t === 1 || t === 2) return 1;
        if (t === 3) return ownerOfX;
        return 3; // ally-owned
      },
    });
  }

  it("returns true when an unowned land tile touches our border", () => {
    const runtime = loadUserscript();
    const { computeLandFrontierOpen } = runtime.test.internals;
    makeStripGameView(runtime, 0);
    expect(computeLandFrontierOpen([2])).toBe(true);
  });

  it("returns false when every border neighbour is owned or water", () => {
    const runtime = loadUserscript();
    const { computeLandFrontierOpen } = runtime.test.internals;
    makeStripGameView(runtime, 3);
    expect(computeLandFrontierOpen([1, 2])).toBe(false);
  });

  it("returns false for an empty border", () => {
    const runtime = loadUserscript();
    const { computeLandFrontierOpen } = runtime.test.internals;
    makeStripGameView(runtime, 0);
    expect(computeLandFrontierOpen([])).toBe(false);
  });
});

describe("computeDiplomaticSeal / allianceWouldSealBorders", () => {
  it("detects the seal only when ALL land neighbours are friendly and the frontier is closed", () => {
    const runtime = loadUserscript();
    const { computeDiplomaticSeal } = runtime.test.internals;
    stubGameView(runtime);

    const allies = [neighborEntry(2), neighborEntry(3)];
    const world = installWorld(runtime, { others: allies });

    // Sealed: all adjacent friendly, frontier closed.
    const sealed = computeDiplomaticSeal(world.me, false);
    expect(sealed).not.toBeNull();
    expect(sealed.alliedNeighborCount).toBe(2);

    // Frontier open -> never sealed.
    expect(computeDiplomaticSeal(world.me, true)).toBeNull();

    // One hostile neighbour left -> not sealed.
    allies[1].isFriendly = false;
    allies[1].isAlly = false;
    expect(computeDiplomaticSeal(world.me, false)).toBeNull();
  });

  it("flags the alliance that would close our last hostile land border", () => {
    const runtime = loadUserscript();
    const { allianceWouldSealBorders } = runtime.test.internals;
    stubGameView(runtime);

    const ally = neighborEntry(2);
    const lastOutlet = neighborEntry(3, { isAlly: false, isFriendly: false });
    installWorld(runtime, {
      others: [ally, lastOutlet],
      threats: { adjacentEnemies: [lastOutlet], landFrontierOpen: false },
    });

    expect(allianceWouldSealBorders(lastOutlet)).toBe(true);

    // A second hostile border remains -> allying one of them is fine.
    const secondOutlet = neighborEntry(4, { isAlly: false, isFriendly: false });
    runtime.world.threats.adjacentEnemies = [lastOutlet, secondOutlet];
    expect(allianceWouldSealBorders(lastOutlet)).toBe(false);

    // Frontier open -> alliances can't lock us in.
    runtime.world.threats.adjacentEnemies = [lastOutlet];
    runtime.world.threats.landFrontierOpen = true;
    expect(allianceWouldSealBorders(lastOutlet)).toBe(false);

    // Non-adjacent partners never seal a land border.
    runtime.world.threats.landFrontierOpen = false;
    const overseas = neighborEntry(5, {
      isAlly: false,
      isFriendly: false,
      isAdjacent: false,
    });
    expect(allianceWouldSealBorders(overseas)).toBe(false);
  });
});

describe("alliance-forming gates respect the seal", () => {
  it("shouldAcceptIncomingAlliance refuses a request that would seal us, unless appeasement-grade", () => {
    const runtime = loadUserscript();
    const { shouldAcceptIncomingAlliance, APPEASE_TROOP_RATIO } =
      runtime.test.internals;
    stubGameView(runtime);

    const requestor = neighborEntry(7, {
      type: "HUMAN",
      isAlly: false,
      isFriendly: false,
      troops: 30_000, // comparable strength — would normally be accepted
      strength: 45_000,
    });
    const world = installWorld(runtime, {
      others: [requestor],
      threats: { adjacentEnemies: [requestor], landFrontierOpen: false },
    });

    // They are our only hostile border and the frontier is closed: refuse.
    expect(shouldAcceptIncomingAlliance(requestor, world.me)).toBe(false);

    // Same request, but they out-troop us 1.4x — appeasement-grade, accept.
    requestor.troops = world.me.troops * APPEASE_TROOP_RATIO + 1;
    expect(shouldAcceptIncomingAlliance(requestor, world.me)).toBe(true);

    // Frontier open again: the original weak request is fine too.
    requestor.troops = 30_000;
    runtime.world.threats.landFrontierOpen = true;
    expect(shouldAcceptIncomingAlliance(requestor, world.me)).toBe(true);
  });

  it("pickAppeasementTarget skips the marginal early-nation case when it would seal us", () => {
    const runtime = loadUserscript();
    const { pickAppeasementTarget } = runtime.test.internals;
    stubGameView(runtime, { ticks: () => 500 }); // early window

    const nation = neighborEntry(8, {
      isAlly: false,
      isFriendly: false,
      troops: 44_000, // 1.1x our 40k — early-nation case, NOT >=1.4x
    });
    // Make PlayerType.Nation comparison work: internals expose the enum.
    nation.type = runtime.test.internals.PlayerType.Nation;
    const world = installWorld(runtime, {
      others: [nation],
      threats: { adjacentEnemies: [nation], landFrontierOpen: false },
    });

    // Sealing case: they're our last hostile border -> no appeasement.
    expect(pickAppeasementTarget(world.me)).toBeNull();

    // Frontier open: the early-nation appeasement is allowed again.
    runtime.world.threats.landFrontierOpen = true;
    const target = pickAppeasementTarget(world.me);
    expect(target).not.toBeNull();
    expect(target.smallID).toBe(8);

    // Genuine overmatch (>=1.4x) is allowed even when it seals us —
    // survival beats expansion.
    runtime.world.threats.landFrontierOpen = false;
    nation.troops = 60_000;
    const appease = pickAppeasementTarget(world.me);
    expect(appease).not.toBeNull();
    expect(appease.smallID).toBe(8);
  });
});

describe("planned alliance lapse (escape valve)", () => {
  it("schedules the weakest adjacent ally, skips its extension, and cancels when the border reopens", () => {
    const runtime = loadUserscript();
    const { maybeExtendAlliances } = runtime.test.internals;
    stubGameView(runtime);

    const weakest = neighborEntry(11, { name: "Weakest", troops: 9_000 });
    const stronger = neighborEntry(12, { name: "Stronger", troops: 25_000 });
    const world = installWorld(runtime, {
      me: {
        alliances: [
          // Both alliances are inside the extension window (tick=1500).
          { id: 901, other: "player-11", expiresAt: 1900 },
          { id: 902, other: "player-12", expiresAt: 1900 },
        ],
      },
      others: [weakest, stronger],
      threats: {
        adjacentEnemies: [],
        landFrontierOpen: false,
        diplomaticallySealed: {
          neighbors: [weakest, stronger],
          alliedNeighborCount: 2,
        },
      },
    });

    // Capture outgoing intents through the local bridge (harness mode).
    const sent: any[] = [];
    const win: any = (globalThis as any).window;
    const priorHarness = win.__SUPERBOT_TEST_MODE;
    const priorSocket = runtime.hooks.socket;
    const priorBridge = runtime.hooks.localBridge;
    const priorLastSig = runtime.state.lastIntentSignature;
    win.__SUPERBOT_TEST_MODE = true;
    runtime.hooks.socket = null;
    runtime.hooks.localBridge = { send: (msg: any) => sent.push(msg) };
    runtime.state.lastIntentSignature = "";
    runtime.intel.plannedLapses.clear();
    runtime.intel.extensionRequested.clear();

    try {
      const acted = maybeExtendAlliances(world.me);

      // The weakest ally's alliance is the release valve: no extension for
      // 901, but 902 (the ally we keep) is renewed as usual.
      expect(runtime.intel.plannedLapses.has(901)).toBe(true);
      expect(runtime.intel.plannedLapses.has(902)).toBe(false);
      expect(acted).toBe(true);
      const extensions = sent.filter(
        (m) => m?.intent?.type === "allianceExtension",
      );
      expect(extensions).toHaveLength(1);
      expect(extensions[0].intent.recipient).toBe("player-12");

      // Border reopens (e.g. a neighbour died) -> lapse is cancelled and
      // the alliance becomes renewable again.
      runtime.world.threats.diplomaticallySealed = null;
      runtime.intel.extensionRequested.clear();
      const actedAfterReopen = maybeExtendAlliances(world.me);
      expect(runtime.intel.plannedLapses.size).toBe(0);
      expect(actedAfterReopen).toBe(true);
      const renewed = sent.filter(
        (m) => m?.intent?.type === "allianceExtension",
      );
      expect(renewed.some((m) => m.intent.recipient === "player-11")).toBe(
        true,
      );
    } finally {
      win.__SUPERBOT_TEST_MODE = priorHarness;
      runtime.hooks.socket = priorSocket;
      runtime.hooks.localBridge = priorBridge;
      runtime.state.lastIntentSignature = priorLastSig;
      runtime.intel.plannedLapses.clear();
      runtime.intel.extensionRequested.clear();
    }
  });

  it("prunes the planned lapse once the alliance has expired", () => {
    const runtime = loadUserscript();
    const { maintainPlannedAllianceLapses } = runtime.test.internals;
    stubGameView(runtime);

    const world = installWorld(runtime, {
      me: { alliances: [] }, // alliance 901 no longer exists
      threats: { landFrontierOpen: false },
    });
    runtime.intel.plannedLapses.clear();
    runtime.intel.plannedLapses.set(901, {
      smallID: 11,
      name: "Weakest",
      plannedAt: 100,
    });
    try {
      maintainPlannedAllianceLapses(world.me);
      expect(runtime.intel.plannedLapses.has(901)).toBe(false);
    } finally {
      runtime.intel.plannedLapses.clear();
    }
  });

  it("never lapses an ally who could roll us after expiry", () => {
    const runtime = loadUserscript();
    const { chooseAllianceLapseCandidate, RELEASE_VALVE_MAX_TROOP_RATIO } =
      runtime.test.internals;
    stubGameView(runtime);

    const giant = neighborEntry(13, {
      name: "Giant",
      troops: 40_000 * RELEASE_VALVE_MAX_TROOP_RATIO + 1,
    });
    const world = installWorld(runtime, {
      others: [giant],
      threats: {
        landFrontierOpen: false,
        diplomaticallySealed: { neighbors: [giant], alliedNeighborCount: 1 },
      },
    });
    expect(chooseAllianceLapseCandidate(world.me)).toBeNull();
  });
});

describe("planner reroute under the seal (scripted suite)", () => {
  it("passes the built-in seal scenarios (NAVAL boost, frontier gate, lapse lifecycle)", () => {
    const runtime = loadUserscript();
    const summary = runtime.test.runSuite();
    const names = [
      "diplomatic seal: hostile border left",
      "diplomatic seal: all land neighbours allied",
      "seal guard: refuse alliance closing last border",
      "release valve: picks weakest adjacent ally",
      "sealed by allies + water target -> NAVAL_LAND_GRAB",
      "open frontier -> TERRA_NULLIUS_RUSH",
      "closed frontier -> not TERRA_NULLIUS_RUSH",
      "planned lapse: scheduled while sealed",
    ];
    for (const prefix of names) {
      const result = summary.results.find((r: any) =>
        r.name.startsWith(prefix),
      );
      expect(result, `scenario "${prefix}" should be in suite`).toBeDefined();
      expect(
        result.pass,
        `scenario "${prefix}": expected=${result.expected}, actual=${result.actual}`,
      ).toBe(true);
    }
  });
});
