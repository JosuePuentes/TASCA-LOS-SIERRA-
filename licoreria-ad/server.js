import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import bcrypt from 'bcryptjs';
import cookieSession from 'cookie-session';
import multer from 'multer';
import QRCode from 'qrcode';
import { openDatabase } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const QR_TTL_MS = 12 * 60 * 60 * 1000;
const onVercel = Boolean(process.env.VERCEL);
const negocio = JSON.parse(fs.readFileSync(path.join(__dirname, 'negocio.json'), 'utf8'));
const dataDir = onVercel
  ? path.join('/tmp', 'LicoreriaAD')
  : path.join(process.env.LOCALAPPDATA || path.join(__dirname, 'data'), 'LicoreriaAD');
const mediaDir = path.join(dataDir, 'uploads', 'media');
const receiptDir = path.join(dataDir, 'uploads', 'receipts');
const productImageDir = path.join(dataDir, 'uploads', 'products');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(receiptDir, { recursive: true });
fs.mkdirSync(productImageDir, { recursive: true });
const dbPath = path.join(dataDir, 'negocio.db');

function cleanHost(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
}

export const hosts = new Set(
  [...(Array.isArray(negocio.hosts) ? negocio.hosts : []), ...String(process.env.LICORERIA_HOSTS || '').split(',')]
    .map(cleanHost)
    .filter(Boolean),
);

const site = {
  id: negocio.id,
  schema: negocio.schema,
  name: negocio.name,
  shortName: negocio.shortName,
  codePrefix: negocio.codePrefix,
  description: negocio.description,
  themeColor: negocio.themeColor || '#1a120e',
  background: negocio.background || '#1a120e',
  eyebrow: negocio.eyebrow || '',
  lead: negocio.lead || '',
  loginTitle: negocio.loginTitle || '',
  loginLead: negocio.loginLead || '',
  adminUser: negocio.adminUser || 'admin',
  adminPassword: negocio.adminPassword,
  prefix: '',
  mediaDir,
  receiptDir,
  dbPath,
  db: openDatabase(dbPath, { schema: negocio.schema }),
  seededAdmin: false,
  session: cookieSession({
    name: negocio.sessionName || 'ad.session',
    keys: [`${process.env.LICORERIA_SESSION_SECRET || process.env.SESSION_SECRET || 'licoreria-ad-puerta-local'}:licoreria-ad`],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: false,
    overwrite: true,
  }),
};

function activeTenant() {
  return site;
}

const statementCache = new WeakMap();

function activeDb() {
  return activeTenant().db;
}

function cachedStatement(sql) {
  const real = activeDb();
  let map = statementCache.get(real);
  if (!map) {
    map = new Map();
    statementCache.set(real, map);
  }
  let statement = map.get(sql);
  if (!statement) {
    statement = real.prepare(sql);
    map.set(sql, statement);
  }
  return statement;
}

const db = {
  exec(sql) {
    return activeDb().exec(sql);
  },
  prepare(sql) {
    return {
      get(...params) {
        return cachedStatement(sql).get(...params);
      },
      all(...params) {
        return cachedStatement(sql).all(...params);
      },
      run(...params) {
        return cachedStatement(sql).run(...params);
      },
    };
  },
};

function num(value) {
  if (typeof value === 'bigint') return Number(value);
  return Number(value || 0);
}

function bootTenant() {
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

  CREATE TABLE IF NOT EXISTS combo_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    combo_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    FOREIGN KEY (combo_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

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
if (!columnNames('products').includes('units_per_box')) {
  db.exec('ALTER TABLE products ADD COLUMN units_per_box INTEGER NOT NULL DEFAULT 1');
}
if (!columnNames('products').includes('is_combo')) {
  db.exec('ALTER TABLE products ADD COLUMN is_combo INTEGER NOT NULL DEFAULT 0');
}
if (!columnNames('products').includes('code')) db.exec('ALTER TABLE products ADD COLUMN code TEXT');
if (!columnNames('products').includes('department')) db.exec('ALTER TABLE products ADD COLUMN department TEXT');
if (!columnNames('products').includes('pay_usd')) db.exec('ALTER TABLE products ADD COLUMN pay_usd INTEGER NOT NULL DEFAULT 1');
if (!columnNames('products').includes('pay_bs')) db.exec('ALTER TABLE products ADD COLUMN pay_bs INTEGER NOT NULL DEFAULT 1');
if (!columnNames('products').includes('image_file')) db.exec('ALTER TABLE products ADD COLUMN image_file TEXT');
if (!columnNames('products').includes('quick_sale')) db.exec('ALTER TABLE products ADD COLUMN quick_sale INTEGER NOT NULL DEFAULT 0');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    document TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS supplier_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL,
    invoice_date TEXT NOT NULL,
    loaded_at TEXT NOT NULL,
    due_date TEXT,
    payment_method TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
  );
  CREATE TABLE IF NOT EXISTS supplier_purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    cost_cents INTEGER NOT NULL,
    price_cents INTEGER NOT NULL,
    pack_count INTEGER,
    pack_cost_cents INTEGER,
    FOREIGN KEY (purchase_id) REFERENCES supplier_purchases(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    bcv_rate REAL NOT NULL DEFAULT 0,
    spent_at TEXT NOT NULL,
    note TEXT,
    user_id INTEGER,
    created_at TEXT NOT NULL
  );
`);
if (!columnNames('tickets').includes('alias')) db.exec('ALTER TABLE tickets ADD COLUMN alias TEXT');
if (!columnNames('tickets').includes('payment_method')) db.exec('ALTER TABLE tickets ADD COLUMN payment_method TEXT');
if (!columnNames('tickets').includes('receipt_file')) db.exec('ALTER TABLE tickets ADD COLUMN receipt_file TEXT');
if (!columnNames('screens').includes('play_seconds')) db.exec('ALTER TABLE screens ADD COLUMN play_seconds REAL');
if (!columnNames('screens').includes('play_at')) db.exec('ALTER TABLE screens ADD COLUMN play_at TEXT');
if (!columnNames('screens').includes('play_mark')) db.exec('ALTER TABLE screens ADD COLUMN play_mark TEXT');
if (!columnNames('purchase_items').includes('delivered_marks')) {
  db.exec('ALTER TABLE purchase_items ADD COLUMN delivered_marks TEXT');
}
if (!columnNames('purchases').includes('refunded_at')) {
  db.exec('ALTER TABLE purchases ADD COLUMN refunded_at TEXT');
}
if (!columnNames('supplier_purchase_items').includes('pack_count')) {
  db.exec('ALTER TABLE supplier_purchase_items ADD COLUMN pack_count INTEGER');
}
if (!columnNames('supplier_purchase_items').includes('pack_cost_cents')) {
  db.exec('ALTER TABLE supplier_purchase_items ADD COLUMN pack_cost_cents INTEGER');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number INTEGER NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    receipt_file TEXT,
    created_at TEXT NOT NULL,
    refunded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(created_at);
  CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    delivered_marks TEXT,
    FOREIGN KEY (invoice_id) REFERENCES invoices(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
  CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
`);
if (!columnNames('invoice_items').includes('cost_cents')) db.exec('ALTER TABLE invoice_items ADD COLUMN cost_cents INTEGER NOT NULL DEFAULT 0');
if (!columnNames('invoices').includes('currency')) db.exec(`ALTER TABLE invoices ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd'`);
if (!columnNames('invoices').includes('bcv_rate')) db.exec('ALTER TABLE invoices ADD COLUMN bcv_rate REAL NOT NULL DEFAULT 0');
if (!columnNames('invoices').includes('channel')) db.exec(`ALTER TABLE invoices ADD COLUMN channel TEXT NOT NULL DEFAULT 'barra'`);
if (!columnNames('invoices').includes('customer_document')) db.exec('ALTER TABLE invoices ADD COLUMN customer_document TEXT');
if (!columnNames('invoices').includes('payment_reference')) db.exec('ALTER TABLE invoices ADD COLUMN payment_reference TEXT');
if (!columnNames('invoice_items').includes('delivered_marks')) db.exec('ALTER TABLE invoice_items ADD COLUMN delivered_marks TEXT');
if (!columnNames('invoice_items').includes('combo_parts')) db.exec('ALTER TABLE invoice_items ADD COLUMN combo_parts TEXT');
if (!columnNames('invoice_items').includes('exploded_at')) db.exec('ALTER TABLE invoice_items ADD COLUMN exploded_at TEXT');
if (!columnNames('invoice_items').includes('source_item_id')) db.exec('ALTER TABLE invoice_items ADD COLUMN source_item_id INTEGER');
if (!columnNames('movements').includes('invoice_id')) {
  db.exec('ALTER TABLE movements ADD COLUMN invoice_id INTEGER');
}
db.exec(`
  INSERT INTO user_permissions (user_id, module)
  SELECT DISTINCT user_id, 'venta'
  FROM user_permissions
  WHERE module IN ('entradas', 'visor', 'eventos')
    AND user_id NOT IN (SELECT user_id FROM user_permissions WHERE module = 'venta')
`);

function allowProductDelete() {
  if (!process.env.DATABASE_URL) return;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT rel.relname AS table_name, con.conname AS name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
      WHERE nsp.nspname = '${activeTenant().schema}'
        AND rel.relname IN ('purchase_items', 'combo_items')
        AND att.attname = 'product_id'
        AND con.contype = 'f'
    `).all();
  } catch (error) {
    console.error('No se pudo revisar el inventario', error);
    return;
  }
  for (const row of rows) {
    if (!/^[a-z0-9_]+$/.test(row.table_name) || !/^[a-z0-9_]+$/.test(row.name)) continue;
    db.exec(`ALTER TABLE ${row.table_name} DROP CONSTRAINT ${row.name}`);
  }
}

allowProductDelete();

function allowEventDelete() {
  if (!process.env.DATABASE_URL) return;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT rel.relname AS table_name, con.conname AS name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
      WHERE nsp.nspname = '${activeTenant().schema}'
        AND rel.relname = 'tickets'
        AND att.attname = 'event_id'
        AND con.contype = 'f'
    `).all();
  } catch (error) {
    console.error('No se pudo revisar los eventos', error);
    return;
  }
  for (const row of rows) {
    if (!/^[a-z0-9_]+$/.test(row.table_name) || !/^[a-z0-9_]+$/.test(row.name)) continue;
    db.exec(`ALTER TABLE ${row.table_name} DROP CONSTRAINT ${row.name}`);
  }
}

allowEventDelete();

const tenant = activeTenant();
const userCount = num(db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
if (userCount === 0) {
  db.prepare('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 1, ?)').run(
    tenant.adminUser,
    bcrypt.hashSync(tenant.adminPassword, 10),
    new Date().toISOString(),
  );
  tenant.seededAdmin = true;
} else if (num(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n) === 0) {
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)').run();
}
const accessReset = 'admin_login_reset_1';
if (tenant.adminPassword && !db.prepare('SELECT value FROM settings WHERE key = ?').get(accessReset)) {
  const hash = bcrypt.hashSync(tenant.adminPassword, 10);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(tenant.adminUser);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, is_admin = 1 WHERE id = ?').run(hash, existing.id);
  } else {
    db.prepare('INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 1, ?)').run(
      tenant.adminUser,
      hash,
      new Date().toISOString(),
    );
  }
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING`).run(accessReset);
  tenant.seededAdmin = true;
}
}

bootTenant();

function flagOn(value) {
  return value === true || value === 1 || value === '1';
}

function toCents(value) {
  const text = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

function currencyOf(value) {
  return value === 'bs' ? 'bs' : 'usd';
}

function pricedInUsd(raw, currency) {
  const cents = toCents(raw);
  if (cents == null) return { cents: null };
  if (currencyOf(currency) !== 'bs') return { cents };
  const rate = currentRate();
  if (!(rate > 0)) return { error: 'Coloca la tasa BCV antes de anotar un monto en bolívares.' };
  const usd = Math.round(cents / rate);
  if (usd > 10000000) return { error: 'Ese monto en bolívares queda demasiado alto en dólares.' };
  return { cents: usd };
}

function normalizeCode(raw) {
  const text = String(raw || '').trim().toUpperCase();
  const prefix = activeTenant().codePrefix;
  const match = text.match(new RegExp(`${prefix}-[A-F0-9]{10}`));
  return match ? match[0] : text;
}

function newCode() {
  return `${activeTenant().codePrefix}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
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

