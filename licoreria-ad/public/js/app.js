const state = {
  user: null,
  events: [],
  editing: null,
  issued: null,
  dash: null,
  sales: null,
  salesError: '',
  salesQuery: { preset: 'day', from: '', to: '', q: '', product: '' },
  productSales: null,
  detail: null,
  reads: [],
  products: [],
  inventoryQuery: '',
  editingProduct: null,
  editingCombo: null,
  comboParts: [],
  currentTicket: null,
  cart: [],
  delivery: null,
  board: [],
  boardQuery: '',
  barra: [],
  barraQuery: '',
  barraSale: null,
  barraPicks: {},
  issuedSale: null,
  saleCurrency: 'usd',
  bcvRate: 0,
  summaryQuery: { preset: 'day', from: '', to: '', fromHour: '', toHour: '' },
  suppliers: [],
  supplierPurchases: [],
  supplierOpen: false,
  buyLines: [],
  expenses: [],
  expenseQuery: { preset: 'month', from: '', to: '' },
  publicSale: null,
  sheet: null,
  moves: null,
  moveQuery: { preset: 'month', from: '', to: '', q: '', kind: '' },
  moveError: '',
  staff: [],
  editingUser: null,
  screens: [],
  orderAlerts: [],
  pendingBarraId: 0,
  skipNoticeId: 0,
};

const MODULES = [
  ['resumen', 'Resumen'],
  ['venta', 'Venta'],
  ['barra', 'Barra'],
  ['inventario', 'Inventario'],
  ['compras', 'Compras'],
  ['cargas', 'Cargas y descargas'],
  ['gastos', 'Gastos'],
  ['ventas', 'Ventas'],
  ['movimientos', 'Movimientos'],
  ['pantallas', 'Pantallas'],
  ['usuarios', 'Usuarios'],
];

const PAYMENTS = [
  ['efectivo', 'Efectivo'],
  ['tarjeta', 'Tarjeta'],
  ['transferencia', 'Transferencia'],
  ['pago_movil', 'Pago móvil'],
];

let renderToken = 0;
let stream = null;
let scanTimer = null;
let screenTimer = null;
let screenBoot = null;
let buyGuard = 0;
let salesTimer = 0;
let liveTimer = 0;
let noticeTimer = 0;
let audioCtx = null;
let youtubeSeconds = null;
let screenReady = true;

window.addEventListener('message', (event) => {
  if (!String(event.origin || '').includes('youtube.com')) return;
  let data = event.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return; }
  }
  const time = data?.info?.currentTime ?? data?.info?.current_time;
  if (typeof time === 'number' && Number.isFinite(time)) youtubeSeconds = time;
});

const negocio = window.__NEGOCIO || {
  id: 'licoreria-ad',
  base: '',
  name: 'Licorería A&D',
  shortName: 'A&D',
  codePrefix: 'AD',
  eyebrow: 'Licorería',
  lead: 'Venta directa, factura con QR y entrega en barra.',
  loginTitle: 'La puerta de la licorería.',
  loginLead: 'Desde aquí se factura, se entrega en barra y se lleva el inventario.',
  themeColor: '#1a120e',
};
const BASE = negocio.base || '';
const screenKey = `${negocio.id || 'sierra'}-screen-token`;
document.documentElement.dataset.negocio = negocio.id || 'sierra';
const themeMeta = document.querySelector('meta[name="theme-color"]');
if (themeMeta && negocio.themeColor) themeMeta.setAttribute('content', negocio.themeColor);
const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
if (appleTitle && negocio.shortName) appleTitle.setAttribute('content', negocio.shortName);

function appPath(path) {
  if (!BASE) return path;
  if (path === '/') return `${BASE}/`;
  return `${BASE}${path}`;
}

function pageTitle(path) {
  const section = {
    '/acceso': 'Acceso',
    '/panel': 'Panel',
    '/panel/venta': 'Venta',
    '/panel/barra': 'Barra',
    '/panel/inventario': 'Inventario',
    '/panel/compras': 'Compras',
    '/panel/cargas': 'Cargas y descargas',
    '/panel/gastos': 'Gastos',
    '/panel/ventas': 'Ventas',
    '/panel/movimientos': 'Movimientos',
    '/panel/pantallas': 'Pantallas',
    '/panel/usuarios': 'Usuarios',
    '/panel/cuenta': 'Cuenta',
    '/pantalla': 'Pantalla',
  }[path];
  return section ? `${section} · ${negocio.name}` : negocio.name;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function money(cents) {
  const formatted = (Number(cents) / 100).toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} $`;
}

function moneyPair(cents, bs) {
  return `<p class="stat-value">${money(cents || 0)}</p><p class="stat-sub">${moneyBs(bs || 0)}</p>`;
}

function moneyBs(cents) {
  const formatted = (Number(cents) / 100).toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} Bs`;
}

function bsCents(usdCents, rate = state.bcvRate) {
  const value = Number(rate) || 0;
  if (value <= 0) return 0;
  return Math.round(Number(usdCents) * value);
}

function displayMoney(cents) {
  if (currentPath() === '/panel/venta' && state.saleCurrency === 'bs') {
    if (!(Number(state.bcvRate) > 0)) return 'Sin tasa BCV';
    return moneyBs(bsCents(cents));
  }
  return money(cents);
}

function chargedTotal(sale) {
  if (!sale) return '';
  if (sale.currency === 'bs') return moneyBs(sale.totalBsCents || bsCents(sale.totalCents, sale.bcvRate));
  return money(sale.totalCents);
}

function todayInput() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function acceptsCurrency(product) {
  if (state.saleCurrency === 'bs') return product.payBs !== false;
  return product.payUsd !== false;
}

function sameCode(left, right) {
  const a = String(left || '').trim().toLocaleLowerCase('es');
  const b = String(right || '').trim().toLocaleLowerCase('es');
  return a.length > 0 && a === b;
}

function combosForProduct(product) {
  if (!product || product.isCombo || !String(product.code || '').trim()) return [];
  const selling = currentPath() === '/panel/venta';
  return state.products.filter((item) => item.isCombo && item.active && sameCode(item.code, product.code) && (!selling || acceptsCurrency(item)));
}

function linkedCombo(product) {
  if (!product?.isCombo) return false;
  const selling = currentPath() === '/panel/venta';
  return state.products.some((item) => !item.isCombo && item.active && sameCode(item.code, product.code) && (!selling || acceptsCurrency(item)));
}

function productThumb(product, className = 'thumb') {
  const letter = esc(String(product?.name || '?').trim().slice(0, 1) || '?');
  if (!product?.imageUrl) return `<span class="${className} thumb-empty">${letter}</span>`;
  return `<img class="${className}" alt="" src="${esc(product.imageUrl)}">`;
}

function formatDateTime(iso) {
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Caracas',
  }).format(new Date(iso));
}

function formatHour(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('es-VE', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'America/Caracas',
  }).format(new Date(iso));
}

function hourOptions(selected) {
  let html = '<option value="">Cualquiera</option>';
  for (let hour = 0; hour < 24; hour += 1) {
    const label = `${String(hour).padStart(2, '0')}:00`;
    html += `<option value="${hour}" ${String(selected ?? '') === String(hour) ? 'selected' : ''}>${label}</option>`;
  }
  return html;
}

function deliveryItems(sale) {
  return (sale?.items || []).filter((item) => !item.exploded);
}

function remaining(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return '0 min';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours <= 0) return `${minutes} min`;
  return `${hours} h ${minutes} min`;
}

function entradasLabel(count) {
  return `${count} ${Number(count) === 1 ? 'entrada' : 'entradas'}`;
}

function paymentLabel(value) {
  if (value === 'cortesia') return 'Sin cobro';
  return PAYMENTS.find(([key]) => key === value)?.[1] || 'Sin definir';
}

