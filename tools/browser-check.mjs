/**
 * Browser check: does the app actually render and play in a real browser?
 *
 * Everything else in this project is verified without pixels. This script closes that
 * gap: it launches headless Chrome, drives it over the DevTools protocol, plays real
 * moves with real (trusted) input events, reports every JavaScript error the page threw,
 * and writes screenshots you can look at.
 *
 *   node tools/browser-check.mjs                 # against http://127.0.0.1:8787
 *   node tools/browser-check.mjs http://host:port
 *   node tools/browser-check.mjs --chrome="C:\path\to\chrome.exe"
 *
 * Chrome needs a Windows named pipe for its IPC, so in a sandboxed environment this must
 * run with wider permissions than the default. It kills only the Chrome process it
 * started, by PID.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BASE = (process.argv.find((arg) => arg.startsWith("http")) ?? process.env.JEVCHESS_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const OUT_DIR = join(ROOT, "screenshots");
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9333);
const CHROME =
  process.argv.find((arg) => arg.startsWith("--chrome="))?.slice("--chrome=".length) ??
  process.env.CHROME_PATH ??
  [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((path) => existsSync(path));

const problems = [];
const notes = [];

function ok(condition, message) {
  if (condition) {
    console.log(`  ok    ${message}`);
  } else {
    problems.push(message);
    console.log(`  FAIL  ${message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!CHROME) {
  console.error("No Chrome binary found. Pass --chrome=<path> or set CHROME_PATH.");
  process.exit(2);
}

console.log(`JevChess browser check`);
console.log(`  page:   ${BASE}`);
console.log(`  chrome: ${CHROME}`);
console.log(`  out:    ${OUT_DIR}\n`);

await mkdir(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// launch Chrome, connect to the DevTools protocol
// ---------------------------------------------------------------------------

const profile = join(tmpdir(), `jevchess-chrome-${Date.now()}`);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--mute-audio",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--window-size=1440,960",
    "about:blank",
  ],
  // stdio 'ignore' rather than 'pipe': piped stdio to child processes is blocked in
  // sandboxed environments, and Chrome's output is noise anyway.
  { stdio: "ignore" },
);

let ws = null;
let nextId = 1;
const pending = new Map();

/** How many games the server is holding — used to prove the page does not create one by itself. */
async function fetchGames() {
  try {
    const response = await fetch(`${BASE}/api/health`);
    const json = await response.json();
    return typeof json.games === "number" ? json.games : -1;
  } catch {
    return -1;
  }
}
const pageErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    pending.set(id, { resolvePromise, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30_000);
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result?.value;
}

async function screenshot(name) {
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const path = join(OUT_DIR, name);
  await writeFile(path, Buffer.from(shot.data, "base64"));
  console.log(`  shot  ${path}`);
  return path;
}

/** Diagnostics about what is actually on the page right now. */
const DIAGNOSTICS = `(() => {
  const q = (sel) => document.querySelector(sel);
  const all = (sel) => Array.from(document.querySelectorAll(sel));
  const svg = q('#board-host svg');
  const rect = svg ? svg.getBoundingClientRect() : null;
  const text = (sel) => (q(sel)?.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 220);
  return {
    title: document.title,
    svgCells: all('#board-host svg [data-square]').length,
    pieces: all('#board-host .piece').length,
    pieceGlyphs: all('#board-host .piece').slice(0, 3).map((n) => (n.textContent || '').trim()),
    boardState: svg?.dataset?.boardState ?? null,
    boardOrientation: svg?.dataset?.orientation ?? null,
    boardRect: rect ? { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top) } : null,
    evalBarHeight: Math.round((q('#eval-bar')?.getBoundingClientRect().height) ?? 0),
    status: text('#status-line'),
    panelChars: (q('#jev-panel')?.textContent ?? '').trim().length,
    panelHeadline: text('#jev-panel'),
    // One element per ply (not per row): a row holds a white move and possibly a black
    // reply, so counting rows would undercount the game's progress.
    moveListRows: all('#move-list [data-ply]').length,
    moveListText: text('#move-list'),
    banner: q('#jev-banner') && !q('#jev-banner').hidden ? text('#jev-banner') : null,
    toasts: all('#toast-stack .toast').map((n) => n.textContent.trim().slice(0, 120)),
    dialogOpen: Boolean(q('#new-game-dialog')?.open),
    // A button the app hidden must really be invisible: a display value of flex beats
    // the hidden attribute unless the stylesheet defends it.
    drawButtonVisible: (() => {
      const b = q('#btn-draw');
      if (!b) return 'missing';
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(b).display !== 'none';
    })(),
    customClockVisible: (() => {
      const row = q('#custom-clock');
      if (!row) return 'missing';
      const r = row.getBoundingClientRect();
      return r.height > 0 && getComputedStyle(row).display !== 'none';
    })(),
    clockTexts: all('.player-card .clock, .player-card [data-clock]').map((n) => n.textContent.trim()),
    // Whose move is it, before anything moves?
    hintText: text('#board-hint'),
    hintTurn: q('#board-hint')?.dataset?.turn ?? null,
    hintThinking: q('#board-hint')?.dataset?.thinking ?? null,
    activeCard: (q('.player-card.is-active')?.dataset?.color) ?? null,
    thinkingCards: all('.player-card[data-thinking="true"]').map((n) => n.dataset.color),
    turnChips: all('.player-card .player-turn').filter((n) => !n.hidden).map((n) => (n.closest('.player-card')?.dataset?.color ?? '?') + ':' + n.textContent.trim()),
    cardTexts: all('.player-card').map((n) => n.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60)),
    styleSheets: document.styleSheets.length,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    cardCount: all('.player-card').length,
  };
})()`;

