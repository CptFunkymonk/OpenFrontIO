// ==UserScript==
// @name         OpenFront.io Emoji Broadcast Hotkey
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Press a key (default: Z) during an OpenFront.io match to broadcast an emoji to every other player (friendlies and enemies). Pure userscript — does not modify the base game.
// @author       Cursor
// @match        https://openfront.io/*
// @match        http://localhost:*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * ---------------------------------------------------------------------------
 * What this does
 * ---------------------------------------------------------------------------
 *
 *   In OpenFront.io, the built-in way to send an emoji is:
 *      right-click a player -> info -> emoji -> pick, or
 *      alt-click a player   -> pick.
 *   Both require pointing at a specific player first.
 *
 *   A lot of players use emojis to coordinate with friendlies and trash-talk
 *   enemies, but there was no one-key way to broadcast to everyone. This
 *   userscript adds exactly that:
 *
 *      Press Z (configurable via localStorage) during a match ->
 *      the script shows an emoji picker overlay ->
 *      click any emoji ->
 *      the emoji is broadcast to all players (AllPlayers).
 *
 *   The script never touches the game source — it just:
 *     1. Wraps window.WebSocket (and listens for the local-transport
 *        bridge used in singleplayer) so it has a handle to the live
 *        transport the game is already using.
 *     2. Listens for the configured key on window.
 *     3. Builds its own overlay DOM (same 60 emojis the game uses).
 *     4. Sends the plain ClientIntentMessage the game itself would send:
 *          { type: "intent", intent: { type: "emoji",
 *              recipient: "AllPlayers", emoji: <index> } }
 *
 *   Server-side cooldown / validation still applies — if the server
 *   rejects (e.g. too soon after the last emoji), it simply won't show up.
 *
 * ---------------------------------------------------------------------------
 * Configuration (all via localStorage, inspect via devtools)
 * ---------------------------------------------------------------------------
 *
 *   emojiBroadcast.keybind      (string, default "KeyZ")
 *                                KeyboardEvent.code to trigger the picker.
 *                                Examples: "KeyZ", "KeyV", "F2", "Backquote".
 *   emojiBroadcast.enabled      (string, default "true")
 *                                Set to "false" to disable the hotkey.
 *   emojiBroadcast.debug        (string, default "false")
 *                                Set to "true" for verbose console logs.
 * ---------------------------------------------------------------------------
 */

