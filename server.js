/**
 * MICKYETS - server.js
 * Pure Node.js (no npm install needed) so it runs cleanly in Termux.
 * Storage: single JSON file (data.json) next to this script.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const gdrive = require('./gdrive');
const auth = require('./auth');

const DATA_DIR = process.env.MICKYETS_DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// candidate folders on Android shared storage that are visible over USB
// (requires `termux-setup-storage` to have been run once)
const USB_BACKUP_DIRS = [
  path.join(process.env.HOME || '', 'storage', 'shared', 'MICKYETS-Backups'),
  '/sdcard/MICKYETS-Backups',
  '/storage/emulated/0/MICKYETS-Backups'
];

const EXPENSE_CATEGORIES = [
  'Home', 'Breakfast', 'Lunch', 'Supper', 'Transport',
  'Debt', 'Airtime', 'Other', 'Home Rent'
];
const INCOME_SOURCES = ['Stationary', 'WiFi'];
const SAVINGS_BUCKETS = ['business', 'home', 'emergency'];

// ---------- data layer ----------
function defaultData() {
  const savings = {};
  SAVINGS_BUCKETS.forEach(b => {
    savings[b] = { target: 0, balance: 0, history: [] };
  });
  return { income: [], expenses: [], savings, goals: [], inventory: [], sales: [], customers: [], credits: [] };
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = defaultData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    if (!parsed.inventory) parsed.inventory = [];
    if (!parsed.sales) parsed.sales = [];
    if (!parsed.customers) parsed.customers = [];
    if (!parsed.credits) parsed.credits = [];
    return parsed;
  } catch (e) {
    console.error('data.json is corrupt, starting fresh backup kept as data.json.bak');
    fs.renameSync(DATA_FILE, DATA_FILE + '.bak');
    const initial = defaultData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- http helpers ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function parseBody(req, cb) {
  // Electron's custom-protocol path hands us the body already buffered
  // (no real socket to stream from) — handle that case directly.
  if (req._bufferedBody !== undefined) {
    try {
      cb(null, req._bufferedBody ? JSON.parse(req._bufferedBody) : {});
    } catch (e) {
      cb(e);
    }
    return;
  }
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      cb(null, body ? JSON.parse(body) : {});
    } catch (e) {
      cb(e);
    }
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');

  let filePath = path.join(PUBLIC_DIR, safePath === '/' ? 'index.html' : safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      // SPA fallback -> index.html. The auth gate itself lives client-side
      // (app.js checks /api/auth/status on load and redirects if needed) —
      // that works the same whether the page came over real HTTP (Termux)
      // or Electron's custom protocol, so there's nothing to branch on here.
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, content2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(content2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- business logic ----------
function monthKey(dateStr) {
  return (dateStr || today()).slice(0, 7); // YYYY-MM
}

function checkGoals(data, bucket) {
  data.goals.forEach(g => {
    if (g.linkedBucket === bucket && !g.achieved) {
      if (data.savings[bucket].balance >= g.target) {
        g.achieved = true;
        g.achievedDate = today();
      }
    }
  });
}

function buildReports(data) {
  const months = {}; // { '2026-09': {income, expense} }
  data.income.forEach(i => {
    const m = monthKey(i.date);
    months[m] = months[m] || { income: 0, expense: 0 };
    months[m].income += Number(i.amount) || 0;
  });
  data.expenses.forEach(e => {
    const m = monthKey(e.date);
    months[m] = months[m] || { income: 0, expense: 0 };
    months[m].expense += Number(e.amount) || 0;
  });

  let bestIncomeMonth = null;
  let worstExpenseMonth = null;
  Object.entries(months).forEach(([m, v]) => {
    if (!bestIncomeMonth || v.income > months[bestIncomeMonth].income) bestIncomeMonth = m;
    if (!worstExpenseMonth || v.expense > months[worstExpenseMonth].expense) worstExpenseMonth = m;
  });

  const savingsGrowth = SAVINGS_BUCKETS.map(b => ({
    bucket: b,
    balance: data.savings[b].balance,
    target: data.savings[b].target,
    history: data.savings[b].history
  }));

  const outstandingCredit = data.credits.filter(c => !c.paid).reduce((s, c) => s + Number(c.amount), 0);

  return {
    months,
    bestIncomeMonth,
    worstExpenseMonth,
    savingsGrowth,
    outstandingCredit,
    meta: { expenseCategories: EXPENSE_CATEGORIES, incomeSources: INCOME_SOURCES }
  };
}

// ---------- router ----------
// Named so it can be reused both by the real http.createServer below
// (Termux / `node server.js` directly) and, unchanged, by Electron's
// custom-protocol handler (electron/main.js) via fake req/res objects —
// same business logic, two different transports.
function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname.startsWith('/api/')) {
    const segs = pathname.split('/').filter(Boolean); // ['api', ...]

    // ---- auth routes: never require an existing session themselves ----
    if (segs[1] === 'auth') {
      if (segs[2] === 'status' && req.method === 'GET') {
        return sendJSON(res, 200, {
          hasAccount: auth.hasAccount(),
          loggedIn: auth.requestIsAuthenticated(req),
          username: auth.requestIsAuthenticated(req) ? auth.getUsername() : null
        });
      }
      if (segs[2] === 'setup' && req.method === 'POST') {
        return parseBody(req, (err, body) => {
          if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
          try {
            auth.createAccount((body.username || '').trim(), body.password || '');
            const session = auth.createSession();
            res.setHeader('Set-Cookie', auth.sessionCookieHeader(session.token, session.maxAgeSeconds));
            return sendJSON(res, 201, { ok: true, token: session.token });
          } catch (e) {
            return sendJSON(res, 400, { error: e.message });
          }
        });
      }
      if (segs[2] === 'login' && req.method === 'POST') {
        return parseBody(req, (err, body) => {
          if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
          if (!auth.verifyPassword((body.username || '').trim(), body.password || '')) {
            return sendJSON(res, 401, { error: 'Incorrect username or password' });
          }
          const session = auth.createSession();
          res.setHeader('Set-Cookie', auth.sessionCookieHeader(session.token, session.maxAgeSeconds));
          return sendJSON(res, 200, { ok: true, token: session.token });
        });
      }
      if (segs[2] === 'logout' && req.method === 'POST') {
        auth.destroySession(auth.getSessionToken(req));
        res.setHeader('Set-Cookie', auth.clearCookieHeader());
        return sendJSON(res, 200, { ok: true });
      }
      if (segs[2] === 'change-password' && req.method === 'POST') {
        if (!auth.requestIsAuthenticated(req)) return sendJSON(res, 401, { error: 'Not authenticated' });
        return parseBody(req, (err, body) => {
          if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
          try {
            auth.changePassword(auth.getUsername(), body.oldPassword, body.newPassword);
            res.setHeader('Set-Cookie', auth.clearCookieHeader());
            return sendJSON(res, 200, { ok: true });
          } catch (e) {
            return sendJSON(res, 400, { error: e.message });
          }
        });
      }
      return sendJSON(res, 404, { error: 'Not found' });
    }

    // ---- everything else under /api/ requires a valid, logged-in session ----
    if (!auth.requestIsAuthenticated(req)) {
      return sendJSON(res, 401, { error: 'Not authenticated' });
    }

    const data = loadData();

    if (req.method === 'GET' && pathname === '/api/data') {
      return sendJSON(res, 200, {
        ...data,
        meta: { expenseCategories: EXPENSE_CATEGORIES, incomeSources: INCOME_SOURCES, savingsBuckets: SAVINGS_BUCKETS }
      });
    }

    if (req.method === 'GET' && pathname === '/api/reports/summary') {
      return sendJSON(res, 200, buildReports(data));
    }

    // ---- income ----
    if (segs[1] === 'income') {
      if (req.method === 'POST' && segs.length === 2) {
        return parseBody(req, (err, body) => {
          if (err || !body.amount) return sendJSON(res, 400, { error: 'amount is required' });
          const entry = {
            id: genId(),
            source: body.source || INCOME_SOURCES[0],
            amount: Number(body.amount),
            date: body.date || today(),
            note: body.note || ''
          };
          data.income.push(entry);
          saveData(data);
          return sendJSON(res, 201, entry);
        });
      }
      if (req.method === 'DELETE' && segs.length === 3) {
        data.income = data.income.filter(i => i.id !== segs[2]);
        saveData(data);
        return sendJSON(res, 200, { ok: true });
      }
    }

    // ---- expenses ----
    if (segs[1] === 'expenses') {
      if (req.method === 'POST' && segs.length === 2) {
        return parseBody(req, (err, body) => {
          if (err || !body.amount) return sendJSON(res, 400, { error: 'amount is required' });
          const entry = {
            id: genId(),
            category: body.category || 'Other',
            amount: Number(body.amount),
            date: body.date || today(),
            note: body.note || ''
          };
          data.expenses.push(entry);
          saveData(data);
          return sendJSON(res, 201, entry);
        });
      }
      if (req.method === 'DELETE' && segs.length === 3) {
        data.expenses = data.expenses.filter(e => e.id !== segs[2]);
        saveData(data);
        return sendJSON(res, 200, { ok: true });
      }
    }

    // ---- savings: /api/savings/:bucket/(deposit|withdraw|target) ----
    if (segs[1] === 'savings' && segs.length >= 3) {
      const bucket = segs[2];
      if (!data.savings[bucket]) return sendJSON(res, 404, { error: 'Unknown bucket' });

      if (segs[3] === 'deposit' && req.method === 'POST') {
        return parseBody(req, (err, body) => {
          if (err || !body.amount) return sendJSON(res, 400, { error: 'amount is required' });
          const amt = Number(body.amount);
          data.savings[bucket].balance += amt;
          data.savings[bucket].history.push({ id: genId(), type: 'deposit', amount: amt, date: body.date || today(), note: body.note || '' });
          checkGoals(data, bucket);
          saveData(data);
          return sendJSON(res, 200, data.savings[bucket]);
        });
      }
      if (segs[3] === 'withdraw' && req.method === 'POST') {
        return parseBody(req, (err, body) => {
          if (err || !body.amount) return sendJSON(res, 400, { error: 'amount is required' });
          const amt = Number(body.amount);
          data.savings[bucket].balance -= amt;
          data.savings[bucket].history.push({ id: genId(), type: 'withdraw', amount: amt, date: body.date || today(), note: body.note || '' });
          saveData(data);
          return sendJSON(res, 200, data.savings[bucket]);
        });
      }
      if (segs[3] === 'target' && req.method === 'PUT') {
        return parseBody(req, (err, body) => {
          if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
          data.savings[bucket].target = Number(body.target) || 0;
          saveData(data);
          return sendJSON(res, 200, data.savings[bucket]);
        });
      }
    }

    // ---- inventory ----
    if (segs[1] === 'inventory') {
      if (req.method === 'POST' && segs.length === 2) {
        return parseBody(req, (err, body) => {
          if (err || !body.name) return sendJSON(res, 400, { error: 'name is required' });
          const item = {
            id: genId(),
            name: body.name,
            quantity: Number(body.quantity) || 0,
            unitCost: Number(body.unitCost) || 0,
            sellingPrice: Number(body.sellingPrice) || 0,
            reorderLevel: Number(body.reorderLevel) || 0
          };
          data.inventory.push(item);
          saveData(data);
          return sendJSON(res, 201, item);
        });
      }
      if (req.method === 'PUT' && segs.length === 3) {
        return parseBody(req, (err, body) => {
          const item = data.inventory.find(i => i.id === segs[2]);
          if (!item) return sendJSON(res, 404, { error: 'Item not found' });
          if (err) return sendJSON(res, 400, { error: 'Invalid JSON' });
          if (body.name !== undefined) item.name = body.name;
          if (body.unitCost !== undefined) item.unitCost = Number(body.unitCost);
          if (body.sellingPrice !== undefined) item.sellingPrice = Number(body.sellingPrice);
          if (body.reorderLevel !== undefined) item.reorderLevel = Number(body.reorderLevel);
          if (body.restock !== undefined) item.quantity += Number(body.restock);
          if (body.setQuantity !== undefined) item.quantity = Number(body.setQuantity);
          saveData(data);
          return sendJSON(res, 200, item);
        });
      }
      if (req.method === 'DELETE' && segs.length === 3) {
        data.inventory = data.inventory.filter(i => i.id !== segs[2]);
        saveData(data);
        return sendJSON(res, 200, { ok: true });
      }
    }

    // ---- daily sales ----
    if (segs[1] === 'sales') {
      if (req.method === 'POST' && segs.length === 2) {
        return parseBody(req, (err, body) => {
          if (err || !body.amount) return sendJSON(res, 400, { error: 'amount is required' });
          const qty = Number(body.quantity) || 1;
          let itemName = body.itemName || '';
          if (body.itemId) {
            const item = data.inventory.find(i => i.id === body.itemId);
            if (item) {
              item.quantity = Math.max(0, item.quantity - qty);
              itemName = item.name;
            }
          }
          const sale = {
            id: genId(),
            itemId: body.itemId || null,
            itemName,
            quantity: qty,
            amount: Number(body.amount),
            date: body.date || today(),
            note: body.note || ''
          };
          data.sales.push(sale);
          saveData(data);
          return sendJSON(res, 201, sale);
        });
      }
      if (req.method === 'DELETE' && segs.length === 3) {
        data.sales = data.sales.filter(s => s.id !== segs[2]);
        saveData(data);
        return sendJSON(res, 200, { ok: true });
      }
    }

    // ---- customers ----
    if (segs[1] === 'customers') {
      if (req.method === 'POST' && segs.length === 2) {
        return parseBody(req, (err, body) => {
          if (err || !body.name) return sendJSON(res, 400, { error: 'name is required' });
          const customer = {
            id: genId(),
            name: body.name,
            phone: body.phone || '',
            notes: body.notes || '',
            createdDate: today()
          };
          data.customers.push(customer);
          saveData(data);
          return sendJSON(res, 201, customer);
        });
      }
      if (req.method === 'DELETE' && segs.length === 3) {
        data.customers = data.customers.filter(c => c.id !== segs[2]);
        saveData(data);
        return sendJSON(res, 200, { ok: true });
      }
    }

    // ---- credits (accounts receivable: money customers owe the business) ----
    if (segs[1] === 'credits') {
      if (req.method === 'POST' && segs.length === 2) {
        return parseBody(req, (err, body) => {
          if (err || !body.amount) return sendJSON(res, 400, { error: 'amount is required' });
          let customerName = body.customerName || '';
          if (body.customerId) {
            const cust = data.customers.find(c => c.id === body.customerId);
            if (cust) customerName = cust.name;
          }
          const credit = {
            id: genId(),
            customerId: body.customerId || null,
            customerName: customerName || 'Unnamed customer',
            source: INCOME_SOURCES.includes(body.source) ? body.source : INCOME_SOURCES[0],
            description: body.description || '',
            amount: Number(body.amount),
            date: body.date || today(),
            dueDate: body.dueDate || null,
            paid: false,
            paidDate: null
          };
          data.credits.push(credit);
          saveData(data);
          return sendJSON(res, 201, credit);
        });
      }
      if (segs[2] && segs[3] === 'pay' && req.method === 'POST') {
        return parseBody(req, (err, body) => {
          const credit = data.credits.find(c => c.id === segs[2]);
          if (!credit) return sendJSON(res, 404, { error: 'Credit record not found' });
          if (credit.paid) return sendJSON(res, 400, { error: 'Already marked as paid' });
          credit.paid = true;
          credit.paidDate = (body && body.date) || today();
          // paying off a debt is money entering the business: log it as income
          data.income.push({
            id: genId(),
            source: credit.source,
            amount: credit.amount,
            date: credit.paidDate,
            note: 'Credit payment: ' + credit.customerName + (credit.description ? ' — ' + credit.description : '')
          });
          saveData(data);
          return sendJSON(res, 200, credit);
        });
      }
      if (req.method === 'DELETE' && segs.length === 3) {
        data.credits = data.credits.filter(c => c.id !== segs[2]);
        saveData(data);
        return sendJSON(res, 200, { ok: true });
      }
    }

    // ---- local / USB backup (writes into shared storage, visible over USB) ----
    if (segs[1] === 'backup') {
      if (segs[2] === 'export' && req.method === 'GET') {
        const content = fs.readFileSync(DATA_FILE, 'utf-8');
        const filename = 'mickyets-backup-' + today() + '.json';
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="' + filename + '"',
          'Content-Length': Buffer.byteLength(content)
        });
        return res.end(content);
      }
      if (segs[2] === 'restore' && req.method === 'POST') {
        return parseBody(req, (err, body) => {
          if (err) return sendJSON(res, 400, { error: 'Invalid JSON in uploaded file' });
          const required = ['income', 'expenses', 'savings', 'goals', 'inventory', 'sales', 'customers', 'credits'];
          const looksValid = required.every(k => body && Object.prototype.hasOwnProperty.call(body, k));
          if (!looksValid) return sendJSON(res, 400, { error: 'That file does not look like a MICKYETS backup' });
          saveData(body);
          return sendJSON(res, 200, { ok: true });
        });
      }
      if (segs[2] === 'usb' && req.method === 'POST') {
        let dir = null;
        for (const candidate of USB_BACKUP_DIRS) {
          try {
            fs.mkdirSync(candidate, { recursive: true });
            fs.accessSync(candidate, fs.constants.W_OK);
            dir = candidate;
            break;
          } catch (e) { /* try next candidate */ }
        }
        if (!dir) {
          return sendJSON(res, 500, { error: 'Could not reach shared storage. Run "termux-setup-storage" in Termux once, allow the permission, then try again.' });
        }
        const filename = 'mickyets-backup-' + today() + '-' + Date.now() + '.json';
        const filePath = path.join(dir, filename);
        fs.writeFileSync(filePath, fs.readFileSync(DATA_FILE, 'utf-8'));
        return sendJSON(res, 200, { ok: true, path: filePath });
      }
      if (segs[2] === 'usb' && segs[3] === 'restore' && req.method === 'POST') {
        return parseBody(req, (err, body) => {
          if (err || !body.filename) return sendJSON(res, 400, { error: 'filename is required' });
          let found = null;
          for (const dir of USB_BACKUP_DIRS) {
            const p = path.join(dir, body.filename);
            if (fs.existsSync(p)) { found = p; break; }
          }
          if (!found) return sendJSON(res, 404, { error: 'Backup file not found in the MICKYETS-Backups folder' });
          try {
            const parsed = JSON.parse(fs.readFileSync(found, 'utf-8'));
            saveData(parsed);
            return sendJSON(res, 200, { ok: true });
          } catch (e) {
            return sendJSON(res, 400, { error: 'That backup file is not valid JSON' });
          }
        });
      }
      if (segs[2] === 'usb' && segs[3] === 'list' && req.method === 'GET') {
        let files = [];
        for (const dir of USB_BACKUP_DIRS) {
          if (fs.existsSync(dir)) {
            try {
              files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
              break;
            } catch (e) { /* ignore */ }
          }
        }
        return sendJSON(res, 200, { files });
      }
    }

    // ---- google drive backup ----
    if (segs[1] === 'gdrive') {
      if (segs[2] === 'status' && req.method === 'GET') {
        return sendJSON(res, 200, gdrive.status());
      }
      if (segs[2] === 'config' && req.method === 'POST') {
        return parseBody(req, (err, body) => {
          if (err || !body.clientId || !body.clientSecret) return sendJSON(res, 400, { error: 'Client ID and Client Secret are both required' });
          gdrive.saveClientCredentials(body.clientId.trim(), body.clientSecret.trim());
          return sendJSON(res, 200, { ok: true });
        });
      }
      if (segs[2] === 'auth' && segs[3] === 'start' && req.method === 'POST') {
        return gdrive.startDeviceAuth()
          .then(r => sendJSON(res, 200, r))
          .catch(e => sendJSON(res, 400, { error: e.message }));
      }
      if (segs[2] === 'auth' && segs[3] === 'poll' && req.method === 'POST') {
        return gdrive.pollDeviceAuth()
          .then(r => sendJSON(res, 200, r))
          .catch(e => sendJSON(res, 400, { error: e.message }));
      }
      if (segs[2] === 'backup' && req.method === 'POST') {
        return gdrive.backupToDrive(fs.readFileSync(DATA_FILE, 'utf-8'))
          .then(r => sendJSON(res, 200, r))
          .catch(e => sendJSON(res, 400, { error: e.message }));
      }
      if (segs[2] === 'restore' && req.method === 'POST') {
        return gdrive.restoreFromDrive()
          .then(content => {
            const parsed = JSON.parse(content);
            saveData(parsed);
            return sendJSON(res, 200, { ok: true });
          })
          .catch(e => sendJSON(res, 400, { error: e.message }));
      }
      if (segs[2] === 'disconnect' && req.method === 'POST') {
        gdrive.disconnect();
        return sendJSON(res, 200, { ok: true });
      }
    }

    // ---- goals ----
    if (segs[1] === 'goals') {
      if (req.method === 'POST' && segs.length === 2) {
        return parseBody(req, (err, body) => {
          if (err || !body.title || !body.target) return sendJSON(res, 400, { error: 'title and target are required' });
          const goal = {
            id: genId(),
            title: body.title,
            target: Number(body.target),
            deadline: body.deadline || null,
            linkedBucket: body.linkedBucket || null,
            achieved: false,
            achievedDate: null
          };
          data.goals.push(goal);
          saveData(data);
          return sendJSON(res, 201, goal);
        });
      }
      if (req.method === 'DELETE' && segs.length === 3) {
        data.goals = data.goals.filter(g => g.id !== segs[2]);
        saveData(data);
        return sendJSON(res, 200, { ok: true });
      }
    }

    return sendJSON(res, 404, { error: 'Not found' });
  }

  serveStatic(req, res, pathname);
}