/** Centre of a board square in CSS pixels, for real input events. */
const squareCentre = (square) => `(() => {
  const el = document.querySelector('#board-host svg [data-square="${square}"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

async function mouse(type, point, extra = {}) {
  await send("Input.dispatchMouseEvent", {
    type,
    x: point.x,
    y: point.y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: 1,
    pointerType: "mouse",
    ...extra,
  });
}

/** A real drag: press on `from`, move in steps, release on `to`. */
async function drag(from, to) {
  const start = await evaluate(squareCentre(from));
  const end = await evaluate(squareCentre(to));
  if (!start || !end) throw new Error(`could not locate ${from} or ${to} on the board`);
  await mouse("mousePressed", start);
  for (let step = 1; step <= 4; step += 1) {
    await mouse("mouseMoved", {
      x: Math.round(start.x + ((end.x - start.x) * step) / 4),
      y: Math.round(start.y + ((end.y - start.y) * step) / 4),
    });
    await sleep(30);
  }
  await mouse("mouseReleased", end);
}

// ---------------------------------------------------------------------------

try {
  // Wait for the DevTools endpoint.
  let version = null;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && !version) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (response.ok) version = await response.json();
    } catch {
      await sleep(400);
    }
  }
  if (!version) throw new Error(`Chrome did not open a DevTools port on ${DEBUG_PORT}`);
  console.log(`  info  ${version.Browser}\n`);

  const listResponse = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const targets = await listResponse.json();
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("no page target to attach to");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    ws.addEventListener("open", resolvePromise, { once: true });
    ws.addEventListener("error", () => reject(new Error("DevTools websocket failed")), { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolvePromise, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}`));
      else resolvePromise(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      pageErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "unknown error");
    }
    if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
      pageErrors.push(`console.${message.params.type}: ${(message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ")}`);
    }
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      pageErrors.push(`log: ${message.params.entry.text}`);
    }
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");

  // Evidence of what the UI actually sent: the game-creation bodies are the fastest way
  // to tell "the dialog submitted what I asked for" from "my synthetic click did nothing".
  const gameRequests = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.requestWillBeSent" && /\/api\/games$/.test(message.params.request.url)) {
      gameRequests.push({ method: message.params.request.method, body: message.params.request.postData ?? null });
    }
  });

  // --- load --------------------------------------------------------------
  console.log("1. loading the page");
  const gamesBefore = await fetchGames();
  await send("Page.navigate", { url: `${BASE}/` });
  await sleep(2500);
  const initial = await evaluate(DIAGNOSTICS);
  ok(initial.styleSheets > 0, `CSS applied (${initial.styleSheets} stylesheet(s), body ${initial.bodyBg})`);
  ok(initial.svgCells >= 64, `board rendered with ${initial.svgCells} square elements`);
  ok(initial.pieces === 32, `start position drawn with ${initial.pieces} pieces (expected 32)`);
  ok(initial.pieceGlyphs.every((glyph) => glyph.length > 0), `pieces carry glyphs (${JSON.stringify(initial.pieceGlyphs)})`);
  ok(initial.boardRect?.w > 300 && initial.boardRect?.h > 300, `board has a real size (${initial.boardRect?.w}×${initial.boardRect?.h})`);
  ok(initial.evalBarHeight > 100, `evaluation bar has height (${initial.evalBarHeight}px)`);
  ok(initial.cardCount === 2, `two player cards (${initial.cardCount})`);
  ok(Boolean(initial.status), `status line says something: "${initial.status}"`);
  ok(initial.drawButtonVisible === true, `"Offer draw" is offered once a game exists (visible: ${initial.drawButtonVisible})`);
  ok(initial.customClockVisible === false, `the custom-clock row obeys "hidden" (visible: ${initial.customClockVisible})`);
  // "Whose move is it, before the piece moves?" — at load it is White (the human) to move and
  // nothing has been played yet, so all three indicators have to say so.
  ok(initial.hintTurn === "w", `the board hint carries the side to move (data-turn="${initial.hintTurn}")`);
  ok(/white/i.test(initial.hintText), `the hint names the side in words: "${initial.hintText}"`);
  ok(initial.activeCard === "w", `White's card is marked active before White moves (${initial.activeCard})`);
  ok(
    initial.turnChips.some((chip) => chip.startsWith("w:")),
    `the seat on the move shows a turn chip (${JSON.stringify(initial.turnChips)})`,
  );
  const gamesAfterLoad = await fetchGames();
  // Deliberate behaviour: the page starts a human-vs-Jev game on load so the board is
  // live immediately (that is also why a clock is running from the first second).
  ok(gamesAfterLoad === gamesBefore + 1, `loading the page starts exactly one game (${gamesBefore} → ${gamesAfterLoad})`);
  const idleClock = await evaluate(`Array.from(document.querySelectorAll('.player-card')).map((n) => n.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`);
  await sleep(1500);
  const idleClockLater = await evaluate(`Array.from(document.querySelectorAll('.player-card')).map((n) => n.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`);
  notes.push(
    `player cards with the auto-started game: "${idleClock}"${idleClock === idleClockLater ? " (static)" : " → clock ticking, as expected for a live game"}`,
  );
  await screenshot("01-initial.png");

  // --- start a Jev vs Jev game from the dialog ---------------------------
  console.log("\n2. opening the new-game dialog and starting Jev vs Jev");
  await evaluate(`document.querySelector('#btn-new').click()`);
  await sleep(1200);
  const dialog = await evaluate(DIAGNOSTICS);
  ok(dialog.dialogOpen, "the new-game dialog opened");
  const strategyCards = await evaluate(`document.querySelectorAll('#players-grid select, #players-grid .strategy-card, #players-grid [data-strategy]').length`);
  ok(strategyCards > 0, `strategy controls rendered in the dialog (${strategyCards})`);
  const strategyStatus = await evaluate(`document.querySelector('#strategies-status')?.textContent?.trim() ?? ''`);
  ok(!/loading/i.test(strategyStatus), `strategies actually loaded ("${strategyStatus}")`);
  await screenshot("02-dialog.png");

  const started = await evaluate(`(() => {
    const radios = Array.from(document.querySelectorAll('#mode-choices input[type=radio]'));
    const jev = radios.find((r) => /jev-vs-jev|jev_vs_jev/i.test(r.value)) ?? radios[1];
    // A real click, not a synthetic checked+change: the app wires its own state to the
    // click event, and this is how a person selects the mode.
    if (jev) jev.click();
    // Give the White seat the planning strategy, so the plan panel has something to show.
    const selects = Array.from(document.querySelectorAll('#players-grid select'));
    let chosen = null;
    for (const select of selects) {
      const option = Array.from(select.options).find((o) => /strategist/i.test(o.textContent) || /strategist/i.test(o.value));
      if (option) {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        chosen = option.textContent.trim();
        break;
      }
    }
    const submit = document.querySelector('#dialog-start');
    if (!submit) return 'missing submit button';
    submit.click();
    return (jev ? 'clicked ' + jev.value : 'clicked Start game') + (chosen ? ' with White = ' + chosen : ' (no strategist option found)');
  })()`);
  console.log(`  info  ${started}`);
  // A planning move costs a Gemini review plus Jev plus the search — seven to twelve seconds is
  // normal — so wait for the first move rather than guessing at a fixed pause.
  const firstMoveDeadline = Date.now() + 90_000;
  let played = await evaluate(DIAGNOSTICS);
  // A Jev-vs-Jev game spends seconds thinking before each move; sample that window, because
  // "which colour is on the move" is exactly what the new indicators have to answer there.
  let thinkingSample = null;
  while (Date.now() < firstMoveDeadline && played.moveListRows === 0) {
    if (!thinkingSample && played.hintThinking === "true") thinkingSample = played;
    await sleep(1000);
    played = await evaluate(DIAGNOSTICS);
  }
  if (thinkingSample) {
    notes.push(
      `while the first Jev move was being chosen: hint "${thinkingSample.hintText}" · active card ${thinkingSample.activeCard} · chips ${JSON.stringify(thinkingSample.turnChips)}`,
    );
  }

  const request = gameRequests[gameRequests.length - 1];
  ok(Boolean(request), `the UI sent POST /api/games (${gameRequests.length} request(s))`);
  if (request?.body) {
    notes.push(`create body: ${request.body.slice(0, 220)}`);
    ok(/"mode"\s*:\s*"jev-vs-jev"/.test(request.body), `the request asked for Jev vs Jev (${request.body.slice(0, 120)})`);
  }
  ok(played.dialogOpen === false, "the dialog closed after starting the game");
  ok(played.moveListRows > 0, `moves were played and listed (${played.moveListRows} row(s))`);
  ok(played.pieces > 0, `pieces still drawn after moves (${played.pieces})`);
  ok(played.panelChars > 50, `the Jev panel has content (${played.panelChars} chars)`);
  // The same three indicators must still agree mid-game, with both seats run by Jev.
  ok(
    played.hintTurn === "w" || played.hintTurn === "b",
    `the board hint names the side to move mid-game (data-turn="${played.hintTurn}")`,
  );
  ok(
    played.activeCard === played.hintTurn,
    `the active player card matches the side to move (card ${played.activeCard} vs turn ${played.hintTurn})`,
  );
  ok(
    played.turnChips.some((chip) => chip.startsWith(`${played.hintTurn}:`)),
    `the seat on the move shows a turn chip (${JSON.stringify(played.turnChips)})`,
  );
  ok(
    Boolean(thinkingSample),
    `a watcher could see the seat on the move thinking before the piece moved${thinkingSample ? ` ("${thinkingSample.hintText}")` : " (no thinking snapshot was sampled)"}`,
  );

  // The strategy layer must be visible to a watcher, not just present in the API.
  const planBlock = await evaluate(`(() => {
    const box = document.querySelector('#jev-panel .jev-plan');
    if (!box) return null;
    return {
      kind: (box.querySelector('.jev-plan-kind')?.textContent ?? '').trim(),
      facts: Array.from(box.querySelectorAll('.chip')).map((c) => c.textContent.trim()),
      commentary: (box.querySelector('.jev-plan-commentary')?.textContent ?? '').trim(),
      meta: (box.querySelector('.jev-plan-meta')?.textContent ?? '').trim(),
      badges: Array.from(box.querySelectorAll('.badge')).map((b) => b.textContent.trim()),
      tally: (box.querySelector('.jev-plan-tally')?.textContent ?? '').trim(),
      text: box.textContent.replace(/\\s+/g, ' ').trim().slice(0, 300),
    };
  })()`);
  ok(Boolean(planBlock), "the plan block is rendered in the Jev panel");
  if (planBlock) {
    console.log(`  info  plan panel: ${planBlock.kind}${planBlock.badges.length ? ` [${planBlock.badges.join(', ')}]` : ""}`);
    if (planBlock.facts.length) console.log(`  info  plan facts: ${planBlock.facts.join(" · ")}`);
    if (planBlock.commentary) console.log(`  info  commentary: ${planBlock.commentary}`);
    if (planBlock.meta) console.log(`  info  plan meta:  ${planBlock.meta}`);
    const explained =
      /no strategist key/i.test(planBlock.text) ||
      /no plan yet/i.test(planBlock.text) ||
      /could not be used/i.test(planBlock.text);
    ok(
      Boolean(planBlock.kind) && planBlock.kind !== "No plan in force" || explained,
      `the plan block either names a plan or explains why there is none ("${planBlock.kind}")`,
    );
    // "A plan is in force" must be visibly separate from "the plan changed something".
    if (planBlock.tally) {
      console.log(`  info  plan effect: ${planBlock.tally}`);
      ok(
        /moves? played under a plan/.test(planBlock.tally) && /review/.test(planBlock.tally),
        `the plan block counts what the plan has actually done ("${planBlock.tally}")`,
      );
    } else {
      ok(explained, "no effect line is shown, and the block explains why there is no plan in force");
    }
  }
  await screenshot("03-jev-vs-jev.png");

  // --- a human game, driven by real input events -------------------------
  console.log("\n3. human vs Jev, played with real mouse input");
  await evaluate(`document.querySelector('#btn-new').click()`);
  await sleep(1000);
  await evaluate(`(() => {
    const radios = Array.from(document.querySelectorAll('#mode-choices input[type=radio]'));
    const human = radios.find((r) => /human/i.test(r.value)) ?? radios[0];
    if (human) human.click();
    const colour = Array.from(document.querySelectorAll('#color-choices input[type=radio]')).find((r) => r.value === 'w');
    if (colour) colour.click();
    const submit = document.querySelector('#dialog-start');
    if (submit) submit.click();
    return 'clicked Human vs Jev, White, then Start game';
  })()`);
  await sleep(3000);

  const beforeMove = await evaluate(DIAGNOSTICS);
  const beforeRows = beforeMove.moveListRows;
  ok(beforeMove.dialogOpen === false, "the dialog closed and the game view is active");

  await drag("e2", "e4");
  // The round trip is a POST plus an SSE broadcast, so wait for the move to appear
  // rather than assuming one fixed delay is enough.
  let afterDrag = await evaluate(DIAGNOSTICS);
  const dragDeadline = Date.now() + 8000;
  while (Date.now() < dragDeadline && !/e4/.test(afterDrag.moveListText)) {
    await sleep(300);
    afterDrag = await evaluate(DIAGNOSTICS);
  }
  ok(afterDrag.moveListRows > beforeRows || /e4/.test(afterDrag.moveListText), `dragging e2-e4 was accepted (move list: "${afterDrag.moveListText.slice(0, 60)}")`);
  if (afterDrag.toasts.length) notes.push(`toasts after the drag: ${JSON.stringify(afterDrag.toasts)}`);
  await screenshot("04-after-human-move.png");

  // The Jev seat (mock, but a real pipeline) must then answer on its own.
  const deadline2 = Date.now() + 25_000;
  let afterReply = afterDrag;
  while (Date.now() < deadline2) {
    await sleep(1000);
    afterReply = await evaluate(DIAGNOSTICS);
    if (afterReply.moveListRows >= afterDrag.moveListRows + 1 || afterReply.pieces < 32) break;
  }
  ok(
    afterReply.moveListRows > afterDrag.moveListRows || afterReply.pieces !== afterDrag.pieces,
    `the Jev seat replied on its own (rows ${afterDrag.moveListRows} → ${afterReply.moveListRows}, pieces ${afterReply.pieces})`,
  );
  ok(afterReply.panelChars > 50, `the panel shows Jev's judgement after the reply (${afterReply.panelChars} chars)`);
  ok(afterReply.moveListRows >= 2, `the finished exchange is listed (${afterReply.moveListRows} row(s): "${afterReply.moveListText.slice(0, 40)}")`);
  await screenshot("05-after-jev-reply.png");

  // --- reported errors ---------------------------------------------------
  console.log("\n4. page health");
  const realErrors = pageErrors.filter((entry) => !/favicon|net::ERR_/i.test(entry));
  ok(realErrors.length === 0, `no JavaScript errors on the page (${realErrors.length})`);
  for (const error of realErrors.slice(0, 8)) console.log(`        ${error.slice(0, 300)}`);

  console.log("\nSummary");
  console.log(`  final status: "${afterReply.status}"`);
  console.log(`  panel:        "${afterReply.panelHeadline.slice(0, 140)}"`);
  console.log(`  move list:    "${afterReply.moveListText.slice(0, 140)}"`);
  console.log(`  banner:       ${afterReply.banner ? `"${afterReply.banner.slice(0, 120)}"` : "none"}`);
  for (const note of notes) console.log(`  note:         ${note}`);
} catch (error) {
  problems.push(`browser check failed: ${error.message}`);
  console.log(`\n  FAIL  ${error.message}`);
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  // Kill only the Chrome we started.
  try {
    chrome.kill();
    console.log(`\n  info  stopped Chrome (pid ${chrome.pid})`);
  } catch {
    /* ignore */
  }
}

console.log(`\n${problems.length === 0 ? "Browser check passed." : `${problems.length} problem(s):`}`);
for (const problem of problems) console.log(` - ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
