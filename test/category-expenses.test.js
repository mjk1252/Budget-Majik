const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test("category details follow the selected month and match its allocated spend", () => {
  let selected = "2026-10";
  let modal;
  const data = { months: {
    "2026-09": { expenses: [{ catId: "food", note: "Bought early", date: "2026-09-25", forMonth: "2026-10", amount: 50 }] },
    "2026-10": { expenses: [
      { catId: "food", note: "<Groceries>", date: "2026-10-03", amount: 100 },
      { catId: "fuel", note: "Petrol", date: "2026-10-04", amount: 500 },
      { catId: "food", note: "Next month", date: "2026-10-05", forMonth: "2026-11", amount: 200 }
    ] },
    "2026-11": { expenses: [] }
  } };
  const context = vm.createContext({
    data, MONTH_NAMES: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    currentKey: () => selected, getMonth: () => data.months[selected], openModal: (value) => { modal = value; }
  });
  vm.runInContext([
    section("function fmt(", "const localDate"),
    section("function monthLabelOf(", "/* ---------- loans / IOUs ---------- */"),
    section("function spentFor(", "// Effective remaining"),
    section("function escapeHtml(", "/* ---------- modal machinery ---------- */")
  ].join("\n"), context);
  context.openCategoryExpenses({ id: "food", name: "Food" });
  assert.equal(modal.title, "Food · October 2026");
  assert.match(modal.body, /2 expenses · Total spent<\/span><b>R150/);
  assert.match(modal.body, /&lt;Groceries&gt;/);
  assert.match(modal.body, /Bought early/);
  assert.match(modal.body, /Pre-purchased/);
  assert.match(modal.body, /For November 2026/);
  assert.doesNotMatch(modal.body, /Petrol/);
  selected = "2026-11";
  context.openCategoryExpenses({ id: "food", name: "Food" });
  assert.equal(modal.title, "Food · November 2026");
  assert.match(modal.body, /1 expense · Total spent<\/span><b>R200/);
  assert.doesNotMatch(modal.body, /Groceries|Bought early/);
  context.openCategoryExpenses({ id: "fuel", name: "Fuel" });
  assert.match(modal.body, /No expenses in this category for November 2026/);
  assert.match(modal.body, /<b>R0<\/b>/);
});
