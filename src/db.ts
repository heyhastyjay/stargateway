import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { isPermanentlyBlockedHostname } from "./permanent-blocklist.js";

export type DeviceStatus = "blocked" | "pending" | "allowed" | "revoked";

export interface Device {
  mac: string;
  status: DeviceStatus;
  label: string | null;
  playa_name: string | null;
  paid_until: number | null;
  stripe_session_id: string | null;
  payment_method: string | null;
  online_ms: number;
  session_started_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Payment {
  id: number;
  mac: string;
  method: "stripe" | "venmo" | "paypal" | "cashapp" | "zelle" | "bitcoin" | "comp" | "quick" | "gift" | "cash";
  amount_cents: number;
  status: "pending" | "paid" | "rejected" | "refunded";
  external_id: string | null;
  note: string | null;
  playa_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface Settings {
  price_cents: number;
  currency: string;
  session_hours: number;
  camp_name: string;
  venmo_handle: string;
  paypal_me: string;
  cashapp_handle: string;
  zelle_handle: string;
  bitcoin_address: string;
  welcome_message: string;
  fundraising_goal_cents: number;
}

export interface CampEvent {
  id: number;
  title: string;
  description: string;
  location: string;
  host: string;
  starts_at: number;
  ends_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Guest events UI card state persisted per device MAC. */
export interface EventsProfileState {
  q: string;
  campQ: string;
  camp: string;
  filtersOpen: boolean;
  favoriteIds: number[];
}

export interface DeviceProfile {
  mac: string;
  state: EventsProfileState;
  created_at: number;
  updated_at: number;
}

export const EMPTY_EVENTS_PROFILE: EventsProfileState = {
  q: "",
  campQ: "",
  camp: "",
  filtersOpen: false,
  favoriteIds: [],
};

/** Access-page form draft persisted per device MAC. */
export interface AccessDraft {
  mac: string;
  amount_cents: number | null;
  method: string;
  guest_handle: string;
  playa_name: string;
  created_at: number;
  updated_at: number;
}

export const EMPTY_ACCESS_DRAFT = {
  amount_cents: null as number | null,
  method: "",
  guest_handle: "",
  playa_name: "",
};

export type AccessDraftFields = typeof EMPTY_ACCESS_DRAFT;

export type SiteWhitelistStatus = "pending" | "approved" | "revoked";

export interface SiteWhitelistEntry {
  url: string;
  hostname: string;
  status: SiteWhitelistStatus;
  unique_requesters: number;
  approved_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Unique device MACs that must request the exact same URL before it is approved. */
export const SITE_WHITELIST_VOTES_NEEDED = 3;

export const PLAYA_TZ = "America/Los_Angeles";

const DEFAULTS: Settings = {
  price_cents: 1000,
  currency: "usd",
  session_hours: 24,
  camp_name: "Phage Camp Emergency Starlink by Jaybird",
  venmo_handle: "corvidae",
  paypal_me: "julia.hasty@gmail.com",
  cashapp_handle: "",
  zelle_handle: "540-798-2312",
  bitcoin_address: "bc1q67lmcve9ykjtg8zt09nx57c9lx67pyf6cp7vv3",
  welcome_message:
    "Emergencies only. For more shameful access to the Default World please consider donating.",
  fundraising_goal_cents: 50000,
};

let db: DatabaseSync;

export function getDb(): DatabaseSync {
  if (!db) throw new Error("Database not initialized");
  return db;
}

function columnExists(table: string, column: string): boolean {
  const cols = getDb().prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
  }>;
  return cols.some((c) => c.name === column);
}

function ensureColumn(table: string, column: string, ddl: string): void {
  if (!columnExists(table, column)) {
    getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function initDb(): DatabaseSync {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, "paywall.sqlite");
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      mac TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'blocked',
      label TEXT,
      playa_name TEXT,
      paid_until INTEGER,
      stripe_session_id TEXT,
      payment_method TEXT,
      online_ms INTEGER NOT NULL DEFAULT 0,
      session_started_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mac TEXT NOT NULL,
      method TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      external_id TEXT,
      note TEXT,
      playa_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT '',
      starts_at INTEGER NOT NULL,
      ends_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);

    CREATE TABLE IF NOT EXISTS site_whitelist (
      url TEXT PRIMARY KEY,
      hostname TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      approved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_whitelist_requests (
      url TEXT NOT NULL,
      mac TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (url, mac),
      FOREIGN KEY (url) REFERENCES site_whitelist(url) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_site_whitelist_status ON site_whitelist(status);
    CREATE INDEX IF NOT EXISTS idx_site_whitelist_hostname ON site_whitelist(hostname);

    CREATE TABLE IF NOT EXISTS device_profiles (
      mac TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS access_drafts (
      mac TEXT PRIMARY KEY,
      amount_cents INTEGER,
      method TEXT NOT NULL DEFAULT '',
      guest_handle TEXT NOT NULL DEFAULT '',
      playa_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Migrations for DBs created before playa_name / online tracking
  ensureColumn("devices", "playa_name", "playa_name TEXT");
  ensureColumn("devices", "online_ms", "online_ms INTEGER NOT NULL DEFAULT 0");
  ensureColumn("devices", "session_started_at", "session_started_at INTEGER");
  ensureColumn("payments", "playa_name", "playa_name TEXT");

  for (const [key, value] of Object.entries(DEFAULTS)) {
    const existing = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (!existing) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
    }
  }

  return db;
}

export function getSettings(): Settings {
  const rows = getDb().prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    price_cents: Number(map.price_cents ?? DEFAULTS.price_cents),
    currency: map.currency ?? DEFAULTS.currency,
    session_hours: Number(map.session_hours ?? DEFAULTS.session_hours),
    camp_name: map.camp_name ?? DEFAULTS.camp_name,
    venmo_handle: map.venmo_handle ?? DEFAULTS.venmo_handle,
    paypal_me: map.paypal_me ?? DEFAULTS.paypal_me,
    cashapp_handle: map.cashapp_handle ?? DEFAULTS.cashapp_handle,
    zelle_handle: map.zelle_handle ?? DEFAULTS.zelle_handle,
    bitcoin_address: map.bitcoin_address ?? DEFAULTS.bitcoin_address,
    welcome_message: map.welcome_message ?? DEFAULTS.welcome_message,
    fundraising_goal_cents: Number(map.fundraising_goal_cents ?? DEFAULTS.fundraising_goal_cents),
  };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const stmt = getDb().prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    stmt.run(key, String(value));
  }
  return getSettings();
}

export function normalizeMac(mac: string): string {
  const cleaned = mac.trim().toLowerCase().replace(/[^a-f0-9]/g, "");
  if (cleaned.length !== 12) {
    throw new Error(`Invalid MAC address: ${mac}`);
  }
  return cleaned.match(/.{2}/g)!.join(":");
}

export function sanitizePlayaName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 48);
}

export type ManualPayMethod = "venmo" | "paypal" | "zelle" | "bitcoin" | "cash";

export const DONATION_TIERS: ReadonlyArray<{ cents: number; label: string }> = [
  {
    cents: 0,
    label: "$0 - Need for Science Talks, music or event support for camp",
  },
  {
    cents: 500,
    label: "$5 - Just needed to pay my rent, thanks!",
  },
  {
    cents: 1000,
    label:
      "$10 - Needed to call into that one work meeting, otherwise I wouldn't be able to come to burn.",
  },
  {
    cents: 2000,
    label:
      "$20 - I'm a workaholic, instead of taking days off, I'm making money out here.",
  },
  {
    cents: 3000,
    label: "$30 - I want to scroll the internetz all the timeeee. Whatevarrr~~~ Default Lyfe 🤘",
  },
];

export function isManualPayMethod(raw: string): raw is ManualPayMethod {
  return (
    raw === "venmo" ||
    raw === "paypal" ||
    raw === "zelle" ||
    raw === "bitcoin" ||
    raw === "cash"
  );
}

/** Custom donations: $1–$1,000 in whole cents. */
export const CUSTOM_AMOUNT_MIN_CENTS = 100;
export const CUSTOM_AMOUNT_MAX_CENTS = 100_000;

export function isPresetDonationTierCents(cents: number): boolean {
  return DONATION_TIERS.some((t) => t.cents === cents);
}

export function isAllowedDonationCents(cents: number): boolean {
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) return false;
  if (isPresetDonationTierCents(cents)) return true;
  return cents >= CUSTOM_AMOUNT_MIN_CENTS && cents <= CUSTOM_AMOUNT_MAX_CENTS;
}

/** Preset tier cents, or any allowed custom amount (whole cents). */
export function parseDonationTierCents(raw: string): number | null {
  const cents = Number(raw);
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) return null;
  return isAllowedDonationCents(cents) ? cents : null;
}

