const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function load(data) {
  let modal = null;
  const context = vm.createContext({
    data,
    MONTH_NAMES: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    openModal: (value) => { modal = value; }
  });
  vm.runInContext([
    "const monthKey = (y, m) => `${y}-${String(m + 1).padStart(2, \"0\")}`;",
    section("function fmt(", "/* ---------- data access ---------- */"),
    section("function emptyMonth(", "const getMonth ="),
    section("function monthLabelOf(", "/* ---------- loans / IOUs ---------- */"),
    section("function spentFor(", "// Effective remaining"),
    section("function escapeHtml(", "function openCategoryExpenses("),
    section("/* ---------- category colours", "/* ---------- rendering ---------- */")
  ].join("\n"), context);
  return { context, modal: () => modal };
}

const cat = (id, name, budget, extra = {}) => ({ id, name, emoji: "🛒", budget, override: null, ...extra });
const exp = (catId, date, amount, extra = {}) => ({ catId, date, amount, ...extra });

test("forecast leans on the budget early in the month and on real pace late", () => {
  const { context } = load({ months: {} });
  const early = context.forecastCategory([100], 3000, 2900, 2026, 9, new Date(2026, 9, 1));
  assert.ok(Math.abs(early.future - (100 / 1 / 31 + 3000 / 31 * (30 / 31)) * 30) < 5);
  const late = context.forecastCategory([500, 500, 500, 500], 3000, 1000, 2026, 9, new Date(2026, 9, 30));
  assert.ok(late.future > 60 && late.future < 90, `late future ${late.future}`);
  assert.equal(context.forecastCategory([100], 3000, 2900, 2026, 8, new Date(2026, 9, 5)), null);
});

test("forecast treats one big purchase as a one-off, not a daily rate", () => {
  const { context } = load({ months: {} });
  const f = context.forecastCategory([10000], 10000, 0, 2026, 9, new Date(2026, 9, 2));
  assert.equal(f.future, 0);
  assert.equal(f.projectedRemaining, 0);
});

test("forecastAll flags categories that will run out before month end", () => {
  const month = {
    income: 20000,
    categories: [cat("food", "Food", 3100), cat("fun", "Fun", 1000)],
    expenses: [exp("food", "2026-10-02", 400), exp("food", "2026-10-03", 400), exp("food", "2026-10-04", 400), exp("fun", "2026-10-03", 50)],
    adjustments: []
  };
  const { context } = load({ months: { "2026-10": month } });
  const fc = context.forecastAll(month, "2026-10", new Date(2026, 9, 10));
  assert.equal(fc.atRisk.map((c) => c.id).join(), "food");
  assert.ok(fc.future > 0);
  assert.equal(context.forecastAll(month, "2026-09", new Date(2026, 9, 10)), null);
});

test("wrap-up summarises a finished month and counts the under-budget streak", () => {
  const data = { months: {
    "2026-08": { income: 10000, categories: [cat("food", "Food", 2000)], expenses: [exp("food", "2026-08-05", 1500)], adjustments: [] },
    "2026-09": {
      income: 10000,
      categories: [cat("food", "Food", 2000), cat("fun", "Fun", 500)],
      expenses: [exp("food", "2026-09-05", 1200), exp("fun", "2026-09-06", 300), exp("food", "2026-09-06", 200, { forMonth: "2026-10" })],
      adjustments: []
    },
    "2026-10": { income: 10000, categories: [cat("food", "Food", 2000), cat("fun", "Fun", 500)], expenses: [exp("fun", "2026-10-03", 900)], adjustments: [] }
  } };
  const { context, modal } = load(data);
  const w = context.monthWrapUp("2026-09");
  assert.equal(w.spent, 1500); // the pre-purchase for October is not September cash
  assert.equal(w.withinBudget, true);
  assert.equal(w.saved, 8500);
  assert.equal(w.biggest.amount, 1200);
  assert.equal(w.streak, 2);
  const october = context.monthWrapUp("2026-10");
  assert.equal(october.spent, 1100); // 900 + 200 pre-purchased last month
  assert.equal(october.overs[0].cat.id, "fun");
  context.openWrapUp("2026-10");
  assert.equal(modal().title, "October 2026 wrap-up");
  assert.match(modal().body, /Worth watching/);
});

test("insight charts render for a month with and without data", () => {
  const month = {
    income: 5000, categories: [cat("food", "Food", 3000, { color: "#ff0000" })],
    expenses: [exp("food", "2026-10-02", 300), exp("food", "2026-10-04", 250)], adjustments: []
  };
  const prev = { income: 5000, categories: [cat("food", "Food", 3000)], expenses: [exp("food", "2026-09-10", 1000)], adjustments: [] };
  const { context } = load({ months: { "2026-09": prev, "2026-10": month } });
  assert.match(context.trendChartHtml("2026-10"), /<svg class="trend-svg"/);
  assert.match(context.donutHtml("2026-10"), /#ff0000/);
  assert.match(context.heatmapHtml("2026-10"), /hm-cell/);
  assert.match(context.unusualHtml("2026-10"), /alert-list|Nothing unusual/);
  assert.match(context.donutHtml("2026-11"), /No spending/);
  assert.match(context.trendChartHtml("2026-11"), /<svg/);
});

test("the everyday bucket is not treated as a one-off and feeds wrap-up, donut and alerts", () => {
  const food = cat("food", "Spend", 3000, { everyday: true });
  const rent = cat("rent", "Rent", 8000);
  const month = {
    income: 20000, categories: [food, rent],
    expenses: [exp("food", "2026-10-02", 1600), exp("rent", "2026-10-01", 8000)], adjustments: []
  };
  const { context } = load({ months: { "2026-10": month } });
  const lumpy = context.forecastCategory([1600], 3000, 1400, 2026, 9, new Date(2026, 9, 2));
  const flat = context.forecastCategory([1600], 3000, 1400, 2026, 9, new Date(2026, 9, 2), { lumpy: false });
  assert.equal(lumpy.future < flat.future, true);
  const w = context.monthWrapUp("2026-10");
  assert.equal(w.everyday.spent, 1600);
  assert.equal(w.plannedSpent, 8000);
  assert.match(context.donutHtml("2026-10"), /everyday/);
});

test("an automatic everyday bucket holds income minus the other budgets", () => {
  const month = {
    income: 20000,
    categories: [cat("rent", "Rent", 8000), cat("food", "Spend", 1, { everyday: true, everydayAuto: true }), cat("car", "Car", 3000)],
    expenses: [], adjustments: []
  };
  const { context } = load({ months: { "2026-10": month } });
  const got = context.getMonthFor("2026-10");
  assert.equal(got.categories[1].budget, 9000);
  month.income = 5000; // other budgets exceed income
  assert.equal(context.getMonthFor("2026-10").categories[1].budget, 0);
  const seeded = context.getMonthFor("2026-11");
  assert.equal(seeded.categories[1].everydayAuto, true);
  assert.equal(seeded.categories[1].budget, 0);
});
