const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "mobile", "shim.js"), "utf8");

function browser(fetch) {
  const timers = new Map();
  let next = 0;
  const context = vm.createContext({ window: {}, URL, AbortController, fetch,
    setTimeout: (fn, delay) => { timers.set(++next, { fn, delay }); return next; },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(source, context);
  return { store: context.window.budgetStore, timers };
}
const url = "https://script.google.com/macros/s/test/exec";

test("browser sends expected revision without CORS preflight and reads the server acknowledgement", async () => {
  let request;
  const b = browser(async (target, options) => {
    request = { target, options };
    return { ok: true, json: async () => ({ ok: true, updatedAt: 123 }) };
  });
  const ack = await b.store.syncPush(url, { months: {} }, 10);
  assert.equal(request.target.searchParams.get("expectedUpdatedAt"), "10");
  assert.equal(request.options.headers["Content-Type"], "text/plain");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.redirect, "follow");
  assert.equal(ack.updatedAt, 123);
  assert.equal(b.timers.size, 0);
});

test("a hung request aborts and releases its timeout", async () => {
  const b = browser((target, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("Aborted"); error.name = "AbortError"; reject(error);
    });
  }));
  const pull = b.store.syncPull(url);
  const timer = [...b.timers.values()][0];
  assert.equal(timer.delay, 45000);
  timer.fn();
  await assert.rejects(pull, /Sync timed out/);
  assert.equal(b.timers.size, 0);
});

test("browser distinguishes retryable busy storage from stale revision conflicts", async () => {
  for (const [result, code] of [
    [{ ok: false, retryable: true, error: "Busy" }, "SYNC_TEMPORARY"],
    [{ ok: false, conflict: true, error: "Stale" }, "SYNC_CONFLICT"],
    [null, "SYNC_REJECTED"]
  ]) {
    const b = browser(async () => ({ ok: true, json: async () => result }));
    await assert.rejects(b.store.syncPush(url, { months: {} }, 10), (err) => err.code === code);
    assert.equal(b.timers.size, 0);
  }
});
