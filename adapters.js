// Adapters look at the UI plus recent activity and propose small edits.
// Every adapter returns { changes: [{ op, id, text, reason }], raw }.
// The app validates each change before applying it, so adapters can be wrong
// without breaking anything.

const WEBLLM_URL = "https://esm.run/@mlc-ai/web-llm@0.2.85";

export const OPS = ["text", "style", "hint", "move_first", "pin"];

// How eagerly the UI changes. "pause" levels wait for a quiet moment; "action"
// runs a round after every action and requires the model to change something.
export const INTENSITIES = {
  gentle: { label: "Gentle", blurb: "Changes only when you seem stuck.", trigger: "pause", idleMs: 2500, minGapMs: 12000, perRound: 1, perControl: 2, always: false },
  balanced: { label: "Balanced", blurb: "Changes after a short pause.", trigger: "pause", idleMs: 1200, minGapMs: 5000, perRound: 2, perControl: 3, always: false },
  max: { label: "Max", blurb: "Every action gets a change.", trigger: "action", idleMs: 0, minGapMs: 0, perRound: 2, perControl: 8, always: true },
};

export const ENGINES = {
  "Qwen2.5-0.5B-Instruct-q4f16_1-MLC": { label: "Qwen2.5 0.5B Instruct" },
  "Qwen2.5-1.5B-Instruct-q4f16_1-MLC": { label: "Qwen2.5 1.5B Instruct" },
};

export async function loadEngine(key, onProgress) {
  const webllm = await import(WEBLLM_URL);
  const engine = await webllm.CreateMLCEngine(key, {
    initProgressCallback: (p) => onProgress(p.text),
  });
  const complete = (ctx, schema) => engine.chat.completions.create({
    messages: [
      { role: "system", content: buildSystemPrompt(ctx.config.prompt, ctx.level, ctx.config.ops) },
      { role: "user", content: describeContext(ctx) },
    ],
    temperature: ctx.config.temperature,
    max_tokens: 300,
    // Constrained decoding: the model can only emit enabled ops and known ids.
    response_format: { type: "json_object", schema },
  });
  return {
    key,
    async propose(ctx) {
      let res;
      try {
        res = await complete(ctx, changeSchema(ctx, true));
      } catch (err) {
        // If the grammar compiler rejects the item-count limits, fall back to
        // the plain schema; the prompt and the app still enforce the counts.
        if (!/schema|grammar/i.test(String(err?.message ?? err))) throw err;
        res = await complete(ctx, changeSchema(ctx, false));
      }
      const raw = res.choices[0].message.content;
      let changes = [];
      try {
        changes = JSON.parse(raw).changes ?? [];
      } catch {
        // Truncated output (hit max_tokens) is the usual cause; treat as no-op.
      }
      return { changes: changes.slice(0, ctx.level.perRound), raw, usage: res.usage };
    },
    unload: () => engine.unload(),
  };
}

// ---------- model prompt ----------

// The editable part of the system prompt. Settings append the rest (see
// buildSystemPrompt), so turning a change type off also removes it here.
export const DEFAULT_GUIDANCE = `You adapt a web app's interface to the person using it. You see every element of the app (controls, texts and containers) and what the person just did. You can change anything: wording, colors, borders, sizes, spacing, any style.

How to read the activity:
- Hesitation means confusion. Pausing on a control without clicking means its label is unclear. Pausing on a page without doing anything means the person can't see what they need there.
- Searching (visiting several pages, clicking the wrong control first) also means a label or place is unclear.
- Selecting or pointing at text shows what the person wants. Change that text's element, or the control whose "what it is" best matches the text, so it is easier to find.
- The person may be asked to confirm your changes. Accepted changes show what they like. After a declined change, try a different kind of change instead.

Rules:
- Only change elements connected to what the person did.
- A control's text must describe what it does. Use the "what it is" column.

Example. Activity: opened page "reports" via nav_reports; hesitated on x_insights "Insights" 1.5s (confused); clicked x_trends "Trends"; clicked x_insights "Insights".
Answer: {"changes":[{"op":"text","id":"x_insights","text":"Monthly reports","reason":"Hesitated, then clicked another control first"}]}

Example. Activity: opened page "orders" via nav_orders; selected text "Order #4411 · Shipped" in orders.row0 on page "orders".
Answer: {"changes":[{"op":"style","id":"x_track","text":"background: #2f5bd3; color: white; font-weight: 600","reason":"Selected a shipped order; tracking is the likely next step"},{"op":"style","id":"orders.row0","text":"background: #fff8db; border-left: 3px solid #f08c00; padding-left: 8px","reason":"Highlight the order they are looking at"}]}`;

