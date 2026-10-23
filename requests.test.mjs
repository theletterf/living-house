import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import * as adapters from "./adapters.js";
import * as scenarios from "./scenarios.js";
import * as docs from "./docs.js";
import * as requests from "./requests.js";
import * as timings from "./performance.js";

const source = (await readFile(new URL("./app.js", import.meta.url), "utf8"))
  .replace(/^import .+;\n/gm, "").split("// ---------- boot ----------")[0];

function app(liveRender = false, clock = performance) {
  const nodes = new Map();
  const getNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      addEventListener() {}, setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [],
      hidden: false, value: "", dataset: {},
    });
    return nodes.get(id);
  };
  const context = vm.createContext({
    ...adapters, ...scenarios, ...docs, ...requests, ...timings,
    patchHTML: (node, html) => { node.innerHTML = html; }, requestAnimationFrame: () => 0,
    navigator: { gpu: {} }, performance: clock, structuredClone,
    document: { getElementById: getNode, addEventListener() {}, documentElement: getNode("html"), querySelectorAll: () => [] },
    getSelection: () => ({ isCollapsed: true }), liveRender,
    localStorage: { getItem: () => null },
    CSS: { supports: () => true }, setTimeout() {},
  });
  vm.runInContext(source + `
    if (!liveRender) render = () => {};
    renderChanges = renderActivity = renderConfirm = renderRequestFeedback = () => {};
    seed(); state.view = firstPage(); state.everStarted = true; state.setupOpen = false;
    state.engineKey = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
    globalThis.app = { state, submitRequest, runRound, maybeRunRound, validate, undoRequest, displayText, apply, undo, renderHelp, buildElements, aliases, pageName, proposalKey, log, buildContext };
  `, context);
  context.app.state.engine = { propose: async () => { throw new Error("Unexpected inference"); } };
  context.app.nodes = nodes;
  return context.app;
}
const flush = () => new Promise(setImmediate);
const change = (id, text) => ({ op: "text", id, text, reason: "test" });

// These exercise the real request/apply/Undo functions with DOM rendering stubbed.
test("Overview rename bypasses the model, updates the inherited heading and supports Undo", async () => {
  const a = app();
  const req = { text: "Rename Overview to Home", ui: "bar" };
  await a.submitRequest(req);
  assert.equal(a.state.els.get("nav_overview").text, "Home");
  assert.equal(a.displayText(a.state.els.get("overview.title")), "Home");
  assert.equal(req.changes.length, 1);
  assert.equal(a.state.rounds[0].attempts, 0);
  assert.equal(a.state.rounds[0].inferenceMs, 0);
  assert.equal(a.validate(change("nav_overview", "Dashboard")), "name set by the person");
  a.undoRequest(req);
  assert.equal(a.state.els.get("nav_overview").text, "Overview");
});

test("repeating a rename via an old alias succeeds without adding a change", async () => {
  const a = app();
  await a.submitRequest({ text: "Rename Overview to Home", ui: "bar" });
  const req = { text: "Rename Overview to Home", ui: "bar" };
  await a.submitRequest(req);
  assert.equal(req.reply, "Already set as requested.");
  assert.equal(a.state.changes.length, 1);
  assert.equal(a.state.rounds[1].rejected.length, 0);
});

test("explicit rename overrides soft locks but preserves length and operation checks", async () => {
  const a = app();
  a.state.els.get("nav_overview").frozen = true;
  await a.submitRequest({ text: "Rename Overview to Home", ui: "bar" });
  assert.equal(a.state.els.get("nav_overview").text, "Home");
  await a.submitRequest({ text: `Rename Home to ${"x".repeat(25)}`, ui: "bar" });
  assert.equal(a.state.els.get("nav_overview").text, "Home");
  a.state.config.ops = ["style"];
  await a.submitRequest({ text: "Rename Home to Dashboard", ui: "bar" });
  assert.equal(a.state.els.get("nav_overview").text, "Home");
});

