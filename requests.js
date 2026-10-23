// Explicit commands are resolved before model inference. Keep this module DOM-free.
const clean = (s) => s.trim().replace(/^["“']|["”']$/g, "").trim();
const key = (s) => clean(s).toLocaleLowerCase();

export function parseCommand(text) {
  const input = text.trim();
  let m = input.match(/^rename\s+(.+?)\s+to\s+(.+)$/i);
  if (m) return { op: "text", target: clean(m[1]), text: clean(m[2]) };
  m = input.match(/^(?:call|rename)\s+(?:it|this)\s+(?:to\s+)?(.+)$/i);
  if (m) return { op: "text", text: clean(m[1]) };
  m = input.match(/^(?:highlight|make)\s+(it|this)(?:\s+(stand out|bigger|red))?$/i);
  if (m && (m[2] || /^highlight/i.test(input))) {
    const preset = m[2]?.toLowerCase() ?? "stand out";
    const styles = {
      "stand out": [["background-color", "#fff3bf"], ["border", "2px solid #f08c00"]],
      bigger: [["font-size", "20px"], ["padding", "12px 18px"]],
      red: [["color", "#c92a2a"]],
    };
    return { op: "style", styles: styles[preset] };
  }
  if (/^(?:put|move) (?:it|this) first$/i.test(input)) return { op: "move_first" };
  if (/^pin (?:it|this)$/i.test(input)) return { op: "pin" };
  return null;
}

export function resolveCommand(command, elements, targetId) {
  let matches = targetId ? elements.filter((e) => e.id === targetId) : elements.filter((e) =>
    command.target && (e.id === command.target || [e.text, ...(e.aliases ?? [])].filter(Boolean).some((s) => key(s) === key(command.target))));
  // An inherited heading and its navigation label are one name, not an ambiguity.
  matches = matches.filter((e) => !e.follows || !matches.some((other) => other.id === e.follows));
  if (matches.length !== 1) return {
    changes: [], candidates: matches,
    error: matches.length ? "Choose which element to change:" : "Choose an element with right-click, then repeat this request.",
  };
  const id = matches[0].id;
  const changes = command.styles
    ? command.styles.map(([property, value]) => ({ op: "style", id, text: `${property}: ${value}`, reason: "Direct request" }))
    : [{ op: command.op, id, text: command.text ?? "", reason: "Direct request" }];
  return { changes, candidates: [] };
}

// Reading or one pause is not enough evidence to change an interface.
export function adaptationEvidence(events) {
  const last = events.filter((e) => ["hesitate", "click", "set", "nav", "help_show"].includes(e.type)).at(-1);
  if (!last || !["hesitate", "click", "set", "nav", "help_show"].includes(last.type)) return null;
  const same = events.filter((e) => e.id && e.id === last.id);
  if (last.type === "hesitate" && last.id && same.filter((e) => e.type === "hesitate").length >= 2) return last.id;
  if (["click", "set"].includes(last.type) && same.filter((e) => ["click", "set"].includes(e.type)).length >= 3) return last.id;
  if (last.type === "nav") {
    const actions = events.filter((e) => ["nav", "click", "set"].includes(e.type)).slice(-3);
    if (actions.length === 3 && actions.every((e) => e.type === "nav") && new Set(actions.map((e) => e.to)).size > 1) return last.id;
  }
  if (last.type === "help_show" && same.some((e) => e.type === "hesitate")) return last.id;
  return null;
}


// Automatic styles stay within a small set of readable, moderate changes.
// Explicit requests still use the full supported CSS surface.
export function automaticStyleIssue(declarations) {
  const rules = {
    "font-size": /^(1[4-9]|2[0-4])px$/,
    "font-weight": /^(400|500|600|700)$/,
    "line-height": /^1\.[3-8]$/,
    padding: /^(?:[4-9]|1[0-9]|20)px(?: (?:[4-9]|1[0-9]|20)px){0,3}$/,
    "background-color": /^#(?:fff3bf|e7f0ff|e8f5e9)$/i,
  };
  return declarations.every(([property, value]) => rules[property]?.test(value))
    ? null : "automatic styles must use moderate readability or highlight changes";
}