const OP_DOCS = {
  text: "- text: replace the text of an element that has text: control labels (max 24 characters), headings, paragraphs, list rows (max 120).",
  style: `- style: set any CSS on any element. Put declarations in text, e.g. "color: #c92a2a; border: 2px solid #c92a2a; border-radius: 12px; font-size: 18px". An empty value ("color:") removes a property.`,
  hint: "- hint: add a one-line hint under a control (max 48 characters).",
  move_first: "- move_first: move a control to the front of its toolbar or the sidebar.",
  pin: "- pin: add an action to the Quick actions bar shown on every page.",
};

export function buildSystemPrompt(guidance, level, ops) {
  const count = level.perRound === 1 ? "1 small change" : `${level.perRound} small changes`;
  const eagerness = level.always
    ? `Always propose at least 1 and at most ${count}. Every action gets a response: change the element most connected to the latest action.`
    : level.perRound === 1
      ? `Propose at most ${count}, and only when the person is clearly struggling. Otherwise return {"changes": []}.`
      : `Propose at most ${count} that would help them find what they are looking for faster. If nothing clearly needs to change, return {"changes": []}.`;
  const blank = ["move_first", "pin"].filter((op) => ops.includes(op));

  return `${guidance.trim()}

When to change: ${eagerness}

Changes you can make:
${OPS.filter((op) => ops.includes(op)).map((op) => OP_DOCS[op]).join("\n")}

Answer format: {"changes":[{"op":...,"id":...,"text":...,"reason":...}]}.${blank.length ? ` Put "" in text for ${blank.join(" and ")}.` : ""} Reply with JSON only.`;
}

function describeContext(ctx) {
  const lines = ctx.elements
    .filter((e) => !e.locked)
    .map((e) => {
      const control = e.kind === "nav" || e.kind === "action";
      const usage = control ? ` | hover ${(e.hoverMs / 1000).toFixed(1)}s | hesitated ${e.hesitations}x | clicks ${e.clicks}` : "";
      const extras = [e.pinned && "pinned", e.hint && `hint "${e.hint}"`].filter(Boolean).join(", ");
      return `${e.id} | ${e.kind} | ${e.page} | ${e.text == null ? "-" : `"${e.text}"`} | ${e.desc} | ${e.css || "default style"}${usage}${extras ? ` | ${extras}` : ""}`;
    });
  const activity = ctx.recent.map(describeEvent);
  const retry = ctx.rejected?.length
    ? `\n\nYour previous answer was rejected:\n${ctx.rejected.map((r) => `${r.op} ${r.id} "${r.text ?? ""}": ${r.why}`).join("\n")}\nPropose something different.`
    : "";
  return `Current page: ${ctx.view}

Elements (id | kind | page | text | what it is | custom style | for controls: hover, hesitated, clicks):
${lines.join("\n")}

Recent activity, oldest first:
${activity.join("\n") || "(none)"}${retry}

${ctx.level.always ? "Which change would help this person most?" : "Which changes, if any, would help this person?"}`;
}

export function describeEvent(e) {
  const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
  switch (e.type) {
    case "nav": return `opened page "${e.to}" via ${e.id}`;
    case "hover": return `hovered ${e.id} "${e.label}" ${s(e.ms)}`;
    case "hesitate": return e.id
      ? `hesitated on ${e.id} "${e.label}" ${s(e.ms)} (confused)`
      : `hesitated on page "${e.page}" ${s(e.ms)} without doing anything (confused)`;
    case "click": return `clicked ${e.id} "${e.label}"`;
    case "select": return `selected text "${e.text}"${e.id ? ` in ${e.id}` : ""} on page "${e.view}"`;
    case "read": return `pointed at ${e.id} "${e.text}" ${s(e.ms)} on page "${e.view}"`;
    case "decision": return `${e.accepted ? "accepted" : "declined"} your proposed change: ${e.op} ${e.id} "${e.text ?? ""}"`;
    default: return e.type;
  }
}

function changeSchema(ctx, withCounts) {
  const ids = ctx.elements.filter((e) => !e.locked).map((e) => e.id);
  const counts = withCounts ? { minItems: ctx.level.always ? 1 : 0, maxItems: ctx.level.perRound } : {};
  return JSON.stringify({
    type: "object",
    properties: {
      changes: {
        type: "array",
        ...counts,
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ctx.config.ops },
            id: { type: "string", enum: ids },
            text: { type: "string" },
            reason: { type: "string" },
          },
          required: ["op", "id", "text", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["changes"],
    additionalProperties: false,
  });
}
