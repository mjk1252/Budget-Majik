const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "google-apps-script.gs"), "utf8");
const budget = () => ({ updatedAt: 10, months: { "2026-09": {
  income: 5000, categories: [{ id: "food", name: "Food", budget: 3000, dailyWeeklySplit: true }], expenses: []
} } });

function backend(initial = budget()) {
  let cells = [JSON.stringify(initial)];
  let held = false;
  let maxRows = 1000;
  let flushed = 0;
  let writes = 0;
  let ids = 0;
  const properties = { BUDGET_SPREADSHEET_ID: "sheet-id", SHORTCUT_TOKEN: "token" };
  const switches = { busy: false, failWrite: false };
  const sheet = {
    getLastRow: () => { const last = cells.findLastIndex((s) => s !== ""); return last + 1; },
    getMaxRows: () => maxRows,
    insertRowsAfter: (after, rows) => { maxRows += rows; },
    getRange: (row, column, rows) => ({
      getValues: () => { assert.equal(held, true); return Array.from({ length: rows }, (_, i) => [cells[row - 1 + i] || ""]); },
      setValues: (values) => {
        assert.equal(held, true);
        if (switches.failWrite) throw new Error("Write unavailable");
        writes++;
        values.forEach((value, i) => { cells[row - 1 + i] = value[0]; });
      }
    })
  };
  const context = vm.createContext({
    Date: { now: () => 100 },
    SpreadsheetApp: {
      openById: (id) => { assert.equal(id, "sheet-id"); return {
        getSheetByName: (name) => { assert.equal(name, "_data"); return sheet; },
        insertSheet: () => { throw new Error("Readable sheets should not be created"); }
      }; },
      getActiveSpreadsheet: () => ({ getId: () => "sheet-id" }),
      flush: () => { assert.equal(held, true); flushed++; }
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (switches.busy) return false; assert.equal(held, false); held = true; return true; },
        releaseLock: () => { assert.equal(held, true); held = false; }
      })
    },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (text) => ({ setMimeType: () => JSON.parse(text) }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (name) => properties[name],
      setProperty: (name, value) => { properties[name] = value; }
    }) },
    Utilities: { getUuid: () => `expense-${++ids}` }
  });
  vm.runInContext(source, context);
  return {
    context, switches, properties, read: () => context.doGet(),
    post: (payload, revision) => context.doPost({ postData: { contents: JSON.stringify(payload) }, parameter: { expectedUpdatedAt: revision === undefined ? undefined : String(revision) } }),
    writes: () => writes, flushed: () => flushed, held: () => held, cells: () => [...cells]
  };
}

test("backend stores only JSON and returns monotonically increasing server revisions", () => {
  const b = backend();
  const payload = budget();
  payload.updatedAt = 999999;
  payload.settings = { syncUrl: "private", syncState: { base: budget() } };
  const first = b.post(payload, 10);
  assert.equal(first.ok, true);
  assert.equal(first.updatedAt, 100);
  assert.equal(b.read().settings, undefined);
  const second = b.post(payload, 100);
  assert.equal(second.updatedAt, 101);
  assert.equal(b.flushed(), 2);
  assert.equal(b.held(), false);
});

test("a second stale client cannot overwrite the first writer", () => {
  const b = backend();
  const first = budget();
  first.months["2026-09"].income = 6000;
  assert.equal(b.post(first, 10).ok, true);
  const stale = budget();
  stale.months["2026-09"].income = 7000;
  assert.equal(b.post(stale, 10).conflict, true);
  assert.equal(b.read().months["2026-09"].income, 6000);
  assert.equal(b.writes(), 1);
  assert.equal(b.post(stale).conflict, true);
});

test("multi-cell JSON round-trips and shorter updates erase old trailing chunks", () => {
  const b = backend();
  const big = budget();
  big.notes = "x".repeat(85000);
  assert.equal(b.post(big, 10).ok, true);
  assert.equal(b.cells().length, 3);
  assert.ok(b.cells().every((cell) => cell.startsWith("BUDGET_MAJIK_JSON_V1:")));
  assert.equal(b.read().notes.length, 85000);
  assert.equal(b.post(budget(), 100).ok, true);
  assert.equal(b.cells()[1], "");
  assert.equal(b.cells()[2], "");
  assert.equal(b.read().notes, undefined);
});

test("busy storage and failed writes return retryable errors and preserve previous data", () => {
  const b = backend();
  b.switches.busy = true;
  assert.equal(b.read().retryable, true);
  assert.equal(b.post(budget(), 10).retryable, true);
  b.switches.busy = false;
  b.switches.failWrite = true;
  assert.equal(b.post(budget(), 10).retryable, true);
  assert.equal(b.read().updatedAt, 10);
  assert.equal(b.held(), false);
});

test("shortcut writes share the storage lock, inherit split settings and remain idempotent", () => {
  const b = backend();
  const request = {
    action: "addExpense", token: "token", amount: 100, merchant: "Food shop",
    transactionDate: "2026-10-09", sourceId: "bank-1", splits: [{ category: "Food", amount: 100 }]
  };
  assert.equal(b.post(request).added, 1);
  assert.equal(b.read().months["2026-10"].categories[0].dailyWeeklySplit, true);
  assert.equal(b.read().months["2026-10"].expenses.length, 1);
  assert.equal(b.post(request).duplicate, true);
  assert.equal(b.writes(), 1);
  assert.deepEqual(b.post({ action: "getCategories", token: "token", month: "2026-10" }).categories, ["Food"]);
});

test("malformed requests cannot replace the stored budget", () => {
  const b = backend();
  assert.equal(b.context.doPost({ postData: { contents: "invalid" } }).ok, false);
  assert.equal(b.post({ months: [] }, 10).ok, false);
  assert.equal(b.writes(), 0);
  assert.equal(b.read().updatedAt, 10);
});

test("storage is opened by its saved ID and missing setup returns a clear non-retryable error", () => {
  const b = backend();
  delete b.properties.BUDGET_SPREADSHEET_ID;
  assert.equal(b.read().retryable, false);
  assert.match(b.read().error, /setupStorage/);
  b.context.setupStorage();
  assert.equal(b.properties.BUDGET_SPREADSHEET_ID, "sheet-id");
  assert.equal(b.read().updatedAt, 10);
});
