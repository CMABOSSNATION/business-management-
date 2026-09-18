(() => {
  'use strict';

  const CATEGORY_COLORS = {
    'Home': '#16a394',
    'Breakfast': '#f2a93b',
    'Lunch': '#3b82f6',
    'Supper': '#8b6bf2',
    'Transport': '#e2574c',
    'Debt': '#c2453c',
    'Airtime': '#35d07f',
    'Other': '#5f6578',
    'Home Rent': '#e2b93b'
  };
  const SOURCE_COLORS = { 'Stationary': '#3b82f6', 'WiFi': '#16a394' };
  const BUCKET_COLORS = { business: '#16a394', home: '#3b82f6', emergency: '#f2a93b' };

  let STATE = { income: [], expenses: [], savings: {}, goals: [], inventory: [], sales: [], customers: [], credits: [], meta: {} };

  // Session token: sent as a header on every API call. This is what makes
  // login work identically whether the page is served over real HTTP
  // (Termux/browser, where a cookie would also work) or from Electron's
  // custom app:// protocol (where cookie-jar behavior can't be relied on).
  const TOKEN_KEY = 'mickyets_session_token';
  const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
  const setToken = t => { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* ignore */ } };
  const clearToken = () => { try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } };

  const fmt = n => 'UGX ' + Number(n || 0).toLocaleString('en-UG', { maximumFractionDigits: 0 });
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const monthKey = d => (d || todayStr()).slice(0, 7);
  const thisMonth = () => todayStr().slice(0, 7);

  function toast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  async function api(path, opts) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
    const token = getToken();
    if (token) headers['X-Session-Token'] = token;
    const res = await fetch('/api' + path, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
      clearToken();
      window.location.href = 'login.html';
      throw new Error('Not authenticated');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || 'Request failed');
    }
    const body = await res.json();
    if (body && body.token) setToken(body.token);
    return body;
  }

  async function loadAll() {
    STATE = await api('/data');
    renderAll();
  }

  function renderAll() {
    fillSelects();
    renderDashboard();
    renderIncomePage();
    renderExpensePage();
    renderInventoryPage();
    renderSalesPage();
    renderCreditPage();
    renderSavingsPage();
    renderGoalsPage();
    renderReportsPage();
  }

  function fillSelects() {
    const sources = STATE.meta.incomeSources || ['Stationary', 'WiFi'];
    const cats = STATE.meta.expenseCategories || Object.keys(CATEGORY_COLORS);
    ['qaIncomeSource', 'incomeSourceSelect'].forEach(id => {
      const e = document.getElementById(id);
      if (e && !e.dataset.filled) {
        e.innerHTML = sources.map(s => `<option value="${s}">${s}</option>`).join('');
        e.dataset.filled = '1';
      }
    });
    ['qaExpenseCategory', 'expenseCategorySelect'].forEach(id => {
      const e = document.getElementById(id);
      if (e && !e.dataset.filled) {
        e.innerHTML = cats.map(c => `<option value="${c}">${c}</option>`).join('');
        e.dataset.filled = '1';
      }
    });
    const creditSourceSelect = document.getElementById('creditSourceSelect');
    if (creditSourceSelect && !creditSourceSelect.dataset.filled) {
      creditSourceSelect.innerHTML = sources.map(s => `<option value="${s}">${s}</option>`).join('');
      creditSourceSelect.dataset.filled = '1';
    }
    const creditCustomerSelect = document.getElementById('creditCustomerSelect');
    if (creditCustomerSelect) {
      const current = creditCustomerSelect.value;
      creditCustomerSelect.innerHTML = '<option value="">— walk-in / not saved —</option>' +
        STATE.customers.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
      if ([...creditCustomerSelect.options].some(o => o.value === current)) creditCustomerSelect.value = current;
    }
    const salesSelect = document.getElementById('salesItemSelect');
    if (salesSelect) {
      const current = salesSelect.value;
      salesSelect.innerHTML = '<option value="">— not from inventory —</option>' +
        STATE.inventory.map(i => `<option value="${i.id}">${escapeHtml(i.name)} (${i.quantity} in stock)</option>`).join('');
      if ([...salesSelect.options].some(o => o.value === current)) salesSelect.value = current;
    }
  }

  function sumBy(list, keyFn) {
    const out = {};
    list.forEach(item => {
      const k = keyFn(item);
      out[k] = (out[k] || 0) + Number(item.amount || 0);
    });
    return out;
  }

  function totalMonth(list, m) {
    return list.filter(x => monthKey(x.date) === m).reduce((s, x) => s + Number(x.amount || 0), 0);
  }

  function totalDay(list, d) {
    return list.filter(x => x.date === d).reduce((s, x) => s + Number(x.amount || 0), 0);
  }

  function last6Months() {
    const arr = [];
    const d = new Date();
    for (let i = 5; i >= 0; i--) {
      const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
      arr.push(dt.toISOString().slice(0, 7));
    }
    return arr;
  }

  function monthLabel(mk) {
    const [y, m] = mk.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-GB', { month: 'short' });
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ================= SVG CHART ENGINE (no external libraries) =================
  function el(id) { return document.getElementById(id); }

  function drawLineChart(id, labels, series) {
    const host = el(id);
    if (!host) return;
    const W = 600, H = 220, padL = 4, padR = 4, padT = 14, padB = 4;
    const n = Math.max(labels.length, 1);
    const maxVal = Math.max(1, ...series.flatMap(s => s.data));
    const xStep = n > 1 ? (W - padL - padR) / (n - 1) : 0;
    const xScale = i => padL + i * xStep;
    const yScale = v => H - padB - (v / maxVal) * (H - padT - padB);

    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">`;
    for (let g = 0; g <= 3; g++) {
      const y = padT + (g / 3) * (H - padT - padB);
      svg += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
    }
    series.forEach(s => {
      const pts = s.data.map((v, i) => `${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ');
      const areaPts = `${xScale(0).toFixed(1)},${yScale(0).toFixed(1)} ${pts} ${xScale(n - 1).toFixed(1)},${yScale(0).toFixed(1)}`;
      svg += `<polygon points="${areaPts}" fill="${s.color}" opacity="0.16"/>`;
      svg += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    });
    svg += `</svg>`;
    host.innerHTML = svg;

    const legend = series.map(s => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;">
      <span style="width:8px;height:8px;border-radius:50%;background:${s.color};display:inline-block;"></span>
      <span style="color:var(--muted);font-size:11px;">${s.label}</span></span>`).join('');
    const xLabels = `<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted-2);margin-top:4px;">${labels.map(l => `<span>${l}</span>`).join('')}</div>`;
    host.insertAdjacentHTML('beforeend', `<div style="margin-top:6px;">${legend}</div>${xLabels}`);
  }

  function drawBarChart(id, labels, series, opts) {
    const host = el(id);
    if (!host) return;
    const stacked = !!(opts && opts.stacked);
    const W = 600, H = 220, padL = 4, padR = 4, padT = 10, padB = 4;
    const n = Math.max(labels.length, 1);
    const groupW = (W - padL - padR) / n;
    let maxVal;
    if (stacked) {
      maxVal = Math.max(1, ...labels.map((_, i) => series.reduce((s, ser) => s + (ser.data[i] || 0), 0)));
    } else {
      maxVal = Math.max(1, ...series.flatMap(s => s.data));
    }
    const usableH = H - padT - padB;
    const yScale = v => (v / maxVal) * usableH;

    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">`;
    for (let g = 0; g <= 3; g++) {
      const y = padT + (g / 3) * usableH;
      svg += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
    }
    labels.forEach((lb, i) => {
      const gx = padL + i * groupW;
      if (stacked) {
        let yCursor = H - padB;
        series.forEach(s => {
          const v = s.data[i] || 0;
          if (v <= 0) return;
          const h = yScale(v);
          const barW = groupW * 0.55;
          const bx = gx + (groupW - barW) / 2;
          svg += `<rect x="${bx.toFixed(1)}" y="${(yCursor - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}" rx="2"/>`;
          yCursor -= h;
        });
      } else {
        const barW = (groupW * 0.62) / series.length;
        series.forEach((s, si) => {
          const v = s.data[i] || 0;
          const h = yScale(v);
          const bx = gx + (groupW - barW * series.length) / 2 + si * barW;
          svg += `<rect x="${bx.toFixed(1)}" y="${(H - padB - h).toFixed(1)}" width="${Math.max(1, barW - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}" rx="2"/>`;
        });
      }
    });
    svg += `</svg>`;
    host.innerHTML = svg;

    const xLabels = `<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted-2);margin-top:4px;">${labels.map(l => `<span>${l}</span>`).join('')}</div>`;
    host.insertAdjacentHTML('beforeend', xLabels);
  }

  function drawDonut(id, segments, opts) {
    const host = el(id);
    if (!host) return;
    const size = (opts && opts.size) || 120;
    const thickness = (opts && opts.thickness) || 13;
    const r = size / 2 - thickness / 2 - 2;
    const cx = size / 2, cy = size / 2;
    const circumference = 2 * Math.PI * r;
    const total = segments.reduce((s, x) => s + x.value, 0);

    let svg = `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="${thickness}"/>`;
    if (total > 0) {
      let offset = 0;
      segments.forEach(seg => {
        if (seg.value <= 0) return;
        const frac = seg.value / total;
        const len = frac * circumference;
        svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${thickness}" stroke-dasharray="${len.toFixed(1)} ${(circumference - len).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}" transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"/>`;
        offset += len;
      });
    }
    svg += `</svg>`;
    host.innerHTML = svg;
  }

  // ================= DASHBOARD =================
  function renderDashboard() {
    const m = thisMonth();
    const today = todayStr();
    const incomeMonth = totalMonth(STATE.income, m);
    const expenseMonth = totalMonth(STATE.expenses, m);
    const balance = incomeMonth - expenseMonth;

    el('statIncome').textContent = fmt(incomeMonth);
    el('statExpense').textContent = fmt(expenseMonth);
    el('statBalance').textContent = fmt(balance);

    const months = last6Months();
    const curM = months[5], prevM = months[4];
    let curDep = 0, prevDep = 0;
    Object.values(STATE.savings).forEach(b => {
      (b.history || []).forEach(h => {
        if (h.type !== 'deposit') return;
        const mk = monthKey(h.date);
        if (mk === curM) curDep += Number(h.amount);
        if (mk === prevM) prevDep += Number(h.amount);
      });
    });
    const growth = prevDep > 0 ? Math.round(((curDep - prevDep) / prevDep) * 100) : (curDep > 0 ? 100 : 0);
    el('statGrowth').textContent = (growth >= 0 ? '+' : '') + growth + '%';

    const todaySales = totalDay(STATE.sales, today);
    const todayIncome = totalDay(STATE.income, today);
    const moneyInToday = todaySales + todayIncome;
    el('statTodaySales').textContent = fmt(todaySales);
    const outstanding = STATE.credits.filter(c => !c.paid).reduce((s, c) => s + Number(c.amount), 0);
    el('statOutstandingCredit').textContent = fmt(outstanding);
    const ind = el('moneyInIndicator');
    const txt = el('moneyInText');
    const sub = el('moneyInSub');
    if (moneyInToday > 0) {
      ind.className = 'money-indicator yes';
      txt.textContent = 'Money is coming in today';
      sub.textContent = fmt(todaySales) + ' in sales, ' + fmt(todayIncome) + ' in other income';
    } else {
      ind.className = 'money-indicator no';
      txt.textContent = 'No sales or income logged today';
      sub.textContent = 'Log a sale or income entry to update this';
    }

    const incByM = months.map(mk => totalMonth(STATE.income, mk));
    const expByM = months.map(mk => totalMonth(STATE.expenses, mk));
    drawLineChart('trendChart', months.map(monthLabel), [
      { label: 'Income', color: '#16a394', data: incByM },
      { label: 'Expenditure', color: '#e2574c', data: expByM }
    ]);

    ['business', 'home', 'emergency'].forEach(b => {
      const bucket = STATE.savings[b] || { balance: 0, target: 0 };
      const pct = bucket.target > 0 ? Math.min(100, Math.round((bucket.balance / bucket.target) * 100)) : 0;
      drawDonut('ring' + capitalize(b), [{ value: pct, color: BUCKET_COLORS[b] }, { value: 100 - pct, color: 'transparent' }], { size: 84, thickness: 10 });
      el('bTarget' + capitalize(b)).textContent = fmt(bucket.balance) + ' / ' + fmt(bucket.target);
      el('bBar' + capitalize(b)).style.width = pct + '%';
    });

    const bySource = sumBy(STATE.income, i => i.source);
    renderPie('incomeStreamsChart', 'incomeStreamsLegend', bySource, SOURCE_COLORS);

    const byCat = sumBy(STATE.expenses, e => e.category);
    renderPie('expenseCategoryChart', 'expenseCategoryLegend', byCat, CATEGORY_COLORS);

    renderWeeklySpend();
    renderGoalsMini('qaGoalsList');
  }

  function renderPie(chartId, legendId, dataObj, colorMap) {
    const labels = Object.keys(dataObj);
    const values = Object.values(dataObj);
    const total = values.reduce((a, b) => a + b, 0) || 1;
    if (!labels.length) {
      const host = el(chartId);
      if (host) host.innerHTML = '';
      if (legendId) el(legendId).innerHTML = '<div class="empty-state" style="padding:10px 0;">No data yet</div>';
      return;
    }
    const colors = labels.map(l => colorMap[l] || '#5f6578');
    drawDonut(chartId, labels.map((l, i) => ({ value: values[i], color: colors[i] })), { size: 140, thickness: 20 });
    if (legendId) {
      el(legendId).innerHTML = labels.map((l, i) => {
        const pct = Math.round((values[i] / total) * 100);
        return `<div class="li"><span class="sw" style="background:${colors[i]}"></span>${l}<span class="pct">${pct}%</span></div>`;
      }).join('');
    }
  }

  function renderWeeklySpend() {
    const days = [];
    const d = new Date();
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(d);
      dt.setDate(d.getDate() - i);
      days.push(dt.toISOString().slice(0, 10));
    }
    const cats = STATE.meta.expenseCategories || Object.keys(CATEGORY_COLORS);
    const datasets = cats.map(c => ({
      color: CATEGORY_COLORS[c] || '#5f6578',
      data: days.map(day => STATE.expenses.filter(e => e.date === day && e.category === c).reduce((s, e) => s + Number(e.amount), 0))
    }));
    drawBarChart('weeklySpendChart', days.map(d2 => new Date(d2 + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' })), datasets, { stacked: true });
  }

  function renderGoalsMini(containerId) {
    const c = document.getElementById(containerId);
    if (!STATE.goals.length) { c.innerHTML = '<div class="empty-state">No goals yet</div>'; return; }
    c.innerHTML = STATE.goals.map(g => {
      const bal = g.linkedBucket && STATE.savings[g.linkedBucket] ? STATE.savings[g.linkedBucket].balance : 0;
      const pct = g.target > 0 ? Math.min(100, Math.round((bal / g.target) * 100)) : 0;
      return `<div class="goal-item">
        <span class="goal-dot ${g.achieved ? 'done' : 'pending'}"></span>
        <div class="gi-main">
          <div class="gi-title">${escapeHtml(g.title)}</div>
          <div class="gi-sub">Deadline: ${g.deadline || '—'}</div>
        </div>
        <div class="gi-pct">${pct}%</div>
      </div>`;
    }).join('');
  }

  // ================= INCOME PAGE =================
  function renderIncomePage() {
    const all = STATE.income.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    const totalAll = all.reduce((s, x) => s + Number(x.amount), 0);
    el('incTotalAll').textContent = fmt(totalAll);
    el('incTotalMonth').textContent = fmt(totalMonth(STATE.income, thisMonth()));
    el('incCount').textContent = all.length;

    const tbody = el('incomeTableBody');
    tbody.innerHTML = all.length ? all.map(i => `
      <tr>
        <td>${i.date}</td>
        <td>${escapeHtml(i.source)}</td>
        <td style="color:var(--muted)">${escapeHtml(i.note || '')}</td>
        <td style="text-align:right;color:var(--teal);font-weight:600;">${fmt(i.amount)}</td>
        <td><div class="row-actions"><span class="icon-link" data-del-income="${i.id}">✕</span></div></td>
      </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state">No income logged yet</div></td></tr>`;

    const bySource = sumBy(STATE.income, i => i.source);
    renderPie('incomeBySourceChart', null, bySource, SOURCE_COLORS);
  }

  // ================= EXPENSE PAGE =================
  function renderExpensePage() {
    const all = STATE.expenses.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    const totalAll = all.reduce((s, x) => s + Number(x.amount), 0);
    el('expTotalAll').textContent = fmt(totalAll);
    el('expTotalMonth').textContent = fmt(totalMonth(STATE.expenses, thisMonth()));

    const byCat = sumBy(STATE.expenses, e => e.category);
    const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
    el('expTopCat').textContent = topCat ? topCat[0] : '—';

    const tbody = el('expenseTableBody');
    tbody.innerHTML = all.length ? all.map(e => `
      <tr>
        <td>${e.date}</td>
        <td><span class="tag" style="background:${(CATEGORY_COLORS[e.category] || '#5f6578')}22;color:${CATEGORY_COLORS[e.category] || '#5f6578'}">${escapeHtml(e.category)}</span></td>
        <td style="color:var(--muted)">${escapeHtml(e.note || '')}</td>
        <td style="text-align:right;color:var(--red);font-weight:600;">${fmt(e.amount)}</td>
        <td><div class="row-actions"><span class="icon-link" data-del-expense="${e.id}">✕</span></div></td>
      </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state">No expenses logged yet</div></td></tr>`;

    renderPie('expenseByCatChart', null, byCat, CATEGORY_COLORS);
  }

  // ================= INVENTORY PAGE =================
  function renderInventoryPage() {
    const items = STATE.inventory.slice().sort((a, b) => a.name.localeCompare(b.name));
    el('invCount').textContent = items.length;
    const stockValue = items.reduce((s, i) => s + i.quantity * i.unitCost, 0);
    el('invValue').textContent = fmt(stockValue);
    const lowCount = items.filter(i => i.quantity <= i.reorderLevel).length;
    el('invLowCount').textContent = lowCount;

    const tbody = el('inventoryTableBody');
    tbody.innerHTML = items.length ? items.map(i => {
      const low = i.quantity <= i.reorderLevel;
      return `<tr>
        <td>${escapeHtml(i.name)}</td>
        <td>${i.quantity}</td>
        <td>${fmt(i.unitCost)}</td>
        <td>${fmt(i.sellingPrice)}</td>
        <td><span class="stock-tag ${low ? 'low' : 'ok'}">${low ? 'Low stock' : 'OK'}</span></td>
        <td>
          <div class="row-actions" style="align-items:center;">
            <input type="number" placeholder="+qty" class="restock-input" data-id="${i.id}" style="width:56px;background:var(--panel-alt);border:1px solid var(--border);border-radius:6px;padding:4px 6px;color:var(--text);" />
            <span class="icon-link" data-restock="${i.id}" title="Restock">↑</span>
            <span class="icon-link" data-del-inventory="${i.id}">✕</span>
          </div>
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="6"><div class="empty-state">No inventory items yet</div></td></tr>`;
  }

  // ================= SALES PAGE =================
  function renderSalesPage() {
    const all = STATE.sales.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    el('salesTodayTotal').textContent = fmt(totalDay(STATE.sales, todayStr()));
    el('salesMonthTotal').textContent = fmt(totalMonth(STATE.sales, thisMonth()));
    el('salesCount').textContent = all.length;

    const tbody = el('salesTableBody');
    tbody.innerHTML = all.length ? all.map(s => `
      <tr>
        <td>${s.date}</td>
        <td>${escapeHtml(s.itemName || '—')}</td>
        <td>${s.quantity}</td>
        <td style="text-align:right;color:var(--teal);font-weight:600;">${fmt(s.amount)}</td>
        <td><div class="row-actions"><span class="icon-link" data-del-sale="${s.id}">✕</span></div></td>
      </tr>`).join('') : `<tr><td colspan="5"><div class="empty-state">No sales logged yet</div></td></tr>`;
  }

  // ================= CREDIT PAGE (accounts receivable) =================
  function renderCreditPage() {
    const credits = STATE.credits.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    const today = todayStr();
    const outstanding = credits.filter(c => !c.paid).reduce((s, c) => s + Number(c.amount), 0);
    const overdue = credits.filter(c => !c.paid && c.dueDate && c.dueDate < today).length;

    el('creditOutstanding').textContent = fmt(outstanding);
    el('customerCount').textContent = STATE.customers.length;
    el('creditOverdue').textContent = overdue;

    const tbody = el('creditTableBody');
    tbody.innerHTML = credits.length ? credits.map(c => {
      const isOverdue = !c.paid && c.dueDate && c.dueDate < today;
      let statusHtml;
      if (c.paid) statusHtml = `<span class="stock-tag ok">Paid</span>`;
      else if (isOverdue) statusHtml = `<span class="stock-tag low">Overdue</span>`;
      else statusHtml = `<span class="stock-tag" style="background:var(--blue-soft);color:var(--blue);">Pending</span>`;
      return `<tr>
        <td>${escapeHtml(c.customerName)}</td>
        <td style="color:var(--muted)">${escapeHtml(c.description || '')}</td>
        <td>${c.date}</td>
        <td>${c.dueDate || '—'}</td>
        <td style="text-align:right;font-weight:600;color:${c.paid ? 'var(--muted)' : 'var(--orange)'}">${fmt(c.amount)}</td>
        <td>${statusHtml}</td>
        <td><div class="row-actions">
          ${c.paid ? '' : `<span class="icon-link" data-pay-credit="${c.id}" style="color:var(--teal);" title="Mark as paid">✓</span>`}
          <span class="icon-link" data-del-credit="${c.id}">✕</span>
        </div></td>
      </tr>`;
    }).join('') : `<tr><td colspan="7"><div class="empty-state">No credit given yet — nothing owed to you right now</div></td></tr>`;

    const custBody = el('customerTableBody');
    custBody.innerHTML = STATE.customers.length ? STATE.customers.map(cust => {
      const owed = credits.filter(c => c.customerId === cust.id && !c.paid).reduce((s, c) => s + Number(c.amount), 0);
      return `<tr>
        <td>${escapeHtml(cust.name)}</td>
        <td style="color:var(--muted)">${escapeHtml(cust.phone || '—')}</td>
        <td style="color:${owed > 0 ? 'var(--orange)' : 'var(--muted)'}">${fmt(owed)}</td>
        <td><span class="icon-link" data-del-customer="${cust.id}">✕</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="4"><div class="empty-state">No customers saved yet</div></td></tr>`;
  }

  // ================= SAVINGS PAGE =================
  function renderSavingsPage() {
    document.querySelectorAll('.savings-bucket-panel').forEach(panel => {
      const b = panel.dataset.bucket;
      const bucket = STATE.savings[b] || { balance: 0, target: 0, history: [] };
      const pct = bucket.target > 0 ? Math.min(100, Math.round((bucket.balance / bucket.target) * 100)) : 0;
      panel.querySelector('[data-field="balance"]').textContent = fmt(bucket.balance);
      panel.querySelector('[data-field="target"]').textContent = fmt(bucket.target);
      panel.querySelector('[data-field="bar"]').style.width = pct + '%';
      const hist = (bucket.history || []).slice().reverse().slice(0, 20);
      panel.querySelector('[data-field="history"]').innerHTML = hist.length ? hist.map(h => `
        <div class="goal-item">
          <span class="goal-dot ${h.type === 'deposit' ? 'done' : 'pending'}"></span>
          <div class="gi-main">
            <div class="gi-title">${h.type === 'deposit' ? '+' : '-'}${fmt(h.amount)}</div>
            <div class="gi-sub">${h.date}${h.note ? ' · ' + escapeHtml(h.note) : ''}</div>
          </div>
        </div>`).join('') : '<div class="empty-state" style="padding:14px 0;">No activity yet</div>';
    });
  }

  // ================= GOALS PAGE =================
  function renderGoalsPage() {
    const container = el('goalsFullList');
    if (!STATE.goals.length) { container.innerHTML = '<div class="empty-state">No goals yet — create one to start tracking.</div>'; return; }
    container.innerHTML = STATE.goals.map(g => {
      const bal = g.linkedBucket && STATE.savings[g.linkedBucket] ? STATE.savings[g.linkedBucket].balance : 0;
      const pct = g.target > 0 ? Math.min(100, Math.round((bal / g.target) * 100)) : 0;
      return `<div style="padding:12px 0; border-bottom:1px solid var(--border);">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:600;">${escapeHtml(g.title)} ${g.achieved ? '<span class="tag" style="background:rgba(53,208,127,0.15);color:#35d07f;">Achieved</span>' : ''}</div>
            <div style="font-size:12px;color:var(--muted-2);margin-top:2px;">Target ${fmt(g.target)} · Deadline ${g.deadline || '—'} ${g.linkedBucket ? '· Tracking ' + capitalize(g.linkedBucket) + ' savings' : ''}</div>
          </div>
          <span class="icon-link" data-del-goal="${g.id}">✕</span>
        </div>
        <div class="progress-wide"><div class="fill" style="width:${pct}%; background:${g.achieved ? '#35d07f' : '#3b82f6'}"></div></div>
      </div>`;
    }).join('');
  }

  // ================= REPORTS PAGE =================
  function renderReportsPage() {
    const months = last6Months();
    const incByM = months.map(mk => totalMonth(STATE.income, mk));
    const expByM = months.map(mk => totalMonth(STATE.expenses, mk));

    let bestIdx = 0, worstIdx = 0;
    incByM.forEach((v, i) => { if (v > incByM[bestIdx]) bestIdx = i; });
    expByM.forEach((v, i) => { if (v > expByM[worstIdx]) worstIdx = i; });

    el('repBestIncome').textContent = incByM[bestIdx] > 0 ? monthLabel(months[bestIdx]) + ' (' + fmt(incByM[bestIdx]) + ')' : '—';
    el('repWorstExpense').textContent = expByM[worstIdx] > 0 ? monthLabel(months[worstIdx]) + ' (' + fmt(expByM[worstIdx]) + ')' : '—';

    const totalIncome = STATE.income.reduce((s, x) => s + Number(x.amount), 0);
    const totalExpense = STATE.expenses.reduce((s, x) => s + Number(x.amount), 0);
    el('repNet').textContent = fmt(totalIncome - totalExpense);

    drawBarChart('reportMonthlyChart', months.map(monthLabel), [
      { color: '#16a394', data: incByM },
      { color: '#e2574c', data: expByM }
    ]);

    const body = el('repSavingsBody');
    body.innerHTML = Object.entries(STATE.savings).map(([b, v]) => {
      const pct = v.target > 0 ? Math.min(100, Math.round((v.balance / v.target) * 100)) : 0;
      return `<tr><td>${capitalize(b)}</td><td>${fmt(v.balance)}</td><td>${fmt(v.target)}</td><td>${pct}%</td></tr>`;
    }).join('');
  }

  // ================= NAVIGATION =================
  function switchView(view) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
    document.querySelectorAll('.content').forEach(c => c.classList.toggle('active', c.id === 'view-' + view));
    const titles = { dashboard: 'Dashboard', income: 'Income', expenses: 'Expenses', inventory: 'Inventory', sales: 'Daily Sales', credit: 'Credit', savings: 'Savings', goals: 'Financial Goals', reports: 'Reports', settings: 'Settings' };
    el('pageTitle').textContent = titles[view] || view;
  }

  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      switchView(item.dataset.view);
      document.body.classList.remove('sidebar-open');
    });
  });

  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');
  if (hamburgerBtn) hamburgerBtn.addEventListener('click', () => document.body.classList.add('sidebar-open'));
  if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', () => document.body.classList.remove('sidebar-open'));

  // ================= FORM HANDLERS =================
  function formData(form) {
    const fd = new FormData(form);
    const obj = {};
    fd.forEach((v, k) => obj[k] = v);
    return obj;
  }

  ['qaIncomeForm', 'incomeForm'].forEach(id => {
    const form = document.getElementById(id);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const body = formData(form);
      try {
        await api('/income', { method: 'POST', body: JSON.stringify(body) });
        form.reset();
        toast('Income added');
        await loadAll();
      } catch (err) { toast(err.message, true); }
    });
  });

  ['qaExpenseForm', 'expenseForm'].forEach(id => {
    const form = document.getElementById(id);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const body = formData(form);
      try {
        await api('/expenses', { method: 'POST', body: JSON.stringify(body) });
        form.reset();
        toast('Expense added');
        await loadAll();
      } catch (err) { toast(err.message, true); }
    });
  });

  document.getElementById('goalForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = formData(e.target);
    try {
      await api('/goals', { method: 'POST', body: JSON.stringify(body) });
      e.target.reset();
      toast('Goal created');
      await loadAll();
    } catch (err) { toast(err.message, true); }
  });

  document.getElementById('inventoryForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = formData(e.target);
    try {
      await api('/inventory', { method: 'POST', body: JSON.stringify(body) });
      e.target.reset();
      toast('Item added to inventory');
      await loadAll();
    } catch (err) { toast(err.message, true); }
  });

  document.getElementById('salesForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = formData(e.target);
    if (!body.itemId) delete body.itemId;
    try {
      await api('/sales', { method: 'POST', body: JSON.stringify(body) });
      e.target.reset();
      toast('Sale recorded');
      await loadAll();
    } catch (err) { toast(err.message, true); }
  });

  document.getElementById('customerForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = formData(e.target);
    try {
      await api('/customers', { method: 'POST', body: JSON.stringify(body) });
      e.target.reset();
      toast('Customer added');
      await loadAll();
    } catch (err) { toast(err.message, true); }
  });

  document.getElementById('creditForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = formData(e.target);
    if (!body.customerId) delete body.customerId;
    try {
      await api('/credits', { method: 'POST', body: JSON.stringify(body) });
      e.target.reset();
      toast('Credit recorded');
      await loadAll();
    } catch (err) { toast(err.message, true); }
  });

  document.getElementById('salesItemSelect').addEventListener('change', e => {
    const opt = e.target.options[e.target.selectedIndex];
    const nameInput = document.getElementById('salesItemNameInput');
    if (e.target.value && opt) {
      nameInput.value = opt.textContent.replace(/\s*\(\d+ in stock\)$/, '');
    }
  });

  document.querySelectorAll('.savings-bucket-panel').forEach(panel => {
    const b = panel.dataset.bucket;
    panel.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const amountInput = panel.querySelector('.bucket-amount');
        const noteInput = panel.querySelector('.bucket-note');
        const targetInput = panel.querySelector('.bucket-target-input');
        try {
          if (action === 'deposit' || action === 'withdraw') {
            const amount = Number(amountInput.value);
            if (!amount) return toast('Enter an amount', true);
            await api(`/savings/${b}/${action}`, { method: 'POST', body: JSON.stringify({ amount, note: noteInput.value }) });
            amountInput.value = ''; noteInput.value = '';
            toast(capitalize(action) + ' recorded');
          } else if (action === 'settarget') {
            const target = Number(targetInput.value);
            await api(`/savings/${b}/target`, { method: 'PUT', body: JSON.stringify({ target }) });
            targetInput.value = '';
            toast('Target updated');
          }
          await loadAll();
        } catch (err) { toast(err.message, true); }
      });
    });
  });

  document.addEventListener('click', async e => {
    const delIncome = e.target.dataset.delIncome;
    const delExpense = e.target.dataset.delExpense;
    const delGoal = e.target.dataset.delGoal;
    const delInventory = e.target.dataset.delInventory;
    const delSale = e.target.dataset.delSale;
    const delCustomer = e.target.dataset.delCustomer;
    const delCredit = e.target.dataset.delCredit;
    const payCredit = e.target.dataset.payCredit;
    const restockId = e.target.dataset.restock;
    try {
      if (delIncome) { await api('/income/' + delIncome, { method: 'DELETE' }); toast('Removed'); await loadAll(); }
      if (delExpense) { await api('/expenses/' + delExpense, { method: 'DELETE' }); toast('Removed'); await loadAll(); }
      if (delGoal) { await api('/goals/' + delGoal, { method: 'DELETE' }); toast('Goal removed'); await loadAll(); }
      if (delInventory) { await api('/inventory/' + delInventory, { method: 'DELETE' }); toast('Item removed'); await loadAll(); }
      if (delSale) { await api('/sales/' + delSale, { method: 'DELETE' }); toast('Sale removed'); await loadAll(); }
      if (delCustomer) { await api('/customers/' + delCustomer, { method: 'DELETE' }); toast('Customer removed'); await loadAll(); }
      if (delCredit) { await api('/credits/' + delCredit, { method: 'DELETE' }); toast('Credit record removed'); await loadAll(); }
      if (payCredit) { await api('/credits/' + payCredit + '/pay', { method: 'POST', body: JSON.stringify({}) }); toast('Marked as paid — logged as income'); await loadAll(); }
      if (restockId) {
        const input = document.querySelector(`.restock-input[data-id="${restockId}"]`);
        const qty = Number(input && input.value);
        if (!qty) return toast('Enter a quantity to restock', true);
        await api('/inventory/' + restockId, { method: 'PUT', body: JSON.stringify({ restock: qty }) });
        toast('Stock updated');
        await loadAll();
      }
    } catch (err) { toast(err.message, true); }
  });

  document.getElementById('printReportBtn').addEventListener('click', () => window.print());

  // ================= BACKUP: USB / local file =================
  document.getElementById('downloadBackupBtn').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = '/api/backup/export';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  async function refreshUsbBackupList() {
    try {
      const r = await api('/backup/usb/list');
      const sel = document.getElementById('usbBackupList');
      sel.innerHTML = r.files.length
        ? r.files.map(f => `<option value="${f}">${f}</option>`).join('')
        : '<option value="">— none found —</option>';
    } catch (e) { /* ignore */ }
  }

  document.getElementById('usbBackupBtn').addEventListener('click', async () => {
    const status = document.getElementById('usbBackupStatus');
    status.textContent = 'Saving…';
    try {
      const r = await api('/backup/usb', { method: 'POST' });
      status.textContent = 'Saved to ' + r.path;
      toast('Backup saved to phone storage');
      refreshUsbBackupList();
    } catch (e) {
      status.textContent = '';
      toast(e.message, true);
    }
  });

  document.getElementById('restoreFileBtn').addEventListener('click', async () => {
    const input = document.getElementById('restoreFileInput');
    const file = input.files[0];
    if (!file) return toast('Choose a backup file first', true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await api('/backup/restore', { method: 'POST', body: JSON.stringify(parsed) });
      toast('Data restored from file');
      input.value = '';
      await loadAll();
    } catch (e) { toast(e.message || 'Could not read that file', true); }
  });

  document.getElementById('usbRestoreBtn').addEventListener('click', async () => {
    const filename = document.getElementById('usbBackupList').value;
    if (!filename) return toast('No backup selected', true);
    if (!confirm('This replaces all current data with the selected backup. Continue?')) return;
    try {
      await api('/backup/usb/restore', { method: 'POST', body: JSON.stringify({ filename }) });
      toast('Data restored from phone storage');
      await loadAll();
    } catch (e) { toast(e.message, true); }
  });

  // ================= BACKUP: Google Drive =================
  async function refreshGdriveStatus() {
    let s;
    try { s = await api('/gdrive/status'); } catch (e) { return; }
    document.getElementById('gdriveNotConfigured').style.display = s.configured ? 'none' : 'block';
    document.getElementById('gdriveConfigured').style.display = s.configured ? 'block' : 'none';
    if (s.configured) {
      document.getElementById('gdriveDisconnected').style.display = s.connected ? 'none' : 'block';
      document.getElementById('gdriveConnected').style.display = s.connected ? 'block' : 'none';
      if (s.connected) {
        document.getElementById('gdriveLastBackup').textContent = s.lastBackup
          ? 'Last backup: ' + new Date(s.lastBackup).toLocaleString()
          : 'No backup yet';
      }
    }
  }

  document.getElementById('gdriveConfigForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = formData(e.target);
    try {
      await api('/gdrive/config', { method: 'POST', body: JSON.stringify(body) });
      toast('Google credentials saved');
      await refreshGdriveStatus();
    } catch (err) { toast(err.message, true); }
  });

  let gdrivePollTimer = null;

  document.getElementById('gdriveConnectBtn').addEventListener('click', async () => {
    try {
      const r = await api('/gdrive/auth/start', { method: 'POST' });
      document.getElementById('gdriveAuthBox').style.display = 'block';
      document.getElementById('gdriveAuthLink').href = r.verificationUrl;
      document.getElementById('gdriveAuthLink').textContent = r.verificationUrl;
      document.getElementById('gdriveUserCode').textContent = r.userCode;
      document.getElementById('gdriveAuthStatus').textContent = 'Waiting for you to approve on Google\'s page…';
    } catch (err) { toast(err.message, true); }
  });

  document.getElementById('gdriveCheckBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('gdriveAuthStatus');
    statusEl.textContent = 'Checking…';
    try {
      const r = await api('/gdrive/auth/poll', { method: 'POST' });
      if (r.status === 'connected') {
        statusEl.textContent = 'Connected!';
        toast('Connected to Google Drive');
        await refreshGdriveStatus();
      } else if (r.status === 'pending') {
        statusEl.textContent = 'Not approved yet — open the link, enter the code, then tap this again.';
      } else if (r.status === 'expired') {
        statusEl.textContent = 'That code expired — tap "Connect to Google Drive" to get a new one.';
      } else if (r.status === 'denied') {
        statusEl.textContent = 'Access was denied on Google\'s side.';
      }
    } catch (err) { statusEl.textContent = err.message; }
  });

  document.getElementById('gdriveBackupBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('gdriveActionStatus');
    statusEl.textContent = 'Backing up…';
    try {
      await api('/gdrive/backup', { method: 'POST' });
      statusEl.textContent = '';
      toast('Backed up to Google Drive');
      await refreshGdriveStatus();
    } catch (err) { statusEl.textContent = ''; toast(err.message, true); }
  });

  document.getElementById('gdriveRestoreBtn').addEventListener('click', async () => {
    if (!confirm('This replaces all current data with your Google Drive backup. Continue?')) return;
    const statusEl = document.getElementById('gdriveActionStatus');
    statusEl.textContent = 'Restoring…';
    try {
      await api('/gdrive/restore', { method: 'POST' });
      statusEl.textContent = '';
      toast('Data restored from Google Drive');
      await loadAll();
    } catch (err) { statusEl.textContent = ''; toast(err.message, true); }
  });

  document.getElementById('gdriveDisconnectBtn').addEventListener('click', async () => {
    try {
      await api('/gdrive/disconnect', { method: 'POST' });
      toast('Disconnected from Google Drive');
      await refreshGdriveStatus();
    } catch (err) { toast(err.message, true); }
  });

  refreshUsbBackupList();
  refreshGdriveStatus();

  // ================= ACCOUNT: username display, logout, change password =================
  (async () => {
    try {
      const s = await api('/auth/status');
      if (s.username) {
        document.getElementById('accountUsernameLine').textContent = 'Signed in as ' + s.username;
        const initials = s.username.trim().slice(0, 2).toUpperCase();
        const avatarEl = document.querySelector('.avatar');
        if (avatarEl) avatarEl.textContent = initials;
      }
    } catch (e) { /* ignore */ }
  })();

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    clearToken();
    window.location.href = 'login.html';
  });

  document.getElementById('changePasswordForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = formData(e.target);
    try {
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify(body) });
      clearToken();
      toast('Password changed — please sign in again');
      setTimeout(() => { window.location.href = 'login.html'; }, 1200);
    } catch (err) { toast(err.message, true); }
  });

  // The server no longer redirects unauthenticated page loads (that
  // decision now lives here, client-side, since it works the same way
  // whether the page came over real HTTP or Electron's custom protocol).
  // Check first, before anything else touches the protected API.
  (async () => {
    try {
      const s = await api('/auth/status');
      if (!s.loggedIn) { window.location.href = 'login.html'; return; }
    } catch (e) {
      window.location.href = 'login.html';
      return;
    }
    loadAll().catch(err => toast(err.message, true));
  })();
})();
