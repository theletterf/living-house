// Adapters look at the UI plus recent activity and propose small edits.
// Every adapter returns { changes: [{ op, id, text, reason }], reply, raw }.
// The app validates each change before applying it, so adapters can be wrong
// without breaking anything.

const WEBLLM_URL = "https://esm.run/@mlc-ai/web-llm@0.2.85";

export const OPS = ["text", "style", "hint", "move_first", "pin"];
export const REQUEST_MAX_CHANGES = 4; // a direct request may need several edits

// A restyle is one property from this list plus a value. Small models write
// usable CSS when they pick the property from a list; free-form declarations
// came back as labels or empty strings.
export const CSS_PROPERTIES = [
  "font-size", "font-weight", "font-style", "text-decoration", "text-transform", "letter-spacing", "line-height", "text-align",
  "color", "background-color", "border", "border-color", "border-width", "border-radius", "border-left", "outline", "box-shadow",
  "padding", "margin", "width", "min-width", "opacity", "display", "transform",
];

const AUTOMATIC_CSS_PROPERTIES = ["font-size", "font-weight", "line-height", "padding", "background-color"];

const CONTROL_KINDS = ["nav", "action", "toggle", "slider", "stepper"];
const PINNABLE_KINDS = ["action", "toggle"];

// How eagerly the UI changes. "pause" levels wait for a quiet moment; "action"
// considers a round after an action when repeated activity supplies evidence.
export const INTENSITIES = {
  gentle: { label: "Gentle", blurb: "Changes only when you seem stuck.", trigger: "pause", idleMs: 2500, minGapMs: 12000, perRound: 1, perControl: 2, always: false, cautious: true },
  balanced: { label: "Balanced", blurb: "Changes after a short pause.", trigger: "pause", idleMs: 1200, minGapMs: 5000, perRound: 1, perControl: 3, always: false },
  max: { label: "Max", blurb: "Responds to repeated use or difficulty.", trigger: "action", idleMs: 0, minGapMs: 0, perRound: 1, perControl: 8, always: false },
  extreme: { label: "Extreme", blurb: "Seeks useful changes after almost every interaction.", trigger: "action", idleMs: 0, minGapMs: 0, perRound: 1, perControl: 100, always: false, eager: true },
};

// `noThinking`: Qwen3 reasons out loud by default, which is slow and breaks
// the JSON; WebLLM turns it off per request.
export const ENGINES = {
  "Qwen2.5-0.5B-Instruct-q4f16_1-MLC": { label: "Qwen2.5 0.5B Instruct", conservative: true },
  "Qwen2.5-1.5B-Instruct-q4f16_1-MLC": { label: "Qwen2.5 1.5B Instruct" },
  "Qwen2.5-3B-Instruct-q4f16_1-MLC": { label: "Qwen2.5 3B Instruct" },
  "Qwen3-1.7B-q4f16_1-MLC": { label: "Qwen3 1.7B", noThinking: true },
  "Qwen3-4B-q4f16_1-MLC": { label: "Qwen3 4B", noThinking: true },
  "Llama-3.2-3B-Instruct-q4f16_1-MLC": { label: "Llama 3.2 3B Instruct" },
};

