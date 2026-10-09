/* ============ Browser bridge for app.js on mobile ============ *
 * Mirrors preload.js + main.js's IPC handlers exactly, but backed by
 * localStorage (instead of the userData JSON file) and direct fetch()
 * (instead of Electron's main-process fetch). app.js itself is untouched —
 * it only ever talks to window.budgetStore, never to Electron directly.
 */

const STORAGE_KEY = "budget-majik-data";

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { months: {} };
  } catch {
    return { months: {} };
  }
}

function saveLocal(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

async function syncRequest(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: "follow", cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return await response.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Sync timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function pickJsonFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(reader.result));
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    };
    input.click();
  });
}

window.budgetStore = {
  load: async () => loadLocal(),

  save: async (data) => {
    saveLocal(data);
    return true;
  },

  syncPull: async (url) => {
    // Apps Script redirects ContentService responses to a short-lived
    // script.googleusercontent.com URL. A browser may cache that redirect,
    // then later follow its expired target and receive a 404. Give every pull
    // a unique Apps Script URL and forbid use of cached redirects.
    const target = new URL(url);
    target.searchParams.set("_sync", String(Date.now()));
    return await syncRequest(target);
  },

  syncPush: async (url, data, expectedUpdatedAt) => {
    const target = new URL(url);
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null) {
      target.searchParams.set("expectedUpdatedAt", String(expectedUpdatedAt));
    }
    const result = await syncRequest(target, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(data)
    });
    if (!result || result.ok !== true) {
      const err = new Error(result && result.error || "Sync was rejected");
      err.code = result && result.conflict ? "SYNC_CONFLICT" : result && result.retryable ? "SYNC_TEMPORARY" : "SYNC_REJECTED";
      throw err;
    }
    return result;
  },

  backupExport: async (data) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `budget-majik-backup-${stamp}.json`;
    downloadJson(filename, data);
    return filename;
  },

  backupImport: async () => {
    const parsed = await pickJsonFile();
    if (!parsed) return null;
    if (!parsed || typeof parsed.months !== "object") throw new Error("Not a Budget Majik backup file");
    return parsed;
  }
};
