/**
 * auth.js — local single-account authentication.
 * Uses Node's built-in crypto.scrypt for password hashing (industry
 * standard, no bcrypt/npm dependency needed). Sessions are random
 * tokens stored in auth.json alongside the password hash, so a login
 * survives server restarts (closing Termux, reopening the app, etc.)
 * until it expires.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_FILE = path.join(process.env.MICKYETS_DATA_DIR || __dirname, 'auth.json');
const SESSION_DAYS = 30;
const COOKIE_NAME = 'cma_session';

function loadAuth() {
  if (!fs.existsSync(AUTH_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')); } catch (e) { return null; }
}

function saveAuth(data) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

function hasAccount() {
  const a = loadAuth();
  return !!(a && a.username && a.hash);
}

function getUsername() {
  const a = loadAuth();
  return a ? a.username : null;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createAccount(username, password) {
  if (hasAccount()) throw new Error('An account already exists');
  if (!username || username.length < 2) throw new Error('Username must be at least 2 characters');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  saveAuth({ username, salt, hash, sessions: [] });
}

function verifyPassword(username, password) {
  const a = loadAuth();
  if (!a || a.username !== username) return false;
  const candidate = hashPassword(password, a.salt);
  const a1 = Buffer.from(candidate, 'hex');
  const a2 = Buffer.from(a.hash, 'hex');
  if (a1.length !== a2.length) return false;
  return crypto.timingSafeEqual(a1, a2);
}

function pruneExpired(a) {
  const now = Date.now();
  a.sessions = (a.sessions || []).filter(s => s.expires > now);
}

function createSession() {
  const a = loadAuth();
  if (!a) throw new Error('No account exists');
  pruneExpired(a);
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  a.sessions.push({ token, expires });
  saveAuth(a);
  return { token, maxAgeSeconds: SESSION_DAYS * 24 * 60 * 60 };
}

function destroySession(token) {
  const a = loadAuth();
  if (!a) return;
  a.sessions = (a.sessions || []).filter(s => s.token !== token);
  saveAuth(a);
}

function isValidSession(token) {
  if (!token) return false;
  const a = loadAuth();
  if (!a) return false;
  pruneExpired(a);
  const found = (a.sessions || []).find(s => s.token === token);
  return !!found;
}

function changePassword(username, oldPassword, newPassword) {
  if (!verifyPassword(username, oldPassword)) throw new Error('Current password is incorrect');
  if (!newPassword || newPassword.length < 6) throw new Error('New password must be at least 6 characters');
  const a = loadAuth();
  const salt = crypto.randomBytes(16).toString('hex');
  a.salt = salt;
  a.hash = hashPassword(newPassword, salt);
  a.sessions = []; // force re-login everywhere after a password change
  saveAuth(a);
}

// ---- tiny cookie helpers (no npm dependency) ----
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function sessionCookieHeader(token, maxAgeSeconds) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`;
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

function getSessionToken(req) {
  return parseCookies(req)[COOKIE_NAME];
}

function requestIsAuthenticated(req) {
  return isValidSession(getSessionToken(req));
}

module.exports = {
  COOKIE_NAME,
  hasAccount, getUsername, createAccount, verifyPassword,
  createSession, destroySession, isValidSession,
  changePassword,
  sessionCookieHeader, clearCookieHeader, getSessionToken, requestIsAuthenticated
};
