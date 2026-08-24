import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "./config.js";
import {
  clearQuickAccessHistory,
  createEvent,
  createPayment,
  deleteEvent,
  getDevice,
  getEvent,
  getPayment,
  getSettings,
  isDeviceCurrentlyAllowed,
  listPayments,
  listSiteWhitelist,
  normalizeMac,
  parsePlayaLocal,
  revokeSiteWhitelist,
  sanitizePlayaName,
  searchEvents,
  countEvents,
  GUEST_EVENT_LIMIT,
  SEARCH_EVENT_LIMIT,
  ADMIN_EVENT_LIMIT,
  QUICK_ACCESS_MINUTES,
  QUICK_ACCESS_COOLDOWN_MINUTES,
  quickAccessCooldownRemainingMs,
  sessionExpiryFromMinutes,
  sessionExpiryMs,
  isManualPayMethod,
  parseDonationDollarsToCents,
  parseDonationTierCents,
  updateEvent,
  updatePayment,
  totalRaisedCents,
  updateSettings,
  upsertDevice,
  listCampNames,
  searchCamps,
  getDeviceProfile,
  saveDeviceProfile,
  mergeDeviceProfiles,
  getAccessDraft,
  saveAccessDraft,
  listDevicesWithAccessDrafts,
  getEventsByIds,
  EMPTY_EVENTS_PROFILE,
  EMPTY_ACCESS_DRAFT,
  displayEventDescription,
  formatEventWhen,
  type EventsProfileState,
  type AccessDraftFields,
} from "./db.js";
import { denyAccess, grantAccess, lookupMacForIp } from "./firewall.js";
import {
  confirmCheckoutSession,
  createCheckoutSession,
} from "./stripe.js";
import { syncSiteWhitelistNetwork } from "./site-whitelist.js";
import { getWeatherRadarMap, getBrcWeather } from "./weather.js";
import { IEM_TILE_BASE, sanitizeIemLayerId } from "./weather-radar-iem.js";
import { librewxrUpstreamTileUrl } from "./weather-radar.js";
import { pickMembersGateChallenge, verifyMembersGateAnswer } from "./members-gate.js";
import {
  adminDashboard,
  adminEventsPage,
  adminLoginPage,
  guestEventsPage,
  guestPaywallPage,
  emergencyAccessPage,
  buildPayMethodLinks,
  successPage,
} from "./views.js";

type Vars = { mac: string | null; admin: boolean; members: boolean };

export const app = new Hono<{ Variables: Vars }>();

const ADMIN_COOKIE = "sp_admin";
const MEMBERS_COOKIE = "sp_members";
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const LEAFLET_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "leaflet",
  "dist",
);
const USER_AGENT = "(PhageCampStarlink/1.0; jaybird@phagecamp.local)";
const CARTO_TILE = "https://a.basemaps.cartocdn.com/dark_all";
const ESRI_SAT_TILE =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";

const PUBLIC_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

async function servePublicFile(c: Context, urlPath: string) {
  const rel = urlPath.replace(/^\/+/, "");
  if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
    return c.text("Not found", 404);
  }
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return c.text("Not found", 404);
  }
  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return c.body(file, 200, {
      "Content-Type": PUBLIC_MIME[ext] || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
    });
  } catch {
    return c.text("Not found", 404);
  }
}

app.get("/playa-bg.jpg", (c) => servePublicFile(c, "playa-bg.jpg"));
app.get("/icons/*", (c) => servePublicFile(c, c.req.path));
app.get("/assets/*", (c) => servePublicFile(c, c.req.path));

app.get("/vendor/leaflet/*", async (c) => {
  const rel = c.req.path.replace(/^\/vendor\/leaflet\/?/, "");
  if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
    return c.text("Not found", 404);
  }
  const filePath = path.join(LEAFLET_DIR, rel);
  if (!filePath.startsWith(LEAFLET_DIR + path.sep)) {
    return c.text("Not found", 404);
  }
  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "application/javascript; charset=utf-8"
          : ext === ".png"
            ? "image/png"
            : "application/octet-stream";
    return c.body(file, 200, {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=86400",
    });
  } catch {
    return c.text("Not found", 404);
  }
});

