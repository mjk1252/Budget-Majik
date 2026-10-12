const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const syncSource = source.slice(source.indexOf("async function persist()"), source.indexOf('$("syncBtn").onclick'));
const copy = (v) => JSON.parse(JSON.stringify(v));
const url = "https://script.google.com/macros/s/test/exec";
const budget = () => ({ updatedAt: 10, months: { "2026-10": {
  income: 5000, categories: [{ id: "food", name: "Food", budget: 3100 }],
  expenses: [{ id: "initial", catId: "food", amount: 100 }]
} } });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function harness(initial = budget(), server = budget()) {
  let remote = copy(server);
  let stored;
  let count = 0;
  const timers = new Map();
  const pushes = [];
  const pulls = [];
  const elements = { syncDot: {}, syncLabel: {} };
  const events = {};
  const hooks = {};
  const bridge = {
    save: async (value) => { stored = copy(value); },
    syncPull: async (endpoint) => {
      pulls.push(endpoint);
      if (hooks.pull) await hooks.pull();
      return copy(remote);
    },
    syncPush: async (endpoint, payload, revision) => {
      pushes.push({ endpoint, payload: copy(payload), revision });
      if (hooks.push) await hooks.push();
      if ((remote.updatedAt || 0) !== revision) {
        const error = new Error("Conflict"); error.code = "SYNC_CONFLICT"; throw error;
      }
      remote = { ...copy(payload), updatedAt: (remote.updatedAt || 0) + 1 };
      if (hooks.afterCommit) await hooks.afterCommit();
      return { ok: true, updatedAt: remote.updatedAt };
    }
  };
  const context = vm.createContext({
    initial: { ...copy(initial), settings: { syncUrl: url, ...copy(initial.settings || {}) } },
    $: (id) => elements[id], render: () => {}, URL,
    console: { error() {} },
    window: { budgetStore: bridge, addEventListener: (name, handler) => { events[name] = handler; } },
    document: { visibilityState: "visible", addEventListener: (name, handler) => { events[name] = handler; } },
    setTimeout: (callback, delay) => { timers.set(++count, { callback, delay }); return count; },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(`let data = initial; ${syncSource}
    globalThis.api = { persist, pushToSheets, pullFromSheets, resetSyncConnection,
      data: () => data, base: () => syncBaseData, busy: () => syncBusy };`, context);
  return {
    api: context.api, pushes, pulls, timers, hooks, events, elements,
    remote: () => copy(remote), stored: () => copy(stored),
    setRemote: (value) => { remote = copy(value); },
    edit: async (fn) => { fn(context.api.data()); await context.api.persist(); },
    flush: async () => context.api.pushToSheets()
  };
}

test("rapid edits are batched, journaled locally, and use the server acknowledgement", async () => {
  const h = harness();
  await h.api.pullFromSheets();
  assert.equal(h.pushes.length, 0);
  for (let i = 0; i < 5; i++) await h.edit((data) => { data.months["2026-10"].income += 100; });
  assert.equal(h.pushes.length, 0);
  assert.equal(h.timers.size, 1);
  assert.equal(h.stored().settings.syncState.pending, true);
  await h.flush();
  assert.equal(h.pushes.length, 1);
  assert.equal(h.remote().months["2026-10"].income, 5500);
  assert.equal(h.pushes[0].payload.settings, undefined);
  assert.equal(h.api.base().updatedAt, 11);
  assert.equal(h.stored().settings.syncState.pending, false);
  assert.equal(h.elements.syncLabel.textContent, "Synced");
});

test("edits during an upload get a subsequent upload without parallel requests", async () => {
  const h = harness();
  await h.api.pullFromSheets();
  await h.edit((data) => { data.months["2026-10"].income = 6000; });
  const gate = deferred();
  const entered = deferred();
  h.hooks.push = async () => { entered.resolve(); await gate.promise; };
  const first = h.flush();
  await entered.promise;
  await h.edit((data) => { data.months["2026-10"].income = 7000; });
  await h.api.pullFromSheets();
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pulls.length, 1);
  gate.resolve();
  await first;
  assert.equal(h.stored().settings.syncState.pending, true);
  await h.flush();
  assert.equal(h.pushes.length, 2);
  assert.equal(h.pushes[1].revision, 11);
  assert.equal(h.remote().months["2026-10"].income, 7000);
});

test("a failed upload retries and offline edits and deletions survive reload with remote additions", async () => {
  const h = harness();
  await h.api.pullFromSheets();
  await h.edit((data) => {
    data.months["2026-10"].expenses = [];
    data.months["2026-10"].categories[0].dailyWeeklySplit = true;
  });
  h.hooks.push = async () => { throw new Error("Failed to fetch"); };
  assert.equal(await h.flush(), false);
  assert.equal([...h.timers.values()][0].delay, 1000);
  const newer = budget();
  newer.updatedAt = 12;
  newer.months["2026-10"].expenses.push({ id: "remote", amount: 250, catId: "food" });
  const reloaded = harness(h.stored(), newer);
  await reloaded.api.pullFromSheets();
  assert.deepEqual(reloaded.remote().months["2026-10"].expenses.map((e) => e.id), ["remote"]);
  assert.equal(reloaded.remote().months["2026-10"].categories[0].dailyWeeklySplit, true);
  assert.equal(reloaded.stored().settings.syncState.pending, false);
});

test("lost acknowledgement is recovered by reading without uploading duplicate purchases", async () => {
  const h = harness();
  await h.api.pullFromSheets();
  await h.edit((data) => { data.months["2026-10"].expenses.push({ id: "new", amount: 250 }); });
  h.hooks.afterCommit = async () => { throw new Error("Sync timed out"); };
  await h.flush();
  await h.flush();
  assert.equal(h.pushes.length, 1);
  assert.equal(h.remote().months["2026-10"].expenses.length, 2);
  assert.equal(h.stored().settings.syncState.pending, false);
  assert.equal(h.elements.syncLabel.textContent, "Synced");
});

test("conflicts reconcile concurrent edits, then retry against the newer revision", async () => {
  const h = harness();
  await h.api.pullFromSheets();
  await h.edit((data) => { data.months["2026-10"].income = 6000; });
  const newer = budget();
  newer.updatedAt = 20;
  newer.months["2026-10"].expenses.push({ id: "remote", amount: 400 });
  h.setRemote(newer);
  assert.equal(await h.flush(), false);
  await h.flush();
  assert.equal(h.remote().months["2026-10"].income, 6000);
  assert.equal(h.remote().months["2026-10"].expenses.length, 2);
  assert.equal(h.pushes[1].revision, 20);
});

test("startup does not upload stale untracked cache, but retains edits made during the first pull", async () => {
  const local = budget();
  local.months["2026-10"].income = 9999;
  const h = harness(local);
  const gate = deferred();
  h.hooks.pull = () => gate.promise;
  const pulling = h.api.pullFromSheets();
  await h.edit((data) => { data.months["2026-10"].categories[0].budget = 4000; });
  gate.resolve();
  await pulling;
  assert.equal(h.remote().months["2026-10"].income, 5000);
  assert.equal(h.remote().months["2026-10"].categories[0].budget, 4000);
});

test("changing the sync endpoint ignores an old response and refreshes the new connection", async () => {
  const h = harness();
  const gate = deferred();
  h.hooks.pull = () => gate.promise;
  const pulling = h.api.pullFromSheets();
  h.api.resetSyncConnection();
  h.api.data().settings.syncUrl = url.replace("test", "another");
  gate.resolve();
  await pulling;
  assert.equal(h.api.base(), null);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 0);
  assert.equal(h.pushes.length, 0);
});

test("invalid server data cannot replace the budget or cause endless retries", async () => {
  const h = harness(budget(), { ok: false, error: "Not authorised" });
  assert.equal(await h.api.pullFromSheets(), false);
  assert.equal(h.api.data().months["2026-10"].income, 5000);
  assert.equal(h.timers.size, 0);
  assert.equal(h.api.busy(), false);
});
