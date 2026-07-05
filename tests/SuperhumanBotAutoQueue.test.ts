/**
 * Regression tests for the v2.16 auto-queue session module:
 *   - Persistent W/L record: increments once per match, survives via
 *     localStorage, and can be manually reset.
 *   - Match result detection: engine Win updates (player / team / nation
 *     winners), our own elimination, and the win-modal browser fallback.
 *   - Auto-requeue: leave scheduling on result, and homepage lobby
 *     auto-join via the client's own `join-lobby` CustomEvent, picking the
 *     first available public lobby (ffa > team > special).
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
  new Function(source).call(win);
  cachedRuntime = win.__superhumanBotRuntime;
  return cachedRuntime;
}

function resetSession(runtime: any) {
  runtime.session.autoQueue = false;
  runtime.session.record = { wins: 0, losses: 0, sinceMs: Date.now() };
  runtime.session.resultRecorded = false;
  runtime.session.lastResult = null;
  runtime.session.leaveAtMs = 0;
  runtime.session.leaving = false;
  runtime.session.homeJoin = {
    lastAttemptMs: 0,
    joinedGameID: null,
    joinedAtMs: 0,
    attempts: 0,
  };
  runtime.state.gameStarted = true;
  runtime.identity.clientID = "my-client";
  runtime.hooks.gameView = null;
  runtime.tickCache = null;
}

function stubGameViewWithWin(winner: any) {
  const updates: any = {};
  updates[12] = winner === null ? [] : [{ winner }];
  return {
    ticks: () => 5000,
    myPlayer: () => null,
    inSpawnPhase: () => false,
    updatesSinceLastTick: () => updates,
  };
}

beforeEach(() => {
  const runtime = loadUserscript();
  resetSession(runtime);
  try {
    (globalThis as any).window.localStorage.clear();
  } catch {
    /* jsdom always has localStorage; ignore */
  }
});

describe("W/L record — persistent tally with manual reset", () => {
  it("counts a win and a loss exactly once per match", () => {
    const runtime = loadUserscript();
    const { recordMatchResult } = runtime.test.internals;

    expect(recordMatchResult("win", "test")).toBe(true);
    // Double-record within the same match is ignored.
    expect(recordMatchResult("loss", "test")).toBe(false);
    expect(runtime.session.record).toMatchObject({ wins: 1, losses: 0 });

    // New match (start message resets the guard) → loss counts.
    runtime.session.resultRecorded = false;
    expect(recordMatchResult("loss", "test")).toBe(true);
    expect(runtime.session.record).toMatchObject({ wins: 1, losses: 1 });
    expect(runtime.session.lastResult).toBe("loss");
  });

  it("persists the record to localStorage and reloads it", () => {
    const runtime = loadUserscript();
    const { recordMatchResult, loadSessionSettings, WL_STORAGE_KEY } =
      runtime.test.internals;

    recordMatchResult("win", "test");
    const raw = (globalThis as any).window.localStorage.getItem(
      WL_STORAGE_KEY,
    );
    expect(JSON.parse(raw)).toMatchObject({ wins: 1, losses: 0 });

    // Simulate a fresh page load: zero the in-memory record and reload.
    runtime.session.record = { wins: 0, losses: 0, sinceMs: 0 };
    loadSessionSettings();
    expect(runtime.session.record).toMatchObject({ wins: 1, losses: 0 });
  });

  it("resetWinLossRecord zeroes the tally and persists the reset", () => {
    const runtime = loadUserscript();
    const { recordMatchResult, resetWinLossRecord, WL_STORAGE_KEY } =
      runtime.test.internals;

    recordMatchResult("win", "test");
    resetWinLossRecord();
    expect(runtime.session.record).toMatchObject({ wins: 0, losses: 0 });
    const raw = (globalThis as any).window.localStorage.getItem(
      WL_STORAGE_KEY,
    );
    expect(JSON.parse(raw)).toMatchObject({ wins: 0, losses: 0 });
  });

  it("setAutoQueue persists the toggle across reloads", () => {
    const runtime = loadUserscript();
    const { setAutoQueue, loadSessionSettings } = runtime.test.internals;

    setAutoQueue(true);
    runtime.session.autoQueue = false;
    loadSessionSettings();
    expect(runtime.session.autoQueue).toBe(true);
    setAutoQueue(false);
    loadSessionSettings();
    expect(runtime.session.autoQueue).toBe(false);
  });
});

