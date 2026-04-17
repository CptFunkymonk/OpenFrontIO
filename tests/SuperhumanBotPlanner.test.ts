/**
 * Regression tests for the standalone superhuman userscript.
 *
 * The userscript is an IIFE that expects a browser environment. We load the
 * raw source inside a sandboxed jsdom window, stub the few globals it
 * touches at module-init time, then invoke the built-in scripted planner
 * suite (`runtime.test.runSuite`). That suite covers:
 *   - planner goal selection across a variety of world states
 *   - alliance diplomacy helpers (accept / reject / safety guards)
 *   - terrain-rush goal selection when a neighbour is collapsing
 *   - low-level SAM trajectory math
 *
 * Running it here ensures the userscript's internal acceptance tests stay
 * green as the codebase evolves.
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

function loadUserscript() {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const win: any = (globalThis as any).window;

  // Stub the APIs the script touches during boot. We don't need any of these
  // to actually do anything — the hooks just have to exist.
  win.WebSocket = win.WebSocket ?? class {};
  win.Worker = win.Worker ?? class {};
  win.localStorage = win.localStorage ?? {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  // setInterval fires the main loop; the runSuite helper sidesteps that and
  // runs synchronously, so we just need the global to exist (it already does
  // in jsdom).
  new Function(source).call(win);
  return win.__superhumanBotRuntime;
}

describe("tampermonkey-superhuman-bot planner suite", () => {
  it("passes the built-in scripted regression suite", () => {
    const runtime = loadUserscript();
    expect(runtime, "userscript should expose runtime on window").toBeDefined();
    expect(runtime.test?.runSuite, "runSuite should be wired up").toBeTypeOf(
      "function",
    );
    const summary = runtime.test.runSuite();
    const failing = summary.results.filter((r: any) => !r.pass);
    if (failing.length > 0) {
      // Surface every failure at once so the user doesn't have to re-run to
      // see what else broke.
      const details = failing
        .map(
          (r: any) =>
            `  - ${r.name}: expected=${r.expected}, actual=${r.actual}`,
        )
        .join("\n");
      throw new Error(
        `Userscript planner suite had ${failing.length} failure(s):\n${details}`,
      );
    }
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBeGreaterThan(0);
  });
});
