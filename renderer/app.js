/* ============ Budget Majik — app logic ============ */

let data = { months: {} };
let viewYear, viewMonth; // viewMonth: 0-11

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const MONTH_NAMES = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];

const monthKey = (y, m) => `${y}-${String(m + 1).padStart(2, "0")}`;
const currentKey = () => monthKey(viewYear, viewMonth);

function fmt(n) {
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(n);
  const str = abs % 1 === 0
    ? abs.toLocaleString("en-US")
    : abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}R${str}`;
}

/* ---------- data access ---------- */

function emptyMonth() {
  return { income: 0, categories: [], expenses: [], adjustments: [] };
}

// Find the latest saved month strictly before the given key, to inherit from.
function previousMonthData(key) {
  const keys = Object.keys(data.months).filter((k) => k < key).sort();
  if (!keys.length) return null;
  return data.months[keys[keys.length - 1]];
}

// Get a month for viewing. If it doesn't exist, build an in-memory seed that
// inherits budgets + income from the most recent earlier month. Not saved
// until the user actually changes something.
function getMonthFor(key) {
  if (data.months[key]) return data.months[key];
  const prev = previousMonthData(key);
  if (!prev) return emptyMonth();
  return {
    income: prev.income,
    categories: prev.categories.map((c) => ({
      id: c.id, name: c.name, emoji: c.emoji, budget: c.budget,
      dailyWeeklySplit: !!c.dailyWeeklySplit, override: null
    })),
    expenses: [],
    adjustments: []
  };
}
const getMonth = () => getMonthFor(currentKey());

// Get a month for mutation: materialize the seed into data, then save after.
function editMonthFor(key) {
  if (!data.months[key]) data.months[key] = getMonthFor(key);
  return data.months[key];
}
const editMonth = () => editMonthFor(currentKey());

/* ---------- recurring expenses ---------- */

// Auto-log recurring items into the real current month once their day of the
// month has arrived. Runs at boot and after each render tick of the app.
function applyRecurring() {
  if (!data.recurring || !data.recurring.length) return false;
  const now = new Date();
  const key = monthKey(now.getFullYear(), now.getMonth());
  let changed = false;
  for (const item of data.recurring) {
    if (item.day > now.getDate()) continue;
    const month = editMonthFor(key);
    if (month.expenses.some((e) => e.recurringId === item.id)) continue;
    const cat = month.categories.find((c) => c.id === item.catId)
      || month.categories.find((c) => c.name.toLowerCase() === (item.catName || "").toLowerCase());
    if (!cat) continue;
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const day = Math.min(item.day, daysInMonth);
    month.expenses.push({
      id: uid(), catId: cat.id, amount: item.amount, note: item.note,
      date: `${key}-${String(day).padStart(2, "0")}`,
      createdAt: Date.now(), recurringId: item.id
    });
    changed = true;
  }
  return changed;
}

// Migrate pre-purchased expenses into their target month's real expense list
// once the 1st of that month has arrived. Before that, they stay in the
// purchase month with a `forMonth` flag and are only virtually attributed to
// the target month (see incomingPrepurchases). Runs at boot, same as recurring.
function applyPrepurchases() {
  const now = new Date();
  let changed = false;
  for (const key of Object.keys(data.months)) {
    const month = data.months[key];
    if (!month.expenses.some((e) => e.forMonth)) continue;
    const keep = [];
    for (const exp of month.expenses) {
      if (exp.forMonth && now >= firstOfMonthDate(exp.forMonth)) {
        const target = editMonthFor(exp.forMonth);
        delete exp.forMonth;
        exp.prepurchased = true;
        target.expenses.push(exp);
        changed = true;
      } else {
        keep.push(exp);
      }
    }
    month.expenses = keep;
  }
  return changed;
}

async function persist() {
  data.updatedAt = Math.max(Date.now(), (data.updatedAt || 0) + 1);
  rememberSyncState(true);
  await window.budgetStore.save(data);
  render();
  scheduleSync();
}

/* ---------- Google Sheets sync ---------- */

let syncBusy = false;
let syncQueued = false;
let syncReady = false;
let syncRemoteUpdatedAt = null;
let syncBaseData = null;
let syncNeedsPull = true;
let syncTimer = null;
let syncRetryCount = 0;
let syncEpoch = 0;

function cloneSyncValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sameSyncValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSyncObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Reconcile local edits with a newer Sheet revision. Records with stable ids
// (expenses, categories, loans, etc.) can be added independently on both
// devices. If both devices edit the same field, this device's value wins.
function mergeSyncValue(base, local, remote) {
  if (sameSyncValue(local, base)) return cloneSyncValue(remote);
  if (sameSyncValue(remote, base) || sameSyncValue(local, remote)) return cloneSyncValue(local);

  if (Array.isArray(local) && Array.isArray(remote)) {
    const all = [...(Array.isArray(base) ? base : []), ...local, ...remote];
    const recordsById = all.every((item) => isSyncObject(item) && item.id != null);
    if (!recordsById) return cloneSyncValue(local);

    const baseMap = new Map((Array.isArray(base) ? base : []).map((item) => [String(item.id), item]));
    const localMap = new Map(local.map((item) => [String(item.id), item]));
    const remoteMap = new Map(remote.map((item) => [String(item.id), item]));
    const order = [...remote, ...local].map((item) => String(item.id));
    return [...new Set(order)].flatMap((id) => {
      const hadBase = baseMap.has(id);
      const hasLocal = localMap.has(id);
      const hasRemote = remoteMap.has(id);
      if (!hasLocal && !hasRemote) return [];
      if (!hasLocal) {
        return hadBase && sameSyncValue(remoteMap.get(id), baseMap.get(id))
          ? [] : [cloneSyncValue(remoteMap.get(id))];
      }
      if (!hasRemote) {
        return hadBase && sameSyncValue(localMap.get(id), baseMap.get(id))
          ? [] : [cloneSyncValue(localMap.get(id))];
      }
      return [mergeSyncValue(baseMap.get(id), localMap.get(id), remoteMap.get(id))];
    });
  }

  if (isSyncObject(local) && isSyncObject(remote)) {
    const baseObject = isSyncObject(base) ? base : {};
    const merged = {};
    const keys = new Set([...Object.keys(baseObject), ...Object.keys(remote), ...Object.keys(local)]);
    for (const key of keys) {
      const hadBase = Object.prototype.hasOwnProperty.call(baseObject, key);
      const hasLocal = Object.prototype.hasOwnProperty.call(local, key);
      const hasRemote = Object.prototype.hasOwnProperty.call(remote, key);
      if (!hasLocal && !hasRemote) continue;
      if (!hasLocal) {
        if (!hadBase || !sameSyncValue(remote[key], baseObject[key])) merged[key] = cloneSyncValue(remote[key]);
        continue;
      }
      if (!hasRemote) {
        if (!hadBase || !sameSyncValue(local[key], baseObject[key])) merged[key] = cloneSyncValue(local[key]);
        continue;
      }
      merged[key] = mergeSyncValue(baseObject[key], local[key], remote[key]);
    }
    return merged;
  }

  return cloneSyncValue(local);
}

function syncUrl() {
  return (data.settings && data.settings.syncUrl) || "";
}

// Sync bookkeeping and connection settings stay in this browser only.
function syncPayload(value = data) {
  const payload = cloneSyncValue(value);
  delete payload.settings;
  return payload;
}

function sameSyncContent(left, right) {
  const a = syncPayload(left);
  const b = syncPayload(right);
  delete a.updatedAt;
  delete b.updatedAt;
  return sameSyncValue(a, b);
}

function rememberSyncState(pending) {
  if (!syncUrl()) return;
  if (!data.settings) data.settings = {};
  // Before the first pull, retain the last acknowledged base from storage.
  const previous = data.settings.syncState;
  data.settings.syncState = {
    url: syncUrl(), pending,
    base: syncBaseData || (previous && previous.url === syncUrl() ? previous.base : null)
  };
}

function scheduleSync(delay = 700) {
  if (!syncUrl()) return;
  syncQueued = true;
  clearTimeout(syncTimer);
  setSyncStatus("busy", "Saved locally · pending sync");
  syncTimer = setTimeout(() => { syncTimer = null; pushToSheets(); }, delay);
}

function resetSyncConnection() {
  syncEpoch++;
  clearTimeout(syncTimer);
  syncTimer = null;
  syncReady = false;
  syncNeedsPull = true;
  syncRetryCount = 0;
  syncBaseData = null;
  syncRemoteUpdatedAt = null;
  syncQueued = false;
}

function validateSyncData(value) {
  if (!isSyncObject(value) || !isSyncObject(value.months) || value.ok === false) {
    const err = new Error(value && value.error || "Invalid sync response");
    err.code = value && value.retryable ? "SYNC_TEMPORARY" : "SYNC_REJECTED";
    throw err;
  }
  return syncPayload(value);
}

function setSyncStatus(state, label) {
  $("syncDot").className = "sync-dot " + (state || "");
  $("syncLabel").textContent = label || "Sync";
}

function syncErrorLabel(err) {
  const message = String((err && err.message) || err || "");
  if (/Storage not configured/i.test(message)) return "Sync: run setupStorage";
  if (/HTTP 401|HTTP 403/i.test(message)) return "Sync: check /exec URL";
  if (/HTTP 404/i.test(message)) return "Sync: URL not found";
  if (/Failed to fetch|NetworkError|fetch failed/i.test(message)) return "Sync: network blocked";
  return "Sync failed";
}

function isAppsScriptExecUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "script.google.com" &&
      /\/macros\/s\/[^/]+\/exec\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

async function pushToSheets() {
  if (!syncUrl()) return;
  if (syncBusy) { syncQueued = true; return; }
  clearTimeout(syncTimer);
  syncTimer = null;
  syncBusy = true;
  syncQueued = false;
  const url = syncUrl();
  const epoch = syncEpoch;
  const active = () => epoch === syncEpoch && url === syncUrl();
  let retryDelay = null;
  setSyncStatus("busy", "Syncing…");
  try {
    if (syncNeedsPull || !syncReady) {
      syncNeedsPull = false;
      const beforePull = syncPayload();
      const saved = data.settings && data.settings.syncState;
      const base = syncBaseData || (saved && saved.url === url && saved.base);
      const remote = validateSyncData(await window.budgetStore.syncPull(url));
      if (!active()) return false;
      const hasRemote = Object.keys(remote.months).length > 0 || (remote.updatedAt || 0) > 0;
      const settings = data.settings;
      // A saved base lets offline changes/deletions survive a reload. Without
      // one, retain only changes made while this first pull was in flight.
      if (hasRemote) {
        const mergeBase = base || (saved && saved.url === url && saved.pending ? { months: {} } : beforePull);
        data = mergeSyncValue(mergeBase, syncPayload(), remote);
        data.settings = settings;
      }
      syncBaseData = remote;
      syncRemoteUpdatedAt = remote.updatedAt || 0;
      syncReady = true;
      rememberSyncState(!sameSyncContent(data, remote));
      await window.budgetStore.save(data);
      if (!active()) return false;
      render();
    }
    if (!sameSyncContent(data, syncBaseData)) {
      const payload = syncPayload();
      payload.updatedAt = Math.max(Date.now(), (syncRemoteUpdatedAt || 0) + 1);
      rememberSyncState(true);
      await window.budgetStore.save(data);
      if (!active()) return false;
      const result = await window.budgetStore.syncPush(url, payload, syncRemoteUpdatedAt);
      if (!active()) return false;
      const revision = result && Number.isFinite(result.updatedAt) ? result.updatedAt : payload.updatedAt;
      payload.updatedAt = revision;
      syncRemoteUpdatedAt = revision;
      syncBaseData = payload;
      const pending = !sameSyncContent(data, payload);
      if (!pending) data.updatedAt = revision;
      rememberSyncState(pending);
      await window.budgetStore.save(data);
      if (!active()) return false;
      syncQueued = pending || syncNeedsPull;
    }
    syncRetryCount = 0;
    if (!syncQueued) setSyncStatus("ok", "Synced");
    return true;
  } catch (err) {
    if (!active()) return false;
    console.error("sync failed", err);
    // Always read again after an ambiguous failure: the server may have
    // committed a POST whose response never reached this browser.
    syncNeedsPull = true;
    syncQueued = true;
    const retryable = err.code !== "SYNC_REJECTED" && !/HTTP 40[134]/i.test(err.message || "");
    if (retryable) {
      retryDelay = Math.min(60000, 1000 * 2 ** Math.min(syncRetryCount++, 6));
      setSyncStatus("error", "Saved locally · retrying sync");
    } else {
      syncQueued = false;
      setSyncStatus("error", syncErrorLabel(err));
    }
    return false;
  } finally {
    syncBusy = false;
    if (!active()) {
      if (syncUrl()) scheduleSync(0);
    } else if (retryDelay !== null) {
      // Keep the error visible until the next attempt starts.
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => { syncTimer = null; pushToSheets(); }, retryDelay);
    } else if (syncQueued && syncRetryCount === 0) {
      scheduleSync();
    }
  }
}

async function pullFromSheets() {
  syncNeedsPull = true;
  return pushToSheets();
}

// Phone browsers suspend timers in the background. Retry when the page is
// visible again or connectivity returns, and refresh other devices' edits.
window.addEventListener("online", () => pullFromSheets());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pullFromSheets();
});

$("syncBtn").onclick = () => {
  openModal({
    title: "Sync & backup",
    saveLabel: "Save & sync",
    body: `
      <div class="field">
        <label>Apps Script web app URL</label>
        <textarea id="f-syncurl" placeholder="https://script.google.com/macros/s/…/exec">${escapeHtml(syncUrl())}</textarea>
        <div class="hint">
          One-time setup: open <b>SYNC_SETUP.md</b> in the app folder — it walks you through
          creating a Google Sheet, pasting the provided script, and deploying it as a web app.
          Paste the resulting /exec URL here on each device. Leave empty to disable sync.
        </div>
      </div>
      <div class="field">
        <label>Backup</label>
        <div style="display:flex;gap:10px">
          <button type="button" class="pill-btn" id="f-backup">Export backup…</button>
          <button type="button" class="pill-btn" id="f-restore">Restore backup…</button>
        </div>
        <div class="hint">Export saves all your data to a JSON file. Restore replaces everything with a backup file's contents.</div>
      </div>`,
    onSave: () => {
      const url = $("f-syncurl").value.trim();
      $("f-syncurl").setCustomValidity("");
      if (url && !isAppsScriptExecUrl(url)) {
        $("f-syncurl").setCustomValidity("Paste the Apps Script Web app URL ending in /exec (not /dev).");
        $("f-syncurl").reportValidity();
        return false;
      }
      if (url !== syncUrl()) resetSyncConnection();
      if (!data.settings) data.settings = {};
      data.settings.syncUrl = url;
      window.budgetStore.save(data);
      if (url) pullFromSheets();
      else setSyncStatus("", "Sync");
    }
  });

  $("f-backup").onclick = async () => {
    try {
      const path = await window.budgetStore.backupExport(data);
      if (path) $("f-backup").textContent = "Exported ✓";
    } catch (err) {
      console.error(err);
      $("f-backup").textContent = "Export failed";
    }
  };
  $("f-restore").onclick = async () => {
    try {
      const restored = await window.budgetStore.backupImport();
      if (!restored) return;
      const keepSettings = data.settings;
      data = restored;
      if (!data.months) data.months = {};
      data.settings = keepSettings;
      data.updatedAt = Math.max(Date.now(), (syncRemoteUpdatedAt || 0) + 1);
      rememberSyncState(true);
      await window.budgetStore.save(data);
      closeModal();
      render();
      pushToSheets();
    } catch (err) {
      console.error(err);
      $("f-restore").textContent = "Restore failed";
    }
  };
};

/* ---------- loans / IOUs ---------- */

$("loansBtn").onclick = () => {
  openModal({ title: "Loans & IOUs", saveLabel: "Done", body: "", onSave: () => {} });
  renderLoansModal();
};

function loanRowHtml(loan) {
  const out = loanOutstanding(loan);
  const settled = out <= 0.004;
  const today = new Date().toISOString().slice(0, 10);
  return `
    <div class="loan-row">
      <div class="loan-top">
        <span class="loan-person">${escapeHtml(loan.person || "Someone")}</span>
        <span class="loan-amt">${fmt(loan.amount)} lent ${loan.date}</span>
      </div>
      ${loan.note ? `<div class="loan-note">${escapeHtml(loan.note)}</div>` : ""}
      <div class="loan-status ${settled ? "settled" : ""}">${settled ? (loan.writtenOff ? "✕ written off" : "✓ settled") : `${fmt(out)} outstanding`}</div>
      ${!settled ? `
      <div class="loan-actions">
        <input type="number" class="loan-repay-amt" min="0" step="0.01" value="${out}" data-id="${loan.id}" />
        <input type="date" class="loan-repay-date" value="${today}" data-id="${loan.id}" />
        <button class="mini-btn" data-act="repay" data-id="${loan.id}">Record repayment</button>
        <button class="mini-btn" data-act="writeoff" data-id="${loan.id}">Write off</button>
      </div>` : ""}
      <button class="mini-btn loan-delete" data-act="delete" data-id="${loan.id}">Delete</button>
    </div>`;
}

function renderLoansModal() {
  const loans = data.loans || [];
  const outstanding = loans.filter((l) => loanOutstanding(l) > 0.004);
  const settled = loans.filter((l) => loanOutstanding(l) <= 0.004);

  $("modalBody").innerHTML = `
    <div class="hint">Money you lend reduces cash this month, without touching any budget. Repayments (even a bit extra) add cash back the month they land.</div>
    <div class="field-row">
      <div class="field"><label>Person</label><input id="ln-person" type="text" placeholder="Brother" /></div>
      <div class="field" style="flex:0 0 120px"><label>Amount</label><input id="ln-amount" type="number" min="0" step="0.01" placeholder="0.00" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Date lent</label><input id="ln-date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
      <div class="field"><label>Note <span style="text-transform:none;letter-spacing:0;opacity:0.6">(optional)</span></label><input id="ln-note" type="text" placeholder="For petrol" /></div>
    </div>
    <button type="button" class="pill-btn primary" id="ln-add" style="align-self:flex-start">+ Add loan</button>
    ${outstanding.length ? `<div class="loan-section-label">Outstanding</div>${outstanding.map(loanRowHtml).join("")}` : `<div class="hint">No outstanding loans.</div>`}
    ${settled.length ? `<div class="loan-section-label">Settled</div>${settled.map(loanRowHtml).join("")}` : ""}
  `;

  $("ln-add").onclick = () => {
    const person = $("ln-person").value.trim();
    const amount = parseFloat($("ln-amount").value);
    const date = $("ln-date").value;
    if (!person || !Number.isFinite(amount) || amount <= 0 || !date) return;
    if (!data.loans) data.loans = [];
    data.loans.push({
      id: uid(), person, amount: Math.round(amount * 100) / 100,
      date, note: $("ln-note").value.trim(), repayments: []
    });
    persist();
    renderLoansModal();
  };

  $("modalBody").querySelectorAll('[data-act="repay"]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const loan = data.loans.find((l) => l.id === id);
      const amtInput = $("modalBody").querySelector(`.loan-repay-amt[data-id="${id}"]`);
      const dateInput = $("modalBody").querySelector(`.loan-repay-date[data-id="${id}"]`);
      const amt = parseFloat(amtInput.value);
      if (!Number.isFinite(amt) || amt <= 0 || !dateInput.value) return;
      if (!loan.repayments) loan.repayments = [];
      loan.repayments.push({ id: uid(), amount: Math.round(amt * 100) / 100, date: dateInput.value });
      persist();
      renderLoansModal();
    };
  });

  $("modalBody").querySelectorAll('[data-act="writeoff"]').forEach((btn) => {
    btn.onclick = () => {
      const loan = data.loans.find((l) => l.id === btn.dataset.id);
      loan.writtenOff = true;
      persist();
      renderLoansModal();
    };
  });

  $("modalBody").querySelectorAll('[data-act="delete"]').forEach((btn) => {
    btn.onclick = () => {
      data.loans = data.loans.filter((l) => l.id !== btn.dataset.id);
      persist();
      renderLoansModal();
    };
  });
}

/* ---------- pre-purchases ---------- */

// Month key arithmetic: "2026-07" -> "2026-08"
function nextMonthOfKey(key) {
  const y = Number(key.slice(0, 4)), mIdx = Number(key.slice(5, 7)) - 1;
  return mIdx === 11 ? monthKey(y + 1, 0) : monthKey(y, mIdx + 1);
}
function monthLabelOf(key) {
  return `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
}
function firstOfMonthDate(key) {
  return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);
}

