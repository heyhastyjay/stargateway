/**
 * Iowa Environmental Mesonet (IEM) radar tiles for Leaflet — same stack as dashbird.
 * @see https://mesonet.agron.iastate.edu/ogc/
 */

/** Default view radius (miles from camp). The playa is featureless at closer zooms. */
export const RADAR_RADIUS_MI = 40;
export const IEM_TILE_BASE = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0";
/** Esri World Imagery — satellite basemap (proxied via `/wx-tiles/sat`). */
export const ESRI_SAT_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const ESRI_SAT_ATTR =
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a> — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
/** @deprecated kept for older references; radar uses satellite now. */
export const CARTO_DARK_URL =
  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
export const CARTO_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
export const IEM_ATTR =
  'Radar &copy; <a href="https://mesonet.agron.iastate.edu/ogc/">Iowa Environmental Mesonet</a>';

const MIN_ZOOM = 5;
const DEFAULT_ZOOM = 8;
const MAX_ZOOM = 12;

export interface IemRadarFrame {
  id: string;
  time: number;
  label: string;
  isCurrent?: boolean;
  urlTemplate: string;
}

export interface IemRadarPayload {
  provider: "iem";
  layer: "mrms";
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
  frames: IemRadarFrame[];
  mapPageUrl: string;
}

/** Round UTC time down to even minute (MRMS archive cadence). */
function floorEvenUtcMinute(d: Date): Date {
  const t = new Date(d.getTime());
  t.setUTCSeconds(0, 0);
  if (t.getUTCMinutes() % 2 === 1) {
    t.setUTCMinutes(t.getUTCMinutes() - 1);
  }
  return t;
}

export function formatRadarLocalTime(d: Date, timeZone: string): string {
  try {
    return d.toLocaleTimeString("en-US", {
      timeZone: timeZone || "America/Los_Angeles",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }
}

export function externalRadarMapUrl(lat: number, lon: number, zoom = 8): string {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return "https://radar.weather.gov/";
  const z = Math.min(12, Math.max(5, Math.round(Number(zoom) || 8)));
  return `https://radar.weather.gov/?center=${la.toFixed(4)},${lo.toFixed(4)}&zoom=${z}`;
}

/** Sanitize IEM layer id for URL path segments. */
export function sanitizeIemLayerId(layerId: string): string | null {
  const safe = String(layerId).replace(/[^a-zA-Z0-9:_-]/g, "");
  return safe || null;
}

export function iemTileUrlTemplate(layerId: string): string {
  const safe = sanitizeIemLayerId(layerId);
  if (!safe) throw new Error("bad_layer");
  return `${IEM_TILE_BASE}/${safe}/{z}/{x}/{y}.png`;
}

/**
 * Portal-relative templates so captive clients only talk to the paywall host.
 * Upstream fetches are proxied by `/wx-tiles/*`.
 */
export function portalBasemapUrlTemplate(): string {
  return "/wx-tiles/sat/{z}/{x}/{y}.jpg";
}

export function portalIemTileUrlTemplate(layerId: string): string {
  const safe = sanitizeIemLayerId(layerId);
  if (!safe) throw new Error("bad_layer");
  return `/wx-tiles/iem/${encodeURIComponent(safe)}/{z}/{x}/{y}.png`;
}

/** Past-hour MRMS SeamlessHSR frames (archived) + current q2-hsr. */
export function buildMrmsFrameList(
  now = new Date(),
  timeZone = "America/Los_Angeles",
): Array<{ id: string; time: number; label: string; isCurrent?: boolean }> {
  const latestArchive = floorEvenUtcMinute(now);
  latestArchive.setUTCMinutes(latestArchive.getUTCMinutes() - 4);
  if (latestArchive.getUTCMinutes() % 2 === 1) {
    latestArchive.setUTCMinutes(latestArchive.getUTCMinutes() - 1);
  }

  const frames: Array<{ id: string; time: number; label: string; isCurrent?: boolean }> = [];
  for (let minsAgo = 55; minsAgo >= 5; minsAgo -= 5) {
    const t = new Date(latestArchive.getTime() - minsAgo * 60_000);
    const aligned = floorEvenUtcMinute(t);
    const stamp =
      String(aligned.getUTCFullYear()) +
      String(aligned.getUTCMonth() + 1).padStart(2, "0") +
      String(aligned.getUTCDate()).padStart(2, "0") +
      String(aligned.getUTCHours()).padStart(2, "0") +
      String(aligned.getUTCMinutes()).padStart(2, "0");
    frames.push({
      id: `mrms::lcref-${stamp}`,
      time: Math.floor(aligned.getTime() / 1000),
      label: formatRadarLocalTime(aligned, timeZone),
    });
  }

  frames.push({
    id: "q2-hsr",
    time: Math.floor(now.getTime() / 1000),
    label: "now",
    isCurrent: true,
  });

  return frames;
}

export function buildIemRadarPayload(
  lat: number,
  lon: number,
  radiusMi = RADAR_RADIUS_MI,
  timeZone?: string,
): IemRadarPayload {
  const radius = Number.isFinite(radiusMi) && radiusMi > 0 ? radiusMi : RADAR_RADIUS_MI;
  const diameterMi = radius * 2;
  const zoom = DEFAULT_ZOOM;
  const tz =
    (typeof timeZone === "string" && timeZone.trim()) ||
    "America/Los_Angeles";
  const frames = buildMrmsFrameList(new Date(), tz);
  const mapPageUrl = externalRadarMapUrl(lat, lon, zoom);

  return {
    provider: "iem",
    layer: "mrms",
    layerLabel: "MRMS SeamlessHSR",
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
    radarAttribution: IEM_ATTR,
    opacity: 0.68,
    frameMs: 0,
    blendMs: 220,
    frames: frames.map((f) => ({
      id: f.id,
      time: f.time,
      label: f.label,
      isCurrent: Boolean(f.isCurrent),
      urlTemplate: portalIemTileUrlTemplate(f.id),
    })),
    mapPageUrl,
  };
}