export async function loadEngine(key, onProgress, {
  loadRuntime = () => import(WEBLLM_URL),
  makeWorker = () => new Worker(new URL("./model-worker.js", import.meta.url), { type: "module" }),
} = {}) {
  const webllm = await loadRuntime();
  const worker = makeWorker();
  let fail;
  let workerError = null;
  const failed = new Promise((_, reject) => { fail = reject; });
  // Keep a failure observable even when the worker is idle.
  failed.catch(() => {});
  const onError = (event) => {
    workerError = new Error(event.message || "The local model worker stopped. Reload the model.");
    fail(workerError);
    worker.terminate();
  };
  worker.addEventListener("error", onError);
  worker.addEventListener("messageerror", onError);
  const run = async (operation) => {
    if (workerError) throw workerError;
    return Promise.race([operation(), failed]);
  };
  let engine;
  try {
    engine = await run(() => webllm.CreateWebWorkerMLCEngine(worker, key, {
      initProgressCallback: (p) => onProgress(p.text),
    }));
  } catch (error) {
    worker.terminate();
    throw error;
  }
  const complete = (ctx, schema) => run(() => engine.chat.completions.create({
    messages: [
      { role: "system", content: buildSystemPrompt(ctx.config.prompt, ctx.level, ctx.config.ops, { request: Boolean(ctx.request) }) },
      { role: "user", content: describeContext(ctx) },
    ],
    temperature: ctx.config.temperature,
    max_tokens: ctx.request ? 300 : 200,
    ...(ENGINES[key]?.noThinking ? { extra_body: { enable_thinking: false } } : {}),
    // Constrained decoding: each change type has its own shape, and ids are
    // limited to the elements that change type can apply to.
    response_format: { type: "json_object", schema },
  }));
  return {
    key,
    async propose(ctx) {
      let res;
      try {
        res = await complete(ctx, changeSchema(ctx, true));
      } catch (err) {
        // If the grammar compiler rejects the length and count limits, fall
        // back to the schema without them; the app still enforces both.
        if (!/schema|grammar/i.test(String(err?.message ?? err))) throw err;
        res = await complete(ctx, changeSchema(ctx, false));
      }
      const raw = res.choices[0].message.content;
      let parsed = {};
      try {
        // Qwen3 writes an empty <think></think> block before the JSON even
        // with thinking off, so parse from the first brace.
        parsed = JSON.parse(raw.slice(raw.indexOf("{")));
      } catch {
        throw new Error(res.choices[0].finish_reason === "length"
          ? "The model output was cut short. Try a simpler request."
          : "The model returned invalid JSON.");
      }
      const limit = ctx.request ? REQUEST_MAX_CHANGES : ctx.level.perRound;
      return {
        changes: (parsed.changes ?? []).slice(0, limit).map(toChange),
        reply: parsed.reply ?? "",
        raw,
        finish: res.choices[0].finish_reason,
        usage: res.usage,
      };
    },
    interrupt: () => engine.interruptGenerate(),
    async unload() {
      try { await run(() => engine.unload()); }
      catch { /* Termination also releases a failed worker's model resources. */ }
      finally {
        worker.removeEventListener("error", onError);
        worker.removeEventListener("messageerror", onError);
        worker.terminate();
      }
    },
  };
}

// The model's per-op shapes, back to the app's single change format.
function toChange(c) {
  if (c?.op === "style") return { op: "style", id: c.id, text: `${c.property}: ${c.value ?? ""}`, reason: c.reason };
  if (c?.op === "move_first" || c?.op === "pin") return { op: c.op, id: c.id, text: "", reason: c.reason };
  return { op: c?.op, id: c?.id, text: c?.text ?? "", reason: c?.reason };
}

// ---------- model prompt ----------

// The editable part of the system prompt. Settings append the rest (see
// buildSystemPrompt), so turning a change type off also removes it here.
export const DEFAULT_GUIDANCE = `You adapt an app's interface to the person using it, so they find what they need faster.

How to read what they did:
- A pause alone is not confusion. Repeated hesitation on the same control may justify a clearer label or hint.
- Several page changes without using a control may mean navigation is unclear. Offer a clearer label only when its purpose supports that label.
- Using the same control again and again is a habit: make it easier to reach.
- Reading, pointing, selecting text and opening help are normal activity, not proof of confusion. Outside Extreme mode, they do not justify a change by themselves.
- Respect earlier requests. A declined change is evidence to leave that element alone, not an instruction to try another decoration.

Rules: preserve the purpose and meaning of each element. Never invent capabilities or facts. A reason must state a practical benefit, not merely say the change is clearer. Use the selected intensity to decide when to seek improvements. Return no changes unless there is a clear practical benefit. Do not add arbitrary decoration. Change only elements connected to what they did. A new label says what the control does (see "what it is") and must differ from the current one.

Example. Activity: hesitated on x_insights "Insights" 1.5s (possible difficulty); clicked x_trends "Trends"; clicked x_insights "Insights".
Answer: {"changes":[{"op":"text","id":"x_insights","text":"Monthly reports","reason":"Unclear label"}]}

Example. Activity: selected text "Order #4411 · Shipped" in orders.row0.
Answer: {"changes":[]}`;

const OP_DOCS = {
  text: `- text: new wording for an element with text (max 24 characters for controls). {"op":"text","id":…,"text":…,"reason":…}`,
  style: `- style: one CSS property and its value, e.g. font-size 20px, font-weight 700, background-color #fff3bf, border 2px solid #f08c00. {"op":"style","id":…,"property":…,"value":…,"reason":…}`,
  hint: `- hint: a short note under a control (max 48 characters). {"op":"hint","id":…,"text":…,"reason":…}`,
  move_first: `- move_first: move a control to the front of its toolbar. {"op":"move_first","id":…,"reason":…}`,
  pin: `- pin: add an action or a switch to the Quick actions bar on every page. {"op":"pin","id":…,"reason":…}`,
};

