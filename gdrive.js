/**
 * gdrive.js — minimal Google Drive backup support using only Node's
 * built-in https module. No googleapis package, no npm install.
 *
 * Uses OAuth 2.0 Device Flow (no redirect URI needed — perfect for a
 * phone/Termux server): the user visits a short Google URL on ANY
 * device and types in a code, instead of the app needing a browser
 * callback.
 *
 * Scope used: drive.file — the app can only see/edit files IT created,
 * never the rest of the user's Drive.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(process.env.MICKYETS_DATA_DIR || __dirname, 'gdrive-config.json');
const BACKUP_FILENAME = 'mickyets-business-tracker-backup.json';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch (e) { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch (e) { /* leave as raw text */ }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function formBody(obj) {
  return Object.entries(obj).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
}

function isConfigured() {
  const cfg = loadConfig();
  return !!(cfg.clientId && cfg.clientSecret);
}

function isConnected() {
  const cfg = loadConfig();
  return !!(cfg.clientId && cfg.clientSecret && cfg.refreshToken);
}

function status() {
  const cfg = loadConfig();
  return {
    configured: !!(cfg.clientId && cfg.clientSecret),
    connected: !!cfg.refreshToken,
    lastBackup: cfg.lastBackup || null,
    fileId: cfg.fileId || null
  };
}

function saveClientCredentials(clientId, clientSecret) {
  const cfg = loadConfig();
  cfg.clientId = clientId;
  cfg.clientSecret = clientSecret;
  saveConfig(cfg);
}

function disconnect() {
  const cfg = loadConfig();
  delete cfg.refreshToken;
  delete cfg.fileId;
  delete cfg.lastBackup;
  saveConfig(cfg);
}

// ---- step 1: ask Google for a device code + short user code ----
async function startDeviceAuth() {
  const cfg = loadConfig();
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('Google Client ID/Secret not saved yet');
  const body = formBody({ client_id: cfg.clientId, scope: SCOPE });
  const res = await request({
    hostname: 'oauth2.googleapis.com',
    path: '/device/code',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  if (res.status !== 200) throw new Error((res.data && res.data.error_description) || 'Failed to start Google authorization');
  // stash the device_code briefly so the poll step can use it
  cfg.pendingDeviceCode = res.data.device_code;
  cfg.pendingInterval = res.data.interval || 5;
  saveConfig(cfg);
  return {
    userCode: res.data.user_code,
    verificationUrl: res.data.verification_url || res.data.verification_uri,
    expiresIn: res.data.expires_in
  };
}

// ---- step 2: poll once to see if the user has approved it yet ----
async function pollDeviceAuth() {
  const cfg = loadConfig();
  if (!cfg.pendingDeviceCode) throw new Error('No pending Google authorization — start again');
  const body = formBody({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    device_code: cfg.pendingDeviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  });
  const res = await request({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  }, body);

  if (res.status === 200 && res.data.refresh_token) {
    cfg.refreshToken = res.data.refresh_token;
    delete cfg.pendingDeviceCode;
    saveConfig(cfg);
    return { status: 'connected' };
  }
  const err = res.data && res.data.error;
  if (err === 'authorization_pending') return { status: 'pending' };
  if (err === 'slow_down') return { status: 'pending' };
  if (err === 'expired_token') { delete cfg.pendingDeviceCode; saveConfig(cfg); return { status: 'expired' }; }
  if (err === 'access_denied') { delete cfg.pendingDeviceCode; saveConfig(cfg); return { status: 'denied' }; }
  throw new Error((res.data && res.data.error_description) || 'Google authorization failed');
}

// ---- get a fresh access token using the stored refresh token ----
async function getAccessToken() {
  const cfg = loadConfig();
  if (!cfg.refreshToken) throw new Error('Not connected to Google Drive yet');
  const body = formBody({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: 'refresh_token'
  });
  const res = await request({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  if (res.status !== 200 || !res.data.access_token) {
    throw new Error((res.data && res.data.error_description) || 'Could not refresh Google access token');
  }
  return res.data.access_token;
}

// ---- upload / update the backup file on Drive ----
async function backupToDrive(jsonString) {
  const cfg = loadConfig();
  const accessToken = await getAccessToken();

  if (cfg.fileId) {
    // update existing file's content
    const res = await request({
      hostname: 'www.googleapis.com',
      path: '/upload/drive/v3/files/' + cfg.fileId + '?uploadType=media',
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(jsonString)
      }
    }, jsonString);
    if (res.status === 200) {
      cfg.lastBackup = new Date().toISOString();
      saveConfig(cfg);
      return { fileId: cfg.fileId, updated: true };
    }
    // fall through to create-new if the old file id is no longer valid (e.g. deleted on Drive)
  }

  // create a new file (media-only upload has no name, so PATCH the name in afterward)
  const createRes = await request({
    hostname: 'www.googleapis.com',
    path: '/upload/drive/v3/files?uploadType=media',
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(jsonString)
    }
  }, jsonString);
  if (createRes.status !== 200 || !createRes.data.id) {
    throw new Error((createRes.data && createRes.data.error && createRes.data.error.message) || 'Google Drive upload failed');
  }
  const fileId = createRes.data.id;
  const nameBody = JSON.stringify({ name: BACKUP_FILENAME });
  await request({
    hostname: 'www.googleapis.com',
    path: '/drive/v3/files/' + fileId,
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(nameBody) }
  }, nameBody);

  cfg.fileId = fileId;
  cfg.lastBackup = new Date().toISOString();
  saveConfig(cfg);
  return { fileId, updated: false };
}

// ---- download the backup file's content from Drive ----
async function restoreFromDrive() {
  const cfg = loadConfig();
  const accessToken = await getAccessToken();
  let fileId = cfg.fileId;

  if (!fileId) {
    // no fileId stored locally (e.g. fresh install) — search Drive for it by name
    const q = encodeURIComponent(`name='${BACKUP_FILENAME}' and trashed=false`);
    const searchRes = await request({
      hostname: 'www.googleapis.com',
      path: '/drive/v3/files?q=' + q + '&spaces=drive&fields=files(id,name)',
      method: 'GET',
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    const found = searchRes.data && searchRes.data.files && searchRes.data.files[0];
    if (!found) throw new Error('No backup found on Google Drive');
    fileId = found.id;
    cfg.fileId = fileId;
    saveConfig(cfg);
  }

  const fileRes = await request({
    hostname: 'www.googleapis.com',
    path: '/drive/v3/files/' + fileId + '?alt=media',
    method: 'GET',
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (fileRes.status !== 200) throw new Error('Could not download backup from Google Drive');
  return typeof fileRes.data === 'string' ? fileRes.data : JSON.stringify(fileRes.data);
}

module.exports = {
  isConfigured, isConnected, status, saveClientCredentials, disconnect,
  startDeviceAuth, pollDeviceAuth, backupToDrive, restoreFromDrive
};