app.get("/api/weather-radar", async (c) => {
  return c.json(await getWeatherRadarMap(), 200, {
    "Cache-Control": "private, max-age=90",
  });
});

async function proxyTile(
  c: Context,
  upstreamUrl: string,
): Promise<Response> {
  try {
    const res = await fetch(upstreamUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "image/png,image/*" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return c.text("Tile unavailable", 502);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 20) return c.text("Tile empty", 502);
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    return c.body(bytes, 200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=300",
    });
  } catch {
    return c.text("Tile unavailable", 502);
  }
}

app.get("/wx-tiles/carto/:z/:x/:y", async (c) => {
  const z = Number(c.req.param("z"));
  const x = Number(c.req.param("x"));
  const yRaw = String(c.req.param("y") ?? "").replace(/\.png$/i, "");
  const yi = Number(yRaw);
  if (![z, x, yi].every((n) => Number.isInteger(n) && n >= 0) || z > 18) {
    return c.text("Bad tile", 400);
  }
  return proxyTile(c, `${CARTO_TILE}/${z}/${x}/${yi}.png`);
});

/** Esri World Imagery — note upstream path is z/y/x. */
app.get("/wx-tiles/sat/:z/:x/:y", async (c) => {
  const z = Number(c.req.param("z"));
  const x = Number(c.req.param("x"));
  const yRaw = String(c.req.param("y") ?? "").replace(/\.(jpg|jpeg|png)$/i, "");
  const yi = Number(yRaw);
  if (![z, x, yi].every((n) => Number.isInteger(n) && n >= 0) || z > 18) {
    return c.text("Bad tile", 400);
  }
  return proxyTile(c, `${ESRI_SAT_TILE}/${z}/${yi}/${x}`);
});

app.get("/wx-tiles/iem/:layer/:z/:x/:y", async (c) => {
  const layer = sanitizeIemLayerId(decodeURIComponent(String(c.req.param("layer") ?? "")));
  if (!layer) return c.text("Bad layer", 400);
  const z = Number(c.req.param("z"));
  const x = Number(c.req.param("x"));
  const yRaw = String(c.req.param("y") ?? "").replace(/\.png$/i, "");
  const yi = Number(yRaw);
  if (![z, x, yi].every((n) => Number.isInteger(n) && n >= 0) || z > 12) {
    return c.text("Bad tile", 400);
  }
  return proxyTile(c, `${IEM_TILE_BASE}/${layer}/${z}/${x}/${yi}.png`);
});

/** LibreWXR / RainViewer-compatible smoothed radar tiles. */
app.get("/wx-tiles/radar/:time/:size/:z/:x/:y", async (c) => {
  const time = Number(c.req.param("time"));
  const z = Number(c.req.param("z"));
  const x = Number(c.req.param("x"));
  const yRaw = String(c.req.param("y") ?? "").replace(/\.png$/i, "");
  const yi = Number(yRaw);
  const size = Number(c.req.param("size"));
  if (
    !Number.isInteger(time) ||
    time < 1_000_000_000 ||
    time > 4_000_000_000 ||
    size !== 256 ||
    ![z, x, yi].every((n) => Number.isInteger(n) && n >= 0) ||
    z > 12
  ) {
    return c.text("Bad tile", 400);
  }
  return proxyTile(c, librewxrUpstreamTileUrl(time, z, x, yi));
});

async function resolveClientMac(c: Parameters<typeof getConnInfo>[0]): Promise<string | null> {
  const headerMac = c.req.header("x-client-mac") || c.req.header("x-forwarded-mac");
  if (headerMac) {
    try {
      return normalizeMac(headerMac);
    } catch {
      /* ignore */
    }
  }

  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  let ip = forwarded || c.req.header("x-real-ip") || "";
  if (!ip) {
    try {
      ip = getConnInfo(c).remote.address || "";
    } catch {
      ip = "";
    }
  }
  return lookupMacForIp(ip || "127.0.0.1");
}