function paymentOptions(selected) {
  return PAYMENTS.map(([key, label]) => `<option value="${key}" ${key === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function normalizeCode(raw) {
  const text = String(raw || '').trim().toUpperCase();
  const prefix = negocio.codePrefix || 'LS';
  const match = text.match(new RegExp(`${prefix}-[A-F0-9]{10}`));
  return match ? match[0] : text;
}

function currentPath() {
  let path = location.pathname;
  if (BASE && (path === BASE || path.startsWith(`${BASE}/`))) path = path.slice(BASE.length) || '/';
  return path.replace(/\/+$/, '') || '/';
}

function mark() {
  return `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-width="1.6"></circle><path d="M9 33 L18 21 L24 27 L33 15 L39 33" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"></path></svg>`;
}

function statusBadge(status) {
  const map = {
    active: ['ok', 'Vigente'],
    used: ['used', 'Usada'],
    expired: ['expired', 'Vencida'],
  };
  const [kind, label] = map[status] || ['used', 'Revisar'];
  return `<span class="badge ${kind}">${label}</span>`;
}

function whenText(ticket) {
  if (ticket.status === 'used' && ticket.usedAt) return `Ingresó ${formatDateTime(ticket.usedAt)}`;
  if (ticket.status === 'expired') return `Venció ${formatDateTime(ticket.expiresAt)}`;
  return `Vence ${formatDateTime(ticket.expiresAt)} · quedan ${remaining(ticket.expiresAt)}`;
}

async function api(path, options = {}) {
  const response = await fetch(appPath(path), {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'No se pudo completar la acción.');
    error.status = response.status;
    error.data = data;
    if (response.status === 401 && !options.soft && !path.includes('/api/login')) {
      state.user = null;
      if (currentPath().startsWith('/panel')) {
        history.replaceState({}, '', appPath('/acceso'));
        queueMicrotask(() => render());
      }
    }
    throw error;
  }
  return data;
}

function toast(message, kind = 'ok') {
  const element = document.createElement('div');
  element.className = `toast ${kind === 'bad' ? 'bad' : ''}`;
  element.textContent = message;
  document.body.appendChild(element);
  setTimeout(() => element.remove(), 3200);
}

function mount(html) {
  const rooted = BASE ? html.replaceAll('href="/', `href="${BASE}/`) : html;
  document.getElementById('app').innerHTML = rooted;
}

function stopLive() {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = 0;
}

function stopCamera() {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = null;
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  const box = document.getElementById('camera-box');
  if (box) box.hidden = true;
}

function allow(moduleName) {
  if (!state.user) return false;
  if (state.user.isAdmin) return true;
  return state.user.permissions?.includes(moduleName);
}

function shell(content) {
  const path = currentPath();
  const items = [
    ['/panel', 'Resumen', 'resumen'],
    ['/panel/venta', 'Venta', 'venta'],
    ['/panel/barra', 'Barra', 'barra'],
    ['/panel/inventario', 'Inventario', 'inventario'],
    ['/panel/compras', 'Compras', 'compras'],
    ['/panel/cargas', 'Cargas y descargas', 'cargas'],
    ['/panel/gastos', 'Gastos', 'gastos'],
    ['/panel/ventas', 'Ventas', 'ventas'],
    ['/panel/movimientos', 'Movimientos', 'movimientos'],
    ['/panel/pantallas', 'Pantallas', 'pantallas'],
    ['/panel/usuarios', 'Usuarios', 'usuarios'],
  ].filter((item) => allow(item[2]));
  const current = [...items, ['/panel/cuenta', 'Cuenta']].find(([href]) => href === path);
  return `
    <div class="shell night">
      <div class="backdrop" data-action="menu"></div>
      <aside class="sidebar">
        <a class="brand brand-light" href="/" data-link>${mark()}<span>${esc(negocio.shortName)}</span></a>
        <nav class="side-nav">
          ${items.map(([href, label]) => `<a class="side-link ${path === href ? 'active' : ''}" href="${href}" data-link>${label}</a>`).join('')}
        </nav>
        <div class="side-foot">
          <a class="side-link ${path === '/panel/cuenta' ? 'active' : ''}" href="/panel/cuenta" data-link>Cuenta</a>
          <button class="side-btn" type="button" data-action="logout">Cerrar sesión</button>
          <p class="side-user">${esc(state.user?.username || '')}</p>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="menu-btn" type="button" data-action="menu" aria-label="Abrir menú"><span></span><span></span><span></span></button>
          <span class="module-title">${esc(current?.[1] || 'Panel')}</span>
          <div class="topbar-space"></div>
          <span class="who">${esc(state.user?.username || '')}</span>
        </header>
        <div class="content">${content}${detailModal()}</div>
      </div>
    </div>`;
}

function loading() {
  return `<p class="lead">Cargando…</p>`;
}

function homeView() {
  return `
    <div class="public">
      <header class="topnav">
        <div class="wrap nav-inner">
          <a class="brand" href="/" data-link>${mark()}<span>${esc(negocio.name)}</span></a>
          <nav class="nav-links">
            <a class="btn amber small" href="${state.user ? '/panel' : '/acceso'}" data-link>${state.user ? 'Panel' : 'Acceso'}</a>
          </nav>
        </div>
      </header>
      <section class="hero">
        <div class="wrap">
          <p class="eyebrow">${esc(negocio.eyebrow)}</p>
          <h1>${esc(negocio.name)}</h1>
          <p class="lead">${esc(negocio.lead)}</p>
          <div class="eq" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
        </div>
      </section>
    </div>`;
}

function loginView(error = '') {
  return `
    <div class="login-split public">
      <aside class="login-aside">
        <a class="brand" href="/" data-link>${mark()}<span>${esc(negocio.name)}</span></a>
        <div>
          <p class="eyebrow">Personal</p>
          <h1>${esc(negocio.loginTitle)}</h1>
          <p class="lead" style="margin-top:16px">${esc(negocio.loginLead)}</p>
        </div>
      </aside>
      <main class="login-main">
        <form class="login-card" data-form="login">
          <h2>Entrar</h2>
          <p class="lead page-lead">Usa el usuario del personal.</p>
          <label class="field"><span>Usuario</span><input name="username" autocomplete="username" required></label>
          <label class="field"><span>Contraseña</span><input name="password" type="password" autocomplete="current-password" required></label>
          <p class="form-error" ${error ? '' : 'hidden'}>${esc(error)}</p>
          <button class="btn primary" type="submit">Entrar al panel</button>
        </form>
      </main>
    </div>`;
}

function ticketRows(rows) {
  if (!rows.length) return `<div class="empty"><h3>Todavía no hay entradas</h3><p class="lead">Cuando emitas la primera, aparecerá en este listado.</p></div>`;
  return `
    <div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>Evento</th><th>Entradas</th><th>Total</th><th>Código</th><th>Estado</th></tr></thead>
      <tbody>
        ${rows.map((ticket) => `
          <tr>
            <td>${formatDateTime(ticket.createdAt)}</td>
            <td>${esc(ticket.eventName)}</td>
            <td>${ticket.quantity}</td>
            <td>${money(ticket.totalCents)}</td>
            <td><button class="linkish code" type="button" data-action="detail" data-code="${esc(ticket.code)}">${esc(ticket.code)}</button></td>
            <td>${statusBadge(ticket.status)}</td>
          </tr>`).join('')}
      </tbody>
    </table></div>`;
}

function dashboardView() {
  const dash = state.dash || {};
  const query = state.summaryQuery;
  const recent = dash.recent || [];
  const payments = dash.payments || [];
  const series = (dash.series || []).filter((row) => row.salesCents || row.salesBs);
  const rows = recent.length
    ? `<div class="event-list">${recent.map((sale) => `
        <article class="event-row">
          <div>
            <h3>${esc(sale.customerName)}</h3>
            <p class="price-line">Factura ${esc(sale.numberLabel)} · ${formatDateTime(sale.createdAt)} · ${sale.refundedAt ? 'Devuelta' : paymentLabel(sale.paymentMethod)}</p>
          </div>
          <strong>${sale.refundedAt ? 'Devuelta' : chargedTotal(sale)}</strong>
        </article>`).join('')}</div>`
    : `<div class="empty"><h3>Todavía no hay facturas</h3><p class="lead">La primera venta aparece aquí.</p></div>`;
  const paymentRows = payments.length
    ? payments.map((row) => `<article class="event-row"><div><h3>${esc(paymentLabel(row.method))}</h3><p class="price-line">${row.count} factura${row.count === 1 ? '' : 's'}</p></div><strong>${money(row.salesCents)} · ${moneyBs(row.salesBs)}</strong></article>`).join('')
    : `<p class="hint">En este periodo no hay cobros.</p>`;
  const seriesRows = series.length
    ? series.map((row) => `<p class="price-line">${esc(row.label)} · ${money(row.salesCents)} · ${moneyBs(row.salesBs)}</p>`).join('')
    : `<p class="hint">Sin ventas en este periodo.</p>`;
  return `
    <h2>Resumen</h2>
    <p class="lead page-lead">${esc(dash.label || 'Periodo')} · Tasa BCV ${Number(dash.rate) > 0 ? Number(dash.rate).toLocaleString('es-VE', { maximumFractionDigits: 4 }) : 'sin colocar'}</p>
    <form class="card no-print" data-form="summary" style="margin-bottom:16px">
      <div class="cart-add summary-filters">
        <label class="field"><span>Periodo</span>
          <select name="preset">
            <option value="hour" ${query.preset === 'hour' ? 'selected' : ''}>Hoy, por hora</option>
            <option value="day" ${query.preset === 'day' ? 'selected' : ''}>Hoy</option>
            <option value="week" ${query.preset === 'week' ? 'selected' : ''}>Esta semana</option>
            <option value="month" ${query.preset === 'month' ? 'selected' : ''}>Este mes</option>
            <option value="custom" ${query.preset === 'custom' ? 'selected' : ''}>Entre fechas</option>
          </select>
        </label>
        <label class="field"><span>Desde</span><input name="from" type="date" value="${esc(query.from || '')}"></label>
        <label class="field"><span>Hasta</span><input name="to" type="date" value="${esc(query.to || '')}"></label>
        <label class="field"><span>Desde la hora</span><select name="fromHour">${hourOptions(query.fromHour)}</select></label>
        <label class="field"><span>Hasta la hora</span><select name="toHour">${hourOptions(query.toHour)}</select></label>
      </div>
      <p class="hint">La hora es la de Venezuela. Si eliges 20 y 22, entran las ventas de las 20:00 a las 22:59.</p>
      <button class="btn primary" type="submit">Ver rendimiento</button>
    </form>
    <section class="card global-card">
      <h3>Global</h3>
      <p class="hint">Junta las ventas en dólares y en bolívares. La utilidad es esa venta menos los costos y los gastos.</p>
      <div class="grid-stats">
        <article class="stat"><p class="stat-label">Venta general</p>${moneyPair(dash.globalSalesCents, dash.globalSalesBs)}</article>
        <article class="stat"><p class="stat-label">Costos</p>${moneyPair(dash.globalCostCents, dash.globalCostBs)}</article>
        <article class="stat"><p class="stat-label">Gastos</p>${moneyPair(dash.globalExpensesCents, dash.globalExpensesBs)}</article>
        <article class="stat"><p class="stat-label">Utilidad</p>${moneyPair(dash.globalProfitCents, dash.globalProfitBs)}</article>
      </div>
    </section>
    <div class="grid-stats">
      <article class="stat"><p class="stat-label">Ventas en dólares</p><p class="stat-value">${money(dash.salesCents || 0)}</p></article>
      <article class="stat"><p class="stat-label">Costo en dólares</p><p class="stat-value">${money(dash.costCents || 0)}</p></article>
      <article class="stat"><p class="stat-label">Utilidad en dólares</p><p class="stat-value">${money(dash.profitCents || 0)}</p></article>
      <article class="stat"><p class="stat-label">Facturas</p><p class="stat-value">${dash.invoices || 0}</p></article>
    </div>
    <div class="grid-stats">
      <article class="stat"><p class="stat-label">Ventas en bolívares</p><p class="stat-value">${moneyBs(dash.salesBs || 0)}</p></article>
      <article class="stat"><p class="stat-label">Costo en bolívares</p><p class="stat-value">${moneyBs(dash.costBs || 0)}</p></article>
      <article class="stat"><p class="stat-label">Utilidad en bolívares</p><p class="stat-value">${moneyBs(dash.profitBs || 0)}</p></article>
      <article class="stat"><p class="stat-label">Por entregar</p><p class="stat-value">${dash.pending || 0}</p></article>
    </div>
    <div class="grid-stats thirds">
      <article class="stat"><p class="stat-label">Gastos en dólares</p><p class="stat-value">${money(dash.expensesCents || 0)}</p></article>
      <article class="stat"><p class="stat-label">Gastos en bolívares</p><p class="stat-value">${moneyBs(dash.expensesBs || 0)}</p></article>
      <article class="stat"><p class="stat-label">Ventas menos gastos</p><p class="stat-value">${money((dash.salesCents || 0) - (dash.expensesCents || 0))}</p></article>
    </div>
    <div class="pos-grid">
      <section class="card"><h3>Cómo está ingresando</h3><div class="event-list" style="margin-top:12px">${paymentRows}</div></section>
      <section class="card"><h3>${query.preset === 'hour' || query.preset === 'day' ? 'Por hora' : 'Por día'}</h3><div style="margin-top:12px">${seriesRows}</div></section>
    </div>
    <section class="card"><h3>Últimas facturas</h3><div style="height:12px"></div>${rows}</section>`;
}

function eventsView() {
  const editing = state.editing;
  const list = state.events.length
    ? `<div class="event-list">${state.events.map((event) => `
        <article class="event-row ${event.active ? '' : 'inactive'}">
          <div>
            <h3>${esc(event.name)}</h3>
            <p class="price-line">${money(event.priceCents)} · ${event.active ? 'A la venta' : 'Inactivo'}</p>
          </div>
          <div class="row-actions">
            <button class="btn ghost small" type="button" data-action="edit-event" data-id="${event.id}">Editar</button>
            <button class="btn ghost small" type="button" data-action="toggle-event" data-id="${event.id}" data-active="${event.active ? '1' : '0'}">${event.active ? 'Desactivar' : 'Activar'}</button>
            <button class="btn danger small" type="button" data-action="delete-event" data-id="${event.id}">Eliminar</button>
          </div>
        </article>`).join('')}</div>`
    : `<div class="empty"><h3>Aún no hay eventos</h3><p class="lead">Crea el primero con su nombre y su precio. Después podrás emitir entradas sobre él.</p></div>`;
  return `
    <div class="split">
      <form class="card no-print" data-form="event">
        <h2>${editing ? 'Editar evento' : 'Nuevo evento'}</h2>
        <p class="lead page-lead">El nombre es el del evento. El precio queda guardado en cada entrada que emitas.</p>
        <label class="field"><span>Nombre</span><input name="name" maxlength="80" required value="${esc(editing?.name || '')}" placeholder="Noche del viernes"></label>
        <label class="field"><span>Precio por entrada</span><input name="price" inputmode="decimal" required value="${editing ? (editing.priceCents / 100).toFixed(2).replace('.', ',') : ''}" placeholder="0,00"></label>
        <label class="check"><input name="active" type="checkbox" ${editing ? (editing.active ? 'checked' : '') : 'checked'}><span>Visible en la cartelera y disponible para vender</span></label>
        <p class="form-error" hidden></p>
        <div class="row-actions">
          <button class="btn primary" type="submit">${editing ? 'Guardar cambios' : 'Crear evento'}</button>
          ${editing ? '<button class="btn ghost" type="button" data-action="cancel-edit">Cancelar</button>' : ''}
        </div>
      </form>
      <section>
        <h2>Eventos y precios</h2>
        <p class="lead page-lead">Cada evento tiene su propio precio. Las entradas ya emitidas conservan el precio del momento.</p>
        ${list}
      </section>
    </div>`;
}

function issuedView() {
  if (!state.issued) {
    return `<section class="card"><h3>Cómo se emite</h3><p class="lead" style="margin-top:8px">Elige el evento, cuántas personas entran, el alias y cómo pagaron. El comprobante es opcional. Puedes dar un QR a cada persona, o un solo QR enlazado a varias entradas. El código caduca a las 12 horas.</p></section>`;
  }
  const issued = state.issued;
  return `
    <section>
      <div class="row-actions no-print" style="margin-bottom:12px">
        <button class="btn primary" type="button" data-action="print">Imprimir</button>
        <button class="btn ghost" type="button" data-action="clear-issued">Nueva emisión</button>
      </div>
      <div class="stub-grid">
        ${issued.tickets.map((ticket) => `
          <article class="stub">
            <div class="stub-body">
              <p class="stub-kicker">${esc(negocio.name)}</p>
              <h3>${esc(ticket.eventName)}</h3>
              ${ticket.alias ? `<p>${esc(ticket.alias)}</p>` : ''}
              <p>${entradasLabel(ticket.quantity)}</p>
              <p class="price-line">${money(ticket.totalCents)} · ${esc(paymentLabel(ticket.paymentMethod))}</p>
              ${ticket.hasReceipt ? `<a class="btn ghost small" href="/api/tickets/${ticket.id}/receipt" target="_blank" rel="noopener">Ver comprobante</a>` : ''}
              <p class="hint" style="margin-top:8px">${ticket.status === 'active' ? `Vence ${esc(formatDateTime(ticket.expiresAt))}<br>Quedan ${esc(remaining(ticket.expiresAt))}` : esc(whenText(ticket))}</p>
              <p class="code" style="margin-top:10px">${esc(ticket.code)}</p>
              <button class="btn ghost small no-print" type="button" data-action="download" data-code="${esc(ticket.code)}" style="margin-top:10px">Descargar QR</button>
            </div>
            <div class="stub-qr"><img alt="QR ${esc(ticket.code)}" src="${ticket.qrDataUrl}"></div>
          </article>`).join('')}
      </div>
    </section>`;
}

function createView() {
  const activeEvents = state.events.filter((event) => event.active);
  const options = activeEvents.map((event) => `<option value="${event.id}" data-price="${event.priceCents}">${esc(event.name)} · ${money(event.priceCents)}</option>`).join('');
  const form = activeEvents.length
    ? `<form class="card no-print" id="ticket-form" data-form="ticket">
        <h2>Emitir</h2>
        <label class="field"><span>Evento</span><select name="eventId">${options}</select></label>
        <label class="field"><span>Cantidad de entradas</span><input name="quantity" type="number" min="1" max="100" value="1" required></label>
        <label class="field"><span>Alias</span><input name="alias" maxlength="40" placeholder="Nombre de quien entra"></label>
        <label class="check"><input name="free" type="checkbox"><span>No cobrar entrada</span></label>
        <p class="hint">Si no la cobras, igual se emite el QR con el alias. El total queda en 0.</p>
        <div id="pay-field"><label class="field"><span>Método de pago</span><select name="paymentMethod" required>${paymentOptions('efectivo')}</select></label></div>
        <label class="field"><span>Comprobante, opcional</span><input name="file" type="file" accept="image/*,.pdf"></label>
        <div class="choices">
          <label class="choice"><input type="radio" name="mode" value="individual" checked><span><strong>Un QR por entrada</strong><small>Cada persona recibe su propio código.</small></span></label>
          <label class="choice"><input type="radio" name="mode" value="group"><span><strong>Un QR para varias entradas</strong><small>Un solo código queda enlazado a todo el grupo.</small></span></label>
        </div>
        <div class="total-box"><span>Total</span><div><strong id="total-preview">${money(activeEvents[0].priceCents)}</strong><small class="hint" id="total-note">1 QR individual</small></div></div>
        <p class="form-error" hidden></p>
        <button class="btn primary" type="submit">Generar QR</button>
      </form>`
    : `<section class="card"><h2>Falta un evento</h2><p class="lead page-lead">Antes de emitir, crea el evento y ponle precio.</p><a class="btn primary" href="/panel/eventos" data-link>Ir a eventos y precios</a></section>`;
  return `<div class="split">${form}${issuedView()}</div>`;
}

function resultView(ticket, note = '') {
  const kind = ticket.status === 'active' ? 'ok' : ticket.status === 'used' ? 'warn' : 'bad';
  const title = ticket.status === 'active' ? 'Vigente' : ticket.status === 'used' ? 'Usada' : 'Vencida';
  const action = ticket.status === 'active'
    ? `<button class="btn primary" type="button" data-action="use-ticket" data-code="${esc(ticket.code)}">Registrar ingreso de ${esc(entradasLabel(ticket.quantity))}</button>`
    : '';
  return `
    <article class="result ${kind}">
      <p class="stub-kicker">${esc(ticket.code)}</p>
      <h2>${title}</h2>
      <p class="people">${ticket.quantity}</p>
      <p>${entradasLabel(ticket.quantity)}</p>
      <h3 style="margin-top:12px">${esc(ticket.alias || ticket.eventName)}</h3>
      ${ticket.alias ? `<p class="price-line">${esc(ticket.eventName)}</p>` : ''}
      <p class="price-line">${money(ticket.totalCents)} · ${esc(paymentLabel(ticket.paymentMethod))} · ${esc(whenText(ticket))}</p>
      ${ticket.hasReceipt ? `<p style="margin-top:8px"><a class="btn ghost small" href="/api/tickets/${ticket.id}/receipt" target="_blank" rel="noopener">Ver comprobante</a></p>` : ''}
      ${note ? `<p style="margin-top:10px">${esc(note)}</p>` : ''}
      <div class="row-actions" style="margin-top:16px">
        ${action}
        ${ticket.status === 'expired' ? '' : `<button class="btn amber" type="button" data-action="open-buy">Agregar compra</button>`}
        <button class="btn ghost" type="button" data-action="focus-code">Leer otro</button>
      </div>
    </article>`;
}

function resultMissing(code) {
  return `<article class="result bad"><h2>No existe</h2><p class="lead">No hay una entrada con el código ${esc(code)}.</p></article>`;
}

function visorView() {
  const canDetect = 'BarcodeDetector' in window;
  const canCamera = canDetect && navigator.mediaDevices?.getUserMedia;
  return `
    <div class="visor-grid">
      <section class="card">
        <h2>Visor QR</h2>
        <p class="lead page-lead">Escanea el QR o busca por el alias. También puedes registrar el ingreso y cargar las compras de esa entrada.</p>
        <form id="lookup-form" data-form="lookup">
          <label class="field"><span>Código o alias</span><input name="code" autocomplete="off" spellcheck="false" placeholder="Código o nombre" required></label>
          <div class="row-actions">
            <button class="btn primary" type="submit">Consultar</button>
            ${canCamera ? '<button class="btn ghost" type="button" data-action="camera">Usar cámara</button>' : ''}
            ${canDetect ? '<label class="btn ghost file-btn">Subir foto<input type="file" accept="image/*" data-file="qr"></label>' : ''}
          </div>
          <p class="form-error" hidden></p>
        </form>
        ${canCamera ? `<div class="camera" id="camera-box" hidden><video id="cam" playsinline autoplay muted></video><button class="btn ghost" type="button" data-action="stop-camera">Detener cámara</button></div>` : `<p class="hint">Este navegador no lee la cámara. Escribe el código que va debajo del QR.</p>`}
        <div id="visor-result" style="margin-top:16px"></div>
      </section>
      <section>
        <div id="visor-account"></div>
        <h3>Lecturas de esta sesión</h3>
        <div id="visor-log" class="read-log" style="margin-top:12px"></div>
      </section>
    </div>`;
}

function centsFromInput(value) {
  const text = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

function moneyInput(cents) {
  return (Number(cents) / 100).toFixed(2).replace('.', ',');
}

function updateProductProfit() {
  const form = document.querySelector('form[data-form="product"]');
  const box = document.getElementById('product-profit');
  if (!form || !box) return;
  const amounts = unitAmounts(form);
  if (amounts.cost == null || amounts.price == null) {
    box.textContent = 'Escribe el costo y el precio de venta para ver la utilidad por unidad.';
    return;
  }
  const profit = amounts.price - amounts.cost;
  const percent = amounts.price > 0 ? (profit / amounts.price) * 100 : null;
  const percentText = percent == null ? '' : ` · ${percent.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
  const unitText = pairMoney(profit);
  if (amounts.boxMode && Number.isInteger(amounts.perBox) && amounts.perBox >= 2 && amounts.costRaw != null) {
    const boxSale = amounts.price * amounts.perBox;
    const boxProfit = boxSale - amounts.costRaw;
    const saleText = pairMoney(boxSale);
    const costText = pairMoney(amounts.costRaw);
    const profitText = pairMoney(boxProfit);
    box.textContent = `Utilidad de la caja: ${profitText}. La venta de las ${amounts.perBox} unidades es ${saleText} y el costo de la caja es ${costText}. Por unidad quedan ${unitText}${percentText}.`;
    box.classList.toggle('loss', boxProfit < 0);
  } else {
    box.textContent = `Utilidad por unidad: ${unitText}${percentText}`;
    box.classList.toggle('loss', profit < 0);
  }
  const costLine = document.getElementById('cost-convert');
  const priceLine = document.getElementById('price-convert');
  if (costLine) costLine.textContent = amounts.cost == null ? 'Elige la moneda y escribe el costo.' : `Costo por unidad: ${bothMoney(amounts.cost)}`;
  if (priceLine) priceLine.textContent = amounts.price == null ? 'Elige la moneda y escribe el precio de venta.' : `Venta por unidad: ${bothMoney(amounts.price)}`;
}

function fieldCurrency(form, name) {
  return form.querySelector(`[name="${name}"]`)?.value === 'bs' ? 'bs' : 'usd';
}

function toUsdCents(cents, currency) {
  if (cents == null) return null;
  if (currency !== 'bs') return cents;
  const rate = Number(state.bcvRate);
  if (!(rate > 0)) return null;
  return Math.round(cents / rate);
}

function fromUsdCents(usdCents, currency) {
  if (usdCents == null) return null;
  if (currency !== 'bs') return usdCents;
  return bsCents(usdCents);
}

function bothMoney(usdCents) {
  if (usdCents == null) return '';
  if (!(Number(state.bcvRate) > 0)) return 'Coloca la tasa BCV para ver la conversión.';
  return `${money(usdCents)} · ${moneyBs(bsCents(usdCents))}`;
}

function pairMoney(usdCents) {
  if (usdCents == null) return '';
  if (!(Number(state.bcvRate) > 0)) return money(usdCents);
  return `${money(usdCents)} · ${moneyBs(bsCents(usdCents))}`;
}

function retargetMoney(input, fromCurrency, toCurrency) {
  if (!input) return;
  const cents = centsFromInput(input.value);
  if (cents == null) return;
  const usd = toUsdCents(cents, fromCurrency);
  if (usd == null) return;
  input.value = moneyInput(fromUsdCents(usd, toCurrency));
}

function convertCurrencyField(target) {
  const form = target.closest?.('form[data-form="product"]');
  if (!form || (target.name !== 'costCurrency' && target.name !== 'priceCurrency')) return;
  const next = target.value === 'bs' ? 'bs' : 'usd';
  const prev = target.dataset.prev === 'bs' ? 'bs' : 'usd';
  if (next === prev) return;
  if (next === 'bs' && !(Number(state.bcvRate) > 0)) {
    target.value = prev;
    toast('Coloca la tasa BCV antes de usar bolívares.', 'bad');
    return;
  }
  if (target.name === 'costCurrency') retargetMoney(form.cost, prev, next);
  else {
    retargetMoney(form.price, prev, next);
    retargetMoney(form.boxPrice, prev, next);
    retargetMoney(form.profit, prev, next);
  }
  target.dataset.prev = next;
}

function unitAmounts(form) {
  const perBox = Number(form.unitsPerBox?.value);
  const boxMode = !state.editingProduct && form.pack?.value === 'box' && Number.isInteger(perBox) && perBox >= 2;
  const costCurrency = fieldCurrency(form, 'costCurrency');
  const priceCurrency = fieldCurrency(form, 'priceCurrency');
  const costRaw = toUsdCents(centsFromInput(form.cost?.value), costCurrency);
  let cost = costRaw;
  if (boxMode && cost != null) cost = Math.round(cost / perBox);
  const price = toUsdCents(centsFromInput(form.price?.value), priceCurrency);
  return { cost, costRaw, price, perBox, boxMode, costCurrency, priceCurrency };
}

function writeUnitProfit(form) {
  if (!form || moneySync || !form.profit) return;
  const amounts = unitAmounts(form);
  if (amounts.cost == null || amounts.price == null) return;
  moneySync = true;
  form.profit.value = moneyInput(fromUsdCents(amounts.price - amounts.cost, amounts.priceCurrency));
  moneySync = false;
}

function refreshProductMoney(target) {
  const form = target?.closest?.('form[data-form="product"]') || document.querySelector('form[data-form="product"]');
  if (!form) return;
  convertCurrencyField(target);
  const name = target?.name;
  if (name === 'profit') syncProfitAndPrice(target);
  else if (name === 'price' || name === 'cost' || name === 'boxPrice') {
    syncPackPrices(target);
    syncProfitAndPrice(target);
  } else writeUnitProfit(form);
  updateProductProfit();
  updatePackHint();
}

let priceSync = false;
let moneySync = false;

function syncProfitAndPrice(target) {
  const form = target?.closest?.('form[data-form="product"]');
  if (!form || moneySync || !form.profit) return;
  const name = target?.name;
  if (name !== 'profit' && name !== 'price' && name !== 'cost') return;
  const costCurrency = fieldCurrency(form, 'costCurrency');
  const priceCurrency = fieldCurrency(form, 'priceCurrency');
  const perBox = Number(form.unitsPerBox?.value);
  const boxMode = !state.editingProduct && form.pack?.value === 'box' && Number.isInteger(perBox) && perBox >= 2;
  let cost = toUsdCents(centsFromInput(form.cost.value), costCurrency);
  if (cost == null) return;
  if (boxMode) cost = Math.round(cost / perBox);
  moneySync = true;
  if (name === 'profit') {
    const profit = toUsdCents(centsFromInput(form.profit.value), priceCurrency);
    if (profit != null) form.price.value = moneyInput(fromUsdCents(cost + profit, priceCurrency));
  } else {
    const price = toUsdCents(centsFromInput(form.price.value), priceCurrency);
    if (price != null) form.profit.value = moneyInput(fromUsdCents(price - cost, priceCurrency));
  }
  moneySync = false;
}

function syncPackPrices(target) {
  const form = target?.closest?.('form[data-form="product"]') || document.querySelector('form[data-form="product"]');
  if (!form || priceSync || !form.boxPrice) return;
  const perBox = Number(form.unitsPerBox?.value);
  if (!Number.isInteger(perBox) || perBox < 2) return;
  priceSync = true;
  if (target?.name === 'boxPrice') {
    const box = centsFromInput(form.boxPrice.value);
    form.price.value = box == null ? '' : moneyInput(Math.round(box / perBox));
  } else {
    const unit = centsFromInput(form.price.value);
    if (unit != null) form.boxPrice.value = moneyInput(unit * perBox);
  }
  priceSync = false;
}

function updatePackHint() {
  const form = document.querySelector('form[data-form="product"]');
  const hint = document.getElementById('pack-hint');
  const label = document.getElementById('stock-label');
  const costLabel = document.getElementById('cost-label');
  const boxPriceField = document.getElementById('box-price-field');
  if (!form || !hint) return;
  const pack = form.pack?.value || 'unit';
  const perBox = Number(form.unitsPerBox?.value);
  const count = Number(form.stock?.value);
  const boxMode = !state.editingProduct && pack === 'box';
  const showBoxPrice = boxMode || (Number.isInteger(perBox) && perBox >= 2);
  if (costLabel) costLabel.textContent = boxMode ? 'Costo de la caja' : 'Costo por unidad';
  if (boxPriceField) boxPriceField.hidden = !showBoxPrice;
  if (label) label.textContent = boxMode ? 'Cajas' : (state.editingProduct ? 'Existencias en unidades' : 'Existencias');
  const amounts = unitAmounts(form);
  const unitCost = amounts.cost == null ? '' : `Costo por unidad: ${bothMoney(amounts.cost) || money(amounts.cost)}. `;
  const unitPrice = amounts.price == null ? '' : `Venta por unidad: ${bothMoney(amounts.price) || money(amounts.price)}. `;
  const boxPrice = amounts.price != null && Number.isInteger(perBox) && perBox >= 2
    ? `Venta por caja: ${bothMoney(amounts.price * perBox) || money(amounts.price * perBox)}. `
    : '';
  let stockText = 'Esto queda en unidades. En el visor se vende de una en una.';
  if (state.editingProduct) stockText = 'Al editar, el costo y el precio son por unidad. Para meter cajas usa Sumar.';
  else if (boxMode && (!Number.isInteger(perBox) || perBox < 2)) stockText = 'Escribe cuántas unidades trae cada caja. El costo de la caja se divide entre esas unidades.';
  else if (boxMode && Number.isInteger(count) && count >= 1) stockText = `${count.toLocaleString('es-ES')} cajas × ${perBox.toLocaleString('es-ES')} = ${(count * perBox).toLocaleString('es-ES')} unidades.`;
  else if (boxMode) stockText = `Cada caja suma ${perBox} unidades.`;
  hint.textContent = `${unitCost}${unitPrice}${boxPrice}${stockText}`;
}

function stockMark(product) {
  const units = Number(product.stock) || 0;
  const perBox = Number(product.unitsPerBox) || 1;
  const label = units === 1 ? 'unidad' : 'unidades';
  let boxes = '';
  if (perBox > 1) {
    const full = Math.floor(units / perBox);
    const loose = units % perBox;
    const boxWord = full === 1 ? 'caja' : 'cajas';
    boxes = loose
      ? `${full.toLocaleString('es-ES')} ${boxWord} y ${loose.toLocaleString('es-ES')} sueltas`
      : `${full.toLocaleString('es-ES')} ${boxWord}`;
  }
  return `
    <div class="stock-mark ${units < 1 ? 'out' : ''}" aria-label="${units.toLocaleString('es-ES')} ${label} en existencia">
      <strong>${units.toLocaleString('es-ES')}</strong>
      <span>${label}</span>
      ${boxes ? `<small>${boxes}</small>` : ''}
    </div>`;
}

function inventoryMatches(product) {
  const text = (state.inventoryQuery || '').trim().toLocaleLowerCase('es');
  if (!text) return true;
  const source = typeof product === 'string' ? { name: product } : product;
  return [source?.name, source?.code, source?.department].some((value) => String(value || '').toLocaleLowerCase('es').includes(text));
}

function productListHtml() {
  const all = state.products.filter((product) => !product.isCombo);
  const products = all.filter((product) => inventoryMatches(product));
  if (!all.length) {
    return `<div class="empty"><h3>El inventario está vacío</h3><p class="lead">Carga cada producto con su costo, su precio de venta y las unidades que tienes.</p></div>`;
  }
  if (!products.length) {
    return `<div class="empty"><h3>Ningún producto coincide</h3><p class="lead">Prueba con otro nombre.</p></div>`;
  }
  return `<div class="event-list">${products.map((product) => `
        <article class="event-row ${product.active ? '' : 'inactive'}">
          ${stockMark(product)}
          ${productThumb(product, 'product-thumb')}
          <div>
            <h3>${product.code ? `${esc(product.code)} · ` : ''}${esc(product.name)}</h3>
            <p class="price-line">${product.department ? `${esc(product.department)} · ` : ''}Costo ${money(product.costCents)}${Number(state.bcvRate) > 0 ? ` · ${moneyBs(bsCents(product.costCents))}` : ''} · Venta ${money(product.priceCents)}${Number(state.bcvRate) > 0 ? ` · ${moneyBs(bsCents(product.priceCents))}` : ''} · ${product.active ? 'A la venta' : 'Inactivo'}</p>
            <p class="price-line">${product.unitsPerBox > 1 ? `Caja de ${product.unitsPerBox.toLocaleString('es-ES')} unidades · Venta por caja ${money(product.priceCents * product.unitsPerBox)} · ` : ''}${product.quickSale ? 'Búsqueda rápida · ' : ''}Utilidad ${money(product.profitCents)} por unidad · ${money(product.stockProfitCents)} en estas existencias</p>
          </div>
          <div class="row-actions">
            <input class="stock-add" type="number" min="1" max="100000" value="1" data-add-stock="${product.id}" aria-label="Cantidad a sumar de ${esc(product.name)}">
            <select class="pack-select" data-add-pack="${product.id}" aria-label="Sumar por unidad o por caja">
              <option value="unit">Unidad</option>
              <option value="box">Caja${product.unitsPerBox > 1 ? ` de ${product.unitsPerBox}` : ''}</option>
            </select>
            <button class="btn ghost small" type="button" data-action="add-stock" data-id="${product.id}">Sumar</button>
            <button class="btn ghost small" type="button" data-action="edit-product" data-id="${product.id}">Editar</button>
            <button class="btn ghost small" type="button" data-action="toggle-product" data-id="${product.id}" data-active="${product.active ? '1' : '0'}">${product.active ? 'Desactivar' : 'Activar'}</button>
            <button class="btn danger small" type="button" data-action="delete-product" data-id="${product.id}">Eliminar</button>
          </div>
        </article>`).join('')}</div>`;
}

function inventoryView() {
  const editing = state.editingProduct;
  const combo = state.editingCombo;
  const products = state.products.filter((product) => !product.isCombo);
  const combos = state.products.filter((product) => product.isCombo);
  const costValue = products.reduce((sum, product) => sum + product.stockCostCents, 0);
  const saleValue = products.reduce((sum, product) => sum + product.stockSaleCents, 0);
  const profitValue = products.reduce((sum, product) => sum + product.stockProfitCents, 0);
  const stockValue = editing ? String(editing.stock) : '';
  const costField = editing ? moneyInput(editing.costCents) : '';
  const priceValue = editing ? moneyInput(editing.priceCents) : '';
  const profitField = editing ? moneyInput(editing.profitCents) : '';
  const boxPriceValue = editing && editing.unitsPerBox > 1 ? moneyInput(editing.priceCents * editing.unitsPerBox) : '';
  return `
    <div class="stack">
      <form class="card product-form" data-form="product">
        <h2>${editing ? 'Editar producto' : 'Cargar producto'}</h2>
        <p class="lead page-lead">Si llega por caja, el costo que escribes es el de la caja y se divide entre las unidades. El precio de venta lo pones por unidad y por caja. En el visor se cobra la unidad.</p>
        <label class="field"><span>Código del producto</span><input name="code" maxlength="40" value="${esc(editing?.code || '')}" placeholder="Código"></label>
        <label class="field"><span>Nombre</span><input name="name" maxlength="80" required value="${esc(editing?.name || '')}" placeholder="Nombre del producto"></label>
        <label class="field"><span>Departamento</span><input name="department" maxlength="60" value="${esc(editing?.department || '')}" placeholder="Cerveza, ron, vino"></label>
        <label class="field"><span>Unidades por caja</span><input name="unitsPerBox" type="number" min="1" max="10000" value="${editing ? esc(String(editing.unitsPerBox || 1)) : ''}" placeholder="36"></label>
        ${editing ? '' : `<label class="field"><span>Cómo llega</span><select name="pack"><option value="unit">Por unidad</option><option value="box">Por caja</option></select></label>`}
        <div class="money-line">
          <label class="field"><span id="cost-label">${editing ? 'Costo por unidad' : 'Costo'}</span><input name="cost" inputmode="decimal" required value="${esc(costField)}" placeholder="0,00"></label>
          <label class="field"><span>Moneda del costo</span><select name="costCurrency" data-prev="usd"><option value="usd">Dólares</option><option value="bs">Bolívares</option></select></label>
        </div>
        <p class="hint" id="cost-convert">Elige la moneda y escribe el costo.</p>
        <label class="field"><span>Utilidad por unidad</span><input name="profit" inputmode="decimal" value="${esc(profitField)}" placeholder="0,00"></label>
        <div class="money-line">
          <label class="field"><span>Precio de venta por unidad</span><input name="price" inputmode="decimal" value="${esc(priceValue)}" placeholder="0,00"></label>
          <label class="field"><span>Moneda del precio</span><select name="priceCurrency" data-prev="usd"><option value="usd">Dólares</option><option value="bs">Bolívares</option></select></label>
        </div>
        <p class="hint" id="price-convert">Elige la moneda y escribe el precio de venta.</p>
        <label class="field" id="box-price-field" ${editing && editing.unitsPerBox > 1 ? '' : 'hidden'}><span>Precio de venta por caja</span><input name="boxPrice" inputmode="decimal" value="${esc(boxPriceValue)}" placeholder="0,00"></label>
        <p class="hint" id="product-profit">Escribe el costo y el precio de venta para ver la utilidad por unidad.</p>
        <label class="field"><span id="stock-label">${editing ? 'Existencias en unidades' : 'Existencias'}</span><input name="stock" type="number" min="0" max="1000000" required value="${esc(stockValue)}" placeholder="0"></label>
        <p class="hint" id="pack-hint">${editing ? 'Al editar, el costo y el precio son por unidad. Para meter cajas usa Sumar.' : 'Si marcas por caja, el costo de la caja se divide entre las unidades.'}</p>
        <label class="field"><span>Imagen</span><input name="image" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></label>
        ${editing?.imageUrl ? productThumb(editing, 'product-preview') : ''}
        <label class="check"><input name="quickSale" type="checkbox" ${editing?.quickSale ? 'checked' : ''}><span>Mostrar en la búsqueda rápida de venta</span></label>
        <label class="check"><input name="active" type="checkbox" ${editing ? (editing.active ? 'checked' : '') : 'checked'}><span>Disponible para vender en el visor</span></label>
        <p class="form-error" hidden></p>
        <div class="row-actions">
          <button class="btn primary" type="submit">${editing ? 'Guardar cambios' : 'Agregar al inventario'}</button>
          ${editing ? '<button class="btn ghost" type="button" data-action="cancel-product">Cancelar</button>' : ''}
        </div>
      </form>
      <section>
        <h2>Inventario</h2>
        <p class="lead page-lead">Estos números salen de los productos que cargues. Al facturar en un QR, se restan las existencias.</p>
        <div class="grid-stats thirds">
          <article class="stat"><p class="stat-label">Costo del inventario</p><p class="stat-value">${money(costValue)}</p></article>
          <article class="stat"><p class="stat-label">Valor de venta</p><p class="stat-value">${money(saleValue)}</p></article>
          <article class="stat"><p class="stat-label">Utilidad</p><p class="stat-value">${money(profitValue)}</p></article>
        </div>
        <label class="field"><span>Buscar</span><input id="inventory-search" type="search" placeholder="Escribe el nombre del producto" autocomplete="off" value="${esc(state.inventoryQuery || '')}"></label>
        <div id="inventory-board">${productListHtml()}</div>
      </section>
      <section>
        <form class="card product-form" data-form="combo">
          <h2>${combo ? 'Editar combo' : 'Crear combo'}</h2>
          <p class="lead page-lead">Elige productos y cuántas unidades lleva cada uno. Si le pones el código de un producto, en la venta ese producto deja elegir este combo.</p>
          <label class="field"><span>Nombre del combo</span><input name="name" maxlength="80" required value="${esc(combo?.name || '')}" placeholder="Balde de cerveza"></label>
          <label class="field"><span>Código del producto</span><select name="code">${productCodeOptions(combo?.code || '')}</select></label>
          <label class="field"><span>Precio de venta</span><input name="price" inputmode="decimal" required value="${esc(combo ? moneyInput(combo.priceCents) : '')}" placeholder="0,00"></label>
          <div class="cart-add">
            <label class="field"><span>Producto</span><select id="combo-product">${comboProductOptions()}</select></label>
            <label class="field"><span>Unidades en el combo</span><input id="combo-qty" type="number" min="1" max="500" value="1"></label>
          </div>
          <div class="row-actions">
            <button class="btn ghost" type="button" data-action="add-combo-part">Agregar al combo</button>
          </div>
          <div id="combo-parts">${comboPartRows()}</div>
          <p class="hint" id="combo-cost">${comboCostHint()}</p>
          <label class="check"><input name="payUsd" type="checkbox" ${combo ? (combo.payUsd ? 'checked' : '') : 'checked'}><span>Se cobra en dólares</span></label>
          <label class="check"><input name="payBs" type="checkbox" ${combo ? (combo.payBs ? 'checked' : '') : 'checked'}><span>Se cobra en bolívares</span></label>
          <label class="check"><input name="active" type="checkbox" ${combo ? (combo.active ? 'checked' : '') : 'checked'}><span>Disponible para vender</span></label>
          <p class="form-error" hidden></p>
          <div class="row-actions">
            <button class="btn primary" type="submit">${combo ? 'Guardar combo' : 'Crear combo'}</button>
            ${combo ? '<button class="btn ghost" type="button" data-action="cancel-combo">Cancelar</button>' : ''}
          </div>
        </form>
        <h2>Combos</h2>
        <p class="lead page-lead">El combo no tiene existencias propias. Alcanza para tantos como permitan los productos que lo componen.</p>
        <div id="combo-board">${comboBoardHtml(combos)}</div>
      </section>
    </div>`;
}

function productCodeOptions(selected) {
  const codes = [];
  for (const product of state.products) {
    if (product.isCombo || !String(product.code || '').trim()) continue;
    if (codes.some((item) => sameCode(item, product.code))) continue;
    codes.push(product.code.trim());
  }
  if (selected && !codes.some((item) => sameCode(item, selected))) codes.push(String(selected).trim());
  const options = [`<option value="">Sin código de producto</option>`].concat(codes.map((code) => {
    const product = state.products.find((item) => !item.isCombo && sameCode(item.code, code));
    const label = product ? `${code} · ${product.name}` : code;
    return `<option value="${esc(code)}" ${sameCode(code, selected) ? 'selected' : ''}>${esc(label)}</option>`;
  }));
  return options.join('');
}

function comboProductOptions() {
  const singles = state.products.filter((product) => !product.isCombo && product.active);
  if (!singles.length) return '<option value="">Carga productos primero</option>';
  return singles.map((product) => `<option value="${product.id}">${esc(product.name)} · quedan ${product.stock.toLocaleString('es-ES')}</option>`).join('');
}

function comboPartRows() {
  if (!state.comboParts.length) return '<p class="hint">Todavía no agregas productos a este combo.</p>';
  return state.comboParts.map((part, index) => {
    const product = state.products.find((item) => item.id === part.productId);
    const label = part.quantity === 1 ? 'unidad' : 'unidades';
    return `<div class="balance"><div><strong>${esc(product?.name || 'Producto')}</strong><p class="hint">${part.quantity.toLocaleString('es-ES')} ${label} por combo</p></div><button class="btn ghost small" type="button" data-action="remove-combo-part" data-index="${index}">Quitar</button></div>`;
  }).join('');
}

function comboCostCents() {
  return state.comboParts.reduce((sum, part) => {
    const product = state.products.find((item) => item.id === part.productId);
    return sum + (product?.costCents || 0) * part.quantity;
  }, 0);
}

function comboCostHint() {
  if (!state.comboParts.length) return 'La utilidad se calcula con el costo de los productos que lleve el combo.';
  return `Costo de los productos: ${money(comboCostCents())}. El precio de venta lo pones tú.`;
}

function comboBoardHtml(combos) {
  const visible = combos.filter((item) => inventoryMatches(item.name));
  if (!combos.length) return '<div class="empty"><h3>Todavía no hay combos</h3><p class="lead">Crea uno cuando quieras vender varios productos juntos a un solo precio.</p></div>';
  if (!visible.length) return '<div class="empty"><h3>Ningún combo coincide</h3><p class="lead">Prueba con otro nombre.</p></div>';
  return comboListHtml(visible);
}

function comboListHtml(combos) {
  if (!combos.length) return '<div class="empty"><h3>Todavía no hay combos</h3><p class="lead">Crea uno cuando quieras vender varios productos juntos a un solo precio.</p></div>';
  return `<div class="event-list">${combos.map((item) => {
    const recipe = (item.parts || []).map((part) => `${part.quantity} ${esc(part.name)}`).join(' · ') || 'Sin productos';
    return `<article class="event-row ${item.active ? '' : 'inactive'}">
      <div>
        <h3>${item.code ? `${esc(item.code)} · ` : ''}${esc(item.name)}</h3>
        <p class="price-line">Venta ${money(item.priceCents)} · Costo ${money(item.costCents)} · Utilidad ${money(item.profitCents)} · ${[item.payUsd ? 'dólares' : '', item.payBs ? 'bolívares' : ''].filter(Boolean).join(' y ') || 'sin moneda'} · ${item.active ? 'A la venta' : 'Inactivo'}</p>
        <p class="price-line">${recipe}</p>
        <p class="hint">${item.stock > 0 ? `Alcanzan ${item.stock.toLocaleString('es-ES')} combos` : 'No alcanzan las unidades para vender uno'}</p>
      </div>
      <div class="row-actions">
        <button class="btn ghost small" type="button" data-action="edit-combo" data-id="${item.id}">Editar</button>
        <button class="btn ghost small" type="button" data-action="toggle-product" data-id="${item.id}" data-active="${item.active ? '1' : '0'}">${item.active ? 'Desactivar' : 'Activar'}</button>
        <button class="btn danger small" type="button" data-action="delete-combo" data-id="${item.id}">Eliminar</button>
      </div>
    </article>`;
  }).join('')}</div>`;
}

function refreshComboParts() {
  const box = document.getElementById('combo-parts');
  const hint = document.getElementById('combo-cost');
  if (box) box.innerHTML = comboPartRows();
  if (hint) hint.textContent = comboCostHint();
}

function balances(purchases) {
  const map = new Map();
  for (const purchase of purchases || []) {
    for (const item of purchase.items) {
      const current = map.get(item.productId) || { name: item.productName, bought: 0, delivered: 0 };
      current.bought += item.quantity;
      current.delivered += item.delivered;
      map.set(item.productId, current);
    }
  }
  return [...map.values()].map((row) => ({ ...row, left: row.bought - row.delivered }));
}

function accountPanel(ticket) {
  if (!ticket) return '';
  const rows = balances(ticket.purchases);
  const summary = rows.length
    ? rows.map((row) => `
        <div class="balance">
          <div>
            <strong>${esc(row.name)}</strong>
            <p class="hint">Compró ${row.bought} · Entregadas ${row.delivered} · Quedan ${row.left}</p>
          </div>
        </div>`).join('')
    : `<p class="hint">Este QR todavía no tiene compras.</p>`;
  const purchases = (ticket.purchases || []).map((purchase) => `
    <article class="purchase">
      <div class="row-actions">
        <strong>${purchase.refundedAt ? 'Devuelta' : money(purchase.totalCents)}</strong>
        ${purchase.refundedAt ? '<span class="hint">Factura cancelada</span>' : `<select data-pay="${purchase.id}" aria-label="Método de pago">${paymentOptions(purchase.paymentMethod)}</select>`}
      </div>
      ${purchase.items.map((item) => purchase.refundedAt ? `
        <div class="balance"><div><strong>${esc(item.productName)}</strong><p class="hint">${item.quantity} devueltas · ${money(item.totalCents)}</p></div></div>` : `
        <button class="sale-hit" type="button" data-action="open-sheet" data-id="${item.id}">
          <strong>${esc(item.productName)}</strong>
          <span>${item.quantity} vendidas · ${money(item.totalCents)} · Entregadas ${item.delivered} · Quedan ${item.remaining}</span>
        </button>`).join('')}
    </article>`).join('');
  return `
    <section class="card" style="margin-bottom:16px">
      <div class="row-actions" style="margin-bottom:8px">
        <h3>Cuenta de ${esc(ticket.code)}</h3>
        ${ticket.status === 'expired' ? '' : '<button class="btn amber small" type="button" data-action="open-buy">Agregar compra</button>'}
      </div>
      <p class="hint" style="margin-bottom:10px">${esc(ticket.eventName)}. Facturar descuenta el inventario. Entregar no puede pasar de lo comprado.</p>
      ${summary}
      ${purchases}
    </section>`;
}

function renderAccount() {
  const box = document.getElementById('visor-account');
  if (box) box.innerHTML = accountPanel(state.currentTicket);
}

function buyMatches(query) {
  const text = query.trim().toLocaleLowerCase('es');
  const selling = currentPath() === '/panel/venta';
  return state.products
    .filter((product) => product.active)
    .filter((product) => !selling || acceptsCurrency(product))
    .filter((product) => !linkedCombo(product))
    .filter((product) => !text || [product.name, product.code].some((value) => String(value || '').toLocaleLowerCase('es').includes(text)))
    .slice(0, 20);
}

function reservedUnits(productId) {
  let units = 0;
  for (const line of state.cart) {
    const item = state.products.find((product) => product.id === line.productId);
    if (!item) continue;
    if (item.isCombo) {
      for (const part of item.parts || []) {
        if (part.productId === productId) units += part.quantity * line.quantity;
      }
    } else if (item.id === productId) {
      units += line.quantity;
    }
  }
  return units;
}

function buyResultsHtml(query) {
  if (!state.products.some((product) => product.active)) return `<p class="hint">El inventario está vacío. Carga productos antes de vender.</p>`;
  const matches = buyMatches(query);
  if (!matches.length) return `<p class="hint">Ningún producto coincide.</p>`;
  return matches.map((product) => {
    const choices = combosForProduct(product);
    const recipe = product.isCombo ? (product.parts || []).map((part) => `${part.quantity} ${part.name}`).join(' · ') : '';
    const stock = product.stock < 1
      ? (product.isCombo ? 'faltan unidades' : 'sin existencias')
      : (product.isCombo ? `alcanzan ${product.stock}` : `quedan ${product.stock}`);
    const canSell = product.stock > 0 || choices.some((item) => item.stock > 0);
    const comboText = choices.length ? ` · ${choices.length} ${choices.length === 1 ? 'combo' : 'combos'}` : '';
    return `
    <button class="buy-hit" type="button" data-action="${choices.length ? 'open-sale-choice' : 'pick-product'}" data-id="${product.id}" ${canSell ? '' : 'disabled'}>
      ${productThumb(product, 'choice-thumb')}
      <strong>${product.isCombo ? 'Combo · ' : ''}${esc(product.name)}</strong>
      <span>${displayMoney(product.priceCents)} · ${stock}${comboText}${recipe ? ` · ${esc(recipe)}` : ''}</span>
    </button>`;
  }).join('');
}

function quickSaleHtml() {
  const products = state.products.filter((product) => product.quickSale && product.active && !product.isCombo && acceptsCurrency(product));
  if (!products.length) return '<p class="hint">En inventario marca los productos que quieres ver aquí y ponles una imagen.</p>';
  return `<div class="quick-grid">${products.map((product) => {
    const choices = combosForProduct(product);
    const canSell = product.stock > 0 || choices.some((item) => item.stock > 0);
    return `
      <button class="quick-tile" type="button" data-action="${choices.length ? 'open-sale-choice' : 'pick-product'}" data-id="${product.id}" ${canSell ? '' : 'disabled'}>
        ${productThumb(product, 'quick-photo')}
        <strong>${esc(product.name)}</strong>
        <span>${displayMoney(product.priceCents)}${choices.length ? ` · ${choices.length} combos` : ''}</span>
      </button>`;
  }).join('')}</div>`;
}

function saleChoiceModal(product) {
  const choices = [product, ...combosForProduct(product)];
  return `
    <div class="modal-back" data-action="close-choice">
      <article class="modal card" data-stop data-modal="sale-choice">
        <h2>${esc(product.name)}</h2>
        <p class="hint">Código ${esc(product.code)}. Elige la unidad o uno de sus combos.</p>
        <div class="choice-list">
          ${choices.map((item) => {
            const recipe = item.isCombo ? (item.parts || []).map((part) => `${part.quantity} ${part.name}`).join(' · ') : '';
            return `
            <button class="choice-hit" type="button" data-action="pick-product" data-id="${item.id}" ${item.stock < 1 ? 'disabled' : ''}>
              ${productThumb(item, 'choice-thumb')}
              <span>
                <strong>${item.isCombo ? 'Combo · ' : 'Unidad · '}${esc(item.name)}</strong>
                <small>${displayMoney(item.priceCents)}${recipe ? ` · ${esc(recipe)}` : ''}</small>
              </span>
            </button>`;
          }).join('')}
        </div>
        <button class="btn ghost" type="button" data-action="close-choice">Cancelar</button>
      </article>
    </div>`;
}

function cartLinesHtml() {
  if (!state.cart.length) return `<p class="hint">Todavía no agregas productos a esta compra.</p>`;
  return state.cart.map((line) => `
    <div class="balance">
      <div><strong>${esc(line.name)}</strong><p class="hint">${line.quantity} · ${displayMoney(line.priceCents * line.quantity)}</p></div>
      <button class="btn ghost small" type="button" data-action="remove-cart" data-id="${line.productId}">Quitar</button>
    </div>`).join('');
}

function refreshBuyCart() {
  const lines = document.getElementById('buy-lines');
  const total = document.getElementById('buy-total');
  const button = document.querySelector('[data-action="confirm-purchase"]');
  if (lines) lines.innerHTML = cartLinesHtml();
  if (total) total.textContent = money(state.cart.reduce((sum, line) => sum + line.priceCents * line.quantity, 0));
  if (button) button.disabled = state.cart.length === 0;
}

function mountModal(html) {
  document.querySelector('.modal-back')?.remove();
  const host = document.querySelector('.shell') || document.body;
  host.insertAdjacentHTML('beforeend', html);
}

function buyModal() {
  return `
    <div class="modal-back" data-action="close-buy">
      <article class="modal card wide" data-stop>
        <p class="stub-kicker">${esc(state.currentTicket?.code || '')}</p>
        <h2 style="font-size:36px">Nueva compra</h2>
        <p class="lead page-lead">Busca un producto o un combo. Al registrar, se cobra el precio elegido y, si es un combo, se restan las unidades de cada producto.</p>
        <div class="cart-add">
          <label class="field"><span>Buscar producto</span><input id="buy-search" type="search" placeholder="Escribe y aparecen los productos" autocomplete="off"></label>
          <label class="field"><span>Cantidad</span><input id="buy-qty" type="number" min="1" max="500" value="1"></label>
        </div>
        <div id="buy-results" class="buy-results">${buyResultsHtml('')}</div>
        <div id="buy-lines">${cartLinesHtml()}</div>
        <div class="total-box"><span>Total</span><strong id="buy-total">${money(0)}</strong></div>
        <label class="field"><span>Método de pago</span><select id="pay-method">${paymentOptions('efectivo')}</select></label>
        <div class="row-actions">
          <button class="btn primary" type="button" data-action="confirm-purchase" disabled>Registrar compra</button>
          <button class="btn ghost" type="button" data-action="close-buy">Cancelar</button>
        </div>
      </article>
    </div>`;
}

function supplierOptions() {
  if (!state.suppliers.length) return '<option value="">Primero agrega un proveedor</option>';
  return state.suppliers.map((supplier) => `<option value="${supplier.id}">${esc(supplier.name)}</option>`).join('');
}

function linePerBox(line) {
  const perBox = Number(line.unitsPerBox) || 1;
  return perBox >= 2 ? perBox : 1;
}

function lineUnits(line) {
  const quantity = Number(line.quantity);
  const perBox = linePerBox(line);
  if (!Number.isInteger(quantity) || quantity < 1) return null;
  const units = perBox >= 2 ? quantity * perBox : quantity;
  if (units > 1000000) return null;
  return units;
}

function lineCostCents(line) {
  const quantity = Number(line.quantity);
  const cost = centsFromInput(line.cost);
  if (!Number.isInteger(quantity) || quantity < 1 || cost == null) return null;
  return quantity * cost;
}

function purchaseUnitCost(line) {
  const cost = centsFromInput(line.cost);
  if (cost == null) return null;
  const perBox = linePerBox(line);
  return perBox >= 2 ? Math.round(cost / perBox) : cost;
}

function lineArriveText(line) {
  const units = lineUnits(line);
  const perBox = linePerBox(line);
  if (units == null) return 'Revisa la cantidad.';
  if (perBox >= 2) {
    const boxes = Number(line.quantity);
    const boxWord = boxes === 1 ? 'caja' : 'cajas';
    return `Llegan ${units.toLocaleString('es-ES')} unidades · ${boxes.toLocaleString('es-ES')} ${boxWord} × ${perBox.toLocaleString('es-ES')}`;
  }
  return `Llegan ${units.toLocaleString('es-ES')} ${units === 1 ? 'unidad' : 'unidades'}`;
}

function purchaseTotalCents() {
  return state.buyLines.reduce((sum, line) => sum + (lineCostCents(line) || 0), 0);
}

function purchaseLinesHtml() {
  if (!state.buyLines.length) return '<p class="hint">Busca un producto y selecciónalo. Puedes agregar varios a la misma factura.</p>';
  return state.buyLines.map((line) => {
    const cents = lineCostCents(line);
    const boxed = linePerBox(line) >= 2;
    return `
    <div class="card purchase-line" data-line="${line.productId}">
      <div class="purchase-line-head">
        <strong>${esc(line.name)}</strong>
        <span data-line-total>${cents == null ? 'Revisa cantidad y costo' : money(cents)}</span>
      </div>
      <p class="hint" data-line-arrive>${esc(lineArriveText(line))}</p>
      <div class="purchase-fields">
        <label class="field"><span>${boxed ? 'Cajas' : 'Cantidad'}</span><input data-field="quantity" type="number" min="1" value="${esc(line.quantity)}"></label>
        <label class="field"><span>${boxed ? 'Costo por caja' : 'Costo por unidad'}</span><input data-field="cost" inputmode="decimal" value="${esc(line.cost)}"></label>
        <label class="field"><span>Utilidad por unidad</span><input data-field="profit" inputmode="decimal" value="${esc(line.profit)}"></label>
        <label class="field"><span>Precio de venta por unidad</span><input data-field="price" inputmode="decimal" value="${esc(line.price)}"></label>
      </div>
      <p class="hint" data-line-math>${cents == null ? '' : `${esc(line.quantity)} × ${esc(line.cost)} $`}</p>
      <button class="btn ghost small" type="button" data-action="remove-buy-line" data-id="${line.productId}">Quitar</button>
    </div>`;
  }).join('');
}

function purchaseTotalHtml() {
  const count = state.buyLines.length;
  const label = count ? `${count} ${count === 1 ? 'producto' : 'productos'}` : 'Total de la factura';
  return `<div class="total-box" id="purchase-total"><span>${label}</span><strong>${money(purchaseTotalCents())}</strong></div>`;
}

function refreshPurchaseTotals() {
  for (const line of state.buyLines) {
    const row = document.querySelector(`#purchase-lines [data-line="${line.productId}"]`);
    if (!row) continue;
    const cents = lineCostCents(line);
    const total = row.querySelector('[data-line-total]');
    const math = row.querySelector('[data-line-math]');
    const arrive = row.querySelector('[data-line-arrive]');
    if (total) total.textContent = cents == null ? 'Revisa cantidad y costo' : money(cents);
    if (math) math.textContent = cents == null ? '' : `${line.quantity} × ${line.cost} $`;
    if (arrive) arrive.textContent = lineArriveText(line);
  }
  const box = document.getElementById('purchase-total');
  if (!box) return;
  const count = state.buyLines.length;
  const label = box.querySelector('span');
  const strong = box.querySelector('strong');
  if (label) label.textContent = count ? `${count} ${count === 1 ? 'producto' : 'productos'}` : 'Total de la factura';
  if (strong) strong.textContent = money(purchaseTotalCents());
}

function addPurchaseProduct(product) {
  if (!product) return;
  const current = state.buyLines.find((line) => line.productId === product.id);
  if (current) {
    const quantity = Number(current.quantity);
    current.quantity = String((Number.isInteger(quantity) && quantity >= 1 ? quantity : 0) + 1);
    const row = document.querySelector(`#purchase-lines [data-line="${product.id}"] [data-field="quantity"]`);
    if (row) row.value = current.quantity;
    refreshPurchaseTotals();
    toast(`Se sumó otra unidad de ${product.name}.`);
    return;
  }
  const perBox = Number(product.unitsPerBox) >= 2 ? Number(product.unitsPerBox) : 1;
  const profit = product.priceCents - product.costCents;
  state.buyLines.push({
    productId: product.id,
    name: product.name,
    unitsPerBox: perBox,
    quantity: '1',
    cost: moneyInput(perBox >= 2 ? product.costCents * perBox : product.costCents),
    profit: moneyInput(profit),
    price: moneyInput(product.priceCents),
  });
  const board = document.getElementById('purchase-lines');
  if (board) board.innerHTML = purchaseLinesHtml();
  refreshPurchaseTotals();
}

function purchaseHistoryHtml() {
  if (!state.supplierPurchases.length) return '<p class="hint">Todavía no hay compras cargadas.</p>';
  return `<div class="event-list">${state.supplierPurchases.map((purchase) => `
    <article class="event-row">
      <div>
        <h3>${esc(purchase.supplierName)}</h3>
        <p class="price-line">Factura ${esc(purchase.invoiceDate)} · Carga ${formatDateTime(purchase.loadedAt)} · ${esc(paymentLabel(purchase.paymentMethod))}${purchase.dueDate ? ` · Vence ${esc(purchase.dueDate)}` : ''}</p>
        <p class="hint">${purchase.items.map((item) => item.packCount
          ? `${item.packCount} cajas de ${esc(item.productName)} · llegan ${item.quantity.toLocaleString('es-ES')} unidades · ${money(item.totalCents)}`
          : `${item.quantity} ${esc(item.productName)} · ${money(item.totalCents)}`).join(' · ')}</p>
      </div>
      <strong>${money(purchase.totalCents)}</strong>
    </article>`).join('')}</div>`;
}

function comprasView() {
  return `
    <h2>Compras</h2>
    <p class="lead page-lead">Aquí entran las facturas de los proveedores. La fecha de carga queda registrada al guardar y las existencias suben en ese momento.</p>
    <div class="row-actions no-print" style="margin-bottom:12px">
      <button class="btn ghost" type="button" data-action="toggle-supplier">${state.supplierOpen ? 'Cerrar proveedor' : 'Agregar proveedor'}</button>
    </div>
    ${state.supplierOpen ? `
      <form class="card" data-form="supplier" style="margin-bottom:16px">
        <h3>Proveedor</h3>
        <label class="field"><span>Nombre</span><input name="name" maxlength="80" required placeholder="Nombre del proveedor"></label>
        <div class="cart-add">
          <label class="field"><span>Documento</span><input name="document" maxlength="40" placeholder="RIF o cédula"></label>
          <label class="field"><span>Teléfono</span><input name="phone" maxlength="40" placeholder="Teléfono"></label>
        </div>
        <label class="field"><span>Correo</span><input name="email" maxlength="80" placeholder="Correo"></label>
        <label class="field"><span>Dirección</span><input name="address" maxlength="160" placeholder="Dirección"></label>
        <label class="field"><span>Notas</span><input name="notes" maxlength="240" placeholder="Notas"></label>
        <p class="form-error" hidden></p>
        <button class="btn primary" type="submit">Guardar proveedor</button>
      </form>` : ''}
    <div class="pos-grid">
      <form class="card" data-form="supplier-purchase">
        <label class="field"><span>Proveedor</span><select name="supplierId" required>${supplierOptions()}</select></label>
        <div class="cart-add">
          <label class="field"><span>Fecha de factura</span><input name="invoiceDate" type="date" required value="${todayInput()}"></label>
          <label class="field"><span>Fecha de carga</span><input value="${esc(formatDateTime(new Date().toISOString()))}" disabled></label>
          <label class="field"><span>Vencimiento</span><input name="dueDate" type="date"></label>
        </div>
        <label class="field"><span>Método de pago</span><select name="paymentMethod">${paymentOptions('efectivo')}</select></label>
        <label class="field"><span>Buscar producto</span><input id="purchase-search" type="search" placeholder="Código o nombre. Puedes agregar varios." autocomplete="off"></label>
        <p class="hint">Elige uno y sigue buscando. Si el producto viene por caja, la cantidad son cajas y el inventario recibe todas las unidades.</p>
        <div id="purchase-results" class="buy-results"></div>
        <div id="purchase-lines">${purchaseLinesHtml()}</div>
        ${purchaseTotalHtml()}
        <p class="form-error" hidden></p>
        <button class="btn primary" type="submit">Guardar compra</button>
      </form>
      <section class="card">
        <h3>Últimas compras</h3>
        <div style="margin-top:12px">${purchaseHistoryHtml()}</div>
      </section>
    </div>`;
}

function purchaseMatches(query) {
  const text = query.trim().toLocaleLowerCase('es');
  return state.products
    .filter((product) => !product.isCombo)
    .filter((product) => !text || [product.name, product.code, product.department].some((value) => String(value || '').toLocaleLowerCase('es').includes(text)))
    .slice(0, 12);
}

function purchaseResultsHtml(query) {
  const matches = purchaseMatches(query);
  if (!query.trim()) return '';
  if (!matches.length) return '<p class="hint">Ningún producto coincide.</p>';
  return matches.map((product) => `
    <button class="buy-hit" type="button" data-action="pick-purchase" data-id="${product.id}">
      <strong>${product.code ? `${esc(product.code)} · ` : ''}${esc(product.name)}</strong>
      <span>${product.unitsPerBox > 1 ? `Caja de ${product.unitsPerBox} · ` : ''}Costo ${money(product.costCents)} · Venta ${money(product.priceCents)} · quedan ${product.stock}</span>
    </button>`).join('');
}

function stockBoardHtml() {
  const query = state.inventoryQuery || '';
  const matches = purchaseMatches(query);
  if (!query.trim()) return '<p class="hint">Escribe el código o el nombre para cargar o descargar.</p>';
  if (!matches.length) return '<p class="hint">Ningún producto coincide.</p>';
  return matches.map((product) => `
    <article class="event-row">
      <div>
        <h3>${product.code ? `${esc(product.code)} · ` : ''}${esc(product.name)}</h3>
        <p class="price-line">Quedan ${product.stock.toLocaleString('es-ES')}</p>
      </div>
      <div class="row-actions">
        <input class="stock-add" type="number" min="1" value="1" data-stock-qty="${product.id}" aria-label="Cantidad">
        <button class="btn primary small" type="button" data-action="stock-move" data-direction="carga" data-id="${product.id}">Cargar</button>
        <button class="btn ghost small" type="button" data-action="stock-move" data-direction="descarga" data-id="${product.id}">Descargar</button>
      </div>
    </article>`).join('');
}

function cargasView() {
  return `
    <h2>Cargas y descargas</h2>
    <p class="lead page-lead">Busca el producto y suma existencias con una carga, o réstalas con una descarga.</p>
    <section class="card">
      <label class="field"><span>Buscar</span><input id="stock-search" type="search" placeholder="Código o nombre" autocomplete="off" value="${esc(state.inventoryQuery || '')}"></label>
      <div id="stock-board" class="event-list">${stockBoardHtml()}</div>
    </section>`;
}

function gastosView() {
  const rows = state.expenses.length
    ? `<div class="event-list">${state.expenses.map((expense) => `
        <article class="event-row">
          <div>
            <h3>${esc(expense.description)}</h3>
            <p class="price-line">${esc(expense.spentAt.slice(0, 10))} · ${expense.currency === 'bs' ? 'Bolívares' : 'Dólares'}${expense.note ? ` · ${esc(expense.note)}` : ''}</p>
          </div>
          <strong>${expense.currency === 'bs' ? moneyBs(expense.amountCents) : money(expense.amountCents)}</strong>
        </article>`).join('')}</div>`
    : '<p class="hint">No hay gastos en este periodo.</p>';
  return `
    <h2>Gastos</h2>
    <p class="lead page-lead">Estos gastos entran al resumen del mismo periodo, al lado de las ventas.</p>
    <form class="card" data-form="expense" style="margin-bottom:16px">
      <label class="field"><span>Gasto</span><input name="description" maxlength="120" required placeholder="Alquiler, luz, flete"></label>
      <div class="cart-add">
        <label class="field"><span>Monto</span><input name="amount" inputmode="decimal" required placeholder="0,00"></label>
        <label class="field"><span>Moneda</span><select name="currency"><option value="usd">Dólares</option><option value="bs">Bolívares</option></select></label>
        <label class="field"><span>Fecha</span><input name="date" type="date" required value="${todayInput()}"></label>
      </div>
      <label class="field"><span>Nota</span><input name="note" maxlength="240" placeholder="Opcional"></label>
      <p class="form-error" hidden></p>
      <button class="btn primary" type="submit">Anotar gasto</button>
    </form>
    <section class="card">${rows}</section>`;
}

function posView() {
  if (state.issuedSale) return issuedSaleView(state.issuedSale);
  const total = state.cart.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
  const rateText = Number(state.bcvRate) > 0 ? Number(state.bcvRate).toLocaleString('es-VE', { maximumFractionDigits: 4 }) : '';
  return `
    <h2>Venta</h2>
    <p class="lead page-lead">Arma la cuenta, cobra y entrega el QR. Quien lo escanee ve la factura al momento.</p>
    <section class="card" style="margin-bottom:16px">
      <div class="cart-add">
        <label class="field"><span>Tasa BCV</span><input id="bcv-rate" inputmode="decimal" value="${esc(rateText)}" placeholder="Ejemplo: 45,50"></label>
        <label class="field"><span>Cobrar en</span>
          <select id="pos-currency">
            <option value="usd" ${state.saleCurrency === 'usd' ? 'selected' : ''}>Dólares</option>
            <option value="bs" ${state.saleCurrency === 'bs' ? 'selected' : ''}>Bolívares</option>
          </select>
        </label>
      </div>
      <button class="btn ghost" type="button" data-action="save-rate">Guardar tasa</button>
      <p class="hint">El precio en bolívares es el precio en dólares multiplicado por esta tasa. Un combo solo aparece en las monedas que tenga marcadas.</p>
    </section>
    <div class="pos-grid">
      <section class="card">
        <label class="field"><span>Nombre del cliente</span><input id="pos-name" maxlength="80" placeholder="Nombre de quien compra" autocomplete="off" required></label>
        <label class="field"><span>Cédula</span><input id="pos-document" maxlength="20" placeholder="V-12345678" autocomplete="off" required></label>
        <label class="field"><span>Método de pago</span><select id="pos-pay">${paymentOptions('efectivo')}</select></label>
        <p class="hint">Búsqueda rápida</p>
        <div id="quick-sale">${quickSaleHtml()}</div>
        <div class="cart-add">
          <label class="field"><span>Producto</span><input id="pos-search" type="search" placeholder="Escribe el producto. Si tiene combos, eliges cuál vender." autocomplete="off"></label>
          <label class="field"><span>Cantidad</span><input id="pos-qty" type="number" min="1" max="500" value="1"></label>
        </div>
        <div id="pos-results" class="buy-results">${buyResultsHtml('')}</div>
        <label class="field"><span>Comprobante, opcional</span><input id="pos-file" type="file" accept="image/*,.pdf"></label>
      </section>
      <section class="card">
        <h3>Cuenta</h3>
        <div id="pos-lines">${cartLinesHtml()}</div>
        <div class="total-box"><span>Total</span><strong id="pos-total">${displayMoney(total)}</strong></div>
        <button class="btn primary" type="button" data-action="charge-sale" ${state.cart.length ? '' : 'disabled'}>Cobrar y emitir QR</button>
        <p class="hint">Al cobrar escribes el número de referencia y después eliges si pasa a barra o es venta al detal.</p>
      </section>
    </div>`;
}

function issuedSaleView(sale) {
  const lines = (sale.items || []).map((item) => `<p>${item.quantity} ${esc(item.productName)} · ${money(item.totalCents)}</p>`).join('');
  return `
    <div class="row-actions no-print" style="margin-bottom:12px">
      <button class="btn primary" type="button" data-action="print">Imprimir</button>
      <button class="btn ghost" type="button" data-action="new-sale">Nueva venta</button>
    </div>
    <article class="stub">
      <div class="stub-body">
        <p class="stub-kicker">${esc(negocio.name)}</p>
        <h3>${esc(sale.customerName)}</h3>
        <p class="price-line">Cédula ${esc(sale.customerDocument || '')}${sale.paymentReference ? ` · Ref. ${esc(sale.paymentReference)}` : ''}</p>
        <p class="code">Factura ${esc(sale.numberLabel)}</p>
        ${lines}
        <p class="price-line">${chargedTotal(sale)} · ${esc(paymentLabel(sale.paymentMethod))}${sale.currency === 'bs' && sale.bcvRate ? ` · tasa ${sale.bcvRate}` : ''}</p>
        <p class="hint">${sale.channel === 'detal' ? 'Venta al detal. Se entregó en el momento.' : 'Pasó a barra.'}</p>
        <p class="hint">${esc(formatDateTime(sale.createdAt))}</p>
      </div>
      <div class="stub-qr"><img alt="QR de la factura ${esc(sale.numberLabel)}" src="${sale.qrDataUrl}"></div>
    </article>`;
}

function refreshPosCart() {
  const lines = document.getElementById('pos-lines');
  const total = document.getElementById('pos-total');
  const button = document.querySelector('[data-action="charge-sale"]');
  if (lines) lines.innerHTML = cartLinesHtml();
  if (total) total.textContent = displayMoney(state.cart.reduce((sum, line) => sum + line.priceCents * line.quantity, 0));
  if (button) button.disabled = state.cart.length === 0;
}

function customerDocumentValue(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function validCustomerDocument(value) {
  return /^[A-Z]{0,2}-?\d{5,12}$/.test(customerDocumentValue(value));
}

function validPaymentReference(value) {
  return /^[A-Za-z0-9-]{4,40}$/.test(String(value || '').trim().replace(/\s+/g, ''));
}

function channelModal(name, documentId) {
  return `
    <div class="modal-back" data-modal="channel" data-action="close-channel">
      <article class="modal card" data-stop>
        <p class="stub-kicker">Confirmar factura</p>
        <h2>Número de referencia</h2>
        <p class="lead page-lead">La cuenta de ${esc(name)}, cédula ${esc(documentId)}, ya está lista.</p>
        <label class="field"><span>Nro. de referencia</span><input id="sale-reference" inputmode="numeric" maxlength="40" autocomplete="off" placeholder="Referencia del pago"></label>
        <h2 style="margin-top:8px">¿A dónde pasa esta venta?</h2>
        <div class="channel-actions">
          <button class="btn primary" type="button" data-action="confirm-channel" data-channel="barra">Pasar a barra</button>
          <button class="btn amber" type="button" data-action="confirm-channel" data-channel="detal">Venta al detal</button>
        </div>
        <p class="hint">Primero el número de referencia. Barra avisa a quien tenga ese módulo. Venta al detal se entrega en el momento y no entra a barra.</p>
        <div class="row-actions" style="margin-top:12px">
          <button class="btn ghost" type="button" data-action="close-channel">Cancelar</button>
        </div>
      </article>
    </div>`;
}

function noticeKey() {
  return `ad-notice-${state.user?.id || 0}`;
}

function noticeCursor() {
  return Number(sessionStorage.getItem(noticeKey()) || 0);
}

function setNoticeCursor(id) {
  const next = Math.max(noticeCursor(), Number(id) || 0);
  sessionStorage.setItem(noticeKey(), String(next));
}

function stopNotices() {
  if (noticeTimer) clearInterval(noticeTimer);
  noticeTimer = 0;
}

function unlockSound() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  audioCtx = audioCtx || new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

function playOrderSound() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  audioCtx = audioCtx || new Ctx();
  const ring = () => {
    const now = audioCtx.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, index) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const at = now + index * 0.14;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(at);
      osc.stop(at + 0.42);
    });
  };
  if (audioCtx.state === 'suspended') audioCtx.resume().then(ring).catch(() => {});
  else ring();
}

