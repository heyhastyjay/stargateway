/** Black Rock City / playa weather via Open-Meteo hourly + BRC Dashboard text. */

import { buildIemRadarPayload, type IemRadarPayload } from "./weather-radar-iem.js";
import { buildLibreWxrRadarPayload, type RadarPayload } from "./weather-radar.js";

export { RADAR_RADIUS_MI } from "./weather-radar-iem.js";

export interface HourlyPoint {
  /** Local ISO hour start, e.g. 2026-08-18T17:00 */
  time: string;
  temperatureF: number;
  precipIn: number;
  precipProb: number;
  windMph: number;
  gustMph: number;
  /** Meteorological degrees: wind FROM this direction (0=N, 90=E). */
  windDirDeg: number;
  uvIndex: number;
  /** WMO weather interpretation code (Open-Meteo). */
  weatherCode: number;
  /** PM2.5 US AQI (Open-Meteo CAMS concentration, EPA breakpoints). */
  usAqi?: number | null;
}

export interface BrcAstro {
  /** Local calendar date YYYY-MM-DD */
  date: string;
  sunrise: string | null;
  sunset: string | null;
  moonrise: string | null;
  moonset: string | null;
  /** Lunation fraction: 0 = new, 0.5 = full (Open-Meteo). */
  moonPhase: number;
  /** Dominant daily WMO weather code. */
  weatherCode: number;
}

export interface BrcDashboard {
  paragraphs: string[];
  modified: string | null;
  error?: string;
}

export interface BrcWeather {
  updated: string | null;
  /** Rolling next 24 hours starting at the current local hour. */
  hours: HourlyPoint[];
  /** Next upcoming sun / moon event times + today's phase (Black Rock City). */
  astro: BrcAstro | null;
  /** Local YYYY-MM-DD of this calendar month's full moon, when known. */
  fullMoonDate: string | null;
  error?: string;
  dashboard: BrcDashboard;
}

/** Dashbird weather-polygon buckets → `/icons/weather/{name}.png`. */
export type WeatherIconKind =
  | "clear"
  | "partly"
  | "cloudy"
  | "fog"
  | "rain"
  | "snow"
  | "storm";

export function classifyWeatherIcon(code: number): WeatherIconKind {
  const c = Number(code);
  if (c === 0 || c === 1) return "clear";
  if (c === 2) return "partly";
  if (c === 3) return "cloudy";
  if (c === 45 || c === 48) return "fog";
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return "rain";
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
  if (c >= 95) return "storm";
  return "partly";
}

export const MOON_PHASE_LABELS = [
  "New moon",
  "Waxing crescent",
  "First quarter",
  "Waxing gibbous",
  "Full moon",
  "Waning gibbous",
  "Last quarter",
  "Waning crescent",
] as const;

/**
 * Map lunation fraction (0 = new, 0.5 = full) → `phase-{n}.png` (0…7).
 * Bins are centered on the eight named phases so the icon snaps to the
 * nearest phase and advances as Open-Meteo’s daily moon_phase moves.
 */
export function moonPhaseIndex8(phase: number): number {
  let p = Number(phase);
  if (!Number.isFinite(p)) p = 0;
  p = p % 1;
  if (p < 0) p += 1;
  return Math.round(p * 8) % 8;
}

/** Mean synodic month (days). */
const SYNODIC_MONTH = 29.530588853;
/** Accurate full moon: 2026-08-28 04:18 UTC (Sturgeon Moon). */
const KNOWN_FULL_MOON_MS = Date.UTC(2026, 7, 28, 4, 18, 0);

