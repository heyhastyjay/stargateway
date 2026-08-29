import { config } from "./config.js";
import { getDb, normalizeMac } from "./db.js";
import { currentLocalDateKey } from "./weather.js";

/** Pixel 10 Pro factory Wi‑Fi MAC (About phone → Device Wi‑Fi MAC). */
export const SEEDED_OPERATOR_IDS = ["b0:d5:fb:9c:1a:ef"] as const;

const KEY_REMAINING = "data_remaining_gb";
const KEY_LIMIT = "data_limit_gb";
const KEY_RESERVED = "data_reserved_gb";
const KEY_UPDATED = "data_updated_at";
const KEY_PACE_DAY = "data_pace_day";
const KEY_PACE_START = "data_pace_start_gb";
const KEY_PACE_DAYS = "data_pace_days";
const KEY_OPERATOR_IDS = "data_operator_ids";
const KEY_OPERATOR_MACS = "data_operator_macs";

/** Camp paces toward this playa date; 25 GB hold is for that Monday. */
export const CAMP_HOLD_UNTIL_DATE = "2026-08-31";

/**
 * Fat buffer for 1h heavy browsing/email + 1h audio call with 10 min screen share.
 * Realistic need is ~2–8 GB; 25 GB is several times worst-case.
 */
export const DEFAULT_RESERVED_GB = 25;

export type StarlinkDataTone = "green" | "yellow" | "amber" | "red" | "empty";

export interface StarlinkDataStatus {
  remaining_gb: number | null;
  limit_gb: number | null;
  reserved_gb: number | null;
  available_gb: number | null;
  days_left: number | null;
  used_today_gb: number | null;
  daily_budget_gb: number | null;
  daily_pct_left: number | null;
  /** True when remaining has hit the reserved floor — stop new guest grants. */
  guest_hold_active: boolean;
  updated_at: number | null;
  label: string;
  tone: StarlinkDataTone;
}

export interface StarlinkDataOperatorView extends StarlinkDataStatus {
  operator: boolean;
  current_mac: string | null;
  unique_ids: string[];
  bound_macs: string[];
}

function getRaw(key: string): string {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? "";
}

function setRaw(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

function parseMacList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    if (!part) continue;
    try {
      const mac = normalizeMac(part);
      if (seen.has(mac)) continue;
      seen.add(mac);
      out.push(mac);
    } catch {
      /* skip junk */
    }
  }
  return out;
}

function parseOptionalGb(raw: string): number | null {
  if (!raw || raw === "null") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10_000) return null;
  return Math.round(n * 100) / 100;
}

export function parseGbInput(raw: string): number | null {
  const cleaned = String(raw || "")
    .trim()
    .replace(/,/g, "")
    .replace(/gb$/i, "")
    .trim();
  if (!cleaned) return null;
  return parseOptionalGb(cleaned);
}

function envOperatorIds(): string[] {
  return parseMacList(config.dataOperatorIds);
}

export function listedOperatorIds(): string[] {
  const fromSettings = parseMacList(getRaw(KEY_OPERATOR_IDS));
  const seeded = fromSettings.length ? fromSettings : [...SEEDED_OPERATOR_IDS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const mac of [...envOperatorIds(), ...seeded]) {
    if (seen.has(mac)) continue;
    seen.add(mac);
    out.push(mac);
  }
  return out;
}

export function boundOperatorMacs(): string[] {
  return parseMacList(getRaw(KEY_OPERATOR_MACS));
}

export function authorizedOperatorMacs(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const mac of [...listedOperatorIds(), ...boundOperatorMacs()]) {
    if (seen.has(mac)) continue;
    seen.add(mac);
    out.push(mac);
  }
  return out;
}

export function isStarlinkDataOperator(mac: string | null, isAdmin = false): boolean {
  if (isAdmin) return true;
  if (!mac) return false;
  try {
    return authorizedOperatorMacs().includes(normalizeMac(mac));
  } catch {
    return false;
  }
}

