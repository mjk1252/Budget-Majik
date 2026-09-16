const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const helperStart = appSource.indexOf("function cloneSyncValue");
const helperEnd = appSource.indexOf("function syncUrl", helperStart);
const mergeSyncValue = new Function(
  `${appSource.slice(helperStart, helperEnd)}; return mergeSyncValue;`
)();

function budget() {
  return {
    updatedAt: 1,
    months: {
      "2026-09": {
        income: 100,
        categories: [{ id: "category-1", name: "Food", budget: 50 }],
        expenses: [{ id: "expense-1", amount: 10, catId: "category-1" }],
        adjustments: []
      }
    }
  };
}

test("keeps a local field edit and a remotely added expense", () => {
  const base = budget();
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.months["2026-09"].income = 120;
  remote.months["2026-09"].expenses.push({ id: "expense-2", amount: 20, catId: "category-1" });

  const merged = mergeSyncValue(base, local, remote);

  assert.equal(merged.months["2026-09"].income, 120);
  assert.deepEqual(merged.months["2026-09"].expenses.map((item) => item.id), ["expense-1", "expense-2"]);
});

test("combines records independently added by two website sessions", () => {
  const base = budget();
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local.months["2026-09"].expenses.push({ id: "local", amount: 15 });
  remote.months["2026-09"].expenses.push({ id: "remote", amount: 25 });

  const merged = mergeSyncValue(base, local, remote);

  assert.deepEqual(merged.months["2026-09"].expenses.map((item) => item.id), ["expense-1", "remote", "local"]);
});

test("keeps a deletion when the other session did not change that record", () => {
  const base = budget();
  const local = structuredClone(base);
  local.months["2026-09"].expenses = [];

  const merged = mergeSyncValue(base, local, structuredClone(base));

  assert.deepEqual(merged.months["2026-09"].expenses, []);
});

test("Google Apps Script backend remains valid JavaScript", () => {
  const backend = fs.readFileSync(path.join(__dirname, "..", "google-apps-script.gs"), "utf8");
  assert.doesNotThrow(() => new Function(backend));
});