function localDateKeyFromInstant(ms: number, timeZone = TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function distanceToFull(phase: number): number {
  let p = Number(phase);
  if (!Number.isFinite(p)) p = 0;
  p = ((p % 1) + 1) % 1;
  return Math.abs(p - 0.5);
}

/** Pick the day in `monthPrefix` (YYYY-MM) whose moon_phase is nearest full. */
export function pickFullMoonDate(
  daily: BrcAstro[],
  monthPrefix: string,
): string | null {
  let best: { date: string; dist: number } | null = null;
  for (const d of daily) {
    if (!d.date.startsWith(monthPrefix)) continue;
    const dist = distanceToFull(d.moonPhase);
    if (!best || dist < best.dist) best = { date: d.date, dist };
  }
  // Require near-full (within ~1.5 days of phase space ≈ 0.05)
  if (best && best.dist <= 0.05) return best.date;
  return null;
}

/**
 * Local calendar date of the full moon falling in the same month as `now`.
 * Prefers Open-Meteo daily phases when available; otherwise synodic estimate.
 */
export function fullMoonDateThisMonth(
  daily: BrcAstro[] = [],
  now = new Date(),
  timeZone = TIMEZONE,
): string | null {
  const todayKey = currentLocalDateKey(now);
  const monthPrefix = todayKey.slice(0, 7);
  const fromApi = pickFullMoonDate(daily, monthPrefix);
  if (fromApi) return fromApi;

  const daysSince = (now.getTime() - KNOWN_FULL_MOON_MS) / 86_400_000;
  const n0 = Math.round(daysSince / SYNODIC_MONTH);
  for (let n = n0 - 2; n <= n0 + 2; n++) {
    const ms = KNOWN_FULL_MOON_MS + n * SYNODIC_MONTH * 86_400_000;
    const key = localDateKeyFromInstant(ms, timeZone);
    if (key.startsWith(monthPrefix)) return key;
  }
  return null;
}

/** e.g. "Friday, August 28" for a YYYY-MM-DD local date key. */
export function formatFullMoonDayLabel(dateKey: string, timeZone = TIMEZONE): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return dateKey;
  // Noon Pacific-ish so the calendar day is stable across US zones.
  const noonUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 20, 0, 0);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(noonUtc));
}

/** Production defaults: Black Rock City. Override with WEATHER_* env for radar review. */
const DEFAULT_LAT = 40.7869;
const DEFAULT_LON = -119.2066;
const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_RADAR_TITLE = "Black Rock City";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const BRC_LAT = envNumber("WEATHER_LAT", DEFAULT_LAT);
const BRC_LON = envNumber("WEATHER_LON", DEFAULT_LON);
const TIMEZONE = process.env.WEATHER_TZ?.trim() || DEFAULT_TIMEZONE;
export const WEATHER_SITE_LABEL = process.env.WEATHER_RADAR_TITLE?.trim() || DEFAULT_RADAR_TITLE;
const USER_AGENT = "(PhageCampStarlink/1.0; jaybird@phagecamp.local)";
const CACHE_MS = 15 * 60 * 1000;
export const BRC_DASHBOARD_HREF =
  "https://burningman.org/black-rock-city/preparation/brc-dashboard/";
const BRC_DASHBOARD_API =
  "https://burningman.org/wp-json/wp/v2/pages?slug=brc-dashboard&_fields=content,modified";

let cache: {
  at: number;
  /** Multi-day series used to re-slice the rolling window. */
  series: HourlyPoint[];
  daily: BrcAstro[];
  data: BrcWeather;
} | null = null;

/** Center used for forecast + Dashbird-style Leaflet radar. */
export function getWeatherCenter(): {
  lat: number;
  lon: number;
  timeZone: string;
  label: string;
} {
  return { lat: BRC_LAT, lon: BRC_LON, timeZone: TIMEZONE, label: WEATHER_SITE_LABEL };
}