app.use("*", async (c, next) => {
  const mac = await resolveClientMac(c);
  c.set("mac", mac);
  c.set("admin", getCookie(c, ADMIN_COOKIE) === "1");
  c.set("members", getCookie(c, MEMBERS_COOKIE) === "1");
  await next();
});

function requireAdmin() {
  return createMiddleware<{ Variables: Vars }>(async (c, next) => {
    if (!c.get("admin")) {
      return c.redirect("/admin/login");
    }
    await next();
  });
}

/** Captive portal connectivity checks — respond so OS detects portal. */
app.get("/generate_204", (c) => c.body(null, 204));
app.get("/gen_204", (c) => c.body(null, 204));
app.get("/hotspot-detect.html", (c) =>
  c.html("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>"),
);
app.get("/library/test/success.html", (c) => c.text("Success"));
app.get("/ncsi.txt", (c) => c.text("Microsoft NCSI"));
app.get("/connecttest.txt", (c) => c.text("Microsoft Connect Test"));
app.get("/canonical.html", (c) => c.html("<html><head><title>Success</title></head></html>"));

app.get("/health", (c) => c.json({ ok: true }));

app.get("/events", (c) => {
  const mac = c.get("mac");
  const device = mac ? getDevice(mac) : null;
  const profile = mac ? getDeviceProfile(mac) : null;
  const state = profile?.state ?? EMPTY_EVENTS_PROFILE;
  const query = String(c.req.query("q") ?? state.q ?? "");
  const camp = String(c.req.query("camp") ?? state.camp ?? "");
  const limit = query.trim() || camp.trim() ? SEARCH_EVENT_LIMIT : GUEST_EVENT_LIMIT;
  const events = searchEvents(query, limit, camp);
  const total = countEvents(query, camp);
  const playaName = sanitizePlayaName(device?.playa_name ?? "");
  return c.html(
    guestEventsPage({
      query,
      camp,
      campQ: state.campQ,
      events,
      total,
      limit,
      mac,
      playaName,
      profile: state,
      profileUpdatedAt: profile?.updated_at ?? null,
      camps: listCampNames(),
    }),
  );
});

app.get("/api/events", (c) => {
  const query = String(c.req.query("q") ?? "");
  const camp = String(c.req.query("camp") ?? "");
  const limitRaw = Number(c.req.query("limit") || SEARCH_EVENT_LIMIT);
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : SEARCH_EVENT_LIMIT), 200);
  const events = searchEvents(query, limit, camp);
  const total = countEvents(query, camp);
  return c.json({
    events: events.map((e) => ({
      id: e.id,
      title: e.title,
      description: displayEventDescription(e.description),
      location: e.location,
      host: e.host,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      when: formatEventWhen(e.starts_at, e.ends_at),
    })),
    total,
    limit,
  });
});

app.get("/api/events/camps", (c) => {
  const query = String(c.req.query("q") ?? "");
  return c.json({ camps: searchCamps(query) });
});

app.get("/api/events/by-ids", (c) => {
  const raw = String(c.req.query("ids") ?? "");
  const ids = raw
    .split(/[, ]+/)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, 500);
  const events = getEventsByIds(ids).sort((a, b) => a.starts_at - b.starts_at || a.id - b.id);
  return c.json({
    events: events.map((e) => ({
      id: e.id,
      title: e.title,
      description: displayEventDescription(e.description),
      location: e.location,
      host: e.host,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      when: formatEventWhen(e.starts_at, e.ends_at),
    })),
  });
});

