/**
 * Nearby wildfire / smoke / AQI for the weather radar map.
 * Sources: USFS AirFire near-me (PurpleAir + AirNow + Clarity), NIFC WFIGS
 * (points + perimeters), BlueSky Canada FireSmoke (hourly ground PM2.5 images).
 */

import { getWeatherCenter, pm25ToUsAqi } from "./weather.js";

const USER_AGENT = "(PhageCampStarlink/1.0; jaybird@phagecamp.local)";
const CACHE_MS = 5 * 60 * 1000;
/** Search radius around the weather center (degrees ≈ 70 mi per degree lat). */
const SEARCH_DEG = 1.6;

const AIRNOW_PM25 =
  "https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Air_Now_Current_Monitors_PM25/FeatureServer/0/query";
/** Fire and Smoke Map “near me” — PurpleAir (EPA-corrected) + AirNow + Clarity. */
const AIRFIRE_NEAR_ME = "https://near-me.airfire.org/near-me/";
const NEAR_ME_MAX_MI = 120;
const NEAR_ME_LIMIT = 25;
const MAX_READING_AGE_MIN = 180;
/** Gerlach–Cedarville Hwy PurpleAir — BRC proxy. Do not use Diablo Drive (126977). */
const PREFERRED_AQI_UNIT_ID = "68427";
const PREFERRED_AQI_SITE_NAME = "Gerlach–Cedarville Hwy";
const WFIGS_INCIDENTS =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query";
const WFIGS_PERIMETERS =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query";
const FIRESMOKE_IMAGE_BASE = "https://firesmoke.ca/forecasts/current/images";

/** FireSmoke hourly PNG georeference (leaflet-forecast.js). */
export const FIRESMOKE_BOUNDS: [[number, number], [number, number]] = [
  [32, -160],
  [70, -52],
];

export type AqiCategory =
  | "Good"
  | "Moderate"
  | "Unhealthy for sensitive groups"
  | "Unhealthy"
  | "Very unhealthy"
  | "Hazardous";

export interface AirQuality {
  aqi: number;
  category: AqiCategory;
  pm25: number;
  siteName: string;
  observedAt: string | null;
  distanceMiles?: number;
  direction?: string;
  source?: string;
}

export interface WildfirePoint {
  name: string;
  lat: number;
  lon: number;
  acres: number | null;
  contained: number | null;
  behavior: string | null;
}

export type GeoFc = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: unknown;
    properties: Record<string, unknown> | null;
  }>;
};

export interface SmokeFrame {
  /** Unix seconds at the start of the UTC hour this PNG represents. */
  time: number;
  hour: string;
  url: string;
}

export interface WildfireHazards {
  air: AirQuality | null;
  fires: WildfirePoint[];
  perimeters: GeoFc;
  smokeFrames: SmokeFrame[];
  smokeBounds: [[number, number], [number, number]];
  smokeOpacity: number;
  watchDutyUrl: string;
  updated: string;
  error?: string;
}

let hazardsCache: { at: number; hourKey: string; data: WildfireHazards } | null = null;
let airCache: { at: number; data: AirQuality | null } | null = null;
let smokeHourCache = new Map<string, { bytes: Buffer; contentType: string; at: number }>();

export function aqiCategory(aqi: number): AqiCategory {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for sensitive groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very unhealthy";
  return "Hazardous";
}

export function aqiBannerColor(category: AqiCategory): string {
  switch (category) {
    case "Good":
      return "#3FA266";
    case "Moderate":
      return "#f0b429";
    case "Unhealthy for sensitive groups":
      return "#ff8c42";
    case "Unhealthy":
      return "#fc6b83";
    case "Very unhealthy":
      return "#9b59b6";
    case "Hazardous":
      return "#c41e3a";
  }
}

export function watchDutyMapUrl(lat: number, lon: number, zoom = 10): string {
  const z = Math.min(12, Math.max(6, Math.round(zoom)));
  return `https://app.watchduty.org/?lat=${lat.toFixed(4)}&lng=${lon.toFixed(4)}&zoom=${z}`;
}

function envelope(lat: number, lon: number, deg = SEARCH_DEG): string {
  return `${lon - deg},${lat - deg},${lon + deg},${lat + deg}`;
}

function emptyFc(): GeoFc {
  return { type: "FeatureCollection", features: [] };
}

function haversineMi(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

async function fetchJson(url: string, timeoutMs = 12_000): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json();
}

interface NearMePoint {
  unit_id?: string;
  lat?: number;
  lng?: number;
  site_name?: string;
  utc_ts?: string;
  local_ts?: string;
  raw_pm25?: number;
  corrected_pm25?: number;
  nowcast?: number;
  aqi?: number;
  status?: number;
  latency_mins?: number;
  distanceMiles?: number;
  direction?: string;
  source?: string;
}