test("a rename completes while background inference is pending and its result is discarded", async () => {
  const a = app();
  let complete;
  let interrupted = 0;
  a.state.events.push({ type: "hesitate", id: "nav_overview" }, { type: "hesitate", id: "nav_overview" });
  a.state.engine = { propose: () => new Promise((resolve) => { complete = resolve; }), interrupt: () => interrupted++ };
  const running = a.runRound();
  a.state.proposals.push(change("nav_overview", "Old proposal"));
  a.state.pending.push(change("nav_overview", "Old pending"));
  await a.submitRequest({ text: "Rename Overview to Home", ui: "bar" });
  assert.equal(a.state.els.get("nav_overview").text, "Home");
  assert.equal(interrupted, 1);
  complete({ changes: [change("nav_overview", "Stale name")], raw: "stale" });
  await running;
  assert.equal(a.state.proposals.length, 0);
  assert.equal(a.state.pending.length, 0);
  assert.equal(a.state.rounds.at(-1).cancelled, true);
  assert.equal(a.state.els.get("nav_overview").text, "Home");
});

test("a newer direct command discards an in-flight model request", async () => {
  const a = app();
  let complete;
  a.state.engine = { propose: () => new Promise((resolve) => { complete = resolve; }) };
  a.submitRequest({ text: "Please improve the navigation wording", ui: "bar" });
  await a.submitRequest({ text: "Rename Overview to Home", ui: "bar" });
  complete({ changes: [change("nav_overview", "Stale name")], raw: "stale" });
  await flush();
  assert.equal(a.state.els.get("nav_overview").text, "Home");
  assert.equal(a.state.busy, false);
  assert.equal(a.state.rounds.at(-1).cancelled, true);
});

test("an older queued request cannot overwrite a newer direct command", async () => {
  const a = app();
  let calls = 0;
  a.state.engine = { propose: async () => { calls++; return { changes: [] }; }, interrupt() {} };
  a.state.busy = true;
  a.submitRequest({ text: "Please improve navigation", ui: "bar" });
  await a.submitRequest({ text: "Rename Overview to Home", ui: "bar" });
  a.state.busy = false;
  a.maybeRunRound();
  await flush();
  assert.equal(calls, 0);
  assert.equal(a.state.els.get("nav_overview").text, "Home");
});

test("targeted model requests reject unrelated edits and do not retry", async () => {
  const a = app();
  let calls = 0;
  a.state.engine = { propose: async (ctx) => {
    calls++;
    assert.equal(ctx.elements.length, 1);
    assert.equal(ctx.recent.length, 0);
    return { changes: [change("nav_overview", "Home"), change("living.lede", "Unrelated")], raw: "test" };
  } };
  const req = { text: "Please improve the wording here", id: "nav_overview", ui: "bar" };
  a.submitRequest(req);
  await flush();
  assert.equal(calls, 1);
  assert.equal(a.state.changes.length, 0);
  assert.match(req.reply, /outside the requested element/);
  assert.equal(a.state.rounds[0].rejected.length, 1);
  for (const field of ["queueMs", "inferenceMs", "applyMs"]) assert.equal(typeof a.state.rounds[0][field], "number");
});

test("CSS validation blocks external resources in model requests", async () => {
  const a = app();
  a.state.engine = { propose: async () => ({ changes: [{ op: "style", id: "nav_overview", text: "background: url(https://example.com/image)" }], raw: "test" }) };
  a.submitRequest({ text: "Add a background image", id: "nav_overview", ui: "bar" });
  await flush();
  assert.equal(a.state.changes.length, 0);
  assert.equal(a.state.rounds[0].rejected[0].why, "external resources aren't allowed");
});

test("ambiguous names return choices and an explicit target resolves them", () => {
  const command = requests.parseCommand('Rename "Overview" to "Home"');
  const elements = [
    { id: "nav_overview", text: "Overview" },
    { id: "overview.title", text: "Overview", follows: "nav_overview" },
    { id: "another", text: "Overview" },
  ];
  assert.equal(requests.resolveCommand(command, elements).candidates.length, 2);
  assert.equal(requests.resolveCommand(command, elements, "another").changes[0].id, "another");
});

test("unknown names never fall through to a model guess", async () => {
  const a = app();
  const req = { text: "Rename Missing to Home", ui: "bar" };
  await a.submitRequest(req);
  assert.equal(a.state.changes.length, 0);
  assert.match(req.reply, /Choose an element/);
});

