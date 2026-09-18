/**
 * electron/main.js
 * Desktop wrapper around the same server.js used on Termux.
 */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Single-instance lock ──────────────────────────────────────────────────────
// Without this, double-clicking the icon (or clicking it while it's still
// starting) opens a second copy of the app.  The second copy tries to bind
// port 4173, gets EADDRINUSE, and both copies hang.  The lock means every
// extra click just focuses the already-running window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance is already running — let it handle things and exit.
  app.quit();
}

// ── GPU / rendering ───────────────────────────────────────────────────────────
// Prevents a blank-black window on older GPUs / VMs / remote-desktop sessions.
app.disableHardwareAcceleration();

// ── Port & data directory ─────────────────────────────────────────────────────
const PORT = parseInt(process.env.MICKYETS_PORT || '4173', 10);
process.env.PORT = String(PORT);

// app.getPath('userData') is safe before ready on all current Electron
// versions, but the *directory* may not exist yet on a fresh install.
// We create it here so the server can write its data files immediately.
const userDataDir = app.getPath('userData');
try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (_) {}
process.env.MICKYETS_DATA_DIR = userDataDir;

// ── Start the internal server ─────────────────────────────────────────────────
let serverStartError = null;
try {
  require('../server.js');
} catch (e) {
  serverStartError = e;
}

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow;

// Loading page shown immediately so the user knows the app is starting.
// Without this, show:false + a slow server = user sees nothing and clicks again.
const LOADING_HTML = `data:text/html,
<!DOCTYPE html><html>
<head><meta charset="utf-8">
<style>
  body{margin:0;background:#0f1115;display:flex;flex-direction:column;
       align-items:center;justify-content:center;height:100vh;
       font-family:'Segoe UI',Arial,sans-serif;color:#c9f7d9;}
  .ring{width:48px;height:48px;border:4px solid #1a4a2e;
        border-top-color:#3ef07a;border-radius:50%;
        animation:spin 0.9s linear infinite;margin-bottom:24px;}
  @keyframes spin{to{transform:rotate(360deg)}}
  p{font-size:14px;opacity:0.7;letter-spacing:1px;}
</style></head>
<body><div class="ring"></div><p>STARTING MICKYETS…</p></body></html>`;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: true, // show immediately with the loading page — no hidden wait
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Show the spinner loading page right away so the user sees something.
  mainWindow.loadURL(LOADING_HTML);

  // If the renderer dies (low-memory / old GPU), reload instead of blank.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const usePort = process.MICKYETS_ACTUAL_PORT || PORT;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL('http://127.0.0.1:' + usePort);
    }
  });

  // Open target="_blank" links in the OS browser, not a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  startRetrying();
}

// ── Retry loop ────────────────────────────────────────────────────────────────
// Polls until the server responds, then swaps the loading page for the real app.
// 120 retries × 500 ms = 60 seconds — generous enough for Windows Defender to
// finish scanning the new executable on first run.
const MAX_RETRIES = 120;
let retriesLeft  = MAX_RETRIES;

function startRetrying() {
  retriesLeft = MAX_RETRIES;
  tryLoad();
}

function tryLoad() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const usePort = process.MICKYETS_ACTUAL_PORT || PORT;
  const url     = 'http://127.0.0.1:' + usePort;

  mainWindow.loadURL(url).then(() => {
    // Success: the loading page is replaced by the real app.
    // Nothing else to do.
  }).catch(() => {
    if (retriesLeft > 0) {
      retriesLeft--;
      setTimeout(tryLoad, 500);
    } else {
      dialog.showErrorBox(
        'MICKYETS could not start',
        'The app\'s internal server did not respond after 60 seconds.\n\n' +
        'Things to try:\n' +
        '• Check Task Manager for a leftover MICKYETS or electron.exe process and end it\n' +
        '• Temporarily disable antivirus / Windows Defender real-time protection and retry\n' +
        '• Run the app as Administrator once\n\n' +
        'If it keeps happening, contact support.'
      );
    }
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  if (serverStartError) {
    dialog.showErrorBox(
      'MICKYETS could not start',
      'The internal server failed to initialise:\n\n' +
      serverStartError.message +
      '\n\nPlease reinstall the app. If this keeps happening, contact support.'
    );
    app.quit();
    return;
  }

  createWindow();

  // Focus the existing window if a second instance tries to open.
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
