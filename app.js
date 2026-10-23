import { DEFAULT_GUIDANCE, ENGINES, INTENSITIES, OPS, buildSystemPrompt, describeEvent, loadEngine } from "./adapters.js";

const MAX_PINS = 4;
const MODEL_EVENTS = new Set(["hover", "hesitate", "click", "nav", "select", "read"]);
// At "Max" each of these starts a round. A plain hover is context, not an action.
const ACTION_EVENTS = new Set(["hesitate", "click", "nav", "select", "read"]);
// What the model sees as recent activity: the signals plus the person's answers
// to proposed changes (not a signal that can be switched off).
const CONTEXT_EVENTS = new Set([...MODEL_EVENTS, "decision"]);
const MAX_PROPOSALS = 3; // confirmations waiting at once; older ones expire

const OP_LABELS = {
  text: "Change any text",
  style: "Restyle anything (any CSS)",
  hint: "Add hints",
  move_first: "Move controls first",
  pin: "Pin to Quick actions",
};

// Signals the model can observe; each can be switched off in the setup.
const SIGNALS = {
  click: "Clicks",
  nav: "Page changes",
  hover: "Hovering over controls",
  hesitate_control: "Hesitating on a control",
  hesitate_page: "Hesitating on a page",
  select: "Selecting text",
  read: "Pointing at text",
};
const signalOf = (type, data) => (type === "hesitate" ? (data.id ? "hesitate_control" : "hesitate_page") : type);

const defaultConfig = () => ({
  prompt: DEFAULT_GUIDANCE,
  ops: [...OPS],
  signals: Object.keys(SIGNALS),
  hesitateMs: 1500,    // dwelling on a control this long without clicking = confusion
  pageHesitateMs: 3000, // doing nothing on a page this long = confusion
  readMs: 600,         // pointing at text this long counts as reading it
  temperature: 0.2,
});

// ---------- the app being adapted ----------
// Every element has an id the model can target. Labels are deliberately vague
// so there is something to fix.

const PAGES = {
  home: { lede: "Welcome back. Here's what changed since yesterday.", rows: ["Q4 roadmap edited by Priya", "3 comments on Launch checklist", "Weekly sync notes added"] },
  projects: { lede: "All projects in this workspace.", rows: ["Launch checklist · 12 tasks", "Q4 roadmap · 31 tasks", "Hiring pipeline · 8 tasks"] },
  team: { lede: "Everyone with access to this workspace.", rows: ["Ana Ruiz · Owner", "Sam Okafor · Editor", "Lee Chen · Viewer"] },
  billing: { lede: "Team plan · renews Nov 14.", rows: ["Visa ending 4242", "Oct 2026 · $96.00 · Paid", "Sep 2026 · $96.00 · Paid"] },
  settings: { lede: "Workspace-wide settings.", rows: ["Workspace name: Atrium", "Default time zone: UTC+1", "Data region: EU"] },
};

const GLOBALS = [
  { id: "app", kind: "box", desc: "The whole app frame" },
  { id: "header", kind: "box", desc: "Top bar of the app" },
  { id: "brand", kind: "text", text: "Atrium", desc: "App name in the top bar" },
  { id: "quick", kind: "box", desc: "Quick actions bar in the top bar, shown once something is pinned" },
  { id: "quick_label", kind: "text", text: "Quick actions", desc: "Label of the Quick actions bar" },
  { id: "sidebar", kind: "box", desc: "Left navigation sidebar" },
  { id: "main", kind: "box", desc: "Main content area" },
];

