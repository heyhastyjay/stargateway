/**
 * Members-only gate: randomly shows one camp secret question.
 * Burn-night chef is pulled live from the kitchen schedule spreadsheet
 * (Friday Dinner "Head Playa Chef"); other answers are static.
 */

import { config } from "./config.js";

const SHEET_CSV_URL = () =>
  `https://docs.google.com/spreadsheets/d/${encodeURIComponent(config.membersSheetId)}/export?format=csv&gid=${encodeURIComponent(config.membersSheetGid)}`;

const CACHE_TTL_MS = 5 * 60 * 1000;

type Cache = { name: string; fetchedAt: number };
let cache: Cache | null = null;
let inflight: Promise<string> | null = null;

export type MembersGateChallenge = {
  id: string;
  question: string;
  answerLabel: string;
};

/** Catalog of unlock questions. Add new entries here as more secrets are shared. */
export const MEMBERS_GATE_CHALLENGES: readonly MembersGateChallenge[] = [
  {
    id: "burn-night-chef",
    question: "Who is kitchen lead for burn night?",
    answerLabel: "Name",
  },
  {
    id: "phage-truck",
    question: "Where did Phage load up the truck before coming out to playa?",
    answerLabel: "Place",
  },
] as const;

const CHALLENGE_BY_ID = new Map(MEMBERS_GATE_CHALLENGES.map((c) => [c.id, c]));

export function getMembersGateChallenge(id: string): MembersGateChallenge | null {
  return CHALLENGE_BY_ID.get(id) ?? null;
}

/** Pick a random challenge to show on the members unlock dialog. */
export function pickMembersGateChallenge(): MembersGateChallenge {
  const list = MEMBERS_GATE_CHALLENGES;
  return list[Math.floor(Math.random() * list.length)]!;
}

/** Trim, lowercase, collapse internal whitespace. */
export function normalizeGateAnswer(raw: string): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Letters/digits only — for place names with spacing/punctuation variants. */
export function normalizeGateAnswerLoose(raw: string): string {
  return normalizeGateAnswer(raw).replace(/[^a-z0-9]/g, "");
}

/**
 * Case-insensitive; ignores leading/trailing spaces.
 * Accepts a full name when the sheet has a first name (or the reverse).
 */
export function gateAnswersMatch(given: string, expected: string): boolean {
  const a = normalizeGateAnswer(given);
  const e = normalizeGateAnswer(expected);
  if (!a || !e) return false;
  if (a === e) return true;
  if (a.startsWith(e + " ") || e.startsWith(a + " ")) return true;
  return false;
}

/** Map common misspellings of the current burn-night chef first name. */
function canonicalizeChefName(raw: string): string {
  return normalizeGateAnswer(raw)
    .split(" ")
    .map((tok) => (tok === "laden" ? "ladan" : tok))
    .join(" ");
}

/** Cloudberry + common misspellings / spacing (cloud berry, cloudbarry, …). */
export function matchesCloudberry(given: string): boolean {
  let n = normalizeGateAnswerLoose(given);
  if (!n) return false;
  if (n.startsWith("the")) n = n.slice(3);
  return /^cloud(berry|barry|bery|bary|berrie|barie)$/.test(n);
}

/** Minimal CSV parser that handles quoted newlines and commas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      // Skip completely empty trailing rows
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function findFridayColumn(header: string[]): number {
  return header.findIndex((h) => /\bfriday\b/i.test(h.trim()));
}

function isDinnerSectionLead(row: string[]): boolean {
  const lead = (row[0] || "").trim();
  return /^dinner$/i.test(lead);
}

function isHeadChefRole(row: string[]): boolean {
  const role = (row[1] || "").trim();
  // "Head Playa Chef [HOT]", "Head Chef", etc.
  return /\bhead\b/i.test(role) && /\bchef\b/i.test(role);
}

/** Extract Friday Dinner Head Playa Chef name from sheet CSV text. */
export function extractBurnNightChefFromCsv(csvText: string): string | null {
  const rows = parseCsv(csvText);
  if (!rows.length) return null;

  let fridayCol = -1;
  let headerRow = -1;
  for (let r = 0; r < Math.min(rows.length, 5); r++) {
    const col = findFridayColumn(rows[r]!);
    if (col >= 0) {
      fridayCol = col;
      headerRow = r;
      break;
    }
  }
  if (fridayCol < 0 || headerRow < 0) return null;

  let dinnerStart = -1;
  for (let r = headerRow + 1; r < rows.length; r++) {
    if (isDinnerSectionLead(rows[r]!)) {
      dinnerStart = r;
      break;
    }
  }

  const searchFrom = dinnerStart >= 0 ? dinnerStart + 1 : headerRow + 1;
  // Stay within Dinner until the next section lead (non-empty col 0) if we found Dinner.
  for (let r = searchFrom; r < rows.length; r++) {
    const row = rows[r]!;
    if (dinnerStart >= 0 && r > dinnerStart) {
      const lead = (row[0] || "").trim();
      if (lead && !/^dinner$/i.test(lead)) break;
    }
    if (!isHeadChefRole(row)) continue;
    const name = (row[fridayCol] || "").trim();
    if (name) return name;
  }

  // Fallback: any Head … Chef row with a Friday value
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r]!;
    if (!isHeadChefRole(row)) continue;
    const name = (row[fridayCol] || "").trim();
    if (name) return name;
  }

  return null;
}

async function fetchChefFromSheet(): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(SHEET_CSV_URL(), {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { Accept: "text/csv,*/*" },
    });
    if (!res.ok) {
      console.warn(`[members-gate] sheet export HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    if (/<!DOCTYPE html>/i.test(text) || /sign in/i.test(text.slice(0, 500))) {
      console.warn("[members-gate] sheet export returned HTML (not public?)");
      return null;
    }
    return extractBurnNightChefFromCsv(text);
  } catch (err) {
    console.warn("[members-gate] sheet fetch failed:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Expected burn-night chef: live sheet value when reachable, else configured fallback. */
export async function getMembersGateExpectedAnswer(): Promise<string> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.name;
  }
  if (!inflight) {
    inflight = (async () => {
      const fromSheet = await fetchChefFromSheet();
      const name = (fromSheet || config.membersPassword || "").trim();
      if (name) {
        cache = { name, fetchedAt: Date.now() };
      }
      return name || config.membersPassword;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function verifyBurnNightChef(given: string): Promise<boolean> {
  const expected = await getMembersGateExpectedAnswer();
  return gateAnswersMatch(canonicalizeChefName(given), canonicalizeChefName(expected));
}

/**
 * Verify an unlock answer for a specific challenge.
 * Unknown / missing challengeId falls back to checking every challenge (OR).
 */
export async function verifyMembersGateAnswer(
  given: string,
  challengeId?: string | null,
): Promise<boolean> {
  const id = String(challengeId || "").trim();
  if (id === "burn-night-chef") return verifyBurnNightChef(given);
  if (id === "phage-truck") return matchesCloudberry(given);

  if (id && !CHALLENGE_BY_ID.has(id)) return false;

  // Legacy / no id: accept any known secret.
  if (await verifyBurnNightChef(given)) return true;
  if (matchesCloudberry(given)) return true;
  return false;
}