function asPoints(raw: unknown): NearMePoint[] {
  return Array.isArray(raw) ? (raw as NearMePoint[]) : [];
}

function readingAgeMin(p: NearMePoint): number | null {
  const latency = Number(p.latency_mins);
  if (Number.isFinite(latency) && latency >= 0) return latency;
  if (typeof p.utc_ts === "string" && p.utc_ts.trim()) {
    const ms = Date.parse(p.utc_ts);
    if (Number.isFinite(ms)) return Math.max(0, (Date.now() - ms) / 60_000);
  }
  return null;
}

function pointPm25(p: NearMePoint): number | null {
  for (const v of [p.nowcast, p.corrected_pm25, p.raw_pm25]) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function pointToAir(p: NearMePoint, originLat: number, originLon: number): AirQuality | null {
  if (p.status != null && Number(p.status) !== 0) return null;
  const lat = Number(p.lat);
  const lon = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const age = readingAgeMin(p);
  if (age != null && age > MAX_READING_AGE_MIN) return null;
  const pm = pointPm25(p);
  const givenAqi = Number(p.aqi);
  const aqi = Number.isFinite(givenAqi)
    ? Math.round(givenAqi)
    : pm != null
      ? pm25ToUsAqi(pm)
      : NaN;
  if (!Number.isFinite(aqi)) return null;
  const dist = haversineMi(originLat, originLon, lat, lon);
  const named = String(p.site_name ?? "").trim();
  const source = String(p.source ?? "").trim() || "sensor";
  const observedAt =
    typeof p.local_ts === "string" && p.local_ts.trim()
      ? p.local_ts.trim()
      : typeof p.utc_ts === "string" && p.utc_ts.trim()
        ? p.utc_ts.trim()
        : null;
  return {
    aqi,
    category: aqiCategory(aqi),
    pm25: pm ?? 0,
    siteName: named || source,
    observedAt,
    distanceMiles: dist,
    direction: String(p.direction ?? "").trim() || undefined,
    source,
  };
}

function nearMeUnitId(p: NearMePoint): string {
  return String(p.unit_id ?? "").trim();
}

export async function fetchAirFireNearMe(lat: number, lon: number): Promise<AirQuality | null> {
  const url =
    `${AIRFIRE_NEAR_ME}?lat=${encodeURIComponent(String(lat))}` +
    `&lng=${encodeURIComponent(String(lon))}` +
    `&maxDistanceMiles=${NEAR_ME_MAX_MI}&limit=${NEAR_ME_LIMIT}`;
  const json = (await fetchJson(url, 10_000)) as {
    purpleAir?: unknown;
    aqMonitors?: unknown;
    clarity?: unknown;
  };
  const tagged: NearMePoint[] = [
    ...asPoints(json.purpleAir).map((p) => ({ ...p, source: p.source || "PurpleAir" })),
    ...asPoints(json.clarity).map((p) => ({ ...p, source: p.source || "Clarity" })),
    ...asPoints(json.aqMonitors).map((p) => ({ ...p, source: p.source || "AirNow" })),
  ];
  const preferred = tagged.find((p) => nearMeUnitId(p) === PREFERRED_AQI_UNIT_ID);
  if (!preferred) return null;
  const air = pointToAir(preferred, lat, lon);
  if (!air) return null;
  return { ...air, siteName: PREFERRED_AQI_SITE_NAME, source: "PurpleAir" };
}

export async function fetchAirNow(lat: number, lon: number): Promise<AirQuality | null> {
  const geom = envelope(lat, lon);
  const url =
    `${AIRNOW_PM25}?where=${encodeURIComponent("Status='Active'")}` +
    `&geometry=${encodeURIComponent(geom)}&geometryType=esriGeometryEnvelope` +
    `&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    `&outFields=SiteName,PM25,PM25_AQI,ValidTime,LocalTimeString` +
    `&returnGeometry=true&outSR=4326&resultRecordCount=25&f=json`;
  const json = (await fetchJson(url)) as {
    features?: Array<{
      attributes?: {
        SiteName?: string;
        PM25?: number;
        PM25_AQI?: number;
        ValidTime?: number;
        LocalTimeString?: string;
      };
      geometry?: { x?: number; y?: number };
    }>;
  };
  const feats = json.features ?? [];
  if (!feats.length) return null;
  let best = feats[0];
  let bestD = Infinity;
  for (const f of feats) {
    const x = Number(f.geometry?.x);
    const y = Number(f.geometry?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const d = haversineMi(lat, lon, y, x);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  const a = best.attributes ?? {};
  const aqi = Number(a.PM25_AQI);
  if (!Number.isFinite(aqi)) return null;
  const observedAt =
    typeof a.LocalTimeString === "string" && a.LocalTimeString.trim()
      ? a.LocalTimeString.trim()
      : typeof a.ValidTime === "number"
        ? new Date(a.ValidTime).toISOString()
        : null;
  return {
    aqi: Math.round(aqi),
    category: aqiCategory(aqi),
    pm25: Number(a.PM25) || 0,
    siteName: String(a.SiteName || "AirNow").trim() || "AirNow",
    observedAt,
    distanceMiles: Number.isFinite(bestD) && bestD < Infinity ? bestD : undefined,
    source: "AirNow",
  };
}

export async function getAirQuality(force = false): Promise<AirQuality | null> {
  if (!force && airCache && Date.now() - airCache.at < CACHE_MS) return airCache.data;
  const { lat, lon } = getWeatherCenter();
  try {
    const data =
      (await fetchAirFireNearMe(lat, lon).catch(() => null)) ?? (await fetchAirNow(lat, lon));
    airCache = { at: Date.now(), data };
    return data;
  } catch {
    return airCache?.data ?? null;
  }
}

async function fetchIncidents(lat: number, lon: number): Promise<WildfirePoint[]> {
  const geom = envelope(lat, lon);
  const fields = [
    "IncidentName",
    "IncidentSize",
    "PercentContained",
    "FireBehaviorGeneral",
    "IncidentTypeCategory",
  ].join(",");
  const url =
    `${WFIGS_INCIDENTS}?where=1%3D1` +
    `&geometry=${encodeURIComponent(geom)}&geometryType=esriGeometryEnvelope` +
    `&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    `&outFields=${encodeURIComponent(fields)}` +
    `&returnGeometry=true&outSR=4326&resultRecordCount=40&f=json`;
  const json = (await fetchJson(url)) as {
    features?: Array<{
      attributes?: Record<string, unknown>;
      geometry?: { x?: number; y?: number };
    }>;
  };
  const out: WildfirePoint[] = [];
  for (const f of json.features ?? []) {
    const a = f.attributes ?? {};
    const kind = String(a.IncidentTypeCategory ?? "WF");
    if (kind && kind !== "WF") continue;
    const x = Number(f.geometry?.x);
    const y = Number(f.geometry?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const name = String(a.IncidentName ?? "").trim();
    if (!name) continue;
    const acres = Number(a.IncidentSize);
    const contained = Number(a.PercentContained);
    out.push({
      name,
      lat: y,
      lon: x,
      acres: Number.isFinite(acres) ? acres : null,
      contained: Number.isFinite(contained) ? contained : null,
      behavior: a.FireBehaviorGeneral ? String(a.FireBehaviorGeneral) : null,
    });
  }
  out.sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0));
  return out.filter((f) => (f.acres ?? 0) >= 50).slice(0, 12);
}