function readUnitsPerBox(value, fallback = 1) {
  if (value == null || value === '') return fallback;
  return wholeNumber(value, 1, 10000);
}

function unitsFromPack(count, unitsPerBox, pack, { min = 0 } = {}) {
  const mode = pack === 'box' ? 'box' : 'unit';
  const amount = wholeNumber(count, min, 100000);
  if (amount == null) {
    return { error: min > 0
      ? 'Indica una cantidad entera entre 1 y 100000.'
      : 'La cantidad tiene que ser un número entero entre 0 y 100000.' };
  }
  if (mode === 'unit') return { units: amount, note: '' };
  if (unitsPerBox < 2) {
    return { error: 'Pon cuántas unidades trae la caja. Tiene que ser 2 o más.' };
  }
  const units = amount * unitsPerBox;
  if (units > 1000000) return { error: 'Esa cantidad de cajas pasa de 1000000 unidades.' };
  return { units, note: `${amount} cajas × ${unitsPerBox} = ${units} unidades` };
}

function centsPerUnit(cents, unitsPerBox, mode) {
  if (cents == null) return { cents: null };
  if (mode !== 'box') return { cents };
  if (!unitsPerBox || unitsPerBox < 2) {
    return { error: 'Pon cuántas unidades trae la caja. Tiene que ser 2 o más.' };
  }
  return { cents: Math.round(cents / unitsPerBox) };
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
    unitsPerBox: Math.max(1, num(row.units_per_box) || 1),
    stockCostCents: costCents * stock,
    stockSaleCents: priceCents * stock,
    stockProfitCents: (priceCents - costCents) * stock,
    active: Boolean(row.active),
    isCombo: Boolean(row.is_combo),
    code: row.code || '',
    department: row.department || '',
    imageUrl: row.image_file ? `/api/products/${num(row.id)}/image?v=${encodeURIComponent(row.image_file)}` : '',
    quickSale: Boolean(row.quick_sale),
    payUsd: row.is_combo ? Boolean(row.pay_usd) : true,
    payBs: row.is_combo ? Boolean(row.pay_bs) : true,
    createdAt: row.created_at,
  };
}

function comboParts(comboId) {
  return db.prepare(`
    SELECT ci.product_id, ci.quantity, p.name, p.cost_cents, p.stock, p.active
    FROM combo_items ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.combo_id = ?
    ORDER BY p.name COLLATE NOCASE
  `).all(comboId).map((row) => ({
    productId: num(row.product_id),
    name: row.name,
    quantity: num(row.quantity),
    costCents: num(row.cost_cents),
    stock: num(row.stock),
    active: Boolean(row.active),
  }));
}

function presentCatalog(row) {
  const base = presentProduct(row);
  if (!row.is_combo) return base;
  const parts = comboParts(row.id);
  const costCents = parts.reduce((sum, part) => sum + part.costCents * part.quantity, 0);
  const available = parts.length
    ? parts.reduce((left, part) => Math.min(left, part.active && part.quantity > 0 ? Math.floor(part.stock / part.quantity) : 0), Infinity)
    : 0;
  return {
    ...base,
    isCombo: true,
    costCents,
    profitCents: base.priceCents - costCents,
    stock: Number.isFinite(available) ? available : 0,
    parts,
    payUsd: Boolean(row.pay_usd),
    payBs: Boolean(row.pay_bs),
    stockCostCents: 0,
    stockSaleCents: 0,
    stockProfitCents: 0,
  };
}

function readComboParts(list) {
  if (!Array.isArray(list) || !list.length || list.length > 20) {
    return { error: 'Agrega al menos un producto al combo.' };
  }
  const merged = new Map();
  for (const raw of list) {
    const productId = Number(raw?.productId);
    const quantity = wholeNumber(raw?.quantity, 1, 500);
    if (!productId || quantity == null) return { error: 'Revisa las unidades de cada producto del combo.' };
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product || product.is_combo) return { error: 'El combo solo puede usar productos sueltos.' };
    merged.set(productId, (merged.get(productId) || 0) + quantity);
  }
  const parts = [...merged.entries()].map(([productId, quantity]) => ({ productId, quantity }));
  if (parts.length > 20) return { error: 'Un combo admite hasta 20 productos.' };
  return { parts };
}

function saveComboParts(comboId, parts) {
  db.prepare('DELETE FROM combo_items WHERE combo_id = ?').run(comboId);
  const insert = db.prepare('INSERT INTO combo_items (combo_id, product_id, quantity) VALUES (?, ?, ?)');
  for (const part of parts) insert.run(comboId, part.productId, part.quantity);
}

function itemParts(row) {
  if (row.combo_parts) {
    try {
      const parsed = JSON.parse(row.combo_parts);
      if (Array.isArray(parsed)) {
        return parsed.map((part) => ({
          productId: num(part.productId),
          name: String(part.name || '').trim(),
          quantity: num(part.quantity),
        })).filter((part) => part.productId && part.name && part.quantity > 0);
      }
    } catch {
      // Si la receta guardada no se lee, se usa la actual.
    }
  }
  if (row.source_item_id || row.exploded_at) return [];
  const product = db.prepare('SELECT is_combo FROM products WHERE id = ?').get(row.product_id);
  if (!product || !flagOn(product.is_combo)) return [];
  return comboParts(row.product_id).map((part) => ({
    productId: part.productId,
    name: part.name,
    quantity: part.quantity,
  }));
}

function readMarks(row) {
  const quantity = num(row.quantity);
  const delivered = Math.min(num(row.delivered), quantity);
  const marks = [];
  const seen = new Set();
  if (row.delivered_marks) {
    try {
      const parsed = JSON.parse(row.delivered_marks);
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          const number = Number(value?.n ?? value);
          const at = typeof value?.at === 'string' ? value.at : '';
          if (!Number.isInteger(number) || number < 1 || number > quantity || seen.has(number)) continue;
          marks.push({ n: number, at });
          seen.add(number);
        }
      }
    } catch {
      marks.length = 0;
      seen.clear();
    }
  }
  if (marks.length < delivered) {
    for (let number = 1; number <= quantity && marks.length < delivered; number += 1) {
      if (seen.has(number)) continue;
      marks.push({ n: number, at: '' });
      seen.add(number);
    }
  }
  marks.sort((left, right) => left.n - right.n);
  return marks;
}

function marksFor(row) {
  return readMarks(row).map((mark) => mark.n);
}

function withDeliveryTime(row, picked, at) {
  return [...readMarks(row), ...picked.map((number) => ({ n: number, at }))].sort((left, right) => left.n - right.n);
}

function presentItem(row) {
  const quantity = num(row.quantity);
  const marks = readMarks(row);
  const deliveredUnits = marks.map((mark) => mark.n);
  const delivered = deliveredUnits.length;
  const deliveredAt = {};
  for (const mark of marks) {
    if (mark.at) deliveredAt[mark.n] = mark.at;
  }
  const parts = itemParts(row);
  const exploded = Boolean(row.exploded_at);
  const sourceItemId = num(row.source_item_id);
  return {
    id: num(row.id),
    purchaseId: num(row.purchase_id),
    productId: num(row.product_id),
    productName: row.product_name,
    unitPriceCents: num(row.unit_price_cents),
    quantity,
    delivered,
    deliveredUnits,
    deliveredAt,
    remaining: quantity - delivered,
    totalCents: quantity * num(row.unit_price_cents),
    exploded,
    sourceItemId,
    parts,
    canSplit: !exploded && !sourceItemId && delivered === 0 && parts.length > 0,
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
      refundedAt: purchase.refunded_at || null,
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

function businessParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Caracas',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const bag = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
  };
}

function businessInstant(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour + 4, minute));
}

