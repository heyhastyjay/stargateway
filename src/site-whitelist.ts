import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { listApprovedSiteHostnames } from "./db.js";
import { ensureAllowedDestsSupport, syncAllowedDestIps, syncBlockedDestIps } from "./firewall.js";
import {
  PERMANENT_BLOCKLIST_IPV4_CIDRS,
  PERMANENT_BLOCKLIST_IPV6_CIDRS,
  isPermanentlyBlockedHostname,
  isSharedGoogleFrontendIp,
  permanentBlocklistDnsmasqHostnames,
  permanentBlocklistResolveHostnames,
} from "./permanent-blocklist.js";
import {
  permanentWhitelistDnsmasqHostnames,
  permanentWhitelistResolveHostnames,
} from "./permanent-whitelist.js";

const execFileAsync = promisify(execFile);

function dnsmasqConfPath(): string {
  return config.dnsmasqWhitelistConf;
}

function dnsmasqBlockConfPath(): string {
  return config.dnsmasqBlocklistConf;
}

function dataDirConfPath(): string {
  return path.join(config.dataDir, "dnsmasq-site-whitelist.conf");
}

function dataDirBlockConfPath(): string {
  return path.join(config.dataDir, "dnsmasq-site-block.conf");
}

function buildDnsmasqSnippet(hostnames: string[]): string {
  const lines = [
    "# Managed by starlinkpayment — do not edit by hand",
    "# Real upstream DNS for permanent + crowd-approved sites.",
  ];
  const dns = config.whitelistUpstreamDns;
  for (const host of hostnames) {
    lines.push(`server=/${host}/${dns}`);
  }
  if (hostnames.length === 0) {
    lines.push("# (no approved sites)");
  }
  lines.push("");
  return lines.join("\n");
}

async function resolveHostIps(hostname: string): Promise<string[]> {
  const ips = new Set<string>();
  try {
    for (const a of await dns.resolve4(hostname)) ips.add(a);
  } catch {
    /* ignore */
  }
  try {
    // Some resolvers only answer via lookup
    const looked = await dns.lookup(hostname, { all: true, family: 4 });
    for (const a of looked) ips.add(a.address);
  } catch {
    /* ignore */
  }
  return [...ips];
}

async function reloadDnsmasq(): Promise<void> {
  try {
    await execFileAsync("systemctl", ["restart", "dnsmasq"], { timeout: 10_000 });
    console.log("[site-whitelist] restarted dnsmasq");
    return;
  } catch {
    /* try kill -HUP */
  }
  try {
    const { stdout } = await execFileAsync("pidof", ["dnsmasq"], { timeout: 5000 });
    const pid = stdout.trim().split(/\s+/)[0];
    if (pid) {
      await execFileAsync("kill", ["-HUP", pid], { timeout: 5000 });
      console.log("[site-whitelist] SIGHUP dnsmasq");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[site-whitelist] could not reload dnsmasq:", msg);
  }
}

function buildDnsmasqBlockSnippet(hostnames: string[]): string {
  const lines = [
    "# Managed by starlinkpayment — do not edit by hand",
    "# Always-on block: TikTok, Reddit, Google News, major news (all devices). Overrides whitelist server=/",
  ];
  for (const host of hostnames) {
    lines.push(`address=/${host}/0.0.0.0`);
  }
  if (hostnames.length === 0) {
    lines.push("# (no blocked sites)");
  }
  lines.push("");
  return lines.join("\n");
}

function writeConfIfChanged(dest: string, snippet: string): { wrote: boolean; changed: boolean } {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let prev = "";
  try {
    prev = fs.readFileSync(dest, "utf8");
  } catch {
    /* first write */
  }
  if (prev === snippet) return { wrote: true, changed: false };
  fs.writeFileSync(dest, snippet, "utf8");
  return { wrote: true, changed: true };
}

function mergeHostnames(...lists: string[][]): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    for (const h of list) set.add(h.toLowerCase());
  }
  return [...set].sort();
}

/** Write dnsmasq exceptions + nftables destination allowlist for approved hostnames. */
export async function syncSiteWhitelistNetwork(): Promise<void> {
  const crowdHostnames = listApprovedSiteHostnames().filter((h) => !isPermanentlyBlockedHostname(h));
  const permanentDns = permanentWhitelistDnsmasqHostnames();
  const blockedDns = permanentBlocklistDnsmasqHostnames();
  const dnsmasqHosts = mergeHostnames(permanentDns, crowdHostnames);
  const snippet = buildDnsmasqSnippet(dnsmasqHosts);
  const blockSnippet = buildDnsmasqBlockSnippet(blockedDns);

  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(dataDirConfPath(), snippet, "utf8");
  fs.writeFileSync(dataDirBlockConfPath(), blockSnippet, "utf8");

  let wroteSystemConf = false;
  let dnsmasqChanged = false;
  try {
    const white = writeConfIfChanged(dnsmasqConfPath(), snippet);
    const block = writeConfIfChanged(dnsmasqBlockConfPath(), blockSnippet);
    wroteSystemConf = white.wrote && block.wrote;
    dnsmasqChanged = white.changed || block.changed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[site-whitelist] could not write dnsmasq conf: ${msg}`);
    console.warn(`[site-whitelist] copies kept at ${dataDirConfPath()} and ${dataDirBlockConfPath()}`);
  }

  if (wroteSystemConf && config.firewallEnabled && dnsmasqChanged) {
    await reloadDnsmasq();
  }

  await ensureAllowedDestsSupport();

  const resolveHosts = mergeHostnames(permanentWhitelistResolveHostnames(), crowdHostnames);
  const allIps = new Set<string>();
  for (const host of resolveHosts) {
    for (const ip of await resolveHostIps(host)) {
      allIps.add(ip);
    }
  }
  await syncAllowedDestIps([...allIps]);

  const blockedResolved = new Set<string>();
  const resolvedLists = await Promise.all(
    permanentBlocklistResolveHostnames().map((host) => resolveHostIps(host)),
  );
  for (const ips of resolvedLists) {
    for (const ip of ips) {
      if (!allIps.has(ip) && !isSharedGoogleFrontendIp(ip)) blockedResolved.add(ip);
    }
  }
  await syncBlockedDestIps(
    [...PERMANENT_BLOCKLIST_IPV4_CIDRS, ...blockedResolved],
    [...PERMANENT_BLOCKLIST_IPV6_CIDRS],
  );

  console.log(
    `[site-whitelist] synced ${dnsmasqHosts.length} hostname(s) ` +
      `(${permanentDns.length} permanent, ${crowdHostnames.length} crowd), ` +
      `${allIps.size} IPv4 destination(s); ` +
      `blocked ${blockedDns.length} domain(s), ` +
      `${PERMANENT_BLOCKLIST_IPV4_CIDRS.length} cidr(s) + ${blockedResolved.size} resolved ip(s)`,
  );
}
