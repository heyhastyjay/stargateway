import type {
  AccessDraft,
  CampEvent,
  Device,
  EventsProfileState,
  Payment,
  Settings,
  SiteWhitelistEntry,
} from "./db.js";
import {
  displayEventDescription,
  eventIsHappening,
  eventSearchHaystack,
  formatDuration,
  formatEventWhen,
  liveOnlineMs,
  DONATION_TIERS,
  SITE_WHITELIST_VOTES_NEEDED,
  toPlayaDatetimeLocal,
} from "./db.js";
import { config } from "./config.js";
import { PERMANENT_WHITELIST_DOMAINS } from "./permanent-whitelist.js";
import {
  WEATHER_SITE_LABEL,
  classifyWeatherIcon,
  formatFullMoonDayLabel,
  getWeatherCenter,
  MOON_PHASE_LABELS,
  moonPhaseIndex8,
  type BrcAstro,
  type BrcWeather,
} from "./weather.js";
import {
  aqiBannerColor,
  aqiCategory,
  watchDutyMapUrl,
  type AirQuality,
} from "./wildfire.js";
import { BMIR_DIRECT_STREAM, BMIR_MAX_LISTEN_MS, BMIR_STREAM_PATH } from "./bmir.js";
import {
  DEFAULT_RESERVED_GB,
  formatGb,
  formatUpdatedAgo,
  type StarlinkDataOperatorView,
} from "./starlink-data.js";

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

/** Human label for quick-access cool-down remaining (e.g. "3 minutes"). */
function formatCooldownMinutes(ms: number): string {
  if (ms <= 0) return "0 minutes";
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function formatHourLabel(isoLocal: string): string {
  const hour = Number(isoLocal.slice(11, 13));
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  if (hour < 12) return `${hour}a`;
  return `${hour - 12}p`;
}

function polylinePoints(
  values: number[],
  xAt: (i: number) => number,
  yAt: (v: number) => number,
): string {
  return values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
}

function addCalendarDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  if (!y || !m || !d) return dateKey;
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function astroDayHint(isoLocal: string, todayKey: string): string | null {
  const eventDate = isoLocal.slice(0, 10);
  if (!eventDate || eventDate === todayKey) return null;
  if (eventDate === addCalendarDays(todayKey, 1)) return "tomorrow";
  const [y, m, d] = eventDate.split("-").map(Number);
  if (!y || !m || !d) return eventDate;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
}

function formatAstroClock(isoLocal: string | null): string {
  if (!isoLocal) return "—";
  const hour = Number(isoLocal.slice(11, 13));
  const minute = isoLocal.slice(14, 16);
  if (!Number.isFinite(hour) || !minute) return "—";
  const h12 = hour % 12 || 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${minute} ${ampm}`;
}

function renderAstroTime(isoLocal: string | null, todayKey: string): string {
  const time = formatAstroClock(isoLocal);
  const hint = isoLocal ? astroDayHint(isoLocal, todayKey) : null;
  const day = hint ? `<span class="wx-astro-day">${escapeHtml(hint)}</span>` : "";
  return `<span class="wx-astro-time">${time}</span>${day}`;
}

function renderWeatherConditionIcon(code: number): string {
  const kind = classifyWeatherIcon(code);
  return `<img class="wx-day-icon" src="/icons/weather/${kind}.png" alt="" width="72" height="72" decoding="async" />`;
}

function renderAstroRow(astro: BrcAstro | null, fullMoonDate: string | null = null): string {
  if (!astro) return "";
  const phaseIdx = moonPhaseIndex8(astro.moonPhase);
  const phaseLabel = MOON_PHASE_LABELS[phaseIdx] ?? "Moon";
  const fullMoonLine = fullMoonDate
    ? `<p class="wx-astro-fullmoon">Full moon on ${escapeHtml(formatFullMoonDayLabel(fullMoonDate))}</p>`
    : "";
  return `
    <div class="wx-astro">
      <div class="wx-astro-block">
        <img class="wx-astro-glyph wx-astro-glyph--sunset" src="/icons/weather/sunset-glyph.png" alt="" width="72" height="72" decoding="async" />
        <div class="wx-astro-pair">
          <div class="wx-astro-text">
            <span class="wx-astro-label">Sunrise</span>
            ${renderAstroTime(astro.sunrise, astro.date)}
          </div>
          <div class="wx-astro-text">
            <span class="wx-astro-label">Sunset</span>
            ${renderAstroTime(astro.sunset, astro.date)}
          </div>
        </div>
      </div>
      <div class="wx-astro-block">
        <img class="wx-astro-glyph wx-astro-glyph--moon" src="/assets/sky/moon/phase-${phaseIdx}.png?d=${encodeURIComponent(astro.date)}" alt="${escapeHtml(phaseLabel)}" width="72" height="72" decoding="async" title="${escapeHtml(phaseLabel)}" data-moon-phase="${astro.moonPhase}" data-moon-octant="${phaseIdx}" />
        <div class="wx-astro-pair">
          <div class="wx-astro-text">
            <span class="wx-astro-label">Moonrise</span>
            ${renderAstroTime(astro.moonrise, astro.date)}
          </div>
          <div class="wx-astro-text">
            <span class="wx-astro-label">Moonset</span>
            ${renderAstroTime(astro.moonset, astro.date)}
          </div>
        </div>
      </div>
      ${fullMoonLine}
    </div>`;
}

/** Rolling 24h SVG: temp / precip% / UV lines + wind arrows (direction = wind toward). */
function formatAirDistance(air: AirQuality): string | null {
  const d = Number(air.distanceMiles);
  if (!Number.isFinite(d) || d < 0) return null;
  const miles = d >= 10 ? String(Math.round(d)) : d.toFixed(1).replace(/\.0$/, "");
  const dir = air.direction ? ` ${air.direction}` : "";
  return `${miles} mi${dir}`;
}

function renderAqiChip(air: AirQuality | null | undefined): string {
  if (!air) return "";
  const color = aqiBannerColor(air.category);
  const shortCat =
    air.category === "Unhealthy for sensitive groups" ? "USG" : air.category;
  const dist = formatAirDistance(air);
  const title = [
    air.siteName,
    dist,
    air.source && air.source !== air.siteName ? air.source : null,
    air.observedAt,
    `PM2.5 ${air.pm25} µg/m³`,
  ]
    .filter(Boolean)
    .join(" · ");
  const loc = dist
    ? `<span class="wx-now-aqi-loc">${escapeHtml(dist)}</span>`
    : "";
  return `<div class="wx-now-aqi" title="${escapeHtml(title)}" style="border-color:${color};color:${color};background:${color}22">
      <span class="wx-now-aqi-num">AQI ${air.aqi}</span>
      <span class="wx-now-aqi-cat">${escapeHtml(shortCat)}</span>
      ${loc}
    </div>`;
}

/** Chart AQI: pin hour 0 to the AirNow chip; scale the CAMS PM2.5 forecast to that observation. */
function alignedHourlyAqi(
  hours: BrcWeather["hours"],
  air?: AirQuality | null,
): Array<number | null> {
  const raw = hours.map((h) =>
    h.usAqi != null && Number.isFinite(h.usAqi) ? Math.round(h.usAqi) : null,
  );
  const observed =
    air && Number.isFinite(air.aqi) ? Math.round(air.aqi) : null;
  if (observed == null) return raw;
  const nowForecast = raw[0];
  if (nowForecast == null) {
    return raw.map((v, i) => (i === 0 ? observed : v));
  }
  const scale = nowForecast > 0 ? observed / nowForecast : 1;
  return raw.map((v, i) => {
    if (i === 0) return observed;
    if (v == null) return null;
    return Math.max(0, Math.min(500, Math.round(v * scale)));
  });
}

function renderHourlyForecastChart(weather: BrcWeather, air?: AirQuality | null): string {
  const hours = weather.hours;
  if (hours.length < 2) return "";

  const W = 392;
  const chartTop = 16;
  const chartH = 90;
  const chartBottom = chartTop + chartH;
  const windY = chartBottom + 17;
  const sepY = windY + 18;
  const labelY = sepY + 10;
  const H = labelY + 8;
  const padL = 34;
  const padR = 34;
  const plotW = W - padL - padR;
  const n = hours.length;
  const xAt = (i: number) => padL + (i / (n - 1)) * plotW;

  const temps = hours.map((h) => h.temperatureF);
  const precip = hours.map((h) => h.precipProb);
  const uvs = hours.map((h) => h.uvIndex);

  const tMin = Math.min(...temps);
  const tMax = Math.max(...temps);
  const tPad = Math.max(2, (tMax - tMin) * 0.12);
  // Snap axis to °F multiples of 5 (e.g. 80° not 81°)
  const tempLo = Math.floor((tMin - tPad) / 5) * 5;
  const tempHi = Math.max(tempLo + 5, Math.ceil((tMax + tPad) / 5) * 5);
  const yTemp = (v: number) =>
    chartBottom - ((v - tempLo) / Math.max(1e-6, tempHi - tempLo)) * chartH;

  // Fixed scales so quiet days don't exaggerate noise
  const yPrecip = (v: number) => chartBottom - (Math.min(100, Math.max(0, v)) / 100) * chartH;
  const yUv = (v: number) => chartBottom - (Math.min(12, Math.max(0, v)) / 12) * chartH;

  const tempPts = polylinePoints(temps, xAt, yTemp);
  const precipPts = polylinePoints(precip, xAt, yPrecip);
  const uvPts = polylinePoints(uvs, xAt, yUv);

  const hourBands = hours
    .map((_, i) => {
      if (i % 2 !== 0) return "";
      const x0 = i === 0 ? padL : (xAt(i) + xAt(i - 1)) / 2;
      const x1 = i === n - 1 ? W - padR : (xAt(i) + xAt(i + 1)) / 2;
      return `<rect x="${x0.toFixed(1)}" y="${chartTop}" width="${(x1 - x0).toFixed(1)}" height="${(sepY - chartTop).toFixed(1)}" fill="rgba(232,238,247,0.035)" />`;
    })
    .join("");

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = chartTop + f * chartH;
      return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(232,238,247,0.08)" />`;
    })
    .join("");

  const midTemp = Math.round((tempLo + tempHi) / 10) * 5;
  const tempTicks = [tempLo, midTemp, tempHi]
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .map((v) => {
      const y = yTemp(v);
      return `<text class="wx-temp-tick" data-temp-f="${v}" x="${padL - 6}" y="${y + 3}" text-anchor="end" fill="#9db0c9" font-size="10">${v}°</text>`;
    })
    .join("");

  // Fixed 0–12 UV / 0–100% precip; show precip % only when rain chance is 8%+
  const showPrecipAxis = precip.some((p) => p >= 8);
  const rightTicks = (showPrecipAxis
    ? [0, 50, 100].map((v) => {
        const y = yPrecip(v);
        return `<text x="${W - padR + 6}" y="${y + 3}" text-anchor="start" fill="#3dd6c6" font-size="10">${v}%</text>`;
      })
    : [0, 6, 12].map((v) => {
        const y = yUv(v);
        return `<text x="${W - padR + 6}" y="${y + 3}" text-anchor="start" fill="#c084fc" font-size="10">${v}</text>`;
      })
  ).join("");

  const hourLabels = hours
    .map((h, i) => {
      if (i !== 0 && i !== n - 1 && i % 3 !== 0) return "";
      return `<text x="${xAt(i).toFixed(1)}" y="${labelY}" text-anchor="middle" fill="#9db0c9" font-size="10">${formatHourLabel(h.time)}</text>`;
    })
    .join("");

  // Wind FROM deg → SVG rotate so tip points where wind is blowing TOWARD (0° = north/up)
  const windMarks = hours
    .map((h, i) => {
      if (i % 2 !== 0 && i !== 0) return "";
      const x = xAt(i);
      const towardDeg = (h.windDirDeg + 180) % 360;
      const svgRot = towardDeg; // path points up (north) at rotate 0
      const gust = Math.round(Math.max(h.gustMph, h.windMph));
      return `
        <g transform="translate(${x.toFixed(1)},${windY})">
          <g transform="rotate(${svgRot.toFixed(0)})">
            <path d="M0,4 L0,-5 M-2.4,-1.8 L0,-5 L2.4,-1.8" fill="none" stroke="#e8eef7" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
          </g>
          <text y="12" text-anchor="middle" fill="#9db0c9" font-size="8">${gust}</text>
        </g>`;
    })
    .join("");

  const aqiSeries = alignedHourlyAqi(hours, air);
  const aqiVals = aqiSeries.filter((v): v is number => v != null && Number.isFinite(v));
  const showAqiBars = aqiVals.length > 0;
  const aqiMax = showAqiBars ? Math.max(...aqiVals) : 0;
  const aqiHi = Math.max(100, Math.ceil(aqiMax / 50) * 50);
  const yAqi = (v: number) =>
    chartBottom - (Math.min(aqiHi, Math.max(0, v)) / Math.max(1, aqiHi)) * chartH;
  const hourGap = n > 1 ? plotW / (n - 1) : plotW;
  const aqiBarW = Math.max(6, hourGap * 1.35);
  const aqiBars = showAqiBars
    ? hours
        .map((h, i) => {
          if (i % 2 !== 0) return "";
          const aqi = aqiSeries[i];
          if (aqi == null || !Number.isFinite(aqi)) return "";
          const x = xAt(i);
          const y = yAqi(aqi);
          const barH = Math.max(2, chartBottom - y);
          const color = aqiBannerColor(aqiCategory(aqi));
          const labelY = Math.max(10, y - 3);
          const cat = aqiCategory(aqi);
          // First bar is only the right half so it does not cross the y-axis.
          const barX = i === 0 ? x : x - aqiBarW / 2;
          const barW = i === 0 ? aqiBarW / 2 : aqiBarW;
          const labelX = i === 0 ? x + barW / 2 : x;
          return `
        <g class="wx-aqi-bar">
          <title>AQI ${Math.round(aqi)} · ${escapeHtml(cat)}</title>
          <rect x="${barX.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="1.4" fill="${color}" fill-opacity="0.34" />
          <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" fill="${color}" stroke="#0b1220" stroke-width="2.4" paint-order="stroke" font-size="8" font-weight="700">${Math.round(aqi)}</text>
        </g>`;
        })
        .join("")
    : "";

  const now = hours[0];
  const nowX = xAt(0);
  const dayCode = weather.astro?.weatherCode ?? now.weatherCode ?? 0;

  return `
    <div class="wx-now">
      <div class="wx-now-main">
        <span class="wx-now-temp" data-temp-f="${now.temperatureF}">${Math.round(now.temperatureF)}°F</span>
        <span class="wx-now-meta"><span class="wx-now-range" data-temp-hi-f="${tMax}" data-temp-lo-f="${tMin}">${Math.round(tMax)}°/${Math.round(tMin)}°</span> · precip ${Math.round(now.precipProb)}% · UV ${now.uvIndex.toFixed(1)}</span>
      </div>
      ${renderAqiChip(air)}
      <div class="wx-now-icon">${renderWeatherConditionIcon(dayCode)}</div>
    </div>
    <div class="wx-legend">
      <span><i class="wx-swatch" style="background:#f0b429"></i> <span class="wx-legend-temp">Temp °F</span></span>
      <span><i class="wx-swatch" style="background:#3dd6c6"></i> Precip %</span>
      <span><i class="wx-swatch" style="background:#c084fc"></i> UV</span>
      ${showAqiBars ? `<span><i class="wx-swatch wx-swatch-aqi"></i> AQI</span>` : ""}
    </div>
    <div class="wx-chart-wrap">
      <svg class="wx-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Next 24 hour forecast chart">
        ${hourBands}
        ${gridLines}
        ${tempTicks}
        ${rightTicks}
        <line x1="${nowX.toFixed(1)}" y1="${chartTop}" x2="${nowX.toFixed(1)}" y2="${chartBottom}" stroke="rgba(61,214,198,0.35)" stroke-dasharray="3 3" />
        ${aqiBars}
        <polyline fill="none" stroke="#3dd6c6" stroke-width="1.75" stroke-linejoin="round" points="${precipPts}" />
        <polyline fill="none" stroke="#c084fc" stroke-width="1.75" stroke-linejoin="round" points="${uvPts}" />
        <polyline fill="none" stroke="#f0b429" stroke-width="2.25" stroke-linejoin="round" points="${tempPts}" />
        <circle cx="${nowX.toFixed(1)}" cy="${yTemp(now.temperatureF).toFixed(1)}" r="3.5" fill="#f0b429" />
        ${windMarks}
        <line x1="${padL}" y1="${sepY}" x2="${(W - padR).toFixed(1)}" y2="${sepY}" stroke="rgba(232,238,247,0.2)" stroke-width="1" />
        ${hourLabels}
      </svg>
    </div>
    ${renderAstroRow(weather.astro, weather.fullMoonDate)}`;
}

