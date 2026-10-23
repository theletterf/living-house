import { DEFAULT_GUIDANCE, ENGINES, INTENSITIES, OPS, buildSystemPrompt, describeEvent, loadEngine } from "./adapters.js";
import { DEFAULT_SCENARIO, SCENARIOS } from "./scenarios.js";

const MAX_PINS = 4;
const MODEL_EVENTS = new Set(["hover", "hesitate", "click", "set", "nav", "select", "read"]);
// At "Max" each of these starts a round. A plain hover is context, not an action.
const ACTION_EVENTS = new Set(["hesitate", "click", "set", "nav", "select", "read"]);
// What the model sees as recent activity: the signals plus the person's answers
// to proposed changes and their own requests (neither can be switched off).
const CONTEXT_EVENTS = new Set([...MODEL_EVENTS, "decision", "request"]);
const MAX_PROPOSALS = 3; // confirmations waiting at once; older ones expire
const CONTROL_KINDS = new Set(["nav", "action", "toggle", "slider", "stepper"]);
const PINNABLE = new Set(["action", "toggle"]);

// "Settled": when to suggest ending the session.
const SETTLED_OUTCOMES = 5;   // look at this many recent suggestion outcomes…
const SETTLED_NEGATIVE = 4;   // …and suggest ending if this many went badly
const CALM_MIN_ACTIONS = 10;  // a calm stretch only counts with real use in it

// A kept layout is what differs from the original in these fields, per element.
const LAYOUT_FIELDS = ["text", "style", "hint", "order", "pinned", "pinnedAt"];
const layoutKey = (scenario) => `living-house:layout:${scenario}`;

// Browser storage can be unavailable (private mode, blocked site data).
function loadLayout(scenario) {
  try {
    return JSON.parse(localStorage.getItem(layoutKey(scenario)) ?? "null");
  } catch {
    return null;
  }
}

const OP_LABELS = {
  text: "Change any text",
  style: "Restyle anything (any CSS)",
  hint: "Add hints",
  move_first: "Move controls first",
  pin: "Pin to Quick actions",
};

// Signals the model can observe; each can be switched off in the setup.
const SIGNALS = {
  click: "Clicks and control changes",
  nav: "Page changes",
  hover: "Hovering over controls",
  hesitate_control: "Hesitating on a control",
  hesitate_page: "Hesitating on a page",
  select: "Selecting text",
  read: "Pointing at text",
};
const signalOf = (type, data) =>
  type === "hesitate" ? (data.id ? "hesitate_control" : "hesitate_page") : type === "set" ? "click" : type;

const defaultConfig = () => ({
  scenario: DEFAULT_SCENARIO,
  base: "saved",       // start from the kept layout when there is one
  suggestEnd: true,
  calmMs: 180000,      // friction-free use before suggesting the session has settled
  prompt: DEFAULT_GUIDANCE,
  ops: [...OPS],
  signals: Object.keys(SIGNALS),
  hesitateMs: 1500,    // dwelling on a control this long without clicking = confusion
  pageHesitateMs: 3000, // doing nothing on a page this long = confusion
  readMs: 600,         // pointing at text this long counts as reading it
  temperature: 0.2,
});

// Elements every scenario has. The pages and controls come from scenarios.js.
const GLOBALS = [
  { id: "app", kind: "box", desc: "The whole app frame" },
  { id: "header", kind: "box", desc: "Top bar of the app" },
  { id: "brand", kind: "text", desc: "App name in the top bar" },
  { id: "quick", kind: "box", desc: "Quick actions bar in the top bar, shown once something is pinned" },
  { id: "quick_label", kind: "text", text: "Quick actions", desc: "Label of the Quick actions bar" },
  { id: "sidebar", kind: "box", desc: "Left navigation sidebar" },
  { id: "main", kind: "box", desc: "Main content area" },
];

// ---------- state ----------

const state = {
  scenario: DEFAULT_SCENARIO,
  view: null,
  els: new Map(),
  events: [],
  sessionStart: 0,  // the adapter never sees events from before the last "Start over"
  windowStart: 0,   // events before this index were already shown to the adapter
  changes: [],
  pending: [],      // validated changes waiting for a safe moment to apply
  proposals: [],    // validated changes waiting for the person to confirm them
  requests: [],     // the person's own requests waiting for the model
  preferences: [],  // everything the person asked for this session
  declined: new Set(),
  request: null,    // the open "Change this" popover: { id, req }
  barRequest: null, // the latest request made in the ask bar
  askFirst: true,
  modalOpen: false,
  ended: false,
  sessionBeganAt: 0,
  endedAt: 0,
  baseInUse: "original", // the layout this session started from
  settledOpen: false,
  settledSnoozedAt: 0,   // "Keep going" restarts the settled detector from here
  lastSettledCheck: 0,
  rounds: [],
  adaptive: true,
  intensity: "max",
  engine: null,
  engineKey: null,
  busy: false,
  requestBusy: false,
  loading: false,
  lastRound: 0,
  lastActivity: 0,
  pageHesitated: false,
  lastSelection: "",
  pointer: { x: -1, y: -1, down: false, inApp: false, enteredApp: 0 },
  hover: null,
  flashUntil: new Map(),
  status: "",
  config: defaultConfig(),
  draft: null,       // the config being edited in the setup
  configVersion: 0,
  setupOpen: true,
  everStarted: false,
};

const hasGPU = "gpu" in navigator;
const $ = (id) => document.getElementById(id);
const $app = $("app");
const now = () => Math.round(performance.now());
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
const level = () => INTENSITIES[state.intensity];
const S = () => SCENARIOS[state.scenario];
const firstPage = () => Object.keys(S().pages)[0];

// The element registry for a scenario, optionally with a kept layout on top.
function buildElements(scenario, saved = null) {
  const sc = SCENARIOS[scenario];
  const els = new Map();
  const add = (el) => els.set(el.id, {
    text: null, page: "all", style: {}, hint: null, pinned: false, pinnedAt: 0,
    frozen: false, adapted: false, adaptReason: null, changeCount: 0, ...el,
  });
  for (const g of GLOBALS) add(g.id === "brand" ? { ...g, text: sc.brand } : g);
  for (const [p, page] of Object.entries(sc.pages)) {
    add({ id: `${p}.title`, kind: "text", page: p, desc: "Page heading" });
    add({ id: `${p}.lede`, kind: "text", page: p, text: page.lede, desc: "Intro line under the heading" });
    add({ id: `${p}.toolbar`, kind: "box", page: p, desc: "Area holding this page's controls" });
    add({ id: `${p}.rows`, kind: "box", page: p, desc: "List of items on this page" });
    page.rows.forEach((text, i) => add({ id: `${p}.row${i}`, kind: "text", page: p, text, desc: "Item in this page's list" }));
  }
  const orderByView = {};
  for (const c of sc.controls) {
    const order = (orderByView[c.view] = (orderByView[c.view] ?? -1) + 1);
    add({ ...c, kind: c.kind ?? (c.view === "nav" ? "nav" : "action"), page: c.view === "nav" ? "all" : c.view, order });
  }
  for (const [id, fields] of Object.entries(saved?.elements ?? {})) {
    if (els.has(id)) Object.assign(els.get(id), structuredClone(fields));
  }
  return els;
}

const effectiveBase = (cfg, scenario) => (cfg.base === "saved" && loadLayout(scenario) ? "saved" : "original");

function seed() {
  state.baseInUse = effectiveBase(state.config, state.scenario);
  state.els = buildElements(state.scenario, state.baseInUse === "saved" ? loadLayout(state.scenario) : null);
}

// Keep the current layout for next time: only what differs from the original.
function saveLayout() {
  const original = buildElements(state.scenario);
  const elements = {};
  for (const [id, el] of state.els) {
    const o = original.get(id);
    if (o && LAYOUT_FIELDS.some((f) => JSON.stringify(el[f]) !== JSON.stringify(o[f]))) {
      elements[id] = Object.fromEntries(LAYOUT_FIELDS.map((f) => [f, el[f]]));
    }
  }
  const count = Object.keys(elements).length;
  if (!count) {
    toast("Nothing differs from the original, so there's nothing to keep.");
    return;
  }
  try {
    localStorage.setItem(layoutKey(state.scenario), JSON.stringify({ savedAt: Date.now(), count, elements }));
  } catch {
    toast("This browser won't let the page save the layout.");
    return;
  }
  log("layout_saved", { scenario: state.scenario, count });
  toast(`Layout kept. The ${S().noun} will start like this next time.`);
}

