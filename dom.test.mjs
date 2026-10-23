import assert from "node:assert/strict";
import test from "node:test";
import { reconcile } from "./dom.js";
import { recordTiming } from "./performance.js";

// Minimal tree fixture for the reconciler. Browser layout and GPU are not mocked here.
class Node {
  constructor(name, attrs = {}, children = []) {
    this.nodeName = name;
    this.nodeType = name === "#text" ? 3 : 1;
    this.nodeValue = name === "#text" ? attrs.text : null;
    this.attrs = name === "#text" ? {} : { ...attrs };
    this.childNodes = [];
    this.value = attrs.value;
    this.writes = 0;
    for (const child of children) this.insertBefore(child, null);
  }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
  get classList() { return { contains: (name) => (this.attrs.class || "").split(" ").includes(name) }; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get firstElementChild() { return this.childNodes.find((c) => c.nodeType === 1) ?? null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return name in this.attrs; }
  setAttribute(name, value) { this.attrs[name] = value; this.writes++; }
  removeAttribute(name) { delete this.attrs[name]; this.writes++; }
  insertBefore(child, reference) {
    child.remove();
    const i = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
    assert.ok(i >= 0);
    this.childNodes.splice(i, 0, child);
    child.parentNode = this;
  }
  remove() {
    if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  cloneNode(deep) {
    return new Node(this.nodeName, this.nodeType === 3 ? { text: this.nodeValue } : this.attrs,
      deep ? this.childNodes.map((child) => child.cloneNode(true)) : []);
  }
}
const text = (value) => new Node("#text", { text: value });
const element = (name, attrs = {}, children = []) => new Node(name, attrs, children);

test("text edits preserve the control and unchanged input identity", () => {
  const label = text("Old label");
  const slider = element("INPUT", { type: "range", value: "20" });
  slider.value = "37"; // An active drag has not committed to application state yet.
  const control = element("DIV", { "data-id": "brightness" }, [label, slider]);
  const root = element("MAIN", {}, [control]);
  reconcile(root, element("MAIN", {}, [element("DIV", { "data-id": "brightness" }, [text("New label"), element("INPUT", { type: "range", value: "20" })])]));
  assert.equal(root.firstChild, control);
  assert.equal(control.childNodes[0], label);
  assert.equal(label.nodeValue, "New label");
  assert.equal(control.childNodes[1], slider);
  assert.equal(slider.value, "37", "unrelated updates must not reset a drag");
});

test("committed device changes update the existing input value", () => {
  const slider = element("INPUT", { type: "range", value: "20" });
  const root = element("MAIN", {}, [slider]);
  reconcile(root, element("MAIN", {}, [element("INPUT", { type: "range", value: "50" })]));
  assert.equal(root.firstChild, slider);
  assert.equal(slider.value, "50");
});

test("reordering controls moves the existing wrappers instead of replacing them", () => {
  const control = (id) => element("DIV", { class: "ctl" }, [element("BUTTON", { "data-id": id }, [text(id)])]);
  const a = control("a"), b = control("b");
  const root = element("MAIN", {}, [a, b]);
  reconcile(root, element("MAIN", {}, [control("b"), control("a")]));
  assert.equal(root.childNodes[0], b);
  assert.equal(root.childNodes[1], a);
});

test("pinned and original copies keep separate identities; obsolete nodes are removed", () => {
  const normal = element("BUTTON", { "data-id": "light", "data-where": "toolbar" });
  const pinned = element("BUTTON", { "data-id": "light", "data-where": "quick" });
  const obsolete = element("P", {}, [text("old")]);
  const root = element("MAIN", {}, [normal, pinned, obsolete]);
  reconcile(root, element("MAIN", {}, [pinned.cloneNode(true), normal.cloneNode(true)]));
  assert.deepEqual(root.childNodes, [pinned, normal]);
  assert.equal(obsolete.parentNode, null);
});

test("unchanged attributes do not cause DOM writes", () => {
  const button = element("BUTTON", { "data-id": "light", class: "btn" }, [text("Light")]);
  const root = element("MAIN", {}, [button]);
  reconcile(root, root.cloneNode(true));
  assert.equal(button.writes, 0);
});

test("performance measurements use bounded aggregates", () => {
  const metrics = {};
  for (let i = 1; i <= 1000; i++) recordTiming(metrics, "render", i);
  recordTiming(metrics, "render", NaN);
  assert.deepEqual(metrics.render, { count: 1000, totalMs: 500500, maxMs: 1000, lastMs: 1000 });
});
