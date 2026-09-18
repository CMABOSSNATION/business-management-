/**
 * electron/main.js
 *
 * Why this looks different from a typical "Electron wraps a local server"
 * setup: the previous version ran a real TCP server on 127.0.0.1 and had
 * the browser window fetch from it. On some Windows machines, security
 * software intercepts exactly that kind of traffic — even pure loopback —
 * because a Chromium-based renderer making HTTP calls looks identical to
 * a real browser tab to that software, and it hangs or blocks it. That's
 * what caused "the app's internal server did not respond".
 *
 * The fix: don't open a network port at all on desktop. A custom `app://`
 * protocol serves the UI straight from disk, and every `/api/...` fetch()
 * the frontend makes is intercepted by that same protocol handler and
 * answered by calling server.js's route logic directly, in-process — the
 * exact same code that runs Termux's real HTTP server, just invoked as a
 * plain function call instead of over a socket. Nothing for a firewall or
 * antivirus product to see or block, because there's no network traffic.
 *
 * Termux is unaffected by any of this: `node server.js` still opens a
 * real HTTP server, because that's the only way a phone browser can reach
 * it. See the `require.main === module` guard at the bottom of server.js.
 */
const { app, BrowserWindow, protocol, shell } = require('electron');
const fs = require('fs');

// ── Single-instance lock ─────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ── GPU / rendering safety net ───────────────────────────────────────────
// Avoids a blank window on some older GPUs / VMs / remote-desktop sessions.
app.disableHardwareAcceleration();

// ── Writable data directory ──────────────────────────────────────────────
// A packaged app's own install folder isn't reliably writable (and may be
// read-only entirely if asar-packed). Electron's userData path always is.
const userDataDir = app.getPath('userData');
try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (_) { /* already exists */ }
process.env.MICKYETS_DATA_DIR = userDataDir;

// server.js only starts a real TCP listener when run directly (Termux).
// Required as a module like this, it just gives us `handleRequest` to
// call ourselves — no port is ever opened here.
const { handleRequest } = require('../server.js');

// ── Custom protocol registration (must happen before app is ready) ──────
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,        // gives it normal URL-resolution behaviour, so
                              // root-relative paths like "/css/style.css"
                              // resolve against app://mickyets correctly
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true
    }
  }
]);

// ── Adapter: turns a Fetch API Request into the same (req, res) shape
//    server.js's handleRequest already expects from Node's http module ──
async function callServerInProcess(request) {
  const u = new URL(request.url);
  const headers = {};
  for (const [key, value] of request.headers) headers[key.toLowerCase()] = value;

  let bodyText;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try { bodyText = await request.text(); } catch (_) { bodyText = ''; }
  }

  const fakeReq = {
    method: request.method,
    url: u.pathname + u.search,
    headers,
    _bufferedBody: bodyText
  };

  return new Promise((resolve) => {
    const fakeRes = {
      _headers: {},
      _status: 200,
      setHeader(name, val) { this._headers[name] = val; },
      writeHead(status, hdrs) { this._status = status; if (hdrs) Object.assign(this._headers, hdrs); },
      end(body) {
        resolve({ status: this._status, headers: this._headers, body: body === undefined ? '' : body });
      }
    };
    handleRequest(fakeReq, fakeRes);
  });
}

function protocolResponse(result) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(result.headers)) {
    // Content-Length is computed automatically for us; skip forwarding it
    // to avoid a mismatch, and Set-Cookie is harmless to include but not
    // relied on — the app authenticates via an X-Session-Token header
    // stored client-side instead, since custom-protocol cookie handling
    // is inconsistent across Chromium versions.
    if (key.toLowerCase() === 'content-length') continue;
    headers.set(key, value);
  }
  const body = typeof result.body === 'string' ? result.body : result.body;
  return new Response(body, { status: result.status, headers });
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL('app://mickyets/');

  // Open target="_blank" links (Google Drive setup link, the device-auth
  // verification link) in the OS browser, not a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    try {
      const result = await callServerInProcess(request);
      return protocolResponse(result);
    } catch (e) {
      return new Response('Internal error: ' + e.message, { status: 500 });
    }
  });

  createWindow();

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
