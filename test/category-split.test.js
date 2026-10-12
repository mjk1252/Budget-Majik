const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const start = source.indexOf("function categorySplit(");
const end = source.indexOf("/* ---------- rendering ---------- */", start);
const fmtStart = source.indexOf("function fmt(");
const fmtEnd = source.indexOf("/* ---------- data access ---------- */", fmtStart);
const { categorySplit, splitDetailsHtml } = new Function(
  `${source.slice(fmtStart, fmtEnd)}\n${source.slice(start, end)}\nreturn { categorySplit, splitDetailsHtml };`
)();

test("splits 28, 29, 30 and 31-day months into equal daily and seven-day allowances", () => {
  for (const [year, month, days] of [[2026, 1, 28], [2028, 1, 29], [2026, 3, 30], [2026, 9, 31]]) {
    const split = categorySplit(year, month, days * 100, 0, days * 100, new Date(year, month, 1));
    assert.equal(split.days, days);
    assert.equal(split.daily, 100);
    assert.equal(split.weekly, 700);
    assert.equal(split.fullWeeks, 4);
    assert.equal(split.extraDays, days - 28);
    assert.equal(split.fullWeeks * split.weekly + split.partialWeek, days * 100);
  }
});

test("early savings raise the daily allowance and spending estimates purchase days", () => {
  const split = categorySplit(2026, 9, 3100, 500, 2600, new Date(2026, 9, 11));
  assert.equal(split.daysRemaining, 21);
  assert.equal(split.adjustedDaily, 2600 / 21);
  assert.ok(split.adjustedDaily > split.daily);
  assert.equal(split.expectedSpent, 1100);
  assert.equal(split.paceDifference, 600);
  assert.equal(split.spentDays, 5);
  assert.equal(split.remainingDays, 26);
});

