// Preserve existing controls, focus and input state while updating changed nodes.
function key(node) {
  if (!node || node.nodeType !== 1) return null;
  const id = node.getAttribute("data-id") || node.getAttribute("data-text") || node.getAttribute("id");
  if (id) return `${node.nodeName}:${id}:${node.getAttribute("data-where") || ""}`;
  // Controls have a wrapper for their optional hint.
  if (node.classList.contains("ctl")) return `ctl:${key(node.firstElementChild)}`;
  return null;
}
const compatible = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName;

export function reconcile(parent, next) {
  const old = [...parent.childNodes];
  const keyed = new Map(old.filter(key).map((node) => [key(node), node]));
  const used = new Set();
  let cursor = parent.firstChild;
  for (const desired of [...next.childNodes]) {
    const id = key(desired);
    let node = id ? keyed.get(id) : old.find((item) => !used.has(item) && !key(item) && compatible(item, desired));
    if (!node || used.has(node) || !compatible(node, desired)) {
      node = desired.cloneNode(true);
      parent.insertBefore(node, cursor);
    } else {
      used.add(node);
      if (node !== cursor) parent.insertBefore(node, cursor);
      if (node.nodeType === 1) {
        const oldValue = node.getAttribute("value");
        for (const attr of [...node.attributes]) if (!desired.hasAttribute(attr.name)) node.removeAttribute(attr.name);
        for (const attr of [...desired.attributes]) if (node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
        // Preserve a slider's uncommitted drag value during unrelated renders.
        if (node.nodeName === "INPUT" && oldValue !== desired.getAttribute("value")) node.value = desired.getAttribute("value") ?? "";
        reconcile(node, desired);
      } else if (node.nodeValue !== desired.nodeValue) {
        node.nodeValue = desired.nodeValue;
      }
    }
    cursor = node.nextSibling;
  }
  for (const node of old) if (!used.has(node)) node.remove();
}

const lastHTML = new WeakMap();
export function patchHTML(host, html) {
  if (lastHTML.get(host) === html) return;
  const template = host.ownerDocument.createElement("template");
  template.innerHTML = html;
  const active = host.ownerDocument.activeElement;
  const hadFocus = active && host.contains(active);
  reconcile(host, template.content);
  if (hadFocus && host.contains(active) && host.ownerDocument.activeElement !== active) active.focus({ preventScroll: true });
  lastHTML.set(host, html);
}