const isControl = (el) => CONTROL_KINDS.has(el.kind);
const controls = () => [...state.els.values()].filter(isControl);
const siblings = (c) => controls().filter((s) => s.view === c.view);
const toolbar = (view) => controls().filter((c) => c.view === view).sort((a, b) => a.order - b.order);
const navFor = (page) => controls().find((c) => c.to === page);
// A page heading follows its nav label until it is changed itself.
const displayText = (el) => (el.kind === "box" ? null : el.text ?? navFor(el.page).text);
const labelOf = (el) => displayText(el) ?? el.desc;
const cssText = (style) => Object.entries(style).map(([k, v]) => `${k}: ${v}`).join("; ");
const pageName = (page) => (page === "all" ? "Everywhere" : S().controls.find((c) => c.to === page)?.text ?? page);

function valueText(c) {
  if (c.kind === "toggle") return c.states ? c.states[c.value ? 1 : 0] : c.value ? "On" : "Off";
  if (c.kind === "slider" || c.kind === "stepper") return `${+c.value.toFixed(1)}${c.unit}`;
  return null;
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

function log(type, data = {}) {
  // Signals switched off in the setup are not observed at all.
  if (MODEL_EVENTS.has(type) && !state.config.signals.includes(signalOf(type, data))) return null;
  const e = { t: now(), type, view: state.view, ...data };
  state.events.push(e);
  if (MODEL_EVENTS.has(type)) {
    state.lastActivity = e.t;
    // Anything but the page-level hesitation itself ends that hesitation.
    if (!(type === "hesitate" && !e.id)) state.pageHesitated = false;
  }
  if (ACTION_EVENTS.has(type)) setTimeout(maybeRunRound, 0);
  renderActivity();
  return e;
}

// ---------- rendering the app ----------

const styleAttr = (el) => (Object.keys(el.style).length ? ` style="${esc(cssText(el.style))}"` : "");
const titleAttr = (el) => (el.adaptReason ? ` title="Adapted: ${esc(el.adaptReason)}"` : "");
const box = (id) => {
  const el = state.els.get(id);
  return `data-id="${id}"${styleAttr(el)}${titleAttr(el)}`;
};
const textAttrs = (id) => `${box(id)} data-text="${id}"`;
const textOf = (id) => esc(displayText(state.els.get(id)));

function controlHTML(c, where = "toolbar") {
  const cls = ["btn", c.kind, where === "quick" && "quick", c.adapted && "adapted",
    c.kind === "nav" && c.to === state.view && "current", c.kind === "toggle" && c.value && "on"].filter(Boolean).join(" ");
  const attrs = `data-id="${c.id}" data-control data-where="${where}" class="${cls}"${styleAttr(c)}${titleAttr(c)}`;
  const label = esc(c.text);
  const value = esc(valueText(c) ?? "");
  switch (c.kind) {
    case "toggle":
      return `<button ${attrs} role="switch" aria-checked="${c.value}"><span class="switch" aria-hidden="true"></span><span>${label}</span><span class="state">${value}</span></button>`;
    case "slider":
      return `<div ${attrs}><span class="ctl-label">${label}</span><input type="range" data-slider="${c.id}" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.value}" aria-label="${label}"><output class="state">${value}</output></div>`;
    case "stepper":
      return `<div ${attrs}><span class="ctl-label">${label}</span><button type="button" data-step="-1" aria-label="Lower ${label}">−</button><output class="state">${value}</output><button type="button" data-step="1" aria-label="Raise ${label}">+</button></div>`;
    default:
      return `<button ${attrs}>${label}</button>`;
  }
}

const control = (c) => `<div class="ctl">${controlHTML(c)}${c.hint ? `<span class="hint" data-text="hint:${c.id}">${esc(c.hint)}</span>` : ""}</div>`;

// Re-rendering replaces the DOM, which would drop a text selection. Text
// elements are keyed by data-text, so the selection can be put back.
function saveSelection() {
  const sel = getSelection();
  if (sel.isCollapsed || !$app.contains(sel.anchorNode)) return null;
  const point = (node, offset) => {
    const key = node.nodeType === Node.TEXT_NODE && node.parentElement.closest("[data-text]")?.dataset.text;
    return key ? { key, offset } : null;
  };
  const anchor = point(sel.anchorNode, sel.anchorOffset);
  const focus = point(sel.focusNode, sel.focusOffset);
  return anchor && focus ? { view: state.view, anchor, focus } : null;
}

function restoreSelection(saved) {
  if (!saved || saved.view !== state.view) return;
  const find = ({ key, offset }) => {
    const node = $app.querySelector(`[data-text="${key}"]`)?.firstChild;
    return node?.nodeType === Node.TEXT_NODE ? [node, Math.min(offset, node.length)] : null;
  };
  const anchor = find(saved.anchor);
  const focus = find(saved.focus);
  if (anchor && focus) getSelection().setBaseAndExtent(...anchor, ...focus);
}

function render() {
  const selection = saveSelection();
  const p = state.view;
  const app = state.els.get("app");
  $app.dataset.id = "app";
  $app.setAttribute("style", cssText(app.style));
  if (app.adaptReason) $app.title = `Adapted: ${app.adaptReason}`;
  else $app.removeAttribute("title");

  const pinned = controls().filter((c) => c.pinned).sort((a, b) => a.pinnedAt - b.pinnedAt);
  $app.innerHTML = `
    <header class="app-top" ${box("header")}>
      <span class="brand" ${textAttrs("brand")}>${textOf("brand")}</span>
      <div class="quick" data-toolbar="quick" ${box("quick")}>
        ${pinned.length ? `<span class="quick-label" ${textAttrs("quick_label")}>${textOf("quick_label")}</span>${pinned.map((c) => controlHTML(c, "quick")).join("")}` : ""}
      </div>
    </header>
    <nav class="app-nav" data-toolbar="nav" ${box("sidebar")}>${toolbar("nav").map(control).join("")}</nav>
    <main class="app-main" ${box("main")}>
      <h1 ${textAttrs(`${p}.title`)}>${textOf(`${p}.title`)}</h1>
      <p class="lede" ${textAttrs(`${p}.lede`)}>${textOf(`${p}.lede`)}</p>
      <div class="toolbar" data-toolbar="${p}" ${box(`${p}.toolbar`)}>${toolbar(p).map(control).join("")}</div>
      <ul class="rows" ${box(`${p}.rows`)}>${S().pages[p].rows.map((_, i) => `<li ${textAttrs(`${p}.row${i}`)}>${textOf(`${p}.row${i}`)}</li>`).join("")}</ul>
    </main>`;

  const t = now();
  for (const [id, until] of state.flashUntil) {
    if (until > t) for (const node of document.querySelectorAll(`[data-id="${id}"]`)) node.classList.add("flash");
  }
  restoreSelection(selection);
  // Popover wording ("On the … page") and anchors depend on the page shown.
  renderConfirm();
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------- user input ----------

$app.addEventListener("click", (ev) => {
  const host = ev.target.closest("[data-control]");
  if (!host) return;
  const c = state.els.get(host.dataset.id);
  endHover();

  const step = ev.target.closest("[data-step]");
  if (step) return setValue(c, c.value + Number(step.dataset.step) * c.step);
  if (c.kind === "slider" || c.kind === "stepper") return; // handled by their own inputs

  if (c.kind === "nav") {
    log("nav", { id: c.id, label: c.text, to: c.to });
    state.view = c.to;
    render();
    return;
  }
  if (c.kind === "toggle") return setValue(c, !c.value);

  log("click", { id: c.id, label: c.text, via: host.dataset.where });
  if (c.effects) {
    for (const [id, value] of Object.entries(c.effects)) {
      const device = state.els.get(id);
      if (device) device.value = value;
    }
    render();
    toast(`${c.text}: ${c.desc.replace(/^Scene: /, "")}`);
  } else {
    toast(c.desc);
  }
});

function setValue(c, raw) {
  const value = c.kind === "toggle" ? Boolean(raw) : Math.min(c.max, Math.max(c.min, Math.round(raw / c.step) * c.step));
  if (value === c.value) return;
  c.value = value;
  log("set", { id: c.id, label: c.text, value: valueText(c) });
  render();
}

// Sliders show their value while dragging and commit on release.
$app.addEventListener("input", (ev) => {
  const range = ev.target.closest("[data-slider]");
  if (!range) return;
  const c = state.els.get(range.dataset.slider);
  range.parentElement.querySelector("output").textContent = valueText({ ...c, value: Number(range.value) });
});
$app.addEventListener("change", (ev) => {
  const range = ev.target.closest("[data-slider]");
  if (range) setValue(state.els.get(range.dataset.slider), Number(range.value));
});

// Hover targets are controls and text.
const HOVER_TARGET = "[data-control], [data-text]";

$app.addEventListener("pointerover", (ev) => {
  const el = ev.target.closest(HOVER_TARGET);
  const isCtl = el?.hasAttribute("data-control");
  const key = el && (isCtl ? el.dataset.id : `text:${el.dataset.text}`);
  if (key === state.hover?.key) return;
  endHover();
  if (el) {
    state.hover = {
      key,
      control: isCtl,
      id: isCtl ? el.dataset.id : el.dataset.text,
      text: isCtl ? null : el.textContent.trim().slice(0, 80),
      t: now(),
      dwellChecked: false,
      hesitated: false,
    };
  }
});

$app.addEventListener("pointerout", (ev) => {
  const from = ev.target.closest(HOVER_TARGET);
  if (from && !from.contains(ev.relatedTarget)) endHover();
});

function endHover() {
  const h = state.hover;
  if (!h) return;
  state.hover = null;
  const ms = now() - h.t;
  if (h.control) {
    // A hesitation was already logged live from tick(); don't double count.
    const c = state.els.get(h.id);
    if (c && !h.hesitated && ms >= 300) log("hover", { id: c.id, label: c.text, ms });
  } else if (ms >= state.config.readMs) {
    log("read", { id: h.id, text: h.text, ms });
  }
}

function selectionInApp() {
  const sel = getSelection();
  return !sel.isCollapsed && $app.contains(sel.anchorNode);
}

function logSelection() {
  const sel = getSelection();
  const text = sel.toString().trim().replace(/\s+/g, " ");
  if (!text || !selectionInApp()) {
    state.lastSelection = "";
    return;
  }
  if (text.length < 2 || text === state.lastSelection) return;
  state.lastSelection = text;
  const host = (n) => (n?.nodeType === Node.TEXT_NODE ? n.parentElement : n)?.closest("[data-text]")?.dataset.text;
  const id = host(sel.anchorNode) === host(sel.focusNode) ? host(sel.anchorNode) : null;
  log("select", { id, text: text.slice(0, 80) });
}

// Right-click (or long-press) any element to ask for a change to it.
$app.addEventListener("contextmenu", (ev) => {
  if (!canRequest()) return;
  const el = ev.target.closest("[data-id]");
  if (!el) return;
  ev.preventDefault();
  endHover();
  openRequest(el.dataset.id);
});

$app.addEventListener("pointerup", () => setTimeout(logSelection, 0));
$app.addEventListener("pointerenter", () => Object.assign(state.pointer, { inApp: true, enteredApp: now() }));
$app.addEventListener("pointerleave", () => { state.pointer.inApp = false; endHover(); });
document.addEventListener("pointermove", (ev) => Object.assign(state.pointer, { x: ev.clientX, y: ev.clientY }));
document.addEventListener("pointerdown", () => (state.pointer.down = true));
document.addEventListener("pointerup", () => {
  state.pointer.down = false;
  // Dragging a slider isn't hesitating: restart the dwell clock on release.
  if (state.hover) state.hover.t = now();
});
document.documentElement.addEventListener("pointerleave", () => Object.assign(state.pointer, { x: -1, y: -1 }));

// Hesitation is logged while it happens, so the adapter can react before the
// person gives up and moves on.
function detectHesitation(t) {
  const h = state.hover;
  if (h?.control && !h.dwellChecked && !state.pointer.down && t - h.t >= state.config.hesitateMs) {
    h.dwellChecked = true;
    const c = state.els.get(h.id);
    h.hesitated = Boolean(log("hesitate", { id: c.id, label: c.text, ms: t - h.t }));
  }
  const since = Math.max(state.lastActivity, state.pointer.enteredApp);
  if (!h && state.pointer.inApp && !state.pageHesitated && t - since >= state.config.pageHesitateMs) {
    state.pageHesitated = true;
    log("hesitate", { id: null, page: state.view, ms: t - since });
  }
}

// ---------- adaptation ----------

function buildContext() {
  const recent = state.events.slice(state.sessionStart).filter((e) => CONTEXT_EVENTS.has(e.type)).slice(-60);
  const stats = new Map();
  for (const e of recent) {
    if (!e.id) continue;
    const s = stats.get(e.id) ?? { hoverMs: 0, hesitations: 0, clicks: 0 };
    if (e.type === "hover") s.hoverMs += e.ms;
    else if (e.type === "hesitate") { s.hoverMs += e.ms; s.hesitations++; }
    else if (e.type === "click" || e.type === "set" || e.type === "nav") s.clicks++;
    stats.set(e.id, s);
  }
  // Global elements, the current page's texts and containers, and every control.
  const p = state.view;
  const ids = [
    ...GLOBALS.map((g) => g.id),
    `${p}.title`, `${p}.lede`, `${p}.toolbar`, `${p}.rows`,
    ...S().pages[p].rows.map((_, i) => `${p}.row${i}`),
    ...["nav", ...Object.keys(S().pages)].flatMap((v) => toolbar(v).map((c) => c.id)),
  ];
  const elements = ids.map((id) => {
    const el = state.els.get(id);
    return {
      id, kind: el.kind, page: el.page, text: displayText(el), desc: el.desc, value: valueText(el), css: cssText(el.style),
      pinned: el.pinned, hint: el.hint,
      // Locked elements are hidden from the model and from its output schema.
      locked: el.frozen || el.changeCount >= level().perControl,
      hoverMs: 0, hesitations: 0, clicks: 0, ...stats.get(id),
    };
  });
  return {
    level: level(), config: state.config, about: S().about, view: p, elements,
    recent: recent.slice(-20), preferences: state.preferences.slice(-6),
  };
}

async function runRound() {
  state.busy = true;
  const ctx = buildContext();
  state.windowStart = state.events.length;
  const t0 = now();
  const round = { at: t0, kind: "adapt", engine: state.engineKey, intensity: state.intensity, configVersion: state.configVersion, attempts: 0, raw: [], accepted: [], rejected: [] };
  try {
    // At "Max" a round must change something: if every proposal is rejected,
    // ask once more, telling the model why.
    const tries = ctx.level.always ? 2 : 1;
    while (round.attempts < tries && !round.accepted.length) {
      round.attempts++;
      const res = await state.engine.propose({ ...ctx, rejected: round.rejected });
      round.raw.push(res.raw);
      round.usage = res.usage;
      const seen = new Set([...state.pending, ...state.proposals].map((p) => p.id));
      for (const ch of res.changes.slice(0, ctx.level.perRound)) {
        const why = seen.has(ch?.id) ? "already changing this round" : validate(ch);
        if (why) {
          round.rejected.push({ ...ch, why });
        } else {
          seen.add(ch.id);
          round.accepted.push(ch);
          queueChange(ch);
        }
      }
      if (!res.changes.length) round.rejected.push({ op: "none", id: "-", why: "no change proposed" });
    }
  } catch (err) {
    round.error = String(err?.message ?? err);
  } finally {
    finishRound(round, t0);
  }
}

function finishRound(round, t0) {
  round.latencyMs = now() - t0;
  state.rounds.push(round);
  log("round", { kind: round.kind, engine: round.engine, latencyMs: round.latencyMs, attempts: round.attempts, accepted: round.accepted.length, rejected: round.rejected.length, error: round.error });
  state.busy = false;
  state.lastRound = now();
  // Anything that arrived while the model was busy gets its own round.
  setTimeout(maybeRunRound, 0);
}

function maybeRunRound() {
  if (!state.everStarted || state.setupOpen || state.modalOpen || state.ended) return;
  if (!state.engine || state.busy || state.loading) return;
  // The person's own requests come first and work even with adaptation off.
  if (state.requests.length) return runRequest(state.requests.shift());
  if (!state.adaptive) return;
  const lvl = level();
  const fresh = state.events.slice(state.windowStart);
  const t = now();
  const due = lvl.trigger === "action"
    ? fresh.some((e) => ACTION_EVENTS.has(e.type))
    : fresh.some((e) => MODEL_EVENTS.has(e.type)) && t - state.lastActivity > lvl.idleMs && t - state.lastRound > lvl.minGapMs;
  if (due) runRound();
}

// "color: red; border: 1px solid red" -> [["color", "red"], ["border", "1px solid red"]],
// or a string saying what is wrong. An empty value means "remove this property".
function parseDeclarations(text) {
  const decls = [];
  for (const part of text.split(";")) {
    if (!part.trim()) continue;
    const i = part.indexOf(":");
    if (i < 0) return `"${part.trim()}" isn't a CSS declaration`;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim().replace(/\s*!important$/i, "");
    if (!/^-?[a-z][a-z0-9-]*$/.test(prop)) return `"${prop}" isn't a CSS property`;
    // Nothing may load from outside the page.
    if (/url\s*\(|image-set\s*\(|@import|expression\s*\(|javascript:/i.test(value)) return "external resources aren't allowed";
    if (value && !CSS.supports(prop, value)) return `"${prop}: ${value}" isn't valid CSS`;
    decls.push([prop, value]);
  }
  return decls.length ? decls : "no CSS declarations";
}

// Explicit requests skip the soft limits (locks, caps, earlier declines) but
// never the checks that keep a change valid and safe.
function validate(ch, { explicit = false } = {}) {
  const el = state.els.get(ch?.id);
  if (!el) return "unknown element";
  if (!state.config.ops.includes(ch.op)) return "change type turned off";
  const text = typeof ch.text === "string" ? ch.text.trim() : "";
  if (!explicit) {
    if (el.frozen) return "locked after undo";
    if (el.changeCount >= level().perControl) return "changed too often";
    if (state.declined.has(proposalKey(ch))) return "the person declined this exact change";
  }
  switch (ch.op) {
    case "text": {
      if (el.kind === "box") return "this element has no text";
      const max = isControl(el) ? 24 : 120;
      if (!text || text.length > max) return `text empty or longer than ${max}`;
      if (text === displayText(el)) return "same text";
      return null;
    }
    case "style": {
      const decls = parseDeclarations(text);
      if (typeof decls === "string") return decls;
      if (decls.every(([p, v]) => (el.style[p] ?? "") === v)) return "same style";
      return null;
    }
    case "hint":
      if (!isControl(el)) return "hints go on controls";
      if (!text || text.length > 48) return "hint empty or too long";
      if (text === el.hint) return "same hint";
      return null;
    case "move_first":
      if (!isControl(el)) return "only controls can be moved";
      if (el.order === Math.min(...siblings(el).map((s) => s.order))) return "already first";
      return null;
    case "pin":
      if (!PINNABLE.has(el.kind)) return "only actions and switches can be pinned";
      if (el.pinned) return "already pinned";
      if (controls().filter((s) => s.pinned).length >= MAX_PINS) return "quick bar full";
      return null;
    default:
      return "unknown op";
  }
}

// ---------- requests: the person asks for a change ----------

const canRequest = () => Boolean(state.engine) && state.everStarted && !state.setupOpen && !state.modalOpen && !state.ended;

function openRequest(id) {
  const el = state.els.get(id);
  state.request = { id, req: null };
  const value = valueText(el);
  $("request-target").textContent = `${labelOf(el)}${value ? ` · ${value}` : ""}`;
  $("request-input").value = "";
  $("request-form").hidden = false;
  $("request-result").hidden = true;
  $("request").hidden = false;
  renderConfirm();
  $("request-input").focus();
}

function closeRequest() {
  state.request = null;
  $("request").hidden = true;
  renderConfirm();
}

function submitRequest(req) {
  if (!canRequest()) return;
  req.phase = "working";
  req.changes = [];
  if (req.ui === "popover" && state.request) state.request.req = req;
  else state.barRequest = req;
  state.preferences.push({ text: req.text, id: req.id });
  log("request", { id: req.id, text: req.text, via: req.ui });
  state.requests.push(req);
  renderRequestFeedback(req);
  maybeRunRound();
}

async function runRequest(req) {
  state.busy = true;
  state.requestBusy = true;
  // A direct request can touch anything, including locked elements.
  const base = buildContext();
  const ctx = { ...base, elements: base.elements.map((e) => ({ ...e, locked: false })), request: { text: req.text, id: req.id } };
  const t0 = now();
  const round = { at: t0, kind: "request", request: req.text, target: req.id, engine: state.engineKey, configVersion: state.configVersion, attempts: 0, raw: [], accepted: [], rejected: [] };
  let reply = "";
  let modelDeclined = false;
  try {
    while (round.attempts < 2 && !req.changes.length) {
      round.attempts++;
      const res = await state.engine.propose({ ...ctx, rejected: round.rejected });
      round.raw.push(res.raw);
      round.usage = res.usage;
      reply = res.reply;
      modelDeclined = !res.changes.length;
      for (const ch of res.changes) {
        const why = validate(ch, { explicit: true });
        if (why) {
          round.rejected.push({ ...ch, why });
        } else {
          round.accepted.push(ch);
          req.changes.push(apply(ch, { requested: req.text }).n);
        }
      }
      // An empty answer is the model saying it can't; its reply says why.
      if (modelDeclined) break;
    }
    if (req.changes.length) {
      render();
      renderChanges();
      req.reply = reply || "Done.";
    } else if (modelDeclined) {
      req.reply = reply || "I couldn't do that.";
    } else {
      req.reply = `I couldn't do that: ${round.rejected.at(-1)?.why ?? "no valid change"}.`;
    }
  } catch (err) {
    round.error = String(err?.message ?? err);
    req.reply = "Something went wrong. Try again.";
  } finally {
    req.phase = "done";
    state.requestBusy = false;
    renderRequestFeedback(req);
    finishRound(round, t0);
  }
}

function renderRequestFeedback(req) {
  const working = req.phase === "working";
  const message = working ? "Working on it…" : req.reply;
  const canUndo = !working && req.changes.length > 0 && !req.undone;
  if (req.ui === "popover") {
    if (state.request?.req !== req) {
      // The popover was closed meanwhile; say it where it can still be seen.
      if (!working) toast(message);
      return;
    }
    $("request-form").hidden = true;
    $("request-result").hidden = false;
    $("request-reply").textContent = message;
    $("request-undo").hidden = !canUndo;
    $("request-ok").hidden = working;
    renderConfirm();
  } else if (state.barRequest === req) {
    $("ask-status").hidden = false;
    $("ask-reply").textContent = message;
    $("ask-undo").hidden = !canUndo;
  }
}

function undoRequest(req) {
  if (!req || req.undone) return;
  for (const n of req.changes) undo(n);
  req.undone = true;
  req.reply = "Undone.";
  renderRequestFeedback(req);
}

// ---------- confirming changes ----------
// With "Ask before each change" on, a change shows up as a small popover next
// to the element it would change. Apply makes it; Not now drops it and tells
// the model, but locks nothing (unlike Undo).

const proposalKey = (ch) => `${ch.op}|${ch.id}|${(ch.text ?? "").trim()}`;

function queueChange(ch) {
  if (!state.askFirst) {
    state.pending.push(ch);
    return;
  }
  state.proposals.push(ch);
  while (state.proposals.length > MAX_PROPOSALS) {
    const old = state.proposals.shift();
    log("expired", { op: old.op, id: old.id, text: old.text });
  }
  renderConfirm();
}

function decide(accepted) {
  const ch = state.proposals.shift();
  if (!ch) return;
  log("decision", { id: ch.id, op: ch.op, text: ch.text, accepted });
  if (accepted) {
    const why = validate(ch);
    if (why) {
      toast("That change no longer fits, so it was skipped.");
    } else {
      apply(ch, { confirmed: true });
      render();
      renderChanges();
    }
  } else {
    state.declined.add(proposalKey(ch));
  }
  renderConfirm();
}

function changeText(e) {
  const label = esc(e.label);
  const text = esc(e.text);
  return {
    text: `Changed “${label}” → “${text}”`,
    style: `Restyled “${label}”: <code>${text}</code>`,
    hint: `Hint on “${label}”: ${text}`,
    move_first: `Moved “${label}” first`,
    pin: `Pinned “${label}” to Quick actions`,
  }[e.op];
}

function describeProposal(ch) {
  const el = state.els.get(ch.id);
  const label = esc(labelOf(el));
  const text = esc((ch.text ?? "").trim());
  const where = el.page !== "all" && el.page !== state.view ? `On the ${esc(navFor(el.page).text)} page: ` : "";
  const what = {
    text: `Change “${label}” to “${text}”?`,
    style: `Restyle “${label}”?`,
    hint: `Add a hint under “${label}”: “${text}”?`,
    move_first: `Move “${label}” to the front?`,
    pin: `Pin “${label}” to Quick actions?`,
  }[ch.op];
  return where + what + (ch.op === "style" ? `<code>${text}</code>` : "");
}

// The element a popover points at: the element itself if it's on screen,
// otherwise the nav item of its page, otherwise the top bar.
function anchorFor(el) {
  if (el.id === "app") return $app;
  return $app.querySelector(`[data-id="${el.id}"]`)
    ?? (el.page !== "all" && $app.querySelector(`[data-id="${navFor(el.page).id}"]`))
    ?? $app.querySelector('[data-id="header"]');
}

function renderConfirm() {
  const ch = state.proposals[0];
  // A suggestion waits while the person is writing their own request or
  // deciding whether to end the session.
  const show = Boolean(ch) && !state.setupOpen && !state.modalOpen && !state.ended && !state.request && !state.settledOpen;
  $("confirm").hidden = !show;
  if (show) {
    $("confirm-what").innerHTML = describeProposal(ch);
    $("confirm-why").textContent = ch.reason || "";
    $("confirm-more").textContent = state.proposals.length > 1 ? `+${state.proposals.length - 1} more` : "";
  }
  positionPopovers();
  renderStatus();
}

function positionPopovers() {
  const ch = state.proposals[0];
  if (ch && !$("confirm").hidden) positionPopover($("confirm"), anchorFor(state.els.get(ch.id)));
  if (state.request) positionPopover($("request"), anchorFor(state.els.get(state.request.id)));
  if (state.settledOpen) positionPopover($("settled"), $app);
}

function positionPopover(pop, anchorNode) {
  if (pop.hidden || !anchorNode) return;
  const anchor = anchorNode.getBoundingClientRect();
  const stage = document.querySelector(".stage").getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  // Big containers get the popover just inside their top edge.
  const big = anchor.height > 200;
  let top = big ? anchor.top - stage.top + 12 : anchor.bottom - stage.top + 10;
  let below = true;
  if (!big && top + h > stage.height && anchor.top - stage.top - h - 10 > 0) {
    top = anchor.top - stage.top - h - 10;
    below = false;
  }
  const left = Math.min(Math.max(8, anchor.left - stage.left + anchor.width / 2 - w / 2), stage.width - w - 8);
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
  pop.dataset.side = big ? "inside" : below ? "below" : "above";
  const arrowX = Math.min(Math.max(14, anchor.left - stage.left + anchor.width / 2 - left), w - 14);
  pop.style.setProperty("--arrow-x", `${arrowX}px`);
}

// ---------- training-mode notice ----------

function showWelcome() {
  state.modalOpen = true;
  $("welcome-confirm-note").hidden = !state.askFirst;
  $("welcome-saved-note").hidden = state.baseInUse !== "saved";
  $("welcome").showModal();
  renderConfirm();
}

// Never move or relabel what the person is pointing at. While the pointer is
// over a toolbar, a change waits if it touches that toolbar or could shift the
// page layout under it (any text, container or style on the current page).
function flushPending() {
  if (!state.pending.length || state.pointer.down) return;
  const under = document.elementFromPoint(state.pointer.x, state.pointer.y);
  const hoveredBar = under?.closest("[data-toolbar]")?.dataset.toolbar;
  const affectsPointer = (ch, el) => {
    if (!hoveredBar) return false;
    if (ch.op === "pin") return hoveredBar === "quick";
    if (isControl(el)) return el.view === hoveredBar || (el.pinned && hoveredBar === "quick");
    return el.page === "all" || el.page === state.view;
  };
  const ready = [];
  const waiting = [];
  for (const ch of state.pending) (affectsPointer(ch, state.els.get(ch.id)) ? waiting : ready).push(ch);
  if (!ready.length) return;
  state.pending = waiting;
  for (const ch of ready) if (!validate(ch)) apply(ch);
  render();
  renderChanges();
}

function apply(ch, { confirmed = false, requested = null } = {}) {
  const el = state.els.get(ch.id);
  const text = (ch.text ?? "").trim();
  const label = labelOf(el);
  const before = {
    text: el.text,
    hint: el.hint,
    style: { ...el.style },
    orders: isControl(el) ? siblings(el).map((s) => [s.id, s.order]) : [],
  };
  switch (ch.op) {
    case "text": el.text = text; break;
    case "style":
      for (const [p, v] of parseDeclarations(text)) {
        if (v) el.style[p] = v;
        else delete el.style[p];
      }
      break;
    case "hint": el.hint = text; break;
    case "move_first": el.order = Math.min(...siblings(el).map((s) => s.order)) - 1; break;
    case "pin": el.pinned = true; el.pinnedAt = now(); break;
  }
  el.changeCount++;
  el.adapted = true;
  el.adaptReason = requested ? `You asked: ${requested}` : ch.reason || ch.op;
  state.flashUntil.set(el.id, now() + 1600);
  const entry = {
    n: state.changes.length + 1, at: now(), op: ch.op, id: el.id, page: el.page, text, reason: ch.reason ?? "", label, before,
    engine: state.engineKey, configVersion: state.configVersion, confirmed, requested, undone: false,
  };
  state.changes.push(entry);
  log("change", { n: entry.n, op: ch.op, id: el.id, text, reason: entry.reason, requested });
  return entry;
}

function undo(n) {
  const entry = state.changes.find((e) => e.n === n);
  if (!entry || entry.undone) return;
  const el = state.els.get(entry.id);
  switch (entry.op) {
    case "text": el.text = entry.before.text; break;
    case "style": el.style = { ...entry.before.style }; break;
    case "hint": el.hint = entry.before.hint; break;
    case "move_first": for (const [id, o] of entry.before.orders) state.els.get(id).order = o; break;
    case "pin": el.pinned = false; break;
  }
  entry.undone = true;
  // An undo is a strong "leave this alone" signal.
  el.frozen = true;
  el.adapted = state.changes.some((e) => e.id === el.id && !e.undone);
  if (!el.adapted) el.adaptReason = null;
  log("undo", { n, op: entry.op, id: el.id });
  render();
  renderChanges();
}

// Back to the original app as if it were a fresh visit. Unlike undo, nothing
// is locked and nothing is recorded as a rejection; the adapter just stops
// seeing earlier activity. The export log is kept.
function resetSession() {
  endHover();
  seed();
  state.view = firstPage();
  state.changes = [];
  state.pending = [];
  state.proposals = [];
  state.requests = [];
  state.preferences = [];
  state.declined.clear();
  state.flashUntil.clear();
  state.pageHesitated = false;
  state.lastSelection = "";
  state.ended = false;
  state.sessionBeganAt = 0;
  state.endedAt = 0;
  state.settledSnoozedAt = 0;
  closeSettled();
  state.barRequest = null;
  $("ask-status").hidden = true;
  getSelection().removeAllRanges();
  closeRequest();
  log("start_over", { scenario: state.scenario, base: state.baseInUse });
  state.sessionStart = state.windowStart = state.events.length;
  state.lastActivity = now();
  render();
  renderChanges();
  renderStage();
}

function startOver() {
  resetSession();
  // A fresh visit is a new session, so it gets the training-mode notice too.
  if (!state.setupOpen) showWelcome();
}

// ---------- ending a session ----------

function endSession() {
  if (!state.everStarted) return;
  if (state.ended) return openSummary();
  state.ended = true;
  state.endedAt = now();
  endHover();
  for (const ch of state.proposals) log("expired", { op: ch.op, id: ch.id, text: ch.text });
  state.proposals = [];
  state.pending = [];
  state.requests = [];
  closeRequest();
  closeSettled();
  const summary = summarize();
  log("session_end", summary);
  renderStage();
  openSummary();
}

function summarize() {
  const events = state.events.slice(state.sessionStart);
  const count = (type, pred = () => true) => events.filter((e) => e.type === type && pred(e)).length;
  const rounds = state.rounds.filter((r) => r.at >= (state.sessionBeganAt || 0));
  const kept = state.changes.filter((c) => !c.undone);
  return {
    durationMs: (state.endedAt || now()) - (state.sessionBeganAt || state.endedAt || now()),
    changes: state.changes.length,
    kept: kept.length,
    undone: state.changes.length - kept.length,
    requests: count("request"),
    requestedChanges: state.changes.filter((c) => c.requested).length,
    suggestedChanges: kept.filter((c) => !c.requested).length,
    accepted: count("decision", (e) => e.accepted),
    declined: count("decision", (e) => !e.accepted),
    expired: count("expired"),
    actions: count("click") + count("set"),
    pages: count("nav"),
    hesitations: count("hesitate"),
    selections: count("select"),
    rounds: rounds.length,
    avgLatencyMs: rounds.length ? Math.round(rounds.reduce((sum, r) => sum + r.latencyMs, 0) / rounds.length) : 0,
  };
}

function openSummary() {
  const s = summarize();
  $("summary-title").textContent = `How the ${S().noun} adapted to you`;
  const tile = (value, label, sub = "") => `<div class="tile"><span class="tile-value">${esc(value)}</span><span class="tile-label">${esc(label)}</span>${sub ? `<span class="tile-sub">${esc(sub)}</span>` : ""}</div>`;
  const offered = s.accepted + s.declined + s.expired;
  $("summary-tiles").innerHTML = [
    tile(fmtDuration(s.durationMs), "Session length"),
    tile(String(s.kept), s.kept === 1 ? "Change kept" : "Changes kept", s.undone ? `${s.undone} undone` : ""),
    tile(String(s.requests), s.requests === 1 ? "Request from you" : "Requests from you", s.requests ? `${s.requestedChanges} changes made` : ""),
    offered
      ? tile(`${s.accepted}/${offered}`, "Suggestions accepted", [s.declined && `${s.declined} declined`, s.expired && `${s.expired} expired`].filter(Boolean).join(", "))
      : tile(String(s.suggestedChanges), "Suggested changes", "applied without asking"),
  ].join("");

  const times = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  $("summary-activity").textContent =
    `You clicked or adjusted things ${times(s.actions, "time", "times")}, changed pages ${times(s.pages, "time", "times")}, ` +
    `hesitated ${times(s.hesitations, "time", "times")} and selected text ${times(s.selections, "time", "times")}. ` +
    `The model ran ${times(s.rounds, "round", "rounds")}${s.rounds ? `, ${(s.avgLatencyMs / 1000).toFixed(1)} s each on average` : ""}.`;

  // Every change, grouped by the page it is on; "Everywhere" for shared parts.
  const groups = new Map();
  for (const c of state.changes) groups.set(c.page, [...(groups.get(c.page) ?? []), c]);
  const order = ["all", ...Object.keys(S().pages)];
  $("summary-changes").innerHTML = state.changes.length
    ? order.filter((p) => groups.has(p)).map((p) => `
        <section>
          <h4>${esc(pageName(p))}</h4>
          <ul>${groups.get(p).map((c) => {
            const tags = [c.requested && "you asked", c.confirmed && "you accepted", c.undone && "undone"].filter(Boolean);
            return `<li class="${c.undone ? "undone" : ""}">${changeText(c)}${tags.map((t) => ` <span class="tag">${t}</span>`).join("")}</li>`;
          }).join("")}</ul>
        </section>`).join("")
    : `<p class="welcome-small">Nothing changed this session.</p>`;

  $("summary").showModal();
}

// ---------- noticing that the session has settled ----------
// Ending is always the person's call, but the house can notice when adapting
// has stopped paying off and offer to end. Returns why, or null.

function settledReason(t) {
  const since = state.settledSnoozedAt || state.sessionBeganAt;
  if (!state.config.suggestEnd || !since) return null;
  const events = state.events.slice(state.sessionStart).filter((e) => e.t >= since);

  // 1. Its suggestions stopped landing: declined, undone or left to expire.
  const outcomes = [
    ...state.changes.filter((c) => !c.requested && c.at >= since).map((c) => ({ t: c.at, bad: c.undone })),
    ...events.filter((e) => (e.type === "decision" && !e.accepted) || e.type === "expired").map((e) => ({ t: e.t, bad: true })),
  ].sort((a, b) => a.t - b.t).slice(-SETTLED_OUTCOMES);
  if (outcomes.length >= SETTLED_OUTCOMES && outcomes.filter((o) => o.bad).length >= SETTLED_NEGATIVE) {
    return "Most of its recent suggestions were declined or undone, so it's probably not helping much anymore.";
  }

  // 2. The friction is gone: real use with no hesitating and no searching
  // around (three page changes in a row without doing anything). Only counts
  // once the house has actually changed something.
  if (!state.changes.some((c) => !c.undone)) return null;
  let calmFrom = since;
  let navRun = 0;
  for (const e of events) {
    if (e.type === "hesitate") calmFrom = e.t;
    if (e.type === "nav") {
      if (++navRun >= 3) calmFrom = e.t;
    } else if (e.type === "click" || e.type === "set") {
      navRun = 0;
    }
  }
  const actions = events.filter((e) => e.t >= calmFrom && ["click", "set", "nav"].includes(e.type)).length;
  if (t - calmFrom >= state.config.calmMs && actions >= CALM_MIN_ACTIONS) {
    return `${fmtDuration(t - calmFrom)} of use without hesitating or searching around.`;
  }
  return null;
}

function openSettled(reason) {
  state.settledOpen = true;
  $("settled-title").textContent = `The ${S().noun} seems settled.`;
  $("settled-why").textContent = reason;
  $("settled").hidden = false;
  log("settled_suggested", { reason });
  renderConfirm();
}

function closeSettled() {
  state.settledOpen = false;
  $("settled").hidden = true;
}

function answerSettled(end) {
  closeSettled();
  log("settled_answer", { end });
  if (end) return endSession();
  // Keep going: judge only what happens from now on, so it doesn't nag.
  state.settledSnoozedAt = now();
  renderConfirm();
}

function tick() {
  const t = now();
  const running = state.everStarted && !state.setupOpen && !state.modalOpen && !state.ended;
  if (running) {
    detectHesitation(t);
    flushPending();
    if (!state.settledOpen && !state.request && !state.requestBusy && t - state.lastSettledCheck > 2000) {
      state.lastSettledCheck = t;
      const reason = settledReason(t);
      if (reason) openSettled(reason);
    }
  }
  maybeRunRound();
  renderStatus();
}

// ---------- setup: 1. model, 2. prompt (optional), then Start ----------

const chip = (kind, key, label, on) =>
  `<label class="chip"><input type="checkbox" data-${kind}="${key}" ${on ? "checked" : ""}> ${esc(label)}</label>`;

function openSetup() {
  endHover();
  closeRequest();
  state.setupOpen = true;
  state.draft = structuredClone(state.config);
  fillSetup();
  renderStage();
}

function fillSetup() {
  const d = state.draft;
  $("scenarios").innerHTML = Object.entries(SCENARIOS).map(([k, s]) =>
    `<label class="chip"><input type="radio" name="scenario" value="${k}" ${d.scenario === k ? "checked" : ""}> ${esc(s.label)}</label>`
  ).join("");
  $("prompt").value = d.prompt;
  $("ops").innerHTML = Object.entries(OP_LABELS).map(([k, l]) => chip("op", k, l, d.ops.includes(k))).join("");
  $("signals").innerHTML = Object.entries(SIGNALS).map(([k, l]) => chip("signal", k, l, d.signals.includes(k))).join("");
  $("p-hesitate").value = d.hesitateMs / 1000;
  $("p-page").value = d.pageHesitateMs / 1000;
  $("p-read").value = d.readMs / 1000;
  $("p-temp").value = d.temperature;
  $("p-suggest-end").checked = d.suggestEnd;
  $("p-calm").value = d.calmMs / 60000;
  renderLayoutChoice();
  renderSetup();
}

// When a kept layout exists for the chosen app, offer it as the starting point.
function renderLayoutChoice() {
  const d = state.draft;
  const saved = loadLayout(d.scenario);
  const box = $("layout-choice");
  box.hidden = !saved;
  if (!saved) return;
  const when = new Date(saved.savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  box.innerHTML = `
    <p class="note">You kept a layout for this app on ${esc(when)} (${saved.count} ${saved.count === 1 ? "element" : "elements"} changed). Start from:</p>
    <div class="chips">
      <label class="chip"><input type="radio" name="base" value="saved" ${d.base === "saved" ? "checked" : ""}> Kept layout</label>
      <label class="chip"><input type="radio" name="base" value="original" ${d.base !== "saved" ? "checked" : ""}> Original layout</label>
      <button type="button" id="layout-forget" class="link">Forget kept layout</button>
    </div>`;
}

function readSetup() {
  const d = state.draft;
  const seconds = (id, min, max, fallback) => {
    const v = parseFloat($(id).value);
    return Math.round((Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback) * 1000);
  };
  d.scenario = $("scenarios").querySelector("input:checked")?.value ?? DEFAULT_SCENARIO;
  d.base = $("layout-choice").querySelector('input[name="base"]:checked')?.value ?? d.base;
  d.suggestEnd = $("p-suggest-end").checked;
  const calm = parseFloat($("p-calm").value);
  d.calmMs = Math.round((Number.isFinite(calm) ? Math.min(30, Math.max(0.5, calm)) : 3) * 60000);
  d.prompt = $("prompt").value;
  d.ops = [...$("ops").querySelectorAll("input:checked")].map((i) => i.dataset.op);
  d.signals = [...$("signals").querySelectorAll("input:checked")].map((i) => i.dataset.signal);
  d.hesitateMs = seconds("p-hesitate", 0.3, 10, 1.5);
  d.pageHesitateMs = seconds("p-page", 1, 30, 3);
  d.readMs = seconds("p-read", 0.2, 5, 0.6);
  d.temperature = Number($("p-temp").value);
}

function renderSetup() {
  const d = state.draft;
  if (!d) return;
  $("prompt-preview").textContent = buildSystemPrompt(d.prompt, level(), d.ops);
  $("p-temp-out").textContent = d.temperature.toFixed(2);
  $("model-status").textContent = !hasGPU
    ? "This needs WebGPU to run a model in the browser. Open it in a recent Chrome or Edge."
    : state.status || (state.engine
      ? `${ENGINES[state.engineKey].label} is ready.`
      : "Picking a model starts the download. The first load fetches several hundred MB; after that it's cached.");
  const problem = !state.engine
    ? (state.loading ? "Waiting for the model to finish loading…" : "Pick a model first.")
    : !d.ops.length ? "Allow at least one kind of change."
    : !d.prompt.trim() ? "The prompt can't be empty."
    : "";
  const switching = state.everStarted &&
    (d.scenario !== state.scenario || effectiveBase(d, d.scenario) !== state.baseInUse);
  $("start").disabled = Boolean(problem);
  $("start").textContent = state.everStarted ? "Apply and return" : "Start";
  $("start-note").textContent = problem || (switching ? "Switching the app or its starting layout starts a new session." : "");
  $("setup-cancel").hidden = !state.everStarted;
}

async function loadModel(key) {
  state.loading = true;
  $("engine").disabled = true;
  try {
    await state.engine?.unload?.();
    state.engine = null;
    state.engineKey = null;
    state.status = "Loading…";
    renderSetup();
    state.engine = await loadEngine(key, (text) => { state.status = text; renderSetup(); renderStatus(); });
    state.engineKey = key;
    state.status = "";
    log("engine", { engine: key });
  } catch (err) {
    state.status = `Couldn't load ${ENGINES[key].label}: ${err?.message ?? err}`;
  } finally {
    state.loading = false;
    $("engine").disabled = !hasGPU;
    renderSetup();
    renderStatus();
  }
}

function start() {
  const firstStart = !state.everStarted;
  readSetup();
  const changed = JSON.stringify(state.draft) !== JSON.stringify(state.config);
  state.config = state.draft;
  state.draft = null;
  if (changed || firstStart) {
    state.configVersion++;
    log("config", { version: state.configVersion, ...state.config });
  }
  state.setupOpen = false;
  state.everStarted = true;
  const switching = state.config.scenario !== state.scenario ||
    effectiveBase(state.config, state.config.scenario) !== state.baseInUse;
  if (switching) {
    state.scenario = state.config.scenario;
    resetSession();
  }
  // Don't react to anything from before (re)starting.
  state.windowStart = state.events.length;
  state.lastActivity = now();
  renderStage();
  if (firstStart || switching) showWelcome();
}

function renderStage() {
  $("setup").hidden = !state.setupOpen;
  $("session").hidden = state.setupOpen;
  $("edit-setup").disabled = state.setupOpen;
  $("end-session").disabled = !state.everStarted || state.setupOpen;
  $("end-session").textContent = state.ended ? "Show summary" : "End session";
  $("ask-input").disabled = state.ended;
  $("ask-input").placeholder = state.ended
    ? "The session has ended."
    : `Ask the ${S().noun} to change something, or right-click any part of it…`;
  if (!state.setupOpen) render();
  renderConfirm();
}

// ---------- control panel ----------

function renderStatus() {
  let s = state.status;
  if (!s) {
    if (!hasGPU) s = "This browser has no WebGPU. Use a recent Chrome or Edge.";
    else if (!state.engine) s = "Step 1: pick a model.";
    else if (!state.everStarted) s = "Step 2: edit the prompt if you like, then click Start.";
    else if (state.setupOpen) s = "Paused while you edit the setup.";
    else if (state.ended) s = "Session ended. The app keeps its changes; Start over begins a new session.";
    else if (state.modalOpen) s = "Waiting for the training-mode notice to be closed.";
    else if (state.requestBusy || state.requests.length) s = "Working on your request…";
    else if (!state.adaptive) s = "Adaptation is off. Requests still work; activity is still logged.";
    else if (state.proposals.length) s = `${state.proposals.length} change(s) waiting for your confirmation.`;
    else if (state.busy) s = "Thinking…";
    else if (state.pending.length) s = `${state.pending.length} change(s) waiting for the pointer to move away.`;
    else if (level().trigger === "action") s = "Watching. Every action gets a change.";
    else s = `Watching. Changes are considered after a ${level().idleMs / 1000} s pause.`;
  }
  $("status").textContent = s;
  $("model-name").textContent = state.engineKey ? ENGINES[state.engineKey].label : "No model yet";
}

function renderChanges() {
  $("changes").innerHTML = state.changes.length
    ? state.changes.slice().reverse().map((e) => {
        const undoBtn = e.undone ? "" : `<button data-undo="${e.n}">Undo</button>`;
        const why = e.requested ? `You asked: “${esc(e.requested)}”` : esc(e.reason);
        return `<li class="${e.undone ? "undone" : ""}">${changeText(e)}${undoBtn}<span class="why">${why}</span></li>`;
      }).join("")
    : `<li class="empty">No changes yet.</li>`;
}

function renderActivity() {
  const items = state.events.slice(-14).reverse().map((e) => {
    const text = CONTEXT_EVENTS.has(e.type) ? describeEvent(e)
      : e.type === "change" ? `change #${e.n}: ${e.op} ${e.id}${e.requested ? " (requested)" : ""}`
      : e.type === "round" ? `${e.kind === "request" ? "request round" : "round"}: ${e.accepted} accepted, ${e.rejected} rejected${e.attempts > 1 ? `, ${e.attempts} tries` : ""} (${e.latencyMs} ms)${e.error ? `. Error: ${e.error}` : ""}`
      : e.type === "expired" ? `unanswered change expired: ${e.op} ${e.id}`
      : e.type === "ask_first" ? `ask before each change: ${e.on ? "on" : "off"}`
      : e.type === "welcome_closed" ? "training-mode notice closed"
      : e.type === "session_end" ? `session ended after ${fmtDuration(e.durationMs)}`
      : e.type === "session_resume" ? "session resumed"
      : e.type === "settled_suggested" ? "suggested ending: the session seems settled"
      : e.type === "settled_answer" ? (e.end ? "chose to end the session" : "chose to keep going")
      : e.type === "layout_saved" ? `layout kept (${e.count} elements)`
      : e.type === "layout_forgotten" ? "kept layout forgotten"
      : e.type === "start_over" ? `started over (${SCENARIOS[e.scenario]?.label ?? e.scenario}, ${e.base} layout)`
      : e.type === "intensity" ? `intensity: ${INTENSITIES[e.level].label}`
      : e.type === "config" ? `prompt and settings v${e.version}`
      : e.type === "engine" ? `model: ${ENGINES[e.engine].label}`
      : e.type;
    return `<li class="${e.type === "hesitate" ? "warn" : ""}">${esc(text)}</li>`;
  });
  $("activity").innerHTML = items.join("") || `<li class="empty">Nothing yet.</li>`;
}

function renderIntensity() {
  for (const b of $("intensity").querySelectorAll("[data-intensity]")) {
    b.setAttribute("aria-pressed", String(b.dataset.intensity === state.intensity));
  }
  $("intensity-blurb").textContent = level().blurb;
}

function setupControls() {
  $("engine").innerHTML = `<option value="" selected disabled>Choose a model…</option>` +
    Object.entries(ENGINES).map(([key, e]) => `<option value="${key}">${esc(e.label)}</option>`).join("");
  $("engine").disabled = !hasGPU;
  $("engine").addEventListener("change", (ev) => loadModel(ev.target.value));

  $("setup").addEventListener("input", (ev) => {
    if (ev.target.id === "engine") return;
    readSetup();
    if (ev.target.name === "scenario") renderLayoutChoice();
    renderSetup();
  });
  $("setup").addEventListener("click", (ev) => {
    if (ev.target.id !== "layout-forget") return;
    try {
      localStorage.removeItem(layoutKey(state.draft.scenario));
    } catch {
      // Nothing stored, or storage blocked: either way there's nothing to forget.
    }
    log("layout_forgotten", { scenario: state.draft.scenario });
    renderLayoutChoice();
    renderSetup();
  });
  $("prompt-reset").addEventListener("click", () => {
    $("prompt").value = DEFAULT_GUIDANCE;
    readSetup();
    renderSetup();
  });
  $("start").addEventListener("click", start);
  $("setup-cancel").addEventListener("click", () => {
    state.draft = null;
    state.setupOpen = false;
    renderStage();
  });
  $("edit-setup").addEventListener("click", openSetup);

  $("intensity").innerHTML = Object.entries(INTENSITIES).map(([key, l]) =>
    `<button type="button" data-intensity="${key}" title="${esc(l.blurb)}">${esc(l.label)}</button>`
  ).join("");
  $("intensity").addEventListener("click", (ev) => {
    const key = ev.target.closest("[data-intensity]")?.dataset.intensity;
    if (!key || key === state.intensity) return;
    state.intensity = key;
    log("intensity", { level: key });
    renderIntensity();
    renderSetup();
    renderStatus();
  });
  renderIntensity();

  $("adaptive").addEventListener("change", (ev) => {
    state.adaptive = ev.target.checked;
    state.windowStart = state.events.length;
    log("adaptive", { on: state.adaptive });
  });

  $("ask-first").addEventListener("change", (ev) => {
    state.askFirst = ev.target.checked;
    log("ask_first", { on: state.askFirst });
    // Turning it off hands any waiting proposals to the normal apply path.
    if (!state.askFirst) state.pending.push(...state.proposals.splice(0));
    renderConfirm();
  });
  $("confirm-yes").addEventListener("click", () => decide(true));
  $("confirm-no").addEventListener("click", () => decide(false));

  // Requests: the ask bar above the app and the "Change this" popover.
  $("ask").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = $("ask-input").value.trim();
    if (!text) return;
    $("ask-input").value = "";
    submitRequest({ id: null, text, ui: "bar" });
  });
  $("ask-undo").addEventListener("click", () => undoRequest(state.barRequest));
  $("request-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = $("request-input").value.trim();
    if (!text || !state.request) return;
    submitRequest({ id: state.request.id, text, ui: "popover" });
  });
  $("request-cancel").addEventListener("click", closeRequest);
  $("request-ok").addEventListener("click", closeRequest);
  $("request-undo").addEventListener("click", () => undoRequest(state.request?.req));
  // Clicking elsewhere closes the popover; a reply that arrives later shows as a toast.
  document.addEventListener("pointerdown", (ev) => {
    if (state.request && !$("request").contains(ev.target)) closeRequest();
  }, true);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && state.request) closeRequest();
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k" && canRequest()) {
      ev.preventDefault();
      $("ask-input").focus();
    }
  });
  window.addEventListener("resize", positionPopovers);
  window.addEventListener("scroll", positionPopovers, { passive: true });

  // Closing the notice (button or Escape) starts the session clock and adaptation.
  $("welcome").addEventListener("close", () => {
    state.modalOpen = false;
    if (!state.sessionBeganAt) state.sessionBeganAt = now();
    state.lastActivity = now();
    log("welcome_closed");
    renderConfirm();
  });

  // Session summary.
  $("end-session").addEventListener("click", endSession);
  $("summary-new").addEventListener("click", () => {
    $("summary").close();
    startOver();
  });
  $("summary-keep").addEventListener("click", () => {
    $("summary").close();
    saveLayout();
  });
  $("settled-end").addEventListener("click", () => answerSettled(true));
  $("settled-keep").addEventListener("click", () => answerSettled(false));
  $("summary-export").addEventListener("click", exportLog);
  $("summary-resume").addEventListener("click", () => {
    $("summary").close();
    state.ended = false;
    log("session_resume");
    renderStage();
  });

  document.querySelector(".panel").addEventListener("click", (ev) => {
    const t = ev.target.closest("button");
    if (t?.dataset.undo) undo(Number(t.dataset.undo));
  });

  $("start-over").addEventListener("click", startOver);
  $("export").addEventListener("click", exportLog);
}

function exportLog() {
  const lines = [
    ...state.events.map((e) => ({ kind: "event", ...e })),
    ...state.changes.map(({ before, ...e }) => ({ kind: "change", ...e })),
    ...state.rounds.map((r) => ({ kind: "round", ...r })),
    { kind: "ui", scenario: state.scenario, elements: [...state.els.values()] },
  ].map((x) => JSON.stringify(x));
  const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `living-house-${Date.now()}.jsonl` });
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- boot ----------

seed();
state.view = firstPage();
setupControls();
openSetup();
render();
renderChanges();
renderActivity();
setInterval(tick, 300);