describe("match result detection", () => {
  it("records a WIN when the engine's Win update names our clientID", () => {
    const runtime = loadUserscript();
    const { maybeDetectMatchResult } = runtime.test.internals;
    runtime.hooks.gameView = stubGameViewWithWin(["player", "my-client"]);

    maybeDetectMatchResult();
    expect(runtime.session.lastResult).toBe("win");
    expect(runtime.session.record.wins).toBe(1);
  });

  it("records a LOSS when another player wins", () => {
    const runtime = loadUserscript();
    const { maybeDetectMatchResult } = runtime.test.internals;
    runtime.hooks.gameView = stubGameViewWithWin(["player", "someone-else"]);

    maybeDetectMatchResult();
    expect(runtime.session.lastResult).toBe("loss");
    expect(runtime.session.record.losses).toBe(1);
  });

  it("records a LOSS when a nation wins", () => {
    const runtime = loadUserscript();
    const { maybeDetectMatchResult } = runtime.test.internals;
    runtime.hooks.gameView = stubGameViewWithWin(["nation", "France"]);

    maybeDetectMatchResult();
    expect(runtime.session.lastResult).toBe("loss");
  });

  it("records a LOSS immediately when we are eliminated", () => {
    const runtime = loadUserscript();
    const { maybeDetectMatchResult } = runtime.test.internals;
    runtime.hooks.gameView = {
      ticks: () => 5000,
      inSpawnPhase: () => false,
      updatesSinceLastTick: () => null,
      myPlayer: () => ({
        hasSpawned: () => true,
        isAlive: () => false,
      }),
    };

    maybeDetectMatchResult();
    expect(runtime.session.lastResult).toBe("loss");
  });

  it("does nothing before the match starts or after a result is in", () => {
    const runtime = loadUserscript();
    const { maybeDetectMatchResult } = runtime.test.internals;
    runtime.hooks.gameView = stubGameViewWithWin(["player", "my-client"]);

    runtime.state.gameStarted = false;
    maybeDetectMatchResult();
    expect(runtime.session.record.wins).toBe(0);

    runtime.state.gameStarted = true;
    maybeDetectMatchResult();
    maybeDetectMatchResult(); // second call must not double count
    expect(runtime.session.record.wins).toBe(1);
  });

  it("falls back to the game's win-modal when engine updates are gone", () => {
    const runtime = loadUserscript();
    const { maybeDetectMatchResult } = runtime.test.internals;
    runtime.hooks.gameView = null;

    const modal: any = document.createElement("win-modal");
    modal.isVisible = true;
    modal.isWin = true;
    document.body.appendChild(modal);
    try {
      maybeDetectMatchResult();
      expect(runtime.session.lastResult).toBe("win");
    } finally {
      modal.remove();
    }
  });
});

describe("auto-requeue — leave and join the next public game", () => {
  it("schedules a delayed leave only when auto-queue is enabled", () => {
    const runtime = loadUserscript();
    const { recordMatchResult } = runtime.test.internals;

    recordMatchResult("loss", "test");
    expect(runtime.session.leaveAtMs).toBe(0); // autoQueue off

    resetSession(runtime);
    runtime.session.autoQueue = true;
    recordMatchResult("loss", "test");
    expect(runtime.session.leaveAtMs).toBeGreaterThan(Date.now());
  });

  it("pickFirstPublicLobby prefers ffa, then team, then special", () => {
    const runtime = loadUserscript();
    const { pickFirstPublicLobby } = runtime.test.internals;

    const selector = {
      lobbies: {
        serverTime: 0,
        games: {
          ffa: [{ gameID: "ffa-1" }, { gameID: "ffa-2" }],
          team: [{ gameID: "team-1" }],
          special: [{ gameID: "special-1" }],
        },
      },
    };
    expect(pickFirstPublicLobby(selector).gameID).toBe("ffa-1");

    selector.lobbies.games.ffa = [];
    expect(pickFirstPublicLobby(selector).gameID).toBe("team-1");

    selector.lobbies.games.team = [];
    expect(pickFirstPublicLobby(selector).gameID).toBe("special-1");

    selector.lobbies.games.special = [];
    expect(pickFirstPublicLobby(selector)).toBeNull();
  });

  it("dispatches the client's join-lobby event for the first lobby", () => {
    const runtime = loadUserscript();
    const { maybeAutoJoinNextGame } = runtime.test.internals;

    runtime.session.autoQueue = true;
    runtime.state.gameStarted = false;
    runtime.hooks.gameView = null;

    const selector: any = document.createElement("game-mode-selector");
    selector.lobbies = {
      serverTime: 0,
      games: { ffa: [{ gameID: "g-123", numClients: 10 }] },
    };
    document.body.appendChild(selector);

    const seen: any[] = [];
    const listener = (event: any) => seen.push(event.detail);
    document.addEventListener("join-lobby", listener);
    try {
      const joined = maybeAutoJoinNextGame();
      expect(joined).toBe(true);
      expect(seen.length).toBe(1);
      expect(seen[0]).toMatchObject({ gameID: "g-123", source: "public" });
      expect(runtime.session.homeJoin.joinedGameID).toBe("g-123");

      // While waiting for that lobby to start, no re-join happens.
      expect(maybeAutoJoinNextGame()).toBe(false);
      expect(seen.length).toBe(1);
    } finally {
      document.removeEventListener("join-lobby", listener);
      selector.remove();
    }
  });

  it("stays idle when auto-queue is off or a match is running", () => {
    const runtime = loadUserscript();
    const { maybeAutoJoinNextGame } = runtime.test.internals;

    const selector: any = document.createElement("game-mode-selector");
    selector.lobbies = {
      serverTime: 0,
      games: { ffa: [{ gameID: "g-456" }] },
    };
    document.body.appendChild(selector);
    try {
      runtime.session.autoQueue = false;
      runtime.state.gameStarted = false;
      expect(maybeAutoJoinNextGame()).toBe(false);

      runtime.session.autoQueue = true;
      runtime.state.gameStarted = true; // match in progress
      expect(maybeAutoJoinNextGame()).toBe(false);
    } finally {
      selector.remove();
    }
  });
});
