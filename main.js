const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const dataFile = () => path.join(app.getPath('userData'), 'budget-data.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch {
    return { months: {} };
  }
}

function saveData(data) {
  const file = dataFile();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#0b0d16',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('renderer/index.html');
}

ipcMain.handle('data:load', () => loadData());
ipcMain.handle('data:save', (_e, data) => {
  saveData(data);
  return true;
});

ipcMain.handle('backup:export', async (_e, data) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export backup',
    defaultPath: `budget-majik-backup-${stamp}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return filePath;
});

ipcMain.handle('backup:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Restore backup',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return null;
  const parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
  if (!parsed || typeof parsed.months !== 'object') throw new Error('Not a Budget Majik backup file');
  return parsed;
});

// Google Sheets sync via the user's Apps Script web app. Runs in the main
// process so the renderer CSP can stay locked down.
ipcMain.handle('sync:pull', async (_e, url) => {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
});
ipcMain.handle('sync:push', async (_e, url, payload) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