(function () {
  "use strict";

  const SCRIPT_VERSION = "1.0.0";
  const LOG_PREFIX = "[emoji-broadcast]";
  const OVERLAY_ID = "of-emoji-broadcast-overlay";
  const OVERLAY_Z_INDEX = 2147483600;
  const AllPlayers = "AllPlayers";

  // Mirrors `emojiTable` / `flattenedEmojiTable` in src/core/Util.ts.
  // Index into this array is the wire-format "emoji" field.
  const EMOJI_GRID = [
    ["\u{1F600}", "\u{1F60A}", "\u{1F970}", "\u{1F607}", "\u{1F60E}"],
    ["\u{1F61E}", "\u{1F97A}", "\u{1F62D}", "\u{1F631}", "\u{1F621}"],
    ["\u{1F608}", "\u{1F921}", "\u{1F971}", "\u{1FAE1}", "\u{1F595}"],
    ["\u{1F44B}", "\u{1F44F}", "\u270B", "\u{1F64F}", "\u{1F4AA}"],
    ["\u{1F44D}", "\u{1F44E}", "\u{1FAF4}", "\u{1F90C}", "\u{1F926}\u200D\u2642\uFE0F"],
    ["\u{1F91D}", "\u{1F198}", "\u{1F54A}\uFE0F", "\u{1F3F3}\uFE0F", "\u23F3"],
    ["\u{1F525}", "\u{1F4A5}", "\u{1F480}", "\u2622\uFE0F", "\u26A0\uFE0F"],
    ["\u2196\uFE0F", "\u2B06\uFE0F", "\u2197\uFE0F", "\u{1F451}", "\u{1F947}"],
    ["\u2B05\uFE0F", "\u{1F3AF}", "\u27A1\uFE0F", "\u{1F948}", "\u{1F949}"],
    ["\u2199\uFE0F", "\u2B07\uFE0F", "\u2198\uFE0F", "\u2764\uFE0F", "\u{1F494}"],
    ["\u{1F4B0}", "\u2693", "\u26F5", "\u{1F3E1}", "\u{1F6E1}\uFE0F"],
    ["\u{1F3ED}", "\u{1F682}", "\u2753", "\u{1F414}", "\u{1F400}"],
  ];
  const FLATTENED_EMOJIS = EMOJI_GRID.reduce(
    (acc, row) => acc.concat(row),
    [],
  );

  // -- Config helpers --------------------------------------------------------

  function readSetting(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return raw;
    } catch (_) {
      return fallback;
    }
  }

  function isDebugEnabled() {
    return readSetting("emojiBroadcast.debug", "false") === "true";
  }

  function isEnabled() {
    return readSetting("emojiBroadcast.enabled", "true") !== "false";
  }

  function getKeybind() {
    const raw = readSetting("emojiBroadcast.keybind", "KeyZ");
    if (typeof raw !== "string" || raw.length === 0) return "KeyZ";
    return raw;
  }

  function log(...args) {
    if (!isDebugEnabled()) return;
    try {
      console.log(LOG_PREFIX, ...args);
    } catch (_) {}
  }

  function warn(...args) {
    try {
      console.warn(LOG_PREFIX, ...args);
    } catch (_) {}
  }

  // -- Transport hooks -------------------------------------------------------
  //
  // We need to send an intent through whichever transport the game is
  // currently using. For multiplayer it's a WebSocket; for singleplayer
  // it's an in-process bridge published at window.__openFrontLocalTransport.
  //
  // We wrap window.WebSocket at document-start so we see the game socket
  // as soon as the client opens it. We don't rely on the `/game/` path
  // detection — instead we stash every non-lobby socket and use the most
  // recent OPEN one when sending.

  const NativeWebSocket = window.WebSocket;
  const state = {
    gameSocket: null,
    bridge: null,
    hookInstalled: false,
  };

  function installWebSocketHook() {
    if (state.hookInstalled) return;
    if (window.__emojiBroadcastWebSocketWrapped) {
      // Something else already wrapped it (e.g. the superhuman bot).
      // That's fine — its wrapper will still fire the native constructor,
      // so we can piggyback by scanning the DOM later. But we won't
      // double-wrap, because wrapping twice breaks the prototype chain.
      state.hookInstalled = true;
      return;
    }
    window.__emojiBroadcastWebSocketWrapped = true;
    state.hookInstalled = true;

    window.WebSocket = function (url, protocols) {
      const socket = protocols
        ? new NativeWebSocket(url, protocols)
        : new NativeWebSocket(url);

      const urlText = String(url);
      if (!urlText.includes("/lobbies")) {
        state.gameSocket = socket;
        log("captured game socket", urlText);
      }

      socket.addEventListener("close", () => {
        if (state.gameSocket === socket) {
          state.gameSocket = null;
          log("game socket closed");
        }
      });

      return socket;
    };

    window.WebSocket.prototype = NativeWebSocket.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((prop) => {
      try {
        Object.defineProperty(window.WebSocket, prop, {
          value: NativeWebSocket[prop],
        });
      } catch (_) {}
    });
  }

  function refreshLocalBridge() {
    const bridge = window.__openFrontLocalTransport;
    if (bridge && typeof bridge.send === "function") {
      if (state.bridge !== bridge) {
        state.bridge = bridge;
        log("captured local transport bridge");
      }
    } else if (state.bridge && !bridge) {
      state.bridge = null;
      log("local transport bridge closed");
    }
  }

  function sendClientMessage(msg) {
    refreshLocalBridge();

    const socket = state.gameSocket;
    if (socket && socket.readyState === NativeWebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(msg));
        return true;
      } catch (err) {
        warn("socket send failed", err && err.message);
      }
    }

    if (state.bridge && typeof state.bridge.send === "function") {
      try {
        state.bridge.send(msg);
        return true;
      } catch (err) {
        warn("local bridge send failed", err && err.message);
        return false;
      }
    }

    warn("no open transport to send through");
    return false;
  }

  function sendEmojiBroadcast(emojiIndex) {
    if (!Number.isInteger(emojiIndex)) return false;
    if (emojiIndex < 0 || emojiIndex >= FLATTENED_EMOJIS.length) return false;

    const msg = {
      type: "intent",
      intent: {
        type: "emoji",
        recipient: AllPlayers,
        emoji: emojiIndex,
      },
    };
    const ok = sendClientMessage(msg);
    log("broadcast emoji", emojiIndex, FLATTENED_EMOJIS[emojiIndex], "ok=" + ok);
    return ok;
  }

  // -- Game-state probing ----------------------------------------------------
  //
  // Trigger only while the local player is actually playing. We look up the
  // GameView the same way the existing bot userscript does: lit elements like
  // <control-panel>, <player-panel>, <events-display> hold a reference.

  const GAME_VIEW_DESCRIPTORS = [
    { selector: "control-panel", gameKey: "game" },
    { selector: "player-panel", gameKey: "g" },
    { selector: "events-display", gameKey: "game" },
    { selector: "player-info-overlay", gameKey: "game" },
    { selector: "emoji-table", gameKey: "game" },
    { selector: "main-radial-menu", gameKey: "game" },
    { selector: "name-layer", gameKey: "game" },
  ];

  function findGameView() {
    for (const desc of GAME_VIEW_DESCRIPTORS) {
      const el = document.querySelector(desc.selector);
      if (!el) continue;
      const gv = el[desc.gameKey];
      if (
        gv &&
        typeof gv.ticks === "function" &&
        typeof gv.myPlayer === "function"
      ) {
        return gv;
      }
    }
    return null;
  }

  function isInActiveGame() {
    const gv = findGameView();
    if (!gv) return false;
    // Don't try to broadcast during the spawn phase - the server ignores it.
    let inSpawnPhase = false;
    try {
      inSpawnPhase =
        typeof gv.inSpawnPhase === "function" ? gv.inSpawnPhase() : false;
    } catch (_) {}
    if (inSpawnPhase) return false;
    let me = null;
    try {
      me = gv.myPlayer();
    } catch (_) {
      me = null;
    }
    if (!me) return false;
    try {
      if (typeof me.isAlive === "function" && !me.isAlive()) return false;
    } catch (_) {}
    return true;
  }

  // -- Overlay UI ------------------------------------------------------------

  let overlayEl = null;

  function ensureStyles() {
    if (document.getElementById(OVERLAY_ID + "-styles")) return;
    const style = document.createElement("style");
    style.id = OVERLAY_ID + "-styles";
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.35);
        z-index: ${OVERLAY_Z_INDEX};
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      #${OVERLAY_ID} .of-eb-panel {
        position: relative;
        background: rgba(24, 24, 27, 0.96);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        padding: 14px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
        max-width: calc(100vw - 32px);
      }
      #${OVERLAY_ID} .of-eb-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
        gap: 12px;
      }
      #${OVERLAY_ID} .of-eb-title {
        color: #fafafa;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
      #${OVERLAY_ID} .of-eb-subtitle {
        color: rgba(250, 250, 250, 0.55);
        font-size: 11px;
        margin-left: 8px;
      }
      #${OVERLAY_ID} .of-eb-close {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        border: none;
        background: #3f3f46;
        color: #fafafa;
        font-size: 14px;
        cursor: pointer;
        line-height: 1;
      }
      #${OVERLAY_ID} .of-eb-close:hover { background: #ef4444; }
      #${OVERLAY_ID} .of-eb-grid {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 6px;
      }
      #${OVERLAY_ID} .of-eb-emoji {
        width: 56px;
        height: 56px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: #27272a;
        color: #fafafa;
        font-size: 30px;
        line-height: 1;
        cursor: pointer;
        transition: transform 120ms ease, background 120ms ease;
      }
      #${OVERLAY_ID} .of-eb-emoji:hover {
        background: #3f3f46;
        transform: scale(1.08);
      }
      #${OVERLAY_ID} .of-eb-emoji:active { transform: scale(0.96); }
      #${OVERLAY_ID} .of-eb-footer {
        margin-top: 10px;
        color: rgba(250, 250, 250, 0.5);
        font-size: 11px;
        text-align: center;
      }
      #${OVERLAY_ID} .of-eb-toast {
        position: fixed;
        left: 50%;
        bottom: 56px;
        transform: translateX(-50%);
        background: rgba(24, 24, 27, 0.94);
        color: #fafafa;
        border-radius: 999px;
        padding: 8px 14px;
        font-size: 13px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        z-index: ${OVERLAY_Z_INDEX + 1};
        pointer-events: none;
        opacity: 0;
        transition: opacity 160ms ease;
      }
      #${OVERLAY_ID} .of-eb-toast.visible { opacity: 1; }
    `;
    document.head.appendChild(style);
  }

  function renderKeybindLabel() {
    const raw = getKeybind();
    if (raw.startsWith("Key")) return raw.slice(3);
    if (raw.startsWith("Digit")) return raw.slice(5);
    return raw;
  }

  function closeOverlay() {
    if (overlayEl && overlayEl.parentNode) {
      overlayEl.parentNode.removeChild(overlayEl);
    }
    overlayEl = null;
  }

  function openOverlay() {
    ensureStyles();
    closeOverlay();

    const root = document.createElement("div");
    root.id = OVERLAY_ID;
    root.addEventListener("click", (e) => {
      if (e.target === root) {
        closeOverlay();
      }
    });

    const panel = document.createElement("div");
    panel.className = "of-eb-panel";
    panel.addEventListener("contextmenu", (e) => e.preventDefault());
    panel.addEventListener("click", (e) => e.stopPropagation());

    const header = document.createElement("div");
    header.className = "of-eb-header";

    const titleWrap = document.createElement("div");
    const title = document.createElement("span");
    title.className = "of-eb-title";
    title.textContent = "Broadcast Emoji";
    const subtitle = document.createElement("span");
    subtitle.className = "of-eb-subtitle";
    subtitle.textContent = "visible to all players";
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "of-eb-close";
    closeBtn.textContent = "\u2715";
    closeBtn.addEventListener("click", closeOverlay);

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    const grid = document.createElement("div");
    grid.className = "of-eb-grid";
    FLATTENED_EMOJIS.forEach((emoji, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "of-eb-emoji";
      btn.textContent = emoji;
      btn.addEventListener("click", () => {
        const ok = sendEmojiBroadcast(idx);
        closeOverlay();
        if (ok) {
          showToast("Broadcast " + emoji);
        } else {
          showToast("Could not broadcast " + emoji);
        }
      });
      grid.appendChild(btn);
    });

    const footer = document.createElement("div");
    footer.className = "of-eb-footer";
    footer.textContent =
      "Press " +
      renderKeybindLabel() +
      " again or Esc to close. Broadcasts to all players.";

    panel.appendChild(header);
    panel.appendChild(grid);
    panel.appendChild(footer);
    root.appendChild(panel);

    document.body.appendChild(root);
    overlayEl = root;
  }

  function toggleOverlay() {
    if (overlayEl) {
      closeOverlay();
    } else {
      openOverlay();
    }
  }

  // Non-blocking toast so the player sees that their broadcast was sent.
  // Lives outside the overlay so it stays visible after the picker closes.
  let toastTimeout = null;
  let toastEl = null;

  function showToast(text) {
    ensureStyles();
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "of-eb-toast";
      toastEl.style.position = "fixed";
      toastEl.style.left = "50%";
      toastEl.style.bottom = "56px";
      toastEl.style.transform = "translateX(-50%)";
      toastEl.style.background = "rgba(24, 24, 27, 0.94)";
      toastEl.style.color = "#fafafa";
      toastEl.style.borderRadius = "999px";
      toastEl.style.padding = "8px 14px";
      toastEl.style.fontSize = "13px";
      toastEl.style.border = "1px solid rgba(255, 255, 255, 0.08)";
      toastEl.style.zIndex = String(OVERLAY_Z_INDEX + 1);
      toastEl.style.pointerEvents = "none";
      toastEl.style.opacity = "0";
      toastEl.style.transition = "opacity 160ms ease";
      toastEl.style.fontFamily =
        "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = "1";
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      if (toastEl) toastEl.style.opacity = "0";
    }, 1400);
  }

  // -- Keybind listener ------------------------------------------------------

  function isTextInputTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function handleKeyDown(e) {
    if (!isEnabled()) return;

    if (e.code === "Escape" && overlayEl) {
      e.preventDefault();
      e.stopPropagation();
      closeOverlay();
      return;
    }

    if (e.code !== getKeybind()) return;
    if (e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTextInputTarget(e.target)) return;

    // Toggle the overlay when already open (common "press Z again" muscle
    // memory). Otherwise require an active game so the key still works as
    // expected in the menu.
    if (overlayEl) {
      e.preventDefault();
      e.stopPropagation();
      closeOverlay();
      return;
    }

    if (!isInActiveGame()) {
      log("ignored keypress: no active game");
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    openOverlay();
  }

  // -- Boot ------------------------------------------------------------------

  function boot() {
    installWebSocketHook();
    // Periodically re-check the local-transport bridge — singleplayer
    // creates / destroys it on Play / Leave.
    setInterval(refreshLocalBridge, 500);
    window.addEventListener("keydown", handleKeyDown, true);
    log("OpenFront.io Emoji Broadcast Hotkey v" + SCRIPT_VERSION + " loaded");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