// Expenses recorded in earlier months that were flagged as pre-purchases
// for the given month. Cash-wise they belong to the month they were bought
// in; budget-wise they belong here.
function incomingPrepurchases(key) {
  const out = [];
  for (const [k, m] of Object.entries(data.months)) {
    if (k === key) continue;
    for (const e of m.expenses) {
      if (e.forMonth === key) out.push({ exp: e, srcKey: k });
    }
  }
  return out;
}

/* ---------- loans / IOUs ---------- */

// A loan is money handed to someone else, expected back (maybe with a bit
// extra). It reduces cash the month it's lent and adds cash back the month
// each repayment lands — but never touches any category's budget, since it
// isn't spending.
function loanOutstanding(loan) {
  if (loan.writtenOff) return 0;
  const repaid = (loan.repayments || []).reduce((s, r) => s + r.amount, 0);
  return Math.round((loan.amount - repaid) * 100) / 100;
}
function totalOutstandingLoans() {
  return (data.loans || []).reduce((s, l) => s + Math.max(0, loanOutstanding(l)), 0);
}
function loansLentInMonth(key) {
  return (data.loans || [])
    .filter((l) => l.date.slice(0, 7) === key)
    .reduce((s, l) => s + l.amount, 0);
}
function loansRepaidInMonth(key) {
  let sum = 0;
  for (const l of data.loans || []) {
    for (const r of l.repayments || []) {
      if (r.date.slice(0, 7) === key) sum += r.amount;
    }
  }
  return sum;
}

