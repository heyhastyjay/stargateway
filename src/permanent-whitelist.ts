/**
 * Domains that are never blocked for unpaid devices (DNS + nft destination allowlist).
 * Apex entries cover that host and all subdomains in dnsmasq (`server=/apex/...`).
 */
export const PERMANENT_WHITELIST_DOMAINS: readonly string[] = [
  // Venmo
  "venmo.com",
  // Cash App (Block / Square)
  "cash.app",
  "cashapp.com",
  "squareup.com",
  "squarecdn.com",
  "square.com",
  // PayPal
  "paypal.com",
  "paypal.me",
  "paypalobjects.com",
  "braintreegateway.com",
  "braintreepayments.com",
  // Zelle
  "zellepay.com",
  "zelle.com",
  // Camp public site (post-unlock / browse destination)
  "thephage.org",
  // Burning Man Project + official playa properties (weather / events APIs)
  "burningman.org",
  "burningman.com",
  "blackrockarts.org",
  "blackrockcitycensus.org",
];

/**
 * Extra hostnames resolved for nft IP allowlisting (CDNs / APIs whose A records
 * may differ from the apex). Parent domains above still open DNS for all subs.
 */
export const PERMANENT_WHITELIST_RESOLVE_EXTRA: readonly string[] = [
  "www.venmo.com",
  "api.venmo.com",
  "www.cash.app",
  "api.cash.app",
  "www.paypal.com",
  "www.paypalobjects.com",
  "api.paypal.com",
  "www.zellepay.com",
  "api.zellepay.com",
  "www.burningman.org",
  "playaevents.burningman.org",
  "tickets.burningman.org",
  "profiles.burningman.org",
  "journal.burningman.org",
  "eplaya.burningman.org",
  "shop.burningman.org",
  "donate.burningman.org",
  "network.burningman.org",
  "regionals.burningman.org",
  "status.burningman.org",
  "helpticket.burningman.org",
  "gallery.burningman.org",
  "api.burningman.org",
  "spark.burningman.org",
];

export function permanentWhitelistDnsmasqHostnames(): string[] {
  return [...PERMANENT_WHITELIST_DOMAINS].map((h) => h.toLowerCase()).sort();
}

/** All hostnames to A-record resolve for destination allowlisting. */
export function permanentWhitelistResolveHostnames(): string[] {
  const set = new Set<string>();
  for (const h of PERMANENT_WHITELIST_DOMAINS) set.add(h.toLowerCase());
  for (const h of PERMANENT_WHITELIST_RESOLVE_EXTRA) set.add(h.toLowerCase());
  return [...set].sort();
}

export function isPermanentWhitelistHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return PERMANENT_WHITELIST_DOMAINS.some(
    (d) => host === d || host.endsWith(`.${d}`),
  );
}