export function buildSystemPrompt(guidance, level, ops, { request = false } = {}) {
  const count = level.perRound === 1 ? "1 change" : `${level.perRound} changes`;
  const eagerness = request
    ? `The person asked for a change directly. Do exactly what they asked, using up to ${REQUEST_MAX_CHANGES} changes. If none of the changes below can do it, return no changes and say why in reply.
Requests and the changes that do them:
- "make it bigger" → style font-size 20px, and style padding 12px 18px
- "make it stand out" or "highlight it" → style background-color #fff3bf, and style border 2px solid #f08c00
- "make it red" → style color #c92a2a
- "call it Lights" → text "Lights"
- "put it first" → move_first
- "I use this a lot" → pin`
    : level.eager
      ? `Extreme mode: actively seek 1 useful improvement after this interaction, without waiting for repeated use or confusion. Improve the latest target or nearby controls on the current page. Make labels more specific, add useful hints, improve readability or spacing, highlight a relevant next action, or bring likely actions within reach. Explain the practical benefit. Preserve the meaning of each control. Never rename a page to the app name or replace a specific action with a vague label. Reading and successful use can reveal an opportunity; they do not prove confusion. Respect requested names, Undo and declined changes. Do not repeat an existing edit or decorate without a purpose. Return no changes only when no useful valid improvement is available.`
    : level.always
      ? `Always propose 1 or ${count === "1 change" ? "1" : "2"} changes, about the element most connected to the latest action.`
      : level.cautious
        ? `Propose at most ${count}, and only when the person is clearly struggling. Otherwise return {"changes": []}.`
        : `Propose at most ${count}. If nothing clearly needs to change, return {"changes": []}.`;
  const format = request
    ? `{"changes":[…],"reply":"one short sentence: what you changed, or why you couldn't"}`
    : `{"changes":[…]}`;

  return `${guidance.trim()}

When to change: ${eagerness}

Changes you can make:
${OPS.filter((op) => ops.includes(op)).map((op) => OP_DOCS[op]).join("\n")}
${!request && ops.includes("style") ? "Automatic styles: font-size 14–24px; font-weight 400, 500, 600 or 700; line-height 1.3–1.8; padding 4–20px per side; background-color #fff3bf, #e7f0ff or #e8f5e9. No other automatic style changes." : ""}

Keep each reason under 8 words. Answer with JSON only: ${format}`;
}

// The context is the slow part of a round (the model reads every token before
// writing), so only what matters now gets full detail: the current page, the
// shared parts, and anything the person touched recently or asked about.
function describeContext(ctx) {
  const visible = ctx.elements.filter((e) => !e.locked);
  const touched = new Set([...ctx.recent.map((e) => e.id), ...(ctx.preferences ?? []).map((p) => p.id), ctx.request?.id].filter(Boolean));
  const full = (e) => e.page === ctx.view || e.page === "all" || touched.has(e.id);

  const line = (e) => {
    const usage = [e.hesitations && `hesitated ${e.hesitations}x`, e.clicks && `used ${e.clicks}x`].filter(Boolean).join(", ");
    const extras = [e.value && `now ${e.value}`, e.css && `style ${e.css}`, e.pinned && "pinned", e.hint && `hint "${e.hint}"`, usage].filter(Boolean).join(" | ");
    return `${e.id} | ${e.kind} | ${e.text == null ? "-" : `"${e.text}"`} | ${e.desc}${extras ? ` | ${extras}` : ""}`;
  };
  const detailed = visible.filter(full).map(line);
  const others = new Map();
  for (const e of visible.filter((e) => !full(e) && CONTROL_KINDS.includes(e.kind))) {
    others.set(e.page, [...(others.get(e.page) ?? []), `${e.id} "${e.text}"`]);
  }
  const elsewhere = [...others].map(([page, items]) => `${page}: ${items.join(", ")}`);

  const activity = ctx.recent.slice(-12).map(describeEvent);
  // Small models repeat themselves; an explicit list stops that better than
  // the same facts spread over the element lines.
  const done = ctx.done?.length
    ? `\n\nAlready changed (don't propose these again):\n${ctx.done.map((d) => `- ${d}`).join("\n")}`
    : "";
  const preferences = ctx.preferences?.length
    ? `\n\nThey asked for these earlier; keep respecting them:\n${ctx.preferences.map((p) => `- "${p.text}"${p.id ? ` (about ${p.id})` : ""}`).join("\n")}`
    : "";
  const retry = ctx.rejected?.length
    ? `\n\nYour previous answer was rejected:\n${ctx.rejected.map((r) => `${r.op} ${r.id} "${r.text ?? ""}": ${r.why}`).join("\n")}\nCorrect only the rejected operation. Preserve the requested target and value.`
    : "";
  const question = ctx.request
    ? `They ask you now: "${ctx.request.text}"${ctx.request.id ? `, about ${ctx.request.id}` : ""}. Which changes do exactly that?`
    : ctx.level.always ? "Which change helps them most?" : "Which changes, if any, would help them?";

  return `App: ${ctx.about}. Current page: ${ctx.view}.

Elements (id | kind | text | what it is | state):
${detailed.join("\n")}${elsewhere.length ? `\n\nOther pages:\n${elsewhere.join("\n")}` : ""}${done}${preferences}

Recent activity, oldest first:
${activity.join("\n") || "(none)"}${retry}

${question}`;
}

