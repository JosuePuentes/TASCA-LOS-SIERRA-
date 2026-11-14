import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from './db.js';
import express from 'express';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const QR_TTL_MS = 12 * 60 * 60 * 1000;
const onVercel = Boolean(process.env.VERCEL);
const dataDir = onVercel
  ? path.join('/tmp', 'TascaLosSierra')
  : path.join(process.env.LOCALAPPDATA || path.join(__dirname, 'data'), 'TascaLosSierra');
const mediaDir = path.join(dataDir, 'uploads', 'media');
const receiptDir = path.join(dataDir, 'uploads', 'receipts');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(receiptDir, { recursive: true });
const dbPath = path.join(dataDir, 'tasca.db');

const db = openDatabase(dbPath);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    event_name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    quantity INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    status TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    FOREIGN KEY (event_id) REFERENCES events(id)
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    stock INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    payment_method TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id)
  );

  CREATE TABLE IF NOT EXISTS purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

  CREATE INDEX IF NOT EXISTS idx_purchases_ticket ON purchases(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_items_purchase ON purchase_items(purchase_id);

  CREATE TABLE IF NOT EXISTS user_permissions (
    user_id INTEGER NOT NULL,
    module TEXT NOT NULL,
    PRIMARY KEY (user_id, module),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    product_id INTEGER,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price_cents INTEGER,
    purchase_id INTEGER,
    ticket_id INTEGER,
    note TEXT,
    user_id INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_movements_created ON movements(created_at);

  CREATE TABLE IF NOT EXISTS screens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    code TEXT NOT NULL UNIQUE,
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    content_kind TEXT,
    content_source TEXT,
    content_title TEXT,
    last_seen TEXT,
    created_at TEXT NOT NULL
  );
`);

function num(value) {
  if (typeof value === 'bigint') return Number(value);
  return Number(value || 0);
}

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

if (!columnNames('users').includes('is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
}
if (!columnNames('purchases').includes('receipt_file')) {
  db.exec('ALTER TABLE purchases ADD COLUMN receipt_file TEXT');
}
if (!columnNames('products').includes('cost_cents')) {
  db.exec('ALTER TABLE products ADD COLUMN cost_cents INTEGER NOT NULL DEFAULT 0');
}
if (!columnNames('tickets').includes('alias')) db.exec('ALTER TABLE tickets ADD COLUMN alias TEXT');
if (!columnNames('tickets').includes('payment_method')) db.exec('ALTER TABLE tickets ADD COLUMN payment_method TEXT');
if (!columnNames('tickets').includes('receipt_file')) db.exec('ALTER TABLE tickets ADD COLUMN receipt_file TEXT');
if (!columnNames('screens').includes('play_seconds')) db.exec('ALTER TABLE screens ADD COLUMN play_seconds REAL');
if (!columnNames('screens').includes('play_at')) db.exec('ALTER TABLE screens ADD COLUMN play_at TEXT');
if (!columnNames('screens').includes('play_mark')) db.exec('ALTER TABLE screens ADD COLUMN play_mark TEXT');

let seededAdmin = false;
const userCount = num(db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
if (userCount === 0) {
  db.prepare('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 1, ?)').run(
    'admin',
    bcrypt.hashSync('LosSierra12', 10),
    new Date().toISOString(),
  );
  seededAdmin = true;
} else if (num(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n) === 0) {
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)').run();
}

function toCents(value) {
  const text = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

function normalizeCode(raw) {
  const text = String(raw || '').trim().toUpperCase();
  const match = text.match(/LS-[A-F0-9]{10}/);
  return match ? match[0] : text;
}

function newCode() {
  return `LS-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function presentEvent(row) {
  return {
    id: num(row.id),
    name: row.name,
    priceCents: num(row.price_cents),
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

const PAYMENTS = new Set(['efectivo', 'tarjeta', 'transferencia', 'pago_movil']);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function wholeNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return null;
  return number;
}

function presentProduct(row) {
  const priceCents = num(row.price_cents);
  const costCents = num(row.cost_cents);
  const stock = num(row.stock);
  return {
    id: num(row.id),
    name: row.name,
    costCents,
    priceCents,
    profitCents: priceCents - costCents,
    stock,
    stockCostCents: costCents * stock,
    stockSaleCents: priceCents * stock,
    stockProfitCents: (priceCents - costCents) * stock,
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

function presentItem(row) {
  const quantity = num(row.quantity);
  const delivered = num(row.delivered);
  return {
    id: num(row.id),
    purchaseId: num(row.purchase_id),
    productId: num(row.product_id),
    productName: row.product_name,
    unitPriceCents: num(row.unit_price_cents),
    quantity,
    delivered,
    remaining: quantity - delivered,
    totalCents: quantity * num(row.unit_price_cents),
  };
}

function purchasesForTicket(ticketId) {
  const purchases = db.prepare('SELECT * FROM purchases WHERE ticket_id = ? ORDER BY created_at DESC').all(ticketId);
  return purchases.map((purchase) => {
    const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').all(purchase.id).map(presentItem);
    return {
      id: num(purchase.id),
      paymentMethod: purchase.payment_method,
      createdAt: purchase.created_at,
      totalCents: items.reduce((sum, item) => sum + item.totalCents, 0),
      hasReceipt: Boolean(purchase.receipt_file),
      items,
    };
  });
}

function withPurchases(ticket) {
  if (!ticket) return null;
  return { ...ticket, purchases: purchasesForTicket(ticket.id) };
}

function presentTicket(row) {
  return {
    id: num(row.id),
    eventId: num(row.event_id),
    eventName: row.event_name,
    code: row.code,
    quantity: num(row.quantity),
    unitPriceCents: num(row.unit_price_cents),
    totalCents: num(row.quantity) * num(row.unit_price_cents),
    status: row.status,
    batchId: row.batch_id,
    alias: row.alias || '',
    paymentMethod: row.payment_method || '',
    hasReceipt: Boolean(row.receipt_file),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

function expireOld() {
  db.prepare(`UPDATE tickets SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`).run(new Date().toISOString());
}

function getTicket(code) {
  expireOld();
  const row = db.prepare('SELECT * FROM tickets WHERE code = ?').get(code);
  return row ? presentTicket(row) : null;
}

function findTickets(query) {
  expireOld();
  const text = String(query || '').trim();
  const code = normalizeCode(text);
  const exact = db.prepare('SELECT * FROM tickets WHERE code = ?').get(code);
  if (exact) return [presentTicket(exact)];
  const like = `%${text.replace(/[%_]/g, '')}%`;
  if (like === '%%') return [];
  return db.prepare(`
    SELECT * FROM tickets
    WHERE alias LIKE ? COLLATE NOCASE
    ORDER BY created_at DESC
    LIMIT 20
  `).all(like).map(presentTicket);
}

async function withQr(ticket) {
  const qrDataUrl = await QRCode.toDataURL(ticket.code, {
    margin: 1,
    width: 360,
    errorCorrectionLevel: 'M',
    color: { dark: '#241812', light: '#fffaf3' },
  });
  return { ...ticket, qrDataUrl };
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function nextDay(date) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + 1);
  return copy;
}

function startOfWeek(date) {
  const start = startOfDay(date);
  const day = start.getDay();
  const diff = day === 0 ? 6 : day - 1;
  start.setDate(start.getDate() - diff);
  return start;
}

function parseDay(str) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1) return null;
  return date;
}

function ymd(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function rangeFor(preset, fromStr, toStr) {
  const now = new Date();
  if (preset === 'day') {
    const from = startOfDay(now);
    return { from, to: nextDay(from) };
  }
  if (preset === 'week') {
    const from = startOfWeek(now);
    return { from, to: new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7) };
  }
  if (preset === 'month') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from, to: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
  }
  if (preset === 'year') {
    const from = new Date(now.getFullYear(), 0, 1);
    return { from, to: new Date(now.getFullYear() + 1, 0, 1) };
  }
  if (preset === 'custom') {
    const from = parseDay(fromStr);
    const end = parseDay(toStr);
    if (!from || !end) {
      const error = new Error('Elige la fecha de inicio y la fecha de fin.');
      error.status = 400;
      throw error;
    }
    if (end < from) {
      const error = new Error('La fecha final tiene que ser igual o posterior a la inicial.');
      error.status = 400;
      throw error;
    }
    const span = Math.round((nextDay(end) - from) / 86400000);
    if (span > 3660) {
      const error = new Error('El rango máximo es de 10 años.');
      error.status = 400;
      throw error;
    }
    return { from, to: nextDay(end) };
  }
  const error = new Error('Elige un periodo válido.');
  error.status = 400;
  throw error;
}

function cap(text) {
  const value = String(text || '').replace('.', '');
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function buildSeries(rows, from, to, preset) {
  const span = Math.round((to - from) / 86400000);
  let grain = 'day';
  if (preset === 'day' || span <= 1) grain = 'hour';
  else if (preset === 'year' || span > 62) grain = 'month';

  const buckets = new Map();
  if (grain === 'hour') {
    for (let hour = 0; hour < 24; hour += 1) {
      buckets.set(String(hour), { label: String(hour).padStart(2, '0'), tickets: 0, revenueCents: 0 });
    }
  } else if (grain === 'month') {
    const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
    const last = new Date(to.getTime() - 1);
    while (cursor <= last) {
      const key = `${cursor.getFullYear()}-${cursor.getMonth()}`;
      const label = cap(new Intl.DateTimeFormat('es-ES', { month: 'short' }).format(cursor));
      buckets.set(key, { label, tickets: 0, revenueCents: 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    const cursor = new Date(from);
    while (cursor < to) {
      const key = ymd(cursor);
      const label = preset === 'week'
        ? cap(new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric' }).format(cursor))
        : String(cursor.getDate());
      buckets.set(key, { label, tickets: 0, revenueCents: 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  for (const row of rows) {
    const date = new Date(row.created_at);
    let key = ymd(date);
    if (grain === 'hour') key = String(date.getHours());
    if (grain === 'month') key = `${date.getFullYear()}-${date.getMonth()}`;
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.tickets += num(row.quantity);
    bucket.revenueCents += num(row.quantity) * num(row.unit_price_cents);
  }

  return { grain, series: [...buckets.values()] };
}

function formatRange(from, toExclusive) {
  const end = new Date(toExclusive.getTime() - 1);
  const formatter = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  const startLabel = formatter.format(from);
  const endLabel = formatter.format(end);
  return startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
}

function asyncRoute(handler) {
  return (req, res, next) => {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };
}

const MODULES = ['resumen', 'eventos', 'entradas', 'visor', 'inventario', 'ventas', 'movimientos', 'pantallas', 'usuarios'];

function presentSessionUser(user) {
  const permissions = user.is_admin
    ? [...MODULES]
    : db.prepare('SELECT module FROM user_permissions WHERE user_id = ? ORDER BY module').all(user.id).map((row) => row.module);
  return {
    id: num(user.id),
    username: user.username,
    isAdmin: Boolean(user.is_admin),
    permissions,
  };
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  req.account = presentSessionUser(user);
  next();
}

const API_RULES = [
  { test: /^\/api\/summary$/, modules: ['resumen'] },
  { test: /^\/api\/events(\/|$)/, modules: ['eventos'] },
  { test: /^\/api\/tickets$/, modules: ['entradas'] },
  { test: /^\/api\/tickets\/search$/, modules: ['visor'] },
  { test: /^\/api\/tickets\/\d+\/receipt$/, modules: ['visor', 'entradas'] },
  { test: /^\/api\/tickets\/code\//, modules: ['visor'] },
  { test: /^\/api\/products(\/|$)/, modules: ['inventario'] },
  { test: /^\/api\/purchases\/\d+\/(payment|deliver)$/, modules: ['visor'] },
  { test: /^\/api\/purchases\/\d+\/receipt$/, modules: ['movimientos'] },
  { test: /^\/api\/sales$/, modules: ['ventas'] },
  { test: /^\/api\/movements$/, modules: ['movimientos'] },
  { test: /^\/api\/users(\/|$)/, modules: ['usuarios'] },
  { test: /^\/api\/screens(\/|$)/, modules: ['pantallas'] },
];

function guardApi(req, res, next) {
  const open = req.path === '/api/login' || req.path === '/api/logout' || req.path === '/api/me' || req.path === '/api/password' || req.path.startsWith('/api/public/');
  if (!req.path.startsWith('/api/') || open) return next();
  if (!req.session.user) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  req.account = presentSessionUser(user);
  const rule = API_RULES.find((item) => item.test.test(req.path));
  if (!rule) return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
  if (req.account.isAdmin || rule.modules.some((name) => req.account.permissions.includes(name))) return next();
  return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
}

const insertMovement = db.prepare(`
  INSERT INTO movements (
    kind, product_id, product_name, quantity, unit_price_cents, purchase_id, ticket_id, note, user_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function logMovement(entry) {
  insertMovement.run(
    entry.kind,
    entry.productId ?? null,
    entry.productName,
    entry.quantity,
    entry.unitPriceCents ?? null,
    entry.purchaseId ?? null,
    entry.ticketId ?? null,
    entry.note ?? null,
    entry.userId ?? null,
    new Date().toISOString(),
  );
}

function youtubeId(value) {
  const text = String(value || '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  try {
    const url = new URL(text);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0] || '';
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const fromQuery = url.searchParams.get('v') || '';
      if (/^[\w-]{11}$/.test(fromQuery)) return fromQuery;
      const parts = url.pathname.split('/').filter(Boolean);
      const id = ['embed', 'shorts', 'live', 'v'].includes(parts[0]) ? parts[1] : '';
      return /^[\w-]{11}$/.test(id || '') ? id : null;
    }
  } catch {
    // El texto no es una URL completa.
  }
  const match = text.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|shorts\/|live\/|v\/))([\w-]{11})/);
  return match ? match[1] : null;
}

function fileExtension(file) {
  const mime = String(file?.mimetype || '').split(';')[0].trim().toLowerCase();
  const fromMime = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
    'video/mp4': '.mp4',
    'application/mp4': '.mp4',
    'video/x-m4v': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
  }[mime];
  if (fromMime) return fromMime;
  const name = String(file?.originalname || '').toLowerCase();
  const match = name.match(/\.([a-z0-9]+)$/);
  const ext = match?.[1] || '';
  if (ext === 'jpeg' || ext === 'jpg') return '.jpg';
  if (ext === 'png' || ext === 'webp' || ext === 'gif' || ext === 'pdf') return `.${ext}`;
  if (ext === 'mp4' || ext === 'm4v') return '.mp4';
  if (ext === 'webm') return '.webm';
  if (ext === 'mov') return '.mov';
  return '';
}

function isVideoFile(file) {
  return ['.mp4', '.webm', '.mov'].includes(fileExtension(file));
}

function uploadSingle(dir, accept, rejectedMessage) {
  const middleware = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, dir),
      filename: (req, file, cb) => cb(null, `${crypto.randomBytes(16).toString('hex')}${fileExtension(file) || '.bin'}`),
    }),
    limits: { fileSize: 200 * 1024 * 1024 },
  }).single('file');
  return (req, res, next) => {
    middleware(req, res, (error) => {
      if (error) {
        const tooBig = error.code === 'LIMIT_FILE_SIZE';
        return res.status(400).json({ error: tooBig ? 'El archivo pesa más de 200 MB. Comprime el video o usa un enlace de YouTube.' : 'No se pudo subir el archivo.' });
      }
      if (req.file && !accept(req.file)) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: rejectedMessage });
      }
      next();
    });
  };
}

const uploadReceipt = uploadSingle(receiptDir, (file) => ['.jpg', '.png', '.webp', '.gif', '.pdf'].includes(fileExtension(file)), 'El comprobante debe ser una imagen o un PDF.');
const uploadMedia = uploadSingle(mediaDir, (file) => ['.jpg', '.png', '.webp', '.gif', '.mp4', '.webm', '.mov'].includes(fileExtension(file)), 'Usa una imagen o un video MP4, WEBM o MOV.');

function cleanUsername(value) {
  const username = String(value || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,24}$/.test(username)) return null;
  return username;
}

function cleanModules(list, actor) {
  const requested = Array.isArray(list) ? list.filter((name) => MODULES.includes(name)) : [];
  if (actor.isAdmin) return [...new Set(requested)];
  return [...new Set(requested.filter((name) => actor.permissions.includes(name)))];
}

function savePermissions(userId, modules) {
  db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO user_permissions (user_id, module) VALUES (?, ?)');
  for (const name of modules) insert.run(userId, name);
}

function presentStoredUser(user) {
  return {
    ...presentSessionUser(user),
    createdAt: user.created_at,
  };
}

function pairingCode() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = String(crypto.randomInt(100000, 999999));
    const existing = db.prepare('SELECT id FROM screens WHERE code = ?').get(code);
    if (!existing) return code;
  }
  throw httpError(500, 'No se pudo generar un código de pantalla.');
}

function presentScreen(row) {
  const seen = row.last_seen ? Date.now() - new Date(row.last_seen).getTime() : Infinity;
  const position = row.play_seconds == null || row.play_seconds === '' ? null : Number(row.play_seconds);
  const content = row.content_kind ? {
    kind: row.content_kind,
    title: row.content_title || '',
    source: row.content_kind === 'youtube' ? row.content_source : `/media/${row.content_source}`,
    mark: row.play_mark || '',
    position: Number.isFinite(position) ? position : null,
    positionAt: row.play_at || null,
  } : null;
  return {
    id: num(row.id),
    name: row.name || '',
    code: row.code,
    status: row.status,
    online: seen < 15000,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
    content,
  };
}

const hosted = onVercel || Boolean(process.env.RENDER);
const app = express();
if (hosted) app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(cookieSession({
  name: 'tasca.session',
  keys: [process.env.SESSION_SECRET || 'tasca-los-sierra-puerta-local'],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: false,
  overwrite: true,
}));
app.use((req, res, next) => {
  if (String(req.headers.cookie || '').includes('tasca.sid=')) {
    res.append('Set-Cookie', 'tasca.sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax');
  }
  next();
});
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'autoplay=*');
  next();
});
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(guardApi);

app.get('/api/public/events', (req, res) => {
  const events = db.prepare('SELECT * FROM events WHERE active = 1 ORDER BY name COLLATE NOCASE').all();
  res.json({ events: events.map(presentEvent) });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  req.session.user = { id: num(user.id), username: user.username };
  res.json({ user: presentSessionUser(user) });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  res.json({ user: presentSessionUser(user) });
});

app.post('/api/password', requireAuth, (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  const confirm = String(req.body.confirm || '');
  if (next.length < 8) return res.status(400).json({ error: 'La nueva contraseña necesita al menos 8 caracteres.' });
  if (next !== confirm) return res.status(400).json({ error: 'La confirmación no coincide.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user || !bcrypt.compareSync(current, user.password_hash)) {
    return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), user.id);
  res.json({ ok: true });
});

app.get('/api/events', requireAuth, (req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY active DESC, name COLLATE NOCASE').all();
  res.json({ events: events.map(presentEvent) });
});

app.post('/api/events', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const priceCents = toCents(req.body.price);
  if (name.length < 2 || name.length > 80) {
    return res.status(400).json({ error: 'El nombre debe tener entre 2 y 80 caracteres.' });
  }
  if (priceCents == null || priceCents > 10000000) {
    return res.status(400).json({ error: 'Escribe un precio válido, con hasta dos decimales.' });
  }
  const info = db.prepare('INSERT INTO events (name, price_cents, active, created_at) VALUES (?, ?, 1, ?)').run(
    name,
    priceCents,
    new Date().toISOString(),
  );
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(num(info.lastInsertRowid));
  res.status(201).json({ event: presentEvent(event) });
});

app.patch('/api/events/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'No se encontró el evento.' });

  const name = req.body.name == null ? current.name : String(req.body.name).trim();
  const priceCents = req.body.price == null ? num(current.price_cents) : toCents(req.body.price);
  const active = req.body.active == null ? Boolean(current.active) : Boolean(req.body.active);
  if (name.length < 2 || name.length > 80) {
    return res.status(400).json({ error: 'El nombre debe tener entre 2 y 80 caracteres.' });
  }
  if (priceCents == null || priceCents > 10000000) {
    return res.status(400).json({ error: 'Escribe un precio válido, con hasta dos decimales.' });
  }
  db.prepare('UPDATE events SET name = ?, price_cents = ?, active = ? WHERE id = ?').run(name, priceCents, active ? 1 : 0, id);
  res.json({ event: presentEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(id)) });
});

app.delete('/api/events/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'No se encontró el evento.' });
  const used = num(db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE event_id = ?').get(id).n);
  if (used) {
    return res.status(409).json({ error: 'Este evento ya tiene entradas. Desactívalo si ya no se vende.' });
  }
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/tickets', requireAuth, uploadReceipt, asyncRoute(async (req, res) => {
  const eventId = Number(req.body.eventId);
  const quantity = Number(req.body.quantity);
  const mode = req.body.mode === 'group' ? 'group' : req.body.mode === 'individual' ? 'individual' : null;
  const alias = String(req.body.alias || '').trim();
  const paymentMethod = String(req.body.paymentMethod || '');
  const dropFile = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  if (!mode) {
    dropFile();
    return res.status(400).json({ error: 'Elige cómo se reparte el QR.' });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    dropFile();
    return res.status(400).json({ error: 'La cantidad debe estar entre 1 y 100.' });
  }
  if (alias.length > 40) {
    dropFile();
    return res.status(400).json({ error: 'El alias puede tener hasta 40 caracteres.' });
  }
  if (!PAYMENTS.has(paymentMethod)) {
    dropFile();
    return res.status(400).json({ error: 'Elige el método de pago.' });
  }
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event || !event.active) {
    dropFile();
    return res.status(400).json({ error: 'Elige un evento activo.' });
  }

  const batchId = crypto.randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + QR_TTL_MS);
  const receiptFile = req.file ? req.file.filename : null;
  const insert = db.prepare(`
    INSERT INTO tickets (
      event_id, event_name, code, quantity, unit_price_cents, status, batch_id, created_at, expires_at, alias, payment_method, receipt_file
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
  `);

  const created = [];
  const insertOne = (ticketQuantity) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = newCode();
      try {
        const info = insert.run(
          event.id,
          event.name,
          code,
          ticketQuantity,
          num(event.price_cents),
          batchId,
          createdAt.toISOString(),
          expiresAt.toISOString(),
          alias,
          paymentMethod,
          receiptFile,
        );
        created.push(getTicket(code) || { id: num(info.lastInsertRowid), code, quantity: ticketQuantity });
        return;
      } catch (error) {
        if (!String(error.message).includes('UNIQUE')) throw error;
      }
    }
    throw new Error('No se pudo generar un código único.');
  };

  db.exec('BEGIN');
  try {
    if (mode === 'group') insertOne(quantity);
    else for (let index = 0; index < quantity; index += 1) insertOne(1);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const tickets = [];
  for (const ticket of created) tickets.push(await withQr(getTicket(ticket.code)));
  res.status(201).json({
    batchId,
    mode,
    quantity,
    expiresAt: expiresAt.toISOString(),
    tickets,
  });
}));

app.get('/api/tickets/search', requireAuth, asyncRoute(async (req, res) => {
  const tickets = findTickets(req.query.q);
  if (tickets.length === 1) {
    return res.json({ tickets: [await withQr(withPurchases(tickets[0]))] });
  }
  res.json({ tickets });
}));

app.get('/api/tickets/:id/receipt', requireAuth, (req, res) => {
  const ticket = db.prepare('SELECT receipt_file FROM tickets WHERE id = ?').get(Number(req.params.id));
  if (!ticket?.receipt_file) return res.status(404).json({ error: 'Esta entrada no tiene comprobante.' });
  res.sendFile(path.join(receiptDir, path.basename(ticket.receipt_file)));
});

app.get('/api/tickets/code/:code', requireAuth, asyncRoute(async (req, res) => {
  const ticket = getTicket(normalizeCode(req.params.code));
  if (!ticket) return res.status(404).json({ error: 'No existe una entrada con ese código.' });
  res.json({ ticket: await withQr(withPurchases(ticket)) });
}));

app.post('/api/tickets/code/:code/use', requireAuth, (req, res) => {
  const code = normalizeCode(req.params.code);
  const existing = getTicket(code);
  if (!existing) return res.status(404).json({ error: 'No existe una entrada con ese código.' });
  if (existing.status === 'expired') {
    return res.status(409).json({ error: 'Este QR está vencido.', ticket: withPurchases(existing) });
  }
  if (existing.status === 'used') {
    return res.status(409).json({ error: 'Este QR ya fue utilizado.', ticket: withPurchases(existing) });
  }
  const usedAt = new Date().toISOString();
  const info = db.prepare(`UPDATE tickets SET status = 'used', used_at = ? WHERE code = ? AND status = 'active'`).run(usedAt, code);
  const ticket = getTicket(code);
  if (!num(info.changes)) {
    return res.status(409).json({ error: 'Este QR ya no está vigente.', ticket: withPurchases(ticket) });
  }
  res.json({ ticket: withPurchases(ticket) });
});

app.get('/api/products', requireAuth, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY active DESC, name COLLATE NOCASE').all();
  res.json({ products: products.map(presentProduct) });
});

app.post('/api/products', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const costCents = toCents(req.body.cost);
  const priceCents = toCents(req.body.price);
  const stock = wholeNumber(req.body.stock, 0, 100000);
  if (name.length < 2 || name.length > 80) {
    return res.status(400).json({ error: 'El nombre debe tener entre 2 y 80 caracteres.' });
  }
  if (costCents == null || costCents > 10000000) {
    return res.status(400).json({ error: 'Escribe el costo, con hasta dos decimales.' });
  }
  if (priceCents == null || priceCents > 10000000) {
    return res.status(400).json({ error: 'Escribe el precio de venta, con hasta dos decimales.' });
  }
  if (stock == null) return res.status(400).json({ error: 'Las existencias tienen que ser un número entero entre 0 y 100000.' });
  const info = db.prepare('INSERT INTO products (name, cost_cents, price_cents, stock, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(
    name,
    costCents,
    priceCents,
    stock,
    new Date().toISOString(),
  );
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(num(info.lastInsertRowid));
  if (stock > 0) {
    logMovement({
      kind: 'entrada',
      productId: num(product.id),
      productName: product.name,
      quantity: stock,
      unitPriceCents: num(product.price_cents),
      userId: req.account?.id,
      note: 'Alta de producto',
    });
  }
  res.status(201).json({ product: presentProduct(product) });
});

app.patch('/api/products/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'No se encontró el producto.' });
  if (req.body.addStock != null) {
    const add = wholeNumber(req.body.addStock, 1, 100000);
    if (add == null) return res.status(400).json({ error: 'Indica cuántas unidades vas a sumar.' });
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(add, id);
    logMovement({
      kind: 'entrada',
      productId: id,
      productName: current.name,
      quantity: add,
      unitPriceCents: num(current.price_cents),
      userId: req.account?.id,
      note: 'Suma de existencias',
    });
    return res.json({ product: presentProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) });
  }
  const name = req.body.name == null ? current.name : String(req.body.name).trim();
  const costCents = req.body.cost == null ? num(current.cost_cents) : toCents(req.body.cost);
  const priceCents = req.body.price == null ? num(current.price_cents) : toCents(req.body.price);
  const stock = req.body.stock == null ? num(current.stock) : wholeNumber(req.body.stock, 0, 100000);
  const active = req.body.active == null ? Boolean(current.active) : Boolean(req.body.active);
  if (name.length < 2 || name.length > 80) {
    return res.status(400).json({ error: 'El nombre debe tener entre 2 y 80 caracteres.' });
  }
  if (costCents == null || costCents > 10000000) {
    return res.status(400).json({ error: 'Escribe el costo, con hasta dos decimales.' });
  }
  if (priceCents == null || priceCents > 10000000) {
    return res.status(400).json({ error: 'Escribe el precio de venta, con hasta dos decimales.' });
  }
  if (stock == null) return res.status(400).json({ error: 'Las existencias tienen que ser un número entero entre 0 y 100000.' });
  const delta = stock - num(current.stock);
  db.prepare('UPDATE products SET name = ?, cost_cents = ?, price_cents = ?, stock = ?, active = ? WHERE id = ?').run(name, costCents, priceCents, stock, active ? 1 : 0, id);
  if (delta !== 0) {
    logMovement({
      kind: delta > 0 ? 'entrada' : 'ajuste',
      productId: id,
      productName: name,
      quantity: Math.abs(delta),
      unitPriceCents: priceCents,
      userId: req.account?.id,
      note: delta > 0 ? 'Ajuste de existencias' : 'Baja de existencias',
    });
  }
  res.json({ product: presentProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) });
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'No se encontró el producto.' });
  const used = num(db.prepare('SELECT COUNT(*) AS n FROM purchase_items WHERE product_id = ?').get(id).n);
  if (used) return res.status(409).json({ error: 'Este producto ya tiene compras. Desactívalo si ya no se vende.' });
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/tickets/code/:code/purchases', requireAuth, (req, res) => {
  const ticket = getTicket(normalizeCode(req.params.code));
  if (!ticket) return res.status(404).json({ error: 'No existe una entrada con ese código.' });
  if (ticket.status === 'expired') {
    return res.status(409).json({ error: 'Este QR está vencido. Ya no se pueden agregar compras.' });
  }
  const paymentMethod = String(req.body.paymentMethod || '');
  if (!PAYMENTS.has(paymentMethod)) return res.status(400).json({ error: 'Elige el método de pago.' });
  if (!Array.isArray(req.body.items) || !req.body.items.length || req.body.items.length > 30) {
    return res.status(400).json({ error: 'Agrega al menos un producto.' });
  }
  const merged = new Map();
  for (const raw of req.body.items) {
    const productId = Number(raw?.productId);
    const quantity = wholeNumber(raw?.quantity, 1, 500);
    if (!productId || quantity == null) return res.status(400).json({ error: 'Revisa las cantidades de la compra.' });
    merged.set(productId, (merged.get(productId) || 0) + quantity);
  }

  const insertPurchase = db.prepare('INSERT INTO purchases (ticket_id, payment_method, created_at) VALUES (?, ?, ?)');
  const insertItem = db.prepare(`
    INSERT INTO purchase_items (purchase_id, product_id, product_name, unit_price_cents, quantity, delivered)
    VALUES (?, ?, ?, ?, ?, 0)
  `);
  const takeStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND active = 1 AND stock >= ?');
  let purchaseId = 0;
  db.exec('BEGIN');
  try {
    const info = insertPurchase.run(ticket.id, paymentMethod, new Date().toISOString());
    purchaseId = num(info.lastInsertRowid);
    for (const [productId, quantity] of merged) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product || !product.active) throw httpError(400, 'Hay un producto que ya no está a la venta.');
      if (num(product.stock) < quantity) {
        throw httpError(400, `No hay suficientes existencias de ${product.name}. Quedan ${num(product.stock)}.`);
      }
      const taken = takeStock.run(quantity, productId, quantity);
      if (!num(taken.changes)) throw httpError(400, `No se pudo descontar ${product.name} del inventario.`);
      insertItem.run(purchaseId, product.id, product.name, num(product.price_cents), quantity);
      logMovement({
        kind: 'venta',
        productId: num(product.id),
        productName: product.name,
        quantity,
        unitPriceCents: num(product.price_cents),
        purchaseId,
        ticketId: ticket.id,
        userId: req.account?.id,
        note: ticket.code,
      });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  const purchase = purchasesForTicket(ticket.id).find((item) => item.id === purchaseId);
  res.status(201).json({ purchase, ticket: withPurchases(getTicket(ticket.code)) });
});

app.patch('/api/purchases/:id/payment', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
  if (!purchase) return res.status(404).json({ error: 'No se encontró la compra.' });
  const paymentMethod = String(req.body.paymentMethod || '');
  if (!PAYMENTS.has(paymentMethod)) return res.status(400).json({ error: 'Elige el método de pago.' });
  db.prepare('UPDATE purchases SET payment_method = ? WHERE id = ?').run(paymentMethod, id);
  const ticket = db.prepare('SELECT code FROM tickets WHERE id = ?').get(purchase.ticket_id);
  res.json({ ticket: withPurchases(getTicket(ticket.code)) });
});

app.post('/api/purchases/:id/deliver', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
  if (!purchase) return res.status(404).json({ error: 'No se encontró la compra.' });
  if (!Array.isArray(req.body.lines) || !req.body.lines.length) {
    return res.status(400).json({ error: 'Indica cuántas unidades vas a entregar.' });
  }
  const deliver = db.prepare(`
    UPDATE purchase_items
    SET delivered = delivered + ?
    WHERE id = ? AND purchase_id = ? AND delivered + ? <= quantity
  `);
  db.exec('BEGIN');
  try {
    for (const raw of req.body.lines) {
      const itemId = Number(raw?.itemId);
      const quantity = wholeNumber(raw?.quantity, 1, 500);
      const item = db.prepare('SELECT * FROM purchase_items WHERE id = ? AND purchase_id = ?').get(itemId, id);
      if (!item || quantity == null) throw httpError(400, 'Revisa las cantidades a entregar.');
      const remaining = num(item.quantity) - num(item.delivered);
      if (quantity > remaining) {
        throw httpError(400, `No puedes entregar más ${item.product_name} de lo facturado. Quedan ${remaining}.`);
      }
      const info = deliver.run(quantity, itemId, id, quantity);
      if (!num(info.changes)) throw httpError(400, `No se pudo registrar la entrega de ${item.product_name}.`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  const ticket = db.prepare('SELECT code FROM tickets WHERE id = ?').get(purchase.ticket_id);
  res.json({ ticket: withPurchases(getTicket(ticket.code)) });
});

app.get('/api/summary', requireAuth, (req, res) => {
  expireOld();
  const today = rangeFor('day');
  const month = rangeFor('month');
  const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const active = num(db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE status = 'active'`).get().n);
  const expiringSoon = num(db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE status = 'active' AND expires_at <= ?`).get(soon).n);
  const soldToday = num(db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS n FROM tickets WHERE created_at >= ? AND created_at < ?`).get(today.from.toISOString(), today.to.toISOString()).n);
  const revenueMonth = num(db.prepare(`SELECT COALESCE(SUM(quantity * unit_price_cents), 0) AS n FROM tickets WHERE created_at >= ? AND created_at < ?`).get(month.from.toISOString(), month.to.toISOString()).n);
  const recent = db.prepare('SELECT * FROM tickets ORDER BY created_at DESC LIMIT 6').all().map(presentTicket);
  res.json({ active, expiringSoon, soldToday, revenueMonth, recent });
});

app.get('/api/sales', requireAuth, (req, res) => {
  let range;
  try {
    range = rangeFor(String(req.query.preset || 'day'), req.query.from, req.query.to);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  expireOld();
  const query = String(req.query.q || '').trim().slice(0, 80);
  const params = [range.from.toISOString(), range.to.toISOString()];
  let sql = 'SELECT * FROM tickets WHERE created_at >= ? AND created_at < ?';
  if (query) {
    sql += ' AND event_name LIKE ? COLLATE NOCASE';
    params.push(`%${query.replace(/[%_]/g, '')}%`);
  }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params);
  const totals = rows.reduce((sum, row) => {
    sum.tickets += num(row.quantity);
    sum.qrs += 1;
    sum.revenueCents += num(row.quantity) * num(row.unit_price_cents);
    return sum;
  }, { tickets: 0, qrs: 0, revenueCents: 0 });
  const { grain, series } = buildSeries(rows, range.from, range.to, String(req.query.preset || 'day'));
  const inclusiveEnd = new Date(range.to.getTime() - 1);
  res.json({
    preset: String(req.query.preset || 'day'),
    from: ymd(range.from),
    to: ymd(inclusiveEnd),
    label: formatRange(range.from, range.to),
    grain,
    query,
    totals,
    series,
    rows: rows.map(presentTicket),
  });
});

app.get('/api/movements', requireAuth, (req, res) => {
  let range = null;
  const preset = String(req.query.preset || 'month');
  if (preset !== 'all') {
    try {
      range = rangeFor(preset, req.query.from, req.query.to);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }
  }
  const kind = ['entrada', 'venta', 'ajuste'].includes(req.query.kind) ? req.query.kind : '';
  const query = String(req.query.q || '').trim().slice(0, 80);
  const params = [];
  let where = 'WHERE 1 = 1';
  if (range) {
    where += ' AND m.created_at >= ? AND m.created_at < ?';
    params.push(range.from.toISOString(), range.to.toISOString());
  }
  if (kind) {
    where += ' AND m.kind = ?';
    params.push(kind);
  }
  if (query) {
    where += ' AND (m.product_name LIKE ? COLLATE NOCASE OR t.code LIKE ? COLLATE NOCASE OR t.event_name LIKE ? COLLATE NOCASE)';
    const like = `%${query.replace(/[%_]/g, '')}%`;
    params.push(like, like, like);
  }
  const rows = db.prepare(`
    SELECT m.*, t.code AS ticket_code, t.event_name, p.payment_method, p.receipt_file, u.username
    FROM movements m
    LEFT JOIN tickets t ON t.id = m.ticket_id
    LEFT JOIN purchases p ON p.id = m.purchase_id
    LEFT JOIN users u ON u.id = m.user_id
    ${where}
    ORDER BY m.created_at DESC, m.id DESC
  `).all(...params);
  const movements = rows.map((row) => ({
    id: num(row.id),
    kind: row.kind,
    productName: row.product_name,
    quantity: num(row.quantity),
    unitPriceCents: row.unit_price_cents == null ? null : num(row.unit_price_cents),
    totalCents: row.unit_price_cents == null ? null : num(row.quantity) * num(row.unit_price_cents),
    purchaseId: row.purchase_id == null ? null : num(row.purchase_id),
    ticketCode: row.ticket_code || '',
    eventName: row.event_name || '',
    paymentMethod: row.payment_method || '',
    hasReceipt: Boolean(row.receipt_file),
    note: row.note || '',
    username: row.username || '',
    createdAt: row.created_at,
  }));
  const inclusiveEnd = range ? new Date(range.to.getTime() - 1) : null;
  res.json({
    preset,
    from: range ? ymd(range.from) : '',
    to: inclusiveEnd ? ymd(inclusiveEnd) : '',
    label: range ? formatRange(range.from, range.to) : 'Todo el historial',
    movements,
  });
});

app.post('/api/purchases/:id/receipt', requireAuth, uploadReceipt, (req, res) => {
  const id = Number(req.params.id);
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
  if (!purchase) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'No se encontró la compra.' });
  }
  if (!req.file) return res.status(400).json({ error: 'Adjunta una imagen o un PDF.' });
  if (purchase.receipt_file) fs.unlink(path.join(receiptDir, purchase.receipt_file), () => {});
  db.prepare('UPDATE purchases SET receipt_file = ? WHERE id = ?').run(req.file.filename, id);
  res.json({ ok: true });
});

app.get('/api/purchases/:id/receipt', requireAuth, (req, res) => {
  const purchase = db.prepare('SELECT receipt_file FROM purchases WHERE id = ?').get(Number(req.params.id));
  if (!purchase?.receipt_file) return res.status(404).json({ error: 'Esta compra no tiene comprobante.' });
  const filename = path.basename(purchase.receipt_file);
  res.sendFile(path.join(receiptDir, filename));
});

app.get('/api/users', requireAuth, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY is_admin DESC, username COLLATE NOCASE').all();
  res.json({ users: users.map(presentStoredUser) });
});

app.post('/api/users', requireAuth, (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username) return res.status(400).json({ error: 'El usuario debe tener de 3 a 24 letras o números.' });
  if (password.length < 8) return res.status(400).json({ error: 'La contraseña necesita al menos 8 caracteres.' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'Ese usuario ya existe.' });
  }
  const makeAdmin = Boolean(req.body.isAdmin) && req.account.isAdmin;
  const info = db.prepare('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)').run(
    username,
    bcrypt.hashSync(password, 10),
    makeAdmin ? 1 : 0,
    new Date().toISOString(),
  );
  const id = num(info.lastInsertRowid);
  if (!makeAdmin) savePermissions(id, cleanModules(req.body.permissions, req.account));
  res.status(201).json({ user: presentStoredUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

app.patch('/api/users/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'No se encontró el usuario.' });
  if (current.is_admin && !req.account.isAdmin) {
    return res.status(403).json({ error: 'Solo un administrador puede modificar a otro administrador.' });
  }
  if (req.body.password) {
    const password = String(req.body.password);
    if (password.length < 8) return res.status(400).json({ error: 'La contraseña necesita al menos 8 caracteres.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
  }
  if (req.account.isAdmin && req.body.isAdmin != null) {
    const nextAdmin = Boolean(req.body.isAdmin);
    if (!nextAdmin && current.is_admin) {
      const admins = num(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n);
      if (admins <= 1) return res.status(400).json({ error: 'Tiene que quedar al menos un administrador.' });
    }
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(nextAdmin ? 1 : 0, id);
    if (nextAdmin) db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id);
  }
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!updated.is_admin && req.body.permissions) savePermissions(id, cleanModules(req.body.permissions, req.account));
  res.json({ user: presentStoredUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.account.id) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario.' });
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'No se encontró el usuario.' });
  if (current.is_admin) {
    if (!req.account.isAdmin) return res.status(403).json({ error: 'Solo un administrador puede eliminar a otro administrador.' });
    const admins = num(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n);
    if (admins <= 1) return res.status(400).json({ error: 'Tiene que quedar al menos un administrador.' });
  }
  db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/public/screens', (req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  const code = pairingCode();
  const info = db.prepare(`
    INSERT INTO screens (name, code, token, status, created_at, last_seen)
    VALUES ('', ?, ?, 'pending', ?, ?)
  `).run(code, token, new Date().toISOString(), new Date().toISOString());
  res.status(201).json({ token, screen: presentScreen(db.prepare('SELECT * FROM screens WHERE id = ?').get(num(info.lastInsertRowid))) });
});

function touchScreen(screen, seconds) {
  const now = new Date().toISOString();
  const playing = screen.content_kind === 'video' || screen.content_kind === 'youtube';
  const value = typeof seconds === 'number' ? seconds : NaN;
  if (playing && Number.isFinite(value) && value >= 0 && value <= 100000) {
    db.prepare('UPDATE screens SET last_seen = ?, play_seconds = ?, play_at = ? WHERE id = ?').run(now, value, now, screen.id);
    return { ...screen, last_seen: now, play_seconds: value, play_at: now };
  }
  db.prepare('UPDATE screens SET last_seen = ? WHERE id = ?').run(now, screen.id);
  return { ...screen, last_seen: now };
}

app.get('/api/public/screens/:token', (req, res) => {
  const screen = db.prepare('SELECT * FROM screens WHERE token = ?').get(String(req.params.token || ''));
  if (!screen) return res.status(404).json({ error: 'Esta pantalla ya no está vinculada.' });
  res.json({ screen: presentScreen(touchScreen(screen, null)) });
});

app.post('/api/public/screens/:token/tick', (req, res) => {
  const screen = db.prepare('SELECT * FROM screens WHERE token = ?').get(String(req.params.token || ''));
  if (!screen) return res.status(404).json({ error: 'Esta pantalla ya no está vinculada.' });
  const raw = req.body?.seconds;
  const seconds = typeof raw === 'number' ? raw : NaN;
  res.json({ screen: presentScreen(touchScreen(screen, seconds)) });
});

app.get('/api/screens', requireAuth, (req, res) => {
  const screens = db.prepare('SELECT * FROM screens ORDER BY status DESC, created_at DESC').all();
  res.json({ screens: screens.map(presentScreen) });
});

app.post('/api/screens/pair', requireAuth, (req, res) => {
  const code = String(req.body.code || '').replace(/\s+/g, '');
  const name = String(req.body.name || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'El código son 6 números, tal como sale en el televisor.' });
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Ponle un nombre de 2 a 40 caracteres.' });
  const screen = db.prepare('SELECT * FROM screens WHERE code = ?').get(code);
  if (!screen) return res.status(404).json({ error: 'No hay una pantalla con ese código. Ábrela en el televisor y espera a que aparezca.' });
  db.prepare(`UPDATE screens SET name = ?, status = 'linked' WHERE id = ?`).run(name, screen.id);
  res.json({ screen: presentScreen(db.prepare('SELECT * FROM screens WHERE id = ?').get(screen.id)) });
});

app.post('/api/screens/:id/link', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const screen = db.prepare('SELECT * FROM screens WHERE id = ?').get(id);
  if (!screen) return res.status(404).json({ error: 'No se encontró la pantalla.' });
  const name = String(req.body.name || '').trim();
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Ponle un nombre de 2 a 40 caracteres.' });
  db.prepare(`UPDATE screens SET name = ?, status = 'linked' WHERE id = ?`).run(name, id);
  res.json({ screen: presentScreen(db.prepare('SELECT * FROM screens WHERE id = ?').get(id)) });
});

app.delete('/api/screens/:id', requireAuth, (req, res) => {
  const screen = db.prepare('SELECT * FROM screens WHERE id = ?').get(Number(req.params.id));
  if (!screen) return res.status(404).json({ error: 'No se encontró la pantalla.' });
  db.prepare('DELETE FROM screens WHERE id = ?').run(screen.id);
  if (screen.content_source && screen.content_kind !== 'youtube') {
    const still = num(db.prepare('SELECT COUNT(*) AS n FROM screens WHERE content_source = ?').get(screen.content_source).n);
    if (!still) fs.unlink(path.join(mediaDir, path.basename(screen.content_source)), () => {});
  }
  res.json({ ok: true });
});

app.post('/api/screens/:id/clear', requireAuth, (req, res) => {
  const screen = db.prepare('SELECT * FROM screens WHERE id = ?').get(Number(req.params.id));
  if (!screen) return res.status(404).json({ error: 'No se encontró la pantalla.' });
  db.prepare(`UPDATE screens SET content_kind = NULL, content_source = NULL, content_title = NULL, play_seconds = NULL, play_at = NULL, play_mark = NULL WHERE id = ?`).run(screen.id);
  res.json({ screen: presentScreen(db.prepare('SELECT * FROM screens WHERE id = ?').get(screen.id)) });
});

app.post('/api/screens/:id/share', requireAuth, (req, res) => {
  const screen = db.prepare('SELECT * FROM screens WHERE id = ?').get(Number(req.params.id));
  if (!screen) return res.status(404).json({ error: 'No se encontró la pantalla.' });
  if (!screen.content_kind || !screen.content_source) return res.status(400).json({ error: 'Esta pantalla no está reproduciendo nada.' });
  const target = String(req.body.target || '');
  const others = target === 'all'
    ? db.prepare(`SELECT * FROM screens WHERE status = 'linked' AND id != ?`).all(screen.id)
    : db.prepare(`SELECT * FROM screens WHERE id = ? AND status = 'linked' AND id != ?`).all(Number(target), screen.id);
  if (!others.length) return res.status(400).json({ error: 'Elige otra pantalla vinculada.' });
  const mark = crypto.randomBytes(8).toString('hex');
  const update = db.prepare(`UPDATE screens SET content_kind = ?, content_source = ?, content_title = ?, play_seconds = ?, play_at = ?, play_mark = ? WHERE id = ?`);
  for (const other of others) {
    update.run(screen.content_kind, screen.content_source, screen.content_title, screen.play_seconds, screen.play_at, mark, other.id);
  }
  res.json({ screens: db.prepare('SELECT * FROM screens ORDER BY status DESC, created_at DESC').all().map(presentScreen) });
});

app.post('/api/screens/play', requireAuth, uploadMedia, (req, res) => {
  const target = String(req.body.target || '');
  const kind = String(req.body.kind || '');
  const title = String(req.body.title || '').trim().slice(0, 80);
  let source = '';
  if (kind === 'youtube') {
    source = youtubeId(req.body.youtube);
    if (!source) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Pega un enlace válido de YouTube.' });
    }
  } else if (kind === 'image' || kind === 'video') {
    if (!req.file) return res.status(400).json({ error: kind === 'image' ? 'Selecciona una imagen.' : 'Selecciona un video.' });
    const ext = fileExtension(req.file);
    const imageExt = ['.jpg', '.png', '.webp', '.gif'];
    const videoExt = ['.mp4', '.webm', '.mov'];
    const valid = kind === 'image' ? imageExt.includes(ext) : videoExt.includes(ext);
    if (!valid) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({
        error: kind === 'image'
          ? 'La imagen debe ser JPG, PNG, WEBP o GIF.'
          : 'El video debe ser MP4, WEBM o MOV. Si es otro formato, pásalo a MP4.',
      });
    }
    source = req.file.filename;
  } else {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Elige imagen, video o YouTube.' });
  }
  const screens = target === 'all'
    ? db.prepare(`SELECT * FROM screens WHERE status = 'linked'`).all()
    : db.prepare(`SELECT * FROM screens WHERE id = ? AND status = 'linked'`).all(Number(target));
  if (!screens.length) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Elige una pantalla vinculada, o vincula una antes de reproducir.' });
  }
  const mark = crypto.randomBytes(8).toString('hex');
  const started = new Date().toISOString();
  const update = db.prepare(`UPDATE screens SET content_kind = ?, content_source = ?, content_title = ?, play_seconds = 0, play_at = ?, play_mark = ? WHERE id = ?`);
  for (const screen of screens) update.run(kind, source, title, started, mark, screen.id);
  res.json({ screens: db.prepare('SELECT * FROM screens ORDER BY status DESC, created_at DESC').all().map(presentScreen) });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'No encontrado.' });
});

app.use('/media', express.static(mediaDir, { maxAge: '1h', index: false, fallthrough: false }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));
app.use((req, res) => {
  if (req.method !== 'GET') return res.status(404).type('text').send('No encontrado.');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  if (req.path.startsWith('/api/')) {
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    const message = status === 500 ? 'Ocurrió un problema interno.' : error.message;
    return res.status(status).json({ error: message });
  }
  res.status(500).type('text').send('Ocurrió un problema interno.');
});

export default app;

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
const server = app.listen(PORT, () => {
  console.log('');
  console.log('  Tasca Los Sierra');
  console.log(`  Abre http://localhost:${PORT}`);
  console.log(process.env.DATABASE_URL ? '  Datos guardados en PostgreSQL' : `  Datos guardados en ${dbPath}`);
  if (seededAdmin) {
    console.log('  Usuario inicial: admin');
    console.log('  Contraseña inicial: LosSierra12');
    console.log('  Cámbiala en Cuenta después de entrar.');
  }
  console.log('');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`El puerto ${PORT} ya está en uso. Cierra el otro programa o inicia con otro puerto.`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
}