async function fetchPerimeters(lat: number, lon: number): Promise<GeoFc> {
  const geom = envelope(lat, lon);
  const url =
    `${WFIGS_PERIMETERS}?where=1%3D1` +
    `&geometry=${encodeURIComponent(geom)}&geometryType=esriGeometryEnvelope` +
    `&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    `&outFields=poly_IncidentName,poly_GISAcres,attr_PercentContained` +
    `&returnGeometry=true&outSR=4326&geometryPrecision=4&resultRecordCount=16&f=geojson`;
  const json = (await fetchJson(url, 15_000)) as GeoFc;
  if (json?.type !== "FeatureCollection" || !Array.isArray(json.features)) return emptyFc();
  return {
    type: "FeatureCollection",
    features: json.features.slice(0, 16).map((feat) => {
      const p = (feat.properties ?? {}) as Record<string, unknown>;
      return {
        type: "Feature" as const,
        geometry: feat.geometry,
        properties: {
          name: String(p.poly_IncidentName ?? p.attr_IncidentName ?? "Fire"),
          acres: p.poly_GISAcres ?? null,
          contained: p.attr_PercentContained ?? null,
        },
      };
    }),
  };
}

function utcHourStamp(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${y}${m}${day}${h}00`;
}

/** Parse FireSmoke `YYYYMMDDHH00` to unix seconds, or null if out of range / invalid. */
export function parseFiresmokeHour(hour: string): number | null {
  if (!/^\d{12}$/.test(hour)) return null;
  const y = Number(hour.slice(0, 4));
  const mo = Number(hour.slice(4, 6));
  const d = Number(hour.slice(6, 8));
  const h = Number(hour.slice(8, 10));
  const min = Number(hour.slice(10, 12));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || min !== 0) return null;
  const ms = Date.UTC(y, mo - 1, d, h, 0, 0);
  const now = Date.now();
  if (ms < now - 48 * 3600_000 || ms > now + 72 * 3600_000) return null;
  return Math.floor(ms / 1000);
}

