import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { getDb, isDeviceCurrentlyAllowed, listDevices, upsertDevice, type Device } from "./db.js";

const execFileAsync = promisify(execFile);

const TABLE = "starlink_paywall";
const SET_ALLOWED = "allowed_macs";
const SET_DESTS = "allowed_dests";

export async function runNft(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("nft", args, {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return (stdout || stderr || "").trim();
}

async function nftQuiet(args: string[]): Promise<boolean> {
  try {
    await runNft(args);
    return true;
  } catch {
    return false;
  }
}

export async function ensureFirewall(): Promise<void> {
  if (!config.firewallEnabled) {
    console.log("[firewall] disabled (FIREWALL_ENABLED=false)");
    return;
  }

  try {
    await runNft(["list", "table", "inet", TABLE]);
  } catch {
    const script = buildNftBootstrap();
    const tmp = path.join(config.dataDir, "bootstrap.nft");
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(tmp, script, "utf8");
    await runNft(["-f", tmp]);
    console.log("[firewall] created inet table", TABLE);
  }

  await syncAllowlistFromDb();
  await ensureAllowedDestsSupport();
}

function buildNftBootstrap(): string {
  const { lanInterface, wanInterface, portalIp, portalPort } = config;
  return `
table inet ${TABLE} {
  set ${SET_ALLOWED} {
    type ether_addr
    flags interval
  }

  set ${SET_DESTS} {
    type ipv4_addr
    flags interval
  }

  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    iifname "${lanInterface}" ether saddr @${SET_ALLOWED} accept
    iifname "${lanInterface}" ip daddr @${SET_DESTS} tcp dport { 80, 443 } accept
    iifname "${lanInterface}" tcp dport { 80, 443 } dnat ip to ${portalIp}:${portalPort}
    iifname "${lanInterface}" udp dport 53 accept
    iifname "${lanInterface}" tcp dport 53 accept
    iifname "${lanInterface}" ip daddr ${portalIp} tcp dport ${portalPort} accept
  }

  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    oifname "${wanInterface}" masquerade
  }

  chain forward {
    type filter hook forward priority filter; policy drop;
    ct state established,related accept
    iifname "${lanInterface}" oifname "${wanInterface}" ether saddr @${SET_ALLOWED} accept
    iifname "${lanInterface}" oifname "${wanInterface}" ip daddr @${SET_DESTS} accept
    iifname "${wanInterface}" oifname "${lanInterface}" ct state established,related accept
    iifname "${lanInterface}" ip daddr ${portalIp} accept
  }

  chain input {
    type filter hook input priority filter; policy accept;
    iifname "${lanInterface}" tcp dport ${portalPort} accept
    iifname "${lanInterface}" udp dport 53 accept
    iifname "${lanInterface}" tcp dport 53 accept
  }
}
`.trimStart();
}

/** Ensure allowed_dests set + skip-DNAT / forward rules exist on older tables. */
export async function ensureAllowedDestsSupport(): Promise<void> {
  if (!config.firewallEnabled) return;

  try {
    await runNft(["list", "set", "inet", TABLE, SET_DESTS]);
  } catch {
    const ok = await nftQuiet([
      "add",
      "set",
      "inet",
      TABLE,
      SET_DESTS,
      "{",
      "type",
      "ipv4_addr",
      ";",
      "flags",
      "interval",
      ";",
      "}",
    ]);
    if (ok) console.log(`[firewall] created set ${SET_DESTS}`);
  }

  let chain = "";
  try {
    chain = await runNft(["list", "chain", "inet", TABLE, "prerouting"]);
  } catch {
    return;
  }
  if (!chain.includes(`@${SET_DESTS}`)) {
    const { lanInterface } = config;
    await nftQuiet([
      "insert",
      "rule",
      "inet",
      TABLE,
      "prerouting",
      "iifname",
      lanInterface,
      "ip",
      "daddr",
      `@${SET_DESTS}`,
      "tcp",
      "dport",
      "{",
      "80,",
      "443",
      "}",
      "accept",
    ]);
  }

  try {
    chain = await runNft(["list", "chain", "inet", TABLE, "forward"]);
  } catch {
    return;
  }
  if (!chain.includes(`@${SET_DESTS}`)) {
    const { lanInterface, wanInterface } = config;
    await nftQuiet([
      "insert",
      "rule",
      "inet",
      TABLE,
      "forward",
      "iifname",
      lanInterface,
      "oifname",
      wanInterface,
      "ip",
      "daddr",
      `@${SET_DESTS}`,
      "accept",
    ]);
  }
}

/** Replace destination IP allowlist used for unpaid access to crowd-approved sites. */
export async function syncAllowedDestIps(ips: string[]): Promise<void> {
  if (!config.firewallEnabled) {
    console.log(`[firewall] dry-run allowed_dests (${ips.length} ip(s))`);
    return;
  }

  await ensureAllowedDestsSupport();

  try {
    await runNft(["flush", "set", "inet", TABLE, SET_DESTS]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[firewall] flush ${SET_DESTS}:`, msg);
  }

  for (const ip of ips) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
    try {
      await runNft(["add", "element", "inet", TABLE, SET_DESTS, "{", ip, "}"]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/exists|File exists/i.test(msg)) {
        console.warn(`[firewall] add dest ${ip}:`, msg);
      }
    }
  }
}

export async function allowMac(mac: string): Promise<void> {
  const normalized = mac.toLowerCase();
  if (!config.firewallEnabled) {
    console.log(`[firewall] dry-run allow ${normalized}`);
    return;
  }
  try {
    await runNft(["add", "element", "inet", TABLE, SET_ALLOWED, "{", normalized, "}"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/exists|File exists/i.test(msg)) {
      console.warn(`[firewall] allow ${normalized}:`, msg);
    }
  }
}

export async function revokeMac(mac: string): Promise<void> {
  const normalized = mac.toLowerCase();
  if (!config.firewallEnabled) {
    console.log(`[firewall] dry-run revoke ${normalized}`);
    return;
  }
  try {
    await runNft(["delete", "element", "inet", TABLE, SET_ALLOWED, "{", normalized, "}"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/No such file|does not exist|Element not found/i.test(msg)) {
      console.warn(`[firewall] revoke ${normalized}:`, msg);
    }
  }
}

export async function syncAllowlistFromDb(): Promise<void> {
  const devices = listDevices();
  const allowed = devices.filter(isDeviceCurrentlyAllowed);
  for (const d of allowed) {
    await allowMac(d.mac);
  }
  for (const d of devices) {
    if (!isDeviceCurrentlyAllowed(d)) {
      await revokeMac(d.mac);
    }
  }
  console.log(`[firewall] synced ${allowed.length} allowed device(s)`);
}

export async function grantAccess(device: Device): Promise<void> {
  if (!isDeviceCurrentlyAllowed(device)) return;
  await allowMac(device.mac);
}

export async function denyAccess(mac: string): Promise<void> {
  await revokeMac(mac);
}

/** Best-effort MAC lookup from ARP/neigh for a client IP. */
export async function lookupMacForIp(ip: string): Promise<string | null> {
  if (!ip || ip === "127.0.0.1" || ip === "::1") {
    return config.devClientMac;
  }

  try {
    const { stdout } = await execFileAsync("ip", ["neigh", "show", ip], { timeout: 5000 });
    const match = stdout.match(/lladdr\s+([0-9a-f:]+)/i);
    if (match) return match[1].toLowerCase();
  } catch {
    /* fall through */
  }

  try {
    const arp = fs.readFileSync("/proc/net/arp", "utf8");
    for (const line of arp.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === ip && parts[3] && parts[3] !== "00:00:00:00:00:00") {
        return parts[3].toLowerCase();
      }
    }
  } catch {
    /* ignore */
  }

  return config.devClientMac;
}

export function expireStaleDevices(): number {
  const now = Date.now();
  const stale = getDb()
    .prepare(
      `SELECT mac FROM devices WHERE status = 'allowed' AND paid_until IS NOT NULL AND paid_until < ?`,
    )
    .all(now) as unknown as Array<{ mac: string }>;

  for (const row of stale) {
    upsertDevice(row.mac, { status: "revoked", paid_until: now });
    void revokeMac(row.mac);
  }
  return stale.length;
}