test("context commands apply multiple styles immediately and support Undo", async () => {
  const a = app();
  const req = { text: "make it bigger", id: "lr_dim", ui: "bar" };
  await a.submitRequest(req);
  assert.equal(a.state.els.get("lr_dim").style["font-size"], "20px");
  assert.equal(req.changes.length, 2);
  a.undoRequest(req);
  assert.equal(Object.keys(a.state.els.get("lr_dim").style).length, 0);
});

test("reading, help browsing and a single hesitation do not start inference", () => {
  for (const event of [{ type: "read", id: "nav_overview" }, { type: "help_open" }, { type: "hesitate", id: "nav_overview" }]) {
    const a = app();
    a.state.events.push(event);
    a.maybeRunRound();
    assert.equal(a.state.busy, false);
    assert.equal(a.state.rounds.length, 0);
  }
});

test("repeated use supplies evidence; successful action after hesitation ends that evidence", () => {
  assert.equal(requests.adaptationEvidence(Array.from({ length: 3 }, () => ({ type: "click", id: "lr_dim" }))), "lr_dim");
  assert.equal(requests.adaptationEvidence([{ type: "hesitate", id: "lr_dim" }, { type: "click", id: "lr_dim" }]), null);
});

test("automatic no-change is a normal outcome and unrelated edits are rejected", async () => {
  const a = app();
  a.state.events.push({ type: "hesitate", id: "nav_overview" }, { type: "hesitate", id: "nav_overview" });
  a.state.engine = { propose: async (ctx) => {
    assert.equal(ctx.elements.length, 1);
    return { changes: [], raw: "test" };
  } };
  await a.runRound();
  assert.equal(a.state.rounds[0].noChange, true);
  assert.equal(a.state.rounds[0].rejected.length, 0);
  a.state.engine.propose = async () => ({ changes: [change("living.lede", "Unrelated")], raw: "test" });
  await a.runRound();
  assert.equal(a.state.rounds[1].rejected[0].why, "unrelated to current evidence");
  assert.equal(a.state.proposals.length, 0);
});


test("an unchanged model proposal cannot claim it fulfilled a general request", async () => {
  const a = app();
  a.state.engine = { propose: async () => ({ changes: [change("living.lede", a.state.els.get("living.lede").text)], raw: "test" }) };
  const req = { text: "Please make the page easier to use", ui: "bar" };
  a.submitRequest(req);
  await flush();
  assert.match(req.reply, /No changes applied: same text/);
  assert.equal(a.state.changes.length, 0);
});

test("background results from a previous page are discarded", async () => {
  const a = app();
  let complete;
  a.state.events.push({ type: "hesitate", id: "nav_overview" }, { type: "hesitate", id: "nav_overview" });
  a.state.engine = { propose: () => new Promise((resolve) => { complete = resolve; }) };
  const running = a.runRound();
  a.state.view = "living";
  complete({ changes: [change("nav_overview", "Stale")], raw: "test" });
  await running;
  assert.equal(a.state.proposals.length, 0);
  assert.equal(a.state.rounds[0].cancelled, true);
});


test("automatic changes use operations supported by the evidence", async () => {
  const a = app();
  a.state.events.push(...Array.from({ length: 3 }, () => ({ type: "click", id: "lr_dim" })));
  a.state.engine = { propose: async (ctx) => {
    assert.deepEqual(Array.from(ctx.config.ops), ["move_first", "pin"]);
    return { changes: [{ op: "style", id: "lr_dim", text: "color: red" }], raw: "test" };
  } };
  await a.runRound();
  assert.equal(a.state.rounds[0].rejected[0].why, "operation does not fit the evidence");
  assert.equal(a.state.proposals.length, 0);
});

test("passive signals after repeated use do not hide evidence or cause extra rounds", async () => {
  const a = app();
  a.state.intensity = "balanced";
  a.state.lastActivity = -10000;
  a.state.lastRound = -10000;
  a.state.events.push(...Array.from({ length: 3 }, () => ({ type: "click", id: "lr_dim" })), { type: "hover", id: "lr_dim" });
  let calls = 0;
  a.state.engine = { propose: async () => { calls++; return { changes: [], raw: "test" }; } };
  a.maybeRunRound();
  await flush();
  assert.equal(calls, 1);
  a.state.lastActivity = -10000;
  a.state.lastRound = -10000;
  a.state.events.push({ type: "read", id: "overview.title" });
  a.maybeRunRound();
  await flush();
  assert.equal(calls, 1);
});