export function formatGb(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 100) return n.toFixed(0);
  if (abs >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function resolveReservedGb(remaining: number | null): number | null {
  const raw = getRaw(KEY_RESERVED);
  if (raw === "0") return 0;
  const parsed = parseOptionalGb(raw);
  if (parsed != null) return parsed;
  if (remaining != null) return DEFAULT_RESERVED_GB;
  return null;
}

function calendarDaysBetween(fromKey: string, untilKey: string): number {
  const from = Date.parse(`${fromKey}T12:00:00Z`);
  const until = Date.parse(`${untilKey}T12:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(until)) return 1;
  return Math.round((until - from) / 86_400_000);
}

/** Days of camp pool left, including today, until the Monday hold (min 1). */
export function campDaysLeft(now = Date.now()): number {
  const today = currentLocalDateKey(new Date(now));
  const until = calendarDaysBetween(today, CAMP_HOLD_UNTIL_DATE);
  if (until <= 0) return 1;
  return until;
}

function holdUntilShortLabel(dateKey = CAMP_HOLD_UNTIL_DATE): string {
  const parts = dateKey.split("-").map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (!year || !month || !day) return dateKey;
  const utc = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(utc);
  return `${weekday} ${month}/${day}`;
}

function campUntilPhrase(now = Date.now()): string {
  const today = currentLocalDateKey(new Date(now));
  if (today < CAMP_HOLD_UNTIL_DATE) return ` until ${holdUntilShortLabel()}`;
  if (today === CAMP_HOLD_UNTIL_DATE) return ` today (${holdUntilShortLabel()})`;
  return "";
}

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 366) return null;
  return Math.round(n);
}

function resetPaceDay(availableGb: number, now = Date.now()): void {
  setRaw(KEY_PACE_DAY, currentLocalDateKey(new Date(now)));
  setRaw(KEY_PACE_START, String(availableGb));
  setRaw(KEY_PACE_DAYS, String(campDaysLeft(now)));
}

/** Keep today's start-of-day pool; roll at midnight Pacific or after a refill. */
function syncPaceDay(availableGb: number, opts?: { refill?: boolean; now?: number }): {
  days_left: number;
  used_today_gb: number;
  daily_budget_gb: number;
  daily_pct_left: number;
} {
  const now = opts?.now ?? Date.now();
  const today = currentLocalDateKey(new Date(now));
  const storedDay = getRaw(KEY_PACE_DAY);
  let start = parseOptionalGb(getRaw(KEY_PACE_START));
  let days = parsePositiveInt(getRaw(KEY_PACE_DAYS));
  if (opts?.refill || storedDay !== today || start == null || days == null) {
    resetPaceDay(availableGb, now);
    start = availableGb;
    days = campDaysLeft(now);
  }
  const used_today_gb = Math.max(0, Math.round((start - availableGb) * 100) / 100);
  const daily_budget_gb = Math.round((start / days) * 100) / 100;
  const daily_pct_left =
    daily_budget_gb <= 0
      ? 0
      : Math.max(0, Math.min(100, Math.round((1 - used_today_gb / daily_budget_gb) * 100)));
  return { days_left: days, used_today_gb, daily_budget_gb, daily_pct_left };
}

function toneFor(status: {
  remaining: number | null;
  reserved: number | null;
  available: number | null;
  daily_pct_left: number | null;
  guest_hold_active: boolean;
}): StarlinkDataTone {
  const { remaining, reserved, available, daily_pct_left, guest_hold_active } = status;
  if (remaining == null) return "empty";
  if (remaining <= 0 || guest_hold_active) return "red";
  if (reserved != null && reserved > 0 && remaining <= reserved) return "red";
  if (available != null && available <= 5) return "red";
  if (daily_pct_left == null) {
    if (available != null && available <= 20) return "amber";
    return "green";
  }
  if (daily_pct_left < 25) return "red";
  if (daily_pct_left < 50) return "amber";
  if (daily_pct_left < 75) return "yellow";
  return "green";
}

function tickerLabel(status: {
  available_gb: number | null;
  remaining_gb: number | null;
  daily_pct_left: number | null;
}): string {
  if (status.available_gb == null && status.remaining_gb == null) {
    return "Starlink remaining data not set yet";
  }
  const pool = status.available_gb ?? status.remaining_gb ?? 0;
  const pct =
    status.daily_pct_left == null ? "—" : `${status.daily_pct_left}%`;
  return `${formatGb(pool)} GB left for camp${campUntilPhrase()}. Daily % left: ${pct}`;
}

export function getStarlinkDataStatus(): StarlinkDataStatus {
  const remaining_gb = parseOptionalGb(getRaw(KEY_REMAINING));
  const limit_gb = parseOptionalGb(getRaw(KEY_LIMIT));
  const reserved_gb = resolveReservedGb(remaining_gb);
  const available_gb =
    remaining_gb == null ? null : Math.max(0, remaining_gb - Math.max(0, reserved_gb ?? 0));
  const guest_hold_active =
    remaining_gb != null && reserved_gb != null && reserved_gb > 0 && remaining_gb <= reserved_gb;
  const updatedRaw = getRaw(KEY_UPDATED);
  const updated_at = updatedRaw ? Number(updatedRaw) : NaN;
  const pace =
    available_gb == null
      ? { days_left: null, used_today_gb: null, daily_budget_gb: null, daily_pct_left: null }
      : syncPaceDay(available_gb);
  const tone = toneFor({
    remaining: remaining_gb,
    reserved: reserved_gb,
    available: available_gb,
    daily_pct_left: pace.daily_pct_left,
    guest_hold_active,
  });
  return {
    remaining_gb,
    limit_gb,
    reserved_gb,
    available_gb,
    days_left: pace.days_left,
    used_today_gb: pace.used_today_gb,
    daily_budget_gb: pace.daily_budget_gb,
    daily_pct_left: pace.daily_pct_left,
    guest_hold_active,
    updated_at: Number.isFinite(updated_at) ? updated_at : null,
    label: tickerLabel({
      available_gb,
      remaining_gb,
      daily_pct_left: pace.daily_pct_left,
    }),
    tone,
  };
}

/** New guest grants (quick / VIP) stop when remaining has hit the reserved floor. Operators stay open. */
export function guestAccessBlockedByDataHold(mac: string | null, isAdmin = false): boolean {
  if (isStarlinkDataOperator(mac, isAdmin)) return false;
  return getStarlinkDataStatus().guest_hold_active;
}

export function getStarlinkDataOperatorView(
  mac: string | null,
  isAdmin = false,
): StarlinkDataOperatorView {
  return {
    ...getStarlinkDataStatus(),
    operator: isStarlinkDataOperator(mac, isAdmin),
    current_mac: mac,
    unique_ids: listedOperatorIds(),
    bound_macs: boundOperatorMacs(),
  };
}

export function setStarlinkDataRemaining(input: {
  remainingGb: number;
  limitGb?: number | null;
  reservedGb?: number | null;
}): StarlinkDataStatus {
  const prevRemaining = parseOptionalGb(getRaw(KEY_REMAINING));
  setRaw(KEY_REMAINING, String(input.remainingGb));
  if (input.limitGb === null) {
    setRaw(KEY_LIMIT, "");
  } else if (input.limitGb != null) {
    setRaw(KEY_LIMIT, String(input.limitGb));
  }
  if (input.reservedGb === null) {
    setRaw(KEY_RESERVED, "");
  } else if (input.reservedGb != null) {
    setRaw(KEY_RESERVED, String(input.reservedGb));
  } else if (!getRaw(KEY_RESERVED)) {
    setRaw(KEY_RESERVED, String(DEFAULT_RESERVED_GB));
  }
  setRaw(KEY_UPDATED, String(Date.now()));
  const reserved = resolveReservedGb(input.remainingGb);
  const available = Math.max(0, input.remainingGb - Math.max(0, reserved ?? 0));
  const refill = prevRemaining != null && input.remainingGb > prevRemaining + 0.05;
  syncPaceDay(available, { refill });
  return getStarlinkDataStatus();
}

function writeMacList(key: string, macs: string[]): void {
  setRaw(key, macs.join(","));
}

/**
 * Prove you know a registered unique ID (factory Wi‑Fi MAC) to bind this
 * network's observed MAC — Android randomized MACs need this once.
 */
export function bindStarlinkDataOperator(
  currentMac: string,
  uniqueId: string,
): { mac: string } {
  const observed = normalizeMac(currentMac);
  const claimed = normalizeMac(uniqueId);
  if (!listedOperatorIds().includes(claimed)) {
    throw new Error("That unique ID is not on the operator list");
  }
  const bound = boundOperatorMacs();
  if (!bound.includes(observed)) {
    writeMacList(KEY_OPERATOR_MACS, [...bound, observed]);
  }
  return { mac: observed };
}

export function addStarlinkDataOperatorId(uniqueId: string): string {
  const mac = normalizeMac(uniqueId);
  const ids = listedOperatorIds();
  if (!ids.includes(mac)) {
    writeMacList(KEY_OPERATOR_IDS, [...ids, mac]);
  }
  return mac;
}

export function formatUpdatedAgo(updatedAt: number | null, now = Date.now()): string {
  if (!updatedAt) return "";
  const delta = Math.max(0, now - updatedAt);
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return "1 hr ago";
  if (hours < 48) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