function renderOrderAlerts() {
  let host = document.getElementById('order-alerts');
  if (!state.orderAlerts.length) {
    host?.remove();
    return;
  }
  if (!host) {
    host = document.createElement('div');
    host.id = 'order-alerts';
    document.body.appendChild(host);
  }
  host.innerHTML = state.orderAlerts.map((notice) => {
    const items = (notice.items || []).map((item) => `${item.quantity} ${esc(item.productName)}`).join(' · ');
    return `
      <article class="order-alert" data-stop>
        <p class="stub-kicker">Factura ${esc(notice.numberLabel)}</p>
        <h2>Pedido nuevo</h2>
        <p class="order-who">${esc(notice.customerName)}</p>
        <p class="hint">${esc(notice.customerDocument || '')}${notice.paymentReference ? ` · Ref. ${esc(notice.paymentReference)}` : ''}</p>
        <p class="order-items">${esc(items)}</p>
        <p class="price-line">${chargedTotal(notice)}</p>
        <div class="row-actions">
          <button class="btn primary small" type="button" data-action="open-notice" data-id="${notice.id}">Abrir en barra</button>
          <button class="btn ghost small" type="button" data-action="dismiss-notice" data-id="${notice.id}">Ocultar</button>
        </div>
      </article>`;
  }).join('');
}