/** Parse a dollars string (e.g. "25" / "25.50") into allowed donation cents. */
export function parseDonationDollarsToCents(raw: string): number | null {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^\$/, "")
    .replace(/,/g, "");
  if (!cleaned) return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars)) return null;
  const cents = Math.round(dollars * 100);
  return isAllowedDonationCents(cents) && cents > 0 ? cents : null;
}

/** Normalize + validate the guest's sending account handle for a payment method. */
export function validateGuestPayHandle(
  method: ManualPayMethod,
  raw: string,
): { ok: true; handle: string } | { ok: false; error: string } {
  if (method === "cash") return { ok: true, handle: "cash" };

  const s = raw.trim();
  if (!s) return { ok: false, error: "Account name / handle is required" };

  switch (method) {
    case "venmo": {
      const h = s.replace(/^@/, "");
      if (!/^[A-Za-z0-9_-]{5,30}$/.test(h)) {
        return {
          ok: false,
          error: "Venmo handle must be @username (5–30 letters, numbers, _ or -)",
        };
      }
      return { ok: true, handle: `@${h}` };
    }
    case "paypal": {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
        return { ok: true, handle: s.toLowerCase() };
      }
      const h = s
        .replace(/^@/, "")
        .replace(/^https?:\/\/(www\.)?paypal\.me\//i, "")
        .replace(/\/.*$/, "")
        .trim();
      if (!/^[A-Za-z0-9._-]{3,64}$/.test(h)) {
        return { ok: false, error: "PayPal must be an email or paypal.me username" };
      }
      return { ok: true, handle: h };
    }
    case "zelle": {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
        return { ok: true, handle: s.toLowerCase() };
      }
      const digits = s.replace(/\D/g, "");
      if (digits.length === 10 || (digits.length === 11 && digits.startsWith("1"))) {
        const ten = digits.slice(-10);
        return {
          ok: true,
          handle: `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`,
        };
      }
      return { ok: false, error: "Zelle must be an email or US phone number" };
    }
    case "bitcoin": {
      const addr = s.trim();
      if (!/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(addr)) {
        return { ok: false, error: "Bitcoin must be a valid BTC address" };
      }
      return { ok: true, handle: addr };
    }
  }
}

