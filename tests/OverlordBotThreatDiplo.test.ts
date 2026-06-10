/**
 * Phase 5 tests — Overlord threat engine (preemption) + diplomacy engine
 * (anti-overgrowth alliances/betrayal/coalition response).
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

let runtime: any;
let THREATS: any;
let DIPLO: any;
beforeAll(() => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const win: any = (globalThis as any).window;
  win.__OVERLORD_TEST_MODE = true;
  win.WebSocket = win.WebSocket ?? class {};
  new Function(source).call(win);
  runtime = win.__overlordBotRuntime;
  THREATS = runtime.threats;
  DIPLO = runtime.diplo;
});

const PlayerType = { Bot: "BOT", Human: "HUMAN", Nation: "NATION" };

function entry(o: any) {
  return {
    smallID: o.smallID,
    id: o.id ?? "p" + o.smallID,
    name: o.name ?? "P" + o.smallID,
    type: o.type ?? PlayerType.Human,
    isMe: !!o.isMe,
    isAlly: !!o.isAlly,
    isEnemy: o.isEnemy ?? (!o.isMe && !o.isAlly),
    tiles: o.tiles ?? 1000,
    troops: o.troops ?? 50000,
    gold: o.gold ?? 0,
    share: o.share ?? 0.1,
    tilesPerMin: o.tilesPerMin ?? 0,
    troopsPerMin: o.troopsPerMin ?? 0,
    isTraitor: !!o.isTraitor,
    isDisconnected: !!o.isDisconnected,
    incomingTroops: o.incomingTroops ?? 0,
    outgoingTroops: o.outgoingTroops ?? 0,
    allianceCount: o.allianceCount ?? 0,
    incomingAttacks: o.incomingAttacks ?? [],
    outgoingAttacks: o.outgoingAttacks ?? [],
  };
}

function makeWorld(opts: any) {
  const everyone: any[] = opts.everyone;
  const bySmallID = new Map();
  for (const e of everyone) bySmallID.set(e.smallID, e);
  const me = everyone.find((e) => e.isMe);
  // attach me extras
  const meFull = Object.assign(
    {
      maxTroops: opts.myMax ?? 200000,
      troopRatio: (me?.troops ?? 0) / (opts.myMax ?? 200000),
      cityLevelsSum: 0,
      structures: {},
      incomingAttacks: me?.incomingAttacks ?? [],
      incomingTroops: me?.incomingTroops ?? 0,
    },
    me,
  );
  bySmallID.set(meFull.smallID, meFull);
  const idx = everyone.indexOf(me);
  everyone[idx] = meFull;
  return {
    tick: opts.tick ?? 1500,
    gameConfig: { difficulty: opts.difficulty ?? "Impossible", isTeam: false },
    me: meFull,
    everyone,
    bySmallID,
    totals: {
      alivePlayers: everyone.length,
      humanCount: everyone.filter((e) => e.type === PlayerType.Human).length,
      nationCount: everyone.filter((e) => e.type === PlayerType.Nation).length,
      botCount: everyone.filter((e) => e.type === PlayerType.Bot).length,
      totalLand: opts.totalLand ?? 100000,
      myShare: meFull.share,
      crownShare: opts.crownShare ?? 0.3,
      secondShare: opts.secondShare ?? 0.1,
    },
    threats: { crown: opts.crown ?? null },
    allianceGraph: { edges: opts.edges ?? new Map() },
  };
}

describe("THREATS.compute", () => {
  it("detects active invaders and inbound troops", () => {
    const me = entry({
      smallID: 1,
      isMe: true,
      troops: 100000,
      incomingAttacks: [{ attackerID: 2, troops: 60000 }],
      incomingTroops: 60000,
    });
    const inv = entry({ smallID: 2, troops: 200000, tiles: 8000 });
    const world = makeWorld({ everyone: [me, inv], myMax: 200000 });
    const t = THREATS.compute(world, { adjacentEnemies: [inv] });
    expect(t.activeInvaders.map((e: any) => e.smallID)).toContain(2);
    expect(t.invasionTroopsInbound).toBe(60000);
  });

  it("flags a brewing invader before they attack", () => {
    const me = entry({ smallID: 1, isMe: true, troops: 90000, tiles: 1000 });
    // strong, capable, accumulating, not yet attacking
    const brew = entry({
      smallID: 3,
      troops: 110000,
      tiles: 6000,
      troopsPerMin: 500,
    });
    const world = makeWorld({ everyone: [me, brew], myMax: 130000 });
    const t = THREATS.compute(world, { adjacentEnemies: [brew] });
    expect(t.brewingInvaders.length).toBeGreaterThan(0);
    expect(t.brewingInvaders[0].smallID).toBe(3);
  });

  it("flags early human overmatch", () => {
    const me = entry({ smallID: 1, isMe: true, troops: 40000 });
    const big = entry({ smallID: 4, type: PlayerType.Human, troops: 80000 });
    const world = makeWorld({ everyone: [me, big], tick: 400, myMax: 100000 });
    const t = THREATS.compute(world, { adjacentEnemies: [big] });
    expect(t.earlyHumanOvermatch).toBeTruthy();
    expect(t.earlyHumanOvermatch.enemy.smallID).toBe(4);
    expect(t.earlyHumanOvermatch.ratio).toBeCloseTo(2, 5);
  });

  it("detects a coalition bloc against us", () => {
    const me = entry({ smallID: 1, isMe: true, troops: 100000, share: 0.1 });
    const a = entry({ smallID: 2, share: 0.12, troops: 120000 });
    const b = entry({ smallID: 3, share: 0.13, troops: 130000 });
    const edges = new Map([
      [2, new Set([3])],
      [3, new Set([2])],
    ]);
    const world = makeWorld({ everyone: [me, a, b], edges, myMax: 200000 });
    const t = THREATS.compute(world, { adjacentEnemies: [a, b] });
    expect(t.coalitionAgainstMe).toBe(true);
    expect(t.coalition.members.sort()).toEqual([2, 3]);
  });
});

describe("DIPLO alliance acceptance", () => {
  const me = entry({ smallID: 1, isMe: true, troops: 100000, tiles: 3000, share: 0.1 });

  it("rejects traitors", () => {
    const req = entry({ smallID: 2, troops: 90000, isTraitor: true });
    const world = makeWorld({ everyone: [me, req], myMax: 200000 });
    expect(DIPLO.shouldAcceptAlliance(world, world.bySmallID.get(2)).accept).toBe(
      false,
    );
  });

  it("rejects crown-feeders (allied to >25% of the field)", () => {
    const players = [me];
    for (let i = 2; i <= 9; i++) players.push(entry({ smallID: i }));
    const req = entry({ smallID: 2, troops: 90000, allianceCount: 4 });
    players[1] = req;
    const world = makeWorld({ everyone: players, myMax: 200000 });
    expect(
      DIPLO.shouldAcceptAlliance(world, world.bySmallID.get(2)).accept,
    ).toBe(false);
  });

  it("appeases a genuine threat by allying", () => {
    const req = entry({ smallID: 2, troops: 200000, tiles: 9000 });
    const world = makeWorld({ everyone: [me, req], myMax: 200000 });
    const d = DIPLO.shouldAcceptAlliance(world, world.bySmallID.get(2));
    expect(d.accept).toBe(true);
    expect(d.reason).toMatch(/appease/);
  });

  it("rejects a non-threat that would overgrow us (late game)", () => {
    const meLate = entry({ smallID: 1, isMe: true, troops: 200000, tiles: 5000, tilesPerMin: 0 });
    // peer (not a threat by troops/tiles/max), but exploding in tiles -> passes us
    const req = entry({ smallID: 2, troops: 150000, tiles: 5200, tilesPerMin: 5000 });
    const world = makeWorld({ everyone: [meLate, req], tick: 3000, myMax: 400000 });
    const d = DIPLO.shouldAcceptAlliance(world, world.bySmallID.get(2));
    expect(d.accept).toBe(false);
    expect(d.reason).toMatch(/overgrow/);
  });
});

describe("DIPLO betrayal (anti-overgrowth)", () => {
  it("betrays a weak/MIRV'd ally we can absorb", () => {
    const me = entry({ smallID: 1, isMe: true, troops: 100000, tiles: 5000, incomingTroops: 0 });
    const ally = entry({ smallID: 2, isAlly: true, troops: 2000, tiles: 1500 });
    const world = makeWorld({ everyone: [me, ally], myMax: 200000 });
    world.threats.adjacentEnemies = [];
    const d = DIPLO.shouldBetrayAlly(world, world.bySmallID.get(2), {});
    expect(d.betray).toBe(true);
  });

  it("betrays an ally projected to surpass us when safe", () => {
    const me = entry({ smallID: 1, isMe: true, troops: 100000, tiles: 5000, tilesPerMin: 0, incomingTroops: 0 });
    const ally = entry({ smallID: 2, isAlly: true, troops: 120000, tiles: 5200, tilesPerMin: 4000 });
    const world = makeWorld({ everyone: [me, ally], myMax: 200000 });
    world.threats.adjacentEnemies = [];
    const d = DIPLO.shouldBetrayAlly(world, world.bySmallID.get(2), {});
    expect(d.betray).toBe(true);
    expect(d.reason).toMatch(/overgrowth/);
  });

  it("does NOT betray when under heavy pressure (unsafe)", () => {
    const me = entry({ smallID: 1, isMe: true, troops: 100000, tiles: 5000, tilesPerMin: 0, incomingTroops: 60000 });
    const ally = entry({ smallID: 2, isAlly: true, troops: 120000, tiles: 5200, tilesPerMin: 4000 });
    const world = makeWorld({ everyone: [me, ally], myMax: 200000 });
    world.threats.adjacentEnemies = [];
    const d = DIPLO.shouldBetrayAlly(world, world.bySmallID.get(2), {});
    expect(d.betray).toBe(false);
  });
});

describe("DIPLO coalition response", () => {
  it("embargoes the bloc + crown and allies a non-bloc rival", () => {
    const me = entry({ smallID: 1, isMe: true, troops: 100000, share: 0.1 });
    const c1 = entry({ smallID: 2, share: 0.2, troops: 200000 });
    const c2 = entry({ smallID: 3, share: 0.15, troops: 150000 });
    const rival = entry({ smallID: 4, share: 0.12, troops: 130000 });
    const edges = new Map([
      [2, new Set([3])],
      [3, new Set([2])],
    ]);
    const world = makeWorld({
      everyone: [me, c1, c2, rival],
      edges,
      crown: undefined,
      myMax: 200000,
    });
    const t = THREATS.compute(world, { adjacentEnemies: [c1, c2, rival] });
    // crown is highest-tile (c1) — set by buildWorld normally; set here:
    world.threats.crown = world.bySmallID.get(2);
    const resp = DIPLO.coalitionResponse(world);
    expect(t.coalitionAgainstMe).toBe(true);
    expect(resp.embargoTargets).toContain("p2");
    expect(resp.embargoTargets).toContain("p3");
    expect(resp.allyTarget.smallID).toBe(4);
  });
});