export async function fetchFiresmokePngAt(
  hour: string,
): Promise<{ bytes: Buffer; contentType: string; hour: string } | null> {
  if (parseFiresmokeHour(hour) == null) return null;
  const hit = smokeHourCache.get(hour);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit, hour };
  try {
    const res = await fetch(`${FIRESMOKE_IMAGE_BASE}/hourly_${hour}.png`, {
      headers: { "User-Agent": USER_AGENT, Accept: "image/png" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 800) return null;
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    const rec = { bytes, contentType, at: Date.now() };
    smokeHourCache.set(hour, rec);
    return { ...rec, hour };
  } catch {
    return null;
  }
}

export async function fetchFiresmokePng(): Promise<{ bytes: Buffer; contentType: string; hour: string } | null> {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 8; i++) {
    const hour = utcHourStamp(new Date(now.getTime() - i * 3600_000));
    const png = await fetchFiresmokePngAt(hour);
    if (png) return png;
  }
  return null;
}

function radarHourKey(times: number[]): string {
  const hours = [...new Set(times.map((t) => Math.floor(Number(t) / 3600)))].filter(Number.isFinite).sort((a, b) => a - b);
  return hours.join(",");
}

async function fetchFiresmokeHours(radarTimes: number[]): Promise<SmokeFrame[]> {
  const times = radarTimes.filter((t) => Number.isFinite(t) && t > 0);
  const nowSec = Math.floor(Date.now() / 1000);
  const minT = times.length ? Math.min(...times) : nowSec - 3 * 3600;
  const maxT = times.length ? Math.max(...times) : nowSec + 2 * 3600;
  const hours: string[] = [];
  const start = Math.floor(minT / 3600) * 3600 - 3600;
  const end = Math.floor(maxT / 3600) * 3600 + 3600;
  for (let t = start; t <= end; t += 3600) {
    const hour = utcHourStamp(new Date(t * 1000));
    if (parseFiresmokeHour(hour) != null) hours.push(hour);
  }
  const found = await Promise.all(hours.map((hour) => fetchFiresmokePngAt(hour)));
  return found
    .filter((png): png is NonNullable<typeof png> => Boolean(png))
    .map((png) => ({
      hour: png.hour,
      time: parseFiresmokeHour(png.hour) ?? 0,
      url: `/wx-overlay/firesmoke/${png.hour}.png`,
    }))
    .filter((f) => f.time > 0)
    .sort((a, b) => a.time - b.time);
}

function pickWatchDuty(lat: number, lon: number, fires: WildfirePoint[]): string {
  const active = fires.filter((f) => (f.acres ?? 0) >= 500 && (f.contained ?? 100) < 95);
  const main = (active.length ? active : fires).sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0))[0];
  if (main) return watchDutyMapUrl(main.lat, main.lon, 10);
  return watchDutyMapUrl(lat, lon, 8);
}

export async function getWildfireHazards(force = false, radarTimes: number[] = []): Promise<WildfireHazards> {
  const hourKey = radarHourKey(radarTimes);
  if (!force && hazardsCache && hazardsCache.hourKey === hourKey && Date.now() - hazardsCache.at < CACHE_MS) {
    return hazardsCache.data;
  }
  const { lat, lon } = getWeatherCenter();
  const errors: string[] = [];

  const airP = (async () => {
    try {
      return await getAirQuality();
    } catch {
      errors.push("aqi");
      return null;
    }
  })();

  const firesP = fetchIncidents(lat, lon).catch((err) => {
    errors.push("fires");
    void err;
    return [] as WildfirePoint[];
  });

  const [air, fires, perimeters, smokeFrames] = await Promise.all([
    airP,
    firesP,
    fetchPerimeters(lat, lon).catch(() => {
      errors.push("perimeters");
      return emptyFc();
    }),
    fetchFiresmokeHours(radarTimes).catch(() => {
      errors.push("smoke-img");
      return [] as SmokeFrame[];
    }),
  ]);
  if (!smokeFrames.length) errors.push("smoke-img");

  const data: WildfireHazards = {
    air,
    fires,
    perimeters,
    smokeFrames,
    smokeBounds: FIRESMOKE_BOUNDS,
    smokeOpacity: 0.65,
    watchDutyUrl: pickWatchDuty(lat, lon, fires),
    updated: new Date().toISOString(),
    error: errors.length ? [...new Set(errors)].join(",") : undefined,
  };
  hazardsCache = { at: Date.now(), hourKey, data };
  return data;
}