export function getDevice(mac: string): Device | null {
  const row = getDb().prepare("SELECT * FROM devices WHERE mac = ?").get(normalizeMac(mac));
  return row ? (row as unknown as Device) : null;
}

function endOpenSession(device: Device, now = Date.now()): number {
  if (!device.session_started_at) return device.online_ms ?? 0;
  const added = Math.max(0, now - device.session_started_at);
  return (device.online_ms ?? 0) + added;
}

export function upsertDevice(
  mac: string,
  fields: Partial<Omit<Device, "mac" | "created_at" | "updated_at">>,
): Device {
  const now = Date.now();
  const key = normalizeMac(mac);
  const existing = getDevice(key);

  if (!existing) {
    const becomingAllowed = (fields.status ?? "blocked") === "allowed";
    getDb()
      .prepare(
        `INSERT INTO devices (
          mac, status, label, playa_name, paid_until, stripe_session_id, payment_method,
          online_ms, session_started_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        fields.status ?? "blocked",
        fields.label ?? null,
        fields.playa_name ?? null,
        fields.paid_until ?? null,
        fields.stripe_session_id ?? null,
        fields.payment_method ?? null,
        fields.online_ms ?? 0,
        becomingAllowed ? now : (fields.session_started_at ?? null),
        now,
        now,
      );
    return getDevice(key)!;
  }

  const nextStatus = fields.status ?? existing.status;
  let onlineMs = existing.online_ms ?? 0;
  let sessionStarted = existing.session_started_at;

  if (existing.status === "allowed" && nextStatus !== "allowed") {
    onlineMs = endOpenSession(existing, now);
    sessionStarted = null;
  } else if (existing.status !== "allowed" && nextStatus === "allowed") {
    sessionStarted = now;
  }

  if (fields.online_ms !== undefined) onlineMs = fields.online_ms;
  if (fields.session_started_at !== undefined) sessionStarted = fields.session_started_at;

  const setPaidUntil = fields.paid_until !== undefined;
  getDb()
    .prepare(
      `UPDATE devices SET
        status = ?,
        label = coalesce(?, label),
        playa_name = coalesce(?, playa_name),
        paid_until = CASE WHEN ? = 1 THEN ? ELSE paid_until END,
        stripe_session_id = coalesce(?, stripe_session_id),
        payment_method = coalesce(?, payment_method),
        online_ms = ?,
        session_started_at = ?,
        updated_at = ?
       WHERE mac = ?`,
    )
    .run(
      nextStatus,
      fields.label ?? null,
      fields.playa_name ?? null,
      setPaidUntil ? 1 : 0,
      setPaidUntil ? (fields.paid_until ?? null) : null,
      fields.stripe_session_id ?? null,
      fields.payment_method ?? null,
      onlineMs,
      sessionStarted,
      now,
      key,
    );

  return getDevice(key)!;
}

export function liveOnlineMs(device: Device, now = Date.now()): number {
  const base = device.online_ms ?? 0;
  if (device.status === "allowed" && device.session_started_at) {
    return base + Math.max(0, now - device.session_started_at);
  }
  return base;
}

export function listDevices(): Device[] {
  return getDb()
    .prepare("SELECT * FROM devices ORDER BY updated_at DESC")
    .all() as unknown as Device[];
}

export function createPayment(input: {
  mac: string;
  method: Payment["method"];
  amount_cents: number;
  status: Payment["status"];
  external_id?: string | null;
  note?: string | null;
  playa_name?: string | null;
}): Payment {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO payments (mac, method, amount_cents, status, external_id, note, playa_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      normalizeMac(input.mac),
      input.method,
      input.amount_cents,
      input.status,
      input.external_id ?? null,
      input.note ?? null,
      input.playa_name ?? null,
      now,
      now,
    );
  return getDb()
    .prepare("SELECT * FROM payments WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as unknown as Payment;
}

export function updatePayment(
  id: number,
  fields: Partial<Pick<Payment, "status" | "external_id" | "note" | "playa_name">>,
): Payment | null {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE payments SET
        status = coalesce(?, status),
        external_id = coalesce(?, external_id),
        note = coalesce(?, note),
        playa_name = coalesce(?, playa_name),
        updated_at = ?
       WHERE id = ?`,
    )
    .run(
      fields.status ?? null,
      fields.external_id ?? null,
      fields.note ?? null,
      fields.playa_name ?? null,
      now,
      id,
    );
  return (getDb().prepare("SELECT * FROM payments WHERE id = ?").get(id) as unknown as Payment | undefined) ?? null;
}

export function listPayments(status?: Payment["status"]): Payment[] {
  if (status) {
    return getDb()
      .prepare("SELECT * FROM payments WHERE status = ? ORDER BY created_at DESC")
      .all(status) as unknown as Payment[];
  }
  return getDb()
    .prepare("SELECT * FROM payments ORDER BY created_at DESC LIMIT 200")
    .all() as unknown as Payment[];
}

export function getPayment(id: number): Payment | null {
  return (getDb().prepare("SELECT * FROM payments WHERE id = ?").get(id) as unknown as Payment | undefined) ?? null;
}

/** Sum of completed payments (excludes free comps). */
export function totalRaisedCents(): number {
  const row = getDb()
    .prepare(
      `SELECT coalesce(sum(amount_cents), 0) AS total
       FROM payments
       WHERE status = 'paid' AND method != 'comp' AND method != 'quick'`,
    )
    .get() as unknown as { total: number | bigint };
  return Number(row.total ?? 0);
}

export function sessionExpiryMs(hours = getSettings().session_hours): number {
  return Date.now() + hours * 60 * 60 * 1000;
}

/** Short visitor unlock. */
export const QUICK_ACCESS_MINUTES = 10;
/** After a visitor unlock ends, this MAC cannot request another until this cool-down elapses. */
export const QUICK_ACCESS_COOLDOWN_MINUTES = 20;
/** Phage VIP unlock. After this they are kicked off with no cool-down; they can click in again. */
export const VIP_ACCESS_HOURS = 3;

export function sessionExpiryFromMinutes(minutes: number): number {
  return Date.now() + minutes * 60 * 1000;
}

/** Timestamp when this MAC may request quick access again (null = never used / available). */
export function quickAccessAvailableAt(mac: string): number | null {
  const row = getDb()
    .prepare(
      `SELECT created_at FROM payments
       WHERE mac = ? AND method = 'quick' AND status = 'paid'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(normalizeMac(mac)) as { created_at: number } | undefined;
  if (!row) return null;
  return (
    Number(row.created_at) +
    (QUICK_ACCESS_MINUTES + QUICK_ACCESS_COOLDOWN_MINUTES) * 60 * 1000
  );
}

/** Ms until quick access is available again (0 = ready now). */
export function quickAccessCooldownRemainingMs(mac: string, now = Date.now()): number {
  const availableAt = quickAccessAvailableAt(mac);
  if (!availableAt) return 0;
  return Math.max(0, availableAt - now);
}

/** Clears quick-access payment history so cooldown no longer applies (dev/test). */
export function clearQuickAccessHistory(mac: string): number {
  const result = getDb()
    .prepare(`DELETE FROM payments WHERE mac = ? AND method = 'quick'`)
    .run(normalizeMac(mac));
  return Number(result.changes ?? 0);
}

export function isDeviceCurrentlyAllowed(device: Device | null): boolean {
  if (!device || device.status !== "allowed") return false;
  if (device.paid_until && device.paid_until < Date.now()) return false;
  return true;
}

export function sanitizeEventText(raw: string, max: number): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Strip playaevents source URLs / [playaevents] marker for display (import still stores the marker). */
export function displayEventDescription(description: string): string {
  return description
    .replace(/(?:\s*[·•]\s*)?https?:\/\/(?:www\.)?playaevents\.burningman\.org\S*/gi, " ")
    .replace(/\[playaevents\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rowToEvent(row: unknown): CampEvent {
  const r = row as CampEvent;
  return {
    id: Number(r.id),
    title: String(r.title ?? ""),
    description: String(r.description ?? ""),
    location: String(r.location ?? ""),
    host: String(r.host ?? ""),
    starts_at: Number(r.starts_at),
    ends_at: r.ends_at == null ? null : Number(r.ends_at),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

/** Keep guest/admin HTML small — full dump of playaevents is multi‑MB. */
export const GUEST_EVENT_LIMIT = 50;
export const SEARCH_EVENT_LIMIT = 80;
export const ADMIN_EVENT_LIMIT = 100;

export function eventSearchHaystack(event: CampEvent): string {
  return [event.title, event.host, event.location, displayEventDescription(event.description)]
    .join(" ")
    .toLowerCase();
}

/**
 * Lightweight fuzzy score: subsequence match with bonuses for substrings,
 * consecutive runs, and word-boundary hits. 0 = no match.
 */
export function fuzzyScore(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase().replace(/\s+/g, " ").trim();
  if (!n) return 1;
  if (h.includes(n)) {
    return 200 + Math.round((n.length / Math.max(h.length, 1)) * 40);
  }
  let hi = 0;
  let score = 0;
  let consecutive = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni]!;
    if (ch === " ") {
      consecutive = 0;
      continue;
    }
    const found = h.indexOf(ch, hi);
    if (found < 0) return 0;
    if (found === hi) consecutive += 1;
    else consecutive = 0;
    score += 1 + consecutive * 2;
    if (found === 0 || /\s/.test(h[found - 1] ?? " ")) score += 4;
    hi = found + 1;
  }
  return score;
}

export function listEvents(limit?: number): CampEvent[] {
  const sql =
    limit == null
      ? "SELECT * FROM events ORDER BY starts_at ASC, id ASC"
      : "SELECT * FROM events ORDER BY starts_at ASC, id ASC LIMIT ?";
  const rows = limit == null ? getDb().prepare(sql).all() : getDb().prepare(sql).all(limit);
  return rows.map(rowToEvent);
}

export function getEventsByIds(ids: number[]): CampEvent[] {
  const uniq = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!uniq.length) return [];
  const placeholders = uniq.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM events WHERE id IN (${placeholders})`)
    .all(...uniq)
    .map(rowToEvent);
  const byId = new Map(rows.map((e) => [e.id, e]));
  return uniq.map((id) => byId.get(id)).filter((e): e is CampEvent => !!e);
}

export function listCampNames(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT host AS host FROM events
         WHERE host IS NOT NULL AND trim(host) != ''
         ORDER BY host COLLATE NOCASE`,
      )
      .all() as Array<{ host: string }>
  ).map((r) => String(r.host));
}

export function searchCamps(query: string, limit = 40): string[] {
  const camps = listCampNames();
  const q = query.replace(/\s+/g, " ").trim();
  if (!q) return camps.slice(0, limit);
  return camps
    .map((name) => ({ name, score: fuzzyScore(name.toLowerCase(), q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((x) => x.name);
}

export function countEvents(query = "", camp = ""): number {
  const q = query.replace(/\s+/g, " ").trim();
  const campFilter = camp.replace(/\s+/g, " ").trim().toLowerCase();
  if (!q && !campFilter) {
    return Number(getDb().prepare("SELECT COUNT(*) AS c FROM events").get()?.c ?? 0);
  }
  if (!q && campFilter) {
    return Number(
      getDb()
        .prepare(`SELECT COUNT(*) AS c FROM events WHERE lower(host) = ?`)
        .get(campFilter)?.c ?? 0,
    );
  }
  return searchEvents(query, Number.MAX_SAFE_INTEGER, camp).length;
}

export function searchEvents(
  query: string,
  limit = SEARCH_EVENT_LIMIT,
  camp = "",
): CampEvent[] {
  const q = query.replace(/\s+/g, " ").trim();
  const campFilter = camp.replace(/\s+/g, " ").trim().toLowerCase();
  const all = listEvents();
  let pool = all;
  if (campFilter) {
    pool = all.filter((e) => e.host.toLowerCase() === campFilter);
  }
  if (!q) {
    return pool.slice(0, limit);
  }
  return pool
    .map((e) => ({ e, score: fuzzyScore(eventSearchHaystack(e), q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.starts_at - b.e.starts_at || a.e.id - b.e.id)
    .slice(0, limit)
    .map((x) => x.e);
}

export function getEvent(id: number): CampEvent | null {
  const row = getDb().prepare("SELECT * FROM events WHERE id = ?").get(id);
  return row ? rowToEvent(row) : null;
}

function parseEventsProfileState(raw: unknown): EventsProfileState {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const favoriteIds = Array.isArray(o.favoriteIds)
    ? o.favoriteIds.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  return {
    q: typeof o.q === "string" ? o.q.slice(0, 200) : "",
    campQ: typeof o.campQ === "string" ? o.campQ.slice(0, 120) : "",
    camp: typeof o.camp === "string" ? o.camp.slice(0, 80) : "",
    filtersOpen: Boolean(o.filtersOpen),
    favoriteIds: [...new Set(favoriteIds)].slice(0, 500),
  };
}

function parseAccessDraftFields(raw: Partial<AccessDraftFields> | AccessDraftFields): AccessDraftFields {
  let amount_cents: number | null = null;
  if (raw.amount_cents != null) {
    const n = Number(raw.amount_cents);
    if (Number.isFinite(n) && Number.isInteger(n) && isAllowedDonationCents(n)) {
      amount_cents = n;
    }
  }
  const methodRaw = typeof raw.method === "string" ? raw.method.trim().toLowerCase() : "";
  let method =
    methodRaw === "venmo" ||
    methodRaw === "paypal" ||
    methodRaw === "zelle" ||
    methodRaw === "bitcoin" ||
    methodRaw === "cash"
      ? methodRaw
      : "";
  // $0 tier does not use a payment method
  if (amount_cents === 0) method = "";
  return {
    amount_cents,
    method,
    guest_handle: typeof raw.guest_handle === "string" ? raw.guest_handle.trim().slice(0, 80) : "",
    playa_name: sanitizePlayaName(typeof raw.playa_name === "string" ? raw.playa_name : ""),
  };
}

function rowToAccessDraft(row: {
  mac: string;
  amount_cents: number | null;
  method: string;
  guest_handle: string;
  playa_name: string;
  created_at: number;
  updated_at: number;
}): AccessDraft {
  const fields = parseAccessDraftFields({
    amount_cents: row.amount_cents,
    method: row.method,
    guest_handle: row.guest_handle,
    playa_name: row.playa_name,
  });
  return {
    mac: row.mac,
    ...fields,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function getAccessDraft(mac: string): AccessDraft | null {
  let key: string;
  try {
    key = normalizeMac(mac);
  } catch {
    return null;
  }
  const row = getDb().prepare("SELECT * FROM access_drafts WHERE mac = ?").get(key) as
    | {
        mac: string;
        amount_cents: number | null;
        method: string;
        guest_handle: string;
        playa_name: string;
        created_at: number;
        updated_at: number;
      }
    | undefined;
  return row ? rowToAccessDraft(row) : null;
}

export function saveAccessDraft(
  mac: string,
  input: Partial<AccessDraftFields>,
): AccessDraft {
  const key = normalizeMac(mac);
  upsertDevice(key, {});
  const existing = getAccessDraft(key);
  const fields = parseAccessDraftFields({
    ...(existing
      ? {
          amount_cents: existing.amount_cents,
          method: existing.method,
          guest_handle: existing.guest_handle,
          playa_name: existing.playa_name,
        }
      : EMPTY_ACCESS_DRAFT),
    ...input,
  });
  const now = Date.now();
  if (existing) {
    getDb()
      .prepare(
        `UPDATE access_drafts SET
          amount_cents = ?, method = ?, guest_handle = ?, playa_name = ?, updated_at = ?
         WHERE mac = ?`,
      )
      .run(
        fields.amount_cents,
        fields.method,
        fields.guest_handle,
        fields.playa_name,
        now,
        key,
      );
  } else {
    getDb()
      .prepare(
        `INSERT INTO access_drafts (
          mac, amount_cents, method, guest_handle, playa_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        fields.amount_cents,
        fields.method,
        fields.guest_handle,
        fields.playa_name,
        now,
        now,
      );
  }
  // Keep burner name on the device record when the draft has one
  if (fields.playa_name) {
    upsertDevice(key, { playa_name: fields.playa_name });
  }
  return getAccessDraft(key)!;
}