/* ---------- derived numbers ---------- */

// Budget-relevant spend for a category in a month: this month's own expenses
// (excluding ones pre-purchased for a later month) plus pre-purchases made in
// earlier months that were allocated to this month.
function spentFor(month, catId, key = currentKey()) {
  const own = month.expenses
    .filter((e) => e.catId === catId && (!e.forMonth || e.forMonth === key))
    .reduce((s, e) => s + e.amount, 0);
  const incoming = incomingPrepurchases(key)
    .filter((p) => p.exp.catId === catId)
    .reduce((s, p) => s + p.exp.amount, 0);
  return own + incoming;
}

// Effective remaining for a category. A manual re-evaluation ("override")
// pins remaining at a value as of the spend level when it was set; later
// expenses keep reducing it. The budget itself is never touched.
function remainingFor(month, cat) {
  const spent = spentFor(month, cat.id);
  if (cat.override) return cat.override.value - (spent - cat.override.spentAt);
  return cat.budget - spent;
}

// Seven-day weeks start on the 1st; the final block may be shorter.
// Today is included in the remaining allowance. Pace uses the end of today.
function categorySplit(year, month, budget, spent, remaining, now = new Date()) {
  const days = new Date(year, month + 1, 0).getDate();
  const current = now.getFullYear() === year && now.getMonth() === month;
  const past = year * 12 + month < now.getFullYear() * 12 + now.getMonth();
  const elapsed = current ? now.getDate() : past ? days : 0;
  const daysRemaining = current ? days - now.getDate() + 1 : past ? 0 : days;
  const daily = budget / days;
  return {
    days, current, past, elapsed, daysRemaining, daily,
    fullWeeks: Math.floor(days / 7), extraDays: days % 7,
    weekly: daily * 7, partialWeek: daily * (days % 7),
    expectedSpent: daily * elapsed,
    paceDifference: daily * elapsed - spent,
    spentDays: daily > 0 ? spent / daily : null,
    remainingDays: daily > 0 ? Math.max(0, remaining) / daily : null,
    adjustedDaily: daysRemaining > 0 ? Math.max(0, remaining) / daysRemaining : null
  };
}

function splitDetailsHtml(split, cat, remaining) {
  const count = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const weeks = `${split.fullWeeks} weeks${split.extraDays ? ` + ${split.extraDays} days` : ""}`;
  const pace = split.current || split.past
    ? `<div class="split-pace ${split.paceDifference < -0.005 ? "over" : "under"}">${Math.abs(split.paceDifference) < 0.005 ? "On budget pace" : `${fmt(Math.abs(split.paceDifference))} ${split.paceDifference > 0 ? "under" : "over"} budget pace`} · ${fmt(split.expectedSpent)} planned ${split.current ? "by the end of today" : "for the month"}</div>`
    : `<div class="split-note">Upcoming month · remaining allowance spread across all ${split.days} days</div>`;
  const change = split.adjustedDaily === null ? 0 : split.adjustedDaily - split.daily;
  return `<div class="split-details">
    <div class="split-note">${split.days} days · ${weeks} · weeks counted from the 1st</div>
    <div class="split-metrics">
      <div><span>Planned daily</span><b>${fmt(split.daily)}</b></div>
      <div><span>Full 7-day week</span><b>${fmt(split.weekly)}</b></div>
      ${split.extraDays ? `<div><span>Final ${split.extraDays} days</span><b>${fmt(split.partialWeek)}</b></div>` : ""}
    </div>
    ${cat.budget > 0 ? `<div class="split-note">Purchases represent <b>${count(split.spentDays)} days</b> of budget · <b>${count(split.remainingDays)} days</b> still affordable at the planned rate. Spending-based estimate.</div>` : `<div class="split-note">Set a monthly budget above zero to estimate days of purchases.</div>`}
    ${pace}
    <div class="split-allowance">
      ${split.past ? `Month ended · ${fmt(Math.abs(remaining))} ${remaining < 0 ? "over budget" : "left"}` : `<b>${fmt(split.adjustedDaily)} / day now</b><span>${split.daysRemaining} day${split.daysRemaining === 1 ? "" : "s"} left${split.current ? ", including today" : ""}${Math.abs(change) >= 0.005 ? ` · ${fmt(Math.abs(change))} ${change > 0 ? "more" : "less"} per day than planned` : ""}</span>`}
    </div>
    ${cat.override ? `<div class="split-note">Daily allowance uses your re-evaluated remaining amount; pace and purchase days use the original budget.</div>` : ""}
    ${remaining < 0 && !split.past ? `<div class="split-pace over">Budget exhausted · ${fmt(-remaining)} over the remaining allowance</div>` : ""}
  </div>`;
}

/* ---------- rendering ---------- */

