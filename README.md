# MICKYETS Business Tracker

Business management dashboard for Clean Money Avenue — income, expenses,
inventory, daily sales, customer credit (accounts receivable), three
savings buckets, financial goals, reports, backups (phone storage / USB
+ Google Drive), a login screen, and a desktop app built automatically
by GitHub Actions. Pure Node.js backend (zero npm runtime dependencies)
+ a static HTML/CSS/JS frontend with hand-built SVG charts (no Chart.js,
no CDN) — everything renders even with zero or patchy connectivity.

The same `server.js` runs two ways:
- **On your phone (Termux)**: `node server.js`, open in the phone's browser.
- **As a Windows/Mac/Linux desktop app**: Electron wraps that same server
  in a native window — no code differs between the two, and GitHub
  Actions builds the installers for you (see below), so you never need
  a PC yourself to produce them.

## Signing in

The first time the app opens (Termux or desktop), it shows an account
setup screen instead of the dashboard — pick a username and password.
Every time after that, it's a normal login screen. Passwords are hashed
with `scrypt` (Node's built-in, industry-standard slow hash — never
stored in plain text), and sessions last 30 days before you're asked to
log in again. Change your password any time from **Settings → Account**.

Note: the Termux copy and a desktop install each keep their own
`auth.json`/`data.json` — they're separate instances of the app, not
synced to each other automatically. Use the Google Drive or phone-storage
backup to move data between them if you end up running both.

## Run it in Termux

No native modules, no `npm install` needed — the server only uses Node's
built-in `http`, `fs`, `path`, `url`, `crypto`, and `https` modules.

```bash
pkg install nodejs        # if you don't have it yet
cd mickyets-business-tracker
node server.js
```

Then open `http://localhost:3000` in Chrome/Firefox on the same phone.
Data is stored in `data.json` next to `server.js`.

To run on a phone-friendly port or let other devices on the same Wi-Fi
reach it:

```bash
PORT=8080 node server.js
```

## Building the desktop app (GitHub Actions — no PC needed)

This repo includes `.github/workflows/build.yml`, which builds Windows
(`.exe`), macOS (`.dmg`), and Linux (`.AppImage`) installers automatically
whenever you push a version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

That triggers three parallel builds (one per OS) on GitHub's own
machines — nothing runs on your phone or any PC of yours. A few minutes
later, go to the repo's **Releases** page and the installers are
attached there, ready to download on whatever Windows/Mac/Linux machine
you want to install on.

You can also trigger a build any time without tagging a release: go to
the repo's **Actions** tab → **Build Desktop App** → **Run workflow**.
That uploads the installers as build artifacts on that run's page
instead of creating a Release.

### How the desktop build actually works (no network involved)

The Windows/Mac/Linux app does **not** open an HTTP port. Early attempts
did, and on some Windows machines that failed — antivirus/firewall
software intercepted the loopback traffic between the app window and its
own embedded server, causing "the app's internal server did not respond"
errors that no amount of retry logic could fix reliably.

Instead, the desktop build registers a custom `app://` protocol and loads
the UI straight from disk. Every `/api/...` call the frontend makes gets
answered by calling `server.js`'s route logic **directly, in-process** —
the exact same business logic Termux's real HTTP server uses, just
invoked as a plain function call instead of over a socket. There is no
port, so there is nothing for security software to see or block.

Sessions use a token sent as an `X-Session-Token` header (stored in
`localStorage`) instead of relying on cookies, since cookie behavior
under custom protocols is inconsistent across Chromium versions — this
also works fine over plain HTTP, so Termux/browser use the same
mechanism (a cookie is set too, as a harmless fallback, but nothing
depends on it working).

None of this affects Termux: `node server.js` still opens a real port,
because that's the only way a phone browser can reach it.

### Running the desktop app locally instead (if you ever do get a PC)

```bash
npm install
npm run electron      # launch it in dev mode
npm run dist           # build an installer for whatever OS you're on
```

## Project structure

```
mickyets-business-tracker/
  server.js          <- HTTP server + REST API + data.json storage
  auth.js             <- login/account: scrypt password hashing, session cookies
  gdrive.js           <- Google Drive OAuth device-flow + backup/restore (pure https, no npm package)
  electron/main.js    <- desktop wrapper: launches server.js, opens a window on it
  .github/workflows/build.yml  <- builds Win/Mac/Linux installers via GitHub Actions
  package.json
  public/
    index.html         <- dashboard, income, expenses, inventory, sales, credit, savings, goals, reports, settings views
    login.html          <- account setup / sign-in page
    css/style.css        <- dark theme matching the reference screenshot
    js/app.js             <- fetches API, renders hand-built SVG charts, handles all forms
    js/login.js            <- login page logic
```

## API (used by the frontend, but callable from anywhere)