export function listAccessDrafts(): AccessDraft[] {
  return (
    getDb()
      .prepare("SELECT * FROM access_drafts ORDER BY updated_at DESC")
      .all() as Array<{
      mac: string;
      amount_cents: number | null;
      method: string;
      guest_handle: string;
      playa_name: string;
      created_at: number;
      updated_at: number;
    }>
  ).map(rowToAccessDraft);
}

/** Devices with live online time, merged with any access-form draft for admin lists. */
export function listDevicesWithAccessDrafts(): Array<
  Device & { draft: AccessDraft | null; online_live_ms: number }
> {
  const devices = listDevices();
  const drafts = new Map(listAccessDrafts().map((d) => [d.mac, d]));
  return devices.map((device) => ({
    ...device,
    draft: drafts.get(device.mac) ?? null,
    online_live_ms: liveOnlineMs(device),
  }));
}

export function getDeviceProfile(mac: string): DeviceProfile | null {
  let key: string;
  try {
    key = normalizeMac(mac);
  } catch {
    return null;
  }
  const row = getDb().prepare("SELECT * FROM device_profiles WHERE mac = ?").get(key) as
    | { mac: string; state_json: string; created_at: number; updated_at: number }
    | undefined;
  if (!row) return null;
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(row.state_json);
  } catch {
    parsed = {};
  }
  return {
    mac: row.mac,
    state: parseEventsProfileState(parsed),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function saveDeviceProfile(
  mac: string,
  stateInput: Partial<EventsProfileState> | EventsProfileState,
): DeviceProfile {
  const key = normalizeMac(mac);
  upsertDevice(key, {});
  const existing = getDeviceProfile(key);
  const state = parseEventsProfileState({
    ...(existing?.state ?? EMPTY_EVENTS_PROFILE),
    ...stateInput,
  });
  const now = Date.now();
  const json = JSON.stringify(state);
  if (existing) {
    getDb()
      .prepare(
        `UPDATE device_profiles SET state_json = ?, updated_at = ? WHERE mac = ?`,
      )
      .run(json, now, key);
  } else {
    getDb()
      .prepare(
        `INSERT INTO device_profiles (mac, state_json, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run(key, json, now, now);
  }
  return getDeviceProfile(key)!;
}

/**
 * Merge profiles for two devices. Card state uses last-write-wins by updated_at;
 * the winning state is written to both MACs (preserving the winner's updated_at).
 */
export function mergeDeviceProfiles(
  primaryMac: string,
  otherMac: string,
): { primary: DeviceProfile; other: DeviceProfile; winnerMac: string } {
  const a = normalizeMac(primaryMac);
  const b = normalizeMac(otherMac);
  if (a === b) throw new Error("Cannot merge a device with itself");
  upsertDevice(a, {});
  upsertDevice(b, {});
  const pa = getDeviceProfile(a);
  const pb = getDeviceProfile(b);
  const emptyA: DeviceProfile = {
    mac: a,
    state: { ...EMPTY_EVENTS_PROFILE },
    created_at: Date.now(),
    updated_at: 0,
  };
  const emptyB: DeviceProfile = {
    mac: b,
    state: { ...EMPTY_EVENTS_PROFILE },
    created_at: Date.now(),
    updated_at: 0,
  };
  const left = pa ?? emptyA;
  const right = pb ?? emptyB;
  const winner = left.updated_at >= right.updated_at ? left : right;
  const loserMac = winner.mac === a ? b : a;
  const json = JSON.stringify(winner.state);
  const createdLoser = (winner.mac === a ? right : left).created_at || Date.now();
  const createdWinner = winner.created_at || Date.now();

  const upsert = (mac: string, createdAt: number) => {
    const exists = getDb().prepare("SELECT mac FROM device_profiles WHERE mac = ?").get(mac);
    if (exists) {
      getDb()
        .prepare(`UPDATE device_profiles SET state_json = ?, updated_at = ? WHERE mac = ?`)
        .run(json, winner.updated_at || Date.now(), mac);
    } else {
      getDb()
        .prepare(
          `INSERT INTO device_profiles (mac, state_json, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        )
        .run(mac, json, createdAt, winner.updated_at || Date.now());
    }
  };
  upsert(winner.mac, createdWinner);
  upsert(loserMac, createdLoser);

  return {
    primary: getDeviceProfile(a)!,
    other: getDeviceProfile(b)!,
    winnerMac: winner.mac,
  };
}

export function playaDayKey(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PLAYA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export function createEvent(input: {
  title: string;
  description?: string;
  location?: string;
  host?: string;
  starts_at: number;
  ends_at?: number | null;
}): CampEvent {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO events (title, description, location, host, starts_at, ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sanitizeEventText(input.title, 80),
      sanitizeEventText(input.description ?? "", 2000),
      sanitizeEventText(input.location ?? "", 80),
      sanitizeEventText(input.host ?? "", 48),
      input.starts_at,
      input.ends_at ?? null,
      now,
      now,
    );
  return getEvent(Number(result.lastInsertRowid))!;
}

export function updateEvent(
  id: number,
  input: {
    title: string;
    description?: string;
    location?: string;
    host?: string;
    starts_at: number;
    ends_at?: number | null;
  },
): CampEvent | null {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE events SET
        title = ?,
        description = ?,
        location = ?,
        host = ?,
        starts_at = ?,
        ends_at = ?,
        updated_at = ?
       WHERE id = ?`,
    )
    .run(
      sanitizeEventText(input.title, 80),
      sanitizeEventText(input.description ?? "", 2000),
      sanitizeEventText(input.location ?? "", 80),
      sanitizeEventText(input.host ?? "", 48),
      input.starts_at,
      input.ends_at ?? null,
      now,
      id,
    );
  return getEvent(id);
}

export function deleteEvent(id: number): void {
  getDb().prepare("DELETE FROM events WHERE id = ?").run(id);
}

/**
 * Canonical exact URL key for whitelist voting.
 * Same link after light normalization (scheme, lowercased host, no trailing slash except `/`).
 */
export function normalizeWhitelistUrl(raw: string): { url: string; hostname: string } {
  let input = raw.trim();
  if (!input) throw new Error("URL is required");
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    throw new Error("Enter a website hostname, not an IP or localhost");
  }
  if (hostname === config.portalIp || hostname.endsWith(".local")) {
    throw new Error("That site is already on the camp network");
  }

  const path = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/, "");
  const url = `${parsed.protocol.toLowerCase()}//${hostname}${path}${parsed.search}`;
  return { url, hostname };
}

function countSiteRequesters(url: string): number {
  const row = getDb()
    .prepare("SELECT count(*) AS n FROM site_whitelist_requests WHERE url = ?")
    .get(url) as { n: number | bigint };
  return Number(row.n);
}

function rowToSiteWhitelist(row: unknown, uniqueRequesters?: number): SiteWhitelistEntry {
  const r = row as SiteWhitelistEntry;
  return {
    url: String(r.url),
    hostname: String(r.hostname),
    status: r.status as SiteWhitelistStatus,
    unique_requesters: uniqueRequesters ?? countSiteRequesters(String(r.url)),
    approved_at: r.approved_at == null ? null : Number(r.approved_at),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

export function getSiteWhitelist(url: string): SiteWhitelistEntry | null {
  const row = getDb().prepare("SELECT * FROM site_whitelist WHERE url = ?").get(url);
  return row ? rowToSiteWhitelist(row) : null;
}

export function listSiteWhitelist(status?: SiteWhitelistStatus): SiteWhitelistEntry[] {
  const rows = status
    ? (getDb()
        .prepare("SELECT * FROM site_whitelist WHERE status = ? ORDER BY updated_at DESC")
        .all(status) as unknown[])
    : (getDb()
        .prepare("SELECT * FROM site_whitelist ORDER BY status ASC, updated_at DESC")
        .all() as unknown[]);
  return rows.map((r) => rowToSiteWhitelist(r));
}

export function listApprovedSiteHostnames(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT hostname FROM site_whitelist
       WHERE status = 'approved'
       ORDER BY hostname ASC`,
    )
    .all() as unknown as Array<{ hostname: string }>;
  return rows.map((r) => r.hostname.toLowerCase());
}

export type SiteWhitelistRequestResult = {
  entry: SiteWhitelistEntry;
  alreadyRequested: boolean;
  newlyApproved: boolean;
  votesNeeded: number;
};

/** Record a MAC vote for an exact URL; auto-approves at SITE_WHITELIST_VOTES_NEEDED unique MACs. */
export function requestSiteWhitelist(rawUrl: string, mac: string): SiteWhitelistRequestResult {
  const { url, hostname } = normalizeWhitelistUrl(rawUrl);
  if (isPermanentlyBlockedHostname(hostname)) {
    throw new Error("That site is blocked on this network");
  }
  const key = normalizeMac(mac);
  const now = Date.now();
  const db = getDb();

  let existing = getSiteWhitelist(url);
  if (!existing) {
    db.prepare(
      `INSERT INTO site_whitelist (url, hostname, status, approved_at, created_at, updated_at)
       VALUES (?, ?, 'pending', NULL, ?, ?)`,
    ).run(url, hostname, now, now);
    existing = getSiteWhitelist(url)!;
  }

  if (existing.status === "revoked") {
    db.prepare(
      `UPDATE site_whitelist SET status = 'pending', approved_at = NULL, updated_at = ? WHERE url = ?`,
    ).run(now, url);
  }

  const prior = db
    .prepare("SELECT 1 AS ok FROM site_whitelist_requests WHERE url = ? AND mac = ?")
    .get(url, key) as { ok: number } | undefined;
  const alreadyRequested = Boolean(prior);

  if (!alreadyRequested) {
    db.prepare(
      `INSERT INTO site_whitelist_requests (url, mac, created_at) VALUES (?, ?, ?)`,
    ).run(url, key, now);
  }

  const votes = countSiteRequesters(url);
  let newlyApproved = false;
  let entry = getSiteWhitelist(url)!;

  if (entry.status !== "approved" && votes >= SITE_WHITELIST_VOTES_NEEDED) {
    db.prepare(
      `UPDATE site_whitelist SET status = 'approved', approved_at = ?, updated_at = ? WHERE url = ?`,
    ).run(now, now, url);
    newlyApproved = true;
    entry = getSiteWhitelist(url)!;
  } else if (!alreadyRequested) {
    db.prepare(`UPDATE site_whitelist SET updated_at = ? WHERE url = ?`).run(now, url);
    entry = getSiteWhitelist(url)!;
  }

  return {
    entry: { ...entry, unique_requesters: votes },
    alreadyRequested,
    newlyApproved,
    votesNeeded: SITE_WHITELIST_VOTES_NEEDED,
  };
}

export function revokeSiteWhitelist(url: string): SiteWhitelistEntry | null {
  const existing = getSiteWhitelist(url);
  if (!existing) return null;
  const now = Date.now();
  const db = getDb();
  db.prepare(`DELETE FROM site_whitelist_requests WHERE url = ?`).run(url);
  db.prepare(
    `UPDATE site_whitelist SET status = 'revoked', approved_at = NULL, updated_at = ? WHERE url = ?`,
  ).run(now, url);
  return getSiteWhitelist(url);
}

/** Treat naive datetime-local (`YYYY-MM-DDTHH:mm`) as playa / Pacific time. */
export function parsePlayaLocal(value: string): number | null {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const desired = Date.UTC(y, mo - 1, d, hh, mm);
  let guess = desired;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: PLAYA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const asZoneUtc = (ms: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  };
  guess += desired - asZoneUtc(guess);
  guess += desired - asZoneUtc(guess);
  return guess;
}

export function toPlayaDatetimeLocal(ms: number): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: PLAYA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function formatEventWhen(startsAt: number, endsAt: number | null): string {
  const startFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: PLAYA_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: PLAYA_TZ,
    hour: "numeric",
    minute: "2-digit",
  });
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: PLAYA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const start = startFmt.format(new Date(startsAt));
  if (!endsAt) return start;
  if (dayKey.format(new Date(startsAt)) === dayKey.format(new Date(endsAt))) {
    return `${start} – ${timeFmt.format(new Date(endsAt))}`;
  }
  return `${start} – ${startFmt.format(new Date(endsAt))}`;
}

export function eventIsHappening(event: CampEvent, now = Date.now()): boolean {
  if (event.starts_at > now) return false;
  if (event.ends_at != null) return event.ends_at >= now;
  return now - event.starts_at < 2 * 60 * 60 * 1000;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