function showNotices(notices) {
  let added = false;
  for (const notice of notices) {
    if (notice.id === state.skipNoticeId) continue;
    if (state.orderAlerts.some((item) => item.id === notice.id)) continue;
    state.orderAlerts.unshift(notice);
    added = true;
  }
  state.orderAlerts = state.orderAlerts.slice(0, 3);
  if (!added) return;
  renderOrderAlerts();
  playOrderSound();
}

async function pullNotices() {
  if (!state.user || !allow('barra')) return;
  try {
    if (!sessionStorage.getItem(noticeKey())) {
      const data = await api('/api/notices/barra?bootstrap=1', { soft: true });
      sessionStorage.setItem(noticeKey(), String(data.latest || 0));
      return;
    }
    const data = await api(`/api/notices/barra?after=${noticeCursor()}`, { soft: true });
    const notices = data.notices || [];
    if (!notices.length) return;
    setNoticeCursor(notices[notices.length - 1].id);
    showNotices(notices);
    if (currentPath() === '/panel/barra') {
      const boardData = await api(`/api/invoices?q=${encodeURIComponent(state.barraQuery || '')}`, { soft: true });
      state.barra = boardData.sales || [];
      const board = document.getElementById('barra-board');
      if (board) board.innerHTML = barraBoardHtml();
    }
  } catch {
    // El aviso vuelve a intentarse en el siguiente ciclo.
  }
}

function watchBarraNotices() {
  if (!state.user || !allow('barra')) {
    stopNotices();
    return;
  }
  if (noticeTimer) return;
  pullNotices();
  noticeTimer = setInterval(pullNotices, 4000);
}

function barraView() {
  const canDetect = 'BarcodeDetector' in window;
  const canCamera = canDetect && navigator.mediaDevices?.getUserMedia;
  return `
    <h2>Barra</h2>
    <p class="lead page-lead">Escanea el QR o busca por nombre o número de factura. Elige los números y márcalos como entregados.</p>
    <section class="card">
      <label class="field"><span>Cliente o factura</span><input id="barra-search" type="search" placeholder="Nombre o número de factura" autocomplete="off" value="${esc(state.barraQuery || '')}"></label>
      <div class="row-actions">
        ${canCamera ? '<button class="btn ghost" type="button" data-action="camera">Escanear QR</button>' : ''}
        ${canDetect ? '<label class="btn ghost file-btn">Subir foto<input type="file" accept="image/*" data-file="qr"></label>' : ''}
      </div>
      ${canCamera ? `<div class="camera" id="camera-box" hidden><video id="cam" playsinline autoplay muted></video><button class="btn ghost" type="button" data-action="stop-camera">Detener cámara</button></div>` : `<p class="hint">Este navegador no lee la cámara. Escribe el nombre o el número de la factura.</p>`}
      <div id="barra-board">${barraBoardHtml()}</div>
    </section>`;
}

function barraBoardHtml() {
  if (!state.barra.length) {
    return `<div class="empty"><h3>${state.barraQuery ? 'Ninguna factura coincide' : 'Todavía no hay pedidos de barra'}</h3><p class="lead">${state.barraQuery ? 'Prueba con otro nombre o número.' : 'Cuando una venta pase a barra, aparece aquí.'}</p></div>`;
  }
  return state.barra.map((sale) => {
    const products = deliveryItems(sale).map((item) => `${item.remaining} de ${item.quantity} ${item.productName}`).join(' · ');
    const status = sale.refundedAt ? 'Devuelta' : paymentLabel(sale.paymentMethod);
    return `
      <button class="sale-hit" type="button" data-action="open-barra" data-id="${sale.id}">
        <strong>${esc(sale.customerName)} · ${esc(sale.numberLabel)}</strong>
        <span>${esc(products)} · ${money(sale.totalCents)} · ${esc(status)}</span>
      </button>`;
  }).join('');
}

function unitMarkup(number, delivered, at) {
  const time = delivered ? formatHour(at) : '';
  if (!time) return String(number);
  return `<span class="unit-n">${number}</span><span class="unit-time">${esc(time)}</span>`;
}

function invoiceUnits(item, interactive) {
  const done = new Set(item.deliveredUnits || []);
  const picked = new Set(state.barraPicks[item.id] || []);
  const times = item.deliveredAt || {};
  let html = '';
  for (let number = 1; number <= item.quantity; number += 1) {
    const delivered = done.has(number);
    const selected = picked.has(number);
    const face = unitMarkup(number, delivered, times[number]);
    const timed = delivered && times[number] ? ' has-time' : '';
    if (!interactive) {
      html += `<span class="unit ${delivered ? 'done' : 'free'}${timed}">${face}</span>`;
      continue;
    }
    html += `<button class="unit ${delivered ? 'done' : selected ? 'pick' : 'free'}${timed}" type="button" data-action="toggle-invoice-unit" data-item="${item.id}" data-n="${number}" ${delivered ? 'disabled' : ''}>${face}</button>`;
  }
  return html;
}

function barraLinesHtml(sale, interactive) {
  return deliveryItems(sale).map((item) => {
    const open = item.parts?.length
      ? item.parts.map((part) => `${part.quantity * item.quantity} ${part.name}`).join(', ')
      : '';
    const split = interactive && !sale.refundedAt && item.canSplit
      ? `<button class="btn ghost small" type="button" data-action="split-invoice-item" data-id="${sale.id}" data-item="${item.id}">Desglosar</button>`
      : '';
    return `
    <section class="paper" style="margin-top:12px">
      <p class="paper-kicker">${esc(item.productName)}</p>
      <p class="hint">${item.quantity} en la factura · Entregadas ${item.delivered} · Quedan ${item.remaining}</p>
      ${open ? `<p class="hint">Al desglosar queda en ${esc(open)}.</p>` : ''}
      <div class="unit-grid">${invoiceUnits(item, interactive && !sale.refundedAt)}</div>
      ${split ? `<div class="row-actions" style="margin-top:10px">${split}</div>` : ''}
    </section>`;
  }).join('');
}

function barraModal() {
  const sale = state.barraSale;
  if (!sale) return '';
  const picked = Object.values(state.barraPicks).reduce((sum, list) => sum + list.length, 0);
  const deliver = !sale.refundedAt && picked
    ? `<button class="btn primary" type="button" data-action="deliver-invoice" data-id="${sale.id}">${picked === 1 ? 'Entregado' : `Entregar ${picked}`}</button>`
    : '';
  const refund = sale.refundedAt
    ? '<p class="hint">Esta factura ya fue devuelta. Las cantidades volvieron al inventario.</p>'
    : `<button class="btn danger" type="button" data-action="refund-invoice" data-id="${sale.id}">Devolver factura</button>`;
  return `
    <div class="modal-back" data-action="close-barra">
      <article class="modal card wide sheet-modal" data-stop>
        <p class="stub-kicker">Factura ${esc(sale.numberLabel)}</p>
        <h2 style="font-size:36px">${esc(sale.customerName)}</h2>
        <p class="hint">${sale.customerDocument ? `Cédula ${esc(sale.customerDocument)}` : ''}${sale.paymentReference ? ` · Ref. ${esc(sale.paymentReference)}` : ''}</p>
        <p class="price-line">${sale.refundedAt ? 'Devuelta' : money(sale.totalCents)} · ${esc(paymentLabel(sale.paymentMethod))}</p>
        <div id="barra-lines">${barraLinesHtml(sale, true)}</div>
        <div class="sheet-legend">
          <span><i class="legend-dot free"></i> Disponible</span>
          <span><i class="legend-dot pick"></i> Seleccionado</span>
          <span><i class="legend-dot done"></i> Entregado</span>
        </div>
        <div class="row-actions" id="barra-actions" style="margin-top:12px">
          ${deliver}
          ${refund}
          <button class="btn ghost" type="button" data-action="close-barra">Cerrar</button>
        </div>
      </article>
    </div>`;
}

