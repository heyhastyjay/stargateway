import "dotenv/config";
import path from "node:path";

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? "0.0.0.0",
  publicUrl: (process.env.PUBLIC_URL ?? "http://10.0.0.1:8080").replace(/\/$/, ""),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  adminPassword: process.env.ADMIN_PASSWORD ?? "changeme",
  /**
   * Fallback answer for the members gate when the kitchen sheet cannot be fetched.
   * Live answer is Friday Dinner "Head Playa Chef" from membersSheetId.
   */
  membersPassword: process.env.MEMBERS_PASSWORD ?? "Ladan",
  membersSheetId:
    process.env.MEMBERS_SHEET_ID ?? "1xMS9to9eNmmhnzOncK-b5qdm1Na-Mzxg-mdSQBt-MYo",
  membersSheetGid: process.env.MEMBERS_SHEET_GID ?? "1827469735",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
  stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
  firewallEnabled: envBool("FIREWALL_ENABLED", false),
  lanInterface: process.env.LAN_INTERFACE ?? "wlan0",
  wanInterface: process.env.WAN_INTERFACE ?? "eth0",
  portalIp: process.env.PORTAL_IP ?? "10.0.0.1",
  portalPort: Number(process.env.PORTAL_PORT ?? process.env.PORT ?? 8080),
  devClientMac: process.env.DEV_CLIENT_MAC?.toLowerCase() ?? null,
  /** Comma-separated factory Wi‑Fi MACs allowed to set remaining Starlink data. */
  dataOperatorIds: process.env.DATA_OPERATOR_IDS ?? "",
  /** Upstream resolver used in dnsmasq exceptions for crowd-approved sites. */
  whitelistUpstreamDns: process.env.WHITELIST_UPSTREAM_DNS ?? "8.8.8.8",
  dnsmasqWhitelistConf:
    process.env.DNSMASQ_WHITELIST_CONF ?? "/etc/dnsmasq.d/starlink-paywall-whitelist.conf",
  dnsmasqBlocklistConf:
    process.env.DNSMASQ_BLOCKLIST_CONF ?? "/etc/dnsmasq.d/starlink-paywall-block.conf",
};

export type Config = typeof config;