export function describeEvent(e) {
  const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
  switch (e.type) {
    case "nav": return `opened page "${e.to}" via ${e.id}`;
    case "hover": return `hovered ${e.id} "${e.label}" ${s(e.ms)}`;
    case "hesitate": return e.id
      ? `hesitated on ${e.id} "${e.label}" ${s(e.ms)} (possible difficulty)`
      : `hesitated on page "${e.page}" ${s(e.ms)} without doing anything (possible difficulty)`;
    case "click": return `clicked ${e.id} "${e.label}"`;
    case "set": return `set ${e.id} "${e.label}" to ${e.value}`;
    case "select": return `selected text "${e.text}"${e.id ? ` in ${e.id}` : ""} on page "${e.view}"`;
    case "read": return `pointed at ${e.id} "${e.text}" ${s(e.ms)} on page "${e.view}"`;
    case "decision": return `${e.accepted ? "accepted" : "declined"} your proposed change: ${e.op} ${e.id} "${e.text ?? ""}"`;
    case "request": return `asked you: "${e.text}"${e.id ? ` (about ${e.id})` : ""}`;
    case "help_open": return `opened the help article "${e.title}"`;
    case "help_show": return `looked up ${e.id} "${e.label}" in the help (couldn't find it on their own)`;
    default: return e.type;
  }
}

// One shape per change type, each limited to the kinds of element it can apply
// to. The schema depends only on the app and the settings, never on what is
// locked or pinned right now: WebLLM compiles a grammar per distinct schema,
// and recompiling made some rounds several seconds slower. Locks and pins are
// enforced by the app's validation instead.
function changeSchema(ctx, strict) {
  const ids = (pred) => (ctx.schemaElements ?? ctx.elements).filter(pred).map((e) => e.id);
  const str = (max) => (strict ? { type: "string", maxLength: max } : { type: "string" });
  const shape = (op, idList, fields) => ({
    type: "object",
    properties: { op: { type: "string", enum: [op] }, id: { type: "string", enum: idList }, ...fields, reason: str(60) },
    required: ["op", "id", ...Object.keys(fields), "reason"],
    additionalProperties: false,
  });
  const shapes = {
    text: () => shape("text", ids((e) => e.kind !== "box"), { text: str(120) }),
    style: () => shape("style", ids(() => true), { property: { type: "string", enum: ctx.request ? CSS_PROPERTIES : AUTOMATIC_CSS_PROPERTIES }, value: str(40) }),
    hint: () => shape("hint", ids((e) => CONTROL_KINDS.includes(e.kind)), { text: str(48) }),
    move_first: () => shape("move_first", ids((e) => CONTROL_KINDS.includes(e.kind)), {}),
    pin: () => shape("pin", ids((e) => PINNABLE_KINDS.includes(e.kind)), {}),
  };
  const items = ctx.config.ops.map((op) => shapes[op]()).filter((s) => s.properties.id.enum.length);

  const max = ctx.request ? REQUEST_MAX_CHANGES : ctx.level.perRound;
  const min = !ctx.request && ctx.level.always ? 1 : 0;
  const properties = {
    changes: { type: "array", ...(strict ? { minItems: min, maxItems: max } : {}), items: items.length === 1 ? items[0] : { anyOf: items } },
  };
  if (ctx.request) properties.reply = str(160);
  return JSON.stringify({
    type: "object",
    properties,
    required: ctx.request ? ["changes", "reply"] : ["changes"],
    additionalProperties: false,
  });
}