function paintBarraModal() {
  const sale = state.barraSale;
  const lines = document.getElementById('barra-lines');
  if (!sale || !lines) {
    mountModal(barraModal());
    return;
  }
  lines.innerHTML = barraLinesHtml(sale, true);
  const actions = document.getElementById('barra-actions');
  if (!actions) return;
  const picked = Object.values(state.barraPicks).reduce((sum, list) => sum + list.length, 0);
  const deliver = !sale.refundedAt && picked
    ? `<button class="btn primary" type="button" data-action="deliver-invoice" data-id="${sale.id}">${picked === 1 ? 'Entregado' : `Entregar ${picked}`}</button>`
    : '';
  const refund = sale.refundedAt
    ? '<p class="hint">Esta factura ya fue devuelta. Las cantidades volvieron al inventario.</p>'
    : `<button class="btn danger" type="button" data-action="refund-invoice" data-id="${sale.id}">Devolver factura</button>`;
  actions.innerHTML = `${deliver}${refund}<button class="btn ghost" type="button" data-action="close-barra">Cerrar</button>`;
}

function keepPicks(sale) {
  const next = {};
  for (const item of sale.items || []) {
    const done = new Set(item.deliveredUnits || []);
    const picked = (state.barraPicks[item.id] || []).filter((number) => !done.has(number));
    if (picked.length) next[item.id] = picked;
  }
  state.barraPicks = next;
}

function facturaView(sale) {
  return `
    <div class="public">
      <header class="topnav">
        <div class="wrap nav-inner">
          <a class="brand" href="/" data-link>${mark()}<span>${esc(negocio.name)}</span></a>
        </div>
      </header>
      <section class="section"><div class="wrap" id="factura-live">${sale ? facturaBody(sale) : '<p class="lead">Cargando factura…</p>'}</div></section>
    </div>`;
}

function facturaBody(sale) {
  if (!sale) return `<div class="empty"><h2>No está esa factura</h2><p class="lead">El QR no corresponde a una venta de ${esc(negocio.name)}.</p></div>`;
  const lines = deliveryItems(sale);
  const pending = lines.reduce((sum, item) => sum + item.remaining, 0);
  const delivered = lines.reduce((sum, item) => sum + item.delivered, 0);
  return `
    <p class="eyebrow">Factura ${esc(sale.numberLabel)}</p>
    <h1 style="font-size:42px">${esc(sale.customerName)}</h1>
    <p class="price-line">${sale.customerDocument ? `Cédula ${esc(sale.customerDocument)}` : ''}${sale.paymentReference ? ` · Ref. ${esc(sale.paymentReference)}` : ''}</p>
    <p class="lead">${sale.refundedAt ? 'Esta factura fue devuelta.' : `Entregado ${delivered} · Disponible ${pending}`}</p>
    ${barraLinesHtml(sale, false)}
    <div class="sheet-legend">
      <span><i class="legend-dot free"></i> Disponible</span>
      <span><i class="legend-dot done"></i> Entregado</span>
    </div>
    <p class="price-line" style="margin-top:14px">${chargedTotal(sale)} · ${esc(formatDateTime(sale.createdAt))}</p>`;
}

function findSale(itemId) {
  const id = Number(itemId);
  const fromBoard = state.board.find((sale) => sale.itemId === id || sale.id === id);
  if (fromBoard) return fromBoard;
  for (const purchase of state.currentTicket?.purchases || []) {
    const item = purchase.items.find((line) => line.id === id);
    if (!item) continue;
    return {
      ...item,
      itemId: item.id,
      purchaseId: purchase.id,
      ticketCode: state.currentTicket.code,
      alias: state.currentTicket.alias || '',
      eventName: state.currentTicket.eventName || '',
    };
  }
  return null;
}

function unitButton(number, delivered, selected, at) {
  const kind = delivered ? 'done' : selected ? 'pick' : 'free';
  const label = delivered ? 'Entregado' : selected ? 'Seleccionado' : 'Disponible';
  const time = delivered ? formatHour(at) : '';
  const timed = time ? ' has-time' : '';
  return `<button class="unit ${kind}${timed}" type="button" data-action="toggle-unit" data-n="${number}" ${delivered ? 'disabled' : ''} aria-label="Número ${number}, ${label}${time ? `, ${time}` : ''}">${unitMarkup(number, delivered, at)}</button>`;
}

function sheetGrid() {
  const sheet = state.sheet;
  if (!sheet) return '';
  const done = new Set(sheet.deliveredUnits || []);
  const picked = new Set(sheet.selected || []);
  let html = '';
  for (let number = 1; number <= sheet.quantity; number += 1) html += unitButton(number, done.has(number), picked.has(number), sheet.deliveredAt?.[number]);
  return html;
}

function sheetActions() {
  const count = state.sheet?.selected?.length || 0;
  const deliver = count
    ? `<button class="btn primary" type="button" data-action="confirm-sheet">${count === 1 ? 'Entregar 1' : `Entregar ${count}`}</button>`
    : '';
  return `${deliver}<button class="btn ghost" type="button" data-action="close-sheet">Cerrar</button>`;
}

function sheetModal() {
  const sheet = state.sheet;
  if (!sheet) return '';
  const who = sheet.alias || sheet.ticketCode || '';
  return `
    <div class="modal-back" data-action="close-sheet">
      <article class="modal card wide sheet-modal" data-stop>
        <p class="stub-kicker">${esc(who)}</p>
        <h2 style="font-size:36px">${esc(sheet.productName)}</h2>
        <p class="lead page-lead" id="sheet-status">${sheet.quantity} vendidas · Entregadas ${sheet.delivered} · Quedan ${sheet.remaining}</p>
        <div class="paper">
          <p class="paper-kicker">Planilla</p>
          <div class="unit-grid" id="unit-grid">${sheetGrid()}</div>
          <div class="sheet-legend">
            <span><i class="legend-dot free"></i> Disponible</span>
            <span><i class="legend-dot pick"></i> Seleccionado</span>
            <span><i class="legend-dot done"></i> Entregado</span>
          </div>
        </div>
        <div class="row-actions" id="sheet-actions">${sheetActions()}</div>
      </article>
    </div>`;
}

function paintSheet() {
  const grid = document.getElementById('unit-grid');
  const status = document.getElementById('sheet-status');
  const actions = document.getElementById('sheet-actions');
  const sheet = state.sheet;
  if (!grid || !sheet) {
    mountModal(sheetModal());
    return;
  }
  grid.innerHTML = sheetGrid();
  if (status) status.textContent = `${sheet.quantity} vendidas · Entregadas ${sheet.delivered} · Quedan ${sheet.remaining}`;
  if (actions) actions.innerHTML = sheetActions();
}

async function reloadBoard() {
  const box = document.getElementById('sales-board');
  if (!box) {
    if (!state.sheet) return;
  } else {
    const query = state.boardQuery || '';
    const sales = (await api(`/api/visor/sales?q=${encodeURIComponent(query)}`)).sales;
    if ((state.boardQuery || '') !== query) return;
    state.board = sales;
    box.innerHTML = state.board.length ? state.board.map((sale) => `
      <button class="sale-hit" type="button" data-action="open-sheet" data-id="${sale.itemId}">
        <strong>${esc(sale.productName)}</strong>
        <span>${esc(sale.alias || sale.ticketCode)} · ${sale.quantity} vendidas</span>
      </button>`).join('') : '';
  }
  if (!state.sheet) return;
  const fresh = findSale(state.sheet.itemId);
  if (!fresh) return;
  const done = new Set(fresh.deliveredUnits || []);
  state.sheet = { ...fresh, selected: (state.sheet.selected || []).filter((number) => !done.has(number)) };
  paintSheet();
}

function paintVisor(ticket, note = '') {
  state.currentTicket = ticket;
  rememberRead(ticket);
  const box = document.getElementById('visor-result');
  if (box) box.innerHTML = resultView(ticket, note);
  renderAccount();
  renderLog();
}

function salesView() {
  const sales = state.sales;
  const presets = [
    ['day', 'Hoy'],
    ['week', 'Esta semana'],
    ['month', 'Este mes'],
    ['year', 'Este año'],
    ['custom', 'Por fecha'],
  ];
  const preset = state.salesQuery.preset;
  return `
    <h2>Ventas</h2>
    <p class="lead page-lead">Aquí salen las entradas y, debajo, las ventas de productos del mismo periodo.</p>
    <form id="sales-form" class="card no-print" data-form="sales" style="margin-bottom:16px">
      <div class="seg">
        ${presets.map(([value, label]) => `<button type="button" class="${preset === value ? 'active' : ''}" data-action="preset" data-preset="${value}">${label}</button>`).join('')}
      </div>
      <div class="filters">
        <label class="field"><span>Desde</span><input name="from" type="date" value="${esc(state.salesQuery.from)}"></label>
        <label class="field"><span>Hasta</span><input name="to" type="date" value="${esc(state.salesQuery.to)}"></label>
        <label class="field"><span>Evento</span><select name="q">${eventOptions(sales)}</select></label>
        <label class="field"><span>Producto</span><input name="product" value="${esc(state.salesQuery.product || '')}" placeholder="Buscar por producto"></label>
        <button class="btn primary" type="submit">Buscar</button>
      </div>
      <p class="form-error" ${state.salesError ? '' : 'hidden'} style="margin-top:10px">${esc(state.salesError)}</p>
    </form>
    <h2>Entradas</h2>
    ${ticketSalesBody(sales)}
    <h2 style="margin-top:28px">Productos</h2>
    ${productSalesBody(state.productSales)}`;
}

function eventOptions(sales) {
  const names = [...(sales?.eventNames || [])];
  const current = state.salesQuery.q || '';
  if (current && !names.includes(current)) names.unshift(current);
  const options = [`<option value="">Todos los eventos</option>`];
  for (const name of names) {
    options.push(`<option value="${esc(name)}" ${name === current ? 'selected' : ''}>${esc(name)}</option>`);
  }
  return options.join('');
}

function ticketSalesBody(sales) {
  if (!sales) return `<div class="empty"><h3>No se pudieron cargar las ventas</h3><p class="lead">${esc(state.salesError || '')}</p></div>`;
  if (!sales.totals.tickets) {
    const lead = sales.query
      ? `No hay ventas de «${esc(sales.query)}» en ${esc(sales.label)}. Si el evento ya se eliminó, sus ventas siguen en el periodo en que se hicieron.`
      : `${esc(sales.label)}. Prueba otra fecha o emite entradas nuevas.`;
    return `<div class="empty"><h3>No hay entradas en este periodo</h3><p class="lead">${lead}</p>${sales.query ? '' : '<a class="btn primary" href="/panel/entradas" data-link style="margin-top:14px">Emitir entradas</a>'}</div>`;
  }
  const chartTitle = sales.grain === 'hour' ? 'Entradas por hora' : sales.grain === 'month' ? 'Entradas por mes' : 'Entradas por día';
  return `
    <div class="grid-stats">
      <article class="stat"><p class="stat-label">Entradas vendidas</p><p class="stat-value">${sales.totals.tickets}</p></article>
      <article class="stat"><p class="stat-label">Códigos QR</p><p class="stat-value">${sales.totals.qrs}</p></article>
      <article class="stat"><p class="stat-label">Ingresos</p><p class="stat-value">${money(sales.totals.revenueCents)}</p></article>
      <article class="stat"><p class="stat-label">Periodo</p><p class="stat-value" style="font-size:22px">${esc(sales.label)}</p></article>
    </div>
    <section class="card"><h3>${chartTitle}</h3><div class="bars">${chartBars(sales.series)}</div></section>
    <section class="card" style="margin-top:16px"><h3>Por evento</h3><p class="hint" style="margin:6px 0 12px">Cada fila suma las ventas de ese evento. Si lo eliminas, estas ventas se conservan y puedes seguir filtrándolas por su nombre.</p><div class="event-list">${eventSalesRows(sales.events)}</div></section>
    <section class="card" style="margin-top:16px"><h3>Entradas del periodo</h3><p class="hint" style="margin:6px 0 12px">Una fila con varias entradas es un solo QR de grupo.</p>${ticketRows(sales.rows)}</section>`;
}

function eventSalesRows(events) {
  return (events || []).map((event) => `
    <article class="event-row">
      <div>
        <h3>${esc(event.name)}</h3>
        <p class="price-line">${event.tickets.toLocaleString('es-ES')} ${event.tickets === 1 ? 'entrada' : 'entradas'} · ${event.qrs.toLocaleString('es-ES')} ${event.qrs === 1 ? 'código' : 'códigos'}</p>
      </div>
      <strong>${money(event.revenueCents)}</strong>
    </article>`).join('');
}

function productSalesBody(sales) {
  if (!sales) return `<div class="empty"><h3>No se pudieron cargar las ventas</h3><p class="lead">${esc(state.salesError || '')}</p></div>`;
  if (!sales.totals.units) {
    const lead = sales.query
      ? `Ningún producto coincide con «${esc(sales.query)}» en ${esc(sales.label)}.`
      : `${esc(sales.label)}. Cuando factures productos en un QR, el total de cada uno aparece aquí.`;
    return `<div class="empty"><h3>No hay ventas de productos en este periodo</h3><p class="lead">${lead}</p></div>`;
  }
  const chartTitle = sales.grain === 'hour' ? 'Unidades por hora' : sales.grain === 'month' ? 'Unidades por mes' : 'Unidades por día';
  const groups = (sales.products || []).map((product) => `
    <article class="event-row">
      <div>
        <h3>${esc(product.name)}</h3>
        <p class="price-line">${product.units.toLocaleString('es-ES')} ${product.units === 1 ? 'unidad' : 'unidades'} · ${product.sales.toLocaleString('es-ES')} ${product.sales === 1 ? 'venta' : 'ventas'}</p>
      </div>
      <strong>${money(product.revenueCents)}</strong>
    </article>`).join('');
  const details = `
    <div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>Producto</th><th>Cantidad</th><th>Total</th><th>Entrada</th><th>Pago</th></tr></thead>
      <tbody>
        ${(sales.rows || []).map((row) => `
          <tr>
            <td>${formatDateTime(row.createdAt)}</td>
            <td>${esc(row.productName)}</td>
            <td>${row.quantity.toLocaleString('es-ES')}</td>
            <td>${money(row.totalCents)}</td>
            <td>${esc(row.alias || row.eventName)} · <span class="code">${esc(row.ticketCode)}</span></td>
            <td>${esc(paymentLabel(row.paymentMethod))}</td>
          </tr>`).join('')}
      </tbody>
    </table></div>`;
  return `
    <div class="grid-stats">
      <article class="stat"><p class="stat-label">Unidades vendidas</p><p class="stat-value">${sales.totals.units.toLocaleString('es-ES')}</p></article>
      <article class="stat"><p class="stat-label">Productos</p><p class="stat-value">${sales.totals.products}</p></article>
      <article class="stat"><p class="stat-label">Ingresos</p><p class="stat-value">${money(sales.totals.revenueCents)}</p></article>
      <article class="stat"><p class="stat-label">Periodo</p><p class="stat-value" style="font-size:22px">${esc(sales.label)}</p></article>
    </div>
    <section class="card"><h3>${chartTitle}</h3><div class="bars">${chartBars(sales.series)}</div></section>
    <section class="card" style="margin-top:16px"><h3>Por producto</h3><p class="hint" style="margin:6px 0 12px">Cada fila suma todas las ventas de ese producto en el periodo. Los combos se cuentan con su propio precio.</p><div class="event-list">${groups}</div></section>
    <section class="card" style="margin-top:16px"><h3>Detalle</h3><div style="height:12px"></div>${details}</section>`;
}

function chartBars(series) {
  const max = Math.max(...series.map((item) => item.tickets), 1);
  const step = series.length > 16 ? Math.ceil(series.length / 12) : 1;
  return series.map((item, index) => {
    const empty = item.tickets === 0;
    const height = empty ? 0 : Math.max(8, Math.round((item.tickets / max) * 100));
    const label = index % step === 0 ? esc(item.label) : '';
    return `<div class="bar" title="${esc(item.label)}: ${item.tickets}"><i class="${empty ? 'empty' : ''}" style="--h:${height}"></i><span>${label}</span></div>`;
  }).join('');
}

function accountView() {
  return `
    <form class="card" data-form="password" style="max-width:460px">
      <h2>Cuenta</h2>
      <p class="lead page-lead">Sesión de ${esc(state.user?.username || '')}. Cambia la contraseña cuando quieras.</p>
      <label class="field"><span>Contraseña actual</span><input name="current" type="password" autocomplete="current-password" required></label>
      <label class="field"><span>Nueva contraseña</span><input name="next" type="password" autocomplete="new-password" minlength="8" required></label>
      <label class="field"><span>Confirmar</span><input name="confirm" type="password" autocomplete="new-password" minlength="8" required></label>
      <p class="form-error" hidden></p>
      <button class="btn primary" type="submit">Guardar contraseña</button>
    </form>`;
}

function detailModal() {
  const ticket = state.detail;
  if (!ticket?.qrDataUrl) return '';
  return `
    <div class="modal-back" data-action="close-detail">
      <article class="modal card" data-stop>
        <p class="stub-kicker">${esc(ticket.code)}</p>
        <h2 style="font-size:36px">${esc(ticket.eventName)}</h2>
        <p class="price-line">${entradasLabel(ticket.quantity)} · ${money(ticket.totalCents)}</p>
        <p class="hint" style="margin:8px 0 12px">${esc(whenText(ticket))} ${statusBadge(ticket.status)}</p>
        <img alt="QR ${esc(ticket.code)}" src="${ticket.qrDataUrl}" style="width:220px;height:220px;margin:0 auto 12px">
        <button class="btn ghost" type="button" data-action="close-detail">Cerrar</button>
      </article>
    </div>`;
}

function updateTotal() {
  const form = document.getElementById('ticket-form');
  if (!form) return;
  const option = form.querySelector('select[name="eventId"]')?.selectedOptions?.[0];
  const free = Boolean(form.free?.checked);
  const price = free ? 0 : Number(option?.dataset.price || 0);
  const quantity = Math.min(100, Math.max(1, Number(form.quantity.value) || 1));
  const mode = form.querySelector('input[name="mode"]:checked')?.value || 'individual';
  const pay = document.getElementById('pay-field');
  if (pay) pay.hidden = free;
  if (form.paymentMethod) form.paymentMethod.required = !free;
  const total = document.getElementById('total-preview');
  const note = document.getElementById('total-note');
  if (total) total.textContent = money(price * quantity);
  if (note) {
    note.textContent = mode === 'group'
      ? `${entradasLabel(quantity)} en un solo QR`
      : `${quantity === 1 ? '1 QR individual' : `${quantity} QR individuales`}`;
  }
}

function renderLog() {
  const log = document.getElementById('visor-log');
  if (!log) return;
  log.innerHTML = state.reads.length
    ? state.reads.map((ticket) => `<button type="button" data-action="show-read" data-code="${esc(ticket.code)}"><strong>${esc(ticket.eventName)}</strong><br><span class="hint">${esc(ticket.code)} · ${entradasLabel(ticket.quantity)} · ${ticket.status === 'active' ? 'Vigente' : ticket.status === 'used' ? 'Usada' : 'Vencida'}</span></button>`).join('')
    : `<p class="hint">Las lecturas de esta visita aparecerán aquí.</p>`;
}

function rememberRead(ticket) {
  state.reads = [ticket, ...state.reads.filter((item) => item.code !== ticket.code)].slice(0, 6);
}

function resultChoices(tickets) {
  return `
    <article class="result">
      <h2>Varias entradas</h2>
      <p class="lead">Elige cuál quieres abrir.</p>
      <div class="read-log" style="margin-top:12px">
        ${tickets.map((ticket) => `<button type="button" data-action="show-read" data-code="${esc(ticket.code)}"><strong>${esc(ticket.alias || ticket.eventName)}</strong><br><span class="hint">${esc(ticket.code)} · ${esc(ticket.eventName)} · ${esc(paymentLabel(ticket.paymentMethod))}</span></button>`).join('')}
      </div>
    </article>`;
}

async function lookupCode(raw) {
  const text = String(raw || '').trim();
  const box = document.getElementById('visor-result');
  if (!box) return;
  box.innerHTML = `<p class="lead">Consultando…</p>`;
  try {
    const data = await api(`/api/tickets/search?q=${encodeURIComponent(text)}`);
    if (!data.tickets.length) {
      state.currentTicket = null;
      renderAccount();
      box.innerHTML = resultMissing(text);
      return;
    }
    if (data.tickets.length > 1) {
      state.currentTicket = null;
      renderAccount();
      box.innerHTML = resultChoices(data.tickets);
      return;
    }
    paintVisor(data.tickets[0]);
  } catch (error) {
    state.currentTicket = null;
    renderAccount();
    box.innerHTML = error.status === 404 ? resultMissing(text) : `<article class="result bad"><h2>Error</h2><p>${esc(error.message)}</p></article>`;
  }
}

async function startCamera() {
  stopCamera();
  const box = document.getElementById('camera-box');
  const video = document.getElementById('cam');
  if (!box || !video || !('BarcodeDetector' in window)) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch {
    toast('No se pudo abrir la cámara. Revisa el permiso del navegador.', 'bad');
    return;
  }
  box.hidden = false;
  video.srcObject = stream;
  await video.play();
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const tick = async () => {
    if (!stream) return;
    try {
      const codes = await detector.detect(video);
      if (codes[0]?.rawValue) {
        const value = codes[0].rawValue;
        stopCamera();
        await onScan(value);
        return;
      }
    } catch {
      /* El fotograma todavía no está listo. */
    }
    scanTimer = setTimeout(tick, 280);
  };
  scanTimer = setTimeout(tick, 400);
}

async function scanFile(file) {
  if (!('BarcodeDetector' in window)) {
    toast('Este navegador no puede leer la foto. Escribe el código.', 'bad');
    return;
  }
  try {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const bitmap = await createImageBitmap(file);
    const codes = await detector.detect(bitmap);
    if (!codes.length) {
      toast('No se encontró un QR en la imagen.', 'bad');
      return;
    }
    await onScan(codes[0].rawValue);
  } catch {
    toast('No se pudo leer esa imagen.', 'bad');
  }
}

function setFormError(form, message) {
  const element = form.querySelector('.form-error');
  if (!element) return;
  element.hidden = !message;
  element.textContent = message || '';
}

function salesParams() {
  const query = new URLSearchParams();
  query.set('preset', state.salesQuery.preset || 'day');
  if (state.salesQuery.from) query.set('from', state.salesQuery.from);
  if (state.salesQuery.to) query.set('to', state.salesQuery.to);
  if (state.salesQuery.q) query.set('q', state.salesQuery.q);
  return query;
}

function productSalesParams() {
  const query = salesParams();
  query.delete('q');
  query.set('kind', 'products');
  if (state.salesQuery.product) query.set('q', state.salesQuery.product);
  return query;
}

function movesParams() {
  const query = new URLSearchParams();
  query.set('preset', state.moveQuery.preset || 'month');
  if (state.moveQuery.from) query.set('from', state.moveQuery.from);
  if (state.moveQuery.to) query.set('to', state.moveQuery.to);
  if (state.moveQuery.q) query.set('q', state.moveQuery.q);
  if (state.moveQuery.kind) query.set('kind', state.moveQuery.kind);
  return query;
}

const routeModules = {
  '/panel': 'resumen',
  '/panel/venta': 'venta',
  '/panel/barra': 'barra',
  '/panel/inventario': 'inventario',
  '/panel/compras': 'compras',
  '/panel/cargas': 'cargas',
  '/panel/gastos': 'gastos',
  '/panel/ventas': 'ventas',
  '/panel/movimientos': 'movimientos',
  '/panel/pantallas': 'pantallas',
  '/panel/usuarios': 'usuarios',
};

function denied() {
  return `<div class="empty"><h2>Sin acceso</h2><p class="lead">Tu usuario no tiene permiso para ver este módulo.</p></div>`;
}

function moduleChecks(selected = []) {
  return `<div class="checks">${MODULES.map(([key, label]) => `
    <label class="check"><input type="checkbox" name="module" value="${key}" ${selected.includes(key) ? 'checked' : ''}><span>${label}</span></label>
  `).join('')}</div>`;
}