app.get("/api/events/profile", (c) => {
  const mac = c.get("mac");
  if (!mac) return c.json({ error: "Unknown device" }, 400);
  const profile = getDeviceProfile(mac);
  return c.json({
    mac,
    state: profile?.state ?? EMPTY_EVENTS_PROFILE,
    updated_at: profile?.updated_at ?? null,
  });
});

app.post("/api/events/profile", async (c) => {
  const mac = c.get("mac");
  if (!mac) return c.json({ error: "Unknown device — reconnect to Wi‑Fi." }, 400);
  let body: Partial<EventsProfileState> = {};
  try {
    body = (await c.req.json()) as Partial<EventsProfileState>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const profile = saveDeviceProfile(mac, body);
  return c.json({
    mac: profile.mac,
    state: profile.state,
    updated_at: profile.updated_at,
  });
});

app.post("/api/events/profile/merge", async (c) => {
  const mac = c.get("mac");
  if (!mac) return c.json({ error: "Unknown device — reconnect to Wi‑Fi." }, 400);
  let otherMac = "";
  try {
    const body = (await c.req.json()) as { mac?: string };
    otherMac = String(body.mac || "");
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  try {
    const result = mergeDeviceProfiles(mac, otherMac);
    return c.json({
      mac,
      other_mac: result.other.mac,
      winner_mac: result.winnerMac,
      state: result.primary.state,
      updated_at: result.primary.updated_at,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Merge failed" }, 400);
  }
});

app.get("/", async (c) => {
  const mac = c.get("mac");
  const device = mac ? getDevice(mac) : null;
  const allowed = isDeviceCurrentlyAllowed(device);
  const settings = getSettings();
  const weather = await getBrcWeather();
  const playaName = sanitizePlayaName(device?.playa_name || "");
  return c.html(
    guestPaywallPage({
      settings,
      mac,
      allowed,
      paidUntil: device?.paid_until ?? null,
      weather,
      playaName,
      askPlayaName: Boolean(mac && !playaName),
      canceled: c.req.query("canceled") === "1",
      error: c.req.query("error") ?? undefined,
    }),
  );
});

app.get("/access", async (c) => {
  const mac = c.get("mac");
  const device = mac ? getDevice(mac) : null;
  if (isDeviceCurrentlyAllowed(device)) {
    return c.redirect("/");
  }
  const settings = getSettings();
  const methods = await buildPayMethodLinks(settings, mac ?? "unknown");
  const draft = mac ? getAccessDraft(mac) : null;
  const playaName = sanitizePlayaName(device?.playa_name || draft?.playa_name || "");
  return c.html(
    emergencyAccessPage({
      settings,
      mac,
      methods,
      playaName,
      draft: draft
        ? {
            amount_cents: draft.amount_cents,
            method: draft.method,
            guest_handle: draft.guest_handle,
            playa_name: draft.playa_name,
          }
        : undefined,
      quickCooldownMs: mac ? quickAccessCooldownRemainingMs(mac) : 0,
      membersUnlocked: c.get("members"),
      membersGateChallenge: pickMembersGateChallenge(),
      error: c.req.query("error") ?? undefined,
    }),
  );
});

app.get("/api/access/draft", (c) => {
  const mac = c.get("mac");
  if (!mac) return c.json({ error: "Unknown device" }, 400);
  const draft = getAccessDraft(mac);
  return c.json({
    mac,
    draft: draft
      ? {
          amount_cents: draft.amount_cents,
          method: draft.method,
          guest_handle: draft.guest_handle,
          playa_name: draft.playa_name,
        }
      : { ...EMPTY_ACCESS_DRAFT },
    updated_at: draft?.updated_at ?? null,
  });
});

app.post("/api/access/draft", async (c) => {
  const mac = c.get("mac");
  if (!mac) return c.json({ error: "Unknown device — reconnect to Wi‑Fi." }, 400);
  let body: Partial<AccessDraftFields> = {};
  try {
    body = (await c.req.json()) as Partial<AccessDraftFields>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const draft = saveAccessDraft(mac, body);
  return c.json({
    mac: draft.mac,
    draft: {
      amount_cents: draft.amount_cents,
      method: draft.method,
      guest_handle: draft.guest_handle,
      playa_name: draft.playa_name,
    },
    updated_at: draft.updated_at,
  });
});

app.post("/members-unlock", async (c) => {
  const body = await c.req.parseBody();
  const answer = String(body.answer || "");
  const challenge = String(body.challenge || "");
  if (!(await verifyMembersGateAnswer(answer, challenge))) {
    return c.json({ ok: false, error: "Incorrect answer." }, 401);
  }
  setCookie(c, MEMBERS_COOKIE, "1", {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 7,
  });
  return c.json({ ok: true });
});

app.post("/api/device/playa-name", async (c) => {
  const mac = c.get("mac");
  if (!mac) {
    return c.json({ ok: false, error: "Unknown device — reconnect to Wi‑Fi." }, 400);
  }
  let raw = "";
  const contentType = c.req.header("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await c.req.json()) as { playa_name?: string };
      raw = String(body.playa_name || "");
    } catch {
      return c.json({ ok: false, error: "Invalid JSON" }, 400);
    }
  } else {
    const body = await c.req.parseBody();
    raw = String(body.playa_name || "");
  }
  const playa = sanitizePlayaName(raw);
  if (!playa) {
    return c.json({ ok: false, error: "Enter your playa name." }, 400);
  }
  const existing = getDevice(mac);
  if (sanitizePlayaName(existing?.playa_name || "")) {
    return c.json({ ok: true, playa_name: existing!.playa_name, already_set: true });
  }
  const device = upsertDevice(mac, { playa_name: playa });
  console.log(`[playa-name] new device ${device.mac} → ${playa}`);
  return c.json({ ok: true, playa_name: device.playa_name, already_set: false });
});

app.get("/quick", async (c) => {
  return c.redirect("/access");
});

app.post("/quick", async (c) => {
  const body = await c.req.parseBody();
  const macRaw = String(body.mac || c.get("mac") || "");
  if (!macRaw) {
    return c.redirect(`/access?error=${encodeURIComponent("Unknown device — reconnect to Wi‑Fi.")}`);
  }
  let mac: string;
  try {
    mac = normalizeMac(macRaw);
  } catch {
    return c.redirect(`/access?error=${encodeURIComponent("Unknown device — reconnect to Wi‑Fi.")}`);
  }
  if (isDeviceCurrentlyAllowed(getDevice(mac))) {
    return c.redirect("https://thephage.org/public/");
  }
  const cooldownMs = quickAccessCooldownRemainingMs(mac);
  if (cooldownMs > 0) {
    return c.redirect("/access");
  }
  const existing = getDevice(mac);
  const burner =
    sanitizePlayaName(String(body.playa_name || "")) ||
    sanitizePlayaName(existing?.playa_name || "") ||
    "quick";
  await grantQuickAccess(mac, burner);
  return c.redirect("https://thephage.org/public/");
});

async function grantQuickAccess(mac: string, burnerName: string): Promise<void> {
  const device = upsertDevice(mac, {
    status: "allowed",
    paid_until: sessionExpiryFromMinutes(QUICK_ACCESS_MINUTES),
    payment_method: "quick",
    playa_name: burnerName,
    label: "quick",
  });
  createPayment({
    mac,
    method: "quick",
    amount_cents: 0,
    status: "paid",
    playa_name: burnerName,
    note: `quick ${QUICK_ACCESS_MINUTES}m + ${QUICK_ACCESS_COOLDOWN_MINUTES}m cooldown`,
  });
  await grantAccess(device);
}

/** Test helper: revoke this device, clear members gate + quick cooldown so the access flow can be retested. */
app.post("/reset-access", async (c) => {
  const mac = c.get("mac");
  if (!mac) {
    return c.redirect(`/?error=${encodeURIComponent("Unknown device — reconnect to Wi‑Fi.")}`);
  }
  upsertDevice(mac, { status: "revoked", paid_until: Date.now() });
  clearQuickAccessHistory(mac);
  await denyAccess(mac);
  deleteCookie(c, MEMBERS_COOKIE, { path: "/" });
  return c.redirect("/access");
});

app.post("/pay/stripe", async (c) => {
  const body = await c.req.parseBody();
  const macRaw = String(body.mac || c.get("mac") || "");
  const playa = sanitizePlayaName(String(body.playa_name || ""));
  if (!macRaw) return c.redirect("/?error=Unknown%20device");
  if (!playa) return c.redirect("/?error=Playa%20name%20required");
  try {
    const { url } = await createCheckoutSession(macRaw, playa);
    return c.redirect(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Stripe error";
    return c.redirect(`/?error=${encodeURIComponent(msg)}`);
  }
});

app.get("/success", async (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) {
    return c.html(successPage({ ok: false, message: "Missing session_id." }));
  }
  try {
    const result = await confirmCheckoutSession(sessionId);
    return c.html(successPage(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not confirm payment";
    return c.html(successPage({ ok: false, message: msg }));
  }
});

app.get("/api/session/:id", async (c) => {
  try {
    const result = await confirmCheckoutSession(c.req.param("id"));
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return c.json({ ok: false, message: msg }, 400);
  }
});

app.get("/full", async (c) => {
  const err = c.req.query("error");
  return c.redirect(err ? `/access?error=${encodeURIComponent(err)}` : "/access");
});

app.post("/pay/manual", async (c) => {
  if (!c.get("members")) {
    return c.redirect("/access?error=Members%20only%20%E2%80%94%20unlock%20first");
  }
  const body = await c.req.parseBody();
  const amountRaw = String(body.amount_cents || "");
  const amountCents =
    amountRaw === "custom"
      ? parseDonationDollarsToCents(String(body.custom_amount || ""))
      : parseDonationTierCents(amountRaw);
  if (amountCents == null) {
    return c.redirect("/access?error=Select%20a%20donation%20level");
  }

  const methodRaw = String(body.method || "");
  /** $0 / camp-support needs no payment rail; otherwise honor-system pick. */
  type ManualOrGift = "gift" | "venmo" | "paypal" | "zelle" | "bitcoin" | "cash";
  let method: ManualOrGift;
  if (amountCents === 0) {
    method = "gift";
  } else if (isManualPayMethod(methodRaw)) {
    method = methodRaw;
  } else {
    return c.redirect("/access?error=Invalid%20payment%20method");
  }

  const macRaw = String(body.mac || c.get("mac") || "");
  if (!macRaw) return c.redirect("/access?error=Unknown%20device");
  const mac = normalizeMac(macRaw);
  const existing = getDevice(mac);
  const playa =
    sanitizePlayaName(existing?.playa_name || "") ||
    sanitizePlayaName(String(body.playa_name || ""));
  if (!playa) return c.redirect("/access?error=Burner%20name%20required");

  if (method !== "gift" && method !== "cash") {
    const settings = getSettings();
    const configured =
      (method === "venmo" && settings.venmo_handle.trim()) ||
      (method === "paypal" && settings.paypal_me.trim()) ||
      (method === "zelle" && settings.zelle_handle.trim()) ||
      (method === "bitcoin" && settings.bitcoin_address.trim());
    if (!configured) {
      return c.redirect("/access?error=That%20payment%20method%20is%20not%20configured");
    }
  }

  const tierLabel =
    amountCents === 0
      ? "camp support / $0"
      : `$${(amountCents / 100).toFixed(amountCents % 100 === 0 ? 0 : 2)} donation`;
  // Honor system: unlock immediately — no admin payment verification.
  const device = upsertDevice(mac, {
    status: "allowed",
    paid_until: null,
    payment_method: method,
    playa_name: playa,
  });
  createPayment({
    mac,
    method,
    amount_cents: amountCents,
    status: "paid",
    note: `${tierLabel} · ${playa}`,
    playa_name: playa,
  });
  await grantAccess(device);
  return c.html(
    successPage({
      ok: true,
      mac,
      message: "You're online. Thanks for supporting camp — payment is optional and on the honor system.",
    }),
  );
});

app.get("/admin/login", (c) => {
  if (c.get("admin")) return c.redirect("/admin");
  return c.html(adminLoginPage());
});

app.post("/admin/login", async (c) => {
  const body = await c.req.parseBody();
  if (String(body.password || "") !== config.adminPassword) {
    return c.html(adminLoginPage("Wrong password."), 401);
  }
  setCookie(c, ADMIN_COOKIE, "1", {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 7,
  });
  return c.redirect("/admin");
});

app.post("/admin/logout", (c) => {
  deleteCookie(c, ADMIN_COOKIE, { path: "/" });
  return c.redirect("/admin/login");
});

app.get("/admin", requireAdmin(), (c) => {
  return c.html(
    adminDashboard({
      settings: getSettings(),
      devices: listDevicesWithAccessDrafts(),
      pending: listPayments("pending").filter(
        (p) =>
          p.method === "venmo" ||
          p.method === "paypal" ||
          p.method === "cashapp" ||
          p.method === "zelle" ||
          p.method === "bitcoin",
      ),
      payments: listPayments(),
      siteWhitelist: listSiteWhitelist(),
      flash: c.req.query("flash") ?? undefined,
    }),
  );
});

function eventFieldsFromBody(body: Record<string, string | File | (string | File)[]>): {
  title: string;
  description: string;
  location: string;
  host: string;
  starts_at: number;
  ends_at: number | null;
} | { error: string } {
  const title = String(body.title || "").trim();
  if (!title) return { error: "Title is required" };
  const startsAt = parsePlayaLocal(String(body.starts_at || ""));
  if (startsAt == null) return { error: "Start time is required" };
  const endsRaw = String(body.ends_at || "").trim();
  const endsAt = endsRaw ? parsePlayaLocal(endsRaw) : null;
  if (endsRaw && endsAt == null) return { error: "End time is invalid" };
  if (endsAt != null && endsAt < startsAt) return { error: "End must be after start" };
  return {
    title,
    description: String(body.description || ""),
    location: String(body.location || ""),
    host: String(body.host || ""),
    starts_at: startsAt,
    ends_at: endsAt,
  };
}

app.get("/admin/events", requireAdmin(), (c) => {
  const query = String(c.req.query("q") ?? "");
  const editId = Number(c.req.query("edit") || 0);
  const events = searchEvents(query, ADMIN_EVENT_LIMIT);
  const total = countEvents(query);
  return c.html(
    adminEventsPage({
      events,
      total,
      limit: ADMIN_EVENT_LIMIT,
      editing: editId ? getEvent(editId) : null,
      query,
      flash: c.req.query("flash") ?? undefined,
      error: c.req.query("error") ?? undefined,
    }),
  );
});

app.post("/admin/events", requireAdmin(), async (c) => {
  const fields = eventFieldsFromBody(await c.req.parseBody());
  if ("error" in fields) {
    return c.redirect(`/admin/events?error=${encodeURIComponent(fields.error)}`);
  }
  createEvent(fields);
  return c.redirect("/admin/events?flash=Event%20added");
});

app.post("/admin/events/:id/delete", requireAdmin(), (c) => {
  deleteEvent(Number(c.req.param("id")));
  return c.redirect("/admin/events?flash=Event%20deleted");
});

app.post("/admin/events/:id", requireAdmin(), async (c) => {
  const id = Number(c.req.param("id"));
  if (!getEvent(id)) return c.redirect("/admin/events?error=Event%20not%20found");
  const fields = eventFieldsFromBody(await c.req.parseBody());
  if ("error" in fields) {
    return c.redirect(`/admin/events?edit=${id}&error=${encodeURIComponent(fields.error)}`);
  }
  updateEvent(id, fields);
  return c.redirect("/admin/events?flash=Event%20saved");
});

app.post("/admin/settings", requireAdmin(), async (c) => {
  const body = await c.req.parseBody();
  updateSettings({
    camp_name: String(body.camp_name || ""),
    welcome_message: String(body.welcome_message || ""),
    price_cents: Number(body.price_cents || 1000),
    fundraising_goal_cents: Number(body.fundraising_goal_cents || 50000),
    currency: String(body.currency || "usd").toLowerCase(),
    session_hours: Number(body.session_hours || 24),
    venmo_handle: String(body.venmo_handle || ""),
    paypal_me: String(body.paypal_me || ""),
    cashapp_handle: "",
    zelle_handle: String(body.zelle_handle || ""),
    bitcoin_address: String(body.bitcoin_address || ""),
  });
  return c.redirect("/admin?flash=Settings%20saved");
});

async function approvePayment(id: number): Promise<void> {
  const payment = getPayment(id);
  if (!payment) throw new Error("Payment not found");
  updatePayment(id, { status: "paid" });
  const device = upsertDevice(payment.mac, {
    status: "allowed",
    paid_until: null,
    payment_method: payment.method,
  });
  await grantAccess(device);
}

app.post("/admin/payments/:id/approve", requireAdmin(), async (c) => {
  await approvePayment(Number(c.req.param("id")));
  return c.redirect("/admin?flash=Device%20approved");
});

app.post("/admin/payments/:id/reject", requireAdmin(), async (c) => {
  const id = Number(c.req.param("id"));
  const payment = getPayment(id);
  if (payment) {
    updatePayment(id, { status: "rejected" });
    upsertDevice(payment.mac, { status: "blocked" });
    await denyAccess(payment.mac);
  }
  return c.redirect("/admin?flash=Request%20rejected");
});

app.post("/admin/devices/comp", requireAdmin(), async (c) => {
  const body = await c.req.parseBody();
  const mac = normalizeMac(String(body.mac || ""));
  const label = String(body.label || "") || "comped";
  const device = upsertDevice(mac, {
    status: "allowed",
    paid_until: sessionExpiryMs(),
    payment_method: "comp",
    label,
  });
  createPayment({
    mac,
    method: "comp",
    amount_cents: 0,
    status: "paid",
    note: label,
  });
  await grantAccess(device);
  return c.redirect("/admin?flash=Device%20comped");
});

app.post("/admin/devices/:mac/comp", requireAdmin(), async (c) => {
  const mac = normalizeMac(decodeURIComponent(c.req.param("mac")));
  const device = upsertDevice(mac, {
    status: "allowed",
    paid_until: sessionExpiryMs(),
    payment_method: "comp",
    label: "comped",
  });
  createPayment({ mac, method: "comp", amount_cents: 0, status: "paid", note: "comped" });
  await grantAccess(device);
  return c.redirect("/admin?flash=Device%20comped");
});

app.post("/admin/devices/:mac/revoke", requireAdmin(), async (c) => {
  const mac = normalizeMac(decodeURIComponent(c.req.param("mac")));
  upsertDevice(mac, { status: "revoked", paid_until: Date.now() });
  await denyAccess(mac);
  return c.redirect("/admin?flash=Device%20revoked");
});

app.post("/admin/whitelist/revoke", requireAdmin(), async (c) => {
  const body = await c.req.parseBody();
  const url = String(body.url || "");
  const entry = revokeSiteWhitelist(url);
  if (!entry) return c.redirect("/admin?flash=Site%20not%20found");
  await syncSiteWhitelistNetwork();
  return c.redirect("/admin?flash=Site%20whitelist%20revoked");
});

app.notFound((c) => {
  // Captive portals probe random hosts — send them to paywall
  if (c.req.method === "GET") return c.redirect("/");
  return c.text("Not found", 404);
});