function layout(title: string, body: string, opts?: { admin?: boolean }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0b1220" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Phage Camp" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/icons/app-icon.svg" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg0: #0b1220;
      --bg1: #142033;
      --ink: #e8eef7;
      --muted: #9db0c9;
      --accent: #3dd6c6;
      --accent2: #f0b429;
      --danger: #ff6b6b;
      --ok: #6bcf7f;
      --line: rgba(232,238,247,0.12);
      --card: rgba(20,32,51,0.72);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      color: var(--ink);
      background-color: var(--bg0);
      background-image:
        linear-gradient(160deg, rgba(11, 18, 32, 0.55), rgba(10, 22, 40, 0.62) 55%, rgba(8, 14, 24, 0.72)),
        url("/playa-bg.jpg");
      background-size: cover;
      background-position: center;
      background-attachment: fixed;
      background-repeat: no-repeat;
    }
    .data-ticker {
      display: none;
      position: sticky;
      top: 0;
      z-index: 50;
      overflow: hidden;
      border-bottom: 1px solid rgba(61, 214, 198, 0.35);
      background: rgba(6, 14, 24, 0.92);
      backdrop-filter: blur(10px);
      color: var(--accent);
      font-size: 0.82rem;
      font-weight: 650;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .data-ticker.is-on { display: block; }
    .data-ticker[data-tone="green"] {
      color: #06240f;
      background: #6bcf7f;
      border-bottom-color: #3da85a;
    }
    .data-ticker[data-tone="yellow"] {
      color: #2a2400;
      background: #f5e04a;
      border-bottom-color: #c9b40f;
    }
    .data-ticker[data-tone="amber"] {
      color: #2a1600;
      background: #f0a020;
      border-bottom-color: #c77a08;
    }
    .data-ticker[data-tone="red"] {
      color: #2a0707;
      background: #ff6b6b;
      border-bottom-color: #e25555;
    }
    .data-ticker-track {
      display: flex;
      gap: 3.5rem;
      width: max-content;
      padding: 0.42rem 0;
      animation: data-ticker-scroll 32s linear infinite;
    }
    .data-ticker-track span { white-space: nowrap; }
    @keyframes data-ticker-scroll {
      from { transform: translateX(0); }
      to { transform: translateX(-50%); }
    }
    @media (prefers-reduced-motion: reduce) {
      .data-ticker-track { animation: none; }
    }
    main {
      width: min(560px, calc(100% - 2rem));
      margin: 0 auto;
      padding: 2.5rem 0 3rem;
    }
    main.wide { width: min(960px, calc(100% - 2rem)); }
    h1 { font-size: 1.75rem; margin: 0 0 0.35rem; letter-spacing: -0.02em; }
    h2 { font-size: 1.1rem; margin: 1.75rem 0 0.75rem; }
    p { color: var(--muted); line-height: 1.5; }
    .brand {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--accent);
      margin-bottom: 0.75rem;
    }
    .panel {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 1.25rem 1.35rem;
      backdrop-filter: blur(8px);
      margin-top: 1rem;
    }
    .access-sub {
      padding: 1rem 0;
      border-top: 1px solid var(--line);
    }
    .access-sub:last-of-type {
      padding-bottom: 0;
    }
    .access-sub h3 {
      margin: 0 0 0.35rem;
      font-size: 1rem;
      font-weight: 650;
      color: var(--ink);
    }
    .price {
      font-size: 2.4rem;
      font-weight: 700;
      color: var(--ink);
      margin: 0.5rem 0;
    }
    .price span { font-size: 1rem; color: var(--muted); font-weight: 500; }
    [hidden] { display: none !important; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      width: 100%;
      border: 0;
      border-radius: 12px;
      padding: 0.9rem 1rem;
      font-size: 1rem;
      font-weight: 650;
      cursor: pointer;
      text-decoration: none;
      color: #06241f;
      background: linear-gradient(135deg, var(--accent), #2bb3a6);
      margin-top: 0.75rem;
    }
    .btn.secondary {
      color: var(--ink);
      background: transparent;
      border: 1px solid var(--line);
    }
    .btn.danger { background: linear-gradient(135deg, #ff7b7b, #e25555); color: #2a0707; }
    .btn.small { width: auto; padding: 0.45rem 0.75rem; font-size: 0.85rem; margin: 0; }
    .home-save-wrap { margin: 0.85rem 0 0; }
    .home-save-wrap .btn { margin-top: 0; }
    .home-save-hint { margin: 0.45rem 0 0; font-size: 0.82rem; }
    .home-save-url {
      display: block;
      margin: 0.35rem 0 0;
      font-size: 0.88rem;
      color: var(--accent);
      word-break: break-all;
    }
    body.is-standalone .home-save-wrap { display: none; }
    dialog.leave-dialog:not([open]) {
      display: none !important;
    }
    .leave-dialog {
      border: 1px solid rgba(240,180,41,0.45);
      border-radius: 16px;
      padding: 0;
      max-width: min(26rem, calc(100vw - 2rem));
      width: 100%;
      background: #1a1520;
      color: var(--ink);
      box-shadow: 0 18px 50px rgba(0,0,0,0.55);
    }
    .leave-dialog::backdrop {
      background: rgba(4, 8, 16, 0.72);
      backdrop-filter: blur(4px);
    }
    .leave-dialog-inner {
      padding: 1.25rem 1.35rem 1.35rem;
    }
    .leave-dialog-badge {
      display: inline-block;
      font-size: 0.72rem;
      font-weight: 750;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #2a1a00;
      background: linear-gradient(135deg, #f0b429, #e89a1a);
      border-radius: 8px;
      padding: 0.28rem 0.55rem;
      margin: 0 0 0.75rem;
    }
    .leave-dialog h2 {
      margin: 0 0 0.55rem;
      font-size: 1.15rem;
      color: var(--ink);
      line-height: 1.35;
    }
    .leave-dialog p {
      margin: 0 0 1rem;
      color: var(--muted);
    }
    .leave-dialog .btn { margin-top: 0.55rem; }
    .leave-dialog .btn:first-of-type { margin-top: 0; }
    .leave-dialog .btn.leave-stay {
      color: #041018;
      background: linear-gradient(135deg, #4db8ff, #2f8fff);
      border: 0;
    }
    .leave-dialog .btn.leave-confirm {
      color: #ff8a8a;
      background: transparent;
      border: 1.5px solid rgba(255, 107, 107, 0.7);
    }
    .meta { font-size: 0.85rem; color: var(--muted); word-break: break-all; }
    .ok { color: var(--ok); }
    .warn { color: var(--accent2); }
    .err { color: var(--danger); }
    label { display: block; font-size: 0.85rem; color: var(--muted); margin: 0.75rem 0 0.3rem; }
    input, textarea, select {
      width: 100%;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: rgba(0,0,0,0.25);
      color: var(--ink);
      padding: 0.7rem 0.8rem;
      font: inherit;
      color-scheme: dark;
    }
    .pay-method-field.is-disabled {
      opacity: 0.45;
      pointer-events: none;
    }
    .pay-method-field.is-disabled select {
      cursor: not-allowed;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.55rem 0.4rem; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; }
    .row-actions { display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .nav { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .nav a { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
    .pill {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 999px;
      border: 1px solid var(--line);
      font-size: 0.75rem;
      color: var(--muted);
    }
    .pill.allowed { color: var(--ok); border-color: rgba(107,207,127,0.35); }
    .pill.approved { color: var(--ok); border-color: rgba(107,207,127,0.35); }
    .pill.pending { color: var(--accent2); border-color: rgba(240,180,41,0.35); }
    .pill.blocked, .pill.revoked { color: var(--danger); border-color: rgba(255,107,107,0.35); }
    .goal-head {
      display: flex;
      justify-content: space-between;
      gap: 0.75rem;
      align-items: baseline;
      font-size: 0.9rem;
      margin-bottom: 0.55rem;
    }
    .goal-head strong { color: var(--ink); font-weight: 650; }
    .goal-track {
      height: 12px;
      border-radius: 999px;
      background: rgba(0,0,0,0.35);
      border: 1px solid var(--line);
      overflow: hidden;
    }
    .goal-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent2), var(--accent));
      min-width: 0;
      transition: width 0.35s ease;
    }
    .lede { font-size: 1.05rem; color: var(--ink); line-height: 1.45; margin: 0.35rem 0 0.75rem; }
    .access-intro {
      border-left: 3px solid var(--accent2);
      background: rgba(240, 180, 41, 0.07);
    }
    .access-intro .lede {
      font-size: 1.12rem;
      line-height: 1.5;
      margin: 0;
      font-weight: 450;
    }
    .access-intro .lede strong {
      color: #f5d27a;
      font-weight: 700;
    }
    .access-intro .access-note {
      margin: 0.7rem 0 0;
      font-size: 0.92rem;
    }
    .access-kicker {
      margin: 0 0 0.45rem;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      text-align: left;
      color: var(--muted);
    }
    .access-sub h3.access-tax {
      margin: 0;
      font-size: 1.12rem;
      font-weight: 700;
      color: var(--accent2);
    }
    .access-pay label {
      color: var(--ink);
      font-weight: 600;
    }
    .access-pay select,
    .access-pay input {
      border-color: rgba(240, 180, 41, 0.55);
      background: rgba(240, 180, 41, 0.1);
    }
    .btn.quiet {
      color: #7ec8ff;
      background: transparent;
      border: 1px solid #7ec8ff;
      border-radius: 8px;
      font-weight: 500;
      font-size: 0.88rem;
      line-height: 1.3;
      padding: 0.62rem 0.85rem;
      white-space: normal;
    }
    .btn.danger.ghost {
      background: transparent;
      color: var(--danger);
      border: 1px solid rgba(255, 107, 107, 0.45);
    }
    .pay-methods {
      display: grid;
      gap: 1rem;
      margin-top: 0.85rem;
    }
    .pay-method {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 1rem 1.05rem;
      background: rgba(0,0,0,0.18);
    }
    .pay-method h3 {
      margin: 0 0 0.25rem;
      font-size: 1.05rem;
      color: var(--ink);
    }
    .pay-method .handle { color: var(--accent); font-weight: 650; }
    .pay-qr {
      display: block;
      margin: 0.85rem auto 0;
      width: 168px;
      max-width: 100%;
      padding: 0.55rem;
      border-radius: 12px;
      background: #fff;
    }
    .pay-qr svg,
    .pay-qr img { display: block; width: 100%; height: auto; }
    .pay-qr-hint { display: block; margin: 0.55rem 0 0; text-align: center; }
    /* QR codes are for laptop/desktop only — phones open the app instead */
    body.pay-mobile .pay-qr,
    body.pay-mobile .pay-qr-hint,
    body.pay-mobile .pay-open-desktop { display: none; }
    body.pay-desktop .pay-open-mobile { display: none; }
    @media (max-width: 900px) {
      .pay-qr,
      .pay-qr-hint { display: none; }
    }
    .portal-top {
      margin: 2rem 0 0.65rem;
    }
    .btn.bmir {
      width: 100%;
      margin-top: 0;
      padding: 0.75rem 1rem;
      font-size: 1rem;
      letter-spacing: 0.01em;
      gap: 0.5rem;
    }
    .btn.bmir .radio-tower {
      flex: 0 0 auto;
      width: 1.35rem;
      height: 1.35rem;
      display: block;
    }
    .btn.bmir .bmir-logo {
      flex: 0 0 auto;
      width: 1.85rem;
      height: 1.85rem;
      display: block;
      border-radius: 50%;
      object-fit: cover;
      background: #000;
    }
    .bmir-player { width: 100%; }
    .bmir-shell {
      display: flex;
      align-items: stretch;
      gap: 0.4rem;
    }
    .bmir-player:not([data-mode="idle"]) .bmir-shell > .btn.bmir { display: none; }
    .bmir-player[data-mode="idle"] .bmir-deck { display: none; }
    .bmir-shell > .btn.bmir {
      flex: 1 1 auto;
      width: auto;
      min-width: 0;
    }
    .bmir-deck {
      display: flex;
      align-items: center;
      gap: 0.7rem;
      flex: 1 1 auto;
      width: auto;
      min-width: 0;
      margin: 0;
      padding: 0.65rem 0.85rem;
      border-radius: 12px;
      color: #06241f;
      background: linear-gradient(135deg, var(--accent), #2bb3a6);
    }
    .bmir-toggle {
      appearance: none;
      flex: 0 0 auto;
      width: 2.55rem;
      height: 2.55rem;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 999px;
      display: grid;
      place-items: center;
      cursor: pointer;
      color: inherit;
      background: rgba(6, 36, 31, 0.16);
    }
    .bmir-toggle svg {
      width: 1.15rem;
      height: 1.15rem;
      display: block;
    }
    .bmir-player[data-mode="live"] .bmir-ic-play,
    .bmir-player:not([data-mode="live"]) .bmir-ic-pause { display: none; }
    .bmir-eq {
      display: flex;
      align-items: flex-end;
      gap: 3px;
      height: 1.05rem;
      flex: 0 0 auto;
    }
    .bmir-eq i {
      display: block;
      width: 3px;
      height: 4px;
      border-radius: 1px;
      font-style: normal;
      background: currentColor;
      transform-origin: bottom;
    }
    .bmir-player[data-mode="live"] .bmir-eq i {
      animation: bmir-eq 0.85s ease-in-out infinite;
    }
    .bmir-player[data-mode="live"] .bmir-eq i:nth-child(2) { animation-delay: -0.2s; }
    .bmir-player[data-mode="live"] .bmir-eq i:nth-child(3) { animation-delay: -0.45s; }
    .bmir-player[data-mode="live"] .bmir-eq i:nth-child(4) { animation-delay: -0.1s; }
    @keyframes bmir-eq {
      0%, 100% { height: 4px; }
      50% { height: 100%; }
    }
    .bmir-copy { flex: 1; min-width: 0; }
    .bmir-kicker {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      opacity: 0.78;
    }
    .bmir-live-dot {
      width: 0.45rem;
      height: 0.45rem;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.45;
    }
    .bmir-player[data-mode="live"] .bmir-live-dot {
      opacity: 1;
      animation: bmir-pulse 1.4s ease-in-out infinite;
    }
    @keyframes bmir-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
    .bmir-name {
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 0.01em;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bmir-status {
      margin: 0.12rem 0 0;
      font-size: 0.78rem;
      font-weight: 600;
      line-height: 1.25;
      opacity: 0.82;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bmir-player[data-mode="error"] .bmir-status { opacity: 1; }
    .bmir-player audio { display: none; }
    @media (prefers-reduced-motion: reduce) {
      .bmir-eq i, .bmir-live-dot { animation: none !important; }
    }
    .wx-panel {
      position: relative;
    }
    .wx-panel-title {
      margin: 0 5.4rem 0.75rem 0;
    }
    .wx-panel > .wx-unit {
      position: absolute;
      top: 0.55rem;
      right: 0.55rem;
      z-index: 2;
    }
    .wx-unit {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: stretch;
      border: 1px solid var(--line);
      border-radius: 999px;
      overflow: hidden;
      background: rgba(0, 0, 0, 0.22);
    }
    .wx-unit-btn {
      appearance: none;
      border: 0;
      margin: 0;
      width: auto;
      padding: 0.28rem 0.7rem;
      font: inherit;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      line-height: 1.2;
      cursor: pointer;
      color: var(--muted);
      background: transparent;
    }
    .wx-unit-btn:hover:not(.is-active) {
      color: var(--ink);
    }
    .wx-unit-btn.is-active {
      color: #06241f;
      background: var(--accent);
    }
    .wx-unit-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
      z-index: 1;
    }
    .wx-now {
      display: flex;
      align-items: center;
      gap: 0.75rem 1rem;
      margin: 0.35rem 0 0.75rem;
    }
    .wx-now-main {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem 1.1rem;
      align-items: baseline;
      min-width: 0;
      flex: 0 1 auto;
    }
    .wx-now .wx-now-temp {
      font-size: 1.85rem;
      font-weight: 700;
      color: var(--ink);
      letter-spacing: -0.02em;
    }
    .wx-now .wx-now-meta { font-size: 1rem; color: var(--muted); }
    .wx-now-icon {
      flex: 1 1 auto;
      display: flex;
      justify-content: center;
      align-items: center;
      min-width: 4.25rem;
    }
    .wx-now-aqi {
      flex: 0 0 auto;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 0.05rem;
      padding: 0.28rem 0.7rem;
      border: 1px solid;
      border-radius: 8px;
      min-width: 4.6rem;
      line-height: 1.15;
    }
    .wx-now-aqi-num {
      font-size: 1.05rem;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .wx-now-aqi-cat {
      font-size: 0.72rem;
      font-weight: 650;
      opacity: 0.92;
    }
    .wx-now-aqi-loc {
      font-size: 0.62rem;
      font-weight: 600;
      opacity: 0.78;
      white-space: nowrap;
    }
    .wx-day-icon {
      flex: 0 0 auto;
      width: 4.25rem;
      height: 4.25rem;
      object-fit: contain;
      filter: drop-shadow(0 2px 6px rgba(0,0,0,0.35));
    }
    .wx-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 0.55rem 0.9rem;
      margin: 0 0 0.55rem;
      font-size: 0.78rem;
      color: var(--muted);
    }
    .wx-legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
    .wx-swatch {
      width: 0.7rem;
      height: 0.7rem;
      border-radius: 2px;
      display: inline-block;
    }
    .wx-swatch-aqi {
      background: linear-gradient(90deg, #3FA266, #f0b429, #fc6b83);
    }
    .wx-chart-wrap {
      margin: 0 -0.15rem;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .wx-chart {
      display: block;
      width: 100%;
      min-width: 294px;
      height: auto;
    }
    .wx-astro {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
      margin-top: 0.9rem;
      padding-top: 0.85rem;
      border-top: 1px solid var(--line);
    }
    .wx-astro-block {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 0.55rem;
      min-width: 0;
      padding: 0.65rem 0.5rem 0.75rem;
      border: 1px solid var(--line);
      border-radius: 0.75rem;
      background: rgba(11, 18, 32, 0.35);
    }
    .wx-astro-glyph {
      width: 4.25rem;
      height: 4.25rem;
      object-fit: contain;
      flex: 0 0 auto;
      filter: drop-shadow(0 2px 6px rgba(0,0,0,0.3));
    }
    .wx-astro-glyph--moon {
      width: 4.25rem;
      height: 4.25rem;
      border-radius: 50%;
    }
    .wx-astro-pair {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.45rem;
      width: 100%;
    }
    .wx-astro-fullmoon {
      grid-column: 1 / -1;
      margin: 0;
      padding: 0.35rem 0.65rem;
      text-align: center;
      font-size: 0.82rem;
      font-weight: 700;
      color: var(--ink);
      line-height: 1.35;
      border: 1px solid var(--line);
      border-radius: 0.35rem;
      justify-self: center;
    }
    .wx-astro-text {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.1rem;
      min-width: 0;
    }
    .wx-astro-label {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    .wx-astro-time {
      font-size: 0.95rem;
      color: var(--ink);
      font-weight: 600;
      line-height: 1.2;
    }
    .wx-astro-day {
      font-size: 0.68rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      line-height: 1.2;
    }
    .wx-dashboard {
      margin-top: 1rem;
      padding-top: 0.85rem;
      border-top: 1px solid var(--line);
    }
    .wx-dashboard h3 {
      margin: 0 0 0.35rem;
      font-size: 0.95rem;
      color: var(--ink);
    }
    .wx-dashboard h3 a {
      color: var(--accent);
      text-decoration: underline;
      text-underline-offset: 0.12em;
    }
    .wx-dashboard-body {
      margin-top: 0.65rem;
      padding: 0.75rem 0.85rem;
      border: 1px solid rgba(61, 214, 198, 0.28);
      border-radius: 4px;
      background: #060a10;
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.45);
      font-family: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 0.8rem;
      line-height: 1.5;
      color: #b8f5c0;
      overflow-x: auto;
    }
    .wx-dashboard-body p {
      margin: 0.55rem 0 0;
      color: inherit;
      font-size: inherit;
      line-height: inherit;
      white-space: pre-line;
    }
    .wx-dashboard-body p:first-child {
      margin-top: 0;
    }
    .wx-dashboard-body .warn {
      color: #ffb4a8;
    }
    .wx-radar {
      margin-top: 1rem;
      padding-top: 0.85rem;
      border-top: 1px solid var(--line);
    }
    .wx-radar h3 {
      margin: 0 0 0.35rem;
      font-size: 0.95rem;
      color: var(--ink);
    }
    .wx-radar-map-host {
      margin-top: 0.7rem;
    }
    .wx-radar-map-wrap {
      position: relative;
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: hidden;
      background: #0b0f14;
    }
    .wx-radar-leaflet {
      width: 100%;
      height: min(58vw, 380px);
      min-height: 240px;
      background: #0b0f14;
    }
    .wx-radar-leaflet .leaflet-control-attribution {
      display: none;
    }
    .wx-radar-leaflet .leaflet-control-zoom {
      border: 1px solid rgba(232, 238, 247, 0.22) !important;
      border-radius: 4px !important;
      overflow: hidden;
      box-shadow: none !important;
    }
    .wx-radar-leaflet .leaflet-control-zoom a {
      width: 28px;
      height: 28px;
      line-height: 28px;
      color: #e8eef7 !important;
      background: rgba(12, 18, 28, 0.92) !important;
      border-bottom: 1px solid rgba(232, 238, 247, 0.16) !important;
    }
    .wx-radar-leaflet .leaflet-control-zoom a:last-child {
      border-bottom: 0 !important;
    }
    .wx-radar-leaflet .leaflet-control-zoom a:hover,
    .wx-radar-leaflet .leaflet-control-zoom a:focus {
      background: rgba(240, 180, 41, 0.22) !important;
      color: #fff !important;
    }
    .wx-radar-controls {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      padding: 0.45rem 0.65rem;
      background: rgba(6, 10, 16, 0.92);
      border-top: 1px solid var(--line);
    }
    .wx-radar-progress {
      flex: 1;
      height: 4px;
      border-radius: 2px;
      background: rgba(232, 238, 247, 0.14);
      overflow: hidden;
    }
    .wx-radar-progress-fill {
      height: 100%;
      width: 0%;
      background: #3dd6c6;
      border-radius: 2px;
    }
    .wx-radar-leaflet .wx-radar-layer,
    .wx-radar-leaflet .wx-smoke-layer {
      will-change: opacity;
    }
    .wx-radar-time {
      font-size: 0.75rem;
      color: var(--muted);
      min-width: 4.5rem;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .wx-radar-fallback {
      margin: 0.5rem 0 0;
      font-size: 0.85rem;
    }
    .wx-radar-scale {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      margin-top: 0.55rem;
      font-size: 0.72rem;
      color: var(--muted);
    }
    .wx-radar-scale i {
      flex: 1;
      height: 8px;
      border-radius: 2px;
      background: linear-gradient(90deg, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000, #ff00ff);
    }
    .wx-radar-links {
      margin: 0.4rem 0 0;
      font-size: 0.85rem;
    }
    .wx-radar-links a {
      color: var(--accent);
      font-weight: 650;
    }
    .wx-radar-overlays {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem 0.85rem;
      margin-top: 0.45rem;
      font-size: 0.72rem;
      color: var(--muted);
    }
    .wx-radar-overlays span {
      display: inline-flex;
      align-items: center;
      gap: 0.32rem;
    }
    .wx-lg-smoke {
      width: 0.85rem;
      height: 0.55rem;
      border-radius: 2px;
      background: linear-gradient(90deg, #fff7bc, #fe9929, #7a3e12);
      display: inline-block;
    }
    .wx-flame-icon {
      background: none !important;
      border: none !important;
    }
    .wx-flame-icon svg {
      display: block;
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.7));
    }
    .tabs {
      display: flex;
      gap: 0.15rem;
      margin: 0 0 1.15rem;
      border-bottom: 1px solid var(--line);
    }
    .tabs a {
      color: var(--muted);
      text-decoration: none;
      padding: 0.55rem 0.85rem;
      margin-bottom: -1px;
      border-bottom: 2px solid transparent;
      font-size: 0.95rem;
      font-weight: 650;
    }
    .tabs a.active { color: var(--accent); border-bottom-color: var(--accent); }
    .search-row { display: flex; gap: 0.5rem; align-items: center; }
    .search-row input { margin: 0; }
    .search-row .btn { width: auto; margin: 0; }
    .event-list { margin: 0; padding: 0; list-style: none; }
    .event-item { padding: 0.9rem 0; border-bottom: 1px solid var(--line); }
    .event-item:last-child { border-bottom: 0; }
    .event-when { font-size: 0.8rem; color: var(--accent); margin: 0 0 0.2rem; }
    .event-item h3 { margin: 0 0 0.2rem; font-size: 1.05rem; font-weight: 650; }
    .event-item p { margin: 0.35rem 0 0; }
    .empty { color: var(--muted); }
    .events-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.75rem;
      margin-bottom: 0.15rem;
    }
    .events-head h1 { margin: 0; }
    .events-head .btn { width: auto; margin: 0; flex-shrink: 0; }
    .filter-bar summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.5rem 1rem;
      font-weight: 650;
      color: var(--ink);
    }
    .filter-bar summary::-webkit-details-marker { display: none; }
    .filter-bar summary::after {
      content: "▸";
      color: var(--muted);
      font-size: 0.85rem;
    }
    .filter-bar[open] summary::after { content: "▾"; }
    .filter-bar .filter-body { margin-top: 1rem; padding-top: 0.85rem; border-top: 1px solid var(--line); }
    .filter-chip {
      display: inline-block;
      margin-left: 0.35rem;
      padding: 0.1rem 0.45rem;
      border-radius: 999px;
      border: 1px solid var(--line);
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--accent);
    }
    .camp-suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      margin-top: 0.55rem;
    }
    .camp-suggestions button {
      border: 1px solid var(--line);
      background: rgba(0,0,0,0.2);
      color: var(--ink);
      border-radius: 999px;
      padding: 0.25rem 0.65rem;
      font: inherit;
      font-size: 0.8rem;
      cursor: pointer;
    }
    .camp-suggestions button.active {
      border-color: rgba(61,214,198,0.5);
      color: var(--accent);
    }
    .camp-active {
      margin-top: 0.65rem;
      font-size: 0.85rem;
      color: var(--accent2);
    }
    .event-item-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .fav-btn {
      border: 1px solid var(--line);
      background: transparent;
      color: var(--muted);
      border-radius: 10px;
      width: 2.1rem;
      height: 2.1rem;
      padding: 0;
      font-size: 1.05rem;
      line-height: 1;
      cursor: pointer;
      flex-shrink: 0;
    }
    .fav-btn.on {
      color: var(--accent2);
      border-color: rgba(240,180,41,0.45);
    }
    .profile-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.85rem; }
    .profile-row .btn { width: auto; margin: 0; }
    .profile-row input { flex: 1; min-width: 10rem; margin: 0; }
    .profile-status { font-size: 0.8rem; color: var(--muted); margin-top: 0.55rem; }
    .data-op-macs { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.4rem 0 0; }
    .data-op-macs code { font-size: 0.78rem; }
  </style>
</head>
<body>
  <div class="data-ticker" id="data-ticker" data-tone="empty" hidden>
    <div class="data-ticker-track" id="data-ticker-track"></div>
  </div>
  <main class="${opts?.admin ? "wide" : ""}">
    ${body}
  </main>
  <script>
    (function () {
      var narrow = window.matchMedia && window.matchMedia("(max-width: 900px)").matches;
      var uaMobile = /Mobi|Android|iPhone|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent || "");
      document.body.classList.add(narrow || uaMobile ? "pay-mobile" : "pay-desktop");
      if (window.navigator.standalone || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)) {
        document.body.classList.add("is-standalone");
      }

      var ticker = document.getElementById("data-ticker");
      var track = document.getElementById("data-ticker-track");
      if (!ticker || !track) return;

      function paintTicker(data) {
        if (!data || data.tone === "empty" || data.remaining_gb == null) {
          ticker.hidden = true;
          ticker.classList.remove("is-on");
          return;
        }
        var text = data.label || "";
        var bits = [];
        for (var i = 0; i < 8; i++) bits.push("<span>" + text.replace(/</g, "") + "</span>");
        track.innerHTML = bits.join("");
        ticker.setAttribute("data-tone", data.tone || "green");
        ticker.hidden = false;
        ticker.classList.add("is-on");
      }

      function loadTicker() {
        fetch("/api/starlink-data", { headers: { "Accept": "application/json" } })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(paintTicker)
          .catch(function () {});
      }
      loadTicker();
      setInterval(loadTicker, 30000);
    })();
  </script>
</body>
</html>`;
}

const OUTSIDE_BROWSE_HREF = "https://thephage.org/public/";
const INNOVATE_HREF = "https://innovate.burningman.org/";

const BMIR_LOGO_IMG = `<img class="bmir-logo" src="/assets/brands/bmir.png" alt="" width="192" height="192" decoding="async" />`;

const RADIO_TOWER_ICON = `<svg class="radio-tower" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path fill="currentColor" d="M12 1.75a1 1 0 0 1 1 1V4.1l2.35 3.53a1 1 0 0 1-.83 1.55H9.48a1 1 0 0 1-.83-1.55L11 4.1V2.75a1 1 0 0 1 1-1Zm0 5.35L11.15 9.18h1.7L12 7.1Z"/>
  <path fill="currentColor" d="M8.75 10.18h6.5a1 1 0 0 1 .97 1.25l-1.6 6.32H9.38l-1.6-6.32a1 1 0 0 1 .97-1.25Zm1.55 2v2.5h3.4v-2.5h-3.4Zm.5 4.5h2.4l.45-1.75h-3.3L10.8 16.68Z"/>
  <path fill="currentColor" d="M7.25 20.25h9.5a1 1 0 1 1 0 2H7.25a1 1 0 1 1 0-2Z"/>
  <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M5.2 7.2c-1.7 1.5-2.7 3.5-2.7 5.7M18.8 7.2c1.7 1.5 2.7 3.5 2.7 5.7M7.1 8.6c-1.15 1.1-1.85 2.55-1.85 4.2M16.9 8.6c1.15 1.1 1.85 2.55 1.85 4.2"/>
</svg>`;

const BMIR_PLAY_ICON = `<svg class="bmir-ic-play" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 5.15v13.7L19.2 12 8 5.15Z"/></svg>`;
const BMIR_PAUSE_ICON = `<svg class="bmir-ic-pause" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7 5h3.4v14H7V5Zm6.6 0H17v14h-3.4V5Z"/></svg>`;

function guestBrand(): string {
  return `<div class="brand">Phage Camp @ The Institute</div>`;
}

/** Phone home-screen shortcut / desktop download — browsers block setting the real homepage. */
function saveHomePageBlock(): string {
  const portalUrl = `${config.publicUrl}/`;
  return `
    <div class="home-save-wrap" id="home-save-wrap" data-portal="${escapeHtml(portalUrl)}">
      <button type="button" class="btn secondary" id="home-save-btn">Save as my home page</button>
      <p class="home-save-hint" id="home-save-hint">Puts a shortcut on your phone so you can get back here in one tap.</p>
    </div>
    <dialog class="leave-dialog" id="home-save-dialog" aria-labelledby="home-save-title">
      <div class="leave-dialog-inner">
        <div class="leave-dialog-badge">Saved</div>
        <h2 id="home-save-title">Get back here anytime</h2>
        <p id="home-save-copy"></p>
        <code class="home-save-url" id="home-save-url">${escapeHtml(portalUrl)}</code>
        <form method="dialog">
          <button class="btn leave-stay" value="ok">Done</button>
        </form>
      </div>
    </dialog>
    <script>
      (function () {
        var wrap = document.getElementById("home-save-wrap");
        var btn = document.getElementById("home-save-btn");
        var hint = document.getElementById("home-save-hint");
        var dialog = document.getElementById("home-save-dialog");
        var copyEl = document.getElementById("home-save-copy");
        var urlEl = document.getElementById("home-save-url");
        if (!wrap || !btn || !dialog) return;

        var KEY = "phage-home-saved";
        var ua = navigator.userAgent || "";
        var isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        var isAndroid = /Android/i.test(ua);
        var isMobile = isIos || isAndroid || /Mobi|IEMobile|Opera Mini/i.test(ua);
        var deferredPrompt = null;

        window.addEventListener("beforeinstallprompt", function (e) {
          e.preventDefault();
          deferredPrompt = e;
        });

        function homeUrl() {
          if (location.origin) return location.origin + "/";
          return wrap.getAttribute("data-portal") || "/";
        }

        function markSaved() {
          try { localStorage.setItem(KEY, "1"); } catch (e) {}
          btn.textContent = "Saved — tap to save again";
          if (hint) hint.textContent = "Shortcut saved on this device. Tap again if you need another copy.";
        }

        try {
          if (localStorage.getItem(KEY)) markSaved();
        } catch (e) {}

        function copyUrl(url) {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).catch(function () {});
            return;
          }
          try {
            var input = document.createElement("input");
            input.value = url;
            document.body.appendChild(input);
            input.select();
            document.execCommand("copy");
            input.remove();
          } catch (e) {}
        }

        function downloadShortcut(url) {
          var blob = new Blob(["[InternetShortcut]\\r\\nURL=" + url + "\\r\\n"], { type: "application/octet-stream" });
          var objectUrl = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = objectUrl;
          a.download = "Phage Camp.url";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 1500);
        }

        function instructions(shared) {
          if (isIos) {
            return shared
              ? "If you chose Add to Home Screen, look for the Phage Camp icon next to your apps. If not: tap the button again, then Share → Add to Home Screen (swipe the bottom row if it is hidden)."
              : "On iPhone, tap Share (the square with the arrow) → Add to Home Screen. That puts this page on your home screen.";
          }
          if (isAndroid) {
            return "Open the browser menu (⋮) and tap Add to Home screen. You will get a Phage Camp icon so you can return in one tap.";
          }
          return "A shortcut file was saved to your downloads. Double-click it anytime, or bookmark this page with Ctrl+D (⌘D on a Mac). The address is also copied to your clipboard.";
        }

        function openDialog(shared) {
          if (copyEl) copyEl.textContent = instructions(shared);
          if (urlEl) urlEl.textContent = homeUrl();
          if (typeof dialog.showModal === "function") dialog.showModal();
        }

        function finish(shared) {
          markSaved();
          openDialog(shared);
        }

        btn.addEventListener("click", function () {
          var url = homeUrl();
          copyUrl(url);
          if (deferredPrompt) {
            deferredPrompt.prompt();
            deferredPrompt.userChoice.then(function () {
              deferredPrompt = null;
              finish(true);
            }).catch(function () { finish(false); });
            return;
          }
          if (isMobile && navigator.share) {
            navigator.share({ title: "Phage Camp", text: "Camp portal home", url: url })
              .then(function () { finish(true); })
              .catch(function () { finish(false); });
            return;
          }
          downloadShortcut(url);
          finish(false);
        });
      })();
    </script>`;
}

function starlinkDataPanel(opts: {
  view: StarlinkDataOperatorView;
  flash?: string;
  error?: string;
  compact?: boolean;
}): string {
  const { view, flash, error, compact = false } = opts;
  const remaining = view.remaining_gb == null ? "" : String(view.remaining_gb);
  const limit = view.limit_gb == null ? "" : String(view.limit_gb);
  const reserved =
    view.reserved_gb == null ? String(DEFAULT_RESERVED_GB) : String(view.reserved_gb);
  const updated = view.updated_at
    ? `Last set ${escapeHtml(formatUpdatedAgo(view.updated_at))}`
    : "Not set yet — enter what the Starlink app shows.";
  const macs = [...new Set([...view.unique_ids, ...view.bound_macs])]
    .map((m) => `<code>${escapeHtml(m)}</code>`)
    .join("");
  const paceNote =
    view.available_gb != null && view.daily_pct_left != null && view.daily_budget_gb != null
      ? ` · ticker: ${escapeHtml(view.label)} · today’s share ${escapeHtml(formatGb(view.daily_budget_gb))} GB (${escapeHtml(formatGb(view.used_today_gb ?? 0))} used)`
      : view.remaining_gb != null
        ? ` · ticker shows ${escapeHtml(formatGb(view.remaining_gb))} GB`
        : "";

  if (!view.operator) {
    return `
    <div class="panel">
      <h2>Authorize this device</h2>
      ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
      ${flash ? `<p class="ok">${escapeHtml(flash)}</p>` : ""}
      <p>This portal identifies you by Wi‑Fi MAC, not IMEI. On your phone use <strong>About phone → Device Wi‑Fi MAC</strong>. On a computer, use the hardware Wi‑Fi address (or the Device line on the guest page).</p>
      <p class="meta">This device: <code>${escapeHtml(view.current_mac ?? "unknown")}</code></p>
      ${
        view.current_mac
          ? `<form method="POST" action="/data/bind">
              <label for="unique-id">Your unique ID (Wi‑Fi MAC)</label>
              <input id="unique-id" name="unique_id" placeholder="b0:d5:fb:9c:1a:ef" required autocomplete="off" spellcheck="false" />
              <button class="btn" type="submit">Authorize this device</button>
            </form>`
          : `<p class="err">Could not see this device’s MAC. Reconnect to camp Wi‑Fi and retry.</p>`
      }
    </div>`;
  }

  return `
    <div class="panel">
      <h2>${compact ? "Starlink data remaining" : "Update remaining data"}</h2>
      ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
      ${flash ? `<p class="ok">${escapeHtml(flash)}</p>` : ""}
      <p class="meta">${escapeHtml(updated)}${paceNote}</p>
      <form method="POST" action="/data/remaining">
        <label for="remaining-gb">Remaining (GB)</label>
        <input id="remaining-gb" name="remaining_gb" type="number" min="0" max="10000" step="0.01" inputmode="decimal" value="${escapeHtml(remaining)}" required />
        <label for="limit-gb">Plan size (GB, optional)</label>
        <input id="limit-gb" name="limit_gb" type="number" min="0" max="10000" step="0.01" inputmode="decimal" value="${escapeHtml(limit)}" placeholder="100" />
        <label for="reserved-gb">Hold for Monday (GB)</label>
        <input id="reserved-gb" name="reserved_gb" type="number" min="0" max="10000" step="0.01" inputmode="decimal" value="${escapeHtml(reserved)}" />
        <p class="meta">Camp can use remaining minus this hold. Daily % left is today’s unused share of that pool (pool ÷ days until Mon 8/31, minus GB used since the last remaining update today). Set hold to 0 after Monday.</p>
        <button class="btn" type="submit">Save remaining data</button>
      </form>
      ${
        compact
          ? `<p class="meta" style="margin-top:0.75rem">This device <code>${escapeHtml(view.current_mac ?? "")}</code>. Add your computer at <a href="/data">/data</a>.</p>`
          : `<p class="meta" style="margin-top:0.85rem">Authorized unique IDs + bound MACs</p>
             <div class="data-op-macs">${macs}</div>
             <form method="POST" action="/data/operators" style="margin-top:0.85rem">
               <label for="add-unique-id">Add another device unique ID (computer Wi‑Fi MAC)</label>
               <input id="add-unique-id" name="unique_id" placeholder="aa:bb:cc:dd:ee:ff" required autocomplete="off" spellcheck="false" />
               <button class="btn secondary" type="submit">Add device</button>
             </form>
             <p class="meta">On the computer, open <code>/data</code> and enter the same unique ID if Android/macOS is using a randomized MAC.</p>`
      }
    </div>`;
}

export function starlinkDataPage(opts: {
  view: StarlinkDataOperatorView;
  flash?: string;
  error?: string;
}): string {
  return layout(
    "Starlink data",
    `
    ${guestBrand()}
    <p class="nav" style="margin:0 0 1rem"><a href="/">← Back</a></p>
    <h1>Starlink data remaining</h1>
    <p class="lede">Manual ticker for camp. Re-check Starlink <strong>Data usage</strong> each day and save remaining here so Daily % left stays honest — pace together and still use today’s share.</p>
    ${starlinkDataPanel({ view: opts.view, flash: opts.flash, error: opts.error })}
    `,
  );
}

function wxUnitToggle(): string {
  return `<div class="wx-unit" role="group" aria-label="Temperature unit">
        <button type="button" class="wx-unit-btn is-active" data-wx-unit="F" aria-pressed="true">°F</button>
        <button type="button" class="wx-unit-btn" data-wx-unit="C" aria-pressed="false">°C</button>
      </div>`;
}

function bmirListenButton(): string {
  return `
    <div class="portal-top">
      <div class="bmir-player" id="bmir-player" data-mode="idle" data-stream="${escapeHtml(BMIR_STREAM_PATH)}" data-fallback="${escapeHtml(BMIR_DIRECT_STREAM)}">
        <div class="bmir-shell">
          <button type="button" class="btn bmir" data-bmir-start aria-label="Play BMIR live radio">
            ${RADIO_TOWER_ICON}
            ${BMIR_LOGO_IMG}
            Listen to BMIR Live!
            ${RADIO_TOWER_ICON}
          </button>
          <div class="bmir-deck">
            <button type="button" class="bmir-toggle" data-bmir-toggle aria-label="Pause BMIR">
              ${BMIR_PLAY_ICON}
              ${BMIR_PAUSE_ICON}
            </button>
            <div class="bmir-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
            <div class="bmir-copy">
              <div class="bmir-kicker"><span class="bmir-live-dot"></span> BMIR 94.5 FM</div>
              <div class="bmir-name">Burning Man Information Radio</div>
              <p class="bmir-status" data-bmir-status>Connecting…</p>
            </div>
            <audio data-bmir-audio preload="none" playsinline></audio>
          </div>
        </div>
      </div>
    </div>
    <script>
      (function () {
        var root = document.getElementById("bmir-player");
        if (!root) return;
        var audio = root.querySelector("[data-bmir-audio]");
        var statusEl = root.querySelector("[data-bmir-status]");
        var startBtn = root.querySelector("[data-bmir-start]");
        var toggleBtn = root.querySelector("[data-bmir-toggle]");
        if (!audio || !startBtn || !toggleBtn) return;
        var sources = [root.getAttribute("data-stream") || "/bmir/stream", root.getAttribute("data-fallback") || ""].filter(Boolean);
        var sourceIndex = 0;
        var loadTimer = 0;
        var hourTimer = 0;
        var wanted = false;
        var playedMs = 0;
        var playStartedAt = 0;
        var SESSION_MS = ${BMIR_MAX_LISTEN_MS};

        function setMode(mode, label) {
          root.setAttribute("data-mode", mode);
          if (statusEl && label) statusEl.textContent = label;
          toggleBtn.setAttribute("aria-label", mode === "live" ? "Pause BMIR" : "Play BMIR");
          toggleBtn.setAttribute("aria-pressed", mode === "live" ? "true" : "false");
        }

        function clearLoadTimer() {
          if (loadTimer) {
            clearTimeout(loadTimer);
            loadTimer = 0;
          }
        }

        function clearHourTimer() {
          if (hourTimer) {
            clearTimeout(hourTimer);
            hourTimer = 0;
          }
        }

        function streamedMs() {
          var n = playedMs;
          if (playStartedAt) n += Date.now() - playStartedAt;
          return n;
        }

        function remainingMs() {
          return SESSION_MS - streamedMs();
        }

        function stopDownload() {
          clearLoadTimer();
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        }

        function stopPlayingClock() {
          if (playStartedAt) {
            playedMs += Date.now() - playStartedAt;
            playStartedAt = 0;
          }
          clearHourTimer();
        }

        function armHourTimer() {
          clearHourTimer();
          var left = remainingMs();
          if (left <= 0) {
            endSession();
            return;
          }
          hourTimer = setTimeout(endSession, left);
        }

        function markPlayingClock() {
          if (!playStartedAt) playStartedAt = Date.now();
          armHourTimer();
        }

        function clearMediaSession() {
          if (!navigator.mediaSession) return;
          try {
            navigator.mediaSession.setActionHandler("play", null);
            navigator.mediaSession.setActionHandler("pause", null);
            navigator.mediaSession.setActionHandler("stop", null);
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = "none";
          } catch (e) {}
        }

        function endSession() {
          wanted = false;
          stopPlayingClock();
          playedMs = 0;
          playStartedAt = 0;
          stopDownload();
          clearMediaSession();
          setMode("idle");
        }

        function checkHourCap() {
          if (!wanted && root.getAttribute("data-mode") === "idle") return;
          if (streamedMs() >= SESSION_MS) endSession();
        }

        function srcAt(i) {
          var base = sources[i];
          var sep = base.indexOf("?") >= 0 ? "&" : "?";
          return base + sep + "t=" + Date.now();
        }

        function bindMediaSession() {
          if (!navigator.mediaSession) return;
          try {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: "BMIR 94.5 FM",
              artist: "Burning Man Information Radio"
            });
            navigator.mediaSession.setActionHandler("play", function () {
              if (root.getAttribute("data-mode") === "idle") return;
              start();
            });
            navigator.mediaSession.setActionHandler("pause", function () { pause(); });
            navigator.mediaSession.setActionHandler("stop", function () { pause(); });
          } catch (e) {}
        }

        function start() {
          if (root.getAttribute("data-mode") === "idle") {
            playedMs = 0;
            playStartedAt = 0;
          }
          wanted = true;
          sourceIndex = 0;
          setMode("loading", "Connecting…");
          bindMediaSession();
          markPlayingClock();
          playCurrent();
        }

        function playCurrent() {
          if (!wanted) return;
          if (remainingMs() <= 0) {
            endSession();
            return;
          }
          if (sourceIndex >= sources.length) {
            setMode("error", "BMIR is off the air. Tap to retry.");
            stopPlayingClock();
            stopDownload();
            return;
          }
          clearLoadTimer();
          setMode("loading", "Connecting…");
          audio.src = srcAt(sourceIndex);
          var playPromise = audio.play();
          if (playPromise && playPromise.catch) {
            playPromise.catch(function () {
              if (!wanted) return;
              sourceIndex += 1;
              playCurrent();
            });
          }
          loadTimer = setTimeout(function () {
            if (!wanted) return;
            if (root.getAttribute("data-mode") === "loading") {
              sourceIndex += 1;
              playCurrent();
            }
          }, 12000);
        }

        function pause() {
          wanted = false;
          stopPlayingClock();
          stopDownload();
          setMode("paused", "Paused — tap to rejoin live");
        }

        startBtn.addEventListener("click", function () { start(); });
        toggleBtn.addEventListener("click", function () {
          if (root.getAttribute("data-mode") === "live") pause();
          else start();
        });
        audio.addEventListener("playing", function () {
          if (!wanted) return;
          clearLoadTimer();
          markPlayingClock();
          setMode("live", "Live");
        });
        audio.addEventListener("waiting", function () {
          if (!wanted) return;
          if (root.getAttribute("data-mode") === "live") setMode("live", "Buffering…");
        });
        audio.addEventListener("timeupdate", checkHourCap);
        audio.addEventListener("error", function () {
          if (!wanted) return;
          if (remainingMs() <= 0) {
            endSession();
            return;
          }
          sourceIndex += 1;
          playCurrent();
        });
        audio.addEventListener("ended", function () {
          if (!wanted) return;
          if (remainingMs() <= 0) {
            endSession();
            return;
          }
          sourceIndex = 0;
          playCurrent();
        });
        document.addEventListener("visibilitychange", checkHourCap);
        window.addEventListener("pagehide", checkHourCap);
      })();
    </script>`;
}

function innovateAppsPanel(): string {
  return `
    <div class="panel">
      <h2 style="margin-top:0">Burning Man Innovate</h2>
      <p class="lede" style="margin-top:0">Community apps for this year's burn — event guides, maps, camp directories, and other playa tools built on official Burning Man open data.</p>
      <a class="btn" href="${escapeHtml(INNOVATE_HREF)}">Open BRC Innovate</a>
    </div>`;
}

/** First-visit gate: collect playa name for a new MAC and never ask again once saved. */
function playaNameGate(ask: boolean): string {
  if (!ask) return "";
  return `
    <dialog class="leave-dialog" id="playa-name-dialog" aria-labelledby="playa-name-title">
      <div class="leave-dialog-inner">
        <div class="leave-dialog-badge">Welcome</div>
        <h2 id="playa-name-title">What is your playa name?</h2>
        <form id="playa-name-form">
          <label for="playa-name-input">Playa name</label>
          <input id="playa-name-input" name="playa_name" type="text" autocomplete="nickname" required maxlength="48" autofocus placeholder="Your burner name" />
          <p class="err" id="playa-name-error" hidden style="margin:0.65rem 0 0"></p>
          <button class="btn leave-confirm" type="submit" style="margin-top:0.9rem">Save</button>
        </form>
      </div>
    </dialog>
    <script>
      (function () {
        var dialog = document.getElementById("playa-name-dialog");
        var form = document.getElementById("playa-name-form");
        var input = document.getElementById("playa-name-input");
        var errEl = document.getElementById("playa-name-error");
        if (!dialog || !form) return;
        function showError(msg) {
          if (errEl) {
            errEl.textContent = msg || "";
            errEl.hidden = !msg;
          } else if (msg) {
            window.alert(msg);
          }
        }
        function openGate() {
          if (typeof dialog.showModal === "function") {
            dialog.showModal();
            if (input) {
              try { input.focus(); } catch (e) {}
            }
            return;
          }
          var name = window.prompt("What is your playa name?");
          if (name == null) return;
          submitName(name);
        }
        function submitName(raw) {
          showError("");
          var playa = String(raw || "").replace(/\\s+/g, " ").trim();
          if (!playa) {
            showError("Enter your playa name.");
            return Promise.resolve();
          }
          return fetch("/api/device/playa-name", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ playa_name: playa }),
            credentials: "same-origin",
          }).then(function (res) {
            return res.json().then(function (data) {
              if (!res.ok || !data || !data.ok) {
                showError((data && data.error) || "Could not save. Try again.");
                return;
              }
              if (typeof dialog.close === "function") dialog.close();
            });
          }).catch(function () {
            showError("Could not save. Try again.");
          });
        }
        dialog.addEventListener("cancel", function (ev) {
          ev.preventDefault();
        });
        form.addEventListener("submit", function (ev) {
          ev.preventDefault();
          submitName(input ? input.value : "");
        });
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", openGate);
        } else {
          openGate();
        }
      })();
    </script>`;
}

function adminNav(): string {
  return `<div class="nav">
      <a href="/admin">Dashboard</a>
      <a href="/admin/events">Events</a>
      <a href="/data">Starlink data</a>
      <a href="/">Guest portal</a>
      <form method="POST" action="/admin/logout" style="display:inline"><button class="btn small secondary" type="submit">Log out</button></form>
    </div>`;
}

const VENMO_CODE_URL =
  "https://venmo.com/code?user_id=1760478422368257014&created=1787256263";
const VENMO_QR_IMG = "/assets/pay/venmo-qr.png";
const PAYPAL_QR_IMG = "/assets/pay/paypal-qr.png";
const ZELLE_QR_IMG = "/assets/pay/zelle-qr.png";
const BITCOIN_QR_IMG = "/assets/pay/bitcoin-qr.png";
const PAYPAL_PHONE_DISPLAY = "540-798-2312";

function isEmailHandle(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function formatUsPhoneDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 || (digits.length === 11 && digits.startsWith("1"))) {
    const ten = digits.slice(-10);
    return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  }
  return raw.trim();
}

function venmoPayUrl(handle: string, amountCents: number, note: string): string {
  const user = handle.replace(/^@/, "").trim();
  const amount = (amountCents / 100).toFixed(2);
  const params = new URLSearchParams({
    txn: "pay",
    amount,
    note,
  });
  return `https://venmo.com/${encodeURIComponent(user)}?${params.toString()}`;
}

function venmoAppUrl(handle: string, amountCents: number, note: string): string {
  const user = handle.replace(/^@/, "").trim();
  const amount = (amountCents / 100).toFixed(2);
  const params = new URLSearchParams({
    txn: "pay",
    recipients: user,
    amount,
    note,
  });
  return `venmo://paycharge?${params.toString()}`;
}

function paypalPayUrl(handle: string, amountCents: number, note: string): string {
  const amount = (amountCents / 100).toFixed(2);
  if (isEmailHandle(handle)) {
    // Prefill recipient + amount so logged-in payers land on confirm (not a blank send form).
    const params = new URLSearchParams({
      cmd: "_xclick",
      business: handle.toLowerCase(),
      amount,
      currency_code: "USD",
      item_name: note.slice(0, 120) || "Starlink",
      no_shipping: "1",
      no_note: "0",
    });
    return `https://www.paypal.com/cgi-bin/webscr?${params.toString()}`;
  }
  const user = handle
    .replace(/^https?:\/\/(www\.)?paypal\.me\//i, "")
    .replace(/^@/, "")
    .replace(/\/$/, "")
    .trim();
  return `https://paypal.me/${encodeURIComponent(user)}/${amount}`;
}

export type PayMethodLink = {
  method: "venmo" | "paypal" | "zelle" | "bitcoin" | "cash";
  label: string;
  handle: string;
  href: string;
  appHref?: string;
  qrSvg: string;
};

export async function buildPayMethodLinks(
  settings: Settings,
  deviceNote: string,
  amountCents = settings.price_cents,
): Promise<PayMethodLink[]> {
  const { default: QRCode } = await import("qrcode");
  const note = `Starlink ${deviceNote}`;
  const links: Omit<PayMethodLink, "qrSvg">[] = [];

  const venmo = settings.venmo_handle.replace(/^@/, "").trim();
  if (venmo) {
    links.push({
      method: "venmo",
      label: "Venmo",
      handle: `@${venmo}`,
      href: venmoPayUrl(venmo, amountCents, note),
      appHref: venmoAppUrl(venmo, amountCents, note),
    });
  }

  const paypalRaw = settings.paypal_me.trim();
  const paypal = isEmailHandle(paypalRaw)
    ? paypalRaw.toLowerCase()
    : paypalRaw
        .replace(/^https?:\/\/(www\.)?paypal\.me\//i, "")
        .replace(/^@/, "")
        .replace(/\/$/, "")
        .trim();
  if (paypal) {
    const phone = formatUsPhoneDisplay(PAYPAL_PHONE_DISPLAY);
    links.push({
      method: "paypal",
      label: "PayPal",
      handle: isEmailHandle(paypal) ? `${paypal} · ${phone}` : paypal,
      href: paypalPayUrl(paypal, amountCents, note),
    });
  }

  const zelle = settings.zelle_handle.trim();
  if (zelle) {
    const zelleDisplay = isEmailHandle(zelle) ? zelle.toLowerCase() : formatUsPhoneDisplay(zelle);
    links.push({
      method: "zelle",
      label: "Zelle",
      handle: zelleDisplay,
      href: isEmailHandle(zelle)
        ? `mailto:${encodeURIComponent(zelle.toLowerCase())}?subject=${encodeURIComponent(note)}`
        : `sms:${zelle.replace(/\D/g, "").slice(-10)}`,
    });
  }

  const bitcoin = settings.bitcoin_address.trim();
  if (bitcoin) {
    links.push({
      method: "bitcoin",
      label: "Bitcoin",
      handle: bitcoin,
      href: `bitcoin:${bitcoin}`,
    });
  }

  links.push({
    method: "cash",
    label: "Cash",
    handle: "Jaybird",
    href: "",
  });

  return Promise.all(
    links.map(async (link) => {
      if (link.method === "cash") {
        return { ...link, qrSvg: "" };
      }
      if (link.method === "zelle") {
        return {
          ...link,
          qrSvg: `<img src="${ZELLE_QR_IMG}" alt="Zelle QR for ${escapeHtml(link.handle)}" width="168" height="234" decoding="async" />`,
        };
      }
      if (link.method === "venmo") {
        return {
          ...link,
          href: amountCents > 0 ? link.href : VENMO_CODE_URL,
          qrSvg: `<img src="${VENMO_QR_IMG}" alt="Venmo QR for ${escapeHtml(link.handle)}" width="168" height="168" decoding="async" />`,
        };
      }
      if (link.method === "paypal") {
        return {
          ...link,
          qrSvg: `<img src="${PAYPAL_QR_IMG}" alt="PayPal QR for ${escapeHtml(link.handle)}" width="168" height="242" decoding="async" />`,
        };
      }
      if (link.method === "bitcoin") {
        return {
          ...link,
          qrSvg: `<img src="${BITCOIN_QR_IMG}" alt="Bitcoin QR for ${escapeHtml(link.handle)}" width="168" height="168" decoding="async" />`,
        };
      }
      return {
        ...link,
        qrSvg: await QRCode.toString(link.href, {
          type: "svg",
          margin: 1,
          width: 168,
          errorCorrectionLevel: "M",
          color: { dark: "#0b1220", light: "#ffffff" },
        }),
      };
    }),
  );
}

function emergencyAccessBlock(opts: {
  settings: Settings;
  mac: string | null;
  quickCooldownMs: number;
  membersUnlocked: boolean;
  membersGateChallenge: { id: string; question: string; answerLabel: string };
  methods?: PayMethodLink[];
  playaName?: string;
  draft?: {
    amount_cents: number | null;
    method: string;
    guest_handle: string;
    playa_name: string;
  };
  error?: string;
  guestHoldActive?: boolean;
  reservedGb?: number | null;
}): string {
  const {
    settings,
    mac,
    quickCooldownMs,
    membersUnlocked,
    membersGateChallenge,
    methods = [],
    playaName = "",
    draft,
    error,
    guestHoldActive = false,
    reservedGb = null,
  } = opts;
  const gateQuestion = membersGateChallenge.question;
  const gateAnswerLabel = membersGateChallenge.answerLabel;
  const gateChallengeId = membersGateChallenge.id;
  const hasPayMethod = true; // cash is always available
  const onQuickCooldown = quickCooldownMs > 0;
  const cooldownLabel = formatCooldownMinutes(quickCooldownMs);

  const fullAccessButton = hasPayMethod
    ? `<button type="button" class="btn quiet" id="full-access-open">Phage VIP - I wants ur internetz right now thx.</button>`
    : `<p class="warn">Payment links are not configured yet. Ask camp admin.</p>`;

  const donationBlock = fullAccessFormFields({
    mac,
    playaName,
    methods,
    draft,
    error,
  });

  const quickBlock = onQuickCooldown
    ? `<p class="warn" style="margin:0.75rem 0 0">Try again in about ${escapeHtml(cooldownLabel)}.</p>`
    : !mac
      ? `<p class="err" style="margin:0.75rem 0 0">Could not identify this device. Reconnect to Wi‑Fi.</p>`
      : `<form method="POST" action="/quick" id="quick-access-form">
                  <input type="hidden" name="mac" value="${escapeHtml(mac)}" />
                  <button class="btn quiet" type="button" id="quick-access-open">Can i haz internet just really quick pls? - Visitors (10 min)</button>
                </form>`;

  const internetButtonsBlock = guestHoldActive
    ? `<p class="warn" style="margin:0.75rem 0 0">New guest internet is paused — ${escapeHtml(formatGb(reservedGb ?? DEFAULT_RESERVED_GB))} GB is held for Monday. Ask Jaybird if this is an emergency.</p>`
    : `<div class="access-sub">
        ${quickBlock}
        <div style="margin-top:0.85rem">${fullAccessButton}</div>
      </div>`;

  return `
    <div class="panel" id="full-access-section">
      <h2 class="access-kicker">Internet for Emergencies Only</h2>
      ${guestHoldActive ? "" : `<div class="access-sub">${donationBlock}</div>`}
      ${internetButtonsBlock}
    </div>
    ${
      !guestHoldActive && ((!onQuickCooldown && mac) || hasPayMethod)
        ? `<dialog class="leave-dialog" id="leave-brc-dialog" aria-labelledby="leave-brc-title">
            <div class="leave-dialog-inner">
              <div class="leave-dialog-badge">Warning</div>
              <h2 id="leave-brc-title">You are leaving Black Rock City and going to the Default World. Are you sure?</h2>
              <form method="dialog">
                <button class="btn leave-stay" value="cancel">Nevermind. I don't want to leave the party!</button>
                <button class="btn leave-confirm" value="confirm" id="leave-brc-confirm">Yes, I understand.</button>
              </form>
            </div>
          </dialog>
          <dialog class="leave-dialog" id="members-gate-dialog" aria-labelledby="members-gate-title">
            <div class="leave-dialog-inner">
              <div class="leave-dialog-badge">Members Only</div>
              <h2 id="members-gate-title">${escapeHtml(gateQuestion)}</h2>
              <form id="members-gate-form">
                <input type="hidden" name="challenge" id="members-gate-challenge" value="${escapeHtml(gateChallengeId)}" />
                <label for="members-gate-answer">${escapeHtml(gateAnswerLabel)}</label>
                <input id="members-gate-answer" name="answer" type="text" autocomplete="off" required autofocus />
                <p class="err" id="members-gate-error" hidden style="margin:0.65rem 0 0"></p>
                <button class="btn leave-confirm" type="submit" style="margin-top:0.9rem">Unlock</button>
                <button class="btn leave-stay" type="button" id="members-gate-cancel" value="cancel">Cancel</button>
              </form>
            </div>
          </dialog>
          <script>
            (function () {
              var dialog = document.getElementById("leave-brc-dialog");
              var membersDialog = document.getElementById("members-gate-dialog");
              var membersForm = document.getElementById("members-gate-form");
              var membersAnswer = document.getElementById("members-gate-answer");
              var membersError = document.getElementById("members-gate-error");
              var membersCancel = document.getElementById("members-gate-cancel");
              var membersChallenge = document.getElementById("members-gate-challenge");
              var quickBtn = document.getElementById("quick-access-open");
              var fullBtn = document.getElementById("full-access-open");
              var quickForm = document.getElementById("quick-access-form");
              var membersUnlocked = ${membersUnlocked ? "true" : "false"};
              var membersGateQuestion = ${JSON.stringify(gateQuestion)};
              var membersGateChallengeId = ${JSON.stringify(gateChallengeId)};
              if (!dialog) return;
              var pending = null;
              var showWarningAfterMembers = false;

              function goFullAccess() {
                var form = document.getElementById("full-access-form");
                var outside = ${JSON.stringify(OUTSIDE_BROWSE_HREF)};
                if (!form) {
                  window.location.href = outside;
                  return;
                }
                var amountEl = document.getElementById("donation-tier");
                var methodEl = document.getElementById("pay-method");
                var customEl = document.getElementById("custom-amount");
                var hasMethod = methodEl && methodEl.value;
                var presetCents = amountEl && amountEl.value && amountEl.value !== "custom"
                  ? parseInt(amountEl.value, 10)
                  : NaN;
                var customOk = amountEl && amountEl.value === "custom" && customEl && parseFloat(customEl.value) > 0;
                var paidReady = (presetCents > 0 || customOk) && hasMethod;
                if (!paidReady && amountEl) amountEl.value = "0";
                if (methodEl) {
                  methodEl.required = false;
                  methodEl.disabled = false;
                }
                form.onsubmit = null;
                form.removeAttribute("onsubmit");
                form.submit();
              }

              function otherOpenDialog(except) {
                var nodes = document.querySelectorAll("dialog");
                for (var i = 0; i < nodes.length; i++) {
                  if (nodes[i] !== except && nodes[i].open) return nodes[i];
                }
                return null;
              }

              /** Open a modal only after the previous one has left the top layer. */
              function showModalWhenReady(el, thenFn) {
                if (!el) return;
                if (typeof el.showModal !== "function") {
                  if (thenFn) thenFn();
                  return;
                }
                var tries = 0;
                function tryOpen() {
                  if (otherOpenDialog(el)) {
                    if (tries++ < 20) setTimeout(tryOpen, 16);
                    return;
                  }
                  try {
                    el.returnValue = "";
                    if (!el.open) el.showModal();
                  } catch (err) {
                    if (tries++ < 20) setTimeout(tryOpen, 32);
                    return;
                  }
                  if (thenFn) thenFn();
                }
                requestAnimationFrame(function () {
                  requestAnimationFrame(tryOpen);
                });
              }

              function openLeaveWarning(action) {
                pending = action;
                if (typeof dialog.showModal === "function") {
                  showModalWhenReady(dialog);
                  return;
                }
                if (action === "quick" && quickForm) quickForm.submit();
                else if (action === "full") goFullAccess();
              }

              /** Always: secret question first, then Default World warning. */
              function openMembersGate() {
                showWarningAfterMembers = false;
                if (membersError) {
                  membersError.hidden = true;
                  membersError.textContent = "";
                }
                if (membersAnswer) membersAnswer.value = "";
                if (membersDialog && typeof membersDialog.showModal === "function") {
                  showModalWhenReady(membersDialog, function () {
                    if (membersAnswer) {
                      try { membersAnswer.focus(); } catch (e) {}
                    }
                  });
                  return;
                }
                var guess = window.prompt(membersGateQuestion);
                if (guess == null) return;
                submitMembersAnswer(guess);
              }

              function afterMembersUnlocked() {
                membersUnlocked = true;
                showWarningAfterMembers = true;
                if (membersDialog && membersDialog.open && typeof membersDialog.close === "function") {
                  membersDialog.close();
                  return;
                }
                openLeaveWarning("full");
              }

              function submitMembersAnswer(answer) {
                if (membersError) {
                  membersError.hidden = true;
                  membersError.textContent = "";
                }
                var challengeId = (membersChallenge && membersChallenge.value) || membersGateChallengeId || "";
                return fetch("/members-unlock", {
                  method: "POST",
                  headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
                  body: "challenge=" + encodeURIComponent(challengeId) + "&answer=" + encodeURIComponent(String(answer || "").trim()),
                  credentials: "same-origin",
                }).then(function (res) {
                  return res.json().then(function (data) {
                    if (!res.ok || !data || !data.ok) {
                      var msg = (data && data.error) || "Incorrect answer.";
                      if (membersError) {
                        membersError.textContent = msg;
                        membersError.hidden = false;
                      } else {
                        window.alert(msg);
                      }
                      return;
                    }
                    afterMembersUnlocked();
                  });
                }).catch(function () {
                  if (membersError) {
                    membersError.textContent = "Could not verify. Try again.";
                    membersError.hidden = false;
                  }
                });
              }

              if (quickBtn) quickBtn.addEventListener("click", function () { openLeaveWarning("quick"); });
              if (fullBtn) {
                fullBtn.addEventListener("click", function () {
                  if (membersUnlocked) openLeaveWarning("full");
                  else openMembersGate();
                });
              }

              dialog.addEventListener("close", function () {
                if (dialog.returnValue !== "confirm") {
                  pending = null;
                  return;
                }
                if (pending === "quick" && quickForm) quickForm.submit();
                else if (pending === "full") goFullAccess();
              });

              if (membersDialog) {
                membersDialog.addEventListener("close", function () {
                  if (!showWarningAfterMembers) return;
                  showWarningAfterMembers = false;
                  openLeaveWarning("full");
                });
              }

              if (membersCancel && membersDialog) {
                membersCancel.addEventListener("click", function () {
                  showWarningAfterMembers = false;
                  if (typeof membersDialog.close === "function") membersDialog.close();
                });
              }

              if (membersForm) {
                membersForm.addEventListener("submit", function (ev) {
                  ev.preventDefault();
                  submitMembersAnswer(membersAnswer ? membersAnswer.value : "");
                });
              }
            })();
          </script>`
        : ""
    }`;
}

export function guestPaywallPage(opts: {
  settings: Settings;
  mac: string | null;
  allowed: boolean;
  paidUntil: number | null;
  weather: BrcWeather;
  air?: AirQuality | null;
  playaName?: string;
  askPlayaName?: boolean;
  canceled?: boolean;
  error?: string;
  starlinkData?: StarlinkDataOperatorView;
  dataFlash?: string;
  dataError?: string;
}): string {
  const {
    settings,
    mac,
    allowed,
    paidUntil,
    weather,
    air = null,
    askPlayaName = false,
    canceled,
    error,
    starlinkData,
    dataFlash,
    dataError,
  } = opts;
  const wxCenter = getWeatherCenter();
  const watchDutyHref = watchDutyMapUrl(wxCenter.lat, wxCenter.lon, 8);

  const dashboardBlock = `
      <div class="wx-dashboard">
        <h3><a href="${escapeHtml(OUTSIDE_BROWSE_HREF)}" target="_blank" rel="noopener">BRC Weather Dashboard Information</a></h3>
        <p class="meta" style="margin:0">Official playa briefing · from burningman.org</p>
        <div class="wx-dashboard-body">
        ${
          weather.dashboard.error && !weather.dashboard.paragraphs.length
            ? `<p class="warn">Dashboard text unavailable (${escapeHtml(weather.dashboard.error)}).</p>`
            : weather.dashboard.paragraphs
                .map((para) => `<p>${escapeHtml(para)}</p>`)
                .join("")
        }
        </div>
      </div>`;

  const weatherPanel = `
    <div class="panel wx-panel">
      ${wxUnitToggle()}
      <h2 class="wx-panel-title">${escapeHtml(WEATHER_SITE_LABEL)} Weather</h2>
      ${
        weather.error || !weather.hours.length
          ? `<p class="warn">Forecast temporarily unavailable${weather.error ? ` (${escapeHtml(weather.error)})` : ""}.</p>
             ${air ? `<div class="wx-now">${renderAqiChip(air)}</div>` : ""}`
          : renderHourlyForecastChart(weather, air)
      }
      <script>
        (function () {
          var KEY = "wx-temp-unit";
          function readUnit() {
            try {
              return localStorage.getItem(KEY) === "C" ? "C" : "F";
            } catch (e) {
              return "F";
            }
          }
          function writeUnit(unit) {
            try { localStorage.setItem(KEY, unit); } catch (e) {}
          }
          function fromF(f, unit) {
            var n = Number(f);
            if (!isFinite(n)) return "";
            if (unit === "C") n = (n - 32) * 5 / 9;
            return String(Math.round(n));
          }
          function apply(unit) {
            document.querySelectorAll(".wx-now-temp").forEach(function (el) {
              el.textContent = fromF(el.getAttribute("data-temp-f"), unit) + "°" + unit;
            });
            document.querySelectorAll(".wx-now-range").forEach(function (el) {
              el.textContent = fromF(el.getAttribute("data-temp-hi-f"), unit) + "°/" +
                fromF(el.getAttribute("data-temp-lo-f"), unit) + "°";
            });
            document.querySelectorAll(".wx-legend-temp").forEach(function (el) {
              el.textContent = "Temp °" + unit;
            });
            document.querySelectorAll(".wx-temp-tick").forEach(function (el) {
              el.textContent = fromF(el.getAttribute("data-temp-f"), unit) + "°";
            });
            document.querySelectorAll(".wx-unit-btn").forEach(function (btn) {
              var on = btn.getAttribute("data-wx-unit") === unit;
              btn.classList.toggle("is-active", on);
              btn.setAttribute("aria-pressed", on ? "true" : "false");
            });
          }
          document.querySelectorAll(".wx-unit-btn").forEach(function (btn) {
            btn.addEventListener("click", function () {
              var unit = btn.getAttribute("data-wx-unit") === "C" ? "C" : "F";
              writeUnit(unit);
              apply(unit);
            });
          });
          apply(readUnit());
        })();
      </script>
      ${dashboardBlock}
      <div class="wx-radar">
        <h3>Weather Radar &amp; Wildfire</h3>
        <p class="meta" style="margin:0">Precipitation · Ground Smoke</p>
        <div id="wx-radar-host" class="wx-radar-map-host" aria-label="Weather, smoke, and wildfire map"></div>
        <div class="wx-radar-scale"><span>Light rain</span><i></i><span>Heavy</span></div>
        <div class="wx-radar-overlays">
          <span><i class="wx-lg-smoke"></i> Ground Smoke</span>
        </div>
        <p class="wx-radar-links">
          <a id="wx-watchduty-link" href="${escapeHtml(watchDutyHref)}" target="_blank" rel="noopener">Watch Duty map</a>
        </p>
        <link rel="stylesheet" href="/vendor/leaflet/leaflet.css" />
        <script src="/vendor/leaflet/leaflet.js"></script>
        <script>
          (function () {
            var host = document.getElementById("wx-radar-host");
            if (!host || !window.L) {
              if (host) host.innerHTML = '<p class="wx-radar-fallback warn">Map library unavailable.</p>';
              return;
            }
            fetch("/api/weather-radar", { cache: "no-store" })
              .then(function (r) { return r.json(); })
              .then(function (data) {
                var radar = (data && data.radar) || {};
                var frames = Array.isArray(radar.frames) ? radar.frames : [];
                var hazards = (data && data.hazards) || {};
                var lat = Number(radar.lat);
                var lon = Number(radar.lon);
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                  lat = Number(data && data.geo && data.geo.lat);
                  lon = Number(data && data.geo && data.geo.lon);
                }
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                  host.innerHTML = '<p class="wx-radar-fallback warn">Map temporarily unavailable.</p>';
                  return;
                }
                var wd = document.getElementById("wx-watchduty-link");
                if (wd && hazards.watchDutyUrl) wd.setAttribute("href", hazards.watchDutyUrl);

                var wrap = document.createElement("div");
                wrap.className = "wx-radar-map-wrap";
                var mapEl = document.createElement("div");
                mapEl.className = "wx-radar-leaflet";
                var controls = document.createElement("div");
                controls.className = "wx-radar-controls";
                controls.setAttribute("aria-hidden", "true");
                var progress = document.createElement("div");
                progress.className = "wx-radar-progress";
                var progressFill = document.createElement("div");
                progressFill.className = "wx-radar-progress-fill";
                progress.appendChild(progressFill);
                var timeEl = document.createElement("span");
                timeEl.className = "wx-radar-time";
                controls.appendChild(progress);
                controls.appendChild(timeEl);
                wrap.appendChild(mapEl);
                wrap.appendChild(controls);
                host.replaceChildren(wrap);
                if (!frames.length) controls.style.display = "none";

                var maxZoom = Number(radar.maxZoom) || 12;
                var minZoom = Number(radar.minZoom) || 5;
                var startZoom = Number(radar.zoom);
                if (!Number.isFinite(startZoom)) startZoom = 8;
                var blendMs = Number(radar.blendMs);
                if (!Number.isFinite(blendMs) || blendMs < 80) blendMs = 220;
                var opacity = Number(radar.opacity);
                if (!Number.isFinite(opacity)) opacity = 0.72;
                var radiusMi = Number(radar.radiusMi);
                if (!Number.isFinite(radiusMi) || radiusMi <= 0) radiusMi = 40;
                var map = L.map(mapEl, {
                  zoomControl: true,
                  attributionControl: false,
                  fadeAnimation: false,
                  scrollWheelZoom: false,
                  center: [lat, lon],
                  zoom: startZoom,
                  minZoom: minZoom,
                });
                map.createPane("smokePane");
                map.getPane("smokePane").style.zIndex = 450;
                map.createPane("roadsPane");
                map.getPane("roadsPane").style.zIndex = 455;
                map.getPane("roadsPane").style.pointerEvents = "none";
                map.createPane("firePane");
                map.getPane("firePane").style.zIndex = 460;
                var bm = radar.basemap || {};
                L.tileLayer(bm.url || "/wx-tiles/sat/{z}/{x}/{y}.jpg", {
                  attribution: "",
                  maxZoom: Math.max(maxZoom, 18),
                  maxNativeZoom: 18,
                  minZoom: minZoom,
                }).addTo(map);
                L.tileLayer("/wx-tiles/roads/{z}/{x}/{y}.png", {
                  attribution: "",
                  maxZoom: Math.max(maxZoom, 18),
                  maxNativeZoom: 18,
                  minZoom: minZoom,
                  pane: "roadsPane",
                  opacity: 0.92,
                }).addTo(map);

                var frameIndex = Math.max(0, frames.length - 1);
                for (var i = 0; i < frames.length; i++) {
                  if (frames[i].isCurrent) { frameIndex = i; break; }
                }

                var layers = frames.map(function (frame, i) {
                  return L.tileLayer(frame.urlTemplate, {
                    opacity: 0,
                    maxZoom: maxZoom,
                    maxNativeZoom: maxZoom,
                    minZoom: minZoom,
                    zIndex: 200 + i,
                    updateWhenIdle: false,
                    updateWhenZooming: false,
                    keepBuffer: 4,
                    className: "wx-radar-layer",
                    crossOrigin: true,
                  }).addTo(map);
                });

                function centerBrc() {
                  map.fitBounds(L.latLng(lat, lon).toBounds(radiusMi * 2 * 1609.344), {
                    animate: false,
                    padding: [12, 12],
                  });
                }
                centerBrc();

                var smokeFrames = Array.isArray(hazards.smokeFrames) ? hazards.smokeFrames : [];
                var smokeBounds = hazards.smokeBounds || [[32, -160], [70, -52]];
                var smokeOp = Number(hazards.smokeOpacity);
                if (!Number.isFinite(smokeOp)) smokeOp = 0.65;
                var smokeLayers = smokeFrames.map(function (sf) {
                  return L.imageOverlay(sf.url, smokeBounds, {
                    opacity: 0,
                    pane: "smokePane",
                    className: "wx-smoke-layer",
                    crossOrigin: true,
                  }).addTo(map);
                });

                function smokeIdxForFrame(idx) {
                  var t = Number(frames[idx] && frames[idx].time);
                  if (!Number.isFinite(t) || !smokeFrames.length) return -1;
                  var hour = Math.floor(t / 3600) * 3600;
                  var best = 0;
                  var bestD = Infinity;
                  for (var si = 0; si < smokeFrames.length; si++) {
                    var d = Math.abs(Number(smokeFrames[si].time) - hour);
                    if (d < bestD) {
                      bestD = d;
                      best = si;
                    }
                  }
                  return best;
                }

                function setSmokeOpacities(fromSi, toSi, mix) {
                  for (var i = 0; i < smokeLayers.length; i++) {
                    var op = 0;
                    if (i === toSi) op = smokeOp * mix;
                    if (i === fromSi) op += smokeOp * (1 - mix);
                    if (fromSi === toSi && i === toSi) op = smokeOp;
                    smokeLayers[i].setOpacity(op);
                  }
                }

                function showSmokeForFrame(idx) {
                  setSmokeOpacities(smokeIdxForFrame(idx), smokeIdxForFrame(idx), 1);
                }
                if (hazards.perimeters && hazards.perimeters.features && hazards.perimeters.features.length) {
                  L.geoJSON(hazards.perimeters, {
                    pane: "firePane",
                    style: {
                      color: "#ff7a18",
                      weight: 2.25,
                      fillColor: "#ff4d00",
                      fillOpacity: 0.22,
                    },
                    onEachFeature: function (feat, layer) {
                      var p = (feat && feat.properties) || {};
                      var acres = p.acres != null ? Math.round(Number(p.acres)).toLocaleString() + " ac" : "";
                      var contained = p.contained != null ? Math.round(Number(p.contained)) + "% contained" : "";
                      var bits = [p.name || "Fire", acres, contained].filter(Boolean);
                      layer.bindPopup(bits.join(" · "));
                    },
                  }).addTo(map);
                }

                L.circleMarker([lat, lon], {
                  radius: 5,
                  color: "#8eb8ff",
                  weight: 2,
                  fillColor: "#cfe0ff",
                  fillOpacity: 0.85,
                }).addTo(map);

                var flameSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><path fill="#ff3b00" d="M16 2c2 6-4 8-3 14 0 0 6-3 7-9 5 5 8 10 8 15a12 12 0 1 1-24 0C4 14 10 10 16 2z"/><path fill="#ffd166" d="M16 14c1.2 3-1.5 4.2-1 7.2 0 0 3-1.5 3.4-4.5 2.2 2.4 3.6 4.6 3.6 7.3A6 6 0 1 1 10 24c0-3.6 3.2-5.8 6-10z"/></svg>';
                var flameIcon = L.divIcon({
                  className: "wx-flame-icon",
                  html: flameSvg,
                  iconSize: [28, 28],
                  iconAnchor: [14, 26],
                  popupAnchor: [0, -22],
                });
                var fires = Array.isArray(hazards.fires) ? hazards.fires : [];
                for (var fi = 0; fi < fires.length; fi++) {
                  var fire = fires[fi];
                  var fy = Number(fire.lat);
                  var fx = Number(fire.lon);
                  if (!Number.isFinite(fy) || !Number.isFinite(fx)) continue;
                  var acresTxt = fire.acres != null ? Math.round(Number(fire.acres)).toLocaleString() + " ac" : "";
                  var containTxt = fire.contained != null ? Math.round(Number(fire.contained)) + "% contained" : "";
                  var pop = [fire.name || "Fire", acresTxt, containTxt, fire.behavior].filter(Boolean).join(" · ");
                  L.marker([fy, fx], { icon: flameIcon, zIndexOffset: 400 }).addTo(map).bindPopup(pop);
                }

                centerBrc();

                var BUFFER_AHEAD = Math.min(8, Math.max(3, frames.length));
                var preloadCache = Object.create(null);
                var layerOp = [];
                var playing = false;
                var loopStart = 0;
                var lastPrefetchFrom = -1;
                var weights = frames.map(function (f) {
                  return f && f.isCurrent ? 1.15 : 1;
                });
                var weightSum = 0;
                for (var wi = 0; wi < weights.length; wi++) weightSum += weights[wi];

                function preloadUrl(url) {
                  if (!url) return Promise.resolve(false);
                  if (preloadCache[url]) return preloadCache[url];
                  preloadCache[url] = new Promise(function (resolve) {
                    var img = new Image();
                    img.decoding = "async";
                    img.onload = function () { resolve(true); };
                    img.onerror = function () { resolve(false); };
                    img.src = url;
                  });
                  return preloadCache[url];
                }

                function tileUrlsForFrame(frame) {
                  if (!frame || !frame.urlTemplate) return [];
                  var z = map.getZoom();
                  var b = map.getBounds();
                  var nw = map.project(b.getNorthWest(), z);
                  var se = map.project(b.getSouthEast(), z);
                  var pad = 256;
                  var minX = Math.floor((nw.x - pad) / 256);
                  var maxX = Math.floor((se.x + pad) / 256);
                  var minY = Math.floor((nw.y - pad) / 256);
                  var maxY = Math.floor((se.y + pad) / 256);
                  var n = Math.pow(2, z);
                  var urls = [];
                  for (var x = minX; x <= maxX; x++) {
                    for (var y = minY; y <= maxY; y++) {
                      if (y < 0 || y >= n) continue;
                      var xx = ((x % n) + n) % n;
                      urls.push(
                        frame.urlTemplate
                          .replace("{z}", String(z))
                          .replace("{x}", String(xx))
                          .replace("{y}", String(y))
                      );
                    }
                  }
                  return urls;
                }

                function prefetchFrame(idx) {
                  var frame = frames[idx];
                  if (!frame) return Promise.resolve();
                  var urls = tileUrlsForFrame(frame);
                  var si = smokeIdxForFrame(idx);
                  if (si >= 0 && smokeFrames[si] && smokeFrames[si].url) {
                    urls.push(smokeFrames[si].url);
                  }
                  return Promise.all(urls.map(preloadUrl));
                }

                function fillBuffer(fromIdx, count) {
                  var n = Math.min(count || BUFFER_AHEAD, frames.length);
                  var idxs = [];
                  for (var i = 0; i < n; i++) {
                    idxs.push((fromIdx + i + frames.length) % frames.length);
                  }
                  var k = 0;
                  function worker() {
                    if (k >= idxs.length) return Promise.resolve();
                    var fi = idxs[k++];
                    return prefetchFrame(fi).then(worker);
                  }
                  var workers = [];
                  var wc = Math.min(3, idxs.length);
                  for (var j = 0; j < wc; j++) workers.push(worker());
                  return Promise.all(workers);
                }

                function updateChrome(fromIdx, toIdx, mix) {
                  var m = mix == null ? 1 : mix;
                  var denom = Math.max(1, frames.length - 1);
                  var pos;
                  if (toIdx < fromIdx) {
                    pos = m < 1 ? 1 : 0;
                  } else {
                    pos = (fromIdx + (toIdx - fromIdx) * m) / denom;
                  }
                  progressFill.style.width = pos * 100 + "%";
                  var frame = frames[m < 0.5 ? fromIdx : toIdx];
                  timeEl.textContent = frame && frame.label ? frame.label : "";
                }

                function setLayerOpacity(idx, op) {
                  if (!layers[idx]) return;
                  if (layerOp[idx] === op) return;
                  layerOp[idx] = op;
                  layers[idx].setOpacity(op);
                }

                function lerpUnix(fromIdx, toIdx, mix) {
                  var a = Number(frames[fromIdx] && frames[fromIdx].time);
                  var b = Number(frames[toIdx] && frames[toIdx].time);
                  if (!Number.isFinite(a)) return b;
                  if (!Number.isFinite(b) || b < a) return mix < 0.5 ? a : b;
                  return a + (b - a) * mix;
                }

                function applySmokeUnix(unix) {
                  if (!smokeLayers.length) return;
                  if (smokeFrames.length === 1) {
                    smokeLayers[0].setOpacity(smokeOp);
                    return;
                  }
                  var t = Number(unix);
                  if (!Number.isFinite(t)) {
                    showSmokeForFrame(frameIndex);
                    return;
                  }
                  var i1 = 0;
                  for (var i = 0; i < smokeFrames.length - 1; i++) {
                    if (Number(smokeFrames[i].time) <= t) i1 = i;
                  }
                  var i2 = Math.min(i1 + 1, smokeFrames.length - 1);
                  var t1 = Number(smokeFrames[i1].time);
                  var t2 = Number(smokeFrames[i2].time);
                  var u = i1 === i2 || t2 === t1 ? 1 : (t - t1) / (t2 - t1);
                  u = Math.max(0, Math.min(1, u));
                  setSmokeOpacities(i1, i2, u);
                }

                function playheadAt(now) {
                  var loopMs = Math.max(1, blendMs * weightSum);
                  var u = (now - loopStart) % loopMs;
                  if (u < 0) u += loopMs;
                  var acc = 0;
                  for (var i = 0; i < frames.length; i++) {
                    var span = weights[i] * blendMs;
                    if (u <= acc + span || i === frames.length - 1) {
                      var local = span <= 0 ? 1 : (u - acc) / span;
                      local = Math.max(0, Math.min(1, local));
                      return { from: i, to: (i + 1) % frames.length, mix: local };
                    }
                    acc += span;
                  }
                  return { from: 0, to: Math.min(1, frames.length - 1), mix: 0 };
                }

                function showInitial(idx) {
                  frameIndex = idx;
                  updateChrome(idx, idx, 1);
                  showSmokeForFrame(idx);
                  for (var j = 0; j < layers.length; j++) {
                    setLayerOpacity(j, j === idx ? opacity : 0);
                  }
                }

                function paint(now) {
                  if (!playing || layers.length < 2) return;
                  var ph = playheadAt(now);
                  var from = ph.from;
                  var to = ph.to;
                  var mix = ph.mix;
                  if (from !== lastPrefetchFrom) {
                    lastPrefetchFrom = from;
                    frameIndex = from;
                    fillBuffer((to + 1) % frames.length, BUFFER_AHEAD);
                  }
                  setLayerOpacity(from, opacity * (1 - mix));
                  if (to !== from) setLayerOpacity(to, opacity * mix);
                  for (var j = 0; j < layers.length; j++) {
                    if (j !== from && j !== to) setLayerOpacity(j, 0);
                  }
                  applySmokeUnix(lerpUnix(from, to, mix));
                  updateChrome(from, to, mix);
                  requestAnimationFrame(paint);
                }

                function begin() {
                  if (playing) return;
                  playing = true;
                  loopStart = performance.now();
                  requestAnimationFrame(paint);
                }

                if (layers.length) {
                  showInitial(0);
                  requestAnimationFrame(function () {
                    map.invalidateSize();
                    centerBrc();
                    for (var s = 0; s < smokeFrames.length; s++) preloadUrl(smokeFrames[s].url);
                    fillBuffer(0, Math.min(3, BUFFER_AHEAD)).then(begin);
                    fillBuffer(0, frames.length);
                    setTimeout(begin, 900);
                    map.on("zoomend moveend", function () {
                      fillBuffer(frameIndex, BUFFER_AHEAD);
                    });
                  });
                } else {
                  requestAnimationFrame(function () {
                    map.invalidateSize();
                    centerBrc();
                  });
                }
              })
              .catch(function () {
                host.innerHTML = '<p class="wx-radar-fallback warn">Radar temporarily unavailable.</p>';
              });
          })();
        </script>
      </div>
    </div>`;

  const dataPanel =
    starlinkData?.operator
      ? starlinkDataPanel({
          view: starlinkData,
          flash: dataFlash,
          error: dataError,
          compact: true,
        })
      : "";

  const resetAccessButton = mac
    ? `<form method="POST" action="/reset-access" style="margin-top:0.75rem">
        <button class="btn small danger" type="submit">Testing: revoke my internet access</button>
      </form>`
    : "";

  if (allowed) {
    return layout(
      "Connected",
      `
      ${guestBrand()}
      ${dataPanel}
      <h1>Welcome to ${escapeHtml(settings.camp_name)}</h1>
      ${saveHomePageBlock()}
      ${bmirListenButton()}
      ${innovateAppsPanel()}
      ${weatherPanel}
      <p class="ok">This device is unlocked${paidUntil ? ` until ${escapeHtml(new Date(paidUntil).toLocaleString())}` : ""}.</p>
      <div class="panel">
        <p class="meta">Device: ${escapeHtml(mac ?? "unknown")}</p>
        <a class="btn" href="${escapeHtml(OUTSIDE_BROWSE_HREF)}">Continue browsing</a>
        ${resetAccessButton}
      </div>
      ${playaNameGate(askPlayaName)}
      `,
    );
  }

  const deviceNote = mac ?? "unknown";

  return layout(
    settings.camp_name,
    `
    ${guestBrand()}
    ${dataPanel}
    <h1>Welcome to Phage Camp<br>Emergency Starlink by Jaybird</h1>
    ${saveHomePageBlock()}
    ${bmirListenButton()}
    ${weatherPanel}
    ${innovateAppsPanel()}
    <div class="panel">
      <a class="btn" href="/access">Emergency Internet Access</a>
    </div>
    ${canceled ? `<p class="warn">Checkout canceled. Try again when ready.</p>` : ""}
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    ${!mac ? `<p class="err">Could not identify this device. Reconnect to Wi‑Fi and open http://${escapeHtml(config.portalIp)}:${config.portalPort}/</p>` : ""}
    <p class="meta">Device: ${escapeHtml(deviceNote)}</p>
    ${playaNameGate(askPlayaName)}
    `,
  );
}

function fullAccessIntro(error?: string): string {
  return `
    <div class="panel access-intro">
      <p class="lede">Internet access on playa isn’t really supposed to be a gifting thing I’m bringing to playa. I brought it because part of my work involves being on call during hurricane season. I don’t want to impact the collective digital detox out on playa so <strong>please consider before using</strong>. Payment is considered to be an <strong>optional donation</strong> and is appreciated but not required.</p>
      <p class="access-note">Also please ask for consent before sharing any news from the Default World that you might see online. We want to respect that others may be wanting to take a break from news exposure for the week.</p>
      ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    </div>`;
}

function fullAccessFormFields(opts: {
  mac: string | null;
  playaName?: string;
  methods: PayMethodLink[];
  draft?: {
    amount_cents: number | null;
    method: string;
    guest_handle: string;
    playa_name: string;
  };
  error?: string;
  showContinue?: boolean;
}): string {
  const { mac, playaName = "", methods, draft, error, showContinue = false } = opts;
  const knownPlaya = (playaName || draft?.playa_name || "").trim();
  const playaField = knownPlaya
    ? `<input type="hidden" name="playa_name" value="${escapeHtml(knownPlaya)}" />`
    : `<label for="full-burner-name">Burner name</label>
        <input id="full-burner-name" name="playa_name" value="${escapeHtml(draft?.playa_name || "")}" placeholder="Your burner name" required maxlength="48" />`;

  const methodOptions = methods
    .map((m) => `<option value="${escapeHtml(m.method)}">${escapeHtml(m.label)}</option>`)
    .join("");

  const methodsJson = JSON.stringify(
    Object.fromEntries(
      methods.map((m) => [
        m.method,
        {
          label: m.label,
          handle: m.handle,
          href: m.href,
          appHref: m.appHref || m.href,
          qrSvg: m.qrSvg,
        },
      ]),
    ),
  );

  const donationOptions = DONATION_TIERS.map(
    (t) => `<option value="${t.cents}">${escapeHtml(t.label)}</option>`,
  ).join("");

  if (!mac) {
    return `<p class="err">Could not identify this device. Reconnect to Wi‑Fi and open http://${escapeHtml(config.portalIp)}:${config.portalPort}/</p>`;
  }
  if (!methods.length) {
    return `<p class="warn">No payment methods configured. Ask camp admin to add Venmo, PayPal, Zelle, or Bitcoin.</p>`;
  }

  return `
          ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
          <form method="POST" action="/pay/manual" id="full-access-form" class="access-pay" autocomplete="off"${showContinue ? "" : ` onsubmit="return false;"`}>
          <input type="hidden" name="mac" value="${escapeHtml(mac)}" />
          <h3 class="access-tax">Default World Access Tax</h3>
          ${playaField}
          <label for="donation-tier">Amount</label>
          <select id="donation-tier" name="amount_cents" required autocomplete="off">
            <option value="" disabled selected>– Select –</option>
            ${donationOptions}
            <option value="custom">Custom amount</option>
          </select>
          <div id="custom-amount-wrap" hidden>
            <label for="custom-amount">Custom Amount</label>
            <input id="custom-amount" name="custom_amount" type="number" min="1" max="1000" step="0.01" inputmode="decimal" placeholder="25.00" value="" autocomplete="off" />
          </div>
          <div id="pay-method-wrap" class="pay-method-field">
            <label for="pay-method">Payment method</label>
            <select id="pay-method" name="method" required autocomplete="off">
              <option value="" disabled selected>– Select –</option>
              ${methodOptions}
            </select>
          </div>
          <div id="pay-to-panel" class="pay-method" hidden>
            <h3 id="pay-to-title" style="margin-top:0"></h3>
            <p class="meta" id="pay-to-copy" style="margin:0"></p>
            <div class="pay-qr" id="pay-to-qr" aria-hidden="true"></div>
            <p class="meta pay-qr-hint" id="pay-to-hint" hidden>Scan with your phone</p>
            <a class="btn" id="pay-to-open" href="#" target="_blank" rel="noopener" hidden>Open app</a>
          </div>
          ${
            showContinue
              ? `<button class="btn" type="submit" style="margin-top:1rem">Continue online</button>`
              : ""
          }
          <p class="meta" id="access-draft-status" style="margin:0.75rem 0 0" aria-live="polite"></p>
        </form>
        <script type="application/json" id="pay-methods-data">${methodsJson.replace(/</g, "\\u003c")}</script>
        <script>
          (function () {
            var methods = {};
            try {
              methods = JSON.parse(document.getElementById("pay-methods-data").textContent || "{}");
            } catch (e) {}
            var methodEl = document.getElementById("pay-method");
            var methodWrap = document.getElementById("pay-method-wrap");
            var amountEl = document.getElementById("donation-tier");
            var customWrap = document.getElementById("custom-amount-wrap");
            var customEl = document.getElementById("custom-amount");
            var playaEl = document.getElementById("full-burner-name");
            var draftStatus = document.getElementById("access-draft-status");
            var panel = document.getElementById("pay-to-panel");
            var title = document.getElementById("pay-to-title");
            var copy = document.getElementById("pay-to-copy");
            var qr = document.getElementById("pay-to-qr");
            var hint = document.getElementById("pay-to-hint");
            var openBtn = document.getElementById("pay-to-open");
            var mac = ${JSON.stringify(mac)};
            var saveTimer = null;
            var CUSTOM_MIN_CENTS = 100;
            var CUSTOM_MAX_CENTS = 100000;

            function moneyLabel(cents) {
              return "$" + (Number(cents) / 100).toFixed(2);
            }

            function syncCustomVisibility() {
              var isCustom = amountEl.value === "custom";
              customWrap.hidden = !isCustom;
              if (isCustom) {
                customEl.required = true;
              } else {
                customEl.required = false;
                customEl.value = "";
              }
            }

            /** Resolve selected tier or custom dollars → cents (or null if incomplete). */
            function effectiveCents() {
              var tier = amountEl.value;
              if (tier === "" || tier == null) return null;
              if (tier === "0") return 0;
              if (tier === "custom") {
                var raw = String(customEl.value || "").trim().replace(/^\\$/, "").replace(/,/g, "");
                if (!raw) return null;
                var dollars = Number(raw);
                if (!Number.isFinite(dollars)) return null;
                var cents = Math.round(dollars * 100);
                if (cents < CUSTOM_MIN_CENTS || cents > CUSTOM_MAX_CENTS) return null;
                return cents;
              }
              var n = Number(tier);
              return Number.isFinite(n) ? n : null;
            }

            /** Bake the selected tier into Venmo / PayPal open links. */
            function hrefWithAmount(href, method, handle, cents) {
              var dollars = (Number(cents) / 100).toFixed(2);
              if (method === "venmo") {
                var user = String(handle || "").replace(/^@/, "").trim();
                if (!user) return href;
                var params = new URLSearchParams({ txn: "pay", amount: dollars });
                try {
                  var existing = new URL(href, window.location.origin);
                  if (existing.searchParams.get("note")) {
                    params.set("note", existing.searchParams.get("note"));
                  }
                } catch (e) {}
                return "https://venmo.com/" + encodeURIComponent(user) + "?" + params.toString();
              }
              if (method === "paypal") {
                try {
                  var u = new URL(href, window.location.origin);
                  if (/(^|\\.)paypal\\.me$/i.test(u.hostname)) {
                    var segs = u.pathname.split("/").filter(Boolean);
                    if (segs.length >= 1) {
                      u.pathname = "/" + encodeURIComponent(decodeURIComponent(segs[0])) + "/" + dollars;
                      return u.toString();
                    }
                  }
                  // Email / _xclick links: keep business + note, swap amount for selected tier.
                  if (/(^|\\.)paypal\\.com$/i.test(u.hostname) && u.searchParams.get("cmd") === "_xclick") {
                    u.searchParams.set("amount", dollars);
                    var email = String(handle || "").split("·")[0].trim();
                    if (email.indexOf("@") !== -1) {
                      u.searchParams.set("business", email.toLowerCase());
                    }
                    return u.toString();
                  }
                } catch (e) {}
              }
              return href;
            }

            function setCopy(amt, handle, method) {
              copy.textContent = "";
              if (amt <= 0) {
                copy.appendChild(document.createTextNode("No donation needed for this option."));
                return;
              }
              if (method === "cash") {
                copy.appendChild(
                  document.createTextNode(
                    "Leave it with Jaybird or toss it in her Ambulance. Thanks!",
                  ),
                );
                return;
              }
              copy.appendChild(document.createTextNode("Send "));
              var strong = document.createElement("strong");
              strong.style.color = "var(--ink)";
              strong.textContent = moneyLabel(amt);
              copy.appendChild(strong);
              copy.appendChild(document.createTextNode(" to "));
              var h = document.createElement("span");
              h.className = "handle";
              h.textContent = handle;
              copy.appendChild(h);
              copy.appendChild(document.createTextNode("."));
            }

            function syncPayTo() {
              var m = methodEl.value;
              var cents = effectiveCents();
              var info = methods[m];
              if (!m || cents == null || cents === 0) {
                panel.hidden = true;
                return;
              }
              if (!info) {
                panel.hidden = false;
                title.textContent = "Payment method not configured";
                copy.textContent = "Ask camp admin to set up this payment method.";
                qr.innerHTML = "";
                hint.hidden = true;
                openBtn.hidden = true;
                return;
              }
              var amt = Number(cents);
              panel.hidden = false;
              title.textContent = m === "cash" ? "Cash" : "Send via " + info.label;
              setCopy(amt, info.handle, m);
              if (amt <= 0 || m === "cash") {
                qr.innerHTML = "";
                hint.hidden = true;
                openBtn.hidden = true;
                return;
              }
              if (!info.qrSvg) {
                qr.innerHTML = "";
                hint.hidden = true;
              } else {
                qr.innerHTML = info.qrSvg;
                hint.hidden = false;
              }
              if (!info.href || m === "bitcoin") {
                openBtn.hidden = true;
              } else {
                openBtn.hidden = false;
                openBtn.href = hrefWithAmount(info.href, m, info.handle, amt);
                openBtn.textContent = "Open in " + info.label;
                // sms:/mailto: should use the same tab / OS handler, not a blank tab.
                if (
                  info.href.indexOf("sms:") === 0 ||
                  info.href.indexOf("mailto:") === 0
                ) {
                  openBtn.removeAttribute("target");
                } else {
                  openBtn.setAttribute("target", "_blank");
                }
              }
            }

            function collectDraft() {
              var amount = effectiveCents();
              var method = methodEl.value || "";
              if (amount === 0) method = "";
              return {
                amount_cents: amount,
                method: method,
                guest_handle: "",
                playa_name: playaEl ? (playaEl.value || "").trim() : ${JSON.stringify(knownPlaya)},
              };
            }

            async function saveDraft() {
              if (!mac) return;
              if (draftStatus) draftStatus.textContent = "Saving…";
              try {
                var res = await fetch("/api/access/draft", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(collectDraft()),
                });
                var data = await res.json();
                if (!res.ok) {
                  if (draftStatus) draftStatus.textContent = data.error || "Could not save";
                  return;
                }
                if (draftStatus) {
                  draftStatus.textContent = "Saved for device " + data.mac;
                }
              } catch (e) {
                if (draftStatus) draftStatus.textContent = "Could not save";
              }
            }

            function scheduleSave() {
              clearTimeout(saveTimer);
              saveTimer = setTimeout(saveDraft, 280);
            }

            function syncMethodRequired() {
              var zero = effectiveCents() === 0;
              methodEl.required = !zero;
              methodEl.disabled = zero;
              if (methodWrap) methodWrap.classList.toggle("is-disabled", zero);
              if (zero) methodEl.selectedIndex = 0;
            }

            methodEl.addEventListener("change", function () {
              syncPayTo();
              scheduleSave();
            });
            amountEl.addEventListener("change", function () {
              syncMethodRequired();
              syncCustomVisibility();
              syncPayTo();
              scheduleSave();
            });
            customEl.addEventListener("input", function () {
              syncPayTo();
              scheduleSave();
            });
            if (playaEl) playaEl.addEventListener("input", scheduleSave);

            function resetSelectsToPlaceholder() {
              amountEl.selectedIndex = 0;
              methodEl.selectedIndex = 0;
              customEl.value = "";
              customEl.required = false;
              syncMethodRequired();
              syncCustomVisibility();
              syncPayTo();
            }

            // Browsers restore form controls on refresh / back-forward; force – Select –.
            resetSelectsToPlaceholder();
            window.addEventListener("pageshow", resetSelectsToPlaceholder);
          })();
        </script>`;
}

export function emergencyAccessPage(opts: {
  settings: Settings;
  mac: string | null;
  methods: PayMethodLink[];
  playaName?: string;
  askPlayaName?: boolean;
  draft?: {
    amount_cents: number | null;
    method: string;
    guest_handle: string;
    playa_name: string;
  };
  quickCooldownMs?: number;
  membersUnlocked?: boolean;
  membersGateChallenge: { id: string; question: string; answerLabel: string };
  error?: string;
  guestHoldActive?: boolean;
  reservedGb?: number | null;
}): string {
  const {
    settings,
    mac,
    methods,
    playaName = "",
    askPlayaName = false,
    draft,
    quickCooldownMs = 0,
    membersUnlocked = false,
    membersGateChallenge,
    error,
    guestHoldActive = false,
    reservedGb = null,
  } = opts;
  const deviceNote = mac ?? "unknown";
  const resetAccessButton = mac
    ? `<form method="POST" action="/reset-access" style="margin-top:0.75rem">
        <button class="btn small danger ghost" type="submit">Testing: revoke my internet access</button>
      </form>`
    : "";

  return layout(
    "Internet access",
    `
    ${guestBrand()}
    <p class="nav" style="margin:0 0 1rem"><a href="/">← Back</a></p>
    ${fullAccessIntro(error)}
    ${emergencyAccessBlock({
      settings,
      mac,
      quickCooldownMs,
      membersUnlocked,
      membersGateChallenge,
      methods,
      playaName,
      draft,
      error: undefined,
      guestHoldActive,
      reservedGb,
    })}
    <p class="meta">Device: ${escapeHtml(deviceNote)}</p>
    <p class="nav" style="margin:0.85rem 0 0"><a href="/">Back</a></p>
    ${resetAccessButton}
    ${playaNameGate(askPlayaName)}
    `,
  );
}

export function successPage(opts: { message: string; ok: boolean; mac?: string }): string {
  return layout(
    opts.ok ? "Payment successful" : "Payment pending",
    `
    <div class="brand">Starlink Paywall</div>
    <h1>${opts.ok ? "You're in" : "Almost"}</h1>
    <p class="${opts.ok ? "ok" : "warn"}">${escapeHtml(opts.message)}</p>
    ${opts.mac ? `<p class="meta">Device ${escapeHtml(opts.mac)}</p>` : ""}
    <div class="panel">
      <a class="btn" href="${escapeHtml(OUTSIDE_BROWSE_HREF)}">Continue browsing</a>
    </div>
    <script>
      // Captive portals often need a hop to mark success
      setTimeout(() => { location.href = ${JSON.stringify(OUTSIDE_BROWSE_HREF)}; }, 2500);
    </script>
    `,
  );
}

export function adminLoginPage(error?: string): string {
  return layout(
    "Admin login",
    `
    <div class="brand">Admin</div>
    <h1>Sign in</h1>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    <form method="POST" action="/admin/login" class="panel">
      <label>Password</label>
      <input type="password" name="password" autofocus required />
      <button class="btn" type="submit">Enter</button>
    </form>
    `,
  );
}

export function adminDashboard(opts: {
  settings: Settings;
  devices: Array<Device & { draft: AccessDraft | null; online_live_ms: number }>;
  pending: Payment[];
  payments: Payment[];
  siteWhitelist: SiteWhitelistEntry[];
  flash?: string;
  starlinkData?: StarlinkDataOperatorView;
}): string {
  const { settings, devices, pending, payments, siteWhitelist, flash } = opts;

  const pendingRows = pending
    .map(
      (p) => `
      <tr>
        <td>${p.id}</td>
        <td><code>${escapeHtml(p.mac)}</code><div class="meta">${escapeHtml(p.playa_name ?? "")}</div></td>
        <td>${escapeHtml(p.method)}</td>
        <td>${escapeHtml(money(p.amount_cents, settings.currency))}</td>
        <td>${escapeHtml(p.note ?? "")}</td>
        <td>
          <div class="row-actions">
            <form method="POST" action="/admin/payments/${p.id}/approve"><button class="btn small" type="submit">Approve</button></form>
            <form method="POST" action="/admin/payments/${p.id}/reject"><button class="btn small danger" type="submit">Reject</button></form>
          </div>
        </td>
      </tr>`,
    )
    .join("");

  const methodLabel = (m: string) =>
    ({
      venmo: "Venmo",
      paypal: "PayPal",
      zelle: "Zelle",
      bitcoin: "Bitcoin",
      cash: "Cash",
    } as Record<string, string>)[m] ?? m;

  const deviceRows = devices
    .map((d) => {
      const draft = d.draft;
      const playa = d.playa_name || draft?.playa_name || "";
      const amount =
        draft?.amount_cents != null
          ? money(draft.amount_cents, settings.currency)
          : "—";
      const method = draft?.method ? methodLabel(draft.method) : "—";
      const handle = draft?.guest_handle?.trim() || "—";
      const online = formatDuration(d.online_live_ms ?? liveOnlineMs(d));
      return `
      <tr>
        <td><code>${escapeHtml(d.mac)}</code><div class="meta">${escapeHtml(playa)}</div></td>
        <td><span class="pill ${escapeHtml(d.status)}">${escapeHtml(d.status)}</span></td>
        <td>${d.paid_until ? escapeHtml(new Date(d.paid_until).toLocaleString()) : "—"}</td>
        <td>${escapeHtml(online)}</td>
        <td>${escapeHtml(amount)}</td>
        <td>${escapeHtml(method)}</td>
        <td>${escapeHtml(handle)}</td>
        <td>${escapeHtml(d.label ?? d.payment_method ?? "")}</td>
        <td>
          <div class="row-actions">
            <form method="POST" action="/admin/devices/${encodeURIComponent(d.mac)}/comp"><button class="btn small" type="submit">Comp</button></form>
            <form method="POST" action="/admin/devices/${encodeURIComponent(d.mac)}/revoke"><button class="btn small danger" type="submit">Revoke</button></form>
          </div>
        </td>
      </tr>`;
    })
    .join("");

  const paymentRows = payments
    .slice(0, 30)
    .map(
      (p) => `
      <tr>
        <td>${p.id}</td>
        <td>${escapeHtml(p.method)}</td>
        <td><span class="pill ${escapeHtml(p.status)}">${escapeHtml(p.status)}</span></td>
        <td><code>${escapeHtml(p.mac)}</code></td>
        <td>${escapeHtml(money(p.amount_cents, settings.currency))}</td>
        <td>${escapeHtml(new Date(p.created_at).toLocaleString())}</td>
      </tr>`,
    )
    .join("");

  const siteRows = siteWhitelist
    .map(
      (s) => `
      <tr>
        <td class="meta">${escapeHtml(s.url)}<div class="meta">${escapeHtml(s.hostname)}</div></td>
        <td><span class="pill ${escapeHtml(s.status)}">${escapeHtml(s.status)}</span></td>
        <td>${s.unique_requesters}/${SITE_WHITELIST_VOTES_NEEDED}</td>
        <td>
          ${
            s.status !== "revoked"
              ? `<form method="POST" action="/admin/whitelist/revoke">
                   <input type="hidden" name="url" value="${escapeHtml(s.url)}" />
                   <button class="btn small danger" type="submit">Revoke</button>
                 </form>`
              : "—"
          }
        </td>
      </tr>`,
    )
    .join("");

  return layout(
    "Admin",
    `
    ${adminNav()}
    <div class="brand">Controls</div>
    <h1>${escapeHtml(settings.camp_name)}</h1>
    ${flash ? `<p class="ok">${escapeHtml(flash)}</p>` : ""}
    ${
      opts.starlinkData
        ? starlinkDataPanel({ view: opts.starlinkData, compact: false })
        : ""
    }

    <form method="POST" action="/admin/settings" class="panel">
      <h2>Settings</h2>
      <label>Camp name</label>
      <input name="camp_name" value="${escapeHtml(settings.camp_name)}" />
      <label>Welcome message</label>
      <textarea name="welcome_message" rows="2">${escapeHtml(settings.welcome_message)}</textarea>
      <label>Price (cents)</label>
      <input name="price_cents" type="number" min="50" step="1" value="${settings.price_cents}" />
      <label>Fundraising goal (cents)</label>
      <input name="fundraising_goal_cents" type="number" min="100" step="100" value="${settings.fundraising_goal_cents}" />
      <label>Currency</label>
      <input name="currency" value="${escapeHtml(settings.currency)}" />
      <label>Session length (hours)</label>
      <input name="session_hours" type="number" min="1" step="1" value="${settings.session_hours}" />
      <label>Venmo handle</label>
      <input name="venmo_handle" value="${escapeHtml(settings.venmo_handle)}" placeholder="yourvenmo" />
      <label>PayPal (email or paypal.me)</label>
      <input name="paypal_me" value="${escapeHtml(settings.paypal_me)}" placeholder="you@email.com or paypal.me name" />
      <label>Zelle (email or phone)</label>
      <input name="zelle_handle" value="${escapeHtml(settings.zelle_handle)}" placeholder="you@email.com or 5551234567" />
      <label>Bitcoin address</label>
      <input name="bitcoin_address" value="${escapeHtml(settings.bitcoin_address)}" placeholder="bc1…" />
      <button class="btn" type="submit">Save settings</button>
    </form>

    <div class="panel">
      <h2>Pending manual payments (${pending.length})</h2>
      ${
        pending.length
          ? `<table><thead><tr><th>ID</th><th>MAC</th><th>Method</th><th>Amount</th><th>Note</th><th></th></tr></thead><tbody>${pendingRows}</tbody></table>`
          : `<p>No pending Venmo requests.</p>`
      }
    </div>

    <div class="panel">
      <h2>Devices (${devices.length})</h2>
      <p class="meta">Saved access-form values are linked to each device MAC. Online is total time spent allowed.</p>
      <form method="POST" action="/admin/devices/comp" class="row-actions" style="margin-bottom:1rem">
        <input name="mac" placeholder="aa:bb:cc:dd:ee:ff" required style="flex:1" />
        <input name="label" placeholder="label (optional)" style="flex:1" />
        <button class="btn small" type="submit">Comp MAC</button>
      </form>
      ${
        devices.length
          ? `<table><thead><tr><th>MAC / playa</th><th>Status</th><th>Until</th><th>Online</th><th>Amount</th><th>Method</th><th>Handle</th><th>Note</th><th></th></tr></thead><tbody>${deviceRows}</tbody></table>`
          : `<p>No devices yet.</p>`
      }
    </div>

    <div class="panel">
      <h2>Site whitelist (${siteWhitelist.length})</h2>
      <p class="meta">Always open (never blocked): payment apps, thephage.org, Burning Man, Innovate showcase apps, BMIR, Spotify, Watch Duty, and the CDNs those pages need.</p>
      <p class="meta">Always blocked (every device, paid or not): TikTok, Reddit, Google News, and major news sites/feeds. Crowd approval cannot open them.</p>
      <p class="meta" style="margin-top:0.35rem">${PERMANENT_WHITELIST_DOMAINS.map((d) => `<code>${escapeHtml(d)}</code>`).join(" · ")}</p>
      <p class="meta">Crowd approval: ${SITE_WHITELIST_VOTES_NEEDED} unique device MACs must request the exact same URL.</p>
      ${
        siteWhitelist.length
          ? `<table><thead><tr><th>URL</th><th>Status</th><th>Votes</th><th></th></tr></thead><tbody>${siteRows}</tbody></table>`
          : `<p>No crowd site whitelist requests yet.</p>`
      }
    </div>

    <div class="panel">
      <h2>Recent payments</h2>
      ${
        payments.length
          ? `<table><thead><tr><th>ID</th><th>Method</th><th>Status</th><th>MAC</th><th>Amount</th><th>When</th></tr></thead><tbody>${paymentRows}</tbody></table>`
          : `<p>No payments yet.</p>`
      }
    </div>
    `,
    { admin: true },
  );
}

function eventListItems(events: CampEvent[], favoriteIds: number[] = [], now = Date.now()): string {
  const fav = new Set(favoriteIds);
  return events
    .map((event) => {
      const happening = eventIsHappening(event, now);
      const past = event.ends_at ? event.ends_at < now : event.starts_at + 2 * 60 * 60 * 1000 < now;
      const meta = [event.location, event.host ? `hosted by ${event.host}` : ""]
        .filter(Boolean)
        .join(" · ");
      const description = displayEventDescription(event.description);
      const isFav = fav.has(event.id);
      return `<li class="event-item" data-id="${event.id}" data-host="${escapeHtml(event.host.toLowerCase())}" data-search="${escapeHtml(eventSearchHaystack(event))}">
        <div class="event-item-head">
          <div>
            <div class="event-when">${escapeHtml(formatEventWhen(event.starts_at, event.ends_at))}${
              happening ? ` <span class="pill allowed">now</span>` : past ? ` <span class="pill">past</span>` : ""
            }</div>
            <h3>${escapeHtml(event.title)}</h3>
          </div>
          <button type="button" class="fav-btn${isFav ? " on" : ""}" data-fav="${event.id}" aria-label="${isFav ? "Remove favorite" : "Add favorite"}" aria-pressed="${isFav ? "true" : "false"}">${isFav ? "★" : "☆"}</button>
        </div>
        ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}
        ${description ? `<p>${escapeHtml(description)}</p>` : ""}
      </li>`;
    })
    .join("");
}

export function guestEventsPage(opts: {
  query: string;
  camp?: string;
  campQ?: string;
  events: CampEvent[];
  total: number;
  limit: number;
  mac?: string | null;
  playaName?: string;
  askPlayaName?: boolean;
  profile?: EventsProfileState;
  profileUpdatedAt?: number | null;
  camps?: string[];
}): string {
  const {
    query,
    camp = "",
    campQ = "",
    events,
    total,
    limit,
    mac = null,
    askPlayaName = false,
    profile,
    profileUpdatedAt = null,
    camps = [],
  } = opts;
  const state: EventsProfileState = {
    q: query,
    campQ: campQ || "",
    camp,
    filtersOpen: profile?.filtersOpen ?? false,
    favoriteIds: profile?.favoriteIds ?? [],
  };
  const empty = query || camp
    ? `No events match${query ? ` “${escapeHtml(query)}”` : ""}${camp ? ` at ${escapeHtml(camp)}` : ""}.`
    : "No events posted yet. Check back after camp admin adds the schedule.";
  const capped = total > events.length;
  const status = events.length
    ? capped
      ? `Showing ${events.length} of ${total} events${query || camp ? "" : " (soonest first)"}. Search to narrow.`
      : `${events.length} event${events.length === 1 ? "" : "s"}${query || camp ? " matched" : ""}.`
    : "";
  const summaryBits: string[] = [];
  if (query) summaryBits.push(`“${query}”`);
  if (camp) summaryBits.push(camp);
  if (state.favoriteIds.length) summaryBits.push(`${state.favoriteIds.length} fav`);
  const summaryText = summaryBits.length ? summaryBits.map((s) => escapeHtml(s)).join(" · ") : "Search &amp; camps";
  const campsJson = JSON.stringify(camps).replace(/</g, "\\u003c");
  const stateJson = JSON.stringify(state).replace(/</g, "\\u003c");

  return layout(
    "Events",
    `
    ${guestBrand()}
    <div class="events-head">
      <h1>Events</h1>
      <button type="button" class="btn small secondary" id="save-offline" title="Download favorites as offline HTML">Save offline calendar</button>
    </div>
    <p class="lede">Camp schedule in Pacific time. Star events to build your offline calendar.</p>

    <details class="panel filter-bar" id="filters"${state.filtersOpen ? " open" : ""}>
      <summary>
        <span>Filters <span class="filter-chip" id="filter-summary">${summaryText}</span></span>
      </summary>
      <div class="filter-body">
        <label for="q">Search events</label>
        <div class="search-row">
          <input type="search" name="q" id="q" value="${escapeHtml(query)}" placeholder="Fuzzy search title, host, place, description" autocomplete="off" />
        </div>
        <label for="camp-q">Search camps</label>
        <div class="search-row">
          <input type="search" name="camp_q" id="camp-q" value="${escapeHtml(state.campQ)}" placeholder="Fuzzy search camp / host name" autocomplete="off" />
          <button type="button" class="btn small secondary" id="clear-camp">Clear</button>
        </div>
        <div class="camp-suggestions" id="camp-suggestions" hidden></div>
        <div class="camp-active" id="camp-active"${camp ? "" : " hidden"}>Filtering camp: <strong id="camp-active-name">${escapeHtml(camp)}</strong></div>
        ${status ? `<p class="meta" id="list-status" style="margin:0.75rem 0 0">${escapeHtml(status)}</p>` : `<p class="meta" id="list-status" style="margin:0.75rem 0 0"></p>`}

        <div class="profile-row">
          <button type="button" class="btn small" id="save-profile">Save profile</button>
          <input type="text" id="other-mac" placeholder="Other device MAC (aa:bb:…)" autocomplete="off" spellcheck="false" />
          <button type="button" class="btn small secondary" id="merge-profile">Add device &amp; merge</button>
        </div>
        <p class="profile-status" id="profile-status">${
          mac
            ? `Device ${escapeHtml(mac)}${profileUpdatedAt ? ` · profile saved ${escapeHtml(new Date(profileUpdatedAt).toLocaleString())}` : " · no saved profile yet"}`
            : "Unknown device — reconnect to camp Wi‑Fi to save a profile."
        }</p>
      </div>
    </details>

    <div class="panel">
      ${
        events.length
          ? `<ul class="event-list" id="event-list">${eventListItems(events, state.favoriteIds)}</ul>`
          : `<p class="empty" id="event-empty">${empty}</p><ul class="event-list" id="event-list" hidden></ul>`
      }
    </div>
    <script>
      (function () {
        const PLAYA_TZ = "America/Los_Angeles";
        const camps = ${campsJson};
        let state = ${stateJson};
        const mac = ${mac ? JSON.stringify(mac) : "null"};
        const qInput = document.getElementById("q");
        const campInput = document.getElementById("camp-q");
        const campSuggestions = document.getElementById("camp-suggestions");
        const campActive = document.getElementById("camp-active");
        const campActiveName = document.getElementById("camp-active-name");
        const clearCamp = document.getElementById("clear-camp");
        const list = document.getElementById("event-list");
        const emptyEl = document.getElementById("event-empty");
        const statusEl = document.getElementById("list-status");
        const filterSummary = document.getElementById("filter-summary");
        const filters = document.getElementById("filters");
        const profileStatus = document.getElementById("profile-status");
        let searchTimer = 0;
        let campTimer = 0;

        function esc(s) {
          return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
        }
        function fuzzyScore(haystack, needle) {
          const h = String(haystack || "").toLowerCase();
          const n = String(needle || "").toLowerCase().replace(/\\s+/g, " ").trim();
          if (!n) return 1;
          if (h.includes(n)) return 200 + Math.round((n.length / Math.max(h.length, 1)) * 40);
          let hi = 0, score = 0, consecutive = 0;
          for (let ni = 0; ni < n.length; ni++) {
            const ch = n[ni];
            if (ch === " ") { consecutive = 0; continue; }
            const found = h.indexOf(ch, hi);
            if (found < 0) return 0;
            if (found === hi) consecutive++; else consecutive = 0;
            score += 1 + consecutive * 2;
            if (found === 0 || /\\s/.test(h[found - 1] || " ")) score += 4;
            hi = found + 1;
          }
          return score;
        }
        function updateSummary() {
          const bits = [];
          if (state.q) bits.push("\\u201c" + state.q + "\\u201d");
          if (state.camp) bits.push(state.camp);
          if (state.favoriteIds.length) bits.push(state.favoriteIds.length + " fav");
          filterSummary.innerHTML = bits.length ? bits.map(esc).join(" · ") : "Search &amp; camps";
        }
        function renderCampSuggestions() {
          const q = (campInput.value || "").trim();
          state.campQ = q;
          const scored = camps
            .map((name) => ({ name, score: fuzzyScore(name, q) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
            .slice(0, 12);
          if (!q || !scored.length) {
            campSuggestions.hidden = true;
            campSuggestions.innerHTML = "";
            return;
          }
          campSuggestions.hidden = false;
          campSuggestions.innerHTML = scored.map((x) =>
            '<button type="button" data-camp="' + esc(x.name) + '"' +
            (state.camp === x.name ? ' class="active"' : "") + ">" + esc(x.name) + "</button>"
          ).join("");
        }
        function setCamp(name) {
          state.camp = name || "";
          if (name) {
            campActive.hidden = false;
            campActiveName.textContent = name;
          } else {
            campActive.hidden = true;
            campActiveName.textContent = "";
          }
          updateSummary();
          fetchEvents();
        }
        function renderEvents(events, total) {
          const fav = new Set(state.favoriteIds);
          if (!events.length) {
            list.innerHTML = "";
            list.hidden = true;
            if (emptyEl) {
              emptyEl.hidden = false;
              emptyEl.textContent = (state.q || state.camp)
                ? ("No events match" + (state.q ? " \\u201c" + state.q + "\\u201d" : "") + (state.camp ? " at " + state.camp : "") + ".")
                : "No events posted yet.";
            } else {
              const p = document.createElement("p");
              p.className = "empty";
              p.id = "event-empty";
              p.textContent = "No matching events.";
              list.parentElement.insertBefore(p, list);
            }
            statusEl.textContent = "";
            return;
          }
          if (emptyEl) emptyEl.hidden = true;
          list.hidden = false;
          list.innerHTML = events.map((e) => {
            const isFav = fav.has(e.id);
            const meta = [e.location, e.host ? ("hosted by " + e.host) : ""].filter(Boolean).join(" · ");
            return '<li class="event-item" data-id="' + e.id + '">' +
              '<div class="event-item-head"><div>' +
              '<div class="event-when">' + esc(e.when) + '</div>' +
              "<h3>" + esc(e.title) + "</h3></div>" +
              '<button type="button" class="fav-btn' + (isFav ? " on" : "") + '" data-fav="' + e.id + '" aria-pressed="' + (isFav ? "true" : "false") + '">' + (isFav ? "\\u2605" : "\\u2606") + "</button>" +
              "</div>" +
              (meta ? '<div class="meta">' + esc(meta) + "</div>" : "") +
              (e.description ? "<p>" + esc(e.description) + "</p>" : "") +
              "</li>";
          }).join("");
          const capped = total > events.length;
          statusEl.textContent = capped
            ? ("Showing " + events.length + " of " + total + " events. Search to narrow.")
            : (events.length + " event" + (events.length === 1 ? "" : "s") + ((state.q || state.camp) ? " matched" : "") + ".");
        }
        async function fetchEvents() {
          const params = new URLSearchParams();
          if (state.q) params.set("q", state.q);
          if (state.camp) params.set("camp", state.camp);
          params.set("limit", "80");
          const res = await fetch("/api/events?" + params.toString());
          const data = await res.json();
          renderEvents(data.events || [], data.total || 0);
          updateSummary();
        }
        function collectState() {
          state.q = (qInput.value || "").trim();
          state.campQ = (campInput.value || "").trim();
          state.filtersOpen = !!(filters && filters.open);
          return state;
        }
        async function saveProfile(silent) {
          if (!mac) {
            profileStatus.textContent = "Unknown device — reconnect to camp Wi‑Fi to save a profile.";
            return;
          }
          collectState();
          const res = await fetch("/api/events/profile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(state),
          });
          const data = await res.json();
          if (!res.ok) {
            profileStatus.textContent = data.error || "Save failed";
            return;
          }
          state = data.state;
          profileStatus.textContent = "Device " + data.mac + " · profile saved " + new Date(data.updated_at).toLocaleString();
          updateSummary();
          if (!silent) profileStatus.className = "profile-status ok";
        }
        list.addEventListener("click", (ev) => {
          const btn = ev.target.closest("[data-fav]");
          if (!btn) return;
          const id = Number(btn.getAttribute("data-fav"));
          if (!id) return;
          const set = new Set(state.favoriteIds);
          if (set.has(id)) set.delete(id); else set.add(id);
          state.favoriteIds = Array.from(set);
          btn.classList.toggle("on", set.has(id));
          btn.textContent = set.has(id) ? "\\u2605" : "\\u2606";
          btn.setAttribute("aria-pressed", set.has(id) ? "true" : "false");
          updateSummary();
          saveProfile(true);
        });
        campSuggestions.addEventListener("click", (ev) => {
          const btn = ev.target.closest("[data-camp]");
          if (!btn) return;
          setCamp(btn.getAttribute("data-camp") || "");
          renderCampSuggestions();
        });
        clearCamp.addEventListener("click", () => {
          campInput.value = "";
          state.campQ = "";
          setCamp("");
          renderCampSuggestions();
        });
        qInput.addEventListener("input", () => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => {
            state.q = (qInput.value || "").trim();
            fetchEvents();
          }, 280);
        });
        campInput.addEventListener("input", () => {
          clearTimeout(campTimer);
          campTimer = setTimeout(renderCampSuggestions, 120);
        });
        if (filters) {
          filters.addEventListener("toggle", () => {
            state.filtersOpen = filters.open;
          });
        }
        document.getElementById("save-profile").addEventListener("click", () => saveProfile(false));
        document.getElementById("merge-profile").addEventListener("click", async () => {
          if (!mac) {
            profileStatus.textContent = "Unknown device — reconnect to camp Wi‑Fi.";
            return;
          }
          const other = (document.getElementById("other-mac").value || "").trim();
          if (!other) {
            profileStatus.textContent = "Enter another device MAC to merge.";
            return;
          }
          await saveProfile(true);
          const res = await fetch("/api/events/profile/merge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mac: other }),
          });
          const data = await res.json();
          if (!res.ok) {
            profileStatus.textContent = data.error || "Merge failed";
            profileStatus.className = "profile-status err";
            return;
          }
          state = data.state;
          qInput.value = state.q || "";
          campInput.value = state.campQ || "";
          setCamp(state.camp || "");
          profileStatus.textContent = "Merged with " + data.other_mac + " · kept card from " + data.winner_mac + " (last write wins)";
          profileStatus.className = "profile-status ok";
          fetchEvents();
          updateSummary();
        });

        function playaDayKey(ms) {
          return new Intl.DateTimeFormat("en-CA", {
            timeZone: PLAYA_TZ, year: "numeric", month: "2-digit", day: "2-digit"
          }).format(new Date(ms));
        }
        function playaDayLabel(ms) {
          return new Intl.DateTimeFormat("en-US", {
            timeZone: PLAYA_TZ, weekday: "short", month: "short", day: "numeric"
          }).format(new Date(ms));
        }
        function buildOfflineHtml(events) {
          const byDay = new Map();
          for (const e of events) {
            const key = playaDayKey(e.starts_at);
            if (!byDay.has(key)) byDay.set(key, []);
            byDay.get(key).push(e);
          }
          const days = Array.from(byDay.keys()).sort();
          const tabs = days.map((d, i) => {
            const label = playaDayLabel(byDay.get(d)[0].starts_at);
            return '<button type="button" class="day-tab' + (i === 0 ? " active" : "") + '" data-day="' + d + '">' + esc(label) + "</button>";
          }).join("");
          const panels = days.map((d, i) => {
            const items = byDay.get(d).map((e) => {
              const meta = [e.location, e.host ? ("hosted by " + e.host) : ""].filter(Boolean).join(" · ");
              return '<article class="ev">' +
                '<div class="when">' + esc(e.when) + "</div>" +
                "<h2>" + esc(e.title) + "</h2>" +
                (meta ? '<div class="meta">' + esc(meta) + "</div>" : "") +
                (e.description ? "<p>" + esc(e.description) + "</p>" : "") +
                "</article>";
            }).join("");
            return '<section class="day-panel' + (i === 0 ? " active" : "") + '" data-day="' + d + '">' +
              (items || "<p class='empty'>No events this day.</p>") + "</section>";
          }).join("");
          return "<!DOCTYPE html><html lang=\\"en\\"><head><meta charset=\\"utf-8\\"/>" +
            "<meta name=\\"viewport\\" content=\\"width=device-width, initial-scale=1\\"/>" +
            "<title>Phage Camp · Offline favorites</title><style>" +
            ":root{--bg0:#0b1220;--ink:#e8eef7;--muted:#9db0c9;--accent:#3dd6c6;--line:rgba(232,238,247,.12)}" +
            "body{margin:0;font-family:Segoe UI,Helvetica Neue,Arial,sans-serif;color:var(--ink);background:var(--bg0)}" +
            "main{width:min(640px,calc(100% - 2rem));margin:0 auto;padding:1.5rem 0 2.5rem}" +
            ".brand{font-size:.8rem;text-transform:uppercase;letter-spacing:.16em;color:var(--accent);margin-bottom:.5rem}" +
            "h1{font-size:1.5rem;margin:0 0 .35rem} .lede{color:var(--muted);margin:0 0 1rem}" +
            ".tabs{display:flex;flex-wrap:wrap;gap:.35rem;margin:0 0 1rem;position:sticky;top:0;background:var(--bg0);padding:.5rem 0;z-index:2}" +
            ".day-tab{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:999px;padding:.35rem .75rem;font:inherit;font-size:.85rem;cursor:pointer}" +
            ".day-tab.active{color:var(--accent);border-color:rgba(61,214,198,.45)}" +
            ".day-panel{display:none}.day-panel.active{display:block}" +
            ".ev{padding:.9rem 0;border-bottom:1px solid var(--line)}.ev:last-child{border-bottom:0}" +
            ".when{font-size:.8rem;color:var(--accent)}.ev h2{margin:.15rem 0;font-size:1.05rem}.meta{font-size:.85rem;color:var(--muted)}" +
            ".ev p{color:var(--muted);line-height:1.45}.empty{color:var(--muted)}" +
            "</style></head><body><main>" +
            '<div class="brand">Phage Camp</div><h1>Offline favorites</h1>' +
            '<p class="lede">' + events.length + " saved event" + (events.length === 1 ? "" : "s") + " · Pacific time · generated " + esc(new Date().toLocaleString()) + "</p>" +
            (days.length ? '<div class="tabs" id="tabs">' + tabs + "</div>" + panels : "<p class='empty'>No favorites yet.</p>") +
            "</main><script>(function(){var tabs=document.getElementById('tabs');if(!tabs)return;tabs.addEventListener('click',function(ev){var b=ev.target.closest('[data-day]');if(!b)return;var day=b.getAttribute('data-day');document.querySelectorAll('.day-tab').forEach(function(t){t.classList.toggle('active',t.getAttribute('data-day')===day)});document.querySelectorAll('.day-panel').forEach(function(p){p.classList.toggle('active',p.getAttribute('data-day')===day)})});})();<\\/script></body></html>";
        }
        document.getElementById("save-offline").addEventListener("click", async () => {
          const ids = state.favoriteIds || [];
          if (!ids.length) {
            profileStatus.textContent = "Star some events first, then save the offline calendar.";
            profileStatus.className = "profile-status warn";
            return;
          }
          const res = await fetch("/api/events/by-ids?ids=" + ids.join(","));
          const data = await res.json();
          const html = buildOfflineHtml(data.events || []);
          const blob = new Blob([html], { type: "text/html;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "phage-camp-favorites.html";
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          profileStatus.textContent = "Downloaded offline calendar (" + (data.events || []).length + " favorites).";
          profileStatus.className = "profile-status ok";
        });

        updateSummary();
        if ((campInput.value || "").trim()) renderCampSuggestions();
      })();
    </script>
    ${playaNameGate(askPlayaName)}
    `,
  );
}

function eventFormFields(event?: CampEvent | null): string {
  return `
      <label>Title</label>
      <input name="title" value="${escapeHtml(event?.title ?? "")}" required maxlength="80" placeholder="Sunrise stretch" />
      <label>Host</label>
      <input name="host" value="${escapeHtml(event?.host ?? "")}" maxlength="48" placeholder="Jaybird" />
      <label>Location</label>
      <input name="location" value="${escapeHtml(event?.location ?? "")}" maxlength="80" placeholder="Phage Camp kitchen" />
      <label>Starts (Pacific)</label>
      <input name="starts_at" type="datetime-local" value="${event ? escapeHtml(toPlayaDatetimeLocal(event.starts_at)) : ""}" required />
      <label>Ends (Pacific, optional)</label>
      <input name="ends_at" type="datetime-local" value="${event?.ends_at ? escapeHtml(toPlayaDatetimeLocal(event.ends_at)) : ""}" />
      <label>Description</label>
      <textarea name="description" rows="3" maxlength="2000">${escapeHtml(event?.description ?? "")}</textarea>`;
}

export function adminEventsPage(opts: {
  events: CampEvent[];
  total?: number;
  limit?: number;
  editing?: CampEvent | null;
  query?: string;
  flash?: string;
  error?: string;
}): string {
  const { events, total = events.length, limit = events.length, editing, query = "", flash, error } = opts;
  const scheduleLabel =
    total > events.length
      ? `Schedule (showing ${events.length} of ${total})`
      : `Schedule (${events.length})`;
  const rows = events
    .map(
      (event) => `
      <tr>
        <td>${escapeHtml(formatEventWhen(event.starts_at, event.ends_at))}</td>
        <td>
          <strong>${escapeHtml(event.title)}</strong>
          <div class="meta">${escapeHtml([event.location, event.host].filter(Boolean).join(" · "))}</div>
        </td>
        <td>
          <div class="row-actions">
            <a class="btn small secondary" href="/admin/events?edit=${event.id}">Edit</a>
            <form method="POST" action="/admin/events/${event.id}/delete"><button class="btn small danger" type="submit">Delete</button></form>
          </div>
        </td>
      </tr>`,
    )
    .join("");

  return layout(
    "Admin events",
    `
    ${adminNav()}
    <div class="brand">Controls</div>
    <h1>Events</h1>
    ${flash ? `<p class="ok">${escapeHtml(flash)}</p>` : ""}
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}

    <form method="POST" action="${editing ? `/admin/events/${editing.id}` : "/admin/events"}" class="panel">
      <h2>${editing ? `Edit event #${editing.id}` : "Add event"}</h2>
      ${eventFormFields(editing)}
      <button class="btn" type="submit">${editing ? "Save event" : "Add event"}</button>
      ${editing ? `<a class="btn secondary" href="/admin/events">Cancel</a>` : ""}
    </form>

    <form method="GET" action="/admin/events" class="panel">
      <h2>${escapeHtml(scheduleLabel)}</h2>
      <div class="search-row" style="margin-bottom:1rem">
        <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Search events" />
        ${editing ? `<input type="hidden" name="edit" value="${editing.id}" />` : ""}
        <button class="btn small" type="submit">Search</button>
      </div>
      ${
        total > events.length
          ? `<p class="meta">Showing first ${limit}. Search to find a specific event.</p>`
          : ""
      }
      ${
        events.length
          ? `<table><thead><tr><th>When</th><th>Event</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
          : `<p class="empty">${query ? "No matching events." : "No events yet."}</p>`
      }
    </form>
    `,
    { admin: true },
  );
}