function movementsView() {
  const presets = [['day', 'Hoy'], ['week', 'Esta semana'], ['month', 'Este mes'], ['year', 'Este año'], ['custom', 'Por fecha'], ['all', 'Todo']];
  const kinds = [['', 'Todo'], ['entrada', 'Entradas'], ['venta', 'Ventas'], ['devolucion', 'Devoluciones'], ['ajuste', 'Ajustes']];
  const data = state.moves;
  const groups = new Map();
  const stock = [];
  for (const row of data?.movements || []) {
    if (row.kind !== 'venta') {
      stock.push(row);
      continue;
    }
    const key = row.invoiceId ? `f-${row.invoiceId}` : (row.purchaseId || row.id);
    const group = groups.get(key) || {
      purchaseId: row.purchaseId,
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoiceNumber,
      customerName: row.customerName,
      ticketCode: row.ticketCode,
      eventName: row.eventName,
      paymentMethod: row.paymentMethod,
      hasReceipt: row.hasReceipt,
      createdAt: row.createdAt,
      username: row.username,
      items: [],
      totalCents: 0,
      refunded: false,
    };
    group.items.push(row);
    group.totalCents += row.totalCents || 0;
      group.hasReceipt = group.hasReceipt || row.hasReceipt;
      group.refunded = group.refunded || row.refunded;
      groups.set(key, group);
  }
  const sales = [...groups.values()];
  const saleCards = sales.length ? sales.map((sale) => `
    <article class="card" style="margin-bottom:12px">
      <div class="row-actions">
        <div>
          <h3>${esc(sale.customerName || sale.eventName || 'Venta')} · <span class="code">${esc(sale.invoiceNumber || sale.ticketCode)}</span></h3>
          <p class="hint">${formatDateTime(sale.createdAt)} · ${paymentLabel(sale.paymentMethod)}${sale.username ? ` · ${esc(sale.username)}` : ''}</p>
        </div>
        <strong>${sale.refunded ? 'Devuelta' : money(sale.totalCents)}</strong>
      </div>
      ${sale.items.map((item) => `<div class="balance"><div><strong>${esc(item.productName)}</strong><p class="hint">${item.unitPriceCents == null ? `${item.quantity} unidades · ${esc(item.note || 'Incluido en un combo')}` : `${item.quantity} vendidas · ${money(item.totalCents || 0)}`}</p></div></div>`).join('')}
      <div class="row-actions" style="margin-top:10px">
        ${sale.hasReceipt ? `<a class="btn ghost small" href="${sale.invoiceId ? `/api/invoices/${sale.invoiceId}/receipt` : `/api/purchases/${sale.purchaseId}/receipt`}" target="_blank" rel="noopener">Ver comprobante</a>` : '<span class="hint">Sin comprobante</span>'}
        ${sale.invoiceId ? '' : `<label class="btn ghost small file-btn">Adjuntar comprobante<input type="file" accept="image/*,.pdf" data-receipt="${sale.purchaseId}"></label>`}
      </div>
    </article>`).join('') : `<div class="empty"><h3>No hay ventas en este periodo</h3><p class="lead">Cuando factures productos en un QR, aparecerán aquí con el pago y el comprobante.</p></div>`;
  const stockRows = stock.length ? `<div class="event-list">${stock.map((row) => `
    <article class="event-row">
      <div>
        <h3>${esc(row.productName)}</h3>
        <p class="price-line">${formatDateTime(row.createdAt)} · ${esc(row.note || '')}${row.username ? ` · ${esc(row.username)}` : ''}</p>
      </div>
      <strong>${row.kind === 'ajuste' ? '−' : '+'}${row.quantity}</strong>
    </article>`).join('')}</div>` : `<div class="empty"><h3>No hay entradas de inventario</h3><p class="lead">Al sumar existencias queda registrado quién agregó unidades y cuántas.</p></div>`;
  const showSales = !['entrada', 'ajuste', 'devolucion'].includes(state.moveQuery.kind);
  const showStock = state.moveQuery.kind !== 'venta';
  return `
    <h2>Movimiento de unidades</h2>
    <p class="lead page-lead">Lo que entra al inventario y lo que se vende en cada QR: a quién, cuánto y cómo pagó.</p>
    <form id="moves-form" class="card" data-form="moves" style="margin-bottom:16px">
      <div class="seg">
        ${presets.map(([value, label]) => `<button type="button" class="${state.moveQuery.preset === value ? 'active' : ''}" data-action="move-preset" data-preset="${value}">${label}</button>`).join('')}
      </div>
      <div class="seg">
        ${kinds.map(([value, label]) => `<button type="button" class="${state.moveQuery.kind === value ? 'active' : ''}" data-action="move-kind" data-kind="${value}">${label}</button>`).join('')}
      </div>
      <div class="filters">
        <label class="field"><span>Desde</span><input name="from" type="date" value="${esc(state.moveQuery.from)}"></label>
        <label class="field"><span>Hasta</span><input name="to" type="date" value="${esc(state.moveQuery.to)}"></label>
        <label class="field"><span>Buscar</span><input name="q" value="${esc(state.moveQuery.q)}" placeholder="Producto, evento o código"></label>
        <button class="btn primary" type="submit">Buscar</button>
      </div>
      <p class="form-error" ${state.moveError ? '' : 'hidden'} style="margin-top:10px">${esc(state.moveError)}</p>
    </form>
    ${data ? `<p class="hint" style="margin-bottom:12px">${esc(data.label)}</p>` : ''}
    ${showSales ? `<h3 style="margin:8px 0 12px">Ventas por QR</h3>${saleCards}` : ''}
    ${showStock ? `<h3 style="margin:18px 0 12px">Inventario</h3>${stockRows}` : ''}`;
}

function usersView() {
  const editing = state.editingUser;
  const list = state.staff.length ? `<div class="event-list">${state.staff.map((user) => `
    <article class="event-row">
      <div>
        <h3>${esc(user.username)}</h3>
        <p class="price-line">${user.isAdmin ? 'Administrador · ve todos los módulos' : (user.permissions.map((key) => MODULES.find((item) => item[0] === key)?.[1] || key).join(' · ') || 'Sin módulos')}</p>
      </div>
      <div class="row-actions">
        <button class="btn ghost small" type="button" data-action="edit-user" data-id="${user.id}">Permisos</button>
        ${user.id === state.user?.id ? '' : `<button class="btn danger small" type="button" data-action="delete-user" data-id="${user.id}">Eliminar</button>`}
      </div>
    </article>`).join('')}</div>` : '';
  return `
    <div class="stack">
      <form class="card product-form" data-form="staff">
        <h2>${editing ? `Permisos de ${esc(editing.username)}` : 'Nuevo usuario'}</h2>
        <p class="lead page-lead">Al entrar, solo verá los módulos que marques. Quien tenga Barra recibe el aviso de cada pedido que pase a barra.</p>
        ${editing ? '' : `<label class="field"><span>Usuario</span><input name="username" required minlength="3" maxlength="24" placeholder="caja"></label>
        <label class="field"><span>Contraseña</span><input name="password" type="password" required minlength="8"></label>`}
        ${editing ? `<label class="field"><span>Nueva contraseña</span><input name="password" type="password" minlength="8" placeholder="Déjala vacía para no cambiarla"></label>` : ''}
        ${state.user?.isAdmin ? `<label class="check"><input name="isAdmin" type="checkbox" ${editing?.isAdmin ? 'checked' : ''}><span>Administrador: ve todos los módulos</span></label>` : ''}
        <p class="hint" style="margin-bottom:8px">Módulos</p>
        ${moduleChecks(editing?.isAdmin ? MODULES.map(([key]) => key) : (editing?.permissions || []))}
        <p class="form-error" hidden></p>
        <div class="row-actions" style="margin-top:12px">
          <button class="btn primary" type="submit">${editing ? 'Guardar permisos' : 'Crear usuario'}</button>
          ${editing ? '<button class="btn ghost" type="button" data-action="cancel-user">Cancelar</button>' : ''}
        </div>
      </form>
      <section>
        <h2>Usuarios</h2>
        <p class="lead page-lead">Cada persona del personal entra con su usuario y ve solo lo que le asignes.</p>
        ${list}
      </section>
    </div>`;
}

function shareControls(screen, linked) {
  const others = linked.filter((item) => item.id !== screen.id);
  if (!others.length) return '';
  return `<div class="share-row">
    <select data-share-target="${screen.id}" aria-label="Compartir a otra pantalla">
      <option value="">Compartir a otra pantalla</option>
      ${others.map((item) => `<option value="${item.id}">${esc(item.name)}</option>`).join('')}
      ${others.length > 1 ? '<option value="all">Todas las demás</option>' : ''}
    </select>
    <button class="btn ghost small" type="button" data-action="share-screen" data-id="${screen.id}">Compartir</button>
  </div>`;
}

function screensView() {
  const linked = state.screens.filter((screen) => screen.status === 'linked');
  const cards = state.screens.length ? state.screens.map((screen) => `
    <article class="event-row">
      <div>
        <h3>${screen.status === 'linked' ? esc(screen.name) : 'Sin vincular'}</h3>
        <p class="price-line"><span class="dot ${screen.online ? 'on' : ''}"></span> Código ${esc(screen.code.slice(0, 3))} ${esc(screen.code.slice(3))} · ${screen.online ? 'En línea' : 'Sin conexión'}${screen.content ? ` · ${screen.content.kind === 'youtube' ? 'YouTube' : screen.content.kind === 'video' ? 'Video' : 'Imagen'}` : ''}</p>
      </div>
      <div class="row-actions">
        ${screen.status === 'pending' ? `<span class="pair-code-label">${esc(screen.code.slice(0, 3))} ${esc(screen.code.slice(3))}</span><input class="screen-name" data-screen-name="${screen.id}" placeholder="Nombre de esta pantalla" maxlength="40" aria-label="Nombre de esta pantalla"><button class="btn primary small" type="button" data-action="link-screen" data-id="${screen.id}">Vincular</button>` : `<button class="btn ghost small" type="button" data-action="clear-screen" data-id="${screen.id}">Quitar contenido</button>`}
        ${screen.status === 'linked' && screen.content ? shareControls(screen, linked) : ''}
        <button class="btn danger small" type="button" data-action="delete-screen" data-id="${screen.id}">Quitar</button>
      </div>
    </article>`).join('') : `<div class="empty"><h3>No hay pantallas</h3><p class="lead">Abre la dirección de abajo en el televisor. El código aparecerá allí.</p></div>`;
  return `
    <h2>Pantallas</h2>
    <p class="lead page-lead">Abre <strong>${esc(location.origin)}/pantalla</strong> en el televisor, en este mismo sitio. Copia el código de 6 números y escríbelo aquí.</p>
    <section class="card" style="margin-bottom:16px">
      <h3>Vincular pantalla</h3>
      <form class="pair-form" data-form="screen-pair">
        <label class="field"><span>Código</span><input name="code" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="000 000" required></label>
        <label class="field"><span>Nombre</span><input name="name" maxlength="40" placeholder="Televisor de la sala" required></label>
        <button class="btn primary" type="submit">Vincular</button>
        <p class="form-error" hidden></p>
      </form>
    </section>
    <div class="split">
      <section class="card">
        <h3>Reproducir</h3>
        <form data-form="screen-play" style="margin-top:12px">
          <label class="field"><span>Título</span><input name="title" maxlength="80" placeholder="Promo de la noche"></label>
          <div class="choices">
            <label class="choice"><input type="radio" name="kind" value="image" checked><span><strong>Imagen</strong><small>JPG, PNG, WEBP o GIF.</small></span></label>
            <label class="choice"><input type="radio" name="kind" value="video"><span><strong>Video</strong><small>MP4, WEBM o MOV. En Vercel, solo hasta 4 MB; en Render, hasta 200 MB.</small></span></label>
            <label class="choice"><input type="radio" name="kind" value="youtube"><span><strong>YouTube</strong><small>Pega el enlace del video.</small></span></label>
          </div>
          <label class="field" id="screen-file-field"><span>Archivo</span><input name="file" type="file" accept="image/*,video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v"></label>
          <label class="field" id="screen-youtube-field" hidden><span>Enlace de YouTube</span><input name="youtube" placeholder="https://www.youtube.com/watch?v="></label>
          <label class="field"><span>Dónde se ve</span>
            <select name="target">
              <option value="all">Todas las pantallas vinculadas</option>
              ${linked.map((screen) => `<option value="${screen.id}">${esc(screen.name)}</option>`).join('')}
            </select>
          </label>
          <p class="form-error" hidden></p>
          <button class="btn primary" type="submit">Reproducir</button>
        </form>
      </section>
      <section>
        <h3 style="margin-bottom:12px">Vinculadas y en espera</h3>
        <div class="event-list">${cards}</div>
      </section>
    </div>`;
}

function mediaOffset(content, duration) {
  const base = Number(content?.position);
  if (!Number.isFinite(base) || base < 0) return 0;
  const at = Date.parse(content.positionAt || '');
  const elapsed = Number.isFinite(at) ? Math.max(0, (Date.now() - at) / 1000) : 0;
  let time = base + elapsed;
  if (Number.isFinite(duration) && duration > 0.5) time %= duration;
  return time;
}

function youtubeFrame(id, title, start) {
  const origin = encodeURIComponent(location.origin);
  const at = start > 0.5 ? `&start=${Math.floor(start)}` : '';
  return `<iframe id="screen-youtube" title="${esc(title || 'Video')}" src="https://www.youtube.com/embed/${id}?autoplay=1&mute=0&enablejsapi=1&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3&controls=0&disablekb=1&fs=0&loop=1&playlist=${id}&origin=${origin}${at}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
}

function kickYouTube(frame, seconds = 0) {
  const win = frame?.contentWindow;
  if (!win) return;
  const send = (func, args) => win.postMessage(JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }), 'https://www.youtube.com');
  win.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), 'https://www.youtube.com');
  send('unMute', []);
  send('setVolume', [100]);
  send('playVideo', []);
  if (seconds > 0.5) send('seekTo', [seconds, true]);
}

function playOutLoud(video) {
  if (!video) return;
  const at = video.currentTime || 0;
  video.volume = 1;
  video.muted = false;
  video.defaultMuted = false;
  const restore = () => {
    if (at > 0.3 && Math.abs((video.currentTime || 0) - at) > 1.2) video.currentTime = at;
  };
  let pending = null;
  try { pending = video.play(); } catch { pending = null; }
  if (!pending || typeof pending.then !== 'function') {
    restore();
    return;
  }
  pending.catch(() => {
    video.muted = true;
    const again = video.play();
    if (!again || typeof again.then !== 'function') return;
    again.then(() => {
      video.muted = false;
      video.volume = 1;
      const loud = video.play();
      if (loud && typeof loud.catch === 'function') loud.catch(() => {});
    }).catch(() => {
      video.muted = true;
      const quiet = video.play();
      if (quiet && typeof quiet.catch === 'function') quiet.catch(() => {});
    });
  }).finally(restore);
}

function seekPlaying(content) {
  const video = document.querySelector('#screen-stage video');
  if (video) {
    const go = () => {
      const time = mediaOffset(content, video.duration);
      if (Math.abs(video.currentTime - time) > 0.8) video.currentTime = time;
      playOutLoud(video);
    };
    if (video.readyState >= 1) go();
    else video.addEventListener('loadedmetadata', go, { once: true });
    return;
  }
  const frame = document.querySelector('#screen-stage iframe');
  if (frame) kickYouTube(frame, mediaOffset(content));
}

function askYouTubeTime(frame) {
  const win = frame?.contentWindow;
  if (!win) return;
  win.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), 'https://www.youtube.com');
  win.postMessage(JSON.stringify({ event: 'command', func: 'getCurrentTime', args: [], id: 1, channel: 'widget' }), 'https://www.youtube.com');
}

function readPlaybackSeconds() {
  if (!screenReady) return null;
  const video = document.querySelector('#screen-stage video');
  if (video && Number.isFinite(video.currentTime) && video.readyState >= 1) {
    return Math.round(video.currentTime * 10) / 10;
  }
  const frame = document.querySelector('#screen-stage iframe');
  if (!frame) return null;
  askYouTubeTime(frame);
  if (typeof youtubeSeconds === 'number') return Math.round(youtubeSeconds * 10) / 10;
  return null;
}

function paintScreen(screen) {
  const stage = document.getElementById('screen-stage');
  if (!stage) return;
  const content = screen.content;
  const identity = `${screen.status}|${screen.name}|${content?.kind || ''}|${content?.source || ''}`;
  const mark = content?.mark || '';
  if (stage.dataset.identity === identity && stage.dataset.mark === mark) return;
  const sameMedia = stage.dataset.identity === identity && (content?.kind === 'video' || content?.kind === 'youtube');
  stage.dataset.identity = identity;
  stage.dataset.mark = mark;
  if (sameMedia) {
    seekPlaying(content);
    return;
  }
  screenReady = true;
  youtubeSeconds = null;
  if (screen.status !== 'linked') {
    stage.className = 'screen-stage wait';
    stage.innerHTML = `<div><p class="eyebrow">${esc(negocio.name)}</p><p class="pair-code">${esc(screen.code.slice(0, 3))} ${esc(screen.code.slice(3))}</p><p>En el panel, entra a Pantallas y escribe este código en Vincular pantalla.</p></div>`;
    return;
  }
  if (!content) {
    stage.className = 'screen-stage wait';
    stage.innerHTML = `<div><p class="eyebrow">Pantalla vinculada</p><h1>${esc(screen.name)}</h1><p>Esperando contenido.</p></div>`;
    return;
  }
  stage.className = 'screen-stage playing';
  if (content.kind === 'image') {
    screenReady = true;
    stage.innerHTML = `<img alt="${esc(content.title || 'Imagen')}" src="${esc(content.source)}">`;
  } else if (content.kind === 'video') {
    const offset = mediaOffset(content);
    screenReady = true;
    const src = offset > 0.5 ? `${content.source}#t=${offset.toFixed(1)}` : content.source;
    stage.innerHTML = `<video src="${esc(src)}" autoplay loop playsinline preload="auto"></video>`;
    const video = stage.querySelector('video');
    let placed = offset < 0.3;
    const place = () => {
      if (placed || video.readyState < 1) return;
      placed = true;
      const time = mediaOffset(content, video.duration);
      if (time > 0.3) video.currentTime = time;
    };
    video.addEventListener('loadedmetadata', place);
    video.addEventListener('error', () => {
      video.dataset.broken = '1';
      stage.className = 'screen-stage wait';
      stage.innerHTML = `<div><p class="eyebrow">Video</p><h1>No se pudo reproducir</h1><p>El televisor no abre este archivo. Usa un MP4.</p></div>`;
    });
    playOutLoud(video);
  } else {
    const offset = mediaOffset(content);
    screenReady = true;
    const id = encodeURIComponent(content.source);
    stage.innerHTML = youtubeFrame(id, content.title, offset);
    const frame = stage.querySelector('iframe');
    frame.addEventListener('load', () => kickYouTube(frame, offset));
  }
}

function keepScreenPlaying() {
  const video = document.querySelector('#screen-stage video');
  if (!video || video.dataset.broken === '1') return;
  if (!video.paused && !video.muted && video.volume > 0) return;
  const tries = Number(video.dataset.soundTries || 0);
  if (!video.paused && video.muted && tries >= 2) return;
  if (video.dataset.holding === '1') return;
  video.dataset.holding = '1';
  video.dataset.soundTries = String(tries + 1);
  playOutLoud(video);
  setTimeout(() => {
    if (video.isConnected) video.dataset.holding = '';
  }, 2000);
}

function stopScreen() {
  if (screenTimer) clearTimeout(screenTimer);
  screenTimer = null;
}

async function renderScreen() {
  document.title = pageTitle('/pantalla');
  mount(`<div class="screen-stage wait" id="screen-stage"><p>Conectando pantalla…</p></div>`);
  let token = localStorage.getItem(screenKey) || '';
  const tick = async () => {
    if (currentPath() !== '/pantalla') return;
    try {
      if (!token) {
        token = localStorage.getItem(screenKey) || '';
      }
      if (!token) {
        if (!screenBoot) {
          screenBoot = api('/api/public/screens', { method: 'POST', body: {} })
            .then((created) => {
              localStorage.setItem(screenKey, created.token);
              return created.token;
            })
            .finally(() => {
              screenBoot = null;
            });
        }
        token = await screenBoot;
      }
      const data = await api(`/api/public/screens/${token}/tick`, {
        method: 'POST',
        body: { seconds: readPlaybackSeconds() },
        soft: true,
      });
      paintScreen(data.screen);
      keepScreenPlaying();
    } catch (error) {
      if (error.status === 404) {
        localStorage.removeItem(screenKey);
        token = '';
      }
      const stage = document.getElementById('screen-stage');
      if (stage && stage.dataset.identity == null) stage.innerHTML = `<p>${esc(error.message || `Sin conexión con ${negocio.name}.`)}</p>`;
    }
    if (currentPath() === '/pantalla') screenTimer = setTimeout(tick, 1000);
  };
  await tick();
}

