import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { listApprovedSiteHostnames } from "./db.js";
import { ensureAllowedDestsSupport, syncAllowedDestIps } from "./firewall.js";
import {
  permanentWhitelistDnsmasqHostnames,
  permanentWhitelistResolveHostnames,
} from "./permanent-whitelist.js";

const execFileAsync = promisify(execFile);

function dnsmasqConfPath(): string {
  return config.dnsmasqWhitelistConf;
}

function dataDirConfPath(): string {
  return path.join(config.dataDir, "dnsmasq-site-whitelist.conf");
}

function buildDnsmasqSnippet(hostnames: string[]): string {
  const lines = [
    "# Managed by starlinkpayment — do not edit by hand",
    "# Real upstream DNS for permanent + crowd-approved sites (overrides address=/#/ portal hijack)",
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
    await execFileAsync("systemctl", ["reload", "dnsmasq"], { timeout: 10_000 });
    console.log("[site-whitelist] reloaded dnsmasq");
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

function mergeHostnames(...lists: string[][]): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    for (const h of list) set.add(h.toLowerCase());
  }
  return [...set].sort();
}

/** Write dnsmasq exceptions + nftables destination allowlist for approved hostnames. */
export async function syncSiteWhitelistNetwork(): Promise<void> {
  const crowdHostnames = listApprovedSiteHostnames();
  const permanentDns = permanentWhitelistDnsmasqHostnames();
  const dnsmasqHosts = mergeHostnames(permanentDns, crowdHostnames);
  const snippet = buildDnsmasqSnippet(dnsmasqHosts);

  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(dataDirConfPath(), snippet, "utf8");

  let wroteSystemConf = false;
  try {
    const dest = dnsmasqConfPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, snippet, "utf8");
    wroteSystemConf = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[site-whitelist] could not write ${dnsmasqConfPath()}: ${msg}`);
    console.warn(`[site-whitelist] copy kept at ${dataDirConfPath()}`);
  }

  if (wroteSystemConf && config.firewallEnabled) {
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
  console.log(
    `[site-whitelist] synced ${dnsmasqHosts.length} hostname(s) ` +
      `(${permanentDns.length} permanent, ${crowdHostnames.length} crowd), ` +
      `${allIps.size} IPv4 destination(s)`,
  );
}