const CONTROLS = [
  { id: "nav_home", view: "nav", to: "home", text: "Home", desc: "Go to the home page" },
  { id: "nav_projects", view: "nav", to: "projects", text: "Work", desc: "Go to the projects page" },
  { id: "nav_team", view: "nav", to: "team", text: "People", desc: "Go to the team members page" },
  { id: "nav_billing", view: "nav", to: "billing", text: "Account", desc: "Go to billing: plan, payment cards, invoices" },
  { id: "nav_settings", view: "nav", to: "settings", text: "Preferences", desc: "Go to settings: notifications, data export" },

  { id: "h_new", view: "home", text: "New", desc: "Create a new project" },
  { id: "h_sync", view: "home", text: "Sync", desc: "Sync local changes with the server" },
  { id: "h_recent", view: "home", text: "Recent", desc: "Open recently viewed items" },
  { id: "h_updates", view: "home", text: "Updates", desc: "Show the product changelog" },

  { id: "p_create", view: "projects", text: "Create", desc: "Start a new project from a template" },
  { id: "p_shelve", view: "projects", text: "Shelve", desc: "Archive the selected project" },
  { id: "p_link", view: "projects", text: "Link", desc: "Copy a share link for the selected project" },
  { id: "p_labels", view: "projects", text: "Labels", desc: "Edit the selected project's tags" },

  { id: "t_roles", view: "team", text: "Roles", desc: "Change what each member can do" },
  { id: "t_groups", view: "team", text: "Groups", desc: "Organize members into groups" },
  { id: "t_seats", view: "team", text: "Seats", desc: "Invite teammates by email and manage seats" },
  { id: "t_activity", view: "team", text: "Activity", desc: "See who did what and when" },

  { id: "b_plan", view: "billing", text: "Plan", desc: "Change or cancel your subscription" },
  { id: "b_methods", view: "billing", text: "Methods", desc: "Add or remove payment cards" },
  { id: "b_statements", view: "billing", text: "Statements", desc: "Download past invoices as PDF" },
  { id: "b_usage", view: "billing", text: "Usage", desc: "See seats and storage used this month" },

  { id: "s_general", view: "settings", text: "General", desc: "Rename the workspace and set the time zone" },
  { id: "s_signals", view: "settings", text: "Signals", desc: "Choose which email and push notifications you get" },
  { id: "s_takeout", view: "settings", text: "Takeout", desc: "Export all workspace data as a ZIP file" },
  { id: "s_danger", view: "settings", text: "Danger zone", desc: "Delete the workspace" },
];

// ---------- state ----------

