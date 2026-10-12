const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const balanceStart = source.indexOf("function expectedInBankForMonth(");
const balanceEnd = source.indexOf("function renderBalanceCheck(", balanceStart);
const categoriesStart = source.indexOf("function preferredQuickCategories(");
const categoriesEnd = source.indexOf("function quickEntryUrl(", categoriesStart);

test("balance checks compare cash changes since the previous bank balance without editing budgets", () => {
  const context = vm.createContext({
    data: { balanceChecks: [], months: {} },
    incomingPrepurchases: () => [{ exp: { amount: 50 } }],
    loansLentInMonth: () => 100,
    loansRepaidInMonth: () => 20
  });
  vm.runInContext(source.slice(balanceStart, balanceEnd), context);
  const month = { income: 5000, expenses: [{ amount: 1200 }, { amount: 300, forMonth: "2026-11" }],
    adjustments: [{ amount: 25 }] };
  const initial = context.expectedInBankForMonth(month, "2026-10");
  assert.equal(initial, 3395);
  assert.equal(context.balanceEstimate(null, initial), null);
  context.data.balanceChecks.push({ id: "first", month: "2026-10", actual: 3400,
    modelCash: initial, checkedAt: 1 });
  month.expenses.push({ amount: 150 });
  assert.equal(context.balanceEstimate(context.latestBalanceCheck("2026-10"),
    context.expectedInBankForMonth(month, "2026-10")), 3250);
  assert.equal(context.latestBalanceCheck("2026-11"), null);
  assert.equal(month.income, 5000);
});

test("quick entry suggests frequent categories from recent months", () => {
  const context = vm.createContext({
    data: { months: {
      "2026-10": { expenses: [{ catId: "food" }, { catId: "food" }, { catId: "fuel" }] },
      "2026-09": { expenses: [{ catId: "fuel" }, { catId: "fuel" }, { catId: "old" }] }
    } },
    monthKey: (year, month) => `${year}-${String(month + 1).padStart(2, "0")}`,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [2026, 9, 9])); } }
  });
  vm.runInContext(source.slice(categoriesStart, categoriesEnd), context);
  const categories = [{ id: "food" }, { id: "fuel" }, { id: "rent" }];
  assert.deepEqual(Array.from(context.preferredQuickCategories({ categories }), (cat) => cat.id),
    ["fuel", "food", "rent"]);
});
