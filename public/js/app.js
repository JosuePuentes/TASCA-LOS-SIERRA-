const state = {
  user: null,
  events: [],
  editing: null,
  issued: null,
  dash: null,
  sales: null,
  salesError: '',
  salesQuery: { preset: 'day', from: '', to: '', q: '' },
  detail: null,
  reads: [],
  products: [],
  editingProduct: null,
  currentTicket: null,
  cart: [],
  delivery: null,
  moves: null,
  moveQuery: { preset: 'month', from: '', to: '', q: '', kind: '' },
  moveError: '',
  staff: [],
  editingUser: null,
  screens: [],
};

const MODULES = [
  ['resumen', 'Resumen'],
  ['eventos', 'Eventos y precios'],
  ['entradas', 'Emitir entradas'],
  ['visor', 'Visor QR'],
  ['inventario', 'Inventario'],
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

const titles = {
  '/': 'Tasca Los Sierra',
  '/acceso': 'Acceso · Tasca Los Sierra',
  '/panel': 'Panel · Tasca Los Sierra',
  '/panel/eventos': 'Eventos y precios · Tasca Los Sierra',
  '/panel/entradas': 'Emitir entradas · Tasca Los Sierra',
  '/panel/visor': 'Visor QR · Tasca Los Sierra',
  '/panel/inventario': 'Inventario · Tasca Los Sierra',
  '/panel/ventas': 'Ventas · Tasca Los Sierra',
  '/panel/movimientos': 'Movimientos · Tasca Los Sierra',
  '/panel/pantallas': 'Pantallas · Tasca Los Sierra',
  '/panel/usuarios': 'Usuarios · Tasca Los Sierra',
  '/panel/cuenta': 'Cuenta · Tasca Los Sierra',
  '/pantalla': 'Pantalla · Tasca Los Sierra',
};

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

function formatDateTime(iso) {
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
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
  return PAYMENTS.find(([key]) => key === value)?.[1] || 'Sin definir';
}

function paymentOptions(selected) {
  return PAYMENTS.map(([key, label]) => `<option value="${key}" ${key === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function normalizeCode(raw) {
  const text = String(raw || '').trim().toUpperCase();
  const match = text.match(/LS-[A-F0-9]{10}/);
  return match ? match[0] : text;
}

function currentPath() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  return path;
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
  const response = await fetch(path, {
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
        history.replaceState({}, '', '/acceso');
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
  document.getElementById('app').innerHTML = html;
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
    ['/panel/eventos', 'Eventos y precios', 'eventos'],
    ['/panel/entradas', 'Emitir entradas', 'entradas'],
    ['/panel/visor', 'Visor QR', 'visor'],
    ['/panel/inventario', 'Inventario', 'inventario'],
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
        <a class="brand brand-light" href="/" data-link>${mark()}<span>Los Sierra</span></a>
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
          <a class="brand" href="/" data-link>${mark()}<span>Tasca Los Sierra</span></a>
          <nav class="nav-links">
            <a class="btn amber small" href="${state.user ? '/panel' : '/acceso'}" data-link>${state.user ? 'Panel' : 'Acceso'}</a>
          </nav>
        </div>
      </header>
      <section class="hero">
        <div class="wrap">
          <p class="eyebrow">Noche electro</p>
          <h1>Tasca Los Sierra</h1>
          <p class="lead">Disfruta tu noche.</p>
          <div class="eq" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
        </div>
      </section>
    </div>`;
}

function loginView(error = '') {
  return `
    <div class="login-split public">
      <aside class="login-aside">
        <a class="brand" href="/" data-link>${mark()}<span>Tasca Los Sierra</span></a>
        <div>
          <p class="eyebrow">Personal</p>
          <h1>La puerta de la noche.</h1>
          <p class="lead" style="margin-top:16px">Desde aquí se publican las sesiones, se emiten las entradas y se comprueban los códigos.</p>
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
  const dash = state.dash;
  return `
    <h2>Resumen</h2>
    <p class="lead page-lead">Los códigos vigentes caducan a las 12 horas de emitirse.</p>
    <div class="grid-stats">
      <article class="stat"><p class="stat-label">Vigentes ahora</p><p class="stat-value">${dash.active}</p></article>
      <article class="stat"><p class="stat-label">Por vencer en 2 h</p><p class="stat-value">${dash.expiringSoon}</p></article>
      <article class="stat"><p class="stat-label">Entradas de hoy</p><p class="stat-value">${dash.soldToday}</p></article>
      <article class="stat"><p class="stat-label">Ingresos del mes</p><p class="stat-value">${money(dash.revenueMonth)}</p></article>
    </div>
    <div class="actions no-print">
      ${allow('entradas') ? '<a class="btn primary" href="/panel/entradas" data-link>Emitir entradas</a>' : ''}
      ${allow('visor') ? '<a class="btn ghost" href="/panel/visor" data-link>Abrir visor</a>' : ''}
      ${allow('ventas') ? '<a class="btn ghost" href="/panel/ventas" data-link>Ver ventas</a>' : ''}
    </div>
    <section class="card">
      <h3>Últimas emisiones</h3>
      <div style="height:12px"></div>
      ${ticketRows(dash.recent)}
    </section>`;
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
              <p class="stub-kicker">Tasca Los Sierra</p>
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
        <label class="field"><span>Método de pago</span><select name="paymentMethod" required>${paymentOptions('efectivo')}</select></label>
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
  const cost = centsFromInput(form.cost.value);
  const price = centsFromInput(form.price.value);
  if (cost == null || price == null) {
    box.textContent = 'Escribe el costo y el precio de venta para ver la utilidad.';
    return;
  }
  const profit = price - cost;
  const percent = price > 0 ? (profit / price) * 100 : null;
  const percentText = percent == null ? '' : ` · ${percent.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
  box.textContent = `Utilidad por unidad: ${money(profit)}${percentText}`;
  box.classList.toggle('loss', profit < 0);
}

function updatePackHint() {
  const form = document.querySelector('form[data-form="product"]');
  const hint = document.getElementById('pack-hint');
  const label = document.getElementById('stock-label');
  if (!form || !hint) return;
  const pack = form.pack?.value || 'unit';
  const perBox = Number(form.unitsPerBox?.value);
  const count = Number(form.stock?.value);
  if (label) label.textContent = pack === 'box' ? 'Cajas' : 'Existencias en unidades';
  if (pack !== 'box') {
    hint.textContent = 'Esto queda en unidades. En el visor se vende de una en una.';
    return;
  }
  if (!Number.isInteger(perBox) || perBox < 2) {
    hint.textContent = 'Escribe cuántas unidades trae cada caja.';
    return;
  }
  if (!Number.isInteger(count) || count < 1) {
    hint.textContent = `Cada caja suma ${perBox} unidades.`;
    return;
  }
  hint.textContent = `${count.toLocaleString('es-ES')} cajas × ${perBox.toLocaleString('es-ES')} = ${(count * perBox).toLocaleString('es-ES')} unidades.`;
}

function inventoryView() {
  const editing = state.editingProduct;
  const products = state.products;
  const costValue = products.reduce((sum, product) => sum + product.stockCostCents, 0);
  const saleValue = products.reduce((sum, product) => sum + product.stockSaleCents, 0);
  const profitValue = products.reduce((sum, product) => sum + product.stockProfitCents, 0);
  const list = products.length
    ? `<div class="event-list">${products.map((product) => `
        <article class="event-row ${product.active ? '' : 'inactive'}">
          <div>
            <h3>${esc(product.name)}</h3>
            <p class="price-line">Costo ${money(product.costCents)} · Venta ${money(product.priceCents)} · ${product.stock.toLocaleString('es-ES')} en existencia · ${product.active ? 'A la venta' : 'Inactivo'}</p>
            <p class="price-line">${product.unitsPerBox > 1 ? `Caja de ${product.unitsPerBox.toLocaleString('es-ES')} unidades · ` : ''}Utilidad ${money(product.profitCents)} por unidad · ${money(product.stockProfitCents)} en estas existencias</p>
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
        </article>`).join('')}</div>`
    : `<div class="empty"><h3>El inventario está vacío</h3><p class="lead">Carga cada producto con su costo, su precio de venta y las unidades que tienes.</p></div>`;
  const stockValue = editing ? String(editing.stock) : '';
  const costField = editing ? moneyInput(editing.costCents) : '';
  const priceValue = editing ? moneyInput(editing.priceCents) : '';
  return `
    <div class="stack">
      <form class="card product-form" data-form="product">
        <h2>${editing ? 'Editar producto' : 'Cargar producto'}</h2>
        <p class="lead page-lead">El costo y el precio son por unidad. Si llega por caja, escribe cuántas unidades trae: 10 cajas de 36 quedan en 360 unidades. La venta sigue siendo por unidad.</p>
        <label class="field"><span>Producto</span><input name="name" maxlength="80" required value="${esc(editing?.name || '')}" placeholder="Nombre del producto"></label>
        <label class="field"><span>Costo</span><input name="cost" inputmode="decimal" required value="${esc(costField)}" placeholder="0,00"></label>
        <label class="field"><span>Precio de venta</span><input name="price" inputmode="decimal" required value="${esc(priceValue)}" placeholder="0,00"></label>
        <p class="hint" id="product-profit">Escribe el costo y el precio de venta para ver la utilidad.</p>
        <label class="field"><span>Unidades por caja</span><input name="unitsPerBox" type="number" min="1" max="10000" value="${editing ? esc(String(editing.unitsPerBox || 1)) : ''}" placeholder="36"></label>
        ${editing ? '' : `<label class="field"><span>Cómo llega</span><select name="pack"><option value="unit">Por unidad</option><option value="box">Por caja</option></select></label>`}
        <label class="field"><span id="stock-label">${editing ? 'Existencias en unidades' : 'Existencias'}</span><input name="stock" type="number" min="0" max="1000000" required value="${esc(stockValue)}" placeholder="0"></label>
        <p class="hint" id="pack-hint">${editing ? 'Al editar, las existencias se guardan en unidades. Para meter cajas usa Sumar.' : 'Esto queda en unidades. En el visor se vende de una en una.'}</p>
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
        ${list}
      </section>
    </div>`;
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
        <strong>${money(purchase.totalCents)}</strong>
        <select data-pay="${purchase.id}" aria-label="Método de pago">${paymentOptions(purchase.paymentMethod)}</select>
      </div>
      ${purchase.items.map((item) => `
        <div class="balance">
          <div>
            <strong>${esc(item.productName)}</strong>
            <p class="hint">${item.quantity} facturadas · ${money(item.totalCents)} · Entregadas ${item.delivered} · Quedan ${item.remaining}</p>
          </div>
          ${item.remaining > 0 ? `<button class="btn small primary" type="button" data-action="deliver-item" data-purchase="${purchase.id}" data-item="${item.id}">Entregar</button>` : '<span class="badge ok">Entregado</span>'}
        </div>`).join('')}
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
  return state.products
    .filter((product) => product.active)
    .filter((product) => !text || product.name.toLocaleLowerCase('es').includes(text))
    .slice(0, 20);
}

function buyResultsHtml(query) {
  if (!state.products.some((product) => product.active)) return `<p class="hint">El inventario está vacío. Carga productos antes de vender.</p>`;
  const matches = buyMatches(query);
  if (!matches.length) return `<p class="hint">Ningún producto coincide.</p>`;
  return matches.map((product) => `
    <button class="buy-hit" type="button" data-action="pick-product" data-id="${product.id}" ${product.stock < 1 ? 'disabled' : ''}>
      <strong>${esc(product.name)}</strong>
      <span>${money(product.priceCents)} · ${product.stock < 1 ? 'sin existencias' : `quedan ${product.stock}`}</span>
    </button>`).join('');
}

function cartLinesHtml() {
  if (!state.cart.length) return `<p class="hint">Todavía no agregas productos a esta compra.</p>`;
  return state.cart.map((line) => `
    <div class="balance">
      <div><strong>${esc(line.name)}</strong><p class="hint">${line.quantity} · ${money(line.priceCents * line.quantity)}</p></div>
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

function buyModal() {
  return `
    <div class="modal-back" data-action="close-buy">
      <article class="modal card wide" data-stop>
        <p class="stub-kicker">${esc(state.currentTicket?.code || '')}</p>
        <h2 style="font-size:36px">Nueva compra</h2>
        <p class="lead page-lead">Busca en el inventario y agrega lo que se va a facturar. Al registrar, se restan las existencias.</p>
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

function deliverModal() {
  const delivery = state.delivery;
  if (!delivery) return '';
  const lines = delivery.lines.map((line) => `
    <div class="balance">
      <div>
        <strong>${esc(line.productName)}</strong>
        <p class="hint">Compró ${line.quantity} · Entregadas ${line.delivered} · Quedan ${line.remaining}</p>
      </div>
      <label class="field" style="margin:0;width:140px">
        <span>Entregar ahora</span>
        <input data-item="${line.id}" type="number" min="1" max="${line.remaining}" placeholder="Cuántas">
      </label>
    </div>`).join('');
  return `
    <div class="modal-back" data-action="close-deliver">
      <article class="modal card wide" data-stop>
        <h2 style="font-size:36px">Entregar</h2>
        <p class="lead page-lead">Elige cuántas entregar ahora. No puedes pasar de las que facturaste.</p>
        <div id="deliver-lines" data-purchase="${delivery.purchaseId}">${lines}</div>
        <div class="row-actions" style="margin-top:16px">
          <button class="btn primary" type="button" data-action="confirm-delivery">Entregar ahora</button>
          <button class="btn ghost" type="button" data-action="close-deliver">Dejar para después</button>
        </div>
      </article>
    </div>`;
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
  const chart = sales && sales.totals.tickets
    ? `<section class="card"><h3>${sales.grain === 'hour' ? 'Entradas por hora' : sales.grain === 'month' ? 'Entradas por mes' : 'Entradas por día'}</h3><div class="bars">${chartBars(sales.series)}</div></section>`
    : '';
  const body = !sales
    ? `<div class="empty"><h3>No se pudieron cargar las ventas</h3><p class="lead">${esc(state.salesError || '')}</p></div>`
    : sales.totals.tickets
      ? `<div class="grid-stats">
          <article class="stat"><p class="stat-label">Entradas vendidas</p><p class="stat-value">${sales.totals.tickets}</p></article>
          <article class="stat"><p class="stat-label">Códigos QR</p><p class="stat-value">${sales.totals.qrs}</p></article>
          <article class="stat"><p class="stat-label">Ingresos</p><p class="stat-value">${money(sales.totals.revenueCents)}</p></article>
          <article class="stat"><p class="stat-label">Periodo</p><p class="stat-value" style="font-size:22px">${esc(sales.label)}</p></article>
        </div>
        ${chart}
        <section class="card" style="margin-top:16px"><h3>Entradas del periodo</h3><p class="hint" style="margin:6px 0 12px">Una fila con varias entradas es un solo QR de grupo.</p>${ticketRows(sales.rows)}</section>`
      : `<div class="empty"><h3>No hay entradas en este periodo</h3><p class="lead">${esc(sales.label)}. Prueba otra fecha o emite entradas nuevas.</p><a class="btn primary" href="/panel/entradas" data-link style="margin-top:14px">Emitir entradas</a></div>`;
  return `
    <h2>Ventas</h2>
    <p class="lead page-lead">Revisa lo vendido hoy, esta semana, este mes, este año, o busca un rango de fechas.</p>
    <form id="sales-form" class="card no-print" data-form="sales" style="margin-bottom:16px">
      <div class="seg">
        ${presets.map(([value, label]) => `<button type="button" class="${preset === value ? 'active' : ''}" data-action="preset" data-preset="${value}">${label}</button>`).join('')}
      </div>
      <div class="filters">
        <label class="field"><span>Desde</span><input name="from" type="date" value="${esc(state.salesQuery.from)}"></label>
        <label class="field"><span>Hasta</span><input name="to" type="date" value="${esc(state.salesQuery.to)}"></label>
        <label class="field"><span>Evento</span><input name="q" value="${esc(state.salesQuery.q)}" placeholder="Buscar por nombre"></label>
        <button class="btn primary" type="submit">Buscar</button>
      </div>
      <p class="form-error" ${state.salesError ? '' : 'hidden'} style="margin-top:10px">${esc(state.salesError)}</p>
    </form>
    ${body}`;
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
  const option = form.querySelector('select')?.selectedOptions?.[0];
  const price = Number(option?.dataset.price || 0);
  const quantity = Math.min(100, Math.max(1, Number(form.quantity.value) || 1));
  const mode = form.querySelector('input[name="mode"]:checked')?.value || 'individual';
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
        await lookupCode(value);
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
    await lookupCode(codes[0].rawValue);
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
  '/panel/eventos': 'eventos',
  '/panel/entradas': 'entradas',
  '/panel/visor': 'visor',
  '/panel/inventario': 'inventario',
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
  const kinds = [['', 'Todo'], ['entrada', 'Entradas'], ['venta', 'Ventas'], ['ajuste', 'Ajustes']];
  const data = state.moves;
  const groups = new Map();
  const stock = [];
  for (const row of data?.movements || []) {
    if (row.kind !== 'venta') {
      stock.push(row);
      continue;
    }
    const key = row.purchaseId || row.id;
    const group = groups.get(key) || {
      purchaseId: row.purchaseId,
      ticketCode: row.ticketCode,
      eventName: row.eventName,
      paymentMethod: row.paymentMethod,
      hasReceipt: row.hasReceipt,
      createdAt: row.createdAt,
      username: row.username,
      items: [],
      totalCents: 0,
    };
    group.items.push(row);
    group.totalCents += row.totalCents || 0;
    group.hasReceipt = group.hasReceipt || row.hasReceipt;
    groups.set(key, group);
  }
  const sales = [...groups.values()];
  const saleCards = sales.length ? sales.map((sale) => `
    <article class="card" style="margin-bottom:12px">
      <div class="row-actions">
        <div>
          <h3>${esc(sale.eventName || 'Entrada')} · <span class="code">${esc(sale.ticketCode)}</span></h3>
          <p class="hint">${formatDateTime(sale.createdAt)} · ${paymentLabel(sale.paymentMethod)}${sale.username ? ` · ${esc(sale.username)}` : ''}</p>
        </div>
        <strong>${money(sale.totalCents)}</strong>
      </div>
      ${sale.items.map((item) => `<div class="balance"><div><strong>${esc(item.productName)}</strong><p class="hint">${item.quantity} vendidas · ${money(item.totalCents || 0)}</p></div></div>`).join('')}
      <div class="row-actions" style="margin-top:10px">
        ${sale.hasReceipt ? `<a class="btn ghost small" href="/api/purchases/${sale.purchaseId}/receipt" target="_blank" rel="noopener">Ver comprobante</a>` : '<span class="hint">Sin comprobante</span>'}
        <label class="btn ghost small file-btn">Adjuntar comprobante<input type="file" accept="image/*,.pdf" data-receipt="${sale.purchaseId}"></label>
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
  const showSales = state.moveQuery.kind !== 'entrada' && state.moveQuery.kind !== 'ajuste';
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
        <p class="lead page-lead">Al entrar, solo verá los módulos que marques.</p>
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
    stage.innerHTML = `<div><p class="eyebrow">Tasca Los Sierra</p><p class="pair-code">${esc(screen.code.slice(0, 3))} ${esc(screen.code.slice(3))}</p><p>En el panel, entra a Pantallas y escribe este código en Vincular pantalla.</p></div>`;
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
  document.title = titles['/pantalla'];
  mount(`<div class="screen-stage wait" id="screen-stage"><p>Conectando pantalla…</p></div>`);
  let token = localStorage.getItem('tasca-screen-token') || '';
  const tick = async () => {
    if (currentPath() !== '/pantalla') return;
    try {
      if (!token) {
        token = localStorage.getItem('tasca-screen-token') || '';
      }
      if (!token) {
        if (!screenBoot) {
          screenBoot = api('/api/public/screens', { method: 'POST', body: {} })
            .then((created) => {
              localStorage.setItem('tasca-screen-token', created.token);
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
        localStorage.removeItem('tasca-screen-token');
        token = '';
      }
      const stage = document.getElementById('screen-stage');
      if (stage && stage.dataset.identity == null) stage.innerHTML = `<p>${esc(error.message || 'Sin conexión con la tasca.')}</p>`;
    }
    if (currentPath() === '/pantalla') screenTimer = setTimeout(tick, 1000);
  };
  await tick();
}

async function apiForm(path, formData) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', body: formData });
  if (response.status === 413) {
    const error = new Error('Vercel rechazó el video: pesa más de 4 MB. Entra en tasca-los-sierra.onrender.com para subirlo, o pega un enlace de YouTube.');
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

async function render() {
  const token = ++renderToken;
  stopCamera();
  stopScreen();
  document.body.classList.remove('nav-open');
  if (currentPath() === '/pantalla') {
    await renderScreen();
    return;
  }
  let path = currentPath();
  if (!state.user && path.startsWith('/panel')) {
    history.replaceState({}, '', '/acceso');
    path = '/acceso';
  } else if (state.user && path === '/acceso') {
    history.replaceState({}, '', '/panel');
    path = '/panel';
  }
  if (routeModules[path] && !allow(routeModules[path])) {
    const fallback = Object.keys(routeModules).find((href) => allow(routeModules[href]));
    if (path === '/panel' && fallback && fallback !== '/panel') {
      history.replaceState({}, '', fallback);
      path = fallback;
    } else {
      document.title = titles[path] || 'Tasca Los Sierra';
      mount(shell(denied()));
      return;
    }
  }
  document.title = titles[path] || 'Tasca Los Sierra';
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
      state.dash = await api('/api/summary');
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
      mount(shell(visorView()));
      renderLog();
      document.querySelector('#lookup-form input[name="code"]')?.focus();
      return;
    }
    if (path === '/panel/inventario') {
      mount(shell(loading()));
      state.products = (await api('/api/products')).products;
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
      state.sales = await api(`/api/sales?${salesParams()}`);
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
    mount(`<div class="section"><div class="wrap"><h2>No está esa página</h2><p class="lead">Vuelve al inicio de Tasca Los Sierra.</p><a class="btn primary" href="/" data-link style="margin-top:16px">Ir al inicio</a></div></div>`);
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
  if (currentPath() === path) return render();
  history.pushState({}, '', path);
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
          setFormError(form, `Este video pesa ${mb} MB. Vercel solo acepta unos 4 MB. Súbelo en https://tasca-los-sierra.onrender.com o pega un enlace de YouTube.`);
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
        name: values.name,
        cost: values.cost,
        price: values.price,
        stock: Number(values.stock),
        unitsPerBox: values.unitsPerBox === '' ? 1 : Number(values.unitsPerBox),
        active: Boolean(form.querySelector('input[name="active"]')?.checked),
      };
      if (!state.editingProduct) body.pack = form.pack?.value || 'unit';
      if (body.pack === 'box' && (!Number.isInteger(body.unitsPerBox) || body.unitsPerBox < 2)) {
        setFormError(form, 'Escribe cuántas unidades trae cada caja.');
        return;
      }
      if (state.editingProduct) await api(`/api/products/${state.editingProduct.id}`, { method: 'PATCH', body });
      else await api('/api/products', { method: 'POST', body });
      state.editingProduct = null;
      toast('Inventario actualizado.');
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
  if (event.target.closest('[data-stop]')) {
    const actionHost = event.target.closest('[data-action]');
    if (!actionHost) return;
  }
  const control = event.target.closest('[data-action]');
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
    state.user = null;
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
    if (!confirm('¿Eliminar este evento? Solo se puede si todavía no tiene entradas.')) return;
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
      document.querySelector('.modal-back')?.remove();
      document.body.insertAdjacentHTML('beforeend', buyModal());
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
  if (action === 'pick-product') {
    const product = state.products.find((item) => item.id === Number(control.dataset.id));
    const quantity = Number(document.querySelector('#buy-qty')?.value);
    if (!product || product.stock < 1) {
      toast('Ese producto no tiene existencias.', 'bad');
      return;
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      toast('Indica una cantidad.', 'bad');
      return;
    }
    const current = state.cart.find((line) => line.productId === product.id)?.quantity || 0;
    if (current + quantity > product.stock) {
      toast(`Solo quedan ${product.stock} de ${product.name}.`, 'bad');
      return;
    }
    if (current) state.cart.find((line) => line.productId === product.id).quantity += quantity;
    else state.cart.push({ productId: product.id, name: product.name, priceCents: product.priceCents, quantity });
    refreshBuyCart();
    return;
  }
  if (action === 'remove-cart') {
    state.cart = state.cart.filter((line) => line.productId !== Number(control.dataset.id));
    refreshBuyCart();
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
      state.delivery = { purchaseId: data.purchase.id, lines: data.purchase.items };
      document.body.insertAdjacentHTML('beforeend', deliverModal());
    } catch (error) {
      toast(error.message, 'bad');
      control.disabled = false;
    }
    return;
  }
  if (action === 'deliver-item') {
    const purchase = state.currentTicket?.purchases?.find((item) => item.id === Number(control.dataset.purchase));
    const line = purchase?.items.find((item) => item.id === Number(control.dataset.item));
    if (!line || line.remaining < 1) return;
    state.delivery = { purchaseId: purchase.id, lines: [line] };
    document.querySelector('.modal-back')?.remove();
    document.body.insertAdjacentHTML('beforeend', deliverModal());
    return;
  }
  if (action === 'close-deliver') {
    state.delivery = null;
    document.querySelector('.modal-back')?.remove();
    return;
  }
  if (action === 'confirm-delivery') {
    const purchaseId = document.getElementById('deliver-lines')?.dataset.purchase;
    const lines = [...document.querySelectorAll('#deliver-lines input')].map((input) => ({
      itemId: Number(input.dataset.item),
      quantity: Number(input.value || 0),
      max: Number(input.max),
    }));
    const chosen = lines.filter((line) => line.quantity > 0);
    if (!chosen.length) {
      toast('Escribe cuántas unidades vas a entregar.', 'bad');
      return;
    }
    if (chosen.some((line) => !Number.isInteger(line.quantity) || line.quantity > line.max)) {
      toast('No puedes entregar más de las facturadas.', 'bad');
      return;
    }
    control.disabled = true;
    try {
      const data = await api(`/api/purchases/${purchaseId}/deliver`, {
        method: 'POST',
        body: { lines: chosen.map((line) => ({ itemId: line.itemId, quantity: line.quantity })) },
      });
      state.delivery = null;
      document.querySelector('.modal-back')?.remove();
      paintVisor(data.ticket, 'Entrega registrada.');
      toast('Entrega registrada.');
    } catch (error) {
      toast(error.message, 'bad');
      control.disabled = false;
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
  if (action === 'toggle-product') {
    const active = control.dataset.active !== '1';
    await api(`/api/products/${control.dataset.id}`, { method: 'PATCH', body: { active } });
    toast(active ? 'Producto activado.' : 'Producto desactivado.');
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
    if (!confirm('¿Eliminar este producto? Solo se puede si todavía no tiene compras.')) return;
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

document.addEventListener('click', (event) => {
  onClick(event).catch((error) => toast(error.message || 'No se pudo completar la acción.', 'bad'));
});
document.addEventListener('submit', (event) => {
  onSubmit(event).catch((error) => toast(error.message || 'No se pudo completar la acción.', 'bad'));
});
document.addEventListener('input', (event) => {
  if (event.target.closest('#ticket-form')) updateTotal();
  if (event.target.closest('form[data-form="product"]')) {
    updateProductProfit();
    updatePackHint();
  }
  if (event.target.id === 'buy-search') {
    const box = document.getElementById('buy-results');
    if (box) box.innerHTML = buyResultsHtml(event.target.value);
  }
});
document.addEventListener('change', (event) => {
  if (event.target.closest('form[data-form="product"]')) updatePackHint();
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
    state.user = data.user;
  })
  .catch(() => {
    state.user = null;
  })
  .finally(() => render());