test("spending ahead shows days bought ahead and preserves the original daily rate", () => {
  const now = new Date(2026, 9, 11);
  const ahead = categorySplit(2026, 9, 3100, 1500, 1600, now);
  assert.equal(ahead.adjustedDaily, ahead.daily);
  assert.equal(ahead.paceDifference, -400);
  assert.equal(ahead.spentDays, 15);
  assert.equal(ahead.coverageDays, 5);
  const aheadHtml = splitDetailsHtml(ahead, { budget: 3100 }, 1600);
  assert.match(aheadHtml, /4 days' worth bought ahead/);
  assert.match(aheadHtml, /About 5 days of purchases left/);
  const over = categorySplit(2026, 9, 3100, 3200, -100, now);
  assert.equal(over.adjustedDaily, 100);
  assert.equal(over.spentDays, 32);
  assert.equal(over.coverageDays, 22);
  assert.equal(over.remainingDays, 0);
  assert.match(splitDetailsHtml(over, { budget: 3100 }, -100), /Budget exhausted/);
  assert.match(splitDetailsHtml(over, { budget: 3100 }, -100), /1 day's worth extra/);
});

test("today is included on the first and last day, and ended months have no daily allowance", () => {
  assert.equal(categorySplit(2026, 9, 3100, 0, 3100, new Date(2026, 9, 1)).adjustedDaily, 100);
  const last = categorySplit(2026, 9, 3100, 2800, 300, new Date(2026, 9, 31));
  assert.equal(last.daysRemaining, 1);
  assert.equal(last.adjustedDaily, 300);
  const past = categorySplit(2026, 9, 3100, 2800, 300, new Date(2026, 10, 1));
  assert.equal(past.daysRemaining, 0);
  assert.equal(past.adjustedDaily, null);
  assert.equal(past.expectedSpent, 3100);
  assert.match(splitDetailsHtml(past, { budget: 3100 }, 300), /Month ended/);
  const future = categorySplit(2027, 0, 3100, 700, 2400, new Date(2026, 11, 31));
  assert.equal(future.daysRemaining, 31);
  assert.equal(future.adjustedDaily, 100);
  assert.equal(future.coverageDays, 7);
  assert.equal(future.elapsed, 0);
});

test("zero budgets avoid undefined coverage and render without Infinity or NaN", () => {
  const split = categorySplit(2026, 9, 0, 50, -50, new Date(2026, 9, 11));
  assert.equal(split.spentDays, null);
  assert.equal(split.remainingDays, null);
  assert.equal(split.adjustedDaily, 0);
  assert.doesNotMatch(splitDetailsHtml(split, { budget: 0 }, -50), /Infinity|NaN/);
});

test("inherited settings, allocated pre-purchases and overrides feed the daily allowance", () => {
  const accessStart = source.indexOf("function emptyMonth(");
  const accessEnd = source.indexOf("/* ---------- recurring expenses ---------- */", accessStart);
  const derivedStart = source.indexOf("function spentFor(");
  const context = vm.createContext({});
  vm.runInContext(`
    let data = { months: { "2026-09": {
      income: 5000,
      categories: [{ id: "food", budget: 3100, dailyWeeklySplit: true, override: { value: 1000, spentAt: 0 } }],
      expenses: []
    } } };
    const currentKey = () => "2026-10";
    const incomingPrepurchases = () => [{ exp: { catId: "food", amount: 200 } }];
    ${source.slice(accessStart, accessEnd)}
    ${source.slice(derivedStart, end)}
    const month = editMonthFor("2026-10");
    const cat = month.categories[0];
    globalThis.inheritedSplit = cat.dailyWeeklySplit;
    globalThis.inheritedOverride = cat.override;
    month.expenses.push({ catId: "food", amount: 300 });
    month.expenses.push({ catId: "food", amount: 700, forMonth: "2026-11" });
    cat.override = { value: 1800, spentAt: 500 };
    month.expenses.push({ catId: "food", amount: 100 });
    globalThis.spent = spentFor(month, cat.id);
    globalThis.remaining = remainingFor(month, cat);
    globalThis.split = categorySplit(2026, 9, cat.budget, spent, remaining, new Date(2026, 9, 11));
  `, context);
  assert.equal(context.inheritedSplit, true);
  assert.equal(context.inheritedOverride, null);
  assert.equal(context.spent, 600);
  assert.equal(context.remaining, 1700);
  assert.equal(context.split.adjustedDaily, 100);
  assert.equal(context.split.daily, 100);
});

test("category toggle renders the split and saves both enabling and disabling", () => {
  const elements = { catList: { innerHTML: "", appendChild(row) { this.row = row; } }, catEmpty: {} };
  const cat = { id: "food", name: "Food", budget: 3100, dailyWeeklySplit: false };
  const month = { categories: [cat] };
  let saves = 0;
  const context = vm.createContext({
    $: (id) => elements[id], viewYear: 2026, viewMonth: 9,
    currentKey: () => "2026-10", incomingPrepurchases: () => [],
    spentFor: () => 500, remainingFor: () => 2600,
    escapeHtml: (s) => s, openCategoryModal: () => {}, openReevalModal: () => {},
    editMonth: () => month, persist: () => { saves++; },
    document: { createElement: () => ({
      innerHTML: "", handlers: {},
      querySelector(selector) { return this.handlers[selector] ||= {}; }
    }) }
  });
  const renderStart = source.indexOf("function renderCategories(");
  const renderEnd = source.indexOf('let expenseFilter = "";', renderStart);
  vm.runInContext(`${source.slice(fmtStart, fmtEnd)}\n${source.slice(start, end)}\n${source.slice(renderStart, renderEnd)}`, context);
  context.renderCategories(month);
  assert.doesNotMatch(elements.catList.row.innerHTML, /split-details/);
  elements.catList.row.handlers['[data-act="split"]'].onchange({ target: { checked: true } });
  assert.equal(cat.dailyWeeklySplit, true);
  assert.equal(saves, 1);
  context.renderCategories(month);
  assert.match(elements.catList.row.innerHTML, /split-details/);
  assert.match(elements.catList.row.innerHTML, /31 days · 4 weeks \+ 3 days/);
  assert.match(elements.catList.row.innerHTML, /data-act="split" checked/);
  elements.catList.row.handlers['[data-act="split"]'].onchange({ target: { checked: false } });
  assert.equal(cat.dailyWeeklySplit, false);
  assert.equal(saves, 2);
});