/** Animated radar payload (LibreWXR smoothed tiles; IEM fallback). */
export async function getWeatherRadarMap(): Promise<{
  ok: true;
  show: true;
  provider: "librewxr" | "iem";
  geo: { lat: number; lon: number; displayName: string };
  radar: RadarPayload | IemRadarPayload;
  embed: { mapPageUrl: string; lat: number; lon: number; radiusMi: number };
}> {
  const { lat, lon, timeZone, label } = getWeatherCenter();
  let radar: RadarPayload | IemRadarPayload;
  let provider: "librewxr" | "iem" = "librewxr";
  try {
    radar = await buildLibreWxrRadarPayload(lat, lon, undefined, timeZone);
  } catch {
    radar = buildIemRadarPayload(lat, lon, undefined, timeZone);
    provider = "iem";
  }
  return {
    ok: true,
    show: true,
    provider,
    geo: { lat, lon, displayName: label },
    radar,
    embed: {
      mapPageUrl: radar.mapPageUrl,
      lat,
      lon,
      radiusMi: radar.radiusMi,
    },
  };
}

function decodeEntities(s: string): string {
  return s
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#8211;", "–")
    .replaceAll("&#8212;", "—")
    .replaceAll("&#8216;", "‘")
    .replaceAll("&#8217;", "’")
    .replaceAll("&#8220;", "“")
    .replaceAll("&#8221;", "”")
    .replaceAll(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replaceAll(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Pull plain-text paragraphs from BRC Dashboard WordPress HTML. */
export function extractDashboardParagraphs(html: string): string[] {
  const chunks = html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? [];
  const out: string[] = [];
  for (const chunk of chunks) {
    const text = decodeEntities(
      chunk
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+\n/g, "\n")
        .replace(/\n\s+/g, "\n")
        .replace(/[ \t]+/g, " ")
        .trim(),
    );
    if (text) out.push(text);
  }
  return out;
}

async function fetchBrcDashboard(): Promise<BrcDashboard> {
  try {
    const res = await fetch(BRC_DASHBOARD_API, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`BRC Dashboard API ${res.status}`);
    const pages = (await res.json()) as Array<{
      modified?: string;
      content?: { rendered?: string };
    }>;
    const page = pages[0];
    if (!page) throw new Error("BRC Dashboard page not found");
    const paragraphs = extractDashboardParagraphs(page.content?.rendered ?? "");
    if (!paragraphs.length) throw new Error("BRC Dashboard text empty");
    return { paragraphs, modified: page.modified ?? null };
  } catch (err) {
    return {
      paragraphs: [],
      modified: null,
      error: err instanceof Error ? err.message : "BRC Dashboard unavailable",
    };
  }
}

/** Current calendar hour in America/Los_Angeles as `YYYY-MM-DDTHH:00`. */
export function currentLocalHourKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:00`;
}

export function sliceRolling24(points: HourlyPoint[], now = new Date()): HourlyPoint[] {
  const key = currentLocalHourKey(now);
  let start = points.findIndex((p) => p.time >= key);
  if (start < 0) start = Math.max(0, points.length - 24);
  return points.slice(start, start + 24);
}

/** Local calendar date YYYY-MM-DD in America/Los_Angeles. */
export function currentLocalDateKey(now = new Date()): string {
  return currentLocalHourKey(now).slice(0, 10);
}

function emptyIso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length ? s : null;
}

/** Current local wall time as `YYYY-MM-DDTHH:MM` (same shape as Open-Meteo daily times). */
export function currentLocalMinuteKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  let hour = get("hour");
  if (hour === "24") hour = "00";
  hour = hour.padStart(2, "0");
  const minute = get("minute").padStart(2, "0");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${minute}`;
}

type AstroEventField = "sunrise" | "sunset" | "moonrise" | "moonset";

function astroMinuteKey(isoLocal: string | null): string | null {
  if (!isoLocal) return null;
  const key = isoLocal.trim().slice(0, 16);
  return key.length === 16 ? key : null;
}

/** First future occurrence of `field` at or after `nowMinuteKey` (local ISO minutes). */
export function nextAstroEventIso(
  daily: BrcAstro[],
  field: AstroEventField,
  nowMinuteKey: string,
): string | null {
  for (const day of daily) {
    const iso = day[field];
    const key = astroMinuteKey(iso);
    if (key && key >= nowMinuteKey) return iso;
  }
  return null;
}

/**
 * Today's moon phase / weather code, with each sun/moon clock set to the next
 * cycle that has not already passed (so noon shows tomorrow's sunrise).
 */
export function pickTodaysAstro(daily: BrcAstro[], now = new Date()): BrcAstro | null {
  if (!daily.length) return null;
  const todayKey = currentLocalDateKey(now);
  const today = daily.find((d) => d.date === todayKey) ?? daily[0]!;
  const nowMinuteKey = currentLocalMinuteKey(now);
  const ordered = daily.slice().sort((a, b) => a.date.localeCompare(b.date));
  return {
    date: today.date,
    weatherCode: today.weatherCode,
    moonPhase: today.moonPhase,
    sunrise: nextAstroEventIso(ordered, "sunrise", nowMinuteKey),
    sunset: nextAstroEventIso(ordered, "sunset", nowMinuteKey),
    moonrise: nextAstroEventIso(ordered, "moonrise", nowMinuteKey),
    moonset: nextAstroEventIso(ordered, "moonset", nowMinuteKey),
  };
}

async function fetchOpenMeteo(): Promise<{ series: HourlyPoint[]; daily: BrcAstro[] }> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(BRC_LAT));
  url.searchParams.set("longitude", String(BRC_LON));
  url.searchParams.set(
    "hourly",
    [
      "temperature_2m",
      "precipitation",
      "precipitation_probability",
      "wind_speed_10m",
      "wind_gusts_10m",
      "wind_direction_10m",
      "uv_index",
      "weather_code",
    ].join(","),
  );
  url.searchParams.set(
    "daily",
    ["sunrise", "sunset", "moonrise", "moonset", "moon_phase", "weather_code"].join(","),
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("timezone", TIMEZONE);
  // Enough daily moon_phase to find this month's full moon (hourly still sliced to 24h).
  const dayOfMonth = Number(currentLocalDateKey().slice(8, 10));
  url.searchParams.set("past_days", String(Math.min(92, Math.max(0, dayOfMonth - 1))));
  url.searchParams.set("forecast_days", "16");

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);

  const json = (await res.json()) as {
    hourly?: {
      time?: string[];
      temperature_2m?: Array<number | null>;
      precipitation?: Array<number | null>;
      precipitation_probability?: Array<number | null>;
      wind_speed_10m?: Array<number | null>;
      wind_gusts_10m?: Array<number | null>;
      wind_direction_10m?: Array<number | null>;
      uv_index?: Array<number | null>;
      weather_code?: Array<number | null>;
    };
    daily?: {
      time?: string[];
      sunrise?: Array<string | null>;
      sunset?: Array<string | null>;
      moonrise?: Array<string | null>;
      moonset?: Array<string | null>;
      moon_phase?: Array<number | null>;
      weather_code?: Array<number | null>;
    };
  };

  const h = json.hourly;
  const times = h?.time ?? [];
  if (!times.length) throw new Error("Open-Meteo hourly empty");

  const series = times.map((time, i) => ({
    time,
    temperatureF: Number(h?.temperature_2m?.[i] ?? 0),
    precipIn: Number(h?.precipitation?.[i] ?? 0),
    precipProb: Number(h?.precipitation_probability?.[i] ?? 0),
    windMph: Number(h?.wind_speed_10m?.[i] ?? 0),
    gustMph: Number(h?.wind_gusts_10m?.[i] ?? 0),
    windDirDeg: Number(h?.wind_direction_10m?.[i] ?? 0),
    uvIndex: Number(h?.uv_index?.[i] ?? 0),
    weatherCode: Number(h?.weather_code?.[i] ?? 0),
    usAqi: null,
  }));

  const d = json.daily;
  const days = d?.time ?? [];
  const daily: BrcAstro[] = days.map((date, i) => ({
    date,
    sunrise: emptyIso(d?.sunrise?.[i]),
    sunset: emptyIso(d?.sunset?.[i]),
    moonrise: emptyIso(d?.moonrise?.[i]),
    moonset: emptyIso(d?.moonset?.[i]),
    moonPhase: Number(d?.moon_phase?.[i] ?? 0),
    weatherCode: Number(d?.weather_code?.[i] ?? 0),
  }));

  return { series, daily };
}