async function apiForm(path, formData) {
  const response = await fetch(appPath(path), { method: 'POST', credentials: 'same-origin', body: formData });
  if (response.status === 413) {
    const error = new Error('Vercel rechazó el video: pesa más de 4 MB. Ábrelo desde el dominio de la licorería en Render, o pega un enlace de YouTube.');
    error.status = 413;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'No se pudo completar la acción.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function invoiceCodeFromScan(raw) {
  const text = String(raw || '').trim();
  const fromUrl = text.match(/\/f\/([^/?#]+)/i);
  if (fromUrl) return decodeURIComponent(fromUrl[1]);
  return normalizeCode(text);
}

async function onScan(raw) {
  if (currentPath() === '/panel/barra') {
    await openScannedInvoice(raw);
    return;
  }
  await lookupCode(raw);
}

async function openScannedInvoice(raw) {
  const code = invoiceCodeFromScan(raw);
  try {
    const data = await api(`/api/invoices/code/${encodeURIComponent(code)}`);
    openBarraSale(data.sale);
  } catch (error) {
    toast(error.message, 'bad');
  }
}

function openBarraSale(sale) {
  state.barraSale = sale;
  state.barraPicks = {};
  mountModal(barraModal());
  watchInvoice(sale.id);
}

function watchInvoice(id) {
  stopLive();
  liveTimer = setInterval(() => {
    if (!state.barraSale || state.barraSale.id !== id || currentPath() !== '/panel/barra') return;
    api(`/api/invoices/${id}`)
      .then((data) => {
        if (!state.barraSale || state.barraSale.id !== id) return;
        state.barraSale = data.sale;
        keepPicks(data.sale);
        paintBarraModal();
      })
      .catch(() => {});
  }, 2000);
}

async function refreshFactura(code) {
  const box = document.getElementById('factura-live');
  try {
    const data = await api(`/api/public/invoices/${encodeURIComponent(code)}`, { soft: true });
    state.publicSale = data.sale;
    if (box) box.innerHTML = facturaBody(data.sale);
  } catch (error) {
    state.publicSale = null;
    if (box) box.innerHTML = facturaBody(null);
  }
}

async function render() {
  const token = ++renderToken;
  stopCamera();
  stopLive();
  stopScreen();
  const facturaCode = currentPath().match(/^\/f\/([^/]+)$/)?.[1];
  if (facturaCode) {
    document.title = `Factura · ${negocio.name}`;
    mount(facturaView(null));
    const code = decodeURIComponent(facturaCode);
    await refreshFactura(code);
    if (token !== renderToken) return;
    liveTimer = setInterval(() => {
      if (token !== renderToken) return;
      refreshFactura(code);
    }, 2000);
    return;
  }
  document.body.classList.remove('nav-open');
  if (currentPath() === '/pantalla') {
    await renderScreen();
    return;
  }
  let path = currentPath();
  if (!state.user && path.startsWith('/panel')) {
    history.replaceState({}, '', appPath('/acceso'));
    path = '/acceso';
  } else if (state.user && path === '/acceso') {
    history.replaceState({}, '', appPath('/panel'));
    path = '/panel';
  }
  if (routeModules[path] && !allow(routeModules[path])) {
    const fallback = Object.keys(routeModules).find((href) => allow(routeModules[href]));
    if (path === '/panel' && fallback && fallback !== '/panel') {
      history.replaceState({}, '', appPath(fallback));
      path = fallback;
    } else {
      document.title = pageTitle(path);
      mount(shell(denied()));
      return;
    }
  }
  document.title = pageTitle(path);
  if (path !== '/panel/entradas') state.issued = null;
  if (path !== '/panel/ventas' && path !== '/panel') state.detail = null;

  try {
    if (path === '/') {
      mount(homeView());
      return;
    }
    if (path === '/acceso') {
      mount(loginView());
      return;
    }
    if (path === '/panel') {
      mount(shell(loading()));
      const query = state.summaryQuery;
      const params = new URLSearchParams({
        preset: query.preset || 'day',
        from: query.from || '',
        to: query.to || '',
        fromHour: query.fromHour ?? '',
        toHour: query.toHour ?? '',
      });
      state.dash = await api(`/api/summary?${params}`);
      if (token !== renderToken) return;
      mount(shell(dashboardView()));
      return;
    }
    if (path === '/panel/eventos') {
      mount(shell(loading()));
      state.events = (await api('/api/events')).events;
      if (state.editing) state.editing = state.events.find((event) => event.id === state.editing.id) || null;
      if (token !== renderToken) return;
      mount(shell(eventsView()));
      return;
    }
    if (path === '/panel/entradas') {
      mount(shell(loading()));
      state.events = (await api('/api/events')).events;
      if (token !== renderToken) return;
      mount(shell(createView()));
      updateTotal();
      return;
    }
    if (path === '/panel/visor') {
      state.currentTicket = null;
      state.cart = [];
      state.delivery = null;
      state.sheet = null;
      mount(shell(visorView()));
      renderLog();
      document.querySelector('#lookup-form input[name="code"]')?.focus();
      return;
    }
    if (path === '/panel/venta') {
      state.issuedSale = null;
      mount(shell(loading()));
      const [catalog, rate] = await Promise.all([api('/api/products'), api('/api/rate')]);
      state.products = catalog.products;
      state.bcvRate = rate.rate;
      if (token !== renderToken) return;
      mount(shell(posView()));
      document.getElementById('pos-search')?.focus();
      return;
    }
    if (path === '/panel/compras') {
      mount(shell(loading()));
      const [catalog, suppliers, purchases] = await Promise.all([
        api('/api/products'),
        api('/api/suppliers'),
        api('/api/supplier-purchases'),
      ]);
      state.products = catalog.products;
      state.suppliers = suppliers.suppliers;
      state.supplierPurchases = purchases.purchases;
      if (token !== renderToken) return;
      mount(shell(comprasView()));
      return;
    }
    if (path === '/panel/cargas') {
      mount(shell(loading()));
      state.products = (await api('/api/products')).products;
      if (token !== renderToken) return;
      mount(shell(cargasView()));
      document.getElementById('stock-search')?.focus();
      return;
    }
    if (path === '/panel/gastos') {
      mount(shell(loading()));
      state.expenses = (await api('/api/expenses?preset=month')).expenses;
      if (token !== renderToken) return;
      mount(shell(gastosView()));
      return;
    }
    if (path === '/panel/barra') {
      state.sheet = null;
      state.barraSale = null;
      state.barraPicks = {};
      mount(shell(loading()));
      state.barra = (await api(`/api/invoices?q=${encodeURIComponent(state.barraQuery || '')}`)).sales;
      if (token !== renderToken) return;
      mount(shell(barraView()));
      document.getElementById('barra-search')?.focus();
      if (state.pendingBarraId) {
        const id = state.pendingBarraId;
        state.pendingBarraId = 0;
        try {
          const opened = await api(`/api/invoices/${id}`);
          if (token !== renderToken) return;
          openBarraSale(opened.sale);
        } catch (error) {
          toast(error.message, 'bad');
        }
      }
      return;
    }
    if (path === '/panel/inventario') {
      mount(shell(loading()));
      const [catalog, rate] = await Promise.all([api('/api/products'), api('/api/rate')]);
      state.products = catalog.products;
      state.bcvRate = rate.rate;
      if (state.editingProduct) {
        state.editingProduct = state.products.find((product) => product.id === state.editingProduct.id) || null;
      }
      if (token !== renderToken) return;
      mount(shell(inventoryView()));
      updateProductProfit();
      updatePackHint();
      return;
    }
    if (path === '/panel/ventas') {
      mount(shell(loading()));
      const [tickets, products] = await Promise.all([
        api(`/api/sales?${salesParams()}`),
        api(`/api/sales?${productSalesParams()}`),
      ]);
      state.sales = tickets;
      state.productSales = products;
      state.salesError = '';
      state.salesQuery.preset = state.sales.preset;
      state.salesQuery.from = state.sales.from;
      state.salesQuery.to = state.sales.to;
      if (token !== renderToken) return;
      mount(shell(salesView()));
      return;
    }
    if (path === '/panel/movimientos') {
      mount(shell(loading()));
      state.moves = await api(`/api/movements?${movesParams()}`);
      state.moveError = '';
      state.moveQuery.preset = state.moves.preset;
      state.moveQuery.from = state.moves.from;
      state.moveQuery.to = state.moves.to;
      if (token !== renderToken) return;
      mount(shell(movementsView()));
      return;
    }
    if (path === '/panel/usuarios') {
      mount(shell(loading()));
      state.staff = (await api('/api/users')).users;
      if (state.editingUser) state.editingUser = state.staff.find((user) => user.id === state.editingUser.id) || null;
      if (token !== renderToken) return;
      mount(shell(usersView()));
      return;
    }
    if (path === '/panel/pantallas') {
      mount(shell(loading()));
      state.screens = (await api('/api/screens')).screens;
      if (token !== renderToken) return;
      mount(shell(screensView()));
      return;
    }
    if (path === '/panel/cuenta') {
      mount(shell(accountView()));
      return;
    }
    mount(`<div class="section"><div class="wrap"><h2>No está esa página</h2><p class="lead">Vuelve al inicio de ${esc(negocio.name)}.</p><a class="btn primary" href="/" data-link style="margin-top:16px">Ir al inicio</a></div></div>`);
  } catch (error) {
    if (token !== renderToken) return;
    if (path === '/panel/movimientos') {
      state.moves = null;
      state.moveError = error.message;
      mount(shell(movementsView()));
      return;
    }
    if (path === '/panel/ventas') {
      state.sales = null;
      state.productSales = null;
      state.salesError = error.message;
      mount(shell(salesView()));
      return;
    }
    mount(shell(`<div class="empty"><h2>No se pudo cargar</h2><p class="lead">${esc(error.message)}</p></div>`));
  }
}

function closeMenu() {
  document.querySelector('.sidebar')?.classList.remove('open');
  document.querySelector('.backdrop')?.classList.remove('show');
  document.body.classList.remove('nav-open');
}

function navigate(path) {
  closeMenu();
  let clean = path || '/';
  if (BASE && (clean === BASE || clean.startsWith(`${BASE}/`))) clean = clean.slice(BASE.length) || '/';
  clean = clean.replace(/\/+$/, '') || '/';
  if (currentPath() === clean) return render();
  history.pushState({}, '', appPath(clean));
  return render();
}

async function onSubmit(event) {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  const values = Object.fromEntries(new FormData(form).entries());
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  setFormError(form, '');
  try {
    if (kind === 'login') {
      state.user = (await api('/api/login', { method: 'POST', body: values })).user;
      watchBarraNotices();
      toast('Sesión iniciada.');
      await navigate('/panel');
      return;
    }
    if (kind === 'event') {
      const body = {
        name: values.name,
        price: values.price,
        active: Boolean(form.querySelector('input[name="active"]')?.checked),
      };
      if (state.editing) await api(`/api/events/${state.editing.id}`, { method: 'PATCH', body });
      else await api('/api/events', { method: 'POST', body });
      state.editing = null;
      toast(body.name ? 'Evento guardado.' : 'Evento guardado.');
      await render();
      return;
    }
    if (kind === 'ticket') {
      state.issued = await apiForm('/api/tickets', new FormData(form));
      toast('Entradas emitidas.');
      mount(shell(createView()));
      updateTotal();
      return;
    }
    if (kind === 'lookup') {
      await lookupCode(values.code);
      return;
    }
    if (kind === 'sales') {
      state.salesQuery = {
        preset: 'custom',
        from: values.from || '',
        to: values.to || '',
        q: String(values.q || '').trim(),
        product: String(values.product || '').trim(),
      };
      await render();
      return;
    }
    if (kind === 'moves') {
      state.moveQuery = {
        preset: 'custom',
        from: values.from || '',
        to: values.to || '',
        q: String(values.q || '').trim(),
        kind: state.moveQuery.kind,
      };
      await render();
      return;
    }
    if (kind === 'staff') {
      const permissions = [...form.querySelectorAll('input[name="module"]:checked')].map((input) => input.value);
      const isAdmin = Boolean(form.querySelector('input[name="isAdmin"]')?.checked);
      if (state.editingUser) {
        const body = { isAdmin, permissions };
        if (values.password) body.password = values.password;
        await api(`/api/users/${state.editingUser.id}`, { method: 'PATCH', body });
        state.editingUser = null;
        toast('Permisos guardados.');
      } else {
        await api('/api/users', {
          method: 'POST',
          body: { username: values.username, password: values.password, isAdmin, permissions },
        });
        toast('Usuario creado.');
      }
      await render();
      return;
    }
    if (kind === 'screen-pair') {
      const code = String(values.code || '').replace(/\s+/g, '');
      await api('/api/screens/pair', { method: 'POST', body: { code, name: values.name } });
      toast('Pantalla vinculada.');
      await render();
      return;
    }
    if (kind === 'screen-play') {
      const mediaKind = form.querySelector('input[name="kind"]:checked')?.value;
      const body = new FormData();
      body.set('kind', mediaKind || '');
      body.set('title', form.title.value);
      body.set('target', form.target.value);
      if (mediaKind === 'youtube') {
        body.set('youtube', form.youtube.value);
      } else if (form.file.files[0]) {
        const file = form.file.files[0];
        const onVercel = location.hostname.endsWith('vercel.app');
        if (mediaKind === 'video' && onVercel && file.size > 4 * 1024 * 1024) {
          const mb = (file.size / (1024 * 1024)).toFixed(0);
          setFormError(form, `Este video pesa ${mb} MB. Vercel solo acepta unos 4 MB. Ábrelo desde el dominio de la licorería en Render, o pega un enlace de YouTube.`);
          return;
        }
        if (file.size > 200 * 1024 * 1024) {
          setFormError(form, 'El video pesa más de 200 MB. Comprime el archivo o usa un enlace de YouTube.');
          return;
        }
        body.set('file', file);
      } else {
        setFormError(form, mediaKind === 'video' ? 'Selecciona un video.' : 'Selecciona una imagen.');
        return;
      }
      state.screens = (await apiForm('/api/screens/play', body)).screens;
      form.reset();
      toast('Contenido enviado a la pantalla.');
      mount(shell(screensView()));
      return;
    }
    if (kind === 'product') {
      const body = {
        code: values.code,
        name: values.name,
        department: values.department,
        cost: values.cost,
        costCurrency: values.costCurrency || 'usd',
        profit: values.profit,
        price: values.price,
        priceCurrency: values.priceCurrency || 'usd',
        stock: Number(values.stock),
        unitsPerBox: values.unitsPerBox === '' ? 1 : Number(values.unitsPerBox),
        active: Boolean(form.querySelector('input[name="active"]')?.checked),
        quickSale: Boolean(form.querySelector('input[name="quickSale"]')?.checked),
      };
      if (!state.editingProduct) body.pack = form.pack?.value || 'unit';
      if (!state.editingProduct) body.boxPrice = values.boxPrice || '';
      if (body.pack === 'box' && (!Number.isInteger(body.unitsPerBox) || body.unitsPerBox < 2)) {
        setFormError(form, 'Escribe cuántas unidades trae cada caja.');
        return;
      }
      if (!values.price && values.boxPrice && body.unitsPerBox >= 2) body.price = '';
      if ((values.costCurrency === 'bs' || values.priceCurrency === 'bs') && !(Number(state.bcvRate) > 0)) {
        setFormError(form, 'Coloca la tasa BCV antes de anotar un monto en bolívares.');
        return;
      }
      const image = form.querySelector('input[name="image"]')?.files?.[0];
      if (image && image.size > 8 * 1024 * 1024) {
        setFormError(form, 'La imagen debe pesar 8 MB o menos.');
        return;
      }
      const saved = state.editingProduct
        ? await api(`/api/products/${state.editingProduct.id}`, { method: 'PATCH', body })
        : await api('/api/products', { method: 'POST', body });
      if (image) {
        const fileBody = new FormData();
        fileBody.set('file', image);
        await apiForm(`/api/products/${saved.product.id}/image`, fileBody);
      }
      state.editingProduct = null;
      toast('Inventario actualizado.');
      await render();
      return;
    }
    if (kind === 'combo') {
      if (!state.comboParts.length) {
        setFormError(form, 'Agrega al menos un producto al combo.');
        return;
      }
      const payUsd = Boolean(form.querySelector('input[name="payUsd"]')?.checked);
      const payBs = Boolean(form.querySelector('input[name="payBs"]')?.checked);
      if (!payUsd && !payBs) {
        setFormError(form, 'Elige al menos una moneda: dólares o bolívares.');
        return;
      }
      const body = {
        name: values.name,
        code: values.code || '',
        price: values.price,
        active: Boolean(form.querySelector('input[name="active"]')?.checked),
        payUsd,
        payBs,
        items: state.comboParts.map((part) => ({ productId: part.productId, quantity: part.quantity })),
      };
      if (state.editingCombo) await api(`/api/combos/${state.editingCombo.id}`, { method: 'PATCH', body });
      else await api('/api/combos', { method: 'POST', body });
      state.editingCombo = null;
      state.comboParts = [];
      toast('Combo guardado.');
      await render();
      return;
    }
    if (kind === 'summary') {
      state.summaryQuery = {
        preset: values.preset || 'day',
        from: values.from || '',
        to: values.to || '',
        fromHour: values.fromHour || '',
        toHour: values.toHour || '',
      };
      await render();
      return;
    }
    if (kind === 'supplier') {
      await api('/api/suppliers', { method: 'POST', body: values });
      state.supplierOpen = false;
      toast('Proveedor guardado.');
      await render();
      return;
    }
    if (kind === 'supplier-purchase') {
      if (!state.buyLines.length) {
        setFormError(form, 'Agrega al menos un producto.');
        return;
      }
      if (state.buyLines.some((line) => lineUnits(line) == null || lineCostCents(line) == null)) {
        setFormError(form, 'Revisa la cantidad y el costo de cada producto.');
        return;
      }
      await api('/api/supplier-purchases', {
        method: 'POST',
        body: {
          supplierId: Number(values.supplierId),
          invoiceDate: values.invoiceDate,
          dueDate: values.dueDate,
          paymentMethod: values.paymentMethod,
          items: state.buyLines.map((line) => ({
            productId: line.productId,
            quantity: Number(line.quantity),
            cost: line.cost,
            profit: line.profit,
            price: line.price,
          })),
        },
      });
      state.buyLines = [];
      toast('Compra cargada al inventario.');
      await render();
      return;
    }
    if (kind === 'expense') {
      await api('/api/expenses', { method: 'POST', body: values });
      toast('Gasto anotado.');
      await render();
      return;
    }
    if (kind === 'password') {
      await api('/api/password', { method: 'POST', body: values });
      form.reset();
      toast('Contraseña actualizada.');
    }
  } catch (error) {
    if (kind === 'login') mount(loginView(error.message));
    else if (document.body.contains(form)) setFormError(form, error.message);
    else toast(error.message, 'bad');
  } finally {
    if (button && document.body.contains(button)) button.disabled = false;
  }
}

async function onClick(event) {
  const link = event.target.closest('a[data-link]');
  if (link) {
    event.preventDefault();
    await navigate(link.getAttribute('href'));
    return;
  }
  const stopped = event.target.closest('[data-stop]');
  const control = event.target.closest('[data-action]');
  if (stopped && (!control || !stopped.contains(control))) return;
  if (!control) return;
  const action = control.dataset.action;
  if (action === 'menu') {
    const open = document.querySelector('.sidebar')?.classList.toggle('open');
    document.querySelector('.backdrop')?.classList.toggle('show', open);
    document.body.classList.toggle('nav-open', open);
    return;
  }
  if (action === 'logout') {
    await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
    stopNotices();
    state.user = null;
    state.orderAlerts = [];
    renderOrderAlerts();
    toast('Sesión cerrada.');
    await navigate('/');
    return;
  }
  if (action === 'edit-event') {
    state.editing = state.events.find((item) => item.id === Number(control.dataset.id)) || null;
    mount(shell(eventsView()));
    return;
  }
  if (action === 'cancel-edit') {
    state.editing = null;
    mount(shell(eventsView()));
    return;
  }
  if (action === 'toggle-event') {
    const active = control.dataset.active !== '1';
    await api(`/api/events/${control.dataset.id}`, { method: 'PATCH', body: { active } });
    toast(active ? 'Evento activado.' : 'Evento desactivado.');
    await render();
    return;
  }
  if (action === 'delete-event') {
    if (!confirm('¿Eliminar este evento? Sale de la lista aunque tenga ventas. Las ventas ya hechas se conservan y se pueden filtrar por el nombre del evento.')) return;
    try {
      await api(`/api/events/${control.dataset.id}`, { method: 'DELETE' });
      if (state.editing?.id === Number(control.dataset.id)) state.editing = null;
      toast('Evento eliminado.');
      await render();
    } catch (error) {
      toast(error.message, 'bad');
    }
    return;
  }
  if (action === 'clear-issued') {
    state.issued = null;
    mount(shell(createView()));
    updateTotal();
    return;
  }
  if (action === 'print') {
    document.body.classList.add('printing');
    window.print();
    window.addEventListener('afterprint', () => document.body.classList.remove('printing'), { once: true });
    return;
  }
  if (action === 'download') {
    const ticket = state.issued?.tickets.find((item) => item.code === control.dataset.code) || state.detail;
    if (!ticket?.qrDataUrl) return;
    const anchor = document.createElement('a');
    anchor.href = ticket.qrDataUrl;
    anchor.download = `${ticket.code}.png`;
    anchor.click();
    return;
  }
  if (action === 'camera') {
    await startCamera();
    return;
  }
  if (action === 'stop-camera') {
    stopCamera();
    return;
  }
  if (action === 'use-ticket') {
    control.disabled = true;
    try {
      const data = await api(`/api/tickets/code/${encodeURIComponent(control.dataset.code)}/use`, { method: 'POST' });
      paintVisor(data.ticket, 'Ingreso registrado.');
      toast('Ingreso registrado.');
    } catch (error) {
      const ticket = error.data?.ticket;
      if (ticket && document.getElementById('visor-result')) paintVisor(ticket, error.message);
      else toast(error.message, 'bad');
    }
    return;
  }
  if (action === 'focus-code') {
    const input = document.querySelector('#lookup-form input[name="code"]');
    if (input) {
      input.value = '';
      input.focus();
    }
    return;
  }
  if (action === 'show-read') {
    await lookupCode(control.dataset.code);
    return;
  }
  if (action === 'open-buy') {
    event.preventDefault();
    event.stopPropagation();
    if (!state.currentTicket || state.currentTicket.status === 'expired') return;
    try {
      state.products = (await api('/api/products')).products;
      state.cart = [];
      buyGuard = Date.now() + 600;
      mountModal(buyModal());
      document.getElementById('buy-search')?.focus();
    } catch (error) {
      toast(error.message, 'bad');
    }
    return;
  }
  if (action === 'close-buy') {
    if (control.classList.contains('modal-back') && Date.now() < buyGuard) return;
    state.cart = [];
    document.querySelector('.modal-back')?.remove();
    return;
  }
  if (action === 'close-choice') {
    document.querySelector('[data-modal="sale-choice"]')?.closest('.modal-back')?.remove();
    return;
  }
  if (action === 'open-sale-choice') {
    const product = state.products.find((item) => item.id === Number(control.dataset.id));
    if (!product) return;
    document.querySelector('[data-modal="sale-choice"]')?.closest('.modal-back')?.remove();
    const host = document.querySelector('.shell') || document.body;
    host.insertAdjacentHTML('beforeend', saleChoiceModal(product));
    return;
  }
  if (action === 'pick-product') {
    const product = state.products.find((item) => item.id === Number(control.dataset.id));
    const quantity = Number(document.querySelector('#pos-qty')?.value || document.querySelector('#buy-qty')?.value);
    if (!product || product.stock < 1) {
      toast(product?.isCombo ? 'No alcanzan las unidades de ese combo.' : 'Ese producto no tiene existencias.', 'bad');
      return;
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      toast('Indica una cantidad.', 'bad');
      return;
    }
    if (product.isCombo) {
      for (const part of product.parts || []) {
        const source = state.products.find((item) => item.id === part.productId);
        const used = reservedUnits(part.productId);
        const left = source?.stock || 0;
        if (used + part.quantity * quantity > left) {
          toast(`No alcanzan ${part.name}. Quedan ${Math.max(0, left - used)}.`, 'bad');
          return;
        }
      }
    } else if (reservedUnits(product.id) + quantity > product.stock) {
      toast(`Solo quedan ${product.stock} de ${product.name}.`, 'bad');
      return;
    }
    const current = state.cart.find((line) => line.productId === product.id);
    if (current) current.quantity += quantity;
    else state.cart.push({ productId: product.id, name: product.name, priceCents: product.priceCents, quantity });
    document.querySelector('[data-modal="sale-choice"]')?.closest('.modal-back')?.remove();
    refreshBuyCart();
    refreshPosCart();
    return;
  }
  if (action === 'remove-cart') {
    state.cart = state.cart.filter((line) => line.productId !== Number(control.dataset.id));
    refreshBuyCart();
    refreshPosCart();
    return;
  }
  if (action === 'save-rate') {
    const rate = document.getElementById('bcv-rate')?.value || '';
    try {
      state.bcvRate = (await api('/api/rate', { method: 'PUT', body: { rate } })).rate;
      toast('Tasa BCV guardada.');
      const box = document.getElementById('pos-results');
      if (box) box.innerHTML = buyResultsHtml(document.getElementById('pos-search')?.value || '');
      refreshPosCart();
    } catch (error) {
      toast(error.message, 'bad');
    }
    return;
  }
  if (action === 'toggle-supplier') {
    state.supplierOpen = !state.supplierOpen;
    mount(shell(comprasView()));
    return;
  }
  if (action === 'pick-purchase') {
    addPurchaseProduct(state.products.find((item) => item.id === Number(control.dataset.id)));
    const search = document.getElementById('purchase-search');
    const results = document.getElementById('purchase-results');
    if (search) search.value = '';
    if (results) results.innerHTML = '';
    search?.focus();
    return;
  }
  if (action === 'remove-buy-line') {
    state.buyLines = state.buyLines.filter((line) => line.productId !== Number(control.dataset.id));
    const board = document.getElementById('purchase-lines');
    if (board) board.innerHTML = purchaseLinesHtml();
    refreshPurchaseTotals();
    return;
  }
  if (action === 'stock-move') {
    const productId = Number(control.dataset.id);
    const quantity = Number(document.querySelector(`[data-stock-qty="${productId}"]`)?.value);
    control.disabled = true;
    try {
      await api('/api/stock', {
        method: 'POST',
        body: { productId, quantity, direction: control.dataset.direction },
      });
      toast(control.dataset.direction === 'descarga' ? 'Descarga registrada.' : 'Carga registrada.');
      state.products = (await api('/api/products')).products;
      mount(shell(cargasView()));
    } catch (error) {
      toast(error.message, 'bad');
      control.disabled = false;
    }
    return;
  }
  if (action === 'charge-sale') {
    const customerName = document.getElementById('pos-name')?.value.trim() || '';
    const customerDocument = customerDocumentValue(document.getElementById('pos-document')?.value);
    if (customerName.length < 2) {
      toast('Escribe el nombre del cliente.', 'bad');
      return;
    }
    if (!validCustomerDocument(customerDocument)) {
      toast('Escribe la cédula del cliente.', 'bad');
      document.getElementById('pos-document')?.focus();
      return;
    }
    if (!state.cart.length) {
      toast('Agrega un producto a la venta.', 'bad');
      return;
    }
    mountModal(channelModal(customerName, customerDocument));
    document.getElementById('sale-reference')?.focus();
    return;
  }
  if (action === 'close-channel') {
    document.querySelector('[data-modal="channel"]')?.remove();
    return;
  }
  if (action === 'confirm-channel') {
    const customerName = document.getElementById('pos-name')?.value.trim() || '';
    const customerDocument = customerDocumentValue(document.getElementById('pos-document')?.value);
    const paymentReference = String(document.getElementById('sale-reference')?.value || '').trim().replace(/\s+/g, '');
    if (customerName.length < 2 || !validCustomerDocument(customerDocument) || !state.cart.length) {
      document.querySelector('[data-modal="channel"]')?.remove();
      toast('Revisa el cliente y los productos antes de cobrar.', 'bad');
      return;
    }
    if (!validPaymentReference(paymentReference)) {
      toast('Escribe el número de referencia.', 'bad');
      document.getElementById('sale-reference')?.focus();
      return;
    }
    control.disabled = true;
    const body = new FormData();
    body.set('customerName', customerName);
    body.set('customerDocument', customerDocument);
    body.set('paymentReference', paymentReference);
    body.set('paymentMethod', document.getElementById('pos-pay')?.value || 'efectivo');
    body.set('currency', state.saleCurrency === 'bs' ? 'bs' : 'usd');
    body.set('channel', control.dataset.channel === 'detal' ? 'detal' : 'barra');
    body.set('items', JSON.stringify(state.cart.map((line) => ({ productId: line.productId, quantity: line.quantity }))));
    const file = document.getElementById('pos-file')?.files?.[0];
    if (file) body.set('file', file);
    try {
      const data = await apiForm('/api/pos/sales', body);
      if (data.sale?.channel === 'barra') {
        state.skipNoticeId = data.sale.id;
        setNoticeCursor(data.sale.id);
      }
      state.cart = [];
      state.issuedSale = data.sale;
      document.querySelector('[data-modal="channel"]')?.remove();
      mount(shell(posView()));
      toast(data.sale?.channel === 'detal' ? 'Venta al detal lista.' : 'Factura en barra. El QR abre la cuenta.');
    } catch (error) {
      toast(error.message, 'bad');
      if (document.body.contains(control)) control.disabled = false;
    }
    return;
  }
  if (action === 'dismiss-notice') {
    const id = Number(control.dataset.id);
    state.orderAlerts = state.orderAlerts.filter((item) => item.id !== id);
    renderOrderAlerts();
    return;
  }
  if (action === 'open-notice') {
    const id = Number(control.dataset.id);
    state.orderAlerts = state.orderAlerts.filter((item) => item.id !== id);
    renderOrderAlerts();
    if (currentPath() === '/panel/barra') {
      try {
        const data = await api(`/api/invoices/${id}`);
        openBarraSale(data.sale);
      } catch (error) {
        toast(error.message, 'bad');
      }
      return;
    }
    state.pendingBarraId = id;
    await navigate('/panel/barra');
    return;
  }
  if (action === 'new-sale') {
    state.issuedSale = null;
    state.cart = [];
    mount(shell(posView()));
    document.getElementById('pos-name')?.focus();
    return;
  }
  if (action === 'confirm-purchase') {
    const paymentMethod = document.querySelector('#pay-method')?.value;
    if (!state.cart.length) {
      toast('Agrega un producto a la compra.', 'bad');
      return;
    }
    control.disabled = true;
    try {
      const data = await api(`/api/tickets/code/${encodeURIComponent(state.currentTicket.code)}/purchases`, {
        method: 'POST',
        body: {
          paymentMethod,
          items: state.cart.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        },
      });
      state.cart = [];
      paintVisor(data.ticket, 'Compra registrada.');
      toast('Compra registrada. El inventario ya se descontó.');
      document.querySelector('.modal-back')?.remove();
      await reloadBoard();
    } catch (error) {
      toast(error.message, 'bad');
      control.disabled = false;
    }
    return;
  }
  if (action === 'open-barra') {
    try {
      const data = await api(`/api/invoices/${control.dataset.id}`);
      openBarraSale(data.sale);
    } catch (error) {
      toast(error.message, 'bad');
    }
    return;
  }
  if (action === 'close-barra') {
    stopLive();
    state.barraSale = null;
    state.barraPicks = {};
    document.querySelector('.modal-back')?.remove();
    return;
  }
  if (action === 'toggle-invoice-unit') {
    const itemId = Number(control.dataset.item);
    const number = Number(control.dataset.n);
    const current = new Set(state.barraPicks[itemId] || []);
    if (current.has(number)) current.delete(number);
    else current.add(number);
    state.barraPicks[itemId] = [...current];
    paintBarraModal();
    return;
  }
  if (action === 'split-invoice-item') {
    const item = deliveryItems(state.barraSale).find((line) => line.id === Number(control.dataset.item));
    const open = item?.parts?.map((part) => `${part.quantity * item.quantity} ${part.name}`).join(', ') || 'sus unidades';
    if (!confirm(`¿Desglosar ${item?.productName || 'este combo'} en ${open}? Después cada unidad se entrega por separado y el total de la factura no cambia.`)) return;
    control.disabled = true;
    try {
      const data = await api(`/api/invoices/${control.dataset.id}/items/${control.dataset.item}/split`, { method: 'POST', body: {} });
      state.barraSale = data.sale;
      state.barraPicks = {};
      state.barra = state.barra.map((sale) => (sale.id === data.sale.id ? { ...sale, ...data.sale } : sale));
      const board = document.getElementById('barra-board');
      if (board) board.innerHTML = barraBoardHtml();
      paintBarraModal();
      toast('Combo desglosado. Ya puedes entregar cada unidad.');
    } catch (error) {
      toast(error.message, 'bad');
      if (document.body.contains(control)) control.disabled = false;
    }
    return;
  }
  if (action === 'deliver-invoice') {
    const lines = Object.entries(state.barraPicks)
      .filter(([, units]) => units.length)
      .map(([itemId, units]) => ({ itemId: Number(itemId), units }));
    if (!lines.length) {
      toast('Selecciona los números que vas a entregar.', 'bad');
      return;
    }
    control.disabled = true;
    try {
      const data = await api(`/api/invoices/${control.dataset.id}/deliver`, { method: 'POST', body: { lines } });
      state.barraSale = data.sale;
      state.barraPicks = {};
      state.barra = state.barra.map((sale) => (sale.id === data.sale.id ? { ...sale, ...data.sale } : sale));
      const board = document.getElementById('barra-board');
      if (board) board.innerHTML = barraBoardHtml();
      paintBarraModal();
      toast('Entrega registrada.');
    } catch (error) {
      toast(error.message, 'bad');
      if (document.body.contains(control)) control.disabled = false;
    }
    return;
  }
  if (action === 'refund-invoice') {
    if (!confirm('¿Devolver esta factura? Se cancela y las cantidades vuelven al inventario.')) return;
    control.disabled = true;
    try {
      const data = await api(`/api/invoices/${control.dataset.id}/refund`, { method: 'POST', body: {} });
      state.barraSale = data.sale;
      state.barraPicks = {};
      state.barra = state.barra.map((sale) => (sale.id === data.sale.id ? { ...sale, ...data.sale } : sale));
      const board = document.getElementById('barra-board');
      if (board) board.innerHTML = barraBoardHtml();
      paintBarraModal();
      toast('Factura devuelta. El inventario volvió.');
    } catch (error) {
      toast(error.message, 'bad');
      if (document.body.contains(control)) control.disabled = false;
    }
    return;
  }
  if (action === 'refund-sale') {
    if (!confirm('¿Devolver esta compra? Se cancela la factura y las cantidades vuelven al inventario.')) return;
    control.disabled = true;
    try {
      const data = await api(`/api/purchases/${control.dataset.id}/refund`, { method: 'POST', body: {} });
      const fresh = await api(`/api/barra/sales/${control.dataset.id}`);
      state.barraSale = fresh.sale;
      state.barra = state.barra.map((sale) => (sale.id === data.sale.id ? { ...sale, ...data.sale } : sale));
      const board = document.getElementById('barra-board');
      if (board) board.innerHTML = barraBoardHtml();
      mountModal(barraModal());
      if (state.currentTicket && data.ticket && state.currentTicket.code === data.ticket.code) paintVisor(data.ticket);
      toast('Compra devuelta. La factura quedó cancelada y el inventario volvió.');
    } catch (error) {
      toast(error.message, 'bad');
      if (document.body.contains(control)) control.disabled = false;
    }
    return;
  }
  if (action === 'open-sheet') {
    const sale = findSale(control.dataset.id);
    if (!sale) {
      toast('No se encontró esa venta.', 'bad');
      return;
    }
    state.sheet = { ...sale, selected: [] };
    mountModal(sheetModal());
    return;
  }
  if (action === 'toggle-unit') {
    const sheet = state.sheet;
    const number = Number(control.dataset.n);
    if (!sheet || !Number.isInteger(number)) return;
    if ((sheet.deliveredUnits || []).includes(number)) return;
    if (sheet.selected.includes(number)) sheet.selected = sheet.selected.filter((value) => value !== number);
    else sheet.selected.push(number);
    sheet.selected.sort((left, right) => left - right);
    paintSheet();
    return;
  }
  if (action === 'close-sheet') {
    state.sheet = null;
    document.querySelector('.modal-back')?.remove();
    return;
  }
  if (action === 'confirm-sheet') {
    const sheet = state.sheet;
    if (!sheet?.selected?.length) {
      toast('Selecciona los números que vas a entregar.', 'bad');
      return;
    }
    control.disabled = true;
    try {
      const data = await api(`/api/purchases/${sheet.purchaseId}/deliver`, {
        method: 'POST',
        body: { lines: [{ itemId: sheet.itemId, units: sheet.selected }] },
      });
      if (state.currentTicket?.code === data.ticket.code) paintVisor(data.ticket, 'Entrega registrada.');
      await reloadBoard();
      toast(sheet.selected.length === 1 ? 'Se entregó 1.' : `Se entregaron ${sheet.selected.length}.`);
    } catch (error) {
      toast(error.message, 'bad');
      if (document.body.contains(control)) control.disabled = false;
    }
    return;
  }
  if (action === 'edit-product') {
    state.editingProduct = state.products.find((item) => item.id === Number(control.dataset.id)) || null;
    mount(shell(inventoryView()));
    updateProductProfit();
    updatePackHint();
    return;
  }
  if (action === 'cancel-product') {
    state.editingProduct = null;
    mount(shell(inventoryView()));
    updateProductProfit();
    updatePackHint();
    return;
  }
  if (action === 'add-combo-part') {
    const productId = Number(document.querySelector('#combo-product')?.value);
    const quantity = Number(document.querySelector('#combo-qty')?.value);
    const product = state.products.find((item) => item.id === productId && !item.isCombo);
    if (!product) {
      toast('Primero carga el producto en el inventario.', 'bad');
      return;
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
      toast('Indica cuántas unidades lleva el combo.', 'bad');
      return;
    }
    const current = state.comboParts.find((part) => part.productId === product.id);
    if (current) current.quantity = Math.min(500, current.quantity + quantity);
    else state.comboParts.push({ productId: product.id, quantity });
    refreshComboParts();
    return;
  }
  if (action === 'remove-combo-part') {
    state.comboParts.splice(Number(control.dataset.index), 1);
    refreshComboParts();
    return;
  }
  if (action === 'edit-combo') {
    const item = state.products.find((product) => product.id === Number(control.dataset.id) && product.isCombo);
    if (!item) return;
    state.editingProduct = null;
    state.editingCombo = item;
    state.comboParts = (item.parts || []).map((part) => ({ productId: part.productId, quantity: part.quantity }));
    mount(shell(inventoryView()));
    return;
  }
  if (action === 'cancel-combo') {
    state.editingCombo = null;
    state.comboParts = [];
    mount(shell(inventoryView()));
    updateProductProfit();
    updatePackHint();
    return;
  }
  if (action === 'delete-combo') {
    if (!confirm('¿Eliminar este combo? Sale del inventario aunque ya se haya vendido. Las facturas ya hechas se conservan.')) return;
    try {
      await api(`/api/combos/${control.dataset.id}`, { method: 'DELETE' });
      if (state.editingCombo?.id === Number(control.dataset.id)) {
        state.editingCombo = null;
        state.comboParts = [];
      }
      toast('Combo eliminado.');
      await render();
    } catch (error) {
      toast(error.message, 'bad');
    }
    return;
  }
  if (action === 'toggle-product') {
    const active = control.dataset.active !== '1';
    const product = state.products.find((item) => item.id === Number(control.dataset.id));
    await api(`/api/products/${control.dataset.id}`, { method: 'PATCH', body: { active } });
    toast(active ? (product?.isCombo ? 'Combo activado.' : 'Producto activado.') : (product?.isCombo ? 'Combo desactivado.' : 'Producto desactivado.'));
    await render();
    return;
  }
  if (action === 'add-stock') {
    const input = document.querySelector(`[data-add-stock="${control.dataset.id}"]`);
    const pack = document.querySelector(`[data-add-pack="${control.dataset.id}"]`)?.value || 'unit';
    const addStock = Number(input?.value);
    const product = state.products.find((item) => item.id === Number(control.dataset.id));
    if (!Number.isInteger(addStock) || addStock < 1) {
      toast('Indica una cantidad entera.', 'bad');
      return;
    }
    if (pack === 'box' && (!product || product.unitsPerBox < 2)) {
      toast('Edita el producto y pon cuántas unidades trae la caja.', 'bad');
      return;
    }
    await api(`/api/products/${control.dataset.id}`, { method: 'PATCH', body: { addStock, pack } });
    const units = pack === 'box' ? addStock * product.unitsPerBox : addStock;
    toast(pack === 'box'
      ? `Se sumaron ${units.toLocaleString('es-ES')} unidades (${addStock.toLocaleString('es-ES')} cajas).`
      : 'Existencias actualizadas.');
    await render();
    return;
  }
  if (action === 'delete-product') {
    if (!confirm('¿Eliminar este producto? Sale del inventario aunque tenga ventas. Las facturas ya hechas se conservan.')) return;
    try {
      await api(`/api/products/${control.dataset.id}`, { method: 'DELETE' });
      if (state.editingProduct?.id === Number(control.dataset.id)) state.editingProduct = null;
      toast('Producto eliminado.');
      await render();
    } catch (error) {
      toast(error.message, 'bad');
    }
    return;
  }
  if (action === 'move-preset' || action === 'move-kind') {
    const form = document.getElementById('moves-form');
    state.moveQuery = {
      preset: action === 'move-preset' ? control.dataset.preset : (state.moveQuery.preset === 'all' ? 'all' : 'custom'),
      from: form?.from.value || '',
      to: form?.to.value || '',
      q: form?.q.value.trim() || '',
      kind: action === 'move-kind' ? control.dataset.kind : state.moveQuery.kind,
    };
    await render();
    return;
  }
  if (action === 'edit-user') {
    state.editingUser = state.staff.find((user) => user.id === Number(control.dataset.id)) || null;
    mount(shell(usersView()));
    return;
  }
  if (action === 'cancel-user') {
    state.editingUser = null;
    mount(shell(usersView()));
    return;
  }
  if (action === 'delete-user') {
    if (!confirm('¿Eliminar este usuario? Ya no podrá entrar.')) return;
    await api(`/api/users/${control.dataset.id}`, { method: 'DELETE' });
    if (state.editingUser?.id === Number(control.dataset.id)) state.editingUser = null;
    toast('Usuario eliminado.');
    await render();
    return;
  }
  if (action === 'link-screen') {
    const input = document.querySelector(`[data-screen-name="${control.dataset.id}"]`);
    await api(`/api/screens/${control.dataset.id}/link`, { method: 'POST', body: { name: input?.value || '' } });
    toast('Pantalla vinculada.');
    await render();
    return;
  }
  if (action === 'clear-screen') {
    await api(`/api/screens/${control.dataset.id}/clear`, { method: 'POST', body: {} });
    toast('Contenido quitado.');
    await render();
    return;
  }
  if (action === 'delete-screen') {
    if (!confirm('¿Quitar esta pantalla? Tendrá que volver a mostrar un código.')) return;
    await api(`/api/screens/${control.dataset.id}`, { method: 'DELETE' });
    toast('Pantalla quitada.');
    await render();
    return;
  }
  if (action === 'share-screen') {
    const select = document.querySelector(`[data-share-target="${control.dataset.id}"]`);
    const target = select?.value || '';
    if (!target) {
      toast('Elige la pantalla que va a recibir lo que se está viendo.', 'bad');
      return;
    }
    state.screens = (await api(`/api/screens/${control.dataset.id}/share`, { method: 'POST', body: { target } })).screens;
    toast('Compartido. Si es un video, el otro televisor sigue en el mismo segundo.');
    mount(shell(screensView()));
    return;
  }
  if (action === 'preset') {
    const form = document.getElementById('sales-form');
    state.salesQuery = {
      preset: control.dataset.preset,
      from: form?.from.value || '',
      to: form?.to.value || '',
      q: form?.q.value.trim() || '',
      product: form?.product.value.trim() || '',
    };
    await render();
    return;
  }
  if (action === 'detail') {
    try {
      state.detail = (await api(`/api/tickets/code/${encodeURIComponent(control.dataset.code)}`)).ticket;
      document.querySelector('.modal-back')?.remove();
      document.querySelector('.content')?.insertAdjacentHTML('beforeend', detailModal());
    } catch (error) {
      toast(error.message, 'bad');
    }
    return;
  }
  if (action === 'close-detail') {
    state.detail = null;
    document.querySelector('.modal-back')?.remove();
  }
}

document.addEventListener('pointerdown', unlockSound);
document.addEventListener('click', (event) => {
  onClick(event).catch((error) => toast(error.message || 'No se pudo completar la acción.', 'bad'));
});
document.addEventListener('submit', (event) => {
  onSubmit(event).catch((error) => toast(error.message || 'No se pudo completar la acción.', 'bad'));
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const form = event.target.closest?.('form[data-form="supplier-purchase"]');
  if (!form || event.target.closest('button[type="submit"]')) return;
  event.preventDefault();
  if (event.target.id !== 'purchase-search') return;
  const matches = purchaseMatches(event.target.value);
  if (matches.length === 1) {
    addPurchaseProduct(matches[0]);
    event.target.value = '';
    const results = document.getElementById('purchase-results');
    if (results) results.innerHTML = '';
  } else if (matches.length > 1) toast('Elige el producto en la lista para agregarlo.', 'bad');
});
document.addEventListener('input', (event) => {
  if (event.target.closest('#ticket-form')) updateTotal();
  if (event.target.closest('form[data-form="product"]')) refreshProductMoney(event.target);
  const buyField = event.target.closest('#purchase-lines [data-field]');
  if (buyField) {
    const row = buyField.closest('[data-line]');
    const line = state.buyLines.find((item) => item.productId === Number(row?.dataset.line));
    if (line) {
      line[buyField.dataset.field] = buyField.value;
      const unitCost = purchaseUnitCost(line);
      if (buyField.dataset.field === 'price' && unitCost != null) {
        const price = centsFromInput(line.price);
        if (price != null) {
          line.profit = moneyInput(price - unitCost);
          const profit = row.querySelector('[data-field="profit"]');
          if (profit) profit.value = line.profit;
        }
      }
      if ((buyField.dataset.field === 'profit' || buyField.dataset.field === 'cost') && unitCost != null) {
        const profit = centsFromInput(line.profit);
        if (profit != null) {
          line.price = moneyInput(unitCost + profit);
          const price = row.querySelector('[data-field="price"]');
          if (price) price.value = line.price;
        }
      }
      refreshPurchaseTotals();
    }
  }
  if (event.target.id === 'purchase-search') {
    const box = document.getElementById('purchase-results');
    if (box) box.innerHTML = purchaseResultsHtml(event.target.value);
  }
  if (event.target.id === 'stock-search') {
    state.inventoryQuery = event.target.value;
    const board = document.getElementById('stock-board');
    if (board) board.innerHTML = stockBoardHtml();
  }
  if (event.target.id === 'bcv-rate') {
    const rate = Number(String(event.target.value || '').trim().replace(/\s/g, '').replace(',', '.'));
    state.bcvRate = Number.isFinite(rate) && rate > 0 ? rate : 0;
    const box = document.getElementById('pos-results');
    if (box) box.innerHTML = buyResultsHtml(document.getElementById('pos-search')?.value || '');
    refreshPosCart();
  }
  if (event.target.id === 'inventory-search') {
    state.inventoryQuery = event.target.value;
    const products = document.getElementById('inventory-board');
    const combos = document.getElementById('combo-board');
    if (products) products.innerHTML = productListHtml();
    if (combos) combos.innerHTML = comboBoardHtml(state.products.filter((product) => product.isCombo));
  }
  if (event.target.id === 'buy-search' || event.target.id === 'pos-search') {
    const box = document.getElementById(event.target.id === 'pos-search' ? 'pos-results' : 'buy-results');
    if (box) box.innerHTML = buyResultsHtml(event.target.value);
  }
  if (event.target.id === 'barra-search') {
    state.barraQuery = event.target.value;
    clearTimeout(salesTimer);
    salesTimer = setTimeout(() => {
      api(`/api/invoices?q=${encodeURIComponent(state.barraQuery || '')}`)
        .then((data) => {
          if (event.target.value !== state.barraQuery) return;
          state.barra = data.sales;
          const board = document.getElementById('barra-board');
          if (board) board.innerHTML = barraBoardHtml();
        })
        .catch((error) => toast(error.message, 'bad'));
    }, 180);
  }
  if (event.target.id === 'sales-search') {
    state.boardQuery = event.target.value;
    clearTimeout(salesTimer);
    salesTimer = setTimeout(() => {
      reloadBoard().catch((error) => toast(error.message, 'bad'));
    }, 180);
  }
});
document.addEventListener('change', (event) => {
  if (event.target.closest('#sales-form') && event.target.name === 'q' && event.target.tagName === 'SELECT') {
    state.salesQuery.q = event.target.value;
    state.salesQuery.product = document.getElementById('sales-form')?.product.value.trim() || '';
    render().catch((error) => toast(error.message, 'bad'));
    return;
  }
  if (event.target.closest('form[data-form="product"]')) refreshProductMoney(event.target);
  if (event.target.id === 'pos-currency') {
    state.saleCurrency = event.target.value === 'bs' ? 'bs' : 'usd';
    state.cart = state.cart.filter((line) => {
      const product = state.products.find((item) => item.id === line.productId);
      return product && acceptsCurrency(product);
    });
    const box = document.getElementById('pos-results');
    if (box) box.innerHTML = buyResultsHtml(document.getElementById('pos-search')?.value || '');
    const quick = document.getElementById('quick-sale');
    if (quick) quick.innerHTML = quickSaleHtml();
    refreshPosCart();
  }
  if (event.target.closest('#ticket-form')) updateTotal();
  const payment = event.target.closest('select[data-pay]');
  if (payment) {
    api(`/api/purchases/${payment.dataset.pay}/payment`, {
      method: 'PATCH',
      body: { paymentMethod: payment.value },
    }).then((data) => {
      paintVisor(data.ticket);
      toast('Método de pago actualizado.');
    }).catch((error) => toast(error.message, 'bad'));
  }
  const input = event.target.closest('input[data-file="qr"]');
  if (input?.files?.[0]) {
    const file = input.files[0];
    input.value = '';
    scanFile(file);
    return;
  }
  const receipt = event.target.closest('input[data-receipt]');
  if (receipt?.files?.[0]) {
    const file = receipt.files[0];
    const purchaseId = receipt.dataset.receipt;
    receipt.value = '';
    const body = new FormData();
    body.set('file', file);
    apiForm(`/api/purchases/${purchaseId}/receipt`, body)
      .then(() => {
        toast('Comprobante guardado.');
        return render();
      })
      .catch((error) => toast(error.message, 'bad'));
  }
  if (event.target.matches('input[name="kind"]') && event.target.closest('[data-form="screen-play"]')) {
    const form = event.target.form;
    const youtube = event.target.value === 'youtube';
    const fileField = form.querySelector('#screen-file-field');
    const youtubeField = form.querySelector('#screen-youtube-field');
    if (fileField) fileField.hidden = youtube;
    if (youtubeField) youtubeField.hidden = !youtube;
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.querySelector('[data-modal="channel"]')) {
    document.querySelector('[data-modal="channel"]')?.remove();
    return;
  }
  if (event.key === 'Escape') {
    state.detail = null;
    state.delivery = null;
    state.cart = [];
    document.querySelector('.modal-back')?.remove();
    document.querySelector('.sidebar')?.classList.remove('open');
    document.querySelector('.backdrop')?.classList.remove('show');
    document.body.classList.remove('nav-open');
  }
});
window.addEventListener('popstate', () => render());

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
}

api('/api/me', { soft: true })
  .then((data) => {
    state.user = data.user || null;
  })
  .catch(() => {
    state.user = null;
  })
  .finally(() => {
    watchBarraNotices();
    return render();
  });
