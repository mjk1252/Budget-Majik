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

// Run this once from the Apps Script editor, then copy the token from the
// execution log into the iPhone Shortcut. Running it again replaces the token.
function createShortcutToken() {
  var token = Utilities.getUuid() + Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('SHORTCUT_TOKEN', token);
  Logger.log('SHORTCUT_TOKEN=' + token);
}

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

  // Small, locked mutation used by the iPhone Shortcut. Normal app sync posts
  // the complete data object and continues through the code below.
  if (data.action === 'getCategories') return getShortcutCategories_(data);
  if (data.action === 'addExpense') return addShortcutExpense_(data);

  // Keep the revision check and write atomic. Without this lock, two clients
  // can both pass the check and the slower write silently replaces the other.
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('_data') || ss.insertSheet('_data');
    // Reject stale clients rather than silently overwriting newer sheet data.
    // The app supplies the revision it observed on its most recent pull.
    var expected = e.parameter && e.parameter.expectedUpdatedAt;
    if (expected === undefined || expected === '') {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false,
        conflict: true,
        error: 'This client is outdated and may not upload data safely.'
      })).setMimeType(ContentService.MimeType.JSON);
    }
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
    sh.clearContents();
    var rows = [];
    for (var i = 0; i < json.length; i += CHUNK) rows.push([json.slice(i, i + CHUNK)]);
    sh.getRange(1, 1, rows.length, 1).setValues(rows);
    sh.hideSheet();

    renderReadable(ss, data);

    return ContentService.createTextOutput('{"ok":true}')
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

/** Return category names for a month without exposing the rest of the budget. */
function getShortcutCategories_(request) {
  var configuredToken = PropertiesService.getScriptProperties().getProperty('SHORTCUT_TOKEN');
  if (!configuredToken || request.token !== configuredToken) {
    return jsonResponse_({ ok: false, error: 'Not authorised.' });
  }
  var monthKey = String(request.month || '');
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return jsonResponse_({ ok: false, error: 'Invalid month.' });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('_data');
  var stored = readData_(sh);
  stored.months = stored.months || {};
  var month = materializeMonth_(stored, monthKey);
  var names = (month.categories || []).map(function (category) {
    return String(category.name || '').trim();
  }).filter(function (name) { return !!name; });
  return jsonResponse_({ ok: true, categories: names });
}

/** Add one bank transaction, optionally split across multiple categories. */
function addShortcutExpense_(request) {
  var configuredToken = PropertiesService.getScriptProperties().getProperty('SHORTCUT_TOKEN');
  if (!configuredToken || request.token !== configuredToken) {
    return jsonResponse_({ ok: false, error: 'Not authorised.' });
  }

  var amount = money_(request.amount);
  var merchant = String(request.merchant || '').trim();
  var transactionDate = String(request.transactionDate || '');
  var transactionMonth = transactionDate.slice(0, 7);
  var budgetMonth = String(request.budgetMonth || transactionMonth);
  var sourceId = String(request.sourceId || '').trim();
  var splits = request.splits;

  if (!(amount > 0) || !merchant || !/^\d{4}-\d{2}-\d{2}$/.test(transactionDate) ||
      !/^\d{4}-\d{2}$/.test(budgetMonth) || !sourceId || !Array.isArray(splits) || !splits.length) {
    return jsonResponse_({ ok: false, error: 'Missing or invalid transaction details.' });
  }

  var splitTotal = 0;
  for (var i = 0; i < splits.length; i++) {
    splits[i].category = String(splits[i].category || '').trim();
    splits[i].amount = money_(splits[i].amount);
    if (!splits[i].category || !(splits[i].amount > 0)) {
      return jsonResponse_({ ok: false, error: 'Every category split needs a positive amount.' });
    }
    splitTotal += splits[i].amount;
  }
  if (Math.abs(splitTotal - amount) > 0.009) {
    return jsonResponse_({ ok: false, error: 'Category amounts do not add up to the transaction total.' });
  }

  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('_data') || ss.insertSheet('_data');
    var stored = readData_(sh);
    stored.months = stored.months || {};
    var month = materializeMonth_(stored, transactionMonth);

    var duplicate = Object.keys(stored.months).some(function (key) {
      return (stored.months[key].expenses || []).some(function (expense) {
        return expense.shortcutSourceId === sourceId;
      });
    });
    if (duplicate) return jsonResponse_({ ok: true, duplicate: true });

    var addedAt = Date.now();
    for (var j = 0; j < splits.length; j++) {
      var wanted = splits[j].category.toLowerCase();
      var category = (month.categories || []).filter(function (candidate) {
        return String(candidate.name || '').toLowerCase() === wanted;
      })[0];
      if (!category) {
        return jsonResponse_({ ok: false, error: 'Unknown category: ' + splits[j].category });
      }
      var expense = {
        id: Utilities.getUuid(), catId: category.id, amount: splits[j].amount,
        note: merchant, date: transactionDate, createdAt: addedAt,
        shortcutSourceId: sourceId, bankDescription: merchant
      };
      if (budgetMonth !== transactionMonth) expense.forMonth = budgetMonth;
      month.expenses.push(expense);
    }

    stored.updatedAt = Date.now();
    writeData_(sh, stored);
    renderReadable(ss, stored);
    return jsonResponse_({ ok: true, added: splits.length, updatedAt: stored.updatedAt });
  } catch (error) {
    return jsonResponse_({ ok: false, error: String(error.message || error) });
  } finally {
    lock.releaseLock();
  }
}

function money_(value) {
  return Math.round(Number(String(value).replace(/,/g, '')) * 100) / 100;
}

function jsonResponse_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function readData_(sheet) {
  if (!sheet || sheet.getLastRow() < 1) return { months: {} };
  var json = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues()
    .map(function (row) { return row[0]; }).join('');
  return JSON.parse(json || '{"months":{}}');
}

function writeData_(sheet, data) {
  var json = JSON.stringify(data);
  var rows = [];
  for (var i = 0; i < json.length; i += CHUNK) rows.push([json.slice(i, i + CHUNK)]);
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, 1).setValues(rows);
  sheet.hideSheet();
}

function materializeMonth_(data, key) {
  if (data.months[key]) return data.months[key];
  var earlier = Object.keys(data.months).filter(function (candidate) { return candidate < key; }).sort();
  var previous = earlier.length ? data.months[earlier[earlier.length - 1]] : null;
  data.months[key] = previous ? {
    income: previous.income,
    categories: (previous.categories || []).map(function (category) {
      return { id: category.id, name: category.name, emoji: category.emoji,
        budget: category.budget, override: null };
    }),
    expenses: [], adjustments: []
  } : { income: 0, categories: [], expenses: [], adjustments: [] };
  return data.months[key];
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
