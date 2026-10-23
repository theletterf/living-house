import assert from "node:assert/strict";
import test from "node:test";
import { loadEngine, DEFAULT_GUIDANCE, INTENSITIES } from "./adapters.js";

function fixture(create) {
  const listeners = new Map();
  const worker = {
    terminated: false,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    terminate() { this.terminated = true; },
    emit: (type, event) => listeners.get(type)?.(event),
  };
  const calls = [];
  const model = {
    chat: { completions: { create: async (request) => {
      calls.push(request);
      return { choices: [{ message: { content: '{"changes":[]}' }, finish_reason: "stop" }], usage: {} };
    } } },
    interruptGenerate() { this.interrupted = true; },
    async unload() { this.unloaded = true; },
  };
  const dependencies = {
    makeWorker: () => worker,
    loadRuntime: async () => ({ CreateWebWorkerMLCEngine: create ?? (async (received, key, config) => {
      assert.equal(received, worker);
      assert.equal(key, "Qwen2.5-0.5B-Instruct-q4f16_1-MLC");
      config.initProgressCallback({ text: "Ready" });
      return model;
    }) }),
  };
  return { worker, calls, model, dependencies };
}
const key = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
const ctx = () => ({
  config: { prompt: DEFAULT_GUIDANCE, ops: ["hint"], temperature: 0.2 },
  level: INTENSITIES.extreme, about: "Test", view: "overview", recent: [],
  elements: [{ id: "a", kind: "action", page: "overview", text: "Action", desc: "Test action" }],
});

test("the worker proxy handles inference, progress, interruption and cleanup", async () => {
  const f = fixture();
  const progress = [];
  const engine = await loadEngine(key, (text) => progress.push(text), f.dependencies);
  assert.deepEqual(progress, ["Ready"]);
  const result = await engine.propose(ctx());
  assert.deepEqual(result.changes, []);
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.calls[0].response_format.schema).properties.changes.maxItems, 1);
  engine.interrupt();
  assert.equal(f.model.interrupted, true);
  await engine.unload();
  assert.equal(f.model.unloaded, true);
  assert.equal(f.worker.terminated, true);
});

test("a worker startup error rejects loading instead of leaving it stuck", async () => {
  const f = fixture(() => new Promise(() => {}));
  const loading = loadEngine(key, () => {}, f.dependencies);
  await Promise.resolve();
  f.worker.emit("error", { message: "Worker module could not load" });
  await assert.rejects(loading, /Worker module could not load/);
  assert.equal(f.worker.terminated, true);
});

test("a worker failure rejects active inference and still permits cleanup", async () => {
  const f = fixture();
  const engine = await loadEngine(key, () => {}, f.dependencies);
  f.model.chat.completions.create = () => new Promise(() => {});
  const pending = engine.propose(ctx());
  f.worker.emit("error", { message: "Worker stopped" });
  await assert.rejects(pending, /Worker stopped/);
  await engine.unload();
  assert.equal(f.worker.terminated, true);
});

test("an idle worker error is reported on its next operation", async () => {
  const f = fixture();
  const engine = await loadEngine(key, () => {}, f.dependencies);
  f.worker.emit("messageerror", {});
  await assert.rejects(engine.propose(ctx()), /local model worker stopped/);
  await engine.unload();
});

test("schema remains stable while prompt targets change", async () => {
  const f = fixture();
  const engine = await loadEngine(key, () => {}, f.dependencies);
  const base = ctx();
  const schemaElements = [{ id: "a", kind: "action" }, { id: "b", kind: "nav" }];
  await engine.propose({ ...base, schemaElements });
  await engine.propose({ ...base, schemaElements, view: "other", elements: [{ id: "b", kind: "nav", page: "all", text: "Other", desc: "Other page" }] });
  assert.equal(f.calls[0].response_format.schema, f.calls[1].response_format.schema);
  assert.notEqual(f.calls[0].messages[1].content, f.calls[1].messages[1].content);
  await engine.unload();
});


test("automatic style schema excludes disruptive properties while requests retain them", async () => {
  const f = fixture();
  const engine = await loadEngine(key, () => {}, f.dependencies);
  const base = ctx();
  base.config.ops = ["style"];
  await engine.propose(base);
  await engine.propose({ ...base, request: { text: "Hide this", id: "a" } });
  const automatic = JSON.parse(f.calls[0].response_format.schema).properties.changes.items.properties.property.enum;
  const requested = JSON.parse(f.calls[1].response_format.schema).properties.changes.items.properties.property.enum;
  assert.ok(!automatic.includes("display"));
  assert.ok(!automatic.includes("opacity"));
  assert.ok(automatic.includes("font-size"));
  assert.ok(requested.includes("display"));
  await engine.unload();
});