function shiftDate(year, month, day, days) {
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function businessYmd(date) {
  const parts = businessParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function parseHour(value) {
  if (value == null || value === '') return null;
  const hour = Number(value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    const error = new Error('Elige una hora entre 00 y 23.');
    error.status = 400;
    throw error;
  }
  return hour;
}

function hoursInWindow(fromHour, toHour) {
  if (fromHour == null && toHour == null) return Array.from({ length: 24 }, (_, hour) => hour);
  const start = fromHour == null ? 0 : fromHour;
  const end = toHour == null ? 23 : toHour;
  const hours = [];
  if (start <= end) {
    for (let hour = start; hour <= end; hour += 1) hours.push(hour);
  } else {
    for (let hour = start; hour <= 23; hour += 1) hours.push(hour);
    for (let hour = 0; hour <= end; hour += 1) hours.push(hour);
  }
  return hours;
}

function matchesHour(iso, fromHour, toHour) {
  if (fromHour == null && toHour == null) return true;
  const hour = businessParts(new Date(iso)).hour;
  return hoursInWindow(fromHour, toHour).includes(hour);
}

function hourWindowLabel(fromHour, toHour) {
  if (fromHour == null && toHour == null) return '';
  const start = `${String(fromHour == null ? 0 : fromHour).padStart(2, '0')}:00`;
  const end = `${String(toHour == null ? 23 : toHour).padStart(2, '0')}:59`;
  return `${start}–${end}`;
}

function businessRange(preset, fromStr, toStr) {
  const today = businessParts(new Date());
  const atStart = (parts) => businessInstant(parts.year, parts.month, parts.day);
  if (preset === 'day' || preset === 'hour') {
    const next = shiftDate(today.year, today.month, today.day, 1);
    return { from: atStart(today), to: businessInstant(next.year, next.month, next.day) };
  }
  if (preset === 'week') {
    const index = new Date(Date.UTC(today.year, today.month - 1, today.day, 16)).getUTCDay();
    const diff = index === 0 ? 6 : index - 1;
    const monday = shiftDate(today.year, today.month, today.day, -diff);
    const next = shiftDate(monday.year, monday.month, monday.day, 7);
    return { from: businessInstant(monday.year, monday.month, monday.day), to: businessInstant(next.year, next.month, next.day) };
  }
  if (preset === 'month') {
    const nextMonth = today.month === 12
      ? { year: today.year + 1, month: 1, day: 1 }
      : { year: today.year, month: today.month + 1, day: 1 };
    return { from: businessInstant(today.year, today.month, 1), to: businessInstant(nextMonth.year, nextMonth.month, 1) };
  }
  if (preset === 'year') {
    return { from: businessInstant(today.year, 1, 1), to: businessInstant(today.year + 1, 1, 1) };
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
    const start = { year: from.getFullYear(), month: from.getMonth() + 1, day: from.getDate() };
    const finish = shiftDate(end.getFullYear(), end.getMonth() + 1, end.getDate(), 1);
    const fromDate = businessInstant(start.year, start.month, start.day);
    const toDate = businessInstant(finish.year, finish.month, finish.day);
    const span = Math.round((toDate - fromDate) / 86400000);
    if (span > 3660) {
      const error = new Error('El rango máximo es de 10 años.');
      error.status = 400;
      throw error;
    }
    return { from: fromDate, to: toDate };
  }
  const error = new Error('Elige un periodo válido.');
  error.status = 400;
  throw error;
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

const MODULES = ['resumen', 'venta', 'barra', 'inventario', 'compras', 'cargas', 'gastos', 'ventas', 'movimientos', 'pantallas', 'usuarios'];

function presentSessionUser(user) {
  const known = new Set(MODULES);
  const permissions = user.is_admin
    ? [...MODULES]
    : db.prepare('SELECT module FROM user_permissions WHERE user_id = ? ORDER BY module').all(user.id)
      .map((row) => row.module)
      .filter((name) => known.has(name));
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
  { test: /^\/api\/summary$/, modules: ['resumen', 'venta'] },
  { test: /^\/api\/rate$/, modules: ['venta', 'resumen', 'inventario', 'compras', 'gastos'] },
  { test: /^\/api\/suppliers(\/|$)/, modules: ['compras'] },
  { test: /^\/api\/supplier-purchases(\/|$)/, modules: ['compras'] },
  { test: /^\/api\/stock$/, modules: ['cargas', 'inventario'] },
  { test: /^\/api\/expenses(\/|$)/, modules: ['gastos', 'resumen'] },
  { test: /^\/api\/pos\/sales$/, modules: ['venta'] },
  { test: /^\/api\/notices\/barra$/, modules: ['barra'] },
  { test: /^\/api\/invoices\/\d+\/deliver$/, modules: ['barra'] },
  { test: /^\/api\/invoices\/\d+\/items\/\d+\/split$/, modules: ['barra'] },
  { test: /^\/api\/invoices\/\d+\/refund$/, modules: ['barra'] },
  { test: /^\/api\/invoices\/\d+\/receipt$/, modules: ['venta', 'barra', 'movimientos'] },
  { test: /^\/api\/invoices\/code\//, modules: ['barra'] },
  { test: /^\/api\/invoices(\/|$)/, modules: ['barra', 'venta'] },
  { test: /^\/api\/events(\/|$)/, modules: ['eventos'] },
  { test: /^\/api\/tickets$/, modules: ['entradas'] },
  { test: /^\/api\/tickets\/search$/, modules: ['visor'] },
  { test: /^\/api\/tickets\/\d+\/receipt$/, modules: ['visor', 'entradas'] },
  { test: /^\/api\/tickets\/code\//, modules: ['visor'] },
  { test: /^\/api\/visor\/sales$/, modules: ['visor'] },
  { test: /^\/api\/barra\/sales(\/|$)/, modules: ['barra'] },
  { test: /^\/api\/purchases\/\d+\/refund$/, modules: ['barra'] },
  { test: /^\/api\/products(\/|$)/, methods: ['POST', 'PATCH', 'DELETE'], modules: ['inventario'] },
  { test: /^\/api\/products(\/|$)/, modules: ['inventario', 'venta', 'compras', 'cargas'] },
  { test: /^\/api\/combos(\/|$)/, modules: ['inventario'] },
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
  const rule = API_RULES.find((item) => item.test.test(req.path) && (!item.methods || item.methods.includes(req.method)));
  if (!rule) return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
  if (req.account.isAdmin || rule.modules.some((name) => req.account.permissions.includes(name))) return next();
  return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
}

const insertMovement = db.prepare(`
  INSERT INTO movements (
    kind, product_id, product_name, quantity, unit_price_cents, purchase_id, ticket_id, note, user_id, created_at, invoice_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    entry.invoiceId ?? null,
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
      destination: (req, file, cb) => cb(null, typeof dir === 'function' ? dir() : dir),
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

const uploadReceipt = uploadSingle(() => activeTenant().receiptDir, (file) => ['.jpg', '.png', '.webp', '.gif', '.pdf'].includes(fileExtension(file)), 'El comprobante debe ser una imagen o un PDF.');
const uploadProductImage = uploadSingle(() => productImageDir, (file) => ['.jpg', '.png', '.webp', '.gif'].includes(fileExtension(file)), 'La imagen debe ser JPG, PNG, WEBP o GIF.');
const uploadMedia = uploadSingle(() => activeTenant().mediaDir, (file) => ['.jpg', '.png', '.webp', '.gif', '.mp4', '.webm', '.mov'].includes(fileExtension(file)), 'Usa una imagen o un video MP4, WEBM o MOV.');

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
    source: row.content_kind === 'youtube' ? row.content_source : `${activeTenant().prefix}/media/${row.content_source}`,
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
app.use(site.session);
app.use((req, res, next) => {
  if (hosted && req.secure) req.sessionOptions.secure = true;
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

function passwordMatches(password, hash) {
  const text = Buffer.isBuffer(hash) ? hash.toString('utf8') : String(hash || '');
  if (!text.startsWith('$2')) return false;
  try {
    return bcrypt.compareSync(password, text);
  } catch {
    return false;
  }
}

app.post('/api/login', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !passwordMatches(password, user.password_hash)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }
    req.session.user = { id: num(user.id), username: user.username };
    res.json({ user: presentSessionUser(user) });
  } catch (error) {
    console.error(error);
    const code = String(error.code || '');
    if (code === '42P01' || code === '42703') {
      return res.status(500).json({ error: 'La base de datos de la licorería está incompleta.' });
    }
    if (code === '28P01' || code === '57P01' || /connect|terminated|timeout|ECONN/i.test(error.message || '')) {
      return res.status(500).json({ error: 'No se pudo conectar con la base de datos. Intenta de nuevo.' });
    }
    return res.status(500).json({ error: 'Ocurrió un problema interno.' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user) return res.json({ user: null });
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

function removeEvent(id) {
  const sqlite = !process.env.DATABASE_URL;
  if (sqlite) db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
  } finally {
    if (sqlite) db.exec('PRAGMA foreign_keys = ON');
  }
}

app.delete('/api/events/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'No se encontró el evento.' });
  removeEvent(id);
  res.json({ ok: true });
});

app.post('/api/tickets', requireAuth, uploadReceipt, asyncRoute(async (req, res) => {
  const eventId = Number(req.body.eventId);
  const quantity = Number(req.body.quantity);
  const mode = req.body.mode === 'group' ? 'group' : req.body.mode === 'individual' ? 'individual' : null;
  const alias = String(req.body.alias || '').trim();
  const free = req.body.free === 'on' || req.body.free === '1' || req.body.free === 'true' || req.body.free === true;
  const paymentMethod = free ? 'cortesia' : String(req.body.paymentMethod || '');
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
  if (!free && !PAYMENTS.has(paymentMethod)) {
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
          free ? 0 : num(event.price_cents),
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
  res.sendFile(path.join(activeTenant().receiptDir, path.basename(ticket.receipt_file)));
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
  const products = db.prepare('SELECT * FROM products ORDER BY is_combo, active DESC, name COLLATE NOCASE').all();
  res.json({ products: products.map(presentCatalog) });
});

app.post('/api/products', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const code = String(req.body.code || '').trim().slice(0, 40);
  const department = String(req.body.department || '').trim().slice(0, 60);
  const unitsPerBox = readUnitsPerBox(req.body.unitsPerBox, 1);
  const packed = unitsFromPack(req.body.stock, unitsPerBox, req.body.pack, { min: 0 });
  const costPer = req.body.pack === 'box' ? 'box' : 'unit';
  const costCurrency = currencyOf(req.body.costCurrency);
  const priceCurrency = currencyOf(req.body.priceCurrency);
  const costParsed = pricedInUsd(req.body.cost, costCurrency);
  if (costParsed.error) return res.status(400).json({ error: costParsed.error });
  let costCents = costParsed.cents;
  const priceParsed = pricedInUsd(req.body.price, priceCurrency);
  if (priceParsed.error) return res.status(400).json({ error: priceParsed.error });
  let priceCents = priceParsed.cents;
  const boxParsed = req.body.boxPrice == null || req.body.boxPrice === '' ? { cents: null } : pricedInUsd(req.body.boxPrice, priceCurrency);
  if (boxParsed.error) return res.status(400).json({ error: boxParsed.error });
  const boxPriceCents = boxParsed.cents;
  if (name.length < 2 || name.length > 80) {
    return res.status(400).json({ error: 'El nombre debe tener entre 2 y 80 caracteres.' });
  }
  if (unitsPerBox == null) return res.status(400).json({ error: 'Las unidades por caja tienen que ser un número entero entre 1 y 10000.' });
  if (costCents == null || costCents > 10000000) {
    return res.status(400).json({ error: 'Escribe el costo, con hasta dos decimales.' });
  }
  const costSplit = centsPerUnit(costCents, unitsPerBox, costPer);
  if (costSplit.error) return res.status(400).json({ error: costSplit.error });
  costCents = costSplit.cents;
  if (priceCents == null && boxPriceCents != null) {
    const priceSplit = centsPerUnit(boxPriceCents, unitsPerBox, 'box');
    if (priceSplit.error) return res.status(400).json({ error: priceSplit.error });
    priceCents = priceSplit.cents;
  }
  if ((priceCents == null || req.body.price === '') && req.body.profit != null && req.body.profit !== '') {
    const profitParsed = pricedInUsd(req.body.profit, priceCurrency);
    if (profitParsed.error) return res.status(400).json({ error: profitParsed.error });
    if (profitParsed.cents == null) return res.status(400).json({ error: 'Escribe la utilidad, con hasta dos decimales.' });
    priceCents = costCents + profitParsed.cents;
  }
  if (priceCents == null || priceCents > 10000000) {
    return res.status(400).json({ error: 'Escribe el precio de venta por unidad, con hasta dos decimales.' });
  }
  if (costCents > 10000000) {
    return res.status(400).json({ error: 'El costo por unidad queda demasiado alto.' });
  }
  if (packed.error) return res.status(400).json({ error: packed.error });
  if (code && db.prepare('SELECT id FROM products WHERE code = ? AND is_combo = 0').get(code)) {
    return res.status(409).json({ error: 'Ya hay un producto con ese código.' });
  }
  const info = db.prepare('INSERT INTO products (name, code, department, cost_cents, price_cents, stock, units_per_box, active, quick_sale, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').run(
    name,
    code || null,
    department || null,
    costCents,
    priceCents,
    packed.units,
    unitsPerBox,
    req.body.quickSale ? 1 : 0,
    new Date().toISOString(),
  );
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(num(info.lastInsertRowid));
  if (packed.units > 0) {
    logMovement({
      kind: 'entrada',
      productId: num(product.id),
      productName: product.name,
      quantity: packed.units,
      unitPriceCents: num(product.price_cents),
      userId: req.account?.id,
      note: packed.note ? `Alta: ${packed.note}` : 'Alta de producto',
    });
  }
  res.status(201).json({ product: presentProduct(product) });
});

app.patch('/api/products/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'No se encontró el producto.' });
  if (current.is_combo && req.body.addStock != null) {
    return res.status(400).json({ error: 'Un combo no guarda existencias. Suma las unidades en cada producto.' });
  }
  if (current.is_combo && req.body.name == null && req.body.price == null && req.body.active != null) {
    db.prepare('UPDATE products SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, id);
    return res.json({ product: presentCatalog(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) });
  }
  if (current.is_combo) {
    return res.status(400).json({ error: 'Edita el combo desde la sección de combos.' });
  }
  if (req.body.addStock != null) {
    const perBox = Math.max(1, num(current.units_per_box) || 1);
    const packed = unitsFromPack(req.body.addStock, perBox, req.body.pack, { min: 1 });
    if (packed.error) return res.status(400).json({ error: packed.error });
    if (num(current.stock) + packed.units > 1000000) {
      return res.status(400).json({ error: 'Esa suma pasa de 1000000 unidades en existencia.' });
    }
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(packed.units, id);
    logMovement({
      kind: 'entrada',
      productId: id,
      productName: current.name,
      quantity: packed.units,
      unitPriceCents: num(current.price_cents),
      userId: req.account?.id,
      note: packed.note || 'Suma de existencias',
    });
    return res.json({ product: presentProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) });
  }
  const name = req.body.name == null ? current.name : String(req.body.name).trim();
  const code = req.body.code == null ? (current.code || '') : String(req.body.code).trim().slice(0, 40);
  const department = req.body.department == null ? (current.department || '') : String(req.body.department).trim().slice(0, 60);
  const costCurrency = currencyOf(req.body.costCurrency);
  const priceCurrency = currencyOf(req.body.priceCurrency);
  let costCents = num(current.cost_cents);
  if (req.body.cost != null) {
    const costParsed = pricedInUsd(req.body.cost, costCurrency);
    if (costParsed.error) return res.status(400).json({ error: costParsed.error });
    costCents = costParsed.cents;
  }
  let priceCents = null;
  if (req.body.price != null && req.body.price !== '') {
    const priceParsed = pricedInUsd(req.body.price, priceCurrency);
    if (priceParsed.error) return res.status(400).json({ error: priceParsed.error });
    priceCents = priceParsed.cents;
  }
  if (priceCents == null && req.body.profit != null && req.body.profit !== '') {
    const profitParsed = pricedInUsd(req.body.profit, priceCurrency);
    if (profitParsed.error) return res.status(400).json({ error: profitParsed.error });
    if (profitParsed.cents == null || costCents == null) return res.status(400).json({ error: 'Escribe la utilidad, con hasta dos decimales.' });
    priceCents = costCents + profitParsed.cents;
  }
  if (priceCents == null) priceCents = num(current.price_cents);
  const stock = req.body.stock == null ? num(current.stock) : wholeNumber(req.body.stock, 0, 1000000);
  const unitsPerBox = req.body.unitsPerBox == null ? Math.max(1, num(current.units_per_box) || 1) : readUnitsPerBox(req.body.unitsPerBox, null);
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
  if (unitsPerBox == null) return res.status(400).json({ error: 'Las unidades por caja tienen que ser un número entero entre 1 y 10000.' });
  if (stock == null) return res.status(400).json({ error: 'Las existencias tienen que ser un número entero entre 0 y 1000000.' });
  const delta = stock - num(current.stock);
  if (code && !current.is_combo && db.prepare('SELECT id FROM products WHERE code = ? AND is_combo = 0 AND id <> ?').get(code, id)) {
    return res.status(409).json({ error: 'Ya hay un producto con ese código.' });
  }
  const quickSale = req.body.quickSale == null ? Boolean(current.quick_sale) : Boolean(req.body.quickSale);
  db.prepare('UPDATE products SET name = ?, code = ?, department = ?, cost_cents = ?, price_cents = ?, stock = ?, units_per_box = ?, active = ?, quick_sale = ? WHERE id = ?').run(name, code || null, department || null, costCents, priceCents, stock, unitsPerBox, active ? 1 : 0, quickSale ? 1 : 0, id);
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

function removeProduct(id) {
  const sqlite = !process.env.DATABASE_URL;
  if (sqlite) db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM combo_items WHERE combo_id = ? OR product_id = ?').run(id, id);
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* la transacción ya se cerró */ }
    throw error;
  } finally {
    if (sqlite) db.exec('PRAGMA foreign_keys = ON');
  }
}

app.delete('/api/products/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'No se encontró el producto.' });
  if (current.image_file) fs.unlink(path.join(productImageDir, path.basename(current.image_file)), () => {});
  removeProduct(id);
  res.json({ ok: true });
});

app.post('/api/products/:id/image', requireAuth, uploadProductImage, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM products WHERE id = ? AND is_combo = 0').get(id);
  if (!current) return res.status(404).json({ error: 'No se encontró el producto.' });
  if (!req.file) return res.status(400).json({ error: 'Elige una imagen.' });
  if (req.file.size > 8 * 1024 * 1024) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'La imagen debe pesar 8 MB o menos.' });
  }
  if (current.image_file) fs.unlink(path.join(productImageDir, path.basename(current.image_file)), () => {});
  db.prepare('UPDATE products SET image_file = ? WHERE id = ?').run(req.file.filename, id);
  res.json({ product: presentProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) });
});

app.get('/api/products/:id/image', requireAuth, (req, res) => {
  const product = db.prepare('SELECT image_file FROM products WHERE id = ?').get(Number(req.params.id));
  if (!product?.image_file) return res.status(404).json({ error: 'Este producto no tiene imagen.' });
  res.sendFile(path.join(productImageDir, path.basename(product.image_file)));
});

app.post('/api/combos', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const priceCents = toCents(req.body.price);
  const active = req.body.active == null ? true : Boolean(req.body.active);
  const recipe = readComboParts(req.body.items);
  if (name.length < 2 || name.length > 80) {
    return res.status(400).json({ error: 'El nombre del combo debe tener entre 2 y 80 caracteres.' });
  }
  if (priceCents == null || priceCents > 10000000) {
    return res.status(400).json({ error: 'Escribe el precio de venta del combo, con hasta dos decimales.' });
  }
  if (recipe.error) return res.status(400).json({ error: recipe.error });
  const payUsd = req.body.payUsd == null ? true : Boolean(req.body.payUsd);
  const payBs = req.body.payBs == null ? false : Boolean(req.body.payBs);
  if (!payUsd && !payBs) return res.status(400).json({ error: 'Elige al menos una moneda para el combo: dólares o bolívares.' });
  const code = String(req.body.code || '').trim().slice(0, 40);
  const info = db.prepare(`
    INSERT INTO products (name, code, cost_cents, price_cents, stock, units_per_box, active, is_combo, pay_usd, pay_bs, created_at)
    VALUES (?, ?, 0, ?, 0, 1, ?, 1, ?, ?, ?)
  `).run(name, code || null, priceCents, active ? 1 : 0, payUsd ? 1 : 0, payBs ? 1 : 0, new Date().toISOString());
  const id = num(info.lastInsertRowid);
  saveComboParts(id, recipe.parts);
  res.status(201).json({ product: presentCatalog(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) });
});

app.patch('/api/combos/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM products WHERE id = ? AND is_combo = 1').get(id);
  if (!current) return res.status(404).json({ error: 'No se encontró el combo.' });
  const name = req.body.name == null ? current.name : String(req.body.name).trim();
  const priceCents = req.body.price == null ? num(current.price_cents) : toCents(req.body.price);
  const active = req.body.active == null ? Boolean(current.active) : Boolean(req.body.active);
  if (name.length < 2 || name.length > 80) {
    return res.status(400).json({ error: 'El nombre del combo debe tener entre 2 y 80 caracteres.' });
  }
  if (priceCents == null || priceCents > 10000000) {
    return res.status(400).json({ error: 'Escribe el precio de venta del combo, con hasta dos decimales.' });
  }
  let parts = null;
  if (req.body.items != null) {
    const recipe = readComboParts(req.body.items);
    if (recipe.error) return res.status(400).json({ error: recipe.error });
    parts = recipe.parts;
  }
  const payUsd = req.body.payUsd == null ? Boolean(current.pay_usd) : Boolean(req.body.payUsd);
  const payBs = req.body.payBs == null ? Boolean(current.pay_bs) : Boolean(req.body.payBs);
  if (!payUsd && !payBs) return res.status(400).json({ error: 'Elige al menos una moneda para el combo: dólares o bolívares.' });
  const code = req.body.code == null ? (current.code || '') : String(req.body.code).trim().slice(0, 40);
  db.prepare('UPDATE products SET name = ?, code = ?, price_cents = ?, active = ?, pay_usd = ?, pay_bs = ? WHERE id = ?').run(name, code || null, priceCents, active ? 1 : 0, payUsd ? 1 : 0, payBs ? 1 : 0, id);
  if (parts) saveComboParts(id, parts);
  res.json({ product: presentCatalog(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) });
});

app.delete('/api/combos/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM products WHERE id = ? AND is_combo = 1').get(id);
  if (!current) return res.status(404).json({ error: 'No se encontró el combo.' });
  removeProduct(id);
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
  const takeStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND active = 1 AND is_combo = 0 AND stock >= ?');
  let purchaseId = 0;
  db.exec('BEGIN');
  try {
    const lines = [];
    const consumption = new Map();
    for (const [productId, quantity] of merged) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product || !product.active) throw httpError(400, 'Hay un producto que ya no está a la venta.');
      lines.push({ product, quantity });
      if (product.is_combo) {
        const parts = db.prepare('SELECT product_id, quantity FROM combo_items WHERE combo_id = ?').all(product.id);
        if (!parts.length) throw httpError(400, `${product.name} no tiene productos.`);
        for (const part of parts) {
          const units = num(part.quantity) * quantity;
          consumption.set(num(part.product_id), (consumption.get(num(part.product_id)) || 0) + units);
        }
      } else {
        consumption.set(productId, (consumption.get(productId) || 0) + quantity);
      }
    }
    for (const [productId, quantity] of consumption) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product || product.is_combo) throw httpError(400, 'Hay un producto del combo que ya no existe.');
      if (!product.active) throw httpError(400, `${product.name} ya no está a la venta.`);
      if (num(product.stock) < quantity) {
        throw httpError(400, `No hay suficientes existencias de ${product.name}. Quedan ${num(product.stock)}.`);
      }
    }
    const info = insertPurchase.run(ticket.id, paymentMethod, new Date().toISOString());
    purchaseId = num(info.lastInsertRowid);
    for (const [productId, quantity] of consumption) {
      const taken = takeStock.run(quantity, productId, quantity);
      if (!num(taken.changes)) {
        const product = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
        throw httpError(400, `No se pudo descontar ${product?.name || 'un producto'} del inventario.`);
      }
    }
    for (const line of lines) {
      insertItem.run(purchaseId, line.product.id, line.product.name, num(line.product.price_cents), line.quantity);
      logMovement({
        kind: 'venta',
        productId: num(line.product.id),
        productName: line.product.name,
        quantity: line.quantity,
        unitPriceCents: num(line.product.price_cents),
        purchaseId,
        ticketId: ticket.id,
        userId: req.account?.id,
        note: ticket.code,
      });
      if (!line.product.is_combo) continue;
      const parts = db.prepare(`
        SELECT ci.quantity, p.id, p.name
        FROM combo_items ci
        JOIN products p ON p.id = ci.product_id
        WHERE ci.combo_id = ?
      `).all(line.product.id);
      for (const part of parts) {
        logMovement({
          kind: 'venta',
          productId: num(part.id),
          productName: part.name,
          quantity: num(part.quantity) * line.quantity,
          purchaseId,
          ticketId: ticket.id,
          userId: req.account?.id,
          note: `Combo ${line.product.name}`,
        });
      }
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

function barraSale(id) {
  const purchase = db.prepare(`
    SELECT p.*, t.code, t.alias, t.event_name, t.status
    FROM purchases p
    JOIN tickets t ON t.id = p.ticket_id
    WHERE p.id = ?
  `).get(id);
  if (!purchase) return null;
  const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').all(id).map(presentItem);
  return {
    id: num(purchase.id),
    paymentMethod: purchase.payment_method || '',
    createdAt: purchase.created_at,
    refundedAt: purchase.refunded_at || null,
    totalCents: items.reduce((sum, item) => sum + item.totalCents, 0),
    ticketCode: purchase.code || '',
    alias: purchase.alias || '',
    eventName: purchase.event_name || '',
    ticketStatus: purchase.status || '',
    items,
  };
}

app.get('/api/barra/sales', requireAuth, (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 80);
  const params = [];
  let where = '';
  if (query) {
    where = `WHERE COALESCE(t.alias, '') LIKE ? COLLATE NOCASE OR t.code LIKE ? COLLATE NOCASE`;
    const like = `%${query.replace(/[%_]/g, '')}%`;
    params.push(like, like);
  }
  const purchases = db.prepare(`
    SELECT p.id
    FROM purchases p
    JOIN tickets t ON t.id = p.ticket_id
    ${where}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT 80
  `).all(...params);
  res.json({ sales: purchases.map((row) => barraSale(num(row.id))) });
});

app.get('/api/barra/sales/:id', requireAuth, asyncRoute(async (req, res) => {
  const sale = barraSale(Number(req.params.id));
  if (!sale) return res.status(404).json({ error: 'No se encontró la venta.' });
  const qrDataUrl = await QRCode.toDataURL(sale.ticketCode, {
    margin: 1,
    width: 360,
    errorCorrectionLevel: 'M',
    color: { dark: '#241812', light: '#ffffff' },
  });
  res.json({ sale: { ...sale, qrDataUrl } });
}));

app.post('/api/purchases/:id/refund', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
  if (!purchase) return res.status(404).json({ error: 'No se encontró la compra.' });
  if (purchase.refunded_at) return res.status(409).json({ error: 'Esta factura ya fue devuelta.' });
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(purchase.ticket_id);
  const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').all(id);
  const movements = db.prepare(`SELECT * FROM movements WHERE purchase_id = ? AND kind = 'venta' ORDER BY id`).all(id);
  const restore = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND is_combo = 0');
  db.exec('BEGIN');
  try {
    const marked = db.prepare('UPDATE purchases SET refunded_at = ? WHERE id = ? AND refunded_at IS NULL').run(new Date().toISOString(), id);
    if (!num(marked.changes)) throw httpError(409, 'Esta factura ya fue devuelta.');
    const giveBack = (productId, quantity, unitPriceCents, productName) => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product || product.is_combo) return;
      const info = restore.run(quantity, productId);
      if (!num(info.changes)) return;
      logMovement({
        kind: 'devolucion',
        productId,
        productName: product.name || productName,
        quantity,
        unitPriceCents,
        purchaseId: id,
        ticketId: purchase.ticket_id,
        userId: req.account?.id,
        note: `Devolución ${ticket?.code || ''}`.trim(),
      });
    };
    let restoredFromMovements = false;
    for (const move of movements) {
      if (move.product_id == null) continue;
      if (move.unit_price_cents == null) {
        restoredFromMovements = true;
        giveBack(num(move.product_id), num(move.quantity), null, move.product_name);
        continue;
      }
      const product = db.prepare('SELECT is_combo FROM products WHERE id = ?').get(move.product_id);
      if (product?.is_combo) continue;
      restoredFromMovements = true;
      giveBack(num(move.product_id), num(move.quantity), num(move.unit_price_cents), move.product_name);
    }
    if (!restoredFromMovements) {
      for (const item of items) {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
        if (!product) continue;
        if (product.is_combo) {
          const parts = db.prepare('SELECT product_id, quantity FROM combo_items WHERE combo_id = ?').all(product.id);
          for (const part of parts) {
            giveBack(num(part.product_id), num(part.quantity) * num(item.quantity), null, '');
          }
          continue;
        }
        giveBack(num(item.product_id), num(item.quantity), num(item.unit_price_cents), item.product_name);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* la transacción ya se cerró */ }
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  const code = ticket?.code;
  res.json({
    sale: barraSale(id),
    ticket: code ? withPurchases(getTicket(code)) : null,
  });
});

app.get('/api/visor/sales', requireAuth, (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 80);
  const params = [];
  let where = '';
  if (query) {
    where = `WHERE pi.product_name LIKE ? COLLATE NOCASE
      OR t.code LIKE ? COLLATE NOCASE
      OR COALESCE(t.alias, '') LIKE ? COLLATE NOCASE
      OR t.event_name LIKE ? COLLATE NOCASE`;
    const like = `%${query.replace(/[%_]/g, '')}%`;
    params.push(like, like, like, like);
  }
  const rows = db.prepare(`
    SELECT pi.*, p.payment_method, p.created_at AS purchased_at, t.code, t.alias, t.event_name, t.status
    FROM purchase_items pi
    JOIN purchases p ON p.id = pi.purchase_id
    JOIN tickets t ON t.id = p.ticket_id
    ${where}
    ORDER BY p.created_at DESC, pi.id DESC
    LIMIT 80
  `).all(...params);
  res.json({
    sales: rows.map((row) => ({
      ...presentItem(row),
      itemId: num(row.id),
      paymentMethod: row.payment_method || '',
      createdAt: row.purchased_at,
      ticketCode: row.code || '',
      alias: row.alias || '',
      eventName: row.event_name || '',
      ticketStatus: row.status || '',
    })),
  });
});

app.post('/api/purchases/:id/deliver', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
  if (!purchase) return res.status(404).json({ error: 'No se encontró la compra.' });
  if (!Array.isArray(req.body.lines) || !req.body.lines.length) {
    return res.status(400).json({ error: 'Selecciona los números que vas a entregar.' });
  }
  const saveMarks = db.prepare('UPDATE purchase_items SET delivered = ?, delivered_marks = ? WHERE id = ? AND purchase_id = ?');
  db.exec('BEGIN');
  try {
    for (const raw of req.body.lines) {
      const itemId = Number(raw?.itemId);
      const item = db.prepare('SELECT * FROM purchase_items WHERE id = ? AND purchase_id = ?').get(itemId, id);
      if (!item) throw httpError(400, 'No se encontró esa factura.');
      const quantity = num(item.quantity);
      const current = marksFor(item);
      const taken = new Set(current);
      let picked = [];
      if (Array.isArray(raw.units)) {
        if (!raw.units.length || raw.units.length > 500) throw httpError(400, 'Selecciona los números que vas a entregar.');
        for (const value of raw.units) {
          const number = Number(value);
          if (!Number.isInteger(number) || number < 1 || number > quantity) {
            throw httpError(400, `El número ${value} no está en esta factura.`);
          }
          if (taken.has(number) || picked.includes(number)) {
            throw httpError(400, `El número ${number} ya está entregado.`);
          }
          picked.push(number);
        }
      } else {
        const count = wholeNumber(raw?.quantity, 1, 500);
        if (count == null) throw httpError(400, 'Revisa las cantidades a entregar.');
        for (let number = 1; number <= quantity && picked.length < count; number += 1) {
          if (!taken.has(number)) picked.push(number);
        }
        if (picked.length !== count) {
          throw httpError(400, `No puedes entregar más ${item.product_name} de lo facturado. Quedan ${quantity - current.length}.`);
        }
      }
      const next = withDeliveryTime(item, picked, new Date().toISOString());
      const info = saveMarks.run(next.length, JSON.stringify(next), itemId, id);
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

function invoiceNumberLabel(number) {
  return String(number).padStart(4, '0');
}

function requestOrigin(req) {
  const configured = String(process.env.LICORERIA_PUBLIC_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const proto = forwarded || req.protocol || 'http';
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function invoiceUrl(req, code) {
  return `${requestOrigin(req)}/f/${encodeURIComponent(code)}`;
}

function loadInvoice(id) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!invoice) return null;
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(id).map((row) => ({
    ...presentItem(row),
    invoiceId: num(row.invoice_id),
  }));
  const number = num(invoice.number);
  return {
    id: num(invoice.id),
    number,
    numberLabel: invoiceNumberLabel(number),
    code: invoice.code,
    customerName: invoice.customer_name,
    customerDocument: invoice.customer_document || '',
    paymentReference: invoice.payment_reference || '',
    paymentMethod: invoice.payment_method || '',
    createdAt: invoice.created_at,
    refundedAt: invoice.refunded_at || null,
    hasReceipt: Boolean(invoice.receipt_file),
    totalCents: items.reduce((sum, item) => sum + item.totalCents, 0),
    currency: invoice.currency || 'usd',
    channel: invoice.channel === 'detal' ? 'detal' : 'barra',
    bcvRate: Number(invoice.bcv_rate) || 0,
    totalBsCents: Math.round(items.reduce((sum, item) => sum + item.totalCents, 0) * (Number(invoice.bcv_rate) || 0)),
    items,
  };
}

function findInvoices(query) {
  const text = String(query || '').trim().slice(0, 80);
  const params = [];
  const barraOnly = `(channel IS NULL OR channel = '' OR channel = 'barra')`;
  let where = `WHERE ${barraOnly}`;
  if (text) {
    where += ` AND (customer_name LIKE ? COLLATE NOCASE
      OR COALESCE(customer_document, '') LIKE ? COLLATE NOCASE
      OR COALESCE(payment_reference, '') LIKE ? COLLATE NOCASE
      OR code LIKE ? COLLATE NOCASE
      OR CAST(number AS TEXT) LIKE ?`;
    const like = `%${text.replace(/[%_]/g, '')}%`;
    params.push(like, like, like, like, like.replace(/^0+/, '') || like);
    if (/^\d+$/.test(text)) {
      where += ' OR number = ?';
      params.push(Number(text));
    }
    where += ')';
  }
  return db.prepare(`
    SELECT id FROM invoices
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT 40
  `).all(...params).map((row) => loadInvoice(num(row.id)));
}

async function withInvoiceQr(req, sale) {
  const url = invoiceUrl(req, sale.code);
  const qrDataUrl = await QRCode.toDataURL(url, {
    margin: 1,
    width: 420,
    errorCorrectionLevel: 'M',
    color: { dark: '#241812', light: '#fffaf3' },
  });
  return { ...sale, url, qrDataUrl };
}

function readSaleItems(rawItems) {
  let items = rawItems;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { throw httpError(400, 'Revisa los productos de la venta.'); }
  }
  if (!Array.isArray(items) || !items.length || items.length > 40) {
    throw httpError(400, 'Agrega al menos un producto.');
  }
  const merged = new Map();
  for (const raw of items) {
    const productId = Number(raw?.productId);
    const quantity = wholeNumber(raw?.quantity, 1, 500);
    if (!productId || quantity == null) throw httpError(400, 'Revisa las cantidades de la venta.');
    merged.set(productId, (merged.get(productId) || 0) + quantity);
  }
  const lines = [];
  const consumption = new Map();
  for (const [productId, quantity] of merged) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product || !product.active) throw httpError(400, 'Hay un producto que ya no está a la venta.');
    lines.push({ product, quantity });
    if (product.is_combo) {
      const parts = db.prepare('SELECT product_id, quantity FROM combo_items WHERE combo_id = ?').all(product.id);
      if (!parts.length) throw httpError(400, `${product.name} no tiene productos.`);
      for (const part of parts) {
        const units = num(part.quantity) * quantity;
        consumption.set(num(part.product_id), (consumption.get(num(part.product_id)) || 0) + units);
      }
    } else {
      consumption.set(productId, (consumption.get(productId) || 0) + quantity);
    }
  }
  for (const [productId, quantity] of consumption) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product || product.is_combo) throw httpError(400, 'Hay un producto del combo que ya no existe.');
    if (!product.active) throw httpError(400, `${product.name} ya no está a la venta.`);
    if (num(product.stock) < quantity) {
      throw httpError(400, `No hay suficientes existencias de ${product.name}. Quedan ${num(product.stock)}.`);
    }
  }
  return { lines, consumption };
}

function cleanCustomerDocument(value) {
  const text = String(value || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 20);
  if (!/^[A-Z]{0,2}-?\d{5,12}$/.test(text)) return '';
  return text;
}

function cleanPaymentReference(value) {
  const text = String(value || '').trim().replace(/\s+/g, '').slice(0, 40);
  if (!/^[A-Za-z0-9-]{4,40}$/.test(text)) return '';
  return text;
}

app.post('/api/pos/sales', requireAuth, uploadReceipt, asyncRoute(async (req, res) => {
  const customerName = String(req.body.customerName || '').trim().slice(0, 80);
  const customerDocument = cleanCustomerDocument(req.body.customerDocument);
  const paymentReference = cleanPaymentReference(req.body.paymentReference);
  if (customerName.length < 2) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Escribe el nombre del cliente.' });
  }
  if (!customerDocument) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Escribe la cédula del cliente.' });
  }
  if (!paymentReference) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Escribe el número de referencia.' });
  }
  const paymentMethod = String(req.body.paymentMethod || '');
  if (!PAYMENTS.has(paymentMethod)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Elige el método de pago.' });
  }
  const channel = req.body.channel === 'detal' ? 'detal' : req.body.channel === 'barra' ? 'barra' : '';
  if (!channel) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Elige si la venta pasa a barra o es venta al detal.' });
  }
  const currency = req.body.currency === 'bs' ? 'bs' : 'usd';
  const bcvRate = currentRate();
  if (currency === 'bs' && bcvRate <= 0) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Coloca la tasa BCV antes de cobrar en bolívares.' });
  }
  let lines;
  let consumption;
  try {
    ({ lines, consumption } = readSaleItems(req.body.items));
  } catch (error) {
    if (req.file) fs.unlink(req.file.path, () => {});
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  const insertInvoice = db.prepare(`
    INSERT INTO invoices (number, code, customer_name, customer_document, payment_reference, payment_method, currency, bcv_rate, receipt_file, created_at, channel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO invoice_items (invoice_id, product_id, product_name, unit_price_cents, cost_cents, quantity, delivered, delivered_marks, combo_parts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const takeStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND active = 1 AND is_combo = 0 AND stock >= ?');
  let invoiceId = 0;
  db.exec('BEGIN');
  try {
    for (const [productId, quantity] of consumption) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product || product.is_combo || !product.active || num(product.stock) < quantity) {
        throw httpError(400, `No hay suficientes existencias de ${product?.name || 'un producto'}.`);
      }
    }
    const number = num(db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM invoices').get().n) + 1;
    let code = newCode();
    while (db.prepare('SELECT id FROM invoices WHERE code = ?').get(code)) code = newCode();
    for (const line of lines) {
      const allowUsd = line.product.is_combo ? flagOn(line.product.pay_usd) : true;
      const allowBs = line.product.is_combo ? flagOn(line.product.pay_bs) : true;
      if (currency === 'usd' && !allowUsd) throw httpError(400, `${line.product.name} no se cobra en dólares.`);
      if (currency === 'bs' && !allowBs) throw httpError(400, `${line.product.name} no se cobra en bolívares.`);
    }
    const info = insertInvoice.run(number, code, customerName, customerDocument, paymentReference, paymentMethod, currency, bcvRate, req.file?.filename || null, new Date().toISOString(), channel);
    invoiceId = num(info.lastInsertRowid);
    for (const [productId, quantity] of consumption) {
      const taken = takeStock.run(quantity, productId, quantity);
      if (!num(taken.changes)) {
        const product = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
        throw httpError(400, `No se pudo descontar ${product?.name || 'un producto'} del inventario.`);
      }
    }
    for (const line of lines) {
      const costCents = line.product.is_combo
        ? num(db.prepare(`SELECT COALESCE(SUM(ci.quantity * p.cost_cents), 0) AS n FROM combo_items ci JOIN products p ON p.id = ci.product_id WHERE ci.combo_id = ?`).get(line.product.id).n)
        : num(line.product.cost_cents);
      const soldAt = new Date().toISOString();
      const delivered = channel === 'detal' ? line.quantity : 0;
      const marks = channel === 'detal'
        ? JSON.stringify(Array.from({ length: line.quantity }, (_, index) => ({ n: index + 1, at: soldAt })))
        : null;
      const snapshot = line.product.is_combo
        ? JSON.stringify(comboParts(line.product.id).map((part) => ({
          productId: part.productId,
          name: part.name,
          quantity: part.quantity,
        })))
        : null;
      insertItem.run(invoiceId, line.product.id, line.product.name, num(line.product.price_cents), costCents, line.quantity, delivered, marks, snapshot);
      logMovement({
        kind: 'venta',
        productId: num(line.product.id),
        productName: line.product.name,
        quantity: line.quantity,
        unitPriceCents: num(line.product.price_cents),
        invoiceId,
        userId: req.account?.id,
        note: code,
      });
      if (!line.product.is_combo) continue;
      const parts = db.prepare(`
        SELECT ci.quantity, p.id, p.name
        FROM combo_items ci
        JOIN products p ON p.id = ci.product_id
        WHERE ci.combo_id = ?
      `).all(line.product.id);
      for (const part of parts) {
        logMovement({
          kind: 'venta',
          productId: num(part.id),
          productName: part.name,
          quantity: num(part.quantity) * line.quantity,
          invoiceId,
          userId: req.account?.id,
          note: `Combo ${line.product.name}`,
        });
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* la transacción ya se cerró */ }
    if (req.file) fs.unlink(req.file.path, () => {});
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  const sale = await withInvoiceQr(req, loadInvoice(invoiceId));
  res.status(201).json({ sale });
}));

app.get('/api/invoices', requireAuth, (req, res) => {
  res.json({ sales: findInvoices(req.query.q) });
});

app.get('/api/notices/barra', requireAuth, (req, res) => {
  const barraOnly = `(channel IS NULL OR channel = '' OR channel = 'barra')`;
  if (req.query.bootstrap === '1') {
    const latest = num(db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM invoices WHERE ${barraOnly}`).get().n);
    return res.json({ notices: [], latest });
  }
  const after = Math.max(0, Number(req.query.after) || 0);
  const notices = db.prepare(`
    SELECT id FROM invoices
    WHERE id > ? AND ${barraOnly}
    ORDER BY id ASC
    LIMIT 8
  `).all(after).map((row) => {
    const sale = loadInvoice(num(row.id));
    return {
      id: sale.id,
      numberLabel: sale.numberLabel,
      customerName: sale.customerName,
      customerDocument: sale.customerDocument,
      paymentReference: sale.paymentReference,
      createdAt: sale.createdAt,
      totalCents: sale.totalCents,
      currency: sale.currency,
      bcvRate: sale.bcvRate,
      totalBsCents: sale.totalBsCents,
      items: sale.items.map((item) => ({ productName: item.productName, quantity: item.quantity })),
    };
  });
  res.json({ notices });
});

app.get('/api/invoices/code/:code', requireAuth, asyncRoute(async (req, res) => {
  const code = normalizeCode(req.params.code);
  const row = db.prepare('SELECT id FROM invoices WHERE code = ?').get(code);
  if (!row) return res.status(404).json({ error: 'No hay una factura con ese código.' });
  res.json({ sale: await withInvoiceQr(req, loadInvoice(num(row.id))) });
}));

app.get('/api/invoices/:id', requireAuth, asyncRoute(async (req, res) => {
  const sale = loadInvoice(Number(req.params.id));
  if (!sale) return res.status(404).json({ error: 'No se encontró la factura.' });
  res.json({ sale: await withInvoiceQr(req, sale) });
}));

app.get('/api/public/invoices/:code', (req, res) => {
  const code = normalizeCode(req.params.code);
  const row = db.prepare('SELECT id FROM invoices WHERE code = ?').get(code);
  if (!row) return res.status(404).json({ error: 'No hay una factura con ese código.' });
  const sale = loadInvoice(num(row.id));
  res.json({
    sale: {
      numberLabel: sale.numberLabel,
      code: sale.code,
      customerName: sale.customerName,
      customerDocument: sale.customerDocument,
      paymentReference: sale.paymentReference,
      createdAt: sale.createdAt,
      refundedAt: sale.refundedAt,
      totalCents: sale.totalCents,
      currency: sale.currency,
      bcvRate: sale.bcvRate,
      totalBsCents: sale.totalBsCents,
      items: sale.items.map((item) => ({
        id: item.id,
        productName: item.productName,
        quantity: item.quantity,
        delivered: item.delivered,
        deliveredUnits: item.deliveredUnits,
        deliveredAt: item.deliveredAt,
        remaining: item.remaining,
        totalCents: item.totalCents,
        exploded: item.exploded,
      })),
    },
  });
});

app.post('/api/invoices/:id/deliver', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!invoice) return res.status(404).json({ error: 'No se encontró la factura.' });
  if (invoice.refunded_at) return res.status(409).json({ error: 'Esta factura ya fue devuelta.' });
  if (!Array.isArray(req.body.lines) || !req.body.lines.length) {
    return res.status(400).json({ error: 'Selecciona los números que vas a entregar.' });
  }
  const saveMarks = db.prepare('UPDATE invoice_items SET delivered = ?, delivered_marks = ? WHERE id = ? AND invoice_id = ?');
  db.exec('BEGIN');
  try {
    for (const raw of req.body.lines) {
      const itemId = Number(raw?.itemId);
      const item = db.prepare('SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?').get(itemId, id);
      if (!item) throw httpError(400, 'No se encontró esa factura.');
      const quantity = num(item.quantity);
      const current = marksFor(item);
      const taken = new Set(current);
      const picked = [];
      if (!Array.isArray(raw.units) || !raw.units.length || raw.units.length > 500) {
        throw httpError(400, 'Selecciona los números que vas a entregar.');
      }
      for (const value of raw.units) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1 || number > quantity) {
          throw httpError(400, `El número ${value} no está en esta factura.`);
        }
        if (taken.has(number) || picked.includes(number)) {
          throw httpError(400, `El número ${number} ya está entregado.`);
        }
        picked.push(number);
      }
      const next = withDeliveryTime(item, picked, new Date().toISOString());
      const info = saveMarks.run(next.length, JSON.stringify(next), itemId, id);
      if (!num(info.changes)) throw httpError(400, `No se pudo registrar la entrega de ${item.product_name}.`);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* la transacción ya se cerró */ }
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  res.json({ sale: loadInvoice(id) });
});

app.post('/api/invoices/:id/items/:itemId/split', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!invoice) return res.status(404).json({ error: 'No se encontró la factura.' });
  if (invoice.refunded_at) return res.status(409).json({ error: 'Esta factura ya fue devuelta.' });
  if (invoice.channel === 'detal') return res.status(400).json({ error: 'La venta al detal ya quedó entregada.' });
  const item = db.prepare('SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?').get(itemId, id);
  if (!item) return res.status(404).json({ error: 'No se encontró ese producto en la factura.' });
  if (item.exploded_at) return res.status(409).json({ error: 'Ese combo ya está desglosado.' });
  if (item.source_item_id) return res.status(400).json({ error: 'Esa línea ya es una unidad del combo.' });
  if (num(item.delivered) > 0) return res.status(400).json({ error: 'Desglosa el combo antes de entregar la primera unidad.' });
  const parts = itemParts(item);
  if (!parts.length) return res.status(400).json({ error: 'Ese producto no es un combo con unidades para abrir.' });
  const buckets = num(item.quantity);
  const opened = parts.map((part) => ({ ...part, units: part.quantity * buckets }));
  const totalUnits = opened.reduce((sum, part) => sum + part.units, 0);
  if (!totalUnits || totalUnits > 500) {
    return res.status(400).json({ error: 'Ese combo se abre en demasiadas unidades para entregarlo en barra.' });
  }
  const insertChild = db.prepare(`
    INSERT INTO invoice_items (
      invoice_id, product_id, product_name, unit_price_cents, cost_cents, quantity, delivered, delivered_marks, source_item_id
    ) VALUES (?, ?, ?, 0, 0, ?, 0, NULL, ?)
  `);
  db.exec('BEGIN');
  try {
    for (const part of opened) {
      const product = db.prepare('SELECT id FROM products WHERE id = ?').get(part.productId);
      if (!product) throw httpError(400, `Ya no está ${part.name}, el producto del combo.`);
      insertChild.run(id, part.productId, part.name, part.units, itemId);
    }
    const marked = db.prepare('UPDATE invoice_items SET exploded_at = ? WHERE id = ? AND invoice_id = ? AND exploded_at IS NULL').run(
      new Date().toISOString(),
      itemId,
      id,
    );
    if (!num(marked.changes)) throw httpError(409, 'Ese combo ya está desglosado.');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* la transacción ya se cerró */ }
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  res.json({ sale: loadInvoice(id) });
});

app.post('/api/invoices/:id/refund', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!invoice) return res.status(404).json({ error: 'No se encontró la factura.' });
  if (invoice.refunded_at) return res.status(409).json({ error: 'Esta factura ya fue devuelta.' });
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(id);
  const movements = db.prepare(`SELECT * FROM movements WHERE invoice_id = ? AND kind = 'venta' ORDER BY id`).all(id);
  const restore = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND is_combo = 0');
  db.exec('BEGIN');
  try {
    const marked = db.prepare('UPDATE invoices SET refunded_at = ? WHERE id = ? AND refunded_at IS NULL').run(new Date().toISOString(), id);
    if (!num(marked.changes)) throw httpError(409, 'Esta factura ya fue devuelta.');
    const giveBack = (productId, quantity, unitPriceCents, productName) => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product || product.is_combo) return;
      const info = restore.run(quantity, productId);
      if (!num(info.changes)) return;
      logMovement({
        kind: 'devolucion',
        productId,
        productName: product.name || productName,
        quantity,
        unitPriceCents,
        invoiceId: id,
        userId: req.account?.id,
        note: `Devolución ${invoice.code}`,
      });
    };
    let restoredFromMovements = false;
    for (const move of movements) {
      if (move.product_id == null) continue;
      if (move.unit_price_cents == null) {
        restoredFromMovements = true;
        giveBack(num(move.product_id), num(move.quantity), null, move.product_name);
        continue;
      }
      const product = db.prepare('SELECT is_combo FROM products WHERE id = ?').get(move.product_id);
      if (product?.is_combo) continue;
      restoredFromMovements = true;
      giveBack(num(move.product_id), num(move.quantity), num(move.unit_price_cents), move.product_name);
    }
    if (!restoredFromMovements) {
      for (const item of items) {
        if (item.source_item_id) continue;
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
        if (!product) continue;
        if (product.is_combo) {
          const parts = db.prepare('SELECT product_id, quantity FROM combo_items WHERE combo_id = ?').all(product.id);
          for (const part of parts) giveBack(num(part.product_id), num(part.quantity) * num(item.quantity), null, '');
          continue;
        }
        giveBack(num(item.product_id), num(item.quantity), num(item.unit_price_cents), item.product_name);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* la transacción ya se cerró */ }
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  res.json({ sale: loadInvoice(id) });
});

app.get('/api/invoices/:id/receipt', requireAuth, (req, res) => {
  const invoice = db.prepare('SELECT receipt_file FROM invoices WHERE id = ?').get(Number(req.params.id));
  if (!invoice?.receipt_file) return res.status(404).json({ error: 'Esta factura no tiene comprobante.' });
  res.sendFile(path.join(activeTenant().receiptDir, path.basename(invoice.receipt_file)));
});

function currentRate() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'bcv_rate'`).get();
  const rate = Number(String(row?.value || '').replace(',', '.'));
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

function readRateInput(value) {
  const rate = Number(String(value ?? '').trim().replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1000000) return null;
  return Math.round(rate * 10000) / 10000;
}

app.get('/api/rate', requireAuth, (req, res) => {
  res.json({ rate: currentRate() });
});

app.put('/api/rate', requireAuth, (req, res) => {
  const rate = readRateInput(req.body.rate);
  if (rate == null) return res.status(400).json({ error: 'Escribe la tasa BCV, con hasta cuatro decimales.' });
  db.prepare(`INSERT INTO settings (key, value) VALUES ('bcv_rate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(rate));
  res.json({ rate });
});

function presentSupplier(row) {
  return {
    id: num(row.id),
    name: row.name,
    document: row.document || '',
    phone: row.phone || '',
    email: row.email || '',
    address: row.address || '',
    notes: row.notes || '',
    createdAt: row.created_at,
  };
}

app.get('/api/suppliers', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM suppliers ORDER BY name COLLATE NOCASE').all();
  res.json({ suppliers: rows.map(presentSupplier) });
});

app.post('/api/suppliers', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'Escribe el nombre del proveedor.' });
  const info = db.prepare(`
    INSERT INTO suppliers (name, document, phone, email, address, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    String(req.body.document || '').trim().slice(0, 40) || null,
    String(req.body.phone || '').trim().slice(0, 40) || null,
    String(req.body.email || '').trim().slice(0, 80) || null,
    String(req.body.address || '').trim().slice(0, 160) || null,
    String(req.body.notes || '').trim().slice(0, 240) || null,
    new Date().toISOString(),
  );
  res.status(201).json({ supplier: presentSupplier(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(num(info.lastInsertRowid))) });
});

app.get('/api/supplier-purchases', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT sp.*, s.name AS supplier_name
    FROM supplier_purchases sp
    JOIN suppliers s ON s.id = sp.supplier_id
    ORDER BY sp.created_at DESC, sp.id DESC
    LIMIT 40
  `).all();
  res.json({
    purchases: rows.map((row) => {
      const items = db.prepare('SELECT * FROM supplier_purchase_items WHERE purchase_id = ? ORDER BY id').all(row.id);
      const presented = items.map((item) => {
        const packs = num(item.pack_count);
        const packCost = item.pack_cost_cents == null ? null : num(item.pack_cost_cents);
        const quantity = num(item.quantity);
        return {
          productName: item.product_name,
          quantity,
          packCount: packs,
          costCents: num(item.cost_cents),
          packCostCents: packCost,
          priceCents: num(item.price_cents),
          totalCents: packs > 0 && packCost != null ? packs * packCost : num(item.cost_cents) * quantity,
        };
      });
      return {
        id: num(row.id),
        supplierName: row.supplier_name,
        invoiceDate: row.invoice_date,
        loadedAt: row.loaded_at,
        dueDate: row.due_date || '',
        paymentMethod: row.payment_method,
        totalCents: presented.reduce((sum, item) => sum + item.totalCents, 0),
        items: presented,
      };
    }),
  });
});

app.post('/api/supplier-purchases', requireAuth, (req, res) => {
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(req.body.supplierId));
  if (!supplier) return res.status(400).json({ error: 'Elige el proveedor.' });
  const invoiceDate = String(req.body.invoiceDate || '').trim();
  if (!parseDay(invoiceDate)) return res.status(400).json({ error: 'Escribe la fecha de la factura.' });
  const dueDate = String(req.body.dueDate || '').trim();
  if (dueDate && !parseDay(dueDate)) return res.status(400).json({ error: 'Revisa la fecha de vencimiento.' });
  const paymentMethod = String(req.body.paymentMethod || '');
  if (!PAYMENTS.has(paymentMethod)) return res.status(400).json({ error: 'Elige el método de pago.' });
  if (!Array.isArray(req.body.items) || !req.body.items.length) return res.status(400).json({ error: 'Agrega al menos un producto.' });
  const lines = [];
  for (const raw of req.body.items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_combo = 0').get(Number(raw?.productId));
    if (!product) return res.status(400).json({ error: 'Revisa el producto, la cantidad, el costo y el precio de venta.' });
    const perBox = Math.max(1, num(product.units_per_box) || 1);
    const pack = perBox >= 2 ? 'box' : 'unit';
    const packed = unitsFromPack(raw?.quantity, perBox, pack, { min: 1 });
    if (packed.error) return res.status(400).json({ error: packed.error });
    if (num(product.stock) + packed.units > 1000000) {
      return res.status(400).json({ error: 'Esa compra pasa de 1000000 unidades.' });
    }
    const enteredCost = toCents(raw?.cost);
    const costSplit = centsPerUnit(enteredCost, perBox, pack);
    if (costSplit.error) return res.status(400).json({ error: costSplit.error });
    let priceCents = raw?.price == null || raw?.price === '' ? null : toCents(raw.price);
    if (priceCents == null && raw?.profit != null && raw.profit !== '') {
      const profitCents = toCents(raw.profit);
      if (profitCents != null && costSplit.cents != null) priceCents = costSplit.cents + profitCents;
    }
    if (costSplit.cents == null || priceCents == null) {
      return res.status(400).json({ error: 'Revisa el producto, la cantidad, el costo y el precio de venta.' });
    }
    lines.push({
      product,
      quantity: packed.units,
      costCents: costSplit.cents,
      priceCents,
      packCount: pack === 'box' ? wholeNumber(raw?.quantity, 1, 100000) : null,
      packCostCents: pack === 'box' ? enteredCost : null,
      note: packed.note,
    });
  }
  const loadedAt = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO supplier_purchases (supplier_id, invoice_date, loaded_at, due_date, payment_method, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO supplier_purchase_items (
      purchase_id, product_id, product_name, quantity, cost_cents, price_cents, pack_count, pack_cost_cents
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  let purchaseId = 0;
  try {
    const info = insert.run(supplier.id, invoiceDate, loadedAt, dueDate || null, paymentMethod, loadedAt);
    purchaseId = num(info.lastInsertRowid);
    for (const line of lines) {
      insertItem.run(purchaseId, line.product.id, line.product.name, line.quantity, line.costCents, line.priceCents, line.packCount, line.packCostCents);
      db.prepare('UPDATE products SET stock = stock + ?, cost_cents = ?, price_cents = ? WHERE id = ?').run(line.quantity, line.costCents, line.priceCents, line.product.id);
      logMovement({
        kind: 'carga',
        productId: num(line.product.id),
        productName: line.product.name,
        quantity: line.quantity,
        unitPriceCents: line.costCents,
        userId: req.account?.id,
        note: line.note ? `Compra ${supplier.name}: ${line.note}` : `Compra ${supplier.name}`,
      });
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* la transacción ya se cerró */ }
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  res.status(201).json({ id: purchaseId });
});

app.post('/api/stock', requireAuth, (req, res) => {
  const direction = req.body.direction === 'descarga' ? 'descarga' : 'carga';
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_combo = 0').get(Number(req.body.productId));
  const quantity = wholeNumber(req.body.quantity, 1, 100000);
  if (!product || quantity == null) return res.status(400).json({ error: 'Elige un producto y una cantidad.' });
  if (direction === 'descarga' && num(product.stock) < quantity) {
    return res.status(400).json({ error: `No puedes descargar más de lo que hay. Quedan ${num(product.stock)}.` });
  }
  if (direction === 'carga') db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(quantity, product.id);
  else db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(quantity, product.id);
  logMovement({
    kind: direction,
    productId: num(product.id),
    productName: product.name,
    quantity,
    unitPriceCents: num(product.cost_cents),
    userId: req.account?.id,
    note: direction === 'carga' ? 'Carga manual' : 'Descarga manual',
  });
  res.json({ product: presentProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(product.id)) });
});

app.get('/api/expenses', requireAuth, (req, res) => {
  let range;
  try {
    range = rangeFor(String(req.query.preset || 'month'), req.query.from, req.query.to);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  const rows = db.prepare('SELECT * FROM expenses WHERE spent_at >= ? AND spent_at < ? ORDER BY spent_at DESC, id DESC').all(range.from.toISOString(), range.to.toISOString());
  res.json({
    expenses: rows.map((row) => ({
      id: num(row.id),
      description: row.description,
      amountCents: num(row.amount_cents),
      currency: row.currency,
      bcvRate: Number(row.bcv_rate) || 0,
      spentAt: row.spent_at,
      note: row.note || '',
    })),
  });
});

app.post('/api/expenses', requireAuth, (req, res) => {
  const description = String(req.body.description || '').trim().slice(0, 120);
  const amountCents = toCents(req.body.amount);
  const currency = req.body.currency === 'bs' ? 'bs' : 'usd';
  const day = parseDay(String(req.body.date || ''));
  if (description.length < 2) return res.status(400).json({ error: 'Escribe el gasto.' });
  if (amountCents == null || amountCents <= 0) return res.status(400).json({ error: 'Escribe el monto del gasto.' });
  if (!day) return res.status(400).json({ error: 'Elige la fecha del gasto.' });
  const rate = currentRate();
  if (currency === 'bs' && rate <= 0) return res.status(400).json({ error: 'Coloca la tasa BCV antes de anotar un gasto en bolívares.' });
  const info = db.prepare(`
    INSERT INTO expenses (description, amount_cents, currency, bcv_rate, spent_at, note, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(description, amountCents, currency, rate, day.toISOString(), String(req.body.note || '').trim().slice(0, 240) || null, req.account?.id || null, new Date().toISOString());
  res.status(201).json({ id: num(info.lastInsertRowid) });
});

app.get('/api/summary', requireAuth, (req, res) => {
  const preset = String(req.query.preset || 'day');
  let range;
  let fromHour;
  let toHour;
  try {
    range = businessRange(preset, req.query.from, req.query.to);
    fromHour = parseHour(req.query.fromHour);
    toHour = parseHour(req.query.toHour);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  const lines = db.prepare(`
    SELECT i.id, i.payment_method, i.bcv_rate, i.created_at,
           ii.quantity, ii.unit_price_cents, ii.cost_cents
    FROM invoices i
    JOIN invoice_items ii ON ii.invoice_id = i.id
    WHERE i.refunded_at IS NULL AND ii.source_item_id IS NULL AND i.created_at >= ? AND i.created_at < ?
  `).all(range.from.toISOString(), range.to.toISOString())
    .filter((line) => matchesHour(line.created_at, fromHour, toHour));
  const invoiceIds = new Set();
  const invoiceTimes = new Map();
  const payments = new Map();
  let salesCents = 0;
  let costCents = 0;
  for (const line of lines) {
    const quantity = num(line.quantity);
    const revenue = quantity * num(line.unit_price_cents);
    const cost = quantity * num(line.cost_cents);
    const rate = Number(line.bcv_rate) || 0;
    salesCents += revenue;
    costCents += cost;
    invoiceIds.add(num(line.id));
    invoiceTimes.set(num(line.id), line.created_at);
    const bucket = payments.get(line.payment_method) || { method: line.payment_method, countIds: new Set(), salesCents: 0, salesBs: 0 };
    bucket.countIds.add(num(line.id));
    bucket.salesCents += revenue;
    bucket.salesBs += Math.round(revenue * rate);
    payments.set(line.payment_method, bucket);
  }
  const salesBs = lines.reduce((sum, line) => sum + Math.round(num(line.quantity) * num(line.unit_price_cents) * (Number(line.bcv_rate) || 0)), 0);
  const costBs = lines.reduce((sum, line) => sum + Math.round(num(line.quantity) * num(line.cost_cents) * (Number(line.bcv_rate) || 0)), 0);
  const expenseRows = db.prepare('SELECT * FROM expenses WHERE spent_at >= ? AND spent_at < ?').all(range.from.toISOString(), range.to.toISOString())
    .filter((expense) => matchesHour(expense.spent_at, fromHour, toHour));
  let expensesCents = 0;
  let expensesBs = 0;
  for (const expense of expenseRows) {
    const amount = num(expense.amount_cents);
    const rate = Number(expense.bcv_rate) || currentRate();
    if (expense.currency === 'bs') {
      expensesBs += amount;
      expensesCents += rate > 0 ? Math.round(amount / rate) : 0;
    } else {
      expensesCents += amount;
      expensesBs += Math.round(amount * rate);
    }
  }
  const grain = preset === 'hour' || preset === 'day' ? 'hour' : 'day';
  const buckets = new Map();
  if (grain === 'hour') {
    for (const hour of hoursInWindow(fromHour, toHour)) {
      buckets.set(String(hour), { label: `${String(hour).padStart(2, '0')}:00`, salesCents: 0, salesBs: 0 });
    }
  } else {
    const cursor = new Date(range.from);
    while (cursor < range.to) {
      const parts = businessParts(cursor);
      buckets.set(`${parts.year}-${parts.month}-${parts.day}`, { label: String(parts.day), salesCents: 0, salesBs: 0 });
      cursor.setTime(cursor.getTime() + 86400000);
    }
  }
  for (const line of lines) {
    const parts = businessParts(new Date(line.created_at));
    const key = grain === 'hour' ? String(parts.hour) : `${parts.year}-${parts.month}-${parts.day}`;
    const bucket = buckets.get(key);
    if (!bucket) continue;
    const revenue = num(line.quantity) * num(line.unit_price_cents);
    bucket.salesCents += revenue;
    bucket.salesBs += Math.round(revenue * (Number(line.bcv_rate) || 0));
  }
  const rateNow = currentRate();
  let globalSalesBs = 0;
  let globalCostBs = 0;
  for (const line of lines) {
    const rate = Number(line.bcv_rate) || rateNow;
    const revenue = num(line.quantity) * num(line.unit_price_cents);
    const cost = num(line.quantity) * num(line.cost_cents);
    globalSalesBs += Math.round(revenue * rate);
    globalCostBs += Math.round(cost * rate);
  }
  const globalSalesCents = salesCents;
  const globalCostCents = costCents;
  const globalExpensesCents = expensesCents;
  const globalExpensesBs = expensesBs || (rateNow > 0 ? Math.round(expensesCents * rateNow) : 0);
  const globalProfitCents = globalSalesCents - globalCostCents - globalExpensesCents;
  const globalProfitBs = globalSalesBs - globalCostBs - globalExpensesBs;
  const pending = num(db.prepare(`
    SELECT COALESCE(SUM(ii.quantity - ii.delivered), 0) AS n
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.refunded_at IS NULL AND ii.exploded_at IS NULL
  `).get().n);
  const recent = [...invoiceTimes.entries()]
    .sort((left, right) => String(right[1]).localeCompare(String(left[1])) || right[0] - left[0])
    .slice(0, 6)
    .map(([invoiceId]) => loadInvoice(invoiceId));
  const windowLabel = hourWindowLabel(fromHour, toHour);
  const formatter = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Caracas' });
  const startLabel = formatter.format(range.from);
  const endLabel = formatter.format(new Date(range.to.getTime() - 1));
  const label = `${startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`}${windowLabel ? ` · ${windowLabel}` : ''}`;
  res.json({
    preset: preset === 'hour' ? 'hour' : preset,
    from: businessYmd(range.from),
    to: businessYmd(new Date(range.to.getTime() - 1)),
    fromHour,
    toHour,
    label,
    rate: currentRate(),
    invoices: invoiceIds.size,
    salesCents,
    costCents,
    profitCents: salesCents - costCents,
    salesBs,
    costBs,
    profitBs: salesBs - costBs,
    expensesCents,
    expensesBs,
    globalSalesCents,
    globalSalesBs,
    globalCostCents,
    globalCostBs,
    globalExpensesCents,
    globalExpensesBs,
    globalProfitCents,
    globalProfitBs,
    pending,
    payments: [...payments.values()].map((row) => ({ method: row.method, count: row.countIds.size, salesCents: row.salesCents, salesBs: row.salesBs })),
    series: [...buckets.values()],
    recent,
  });
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
  const kind = req.query.kind === 'products' ? 'products' : 'tickets';
  const params = [range.from.toISOString(), range.to.toISOString()];
  const like = query ? `%${query.replace(/[%_]/g, '')}%` : '';
  const inclusiveEnd = new Date(range.to.getTime() - 1);
  const period = {
    kind,
    preset: String(req.query.preset || 'day'),
    from: ymd(range.from),
    to: ymd(inclusiveEnd),
    label: formatRange(range.from, range.to),
    query,
  };
  if (kind === 'products') {
    let sql = `
      SELECT pi.product_name, pi.unit_price_cents, pi.quantity,
             p.created_at, p.payment_method,
             t.code AS ticket_code, t.alias, t.event_name
      FROM purchase_items pi
      JOIN purchases p ON p.id = pi.purchase_id
      JOIN tickets t ON t.id = p.ticket_id
      WHERE p.created_at >= ? AND p.created_at < ? AND p.refunded_at IS NULL`;
    if (like) {
      sql += ' AND pi.product_name LIKE ? COLLATE NOCASE';
      params.push(like);
    }
    sql += ' ORDER BY p.created_at DESC, pi.id DESC';
    const invoiceParams = [range.from.toISOString(), range.to.toISOString()];
    let invoiceSql = `
      SELECT ii.product_name, ii.unit_price_cents, ii.quantity,
             i.created_at, i.payment_method,
             i.code AS ticket_code, i.customer_name AS alias, '' AS event_name
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      WHERE i.created_at >= ? AND i.created_at < ? AND i.refunded_at IS NULL AND ii.source_item_id IS NULL`;
    if (like) {
      invoiceSql += ' AND ii.product_name LIKE ? COLLATE NOCASE';
      invoiceParams.push(like);
    }
    const rows = [...db.prepare(sql).all(...params), ...db.prepare(invoiceSql).all(...invoiceParams)]
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    const grouped = new Map();
    const totals = { units: 0, products: 0, sales: 0, revenueCents: 0 };
    for (const row of rows) {
      const units = num(row.quantity);
      const revenue = units * num(row.unit_price_cents);
      totals.units += units;
      totals.sales += 1;
      totals.revenueCents += revenue;
      const name = row.product_name;
      const group = grouped.get(name) || { name, units: 0, sales: 0, revenueCents: 0 };
      group.units += units;
      group.sales += 1;
      group.revenueCents += revenue;
      grouped.set(name, group);
    }
    totals.products = grouped.size;
    const { grain, series } = buildSeries(rows, range.from, range.to, String(req.query.preset || 'day'));
    res.json({
      ...period,
      grain,
      totals,
      series,
      products: [...grouped.values()].sort((left, right) => right.revenueCents - left.revenueCents || right.units - left.units),
      rows: rows.map((row) => ({
        productName: row.product_name,
        quantity: num(row.quantity),
        unitPriceCents: num(row.unit_price_cents),
        totalCents: num(row.quantity) * num(row.unit_price_cents),
        createdAt: row.created_at,
        paymentMethod: row.payment_method || '',
        ticketCode: row.ticket_code || '',
        alias: row.alias || '',
        eventName: row.event_name || '',
      })),
    });
    return;
  }
  const eventNames = db.prepare(`
    SELECT DISTINCT event_name AS name
    FROM tickets
    WHERE created_at >= ? AND created_at < ?
    ORDER BY 1
  `).all(range.from.toISOString(), range.to.toISOString()).map((row) => row.name);
  let sql = 'SELECT * FROM tickets WHERE created_at >= ? AND created_at < ?';
  if (query) {
    sql += ' AND event_name = ?';
    params.push(query);
  }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params);
  const grouped = new Map();
  const totals = rows.reduce((sum, row) => {
    const tickets = num(row.quantity);
    const revenue = tickets * num(row.unit_price_cents);
    sum.tickets += tickets;
    sum.qrs += 1;
    sum.revenueCents += revenue;
    const name = row.event_name;
    const group = grouped.get(name) || { name, tickets: 0, qrs: 0, revenueCents: 0 };
    group.tickets += tickets;
    group.qrs += 1;
    group.revenueCents += revenue;
    grouped.set(name, group);
    return sum;
  }, { tickets: 0, qrs: 0, revenueCents: 0 });
  const { grain, series } = buildSeries(rows, range.from, range.to, String(req.query.preset || 'day'));
  res.json({
    ...period,
    grain,
    totals,
    series,
    eventNames,
    events: [...grouped.values()].sort((left, right) => right.revenueCents - left.revenueCents || right.tickets - left.tickets),
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
  const kind = ['entrada', 'venta', 'ajuste', 'devolucion', 'carga', 'descarga'].includes(req.query.kind) ? req.query.kind : '';
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
    where += ` AND (
      m.product_name LIKE ? COLLATE NOCASE
      OR COALESCE(t.code, '') LIKE ? COLLATE NOCASE
      OR COALESCE(t.event_name, '') LIKE ? COLLATE NOCASE
      OR COALESCE(i.customer_name, '') LIKE ? COLLATE NOCASE
      OR COALESCE(i.code, '') LIKE ? COLLATE NOCASE
      OR CAST(i.number AS TEXT) LIKE ?
    )`;
    const like = `%${query.replace(/[%_]/g, '')}%`;
    params.push(like, like, like, like, like, like);
  }
  const rows = db.prepare(`
    SELECT m.*, t.code AS ticket_code, t.event_name,
           COALESCE(p.payment_method, i.payment_method) AS payment_method,
           COALESCE(p.receipt_file, i.receipt_file) AS receipt_file,
           COALESCE(p.refunded_at, i.refunded_at) AS refunded_at,
           i.number AS invoice_number,
           i.customer_name,
           i.code AS invoice_code,
           u.username
    FROM movements m
    LEFT JOIN tickets t ON t.id = m.ticket_id
    LEFT JOIN purchases p ON p.id = m.purchase_id
    LEFT JOIN invoices i ON i.id = m.invoice_id
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
    invoiceId: row.invoice_id == null ? null : num(row.invoice_id),
    invoiceNumber: row.invoice_number == null ? '' : invoiceNumberLabel(num(row.invoice_number)),
    customerName: row.customer_name || '',
    invoiceCode: row.invoice_code || '',
    ticketCode: row.ticket_code || '',
    eventName: row.event_name || '',
    paymentMethod: row.payment_method || '',
    hasReceipt: Boolean(row.receipt_file),
    refunded: Boolean(row.refunded_at),
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
  if (purchase.receipt_file) fs.unlink(path.join(activeTenant().receiptDir, purchase.receipt_file), () => {});
  db.prepare('UPDATE purchases SET receipt_file = ? WHERE id = ?').run(req.file.filename, id);
  res.json({ ok: true });
});

app.get('/api/purchases/:id/receipt', requireAuth, (req, res) => {
  const purchase = db.prepare('SELECT receipt_file FROM purchases WHERE id = ?').get(Number(req.params.id));
  if (!purchase?.receipt_file) return res.status(404).json({ error: 'Esta compra no tiene comprobante.' });
  const filename = path.basename(purchase.receipt_file);
  res.sendFile(path.join(activeTenant().receiptDir, filename));
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
    if (!still) fs.unlink(path.join(activeTenant().mediaDir, path.basename(screen.content_source)), () => {});
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

let appHtml = '';
function sendApp(res) {
  if (!appHtml) appHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const tenant = activeTenant();
  const payload = {
    id: tenant.id,
    base: tenant.prefix,
    name: tenant.name,
    shortName: tenant.shortName,
    codePrefix: tenant.codePrefix,
    eyebrow: tenant.eyebrow,
    lead: tenant.lead,
    loginTitle: tenant.loginTitle,
    loginLead: tenant.loginLead,
    themeColor: tenant.themeColor,
  };
  const html = appHtml.replace(
    '<script type="module"',
    `<script>window.__NEGOCIO=${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>\n  <script type="module"`,
  );
  res.set('Cache-Control', 'no-store');
  res.type('html').send(html);
}

app.get('/manifest.json', (req, res) => {
  const tenant = activeTenant();
  const start = tenant.prefix ? `${tenant.prefix}/` : '/';
  res.json({
    name: tenant.name,
    short_name: tenant.shortName,
    description: tenant.description,
    start_url: start,
    scope: start,
    display: 'standalone',
    orientation: 'portrait',
    background_color: tenant.background,
    theme_color: tenant.themeColor,
    lang: 'es',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

app.use('/media', (req, res, next) => {
  express.static(activeTenant().mediaDir, { maxAge: '1h', index: false, fallthrough: false })(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true, index: false }));
app.use((req, res) => {
  if (req.method !== 'GET') return res.status(404).type('text').send('No encontrado.');
  if (path.extname(req.path)) return res.status(404).type('text').send('No encontrado.');
  sendApp(res);
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
  const host = [...hosts][0] || 'licoreria.localhost';
  console.log('');
  console.log(`  ${site.name}`);
  console.log(`  Abre http://${host}:${PORT}/`);
  console.log(process.env.DATABASE_URL ? `  Datos en PostgreSQL (${site.schema})` : `  Datos guardados en ${site.dbPath}`);
  if (site.seededAdmin) {
    console.log(`  Usuario inicial: ${site.adminUser}`);
    console.log(`  Contraseña inicial: ${site.adminPassword}`);
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