// The desktop (Electron) build never reaches this block — it requires this
// file as a module and calls handleRequest(fakeReq, fakeRes) directly,
// in-process, with no TCP port involved at all. Only `node server.js` run
// directly (Termux, or `npm start`) gets here and opens a real port, which
// is exactly what a phone browser needs to talk to it.
if (require.main === module) {
  const server = http.createServer(handleRequest);

  const BASE_PORT = parseInt(process.env.PORT || '4173', 10);
  let _currentPort = BASE_PORT;
  const MAX_PORT_TRIES = 10;

  // On EADDRINUSE (port already taken by a leftover process), try the
  // next port automatically instead of hanging silently.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && (_currentPort - BASE_PORT) < MAX_PORT_TRIES) {
      _currentPort++;
      console.warn('Port ' + (_currentPort - 1) + ' in use — trying ' + _currentPort);
      setTimeout(() => server.listen(_currentPort, '127.0.0.1'), 100);
    } else {
      console.error('Server failed to start:', err);
      process.exit(1);
    }
  });

  // Listen on 127.0.0.1 explicitly — on some machines 'localhost' resolves
  // to ::1 (IPv6) while the server defaults to 0.0.0.0 (IPv4), which causes
  // "connection refused" even when the server is running.
  server.on('listening', () => {
    console.log('=======================================');
    console.log('  MICKYETS running on http://127.0.0.1:' + server.address().port);
    console.log('=======================================');
  });

  server.listen(_currentPort, '127.0.0.1');
}

module.exports = { handleRequest };