test("Extreme starts a round after a single interaction, but not ordinary hover", async () => {
  for (const type of ["click", "set", "nav", "hesitate", "select", "read", "help_open", "help_show", "hover"]) {
    const a = app();
    a.state.intensity = "extreme";
    let calls = 0;
    a.state.engine = { propose: async () => { calls++; return { changes: [], raw: "test" }; } };
    a.state.events.push({ type, id: "nav_overview", to: "overview", text: "Overview", label: "Overview", ms: 1000 });
    a.maybeRunRound();
    await flush();
    assert.equal(calls, type === "hover" ? 0 : 1, type);
    a.maybeRunRound();
    await flush();
    assert.equal(calls, type === "hover" ? 0 : 1, `no idle loop after ${type}`);
  }
});

test("Extreme allows relevant styles and nearby improvements with confirmation", async () => {
  const a = app();
  a.state.intensity = "extreme";
  a.state.events.push({ type: "click", id: "nav_overview" });
  a.state.engine = { propose: async (ctx) => {
    assert.ok(ctx.config.ops.includes("style"));
    assert.ok(ctx.elements.some((e) => e.id === "overview.title"));
    assert.ok(!ctx.elements.some((e) => e.id === "lr_dim"));
    return { changes: [{ op: "style", id: "overview.title", text: "font-size: 24px", reason: "Make the page heading easier to read" }], raw: "test" };
  } };
  a.maybeRunRound();
  await flush();
  assert.equal(a.state.proposals.length, 1);
  assert.equal(a.state.changes.length, 0);
  assert.equal(a.state.rounds[0].accepted.length, 1);
});

test("Extreme retains same-page results and processes newer interactions in the next round", async () => {
  const a = app();
  a.state.intensity = "extreme";
  let complete;
  let calls = 0;
  a.state.engine = { propose: (ctx) => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { complete = resolve; });
    assert.ok(!ctx.elements.some((e) => e.id === "overview.title"), "exclude waiting proposal");
    return Promise.resolve({ changes: [], raw: "test" });
  } };
  a.state.events.push({ type: "click", id: "nav_overview" });
  a.maybeRunRound();
  a.state.events.push({ type: "read", id: "overview.lede", text: "Welcome", ms: 1000 });
  a.maybeRunRound();
  assert.equal(calls, 1, "inference stays serial");
  complete({ changes: [change("overview.title", "Your home")], raw: "test" });
  await flush();
  assert.equal(a.state.proposals.length, 1);
  assert.notEqual(a.state.rounds[0].cancelled, true);
  a.maybeRunRound();
  await flush();
  assert.equal(calls, 2);
  a.maybeRunRound();
  await flush();
  assert.equal(calls, 2, "no extra round without a new interaction");
});

test("Extreme preserves requested names, enabled operations and the larger change limit", async () => {
  const a = app();
  a.state.intensity = "extreme";
  await a.submitRequest({ text: "Rename Overview to Home", ui: "bar" });
  a.state.els.get("nav_overview").changeCount = 9;
  assert.equal(a.validate({ op: "style", id: "nav_overview", text: "font-size: 18px" }), null);
  assert.equal(a.validate(change("nav_overview", "Dashboard")), "name set by the person");
  a.state.config.ops = ["hint"];
  a.state.events.push({ type: "click", id: "nav_overview" });
  a.state.engine = { propose: async (ctx) => {
    assert.deepEqual(Array.from(ctx.config.ops), ["hint"]);
    return { changes: [{ op: "style", id: "nav_overview", text: "color: red" }], raw: "test" };
  } };
  a.maybeRunRound();
  await flush();
  assert.equal(a.state.proposals.length, 0);
  assert.equal(a.state.rounds.at(-1).rejected[0].why, "operation does not fit the evidence");
});

