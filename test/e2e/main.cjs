// End-to-end test: loads the real main.js in Electron with a mocked 'obsidian' module.
// Run: npm run build && npm run test:e2e   (Linux CI: wrap in xvfb-run)
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 620, show: true, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  win.webContents.on('console-message', (e) => { const m = e.message ?? e; console.log('[renderer]', typeof m === 'string' ? m : JSON.stringify(m)); });
  ipcMain.handle('shot', async (_e, name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(name, img.toPNG()); return true; });
  ipcMain.handle('resize', async (_e, w, h) => { win.setContentSize(w, h); return true; });
  ipcMain.handle('done', (_e, code) => { setTimeout(() => app.exit(code), 200); });
  await win.loadFile('index.html');
});
