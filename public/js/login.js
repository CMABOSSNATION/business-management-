(() => {
  'use strict';

  async function api(path, opts) {
    const res = await fetch('/api' + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  function show(id) { document.getElementById(id).style.display = 'block'; }
  function hide(id) { document.getElementById(id).style.display = 'none'; }

  function showError(id, msg) {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.style.display = 'block';
  }

  (async () => {
    let status;
    try { status = await api('/auth/status'); } catch (e) { status = { hasAccount: false, loggedIn: false }; }

    if (status.loggedIn) { window.location.href = '/'; return; }

    if (status.hasAccount) {
      show('loginView');
    } else {
      show('setupView');
    }
  })();

  document.getElementById('setupForm').addEventListener('submit', async e => {
    e.preventDefault();
    hide('setupError');
    const fd = new FormData(e.target);
    const username = fd.get('username').trim();
    const password = fd.get('password');
    const confirm = fd.get('confirm');
    if (password !== confirm) return showError('setupError', 'Passwords do not match');
    try {
      await api('/auth/setup', { method: 'POST', body: JSON.stringify({ username, password }) });
      window.location.href = '/';
    } catch (err) { showError('setupError', err.message); }
  });

  document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    hide('loginError');
    const fd = new FormData(e.target);
    try {
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }) });
      window.location.href = '/';
    } catch (err) { showError('loginError', err.message); }
  });
})();
