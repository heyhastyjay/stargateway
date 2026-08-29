/**
 * Smoothed precipitation radar via LibreWXR (RainViewer-compatible tiles).
 * @see https://api.librewxr.net/public/weather-maps.json
 * @see https://librewxr.net/
 */

import {
  formatRadarLocalTime,
  portalBasemapUrlTemplate,
  RADAR_RADIUS_MI,
  ESRI_SAT_ATTR,
  externalRadarMapUrl,
} from "./weather-radar-iem.js";

export { RADAR_RADIUS_MI, formatRadarLocalTime, portalBasemapUrlTemplate } from "./weather-radar-iem.js";

/** Public LibreWXR instance — MRMS-based, Gaussian-smoothed tiles, nowcast. */
export const LIBREWXR_MAPS_URL = "https://api.librewxr.net/public/weather-maps.json";
export const LIBREWXR_HOST = "https://api.librewxr.net";
export const LIBREWXR_ATTR =
  'Radar &copy; <a href="https://librewxr.net/">LibreWXR</a> (MRMS)';

const MIN_ZOOM = 5;
const DEFAULT_ZOOM = 8;
const MAX_ZOOM = 12;
/** Universal Blue + smooth edges + snow tint. */
const COLOR_SCHEME = 2;
const TILE_OPTIONS = "1_1";
const MAPS_CACHE_MS = 90_000;

export interface RadarFrame {
  id: string;
  time: number;
  label: string;
  isCurrent?: boolean;
  isNowcast?: boolean;
  urlTemplate: string;
}

export interface RadarPayload {
  provider: "librewxr";
  layer: "radar";
  layerLabel: string;
  lat: number;
  lon: number;
  zoom: number;
  minZoom: number;
  maxZoom: number;
  radiusMi: number;
  diameterMi: number;
  basemap: {
    url: string;
    attribution: string;
    subdomains: string;
  };
  radarAttribution: string;
  opacity: number;
  frameMs: number;
  blendMs: number;
  frames: RadarFrame[];
  mapPageUrl: string;
}

interface MapsJson {
  version?: string;
  generated?: number;
  host?: string;
  radar?: {
    past?: Array<{ time: number; path: string }>;
    nowcast?: Array<{ time: number; path: string }>;
  };
}

let mapsCache: { at: number; data: MapsJson } | null = null;

export function portalRadarTileUrlTemplate(unixTime: number): string {
  const t = Math.floor(Number(unixTime));
  if (!Number.isFinite(t) || t <= 0) throw new Error("bad_radar_time");
  return `/wx-tiles/radar/${t}/256/{z}/{x}/{y}.png`;
}

export function librewxrUpstreamTileUrl(unixTime: number, z: number, x: number, y: number): string {
  const t = Math.floor(Number(unixTime));
  return `${LIBREWXR_HOST}/v2/radar/${t}/256/${z}/${x}/${y}/${COLOR_SCHEME}/${TILE_OPTIONS}.png`;
}

export async function fetchLibreWxrMaps(now = Date.now()): Promise<MapsJson> {
  if (mapsCache && now - mapsCache.at < MAPS_CACHE_MS) {
    return mapsCache.data;
  }
  const res = await fetch(LIBREWXR_MAPS_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "(PhageCampStarlink/1.0; jaybird@phagecamp.local)",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`librewxr_maps_${res.status}`);
  const data = (await res.json()) as MapsJson;
  const past = data?.radar?.past;
  if (!Array.isArray(past) || past.length < 2) {
    throw new Error("librewxr_maps_empty");
  }
  mapsCache = { at: now, data };
  return data;
}

function frameLabel(
  unixTime: number,
  timeZone: string,
  kind: "past" | "nowcast",
  isLatestPast: boolean,
): string {
  if (kind === "nowcast") {
    const mins = Math.max(0, Math.round((unixTime * 1000 - Date.now()) / 60_000));
    return mins <= 0 ? "now" : `+${mins}m`;
  }
  if (isLatestPast) return "now";
  return formatRadarLocalTime(new Date(unixTime * 1000), timeZone);
}

export async function buildLibreWxrRadarPayload(
  lat: number,
  lon: number,
  radiusMi = RADAR_RADIUS_MI,
  timeZone?: string,
): Promise<RadarPayload> {
  const radius = Number.isFinite(radiusMi) && radiusMi > 0 ? radiusMi : RADAR_RADIUS_MI;
  const diameterMi = radius * 2;
  const zoom = DEFAULT_ZOOM;
  const tz =
    (typeof timeZone === "string" && timeZone.trim()) || "America/Los_Angeles";
  const maps = await fetchLibreWxrMaps();
  const past = maps.radar?.past ?? [];
  const nowcast = maps.radar?.nowcast ?? [];
  const latestPastTime = past[past.length - 1]?.time;

  const frames: RadarFrame[] = [];
  for (const f of past) {
    const t = Number(f.time);
    if (!Number.isFinite(t) || t <= 0) continue;
    frames.push({
      id: `radar-${t}`,
      time: t,
      label: frameLabel(t, tz, "past", t === latestPastTime),
      isCurrent: t === latestPastTime,
      urlTemplate: portalRadarTileUrlTemplate(t),
    });
  }
  for (const f of nowcast) {
    const t = Number(f.time);
    if (!Number.isFinite(t) || t <= 0) continue;
    frames.push({
      id: `radar-fcst-${t}`,
      time: t,
      label: frameLabel(t, tz, "nowcast", false),
      isNowcast: true,
      urlTemplate: portalRadarTileUrlTemplate(t),
    });
  }

  if (frames.length < 2) throw new Error("librewxr_frames_empty");

  return {
    provider: "librewxr",
    layer: "radar",
    layerLabel: "MRMS smoothed",
    lat,
    lon,
    zoom,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    radiusMi: radius,
    diameterMi,
    basemap: {
      url: portalBasemapUrlTemplate(),
      attribution: ESRI_SAT_ATTR,
      subdomains: "",
    },
    radarAttribution: LIBREWXR_ATTR,
    opacity: 0.72,
    /** Unused hold — the client runs a continuous crossfade. */
    frameMs: 0,
    /** Milliseconds per frame; the whole interval is a blend. */
    blendMs: 220,
    frames,
    mapPageUrl: externalRadarMapUrl(lat, lon, zoom),
  };
}