async function fetchOpenMeteoUsAqi(): Promise<Map<string, number>> {
  const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  url.searchParams.set("latitude", String(BRC_LAT));
  url.searchParams.set("longitude", String(BRC_LON));
  // Hourly PM2.5 concentration — same pollutant as the AirNow chip.
  // Do not use consolidated us_aqi: it is often ozone and a 24h average.
  url.searchParams.set("hourly", "pm2_5");
  url.searchParams.set("timezone", TIMEZONE);
  url.searchParams.set("forecast_days", "3");

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Open-Meteo AQI ${res.status}`);

  const json = (await res.json()) as {
    hourly?: { time?: string[]; pm2_5?: Array<number | null> };
  };
  const times = json.hourly?.time ?? [];
  const values = json.hourly?.pm2_5 ?? [];
  const map = new Map<string, number>();
  for (let i = 0; i < times.length; i++) {
    const pm = Number(values[i]);
    if (!Number.isFinite(pm)) continue;
    map.set(times[i], pm25ToUsAqi(pm));
  }
  return map;
}

/** EPA PM2.5 (µg/m³, truncated to 0.1) → US AQI. */
export function pm25ToUsAqi(pm25: number): number {
  const c = Math.floor(Math.max(0, pm25) * 10) / 10;
  const breaks: Array<[number, number, number, number]> = [
    [0.0, 12.0, 0, 50],
    [12.1, 35.4, 51, 100],
    [35.5, 55.4, 101, 150],
    [55.5, 150.4, 151, 200],
    [150.5, 250.4, 201, 300],
    [250.5, 350.4, 301, 400],
    [350.5, 500.4, 401, 500],
  ];
  const row = breaks.find(([, chi]) => c <= chi) ?? breaks[breaks.length - 1];
  const [clo, chi, ilo, ihi] = row;
  if (chi <= clo) return ihi;
  return Math.round(((c - clo) / (chi - clo)) * (ihi - ilo) + ilo);
}

function withUsAqi(series: HourlyPoint[], aqiByTime: Map<string, number>): HourlyPoint[] {
  if (!aqiByTime.size) return series;
  return series.map((h) => {
    const aqi = aqiByTime.get(h.time);
    return aqi == null ? h : { ...h, usAqi: aqi };
  });
}

export async function getBrcWeather(force = false): Promise<BrcWeather> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) {
    const hours = sliceRolling24(cache.series);
    const astro = pickTodaysAstro(cache.daily);
    const fullMoonDate = fullMoonDateThisMonth(cache.daily);
    return { ...cache.data, hours, astro, fullMoonDate };
  }

  const dashboard = await fetchBrcDashboard();

  try {
    const [{ series, daily }, aqiByTime] = await Promise.all([
      fetchOpenMeteo(),
      fetchOpenMeteoUsAqi().catch(() => new Map<string, number>()),
    ]);
    const merged = withUsAqi(series, aqiByTime);
    const hours = sliceRolling24(merged);
    const astro = pickTodaysAstro(daily);
    const fullMoonDate = fullMoonDateThisMonth(daily);
    const data: BrcWeather = {
      updated: new Date().toISOString(),
      hours,
      astro,
      fullMoonDate,
      dashboard,
    };
    cache = { at: Date.now(), series: merged, daily, data };
    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Weather unavailable";
    const data: BrcWeather = {
      updated: null,
      hours: [],
      astro: null,
      fullMoonDate: fullMoonDateThisMonth([]),
      error: message,
      dashboard,
    };
    cache = { at: Date.now() - CACHE_MS + 60_000, series: [], daily: [], data };
    return data;
  }
}