function render() {
  const month = getMonth();
  $("monthLabel").textContent = `${MONTH_NAMES[viewMonth]} ${viewYear}`;

  // Pre-purchases don't hit cash in the month they're bought — they're
  // effectively bought on credit for next month, so they're excluded from
  // this month's cash spend and added to the target month's instead.
  const preBought = month.expenses
    .filter((e) => e.forMonth)
    .reduce((s, e) => s + e.amount, 0);
  const preIncoming = incomingPrepurchases(currentKey())
    .reduce((s, p) => s + p.exp.amount, 0);

  const totalSpent = month.expenses.reduce((s, e) => s + e.amount, 0) - preBought + preIncoming;
  const totalBudget = month.categories.reduce((s, c) => s + c.budget, 0);
  const totalRemaining = month.categories.reduce((s, c) => s + Math.max(0, remainingFor(month, c)), 0);

  // Loans are cash out/in but never touch a category's budget.
  const lentThisMonth = loansLentInMonth(currentKey());
  const repaidThisMonth = loansRepaidInMonth(currentKey());
  const netLoanCash = lentThisMonth - repaidThisMonth;
  const totalAdjustments = (month.adjustments || []).reduce((s, a) => s + a.amount, 0);

  const cashLeft = month.income - totalSpent - netLoanCash + totalAdjustments;
  const bankTarget = cashLeft - preBought;
  const trulyFree = month.income - totalSpent - totalRemaining - netLoanCash + totalAdjustments;

  $("incomeValue").textContent = fmt(month.income);
  $("spentValue").textContent = fmt(totalSpent);
  $("spentSub").textContent = [
    totalBudget ? `of ${fmt(totalBudget)} budgeted` : "",
    preBought > 0 ? `🛒 ${fmt(preBought)} on credit for next month` : "",
    preIncoming > 0 ? `incl. 🛒 ${fmt(preIncoming)} pre-purchased last month` : ""
  ].filter(Boolean).join(" · ") || " ";
  const cashEl = $("cashLeftValue");
  cashEl.textContent = fmt(cashLeft);
  cashEl.className = "stat-value " + (cashLeft < 0 ? "neg" : "");
  $("cashLeftSub").textContent = [
    "income − spent",
    lentThisMonth > 0 ? `🤝 ${fmt(lentThisMonth)} lent out` : "",
    repaidThisMonth > 0 ? `🤝 ${fmt(repaidThisMonth)} repaid` : "",
    totalAdjustments ? `${totalAdjustments > 0 ? "+" : ""}${fmt(totalAdjustments)} adjustments` : "",
    "tap to adjust"
  ].filter(Boolean).join(" · ");
  const bankTargetEl = $("bankTargetValue");
  bankTargetEl.textContent = fmt(bankTarget);
  bankTargetEl.className = "stat-value " + (bankTarget < 0 ? "neg" : "");
  $("bankTargetSub").textContent = preBought > 0
    ? `cash left − ${fmt(preBought)} allocated ahead`
    : "same as cash left · nothing allocated ahead";
  const freeEl = $("freeValue");
  freeEl.textContent = fmt(trulyFree);
  freeEl.className = "stat-value " + (trulyFree < 0 ? "neg" : "pos");

  $("budgetTotalLabel").textContent = totalBudget ? `${fmt(totalBudget)} budgeted` : "";

  const outstandingTotal = totalOutstandingLoans();
  $("loansLabel").textContent = outstandingTotal > 0 ? `Loans (${fmt(outstandingTotal)})` : "Loans";

  renderCategories(month);
  renderExpenses(month);
}

function renderCategories(month) {
  const list = $("catList");
  list.innerHTML = "";
  $("catEmpty").hidden = month.categories.length > 0;

  // pace marker only makes sense on the real, in-progress month
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === viewYear && now.getMonth() === viewMonth;
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const monthElapsed = isCurrentMonth ? now.getDate() / daysInMonth : 0;
  const incoming = incomingPrepurchases(currentKey());

  for (const cat of month.categories) {
    const preAmt = incoming
      .filter((p) => p.exp.catId === cat.id)
      .reduce((s, p) => s + p.exp.amount, 0);
    const spent = spentFor(month, cat.id);
    const remaining = remainingFor(month, cat);
    const split = cat.dailyWeeklySplit ? categorySplit(viewYear, viewMonth, cat.budget, spent, remaining, now) : null;
    const effectiveTotal = spent + Math.max(0, remaining);
    const barTotal = split ? cat.budget : effectiveTotal;
    const pct = barTotal > 0 ? Math.max(0, Math.min(100, (spent / barTotal) * 100)) : (spent > 0 ? 100 : 0);
    const over = remaining < 0;
    const spentFrac = cat.budget > 0 ? spent / cat.budget : 0;
    const aheadOfPace = isCurrentMonth && !over && !cat.override && cat.budget > 0
      && spentFrac > monthElapsed + 0.1 && spent > 0;

    const row = document.createElement("div");
    row.className = "cat-row";
    row.innerHTML = `
      <div class="cat-top">
        <span class="cat-emoji">${cat.emoji || "📦"}</span>
        <span class="cat-name">${escapeHtml(cat.name)}</span>
        <span class="cat-nums">
          <b class="${over ? "over" : cat.override ? "adjusted" : ""}">${fmt(remaining)}</b> left
          &nbsp;·&nbsp; ${fmt(spent)} spent &nbsp;·&nbsp; ${fmt(cat.budget)} budget
        </span>
      </div>
      <div class="bar" title="${isCurrentMonth ? `${Math.round(monthElapsed * 100)}% through the month · ${Math.round(spentFrac * 100)}% of budget used` : ""}">
        <div class="bar-fill ${over ? "over" : split && split.current && split.paceDifference >= 0 ? "under" : pct > 80 ? "warn" : ""}" style="width:${split ? pct : over ? 100 : pct}%"></div>
        ${isCurrentMonth ? `<div class="pace-mark" style="left:${(monthElapsed * 100).toFixed(1)}%" title="Today: ${Math.round(monthElapsed * 100)}% through the month"></div>` : ""}
      </div>
      ${cat.override ? `<div class="cat-adjust-note">✦ re-evaluated — remaining pinned (budget untouched)</div>` : ""}
      ${preAmt > 0 ? `<div class="cat-prep-note">🛒 ${fmt(preAmt)} already pre-purchased in an earlier month (paid then, allocated here)</div>` : ""}
      ${aheadOfPace && !split ? `<div class="pace-note">⚡ ${Math.round(spentFrac * 100)}% of budget used, but only ${Math.round(monthElapsed * 100)}% through the month</div>` : ""}
      <label class="split-toggle"><input type="checkbox" role="switch" data-act="split" ${cat.dailyWeeklySplit ? "checked" : ""} /><span>Daily/Weekly Split</span></label>
      ${split ? splitDetailsHtml(split, cat, remaining) : ""}
      <div class="cat-actions">
        <button class="mini-btn" data-act="reeval">Re-evaluate</button>
        <button class="mini-btn" data-act="edit">Edit</button>
      </div>`;
    row.querySelector('[data-act="reeval"]').onclick = () => openReevalModal(cat);
    row.querySelector('[data-act="edit"]').onclick = () => openCategoryModal(cat);
    row.querySelector('[data-act="split"]').onchange = (event) => {
      const c = editMonth().categories.find((item) => item.id === cat.id);
      if (c) c.dailyWeeklySplit = event.target.checked;
      persist();
    };
    list.appendChild(row);
  }
}

let expenseFilter = "";

// Reminder strip: things already bought in an earlier month for this one.
function renderPrepurchaseStrip(month) {
  const strip = $("prepStrip");
  const incoming = incomingPrepurchases(currentKey());
  strip.hidden = !incoming.length;
  strip.innerHTML = "";
  if (!incoming.length) return;
  const cats = Object.fromEntries(month.categories.map((c) => [c.id, c]));
  const label = document.createElement("div");
  label.className = "prep-strip-label";
  label.textContent = "🛒 Already pre-purchased for this month";
  strip.appendChild(label);
  for (const { exp, srcKey } of incoming) {
    const cat = cats[exp.catId];
    const chip = document.createElement("button");
    chip.className = "prep-chip";
    chip.title = `Bought ${exp.date} — counted against ${cat ? cat.name : "a deleted category"}'s budget this month. Click to edit.`;
    chip.innerHTML = `${cat ? cat.emoji || "📦" : "❔"} ${escapeHtml(exp.note || (cat ? cat.name : "Pre-purchase"))} <b>${fmt(exp.amount)}</b> <span>· bought ${monthLabelOf(srcKey).split(" ")[0].slice(0, 3)} ${Number(exp.date.slice(8, 10))}</span>`;
    chip.onclick = () => openExpenseModal(exp, srcKey);
    strip.appendChild(chip);
  }
}