test("Extreme respects Undo locks and discards results after navigating away", async () => {
  const a = app();
  a.state.intensity = "extreme";
  a.state.els.get("overview.title").frozen = true;
  a.state.events.push({ type: "read", id: "overview.title", text: "Overview", ms: 1000 });
  let complete;
  a.state.engine = { propose: (ctx) => {
    assert.ok(!ctx.elements.some((e) => e.id === "overview.title"));
    return new Promise((resolve) => { complete = resolve; });
  } };
  a.maybeRunRound();
  a.state.view = "living";
  complete({ changes: [change("overview.lede", "Outdated")], raw: "test" });
  await flush();
  assert.equal(a.state.proposals.length, 0);
  assert.equal(a.state.rounds[0].cancelled, true);
});

test("Extreme prompt actively seeks improvements without forcing invalid edits", () => {
  const prompt = adapters.buildSystemPrompt(adapters.DEFAULT_GUIDANCE, adapters.INTENSITIES.extreme, adapters.OPS);
  assert.match(prompt, /actively seek 1 useful improvement/);
  assert.match(prompt, /without waiting for repeated use/);
  assert.match(prompt, /Return no changes only when no useful valid improvement is available/);
  assert.equal(adapters.INTENSITIES.extreme.perControl, 100);
});


test("heading rename updates navigation and an open help article; Undo restores all three", () => {
  const a = app(true);
  a.state.helpOpen = true;
  a.state.helpArticle = "movie";
  const entry = a.apply(change("overview.title", "Hearth"));
  // Exercise the real render path through Undo and the normal request path below.
  a.renderHelp();
  assert.equal(a.state.els.get("nav_overview").text, "Hearth");
  assert.equal(a.displayText(a.state.els.get("overview.title")), "Hearth");
  assert.equal(a.pageName("overview"), "Hearth");
  assert.match(a.nodes.get("help-body").innerHTML, /data-ref="nav_overview"[^>]*>Hearth<\/button>/);
  assert.match(a.nodes.get("help-body").innerHTML, /formerly “Overview”/);
  a.undo(entry.n);
  assert.equal(a.state.els.get("nav_overview").text, "Overview");
  assert.equal(a.displayText(a.state.els.get("overview.title")), "Overview");
  assert.match(a.nodes.get("app").innerHTML, /data-id="overview.title"[^>]*>Overview<\/h1>/);
  assert.match(a.nodes.get("help-body").innerHTML, /data-ref="nav_overview"[^>]*>Overview<\/button>/);
  assert.equal(a.validate(change("nav_overview", "Dashboard")), "locked after undo");
});

test("a heading request refreshes open help and protects the matching nav name", async () => {
  const a = app(true);
  a.state.helpOpen = true;
  a.state.helpArticle = "movie";
  const req = { text: "call it Home", id: "overview.title", ui: "bar" };
  await a.submitRequest(req);
  assert.equal(req.changes.length, 1);
  assert.match(a.nodes.get("app").innerHTML, /data-id="overview.title"[^>]*>Home<\/h1>/);
  assert.match(a.nodes.get("help-body").innerHTML, /data-ref="nav_overview"[^>]*>Home<\/button>/);
  assert.equal(a.validate(change("nav_overview", "Dashboard")), "name set by the person");
  assert.equal(a.validate(change("overview.title", "Dashboard")), "name set by the person");
});

test("help search finds both current and old page names after a heading rename", () => {
  const a = app();
  a.apply(change("overview.title", "Hearth"));
  a.state.helpOpen = true;
  a.state.helpArticle = null;
  for (const query of ["Hearth", "Overview"]) {
    // renderHelp creates its search node on the first call.
    a.renderHelp();
    a.nodes.get("help-search").value = query;
    a.renderHelp();
    assert.match(a.nodes.get("help-body").innerHTML, /Start a movie night/);
  }
  assert.ok(a.aliases("nav_overview").includes("Hearth"));
  assert.ok(a.aliases("nav_overview").includes("Overview"));
});

test("legacy saved heading-only renames migrate into the shared page name", () => {
  const a = app();
  const els = a.buildElements("home", { elements: { "overview.title": { text: "Hearth" } } });
  assert.equal(els.get("nav_overview").text, "Hearth");
  assert.equal(els.get("overview.title").text, null);
});

