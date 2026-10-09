/**
 * Budget Majik — Google Sheets sync backend.
 * Paste this whole file into Extensions → Apps Script of a Google Sheet,
 * then deploy as a Web App (see SYNC_SETUP.md).
 *
 * Source of truth is the raw JSON stored in the "_data" sheet.
 * Only JSON storage is updated. Existing readable tabs are left untouched.
 */

var CHUNK = 40000; // stay under the 50k chars-per-cell limit
var STORAGE_PREFIX = 'BUDGET_MAJIK_JSON_V1:'; // chunks must never be interpreted as Sheet formulas

// Run once in the editor opened from the budget spreadsheet. Web-app
// requests cannot depend on there being an active spreadsheet.
function setupStorage() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Open Apps Script from the budget spreadsheet, then run setupStorage.');
  PropertiesService.getScriptProperties().setProperty('BUDGET_SPREADSHEET_ID', spreadsheet.getId());
}

function storageSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('BUDGET_SPREADSHEET_ID');
  if (!id) {
    var error = new Error('Storage not configured. Run setupStorage in the Apps Script editor.');
    error.retryable = false;
    throw error;
  }
  return SpreadsheetApp.openById(id);
}

// Run this once from the Apps Script editor, then copy the token from the
// execution log into the iPhone Shortcut. Running it again replaces the token.
function createShortcutToken() {
  var token = Utilities.getUuid() + Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('SHORTCUT_TOKEN', token);
  Logger.log('SHORTCUT_TOKEN=' + token);
}

function doGet() {
  return withStorageLock_(function () {
    var ss = storageSpreadsheet_();
    return jsonResponse_(readData_(ss.getSheetByName('_data')));
  });
}

function doPost(e) {
  var data;
  try {
    data = JSON.parse(e.postData.contents);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid payload.');
  } catch (error) {
    return jsonResponse_({ ok: false, error: 'Invalid JSON payload.' });
  }

  // Small, locked mutation used by the iPhone Shortcut. Normal app sync posts
  // the complete data object and continues through the code below.
  if (data.action === 'getCategories') return getShortcutCategories_(data);
  if (data.action === 'addExpense') return addShortcutExpense_(data);

  // Keep the revision check and write atomic. Without this lock, two clients
  // can both pass the check and the slower write silently replaces the other.
  if (!data.months || typeof data.months !== 'object' || Array.isArray(data.months)) {
    return jsonResponse_({ ok: false, error: 'Missing budget months.' });
  }
  return withStorageLock_(function () {
    var ss = storageSpreadsheet_();
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
    var currentData = readData_(sh);
    var currentRevision = Number(currentData.updatedAt || 0);
    if (currentRevision !== Number(expected)) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false,
        conflict: true,
        error: 'The Google Sheet changed on another device. Local data was not uploaded.'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    // The server assigns a unique increasing revision, even when devices have
    // different clocks or two requests arrive within the same millisecond.
    data.updatedAt = Math.max(Date.now(), currentRevision + 1);
    delete data.settings;
    writeData_(sh, data);
    return jsonResponse_({ ok: true, updatedAt: data.updatedAt });
  });
}

function withStorageLock_(callback) {
  var lock = LockService.getScriptLock();
  var acquired = false;
  try {
    acquired = lock.tryLock(10000);
    if (!acquired) return jsonResponse_({ ok: false, retryable: true, error: 'Storage busy. Try again.' });
    return callback();
  } catch (error) {
    return jsonResponse_({ ok: false, retryable: error.retryable !== false, error: String(error.message || error) });
  } finally {
    if (acquired) lock.releaseLock();
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

  return withStorageLock_(function () {
    var ss = storageSpreadsheet_();
    var stored = readData_(ss.getSheetByName('_data'));
    stored.months = stored.months || {};
    var month = materializeMonth_(stored, monthKey);
    var names = (month.categories || []).map(function (category) {
      return String(category.name || '').trim();
    }).filter(function (name) { return !!name; });
    return jsonResponse_({ ok: true, categories: names });
  });
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

  return withStorageLock_(function () {
    var ss = storageSpreadsheet_();
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

    stored.updatedAt = Math.max(Date.now(), Number(stored.updatedAt || 0) + 1);
    delete stored.settings;
    writeData_(sh, stored);
    return jsonResponse_({ ok: true, added: splits.length, updatedAt: stored.updatedAt });
  });
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
  var values = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  var prefixed = String(values[0][0]).indexOf(STORAGE_PREFIX) === 0;
  var json = values.map(function (row) {
    var value = String(row[0]);
    if (!value) return '';
    if (!prefixed) return value; // old deployments stored unprefixed JSON
    if (value.indexOf(STORAGE_PREFIX) !== 0) throw new Error('Invalid stored JSON chunk.');
    return value.slice(STORAGE_PREFIX.length);
  }).join('');
  return JSON.parse(json || '{"months":{}}');
}

function writeData_(sheet, data) {
  var json = JSON.stringify(data);
  var rows = [];
  for (var i = 0; i < json.length; i += CHUNK) rows.push([STORAGE_PREFIX + json.slice(i, i + CHUNK)]);
  // Replace the old chunks and trailing cells in one range write. Never
  // clear the previous JSON before the replacement is ready to be written.
  var rowCount = Math.max(rows.length, sheet.getLastRow());
  while (rows.length < rowCount) rows.push(['']);
  if (rowCount > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), rowCount - sheet.getMaxRows());
  sheet.getRange(1, 1, rows.length, 1).setValues(rows);
  SpreadsheetApp.flush();
}

function materializeMonth_(data, key) {
  if (data.months[key]) return data.months[key];
  var earlier = Object.keys(data.months).filter(function (candidate) { return candidate < key; }).sort();
  var previous = earlier.length ? data.months[earlier[earlier.length - 1]] : null;
  data.months[key] = previous ? {
    income: previous.income,
    categories: (previous.categories || []).map(function (category) {
      return { id: category.id, name: category.name, emoji: category.emoji,
        budget: category.budget, dailyWeeklySplit: !!category.dailyWeeklySplit, override: null };
    }),
    expenses: [], adjustments: []
  } : { income: 0, categories: [], expenses: [], adjustments: [] };
  return data.months[key];
}