function renderExpenses(month) {
  renderPrepurchaseStrip(month);
  const list = $("expenseList");
  list.innerHTML = "";

  // quick-add category options (preserve selection across re-renders)
  const qaCat = $("qa-cat");
  const prevSel = qaCat.value;
  qaCat.innerHTML = month.categories.map((c) =>
    `<option value="${c.id}">${c.emoji || ""} ${escapeHtml(c.name)}</option>`).join("");
  if ([...qaCat.options].some((o) => o.value === prevSel)) qaCat.value = prevSel;

  const cats = Object.fromEntries(month.categories.map((c) => [c.id, c]));
  const q = expenseFilter.toLowerCase();
  const filtered = month.expenses.filter((e) => {
    if (!q) return true;
    const cat = cats[e.catId];
    return (e.note || "").toLowerCase().includes(q)
      || (cat && cat.name.toLowerCase().includes(q))
      || String(e.amount).includes(q);
  });
  $("expEmpty").hidden = filtered.length > 0;
  const sorted = filtered.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

  for (const exp of sorted) {
    const cat = cats[exp.catId];
    const row = document.createElement("div");
    row.className = "expense-row";
    const day = new Date(exp.date + "T12:00:00");
    row.innerHTML = `
      <div class="expense-emoji">${cat ? cat.emoji || "📦" : "❔"}</div>
      <div class="expense-info">
        <div class="expense-note">${escapeHtml(exp.note || (cat ? cat.name : "Expense"))}</div>
        <div class="expense-meta">${cat ? escapeHtml(cat.name) + " · " : ""}${day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}${exp.recurringId ? " · ↻ recurring" : ""}${exp.forMonth ? ` · <span class="prep-tag">🛒 for ${escapeHtml(monthLabelOf(exp.forMonth))}</span>` : exp.prepurchased ? ` · <span class="prep-tag">🛒 pre-purchased</span>` : ""}</div>
      </div>
      <div class="expense-amount">${fmt(exp.amount)}</div>`;
    row.onclick = () => openExpenseModal(exp);
    list.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- modal machinery ---------- */

let modalHandlers = { save: null, delete: null };

function openModal({ title, body, saveLabel = "Save", onSave, onDelete }) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = body;
  $("modalSave").textContent = saveLabel;
  $("modalDelete").hidden = !onDelete;
  modalHandlers = { save: onSave, delete: onDelete };
  $("modalBackdrop").hidden = false;
  const first = $("modalBody").querySelector("input, select");
  if (first) { first.focus(); if (first.select) first.select(); }
}

function closeModal() {
  $("modalBackdrop").hidden = true;
  modalHandlers = { save: null, delete: null };
}

$("modalCancel").onclick = closeModal;
$("modalBackdrop").addEventListener("mousedown", (e) => {
  if (e.target === $("modalBackdrop")) closeModal();
});
$("modalSave").onclick = () => { if (modalHandlers.save && modalHandlers.save() !== false) closeModal(); };
$("modalDelete").onclick = () => { if (modalHandlers.delete) { modalHandlers.delete(); closeModal(); } };
document.addEventListener("keydown", (e) => {
  if ($("modalBackdrop").hidden) return;
  if (e.key === "Escape") closeModal();
  if (e.key === "Enter" && e.target.tagName !== "SELECT") $("modalSave").click();
});

const numVal = (id) => {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
};

/* ---------- income ---------- */

$("incomeCard").onclick = () => {
  const month = getMonth();
  openModal({
    title: "Monthly income",
    body: `
      <div class="field">
        <label>Income for ${MONTH_NAMES[viewMonth]} ${viewYear}</label>
        <input id="f-income" type="number" min="0" step="0.01" value="${month.income || ""}" placeholder="0.00" />
      </div>`,
    onSave: () => {
      const v = numVal("f-income");
      if (!Number.isFinite(v) || v < 0) return false;
      editMonth().income = v;
      persist();
    }
  });
};

/* ---------- cash adjustments ---------- */

// One-off cash in/out for the month — a bonus, a gift, an unexpected bill —
// that shouldn't change the planned monthly income baseline. Never carries
// over to future months.
function adjustmentRowHtml(adj) {
  const pos = adj.amount >= 0;
  return `
    <div class="loan-row">
      <div class="loan-top">
        <span class="loan-person">${escapeHtml(adj.note || (pos ? "Extra cash" : "Extra cost"))}</span>
        <span class="loan-amt">${pos ? "+" : ""}${fmt(adj.amount)}</span>
      </div>
      <button class="mini-btn loan-delete" data-act="delete-adj" data-id="${adj.id}">Delete</button>
    </div>`;
}

function renderAdjustmentsModal() {
  const month = getMonth();
  const adjustments = month.adjustments || [];
  $("modalBody").innerHTML = `
    <div class="hint">Add a one-off amount to this month's cash left — a bonus, a gift, or an unexpected cost — without changing your planned income. Use a negative amount for money out.</div>
    <div class="field-row">
      <div class="field" style="flex:0 0 120px"><label>Amount</label><input id="adj-amount" type="number" step="0.01" placeholder="0.00" /></div>
      <div class="field"><label>Note <span style="text-transform:none;letter-spacing:0;opacity:0.6">(optional)</span></label><input id="adj-note" type="text" placeholder="Birthday gift" /></div>
    </div>
    <button type="button" class="pill-btn primary" id="adj-add" style="align-self:flex-start">+ Add</button>
    ${adjustments.length ? adjustments.map(adjustmentRowHtml).join("") : `<div class="hint">No adjustments yet this month.</div>`}
  `;

  $("adj-add").onclick = () => {
    const amount = parseFloat($("adj-amount").value);
    if (!Number.isFinite(amount) || amount === 0) return;
    const m = editMonth();
    if (!m.adjustments) m.adjustments = [];
    m.adjustments.push({ id: uid(), amount: Math.round(amount * 100) / 100, note: $("adj-note").value.trim() });
    persist();
    renderAdjustmentsModal();
  };

  $("modalBody").querySelectorAll('[data-act="delete-adj"]').forEach((btn) => {
    btn.onclick = () => {
      const m = editMonth();
      m.adjustments = (m.adjustments || []).filter((a) => a.id !== btn.dataset.id);
      persist();
      renderAdjustmentsModal();
    };
  });
}

const cashLeftCard = $("cashLeftValue").closest(".stat-card");
cashLeftCard.classList.add("cash-left-card");
cashLeftCard.title = "Click to add a one-off adjustment";
cashLeftCard.onclick = () => {
  openModal({ title: "Cash left adjustments", saveLabel: "Done", body: "", onSave: () => {} });
  renderAdjustmentsModal();
};

/* ---------- categories ---------- */

$("addCategoryBtn").onclick = () => openCategoryModal(null);

function openCategoryModal(cat) {
  openModal({
    title: cat ? "Edit category" : "New category",
    body: `
      <div class="field-row">
        <div class="field" style="flex:0 0 84px">
          <label>Emoji</label>
          <input id="f-emoji" type="text" maxlength="4" value="${cat ? cat.emoji || "" : ""}" placeholder="🍎" />
        </div>
        <div class="field">
          <label>Name</label>
          <input id="f-name" type="text" value="${cat ? escapeHtml(cat.name) : ""}" placeholder="Groceries" />
        </div>
      </div>
      <div class="field">
        <label>Monthly budget</label>
        <input id="f-budget" type="number" min="0" step="0.01" value="${cat ? cat.budget : ""}" placeholder="0.00" />
        <div class="hint">This is the planned amount. It carries over as the default for future months and is never changed by re-evaluations.</div>
      </div>
      <div class="field">
        <label class="split-toggle"><input id="f-split" type="checkbox" role="switch" ${cat && cat.dailyWeeklySplit ? "checked" : ""} /><span>Daily/Weekly Split</span></label>
        <div class="hint">Show daily and weekly allowances, purchase days, and an updated daily budget using what's left. This choice carries over to future months.</div>
      </div>`,
    onSave: () => {
      const name = $("f-name").value.trim();
      const budget = numVal("f-budget");
      if (!name || !Number.isFinite(budget) || budget < 0) return false;
      const month = editMonth();
      if (cat) {
        const c = month.categories.find((x) => x.id === cat.id);
        if (c) { c.name = name; c.emoji = $("f-emoji").value.trim(); c.budget = budget; c.dailyWeeklySplit = $("f-split").checked; }
      } else {
        month.categories.push({ id: uid(), name, emoji: $("f-emoji").value.trim(), budget, dailyWeeklySplit: $("f-split").checked, override: null });
      }
      persist();
    },
    onDelete: cat ? () => {
      const month = editMonth();
      month.categories = month.categories.filter((x) => x.id !== cat.id);
      month.expenses = month.expenses.filter((e) => e.catId !== cat.id);
      persist();
    } : null
  });
}

/* ---------- re-evaluate remaining ---------- */

function openReevalModal(cat) {
  const month = getMonth();
  const remaining = remainingFor(month, cat);
  openModal({
    title: `Re-evaluate · ${cat.emoji || ""} ${cat.name}`,
    saveLabel: "Set remaining",
    body: `
      <div class="field">
        <label>Remaining for the rest of the month</label>
        <input id="f-remaining" type="number" step="0.01" value="${Math.max(0, remaining)}" />
        <div class="hint">
          Currently ${fmt(remaining)} left of a ${fmt(cat.budget)} budget.
          Setting a new remaining amount only affects this month —
          your ${fmt(cat.budget)} budget stays as the default for next month.
        </div>
      </div>
      ${cat.override ? `
      <div class="field">
        <div class="hint" style="margin-top:-4px">✦ This category was already re-evaluated. Save a new value to replace it, or
        <a href="#" id="f-clear" style="color:var(--accent)">reset to budget-based remaining</a>.</div>
      </div>` : ""}`,
    onSave: () => {
      const v = numVal("f-remaining");
      if (!Number.isFinite(v) || v < 0) return false;
      const m = editMonth();
      const c = m.categories.find((x) => x.id === cat.id);
      if (c) c.override = { value: v, spentAt: spentFor(m, c.id) };
      persist();
    }
  });
  const clear = $("f-clear");
  if (clear) clear.onclick = (e) => {
    e.preventDefault();
    const m = editMonth();
    const c = m.categories.find((x) => x.id === cat.id);
    if (c) c.override = null;
    persist();
    closeModal();
  };
}

/* ---------- expenses ---------- */

$("addExpenseBtn").onclick = () => openExpenseModal(null);

$("expenseSearch").oninput = (e) => {
  expenseFilter = e.target.value.trim();
  renderExpenses(getMonth());
};

function quickAdd() {
  const amount = parseFloat($("qa-amount").value);
  const catId = $("qa-cat").value;
  if (!Number.isFinite(amount) || amount <= 0 || !catId) return;
  const now = new Date();
  const inThisMonth = now.getFullYear() === viewYear && now.getMonth() === viewMonth;
  const date = inThisMonth ? now.toISOString().slice(0, 10) : `${currentKey()}-01`;
  editMonth().expenses.push({
    id: uid(), catId, amount: Math.round(amount * 100) / 100,
    note: $("qa-note").value.trim(), date, createdAt: Date.now()
  });
  $("qa-amount").value = "";
  $("qa-note").value = "";
  persist();
  $("qa-amount").focus();
}
$("qa-add").onclick = quickAdd;
$("qa-amount").addEventListener("keydown", (e) => { if (e.key === "Enter") quickAdd(); });
$("qa-note").addEventListener("keydown", (e) => { if (e.key === "Enter") quickAdd(); });

// srcKey: the month the expense record actually lives in (differs from the
// viewed month when editing a pre-purchase from its target month's strip).
function openExpenseModal(exp, srcKey) {
  const entryKey = srcKey || currentKey();
  const targetKey = nextMonthOfKey(entryKey);
  const month = getMonth();
  if (!month.categories.length) {
    openModal({
      title: "No categories yet",
      saveLabel: "OK",
      body: `<div class="field"><div class="hint">Add a budget category first, then log expenses against it.</div></div>`,
      onSave: () => {}
    });
    return;
  }
  const today = new Date();
  const inThisMonth = today.getFullYear() === viewYear && today.getMonth() === viewMonth;
  const defaultDate = exp ? exp.date
    : inThisMonth ? today.toISOString().slice(0, 10)
    : `${currentKey()}-01`;

  const catOptions = month.categories.map((c) =>
    `<option value="${c.id}" ${exp && exp.catId === c.id ? "selected" : ""}>${c.emoji || ""} ${escapeHtml(c.name)}</option>`).join("");

  openModal({
    title: exp ? "Edit expense" : "Add expense",
    body: `
      <div class="field-row">
        <div class="field">
          <label>Amount</label>
          <input id="f-amount" type="number" min="0" step="0.01" value="${exp ? exp.amount : ""}" placeholder="0.00" />
        </div>
        <div class="field">
          <label>Date</label>
          <input id="f-date" type="date" value="${defaultDate}" min="${entryKey}-01" max="${entryKey}-31" />
        </div>
      </div>
      <div class="field">
        <label>Category</label>
        <select id="f-cat">${catOptions}</select>
        <button type="button" class="mini-btn" id="f-claim" style="margin-top:8px"></button>
      </div>
      <div class="field">
        <label>Note <span style="text-transform:none;letter-spacing:0;opacity:0.6">(optional)</span></label>
        <input id="f-note" type="text" value="${exp ? escapeHtml(exp.note || "") : ""}" placeholder="Costco run" />
      </div>
      <div class="field">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;text-transform:none;letter-spacing:0;font-size:13px;color:var(--text)">
          <input id="f-recurring" type="checkbox" style="width:auto" ${exp && exp.recurringId ? "checked" : ""} />
          ↻ Repeat monthly on this day
        </label>
        <div class="hint">Automatically logged each month once the day arrives (rent, subscriptions, insurance…).</div>
      </div>
      <div class="field">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;text-transform:none;letter-spacing:0;font-size:13px;color:var(--text)">
          <input id="f-prepurchase" type="checkbox" style="width:auto" ${exp && exp.forMonth ? "checked" : ""} />
          🛒 Pre-purchase for ${monthLabelOf(targetKey)}
        </label>
        <div class="hint">Bought early (on special etc.). Comes out of this month's cash, but counts against ${monthLabelOf(targetKey)}'s budget for this category — with a reminder shown there.</div>
      </div>`,
    onSave: () => {
      const amount = numVal("f-amount");
      const date = $("f-date").value;
      if (!Number.isFinite(amount) || amount <= 0 || !date) return false;
      const m = editMonthFor(entryKey);
      const catId = $("f-cat").value;
      const note = $("f-note").value.trim();
      const wantRecurring = $("f-recurring").checked;
      if (!data.recurring) data.recurring = [];

      let entry;
      if (exp) {
        entry = m.expenses.find((x) => x.id === exp.id);
        if (entry) { entry.amount = amount; entry.date = date; entry.catId = catId; entry.note = note; }
      } else {
        entry = {
          id: uid(), catId, amount, note, date, createdAt: Date.now()
        };
        m.expenses.push(entry);
      }

      if (entry) {
        if ($("f-prepurchase").checked) entry.forMonth = targetKey;
        else delete entry.forMonth;
        const catName = (m.categories.find((c) => c.id === catId) || {}).name || "";
        const day = Number(date.slice(8, 10));
        if (wantRecurring) {
          let rec = entry.recurringId && data.recurring.find((r) => r.id === entry.recurringId);
          if (!rec) {
            rec = { id: uid() };
            data.recurring.push(rec);
            entry.recurringId = rec.id;
          }
          Object.assign(rec, { note, amount, catId, catName, day });
        } else if (entry.recurringId) {
          data.recurring = data.recurring.filter((r) => r.id !== entry.recurringId);
          delete entry.recurringId;
        }
      }
      persist();
    },
    onDelete: exp ? () => {
      const m = editMonthFor(entryKey);
      m.expenses = m.expenses.filter((x) => x.id !== exp.id);
      // deleting a recurring instance also stops the rule, otherwise it
      // would just be re-created on the next launch
      if (exp.recurringId && data.recurring) {
        data.recurring = data.recurring.filter((r) => r.id !== exp.recurringId);
      }
      persist();
    } : null
  });

  // "Claim remaining" fills the amount with what's left in the selected
  // category (the full budget if nothing has been spent yet). When editing an
  // existing expense, its own amount is excluded so re-claiming is idempotent.
  const claimBtn = $("f-claim");
  const claimable = () => {
    const cat = month.categories.find((c) => c.id === $("f-cat").value);
    if (!cat) return 0;
    let rem = remainingFor(month, cat);
    // add the expense's own amount back only if it counts against the viewed
    // month's budget (not when it's a pre-purchase allocated elsewhere)
    const countsHere = exp && (exp.forMonth
      ? exp.forMonth === currentKey()
      : entryKey === currentKey());
    if (exp && exp.catId === cat.id && countsHere) rem += exp.amount;
    return Math.max(0, Math.round(rem * 100) / 100);
  };
  const refreshClaim = () => { claimBtn.textContent = `Claim remaining (${fmt(claimable())})`; };
  claimBtn.onclick = () => { $("f-amount").value = claimable(); };
  $("f-cat").onchange = refreshClaim;
  refreshClaim();
}

/* ---------- CSV bank import ---------- */

const importState = { rows: [], txns: [] };

$("importBtn").onclick = () => openImport();
$("importCancel").onclick = () => { $("importBackdrop").hidden = true; };
$("importBackdrop").addEventListener("mousedown", (e) => {
  if (e.target === $("importBackdrop")) $("importBackdrop").hidden = true;
});

function openImport() {
  $("importConfirm").hidden = true;
  $("importBody").innerHTML = `
    <div class="import-drop" id="importDrop">
      <b>Drop a CSV file here</b> or click to choose one<br/>
      <span style="font-size:12px">Export a transaction/statement CSV from your bank's website, then load it here.</span>
    </div>
    <input type="file" id="importFile" accept=".csv,.txt" style="display:none" />
    <div class="import-note">Dates, descriptions and amounts are detected automatically — you'll confirm the columns and pick a category per row before anything is saved. The app remembers your categorisations for next time.</div>`;
  $("importBackdrop").hidden = false;

  const drop = $("importDrop");
  const file = $("importFile");
  drop.onclick = () => file.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("drag"); };
  drop.ondragleave = () => drop.classList.remove("drag");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    if (e.dataTransfer.files.length) readImportFile(e.dataTransfer.files[0]);
  };
  file.onchange = () => { if (file.files.length) readImportFile(file.files[0]); };
}