- `GET /api/data` — full dataset (income, expenses, inventory, sales, savings, goals)
- `POST /api/income` `{source, amount, date, note}`
- `DELETE /api/income/:id`
- `POST /api/expenses` `{category, amount, date, note}`
- `DELETE /api/expenses/:id`
- `POST /api/inventory` `{name, quantity, unitCost, sellingPrice, reorderLevel}`
- `PUT /api/inventory/:id` `{restock}` (adds to quantity) or `{setQuantity, name, unitCost, sellingPrice, reorderLevel}` (edits fields directly)
- `DELETE /api/inventory/:id`
- `POST /api/sales` `{itemId?, itemName?, quantity, amount, date, note}` — if `itemId` is given, that inventory item's quantity is decremented automatically
- `DELETE /api/sales/:id`
- `POST /api/customers` `{name, phone, notes}`
- `DELETE /api/customers/:id`
- `POST /api/credits` `{customerId?, customerName?, source, description, amount, date, dueDate}` — records money a customer owes you (accounts receivable)
- `POST /api/credits/:id/pay` — marks a credit record paid and automatically logs it as an income entry
- `DELETE /api/credits/:id`
- `GET /api/backup/export` — downloads the current data as a `.json` file (browser download → phone's Downloads folder, USB-accessible)
- `POST /api/backup/restore` — body is a full backup JSON object; overwrites current data after a basic shape check
- `POST /api/backup/usb` — writes a timestamped copy into a `MICKYETS-Backups` folder on shared storage (USB-visible)
- `GET /api/backup/usb/list` — lists available phone-storage backups
- `POST /api/backup/usb/restore` `{filename}` — restores from a phone-storage backup by filename
- `GET /api/gdrive/status` — `{configured, connected, lastBackup, fileId}`
- `POST /api/gdrive/config` `{clientId, clientSecret}` — saves your Google OAuth app credentials
- `POST /api/gdrive/auth/start` — begins the device-flow login, returns a code + URL to show the user
- `POST /api/gdrive/auth/poll` — call after the user approves; returns `connected` / `pending` / `expired` / `denied`
- `POST /api/gdrive/backup` — uploads/updates the backup file on the connected Google Drive
- `POST /api/gdrive/restore` — downloads and restores the backup file from Google Drive
- `POST /api/gdrive/disconnect` — forgets the stored refresh token
- `POST /api/savings/:bucket/deposit` `{amount, note}` — bucket = business|home|emergency
- `POST /api/savings/:bucket/withdraw` `{amount, note}`
- `PUT /api/savings/:bucket/target` `{target}`
- `POST /api/goals` `{title, target, deadline, linkedBucket}`
- `DELETE /api/goals/:id`
- `GET /api/reports/summary` — monthly totals, best/worst month, savings growth

Income sources (Stationary, WiFi), the 9 expense categories (Home,
Breakfast, Lunch, Supper, Transport, Debt, Airtime, Other, Home Rent) and
the 3 savings buckets (Business, Home, Emergency) are set as constants at
the top of `server.js` — edit that list if your categories change.

Auth endpoints (the only ones that work without being logged in already):
- `GET /api/auth/status` — `{hasAccount, loggedIn, username}`
- `POST /api/auth/setup` `{username, password}` — one-time, only works before an account exists
- `POST /api/auth/login` `{username, password}`
- `POST /api/auth/logout`
- `POST /api/auth/change-password` `{oldPassword, newPassword}` — requires being logged in

## Notes

- All amounts are shown in UGX with thousands separators; change the
  `fmt()` function in `public/js/app.js` if you want a different currency
  label or format.
- Charts are hand-built SVG (see the "SVG CHART ENGINE" section near the
  top of `public/js/app.js`) — no Chart.js, no CDN script tag, nothing to
  fetch over the network. The dashboard loads and renders fully even with
  zero internet, which matters on a Termux server accessed over spotty
  mobile data.
- Backups are opt-in and manual — the app never auto-syncs anywhere on
  its own. See "Setting up backups" below for USB/phone-storage and
  Google Drive.
- Auth data (`auth.json`), Google credentials (`gdrive-config.json`),
  and business data (`data.json`) are all plain local files next to
  `server.js` — none of them are committed to git (see `.gitignore`).

## Setting up backups

### Phone storage / USB (Settings tab)

The first time only, allow Termux to see your phone's shared storage:

```bash
termux-setup-storage
```

Android will show a permission prompt — allow it. After that, the
**Settings → Backup to Phone Storage** button in the app writes a
timestamped copy into a `MICKYETS-Backups` folder on shared storage — the
same storage area a PC sees when the phone is plugged in over USB, or
that any file manager app can browse to. "Download Backup File" does
the same thing but through the browser's normal download, landing in
your phone's Downloads folder instead.

Restoring: either pick a file with "Restore from Selected File", or
pick one of the phone-storage backups from the dropdown and use
"Restore from Phone Storage". Both overwrite all current data — the
app asks for confirmation first.

### Google Drive (Settings tab)

This needs a one-time setup step on Google's side that only you can do
(it ties the connection to your own Google account, not a shared one):

1. Go to [console.cloud.google.com](https://console.cloud.google.com/)
   and create a project (or use an existing one) — it's free.
2. In the left menu: **APIs & Services → Credentials**.
3. **Create Credentials → OAuth client ID**.
   - If asked, configure the consent screen first: choose **External**,
     fill in an app name and your email, and you can leave it in
     "Testing" status — you don't need to publish it.
   - Application type: **TV and Limited Input devices**.
4. Copy the **Client ID** and **Client Secret** it gives you.
5. In the app: **Settings → Google Drive Backup**, paste both in, Save.
6. Tap **Connect to Google Drive** — it shows a short code and a link.
   Open the link on any device (phone, PC, doesn't matter), sign in,
   and type in the code.
7. Back in the app, tap **"I've approved it — check now"**. Once it
   says Connected, use **Backup Now** / **Restore from Google Drive**
   whenever you want.

The app only ever touches one file it creates itself on your Drive
(`mickyets-business-tracker-backup.json`) — the OAuth scope used
(`drive.file`) means it can't see or touch anything else in your
Google Drive.

Your Client ID/Secret and refresh token are stored locally in
`gdrive-config.json` next to `server.js` — same local-only philosophy
as everything else here, just now also holding your Google credentials
so the app can talk to Drive directly without any third-party server
in between.
