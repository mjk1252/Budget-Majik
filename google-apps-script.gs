/**
 * Budget Majik — Google Sheets sync backend.
 * Paste this whole file into Extensions → Apps Script of a Google Sheet,
 * then deploy as a Web App (see SYNC_SETUP.md).
 *
 * Source of truth is the raw JSON stored in the hidden "_data" sheet.
 * "Overview" and "Expenses" sheets are regenerated on every sync for
 * viewing — edits made directly in those sheets are NOT synced back.
 */

var CHUNK = 40000; // stay under the 50k chars-per-cell limit

function doGet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('_data');
  var json = '{"months":{}}';
  if (sh && sh.getLastRow() > 0) {
    var values = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
    json = values.map(function (r) { return r[0]; }).join('');
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var json = e.postData.contents;
  var data = JSON.parse(json); // throws on bad payload → error returned to app

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('_data') || ss.insertSheet('_data');
  // Reject stale clients rather than silently overwriting newer sheet data.
  // The app supplies the revision it observed on its most recent pull.
  var expected = e.parameter && e.parameter.expectedUpdatedAt;
  if (expected !== undefined && expected !== '') {
    var current = '{"months":{}}';
    if (sh.getLastRow() > 0) {
      current = sh.getRange(1, 1, sh.getLastRow(), 1).getValues()
        .map(function (r) { return r[0]; }).join('');
    }
    var currentData = JSON.parse(current);
    var currentRevision = Number(currentData.updatedAt || 0);
    if (currentRevision !== Number(expected)) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false,
        conflict: true,
        error: 'The Google Sheet changed on another device. Local data was not uploaded.'
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  sh.clearContents();
  var rows = [];
  for (var i = 0; i < json.length; i += CHUNK) rows.push([json.slice(i, i + CHUNK)]);
  sh.getRange(1, 1, rows.length, 1).setValues(rows);
  sh.hideSheet();

  renderReadable(ss, data);

  return ContentService.createTextOutput('{"ok":true}')
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- pretty, read-only views ---------- */

function spentFor(month, catId) {
  return month.expenses.reduce(function (s, ex) {
    return ex.catId === catId ? s + ex.amount : s;
  }, 0);
}

function remainingFor(month, cat) {
  var spent = spentFor(month, cat.id);
  if (cat.override) return cat.override.value - (spent - cat.override.spentAt);
  return cat.budget - spent;
}

// Loans are cash out/in but never touch a category's budget — same rule as renderer/app.js.
function loansLentInMonth(loans, key) {
  return (loans || []).filter(function (l) { return l.date.slice(0, 7) === key; })
    .reduce(function (s, l) { return s + l.amount; }, 0);
}
function loansRepaidInMonth(loans, key) {
  var sum = 0;
  (loans || []).forEach(function (l) {
    (l.repayments || []).forEach(function (r) {
      if (r.date.slice(0, 7) === key) sum += r.amount;
    });
  });
  return sum;
}

function renderReadable(ss, data) {
  var monthKeys = Object.keys(data.months || {}).sort().reverse();

  // --- Overview sheet ---
  var ov = ss.getSheetByName('Overview') || ss.insertSheet('Overview', 0);
  ov.clearContents();
  var rows = [['Month', 'Category', 'Budget', 'Spent', 'Remaining', 'Re-evaluated', '', 'Income', 'Total spent', 'Loans net', 'Adjustments', 'Cash left', 'Adjustment notes']];
  monthKeys.forEach(function (key) {
    var m = data.months[key];
    var totalSpent = m.expenses.reduce(function (s, ex) { return s + ex.amount; }, 0);
    var netLoanCash = loansLentInMonth(data.loans, key) - loansRepaidInMonth(data.loans, key);
    var adjustments = m.adjustments || [];
    var totalAdjustments = adjustments.reduce(function (s, a) { return s + a.amount; }, 0);
    var adjustmentNotes = adjustments.map(function (a) {
      return (a.amount >= 0 ? '+' : '') + a.amount + (a.note ? ' (' + a.note + ')' : '');
    }).join('; ');
    var cashLeft = m.income - totalSpent - netLoanCash + totalAdjustments;
    var first = true;
    m.categories.forEach(function (c) {
      rows.push([
        key, c.name, c.budget, spentFor(m, c.id), remainingFor(m, c),
        c.override ? 'yes' : '',
        '',
        first ? m.income : '', first ? totalSpent : '',
        first ? netLoanCash : '', first ? totalAdjustments : '', first ? cashLeft : '',
        first ? adjustmentNotes : ''
      ]);
      first = false;
    });
    if (!m.categories.length) {
      rows.push([key, '(no categories)', '', '', '', '', '', m.income, totalSpent, netLoanCash, totalAdjustments, cashLeft, adjustmentNotes]);
    }
    rows.push(['', '', '', '', '', '', '', '', '', '', '', '', '']);
  });
  ov.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  ov.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');

  // --- Expenses sheet ---
  var ex = ss.getSheetByName('Expenses') || ss.insertSheet('Expenses');
  ex.clearContents();
  var erows = [['Date', 'Month', 'Category', 'Amount', 'Note']];
  monthKeys.forEach(function (key) {
    var m = data.months[key];
    var cats = {};
    m.categories.forEach(function (c) { cats[c.id] = c.name; });
    m.expenses
      .slice()
      .sort(function (a, b) { return b.date < a.date ? -1 : 1; })
      .forEach(function (e2) {
        erows.push([e2.date, key, cats[e2.catId] || '(deleted)', e2.amount, e2.note || '']);
      });
  });
  ex.getRange(1, 1, erows.length, erows[0].length).setValues(erows);
  ex.getRange(1, 1, 1, erows[0].length).setFontWeight('bold');
}