test("a page rename is one logical field for duplicate plans and declined proposals", async () => {
  const a = app();
  assert.equal(a.proposalKey(change("nav_overview", "Home")), a.proposalKey(change("overview.title", "Home")));
  a.state.declined.add(a.proposalKey(change("overview.title", "Home")));
  assert.equal(a.validate(change("nav_overview", "Home")), "the person declined this exact change");
  a.state.engine = { propose: async () => ({ changes: [change("overview.title", "Home"), change("nav_overview", "Dashboard")], raw: "test" }) };
  const req = { text: "Please improve the page name", ui: "bar" };
  a.submitRequest(req);
  await flush();
  assert.equal(a.state.changes.length, 0);
  assert.match(req.reply, /conflicting edits to the same field/);
});

test("heading styles remain independent of navigation styles", () => {
  const a = app();
  a.apply({ op: "style", id: "overview.title", text: "font-size: 24px" });
  assert.equal(a.state.els.get("overview.title").style["font-size"], "24px");
  assert.equal(a.state.els.get("nav_overview").style["font-size"], undefined);
  assert.equal(a.state.els.get("nav_overview").text, "Overview");
});


test("automatic scheduling combines a 200 ms burst and pauses when confirmations are full", async () => {
  let time = 100;
  const a = app(false, { now: () => time });
  a.state.intensity = "extreme";
  let calls = 0;
  a.state.engine = { propose: async () => { calls++; return { changes: [], raw: "test" }; } };
  a.log("click", { id: "nav_overview" });
  time = 200;
  a.log("read", { id: "overview.title", text: "Overview", ms: 1000 });
  a.maybeRunRound();
  assert.equal(calls, 0);
  assert.equal(a.state.adaptDueAt, 300, "continuous input cannot postpone the window forever");
  time = 300;
  a.maybeRunRound();
  await flush();
  assert.equal(calls, 1);
  a.state.proposals.push(change("overview.title", "Home"), change("overview.lede", "Welcome"), change("overview.row0", "Door locked"));
  a.log("click", { id: "sc_movie" });
  time = 600;
  a.maybeRunRound();
  assert.equal(calls, 1);
  a.state.proposals.pop();
  a.maybeRunRound();
  await flush();
  assert.equal(calls, 2, "latest activity is retained while the queue is full");
});

test("model schema IDs stay stable across page navigation", () => {
  const a = app();
  const before = JSON.stringify(a.buildContext().schemaElements);
  a.state.view = "living";
  assert.equal(JSON.stringify(a.buildContext().schemaElements), before);
});

test("the smallest model uses at most six targets and cannot rename automatically", async () => {
  const a = app();
  a.state.engineKey = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
  a.state.intensity = "extreme";
  a.state.events.push({ type: "click", id: "sc_movie" });
  a.state.engine = { propose: async (ctx) => {
    assert.ok(ctx.elements.length <= 6);
    assert.equal(ctx.elements[0].id, "sc_movie");
    assert.ok(!ctx.config.ops.includes("text"));
    assert.equal(ctx.level.perRound, 1);
    return { changes: [change("overview.title", "Hearth")], raw: "test" };
  } };
  a.maybeRunRound();
  await flush();
  assert.equal(a.state.proposals.length, 0);
  const req = { text: "Rename Overview to Home", ui: "bar" };
  await a.submitRequest(req);
  assert.equal(a.state.els.get("nav_overview").text, "Home");
});

test("automatic styling stays moderate and explicit styling retains the full surface", () => {
  const a = app();
  assert.equal(a.validate({ op: "style", id: "nav_overview", text: "display: none" }), "automatic styles must use moderate readability or highlight changes");
  assert.equal(a.validate({ op: "style", id: "nav_overview", text: "font-size: 100px" }), "automatic styles must use moderate readability or highlight changes");
  assert.equal(a.validate({ op: "style", id: "nav_overview", text: "font-size: 20px" }), null);
  assert.equal(a.validate({ op: "style", id: "nav_overview", text: "font-size: 100px" }, { explicit: true }), null);
  assert.equal(a.validate(change("overview.title", "Hearth")), "a page name must describe the page, not the app");
});