function readImportFile(f) {
  const reader = new FileReader();
  reader.onload = () => {
    const rows = parseCSV(String(reader.result));
    if (rows.length < 1 || rows[0].length < 2) {
      $("importBody").insertAdjacentHTML("afterbegin",
        `<div class="import-note" style="color:var(--red)">Couldn't parse that file as CSV — check it's a comma/semicolon-delimited export.</div>`);
      return;
    }
    importState.rows = rows;
    showColumnMapping();
  };
  reader.readAsText(f);
}

function parseCSV(text) {
  // detect delimiter on the first non-empty lines
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5).join("\n");
  const delim = [",", ";", "\t"].map((d) => [d, (sample.match(new RegExp(d === "\t" ? "\t" : "\\" + d, "g")) || []).length])
    .sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = [], cell = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

// Accepts yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy, yyyy/mm/dd, dd Mon yyyy.
// Day-first is assumed for slashed dates (SA convention).
function parseImportDate(s) {
  s = String(s).trim();
  let m;
  if ((m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/))) return isoDate(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/))) return isoDate(m[3], m[2], m[1]);
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/))) {
    const mo = MONTH_NAMES.findIndex((n) => n.toLowerCase().startsWith(m[2].toLowerCase().slice(0, 3)));
    if (mo >= 0) return isoDate(m[3], mo + 1, m[1]);
  }
  return null;
}
function isoDate(y, mo, d) {
  mo = Number(mo); d = Number(d);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseImportAmount(s) {
  s = String(s).trim().replace(/[R$\s]/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", "."); // comma decimal
  if (/^\(.*\)$/.test(s)) s = "-" + s.slice(1, -1);      // (123.45) = negative
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

function showColumnMapping() {
  const rows = importState.rows;
  const cols = rows[0].length;
  // does row 0 look like a header? (no parseable date or amount in it)
  const hasHeader = !rows[0].some((c) => parseImportDate(c)) && !rows[0].every((c) => parseImportAmount(c) !== null);
  const body = hasHeader ? rows.slice(1) : rows;

  // score each column over a sample
  const sample = body.slice(0, 25);
  let dateCol = -1, amountCol = -1, descCol = -1;
  let bestDate = 0, bestAmt = 0, bestDesc = 0;
  for (let c = 0; c < cols; c++) {
    let dates = 0, nums = 0, textLen = 0;
    for (const r of sample) {
      const v = r[c] || "";
      if (parseImportDate(v)) dates++;
      else if (parseImportAmount(v) !== null && v.trim()) nums++;
      else textLen += v.length;
    }
    if (dates > bestDate) { bestDate = dates; dateCol = c; }
    if (nums > bestAmt) { bestAmt = nums; amountCol = c; }
    if (textLen > bestDesc) { bestDesc = textLen; descCol = c; }
  }

  const headers = hasHeader ? rows[0] : rows[0].map((_, i) => `Column ${i + 1}`);
  const colOptions = (sel) => headers.map((h, i) =>
    `<option value="${i}" ${i === sel ? "selected" : ""}>${escapeHtml(h || `Column ${i + 1}`)}</option>`).join("");

  $("importBody").innerHTML = `
    <div class="field-row">
      <div class="field"><label>Date column</label><select id="col-date">${colOptions(dateCol)}</select></div>
      <div class="field"><label>Description column</label><select id="col-desc">${colOptions(descCol)}</select></div>
      <div class="field"><label>Amount column</label><select id="col-amount">${colOptions(amountCol)}</select></div>
    </div>
    <div class="import-note">${body.length} rows found${hasHeader ? " (header row skipped)" : ""}. Adjust the columns if the guess is wrong, then continue.</div>
    <button class="pill-btn primary" id="colsNext" style="align-self:flex-start">Continue →</button>`;
  $("colsNext").onclick = () => buildTxnTable(body);
}

const normDesc = (s) => String(s).toLowerCase().replace(/\d+/g, "").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

const SKIP_CAT = "__skip__"; // learned marker: "this is a transfer, not spend"
const IMPORT_RECONCILE_TOLERANCE = 1;
const IMPORT_RECONCILE_DAY_WINDOW = 7;

// inter-account transfers between the user's own accounts are not spending
const looksLikeTransfer = (desc) =>
  /\b(transfer|trf|tfr|inter.?acc\w*|own acc\w*|to (credit|transact|savings|cheque)|from (credit|transact|savings|cheque))\b/i.test(desc);

function rememberedCategory(desc) {
  const mem = data.catMemory || {};
  const n = normDesc(desc);
  if (!n) return null;
  if (mem[n]) return mem[n];
  for (const key of Object.keys(mem)) {
    if (key && (n.includes(key) || key.includes(n))) return mem[key];
  }
  return null;
}

function importDayDifference(a, b) {
  const left = Date.parse(a + "T00:00:00Z");
  const right = Date.parse(b + "T00:00:00Z");
  return Math.abs(left - right) / 86400000;
}

// Match each statement row to at most one existing expense. Exact same-day
// matches are skipped as duplicates. Close amounts captured within a week are
// offered for reconciliation because manual-entry and bank posting dates can
// differ.
function findImportMatch(existing, date, amount, desc, claimedIds) {
  if (!existing) return null;
  const candidates = (existing.expenses || [])
    .filter((e) => !claimedIds.has(e.id))
    .map((e) => ({
      expense: e,
      difference: Math.abs(e.amount - amount),
      dayDifference: importDayDifference(e.date, date),
      description: e.bankDescription || e.note || ""
    }));
  const exact = candidates.find((c) =>
    c.dayDifference === 0 && c.difference < 0.005 && normDesc(c.description) === normDesc(desc));
  if (exact) return { expense: exact.expense, duplicate: true };
  const close = candidates
    .filter((c) => c.difference <= IMPORT_RECONCILE_TOLERANCE &&
      c.dayDifference <= IMPORT_RECONCILE_DAY_WINDOW)
    .sort((a, b) => a.difference - b.difference || a.dayDifference - b.dayDifference)[0];
  return close ? { expense: close.expense, duplicate: false } : null;
}

function buildTxnTable(body) {
  const dc = Number($("col-date").value), xc = Number($("col-desc").value), ac = Number($("col-amount").value);
  const month = getMonth();
  const statementHasNegativeAmounts = body.some((r) => {
    const value = parseImportAmount(r[ac] || "");
    return value !== null && value < 0;
  });

  const txns = [];
  const claimedExpenseIds = new Set();
  for (const r of body) {
    const date = parseImportDate(r[dc] || "");
    const amt = parseImportAmount(r[ac] || "");
    if (!date || amt === null || amt === 0) continue;
    const desc = (r[xc] || "").trim();
    const key = date.slice(0, 7);
    const existing = data.months[key];
    const remembered = rememberedCategory(desc);
    const transfer = remembered === SKIP_CAT || (!remembered && looksLikeTransfer(desc));
    const debit = amt < 0 || !statementHasNegativeAmounts;
    const match = debit && !transfer
      ? findImportMatch(existing, date, Math.abs(amt), desc, claimedExpenseIds)
      : null;
    if (match) claimedExpenseIds.add(match.expense.id);
    const dup = !!(match && match.duplicate);
    const matchedCategory = match && (existing.categories || []).find((c) => c.id === match.expense.catId);
    txns.push({
      date, desc, amount: Math.abs(amt), credit: !debit, dup, transfer,
      include: debit && !dup && !transfer,
      catName: transfer ? SKIP_CAT : ((matchedCategory && matchedCategory.name) || remembered || ""),
      learned: !!remembered,
      matchExpId: match && !dup ? match.expense.id : null,
      matchAmount: match && !dup ? match.expense.amount : null,
      matchDate: match && !dup ? match.expense.date : null,
      reconcile: !!(match && !dup)
    });
  }
  importState.txns = txns;

  if (!txns.length) {
    $("importBody").innerHTML = `<div class="import-note" style="color:var(--red)">No usable transactions found with those columns — go back and check the mapping.</div>
      <button class="pill-btn" id="backCols">← Back</button>`;
    $("backCols").onclick = showColumnMapping;
    return;
  }

  const catOpts = (selName) => `<option value="">— skip —</option>
    <option value="${SKIP_CAT}" ${selName === SKIP_CAT ? "selected" : ""}>🚫 Not spend (transfer)</option>` +
    month.categories.map((c) =>
      `<option value="${escapeHtml(c.name)}" ${c.name === selName ? "selected" : ""}>${c.emoji || ""} ${escapeHtml(c.name)}</option>`).join("");

  $("importBody").innerHTML = `
    <div class="import-note">
      ${txns.length} transactions. Debits are pre-selected; credits (money in) and rows matching an existing expense (duplicates) start unticked.
      Expenses within ${fmt(IMPORT_RECONCILE_TOLERANCE)} and ${IMPORT_RECONCILE_DAY_WINDOW} days are suggested as matches; choose whether to update the existing entry or import separately.
      <span style="color:var(--green)">Green</span> category boxes were filled from what you chose before.
    </div>
    <table class="import-table">
      <thead><tr><th></th><th>Date</th><th>Description</th><th style="text-align:right">Amount</th><th>Category</th></tr></thead>
      <tbody>
        ${txns.map((t, i) => `
        <tr class="${t.include ? "" : "skip"}" data-i="${i}">
          <td><input type="checkbox" data-i="${i}" class="inc" ${t.include ? "checked" : ""} /></td>
          <td style="white-space:nowrap">${t.date}</td>
          <td class="import-desc" title="${escapeHtml(t.desc)}">${escapeHtml(t.desc) || "<i>(no description)</i>"}${t.dup ? ' <span style="color:var(--amber)">· duplicate?</span>' : ""}${t.matchExpId ? `<select class="match-action" data-i="${i}"><option value="reconcile">Update ${fmt(t.matchAmount)} from ${t.matchDate}</option><option value="new">Import separately</option></select>` : ""}${t.credit ? ' <span style="color:var(--green)">· money in</span>' : ""}${t.transfer ? ' <span style="color:var(--accent)">· transfer</span>' : ""}</td>
          <td class="num">${fmt(t.amount)}</td>
          <td><select class="rowcat ${t.learned ? "learned" : ""}" data-i="${i}">${catOpts(t.catName)}</select></td>
        </tr>`).join("")}
      </tbody>
    </table>`;

  $("importBody").querySelectorAll(".inc").forEach((cb) => {
    cb.onchange = () => {
      const t = importState.txns[Number(cb.dataset.i)];
      t.include = cb.checked;
      cb.closest("tr").classList.toggle("skip", !t.include);
    };
  });
  $("importBody").querySelectorAll(".rowcat").forEach((sel) => {
    sel.onchange = () => {
      const t = importState.txns[Number(sel.dataset.i)];
      t.catName = sel.value;
      sel.classList.remove("learned");
      const row = sel.closest("tr");
      if (sel.value === SKIP_CAT || !sel.value) {
        // transfers / skips are never imported
        t.include = false;
        row.classList.add("skip");
        row.querySelector(".inc").checked = false;
      } else if (!t.include) {
        t.include = true;
        row.classList.remove("skip");
        row.querySelector(".inc").checked = true;
      }
    };
  });
  $("importBody").querySelectorAll(".match-action").forEach((sel) => {
    sel.onchange = () => {
      importState.txns[Number(sel.dataset.i)].reconcile = sel.value === "reconcile";
    };
  });
  $("importConfirm").hidden = false;
}

$("importConfirm").onclick = () => {
  const chosen = importState.txns.filter((t) => t.include && t.catName && t.catName !== SKIP_CAT);
  if (!data.catMemory) data.catMemory = {};

  // remember explicit transfer markings so they're auto-skipped next import
  for (const t of importState.txns) {
    if (t.catName === SKIP_CAT) {
      const n = normDesc(t.desc);
      if (n) data.catMemory[n] = SKIP_CAT;
    }
  }
  if (!chosen.length) { $("importBackdrop").hidden = true; persist(); return; }

  for (const t of chosen) {
    const key = t.date.slice(0, 7);
    const m = editMonthFor(key);
    let cat = m.categories.find((c) => c.name.toLowerCase() === t.catName.toLowerCase());
    if (!cat) {
      cat = { id: uid(), name: t.catName, emoji: "", budget: 0, override: null };
      m.categories.push(cat);
    }
    const matched = t.reconcile && t.matchExpId && m.expenses.find((e) => e.id === t.matchExpId);
    if (matched) {
      matched.amount = t.amount;
      matched.catId = cat.id;
      if (!matched.note) matched.note = t.desc;
      matched.bankDescription = t.desc;
      matched.importedFromStatement = true;
    } else {
      m.expenses.push({
        id: uid(), catId: cat.id, amount: t.amount, note: t.desc,
        date: t.date, createdAt: Date.now(), bankDescription: t.desc,
        importedFromStatement: true
      });
    }
    const n = normDesc(t.desc);
    if (n) data.catMemory[n] = t.catName;
  }

  $("importBackdrop").hidden = true;
  persist();
};

/* ---------- insights ---------- */

let insightsOpen = false;
let insightsMonths = 3;

$("insightsBtn").onclick = () => {
  insightsOpen = !insightsOpen;
  $("insightsBtn").textContent = insightsOpen ? "Budget" : "Insights";
  document.querySelector(".hero").hidden = insightsOpen;
  document.querySelector(".columns").hidden = insightsOpen;
  $("insightsView").hidden = !insightsOpen;
  if (insightsOpen) renderInsights();
};

$("periodSeg").querySelectorAll("button").forEach((btn) => {
  btn.onclick = () => {
    insightsMonths = Number(btn.dataset.months);
    $("periodSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    renderInsights();
  };
});

// Average monthly spend per category over the last N calendar months
// (including the current one). Categories are grouped by name so history
// survives month-to-month copies; the average divides by the number of
// months in the window that actually have expenses recorded.
function renderInsights() {
  const now = new Date();
  const keys = [];
  for (let i = 0; i < insightsMonths; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(monthKey(d.getFullYear(), d.getMonth()));
  }

  const byName = new Map(); // nameKey -> {name, emoji, total, months: Map(key -> {budget, spent})}
  let monthsWithData = 0;
  for (const key of keys) {
    const m = data.months[key];
    if (!m || !m.expenses.length) continue;
    monthsWithData++;
    const cats = Object.fromEntries(m.categories.map((c) => [c.id, c]));
    for (const exp of m.expenses) {
      const cat = cats[exp.catId];
      const name = cat ? cat.name : "(deleted category)";
      const k = name.toLowerCase();
      if (!byName.has(k)) byName.set(k, { name, emoji: cat ? cat.emoji : "", total: 0, months: new Map() });
      const rec = byName.get(k);
      rec.total += exp.amount;
      if (!rec.months.has(key)) rec.months.set(key, { budget: cat ? cat.budget : 0, spent: 0 });
      rec.months.get(key).spent += exp.amount;
    }
  }

  const list = $("insightList");
  list.innerHTML = "";
  $("insightEmpty").hidden = byName.size > 0;
  $("insightsSub").textContent = monthsWithData
    ? `Averaged over the ${monthsWithData} month${monthsWithData > 1 ? "s" : ""} with recorded spending in this period (current month included).`
    : "";
  if (!byName.size) return;

  const rows = [...byName.values()]
    .map((r) => ({ ...r, avg: r.total / monthsWithData }))
    .sort((a, b) => b.avg - a.avg);
  const maxAvg = rows[0].avg;

  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "insight-row";
    row.innerHTML = `
      <div class="insight-top">
        <span class="cat-emoji">${r.emoji || "📦"}</span>
        <span class="insight-name">${escapeHtml(r.name)}</span>
        <span class="insight-avg">${fmt(Math.round(r.avg * 100) / 100)} <span>/ month</span></span>
      </div>
      <div class="insight-bar" title="${escapeHtml(r.name)}: ${fmt(r.total)} total over ${monthsWithData} month(s)">
        <div class="insight-bar-fill" style="width:${maxAvg > 0 ? (r.avg / maxAvg) * 100 : 0}%"></div>
      </div>
      <div class="insight-months">${[...r.months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, mm]) => {
        const d = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);
        const label = d.toLocaleDateString("en-US", { month: "short" });
        const cls = mm.budget > 0 ? (mm.spent <= mm.budget ? "under" : "over") : "";
        return `<span class="month-chip ${cls}" title="${label}: spent ${fmt(mm.spent)} of ${fmt(mm.budget)} budget">${label} <b>${fmt(mm.spent)}</b>${mm.budget > 0 ? ` / ${fmt(mm.budget)}` : ""}</span>`;
      }).join("")}</div>
      <div class="insight-meta">${fmt(r.total)} total in period</div>`;
    list.appendChild(row);
  }
}

/* ---------- month navigation ---------- */

function shiftMonth(delta) {
  viewMonth += delta;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  render();
}
$("prevMonth").onclick = () => shiftMonth(-1);
$("nextMonth").onclick = () => shiftMonth(1);
$("todayBtn").onclick = () => {
  const now = new Date();
  viewYear = now.getFullYear();
  viewMonth = now.getMonth();
  render();
};

/* ---------- boot ---------- */

(async function init() {
  const now = new Date();
  viewYear = now.getFullYear();
  viewMonth = now.getMonth();
  data = (await window.budgetStore.load()) || { months: {} };
  if (!data.months) data.months = {};
  // Keep the website usable while a slow or offline connection is syncing.
  render();
  if (syncUrl()) {
    setSyncStatus("busy", "Syncing…");
    await pullFromSheets();
  }
  const recurred = applyRecurring();
  const prepurchased = applyPrepurchases();
  if (recurred || prepurchased) { persist(); } else { render(); }
})();
