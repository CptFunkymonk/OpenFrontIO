/**
 * Regression tests for the superhuman bot's emoji communication module.
 *
 * These tests load the userscript the same way `SuperhumanBotPlanner.test.ts`
 * does (inside a sandboxed jsdom window) and then poke the exported emoji
 * internals to confirm:
 *   - Every emoji index 0..59 is covered by at least one rule OR by
 *     GOAL_EMOJI OR by a milestone / podium path.
 *   - `sendEmojiIntent` produces a valid ClientIntentMessage and wires
 *     through `sendRawMessage` exactly once per call.
 *   - `emitEmoji` honours the per-emoji cooldown but NOT the global
 *     cooldown (that's the caller's job).
 *   - `maybeEmitEmoji` fires at most once per tick and respects the
 *     global cooldown.
 *   - `emojiOnGoalSwitch` maps goal IDs to the expected emojis.
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

// Share a single userscript boot across the file so we don't re-init
// the overlay / WS hook (the IIFE guards against double-wrapping and
// would throw on a second boot inside the same jsdom window).
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

describe("superhuman bot emoji module", () => {
  let runtime: any;
  let internals: any;
  let sent: any[];

  beforeEach(() => {
    runtime = loadUserscript();
    internals = runtime.test.internals;
    sent = [];
    // Intercept sendRawMessage so we can assert what the bot tries to send
    // without needing a real transport. Monkey-patches the script's
    // runtime.hooks so the internal sendRawMessage picks our fake up.
    runtime.hooks.socket = null;
    runtime.hooks.localBridge = {
      send: (msg: any) => {
        sent.push(msg);
      },
    };
    // Ensure the emoji module is enabled and cooldowns are fresh.
    runtime.state.emoji.enabled = true;
    runtime.state.emoji.lastEmojiTick = -99999;
    runtime.state.emoji.perEmojiLastTick.clear();
    runtime.state.emoji.totalEmojisSent = 0;
  });

  it("exposes all 60 emojis in the FLATTENED_EMOJIS array", () => {
    expect(internals.FLATTENED_EMOJIS).toHaveLength(60);
    for (const e of internals.FLATTENED_EMOJIS) {
      expect(typeof e).toBe("string");
      expect(e.length).toBeGreaterThan(0);
    }
  });

  it("covers every emoji index with either a rule, goal-switch, or sticky milestone path", () => {
    const covered = new Set<number>();

    // Rules declare their emoji via `emoji: <index>` in the return object.
    // We scan the raw source rather than re-simulating every rule, so
    // static coverage is checked independently of whether a given world
    // state would actually satisfy the condition.
    const src = readFileSync(SCRIPT_PATH, "utf8");

    // Scan `emoji: NUMBER` literals within rule returns + podium helpers.
    for (const match of src.matchAll(/emoji:\s*(\d+)/g)) {
      covered.add(Number(match[1]));
    }
    // GOAL_EMOJI values.
    const goalBlock = /const GOAL_EMOJI\s*=\s*\{([^}]+)\}/.exec(src);
    if (goalBlock) {
      for (const m of goalBlock[1].matchAll(/:\s*(\d+)/g)) {
        covered.add(Number(m[1]));
      }
    }
    // OCTANT_EMOJI_INDEX values.
    const octBlock = /const OCTANT_EMOJI_INDEX\s*=\s*\{([^}]+)\}/.exec(src);
    if (octBlock) {
      for (const m of octBlock[1].matchAll(/:\s*(\d+)/g)) {
        covered.add(Number(m[1]));
      }
    }

    const missing: number[] = [];
    for (let i = 0; i < 60; i++) {
      if (!covered.has(i)) missing.push(i);
    }
    expect(missing).toEqual([]);
  });

  it("sendEmojiIntent emits a well-formed ClientIntentMessage", () => {
    internals.sendEmojiIntent("AllPlayers", 30);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "intent",
      intent: {
        type: "emoji",
        recipient: "AllPlayers",
        emoji: 30,
      },
    });
  });

  it("sendEmojiIntent rejects out-of-range indices without calling transport", () => {
    internals.sendEmojiIntent("AllPlayers", -1);
    internals.sendEmojiIntent("AllPlayers", 60);
    internals.sendEmojiIntent("AllPlayers", 1.5);
    internals.sendEmojiIntent("AllPlayers", "30");
    expect(sent).toHaveLength(0);
  });

  it("emitEmoji sends exactly once and bumps the counter", () => {
    // Pretend the game view has ticks.
    runtime.hooks.gameView = { ticks: () => 100 } as any;
    const ok = internals.emitEmoji(15, "AllPlayers", "hello");
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].intent.emoji).toBe(15);
    expect(runtime.state.emoji.totalEmojisSent).toBe(1);
  });

  it("emojiOnGoalSwitch uses the GOAL_EMOJI mapping", () => {
    runtime.hooks.gameView = { ticks: () => 100 } as any;
    internals.emojiOnGoalSwitch(null, "REPEL_INVASION");
    expect(sent[sent.length - 1]?.intent.emoji).toBe(
      internals.GOAL_EMOJI.REPEL_INVASION,
    );
    // Unknown goals are silently ignored.
    const priorCount = sent.length;
    internals.emojiOnGoalSwitch("REPEL_INVASION", "NOT_A_GOAL");
    expect(sent).toHaveLength(priorCount);
  });

  it("emojiOnGoalSwitch respects per-emoji cooldown", () => {
    runtime.hooks.gameView = { ticks: () => 100 } as any;
    internals.emojiOnGoalSwitch(null, "REPEL_INVASION");
    internals.emojiOnGoalSwitch(null, "REPEL_INVASION");
    // Second call within the 300-tick per-emoji cooldown is swallowed.
    expect(sent).toHaveLength(1);
  });

  it("maybeEmitEmoji refuses to fire before the global cooldown elapses", () => {
    runtime.hooks.gameView = { ticks: () => 100 } as any;
    // Seed a fake world so the rule evaluators don't early-exit.
    runtime.world = {
      tick: 100,
      me: {
        tiles: 500,
        troops: 10000,
        incomingTroops: 0,
        outgoingTroops: 0,
        outgoingAttacks: [],
        gold: 100000,
        structures: {},
        troopRatio: 0.5,
      },
      meSmallID: 1,
      everyone: [],
      bySmallID: new Map(),
      threats: {
        crown: null,
        adjacentEnemies: [],
        activeInvaders: [],
        brewingInvaders: [],
        mirvCapable: [],
      },
      totals: { myShare: 0.1, alivePlayers: 3 },
    };
    // Simulate a live player object the rules accept.
    const me = {
      isAlive: () => true,
      smallID: () => 1,
      id: () => "me",
      tiles: () => [],
      incomingAttacks: () => [],
      targets: () => [],
      isTraitor: () => false,
      getTraitorRemainingTicks: () => 0,
      units: () => [],
    } as any;
    // Prime a lastEmojiTick inside the cooldown window → maybeEmitEmoji
    // should refuse before scanning any rules.
    runtime.state.emoji.lastEmojiTick = 99;
    internals.maybeEmitEmoji(me);
    expect(sent).toHaveLength(0);
  });

  it("emoji stats surface through the debug namespace", () => {
    runtime.hooks.gameView = { ticks: () => 42 } as any;
    // The overlay refresh that fires after emitEmoji pokes runtime.world,
    // so stub the minimum shape it expects.
    runtime.world = {
      tick: 42,
      allianceGraph: { largestBlocShare: 0, coalitionThreat: false },
      totals: { myShare: 0, crownShare: 0, alivePlayers: 1 },
      threats: { crown: null, risingStars: [], nearestDanger: null },
      archetype: "unknown",
    };
    internals.emitEmoji(0, "AllPlayers", "hello");
    const debug = (globalThis as any).window.__superhumanBotDebug;
    expect(debug.emoji.totalSent).toBeGreaterThanOrEqual(1);
    expect(debug.emoji.stats.enabled).toBe(true);
    expect(debug.emoji.stats.perEmoji[0]).toBe(42);
  });

  it("can be disabled at runtime so no intents fire", () => {
    runtime.hooks.gameView = { ticks: () => 1 } as any;
    runtime.state.emoji.enabled = false;
    const ok = internals.emitEmoji(0, "AllPlayers", "hello");
    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("exposes the manual picker hotkey internals", () => {
    // These are the names that __superhumanBotDebug.emoji.openPicker +
    // the install path depend on. A broken refactor here would silently
    // disable the hotkey, so guard against it.
    expect(typeof internals.openEmojiPicker).toBe("function");
    expect(typeof internals.closeEmojiPicker).toBe("function");
    expect(typeof internals.handleEmojiPickerKeyDown).toBe("function");
    expect(typeof internals.installEmojiPickerHotkey).toBe("function");
    expect(internals.getPickerKeybind()).toBe("KeyZ");
  });

  it("opens and closes the picker overlay without throwing", () => {
    // Picker mounts a <div id="of-superbot-emoji-picker"> into
    // document.body. Verify the overlay lifecycle works end-to-end.
    internals.closeEmojiPicker();
    expect(document.getElementById("of-superbot-emoji-picker")).toBeNull();
    internals.openEmojiPicker();
    const el = document.getElementById("of-superbot-emoji-picker");
    expect(el).not.toBeNull();
    // Grid should contain one button per emoji.
    const buttons = el!.querySelectorAll("button.of-ep-emoji");
    expect(buttons.length).toBe(60);
    internals.closeEmojiPicker();
    expect(document.getElementById("of-superbot-emoji-picker")).toBeNull();
  });

  it("picker buttons send through emitEmoji + bump the counter", () => {
    runtime.hooks.gameView = { ticks: () => 50 } as any;
    runtime.world = {
      tick: 50,
      allianceGraph: { largestBlocShare: 0, coalitionThreat: false },
      totals: { myShare: 0, crownShare: 0, alivePlayers: 1 },
      threats: { crown: null, risingStars: [], nearestDanger: null },
      archetype: "unknown",
    };
    internals.openEmojiPicker();
    const el = document.getElementById("of-superbot-emoji-picker")!;
    const buttons = el.querySelectorAll(
      "button.of-ep-emoji",
    ) as NodeListOf<HTMLButtonElement>;
    const priorCount = runtime.state.emoji.totalEmojisSent;
    buttons[15].click(); // 👋
    expect(sent.at(-1)?.intent).toEqual({
      type: "emoji",
      recipient: "AllPlayers",
      emoji: 15,
    });
    expect(runtime.state.emoji.totalEmojisSent).toBe(priorCount + 1);
    // Clicking a button also closes the overlay.
    expect(document.getElementById("of-superbot-emoji-picker")).toBeNull();
  });
});