const state = {
  view: "home",
  els: new Map(),
  events: [],
  sessionStart: 0,  // the adapter never sees events from before the last "Start over"
  windowStart: 0,   // events before this index were already shown to the adapter
  changes: [],
  pending: [],      // validated changes waiting for a safe moment to apply
  proposals: [],    // validated changes waiting for the person to confirm them
  declined: new Set(),
  askFirst: true,
  modalOpen: false,
  rounds: [],
  adaptive: true,
  intensity: "max",
  engine: null,
  engineKey: null,
  busy: false,
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

function seed() {
  state.els.clear();
  const add = (el) => state.els.set(el.id, {
    text: null, page: "all", style: {}, hint: null, pinned: false, pinnedAt: 0,
    frozen: false, adapted: false, adaptReason: null, changeCount: 0, ...el,
  });
  for (const g of GLOBALS) add(g);
  for (const [p, page] of Object.entries(PAGES)) {
    add({ id: `${p}.title`, kind: "text", page: p, desc: "Page heading" });
    add({ id: `${p}.lede`, kind: "text", page: p, text: page.lede, desc: "Intro line under the heading" });
    add({ id: `${p}.toolbar`, kind: "box", page: p, desc: "Toolbar holding this page's actions" });
    add({ id: `${p}.rows`, kind: "box", page: p, desc: "List of items on this page" });
    page.rows.forEach((text, i) => add({ id: `${p}.row${i}`, kind: "text", page: p, text, desc: "Item in this page's list" }));
  }
  const orderByView = {};
  for (const c of CONTROLS) {
    const order = (orderByView[c.view] = (orderByView[c.view] ?? -1) + 1);
    add({ ...c, kind: c.view === "nav" ? "nav" : "action", page: c.view === "nav" ? "all" : c.view, order });
  }
}

const isControl = (el) => el.kind === "nav" || el.kind === "action";
const controls = () => [...state.els.values()].filter(isControl);
const siblings = (c) => controls().filter((s) => s.view === c.view);
const toolbar = (view) => controls().filter((c) => c.view === view).sort((a, b) => a.order - b.order);
const navFor = (page) => controls().find((c) => c.to === page);
// A page heading follows its nav label until it is changed itself.
const displayText = (el) => (el.kind === "box" ? null : el.text ?? navFor(el.page).text);
const labelOf = (el) => displayText(el) ?? el.desc;
const cssText = (style) => Object.entries(style).map(([k, v]) => `${k}: ${v}`).join("; ");

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

function button(c, where = "toolbar") {
  const cls = ["btn", c.kind, where === "quick" && "quick", c.adapted && "adapted",
    c.kind === "nav" && c.to === state.view && "current"].filter(Boolean).join(" ");
  return `<button data-id="${c.id}" data-where="${where}" class="${cls}"${styleAttr(c)}${titleAttr(c)}>${esc(c.text)}</button>`;
}

const control = (c) => `<div class="ctl">${button(c)}${c.hint ? `<span class="hint" data-text="hint:${c.id}">${esc(c.hint)}</span>` : ""}</div>`;

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
        ${pinned.length ? `<span class="quick-label" ${textAttrs("quick_label")}>${textOf("quick_label")}</span>${pinned.map((c) => button(c, "quick")).join("")}` : ""}
      </div>
    </header>
    <nav class="app-nav" data-toolbar="nav" ${box("sidebar")}>${toolbar("nav").map(control).join("")}</nav>
    <main class="app-main" ${box("main")}>
      <h1 ${textAttrs(`${p}.title`)}>${textOf(`${p}.title`)}</h1>
      <p class="lede" ${textAttrs(`${p}.lede`)}>${textOf(`${p}.lede`)}</p>
      <div class="toolbar" data-toolbar="${p}" ${box(`${p}.toolbar`)}>${toolbar(p).map(control).join("")}</div>
      <ul class="rows" ${box(`${p}.rows`)}>${PAGES[p].rows.map((_, i) => `<li ${textAttrs(`${p}.row${i}`)}>${textOf(`${p}.row${i}`)}</li>`).join("")}</ul>
    </main>`;

  const t = now();
  for (const [id, until] of state.flashUntil) {
    if (until > t) for (const node of document.querySelectorAll(`[data-id="${id}"]`)) node.classList.add("flash");
  }
  restoreSelection(selection);
  // The popover's wording ("On the … page") and anchor depend on the page shown.
  renderConfirm();
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

// ---------- user input ----------

$app.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-id]");
  if (!btn) return;
  const c = state.els.get(btn.dataset.id);
  endHover();

  if (c.kind === "nav") {
    log("nav", { id: c.id, label: c.text, to: c.to });
    state.view = c.to;
    render();
    return;
  }

  log("click", { id: c.id, label: c.text, via: btn.dataset.where });
  toast(c.desc);
});

// Hover targets are controls (buttons) and text (data-text).
const HOVER_TARGET = "button[data-id], [data-text]";

$app.addEventListener("pointerover", (ev) => {
  const el = ev.target.closest(HOVER_TARGET);
  const isButton = el?.matches("button");
  const key = el && (isButton ? el.dataset.id : `text:${el.dataset.text}`);
  if (key === state.hover?.key) return;
  endHover();
  if (el) {
    state.hover = {
      key,
      control: isButton,
      id: isButton ? el.dataset.id : el.dataset.text,
      text: isButton ? null : el.textContent.trim().slice(0, 80),
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

$app.addEventListener("pointerup", () => setTimeout(logSelection, 0));
$app.addEventListener("pointerenter", () => Object.assign(state.pointer, { inApp: true, enteredApp: now() }));
$app.addEventListener("pointerleave", () => { state.pointer.inApp = false; endHover(); });
document.addEventListener("pointermove", (ev) => Object.assign(state.pointer, { x: ev.clientX, y: ev.clientY }));
document.addEventListener("pointerdown", () => (state.pointer.down = true));
document.addEventListener("pointerup", () => (state.pointer.down = false));
document.documentElement.addEventListener("pointerleave", () => Object.assign(state.pointer, { x: -1, y: -1 }));

// Hesitation is logged while it happens, so the adapter can react before the
// person gives up and moves on.
function detectHesitation(t) {
  const h = state.hover;
  if (h?.control && !h.dwellChecked && t - h.t >= state.config.hesitateMs) {
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
    else if (e.type === "click" || e.type === "nav") s.clicks++;
    stats.set(e.id, s);
  }
  // Global elements, the current page's texts and containers, and every control.
  const p = state.view;
  const ids = [
    ...GLOBALS.map((g) => g.id),
    `${p}.title`, `${p}.lede`, `${p}.toolbar`, `${p}.rows`,
    ...PAGES[p].rows.map((_, i) => `${p}.row${i}`),
    ...["nav", ...Object.keys(PAGES)].flatMap((v) => toolbar(v).map((c) => c.id)),
  ];
  const elements = ids.map((id) => {
    const el = state.els.get(id);
    return {
      id, kind: el.kind, page: el.page, text: displayText(el), desc: el.desc, css: cssText(el.style),
      pinned: el.pinned, hint: el.hint,
      // Locked elements are hidden from the model and from its output schema.
      locked: el.frozen || el.changeCount >= level().perControl,
      hoverMs: 0, hesitations: 0, clicks: 0, ...stats.get(id),
    };
  });
  return { level: level(), config: state.config, view: p, elements, recent: recent.slice(-20) };
}

async function runRound() {
  state.busy = true;
  const ctx = buildContext();
  state.windowStart = state.events.length;
  const t0 = now();
  const round = { at: t0, engine: state.engineKey, intensity: state.intensity, configVersion: state.configVersion, attempts: 0, raw: [], accepted: [], rejected: [] };
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
    round.latencyMs = now() - t0;
    state.rounds.push(round);
    log("round", { engine: round.engine, latencyMs: round.latencyMs, attempts: round.attempts, accepted: round.accepted.length, rejected: round.rejected.length, error: round.error });
    state.busy = false;
    state.lastRound = now();
    // Actions that arrived while the model was busy get their own round.
    setTimeout(maybeRunRound, 0);
  }
}

function maybeRunRound() {
  if (!state.everStarted || state.setupOpen || state.modalOpen) return;
  if (!state.adaptive || !state.engine || state.busy || state.loading) return;
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

function validate(ch) {
  const el = state.els.get(ch?.id);
  if (!el) return "unknown element";
  if (!state.config.ops.includes(ch.op)) return "change type turned off";
  if (el.frozen) return "locked after undo";
  if (el.changeCount >= level().perControl) return "changed too often";
  const text = typeof ch.text === "string" ? ch.text.trim() : "";
  if (state.declined.has(proposalKey(ch))) return "the person declined this exact change";
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
      if (el.kind !== "action") return "only actions can be pinned";
      if (el.pinned) return "already pinned";
      if (controls().filter((s) => s.pinned).length >= MAX_PINS) return "quick bar full";
      return null;
    default:
      return "unknown op";
  }
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

// The element a proposal points at: the element itself if it's on screen,
// otherwise the nav item of its page, otherwise the top bar.
function anchorFor(el) {
  if (el.id === "app") return $app;
  return $app.querySelector(`[data-id="${el.id}"]`)
    ?? (el.page !== "all" && $app.querySelector(`[data-id="${navFor(el.page).id}"]`))
    ?? $app.querySelector('[data-id="header"]');
}

function renderConfirm() {
  const ch = state.proposals[0];
  const show = Boolean(ch) && !state.setupOpen && !state.modalOpen;
  $("confirm").hidden = !show;
  if (!show) return;
  $("confirm-what").innerHTML = describeProposal(ch);
  $("confirm-why").textContent = ch.reason || "";
  $("confirm-more").textContent = state.proposals.length > 1 ? `+${state.proposals.length - 1} more` : "";
  positionConfirm();
  renderStatus();
}

function positionConfirm() {
  const pop = $("confirm");
  const ch = state.proposals[0];
  if (pop.hidden || !ch) return;
  const anchor = anchorFor(state.els.get(ch.id)).getBoundingClientRect();
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

function apply(ch, { confirmed = false } = {}) {
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
  el.adaptReason = ch.reason || ch.op;
  state.flashUntil.set(el.id, now() + 1600);
  const entry = { n: state.changes.length + 1, op: ch.op, id: el.id, text, reason: ch.reason ?? "", label, before, engine: state.engineKey, configVersion: state.configVersion, confirmed, undone: false };
  state.changes.push(entry);
  log("change", { n: entry.n, op: ch.op, id: el.id, text, reason: entry.reason });
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
function startOver() {
  endHover();
  seed();
  state.view = "home";
  state.changes = [];
  state.pending = [];
  state.proposals = [];
  state.declined.clear();
  state.flashUntil.clear();
  state.pageHesitated = false;
  state.lastSelection = "";
  getSelection().removeAllRanges();
  log("start_over");
  state.sessionStart = state.windowStart = state.events.length;
  state.lastActivity = now();
  render();
  renderChanges();
  renderConfirm();
  // A fresh visit is a new session, so it gets the training-mode notice too.
  if (!state.setupOpen) showWelcome();
}

function tick() {
  if (!state.setupOpen && !state.modalOpen) {
    detectHesitation(now());
    flushPending();
    maybeRunRound();
  }
  renderStatus();
}

// ---------- setup: 1. model, 2. prompt (optional), then Start ----------

const chip = (kind, key, label, on) =>
  `<label class="chip"><input type="checkbox" data-${kind}="${key}" ${on ? "checked" : ""}> ${esc(label)}</label>`;

function openSetup() {
  endHover();
  state.setupOpen = true;
  state.draft = structuredClone(state.config);
  fillSetup();
  renderStage();
}

function fillSetup() {
  const d = state.draft;
  $("prompt").value = d.prompt;
  $("ops").innerHTML = Object.entries(OP_LABELS).map(([k, l]) => chip("op", k, l, d.ops.includes(k))).join("");
  $("signals").innerHTML = Object.entries(SIGNALS).map(([k, l]) => chip("signal", k, l, d.signals.includes(k))).join("");
  $("p-hesitate").value = d.hesitateMs / 1000;
  $("p-page").value = d.pageHesitateMs / 1000;
  $("p-read").value = d.readMs / 1000;
  $("p-temp").value = d.temperature;
  renderSetup();
}

function readSetup() {
  const d = state.draft;
  const seconds = (id, min, max, fallback) => {
    const v = parseFloat($(id).value);
    return Math.round((Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback) * 1000);
  };
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
  $("start").disabled = Boolean(problem);
  $("start").textContent = state.everStarted ? "Apply and return" : "Start";
  $("start-note").textContent = problem;
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
  if (changed || !state.everStarted) {
    state.configVersion++;
    log("config", { version: state.configVersion, ...state.config });
  }
  state.setupOpen = false;
  state.everStarted = true;
  // Don't react to anything from before (re)starting.
  state.windowStart = state.events.length;
  state.lastActivity = now();
  renderStage();
  if (firstStart) showWelcome();
}

function renderStage() {
  $("setup").hidden = !state.setupOpen;
  $("app-wrap").hidden = state.setupOpen;
  $("edit-setup").disabled = state.setupOpen;
  if (!state.setupOpen) render();
  renderConfirm();
  renderStatus();
}

// ---------- control panel ----------

function renderStatus() {
  let s = state.status;
  if (!s) {
    if (!hasGPU) s = "This browser has no WebGPU. Use a recent Chrome or Edge.";
    else if (!state.engine) s = "Step 1: pick a model.";
    else if (!state.everStarted) s = "Step 2: edit the prompt if you like, then click Start.";
    else if (state.setupOpen) s = "Paused while you edit the setup.";
    else if (state.modalOpen) s = "Waiting for the training-mode notice to be closed.";
    else if (!state.adaptive) s = "Adaptation is off. Activity is still logged.";
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
        const what = {
          text: `Changed “${esc(e.label)}” → “${esc(e.text)}”`,
          style: `Restyled “${esc(e.label)}”: <code>${esc(e.text)}</code>`,
          hint: `Hint on “${esc(e.label)}”: ${esc(e.text)}`,
          move_first: `Moved “${esc(e.label)}” first`,
          pin: `Pinned “${esc(e.label)}” to Quick actions`,
        }[e.op];
        const undoBtn = e.undone ? "" : `<button data-undo="${e.n}">Undo</button>`;
        return `<li class="${e.undone ? "undone" : ""}">${what}${undoBtn}<span class="why">${esc(e.reason)}</span></li>`;
      }).join("")
    : `<li class="empty">No changes yet.</li>`;
}

function renderActivity() {
  const items = state.events.slice(-14).reverse().map((e) => {
    const text = CONTEXT_EVENTS.has(e.type) ? describeEvent(e)
      : e.type === "expired" ? `unanswered change expired: ${e.op} ${e.id}`
      : e.type === "ask_first" ? `ask before each change: ${e.on ? "on" : "off"}`
      : e.type === "welcome_closed" ? "training-mode notice closed"
      : e.type === "change" ? `change #${e.n}: ${e.op} ${e.id}`
      : e.type === "round" ? `round: ${e.accepted} accepted, ${e.rejected} rejected${e.attempts > 1 ? `, ${e.attempts} tries` : ""} (${e.latencyMs} ms)${e.error ? `. Error: ${e.error}` : ""}`
      : e.type === "start_over" ? "started over"
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
    renderStatus();
  });
  $("confirm-yes").addEventListener("click", () => decide(true));
  $("confirm-no").addEventListener("click", () => decide(false));
  window.addEventListener("resize", positionConfirm);
  window.addEventListener("scroll", positionConfirm, { passive: true });

  // Closing the notice (button or Escape) resumes adaptation.
  $("welcome").addEventListener("close", () => {
    state.modalOpen = false;
    state.lastActivity = now();
    log("welcome_closed");
    renderConfirm();
    renderStatus();
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
    { kind: "ui", elements: [...state.els.values()] },
  ].map((x) => JSON.stringify(x));
  const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `living-house-${Date.now()}.jsonl` });
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- boot ----------

seed();
setupControls();
openSetup();
renderChanges();
renderActivity();
setInterval(tick, 300);
