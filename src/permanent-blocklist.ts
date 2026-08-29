/**
 * Destinations that are always blocked — paid and unpaid devices.
 * DNS sinkhole (dnsmasq address=) plus nftables drop of dedicated prefixes
 * and resolved IPs (except shared Google frontends).
 *
 * Apex entries cover that host and all subdomains in dnsmasq (`address=/apex/0.0.0.0`).
 * CIDRs are ByteDance/TikTok space only — not shared Google/Akamai/Fastly ranges.
 */

const TIKTOK_DOMAINS: readonly string[] = [
  "tiktok.com",
  "tiktokv.com",
  "tiktokv.eu",
  "tiktokv.us",
  "tiktokv-eu.com",
  "tiktokv-us.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "tiktokcdn-eu.net",
  "tiktokcdn-in.com",
  "tiktokcdn-row.com",
  "tiktok-cdns.com",
  "tiktokw.eu",
  "tiktokw.us",
  "tiktok.us",
  "tiktok.in",
  "tiktok.org",
  "tiktok.shop",
  "tiktokd.net",
  "tiktokd.org",
  "tiktok-row.net",
  "tiktok-row.org",
  "tiktok-us.net",
  "tiktok-eu.net",
  "tiktok-usts.net",
  "tiktok-usts.com",
  "tiktok-minis.com",
  "tiktok-minis.eu",
  "tiktok-minis.us",
  "tiktokminis.us",
  "tiktokmusic.app",
  "tiktokstaticb.com",
  "tiktokcreativeone.com",
  "tiktokglobalshop.com",
  "tiktokglobalshop.eu",
  "tiktokglobalshop.us",
  "tiktokglobalshopv.com",
  "tiktokglobalshop-governance.com",
  "tiktokshop.com",
  "tiktokshopglobalselling.com",
  "tiktokshops.us",
  "tiktoklinksafety.com",
  "tiktoklinksafety.eu",
  "tiktoklinksafety.us",
  "musical.ly",
  "musically.ly",
  "muscdn.com",
  "musemuse.cn",
  "amemv.com",
  "ttwstatic.com",
  "ttlstatic.com",
  "ttlivecdn.com",
  "tlivecdn.com",
  "tlivepush.com",
  "ttcdn-us.com",
  "ttapis.com",
  "ttoversea.net",
  "ttoverseaus.net",
  "ttdns2.com",
  "byteoversea.com",
  "byteoversea.net",
  "ibyteimg.com",
  "ibytedtos.com",
  "byteimg.com",
  "pstatp.com",
  "ipstatp.com",
  "isnssdk.com",
  "sgsnssdk.com",
  "snssdk.com",
  "bytedance.com",
  "bytedance.net",
  "bytedance.info",
  "byteintl.com",
  "byteintl.net",
  "byteintlapi.com",
  "bytefcdn-oversea.com",
  "bytefcdn-ttpeu.com",
  "bytetcdn.com",
  "byteglb.com",
  "byteigtm.com",
  "qlivecdn.com",
  "hypstarcdn.com",
];

const REDDIT_DOMAINS: readonly string[] = [
  "reddit.com",
  "redd.it",
  "redditmedia.com",
  "redditstatic.com",
  "redditinc.com",
  "redditmail.com",
  "reddituploads.com",
  "redditblog.com",
  "reddithelp.com",
  "redditgifts.com",
  "redditforbusiness.com",
];

/**
 * Major news sites, wires, and aggregators. Apex only — do not add google.com,
 * yahoo.com, sky.com, go.com, or apple.com (those hosts other services).
 */
const NEWS_DOMAINS: readonly string[] = [
  // US TV / cable
  "cnn.com",
  "cnn.io",
  "foxnews.com",
  "foxbusiness.com",
  "msnbc.com",
  "nbcnews.com",
  "abcnews.com",
  "cbsnews.com",
  "cbsnewsdc.com",
  "cnbc.com",
  "npr.org",
  "newshour.org",
  "pbs.org",
  // Wires / business
  "reuters.com",
  "apnews.com",
  "ap.org",
  "associatedpress.com",
  "bloomberg.com",
  "bloomberg.net",
  "wsj.com",
  "wsj.net",
  "ft.com",
  "marketwatch.com",
  "barrons.com",
  // US papers / digital
  "nytimes.com",
  "nyt.com",
  "nytimes.net",
  "washingtonpost.com",
  "washpost.com",
  "wapo.st",
  "latimes.com",
  "usatoday.com",
  "usatoday.net",
  "nypost.com",
  "politico.com",
  "thehill.com",
  "axios.com",
  "theatlantic.com",
  "economist.com",
  "time.com",
  "newsweek.com",
  "forbes.com",
  "businessinsider.com",
  "insider.com",
  "huffpost.com",
  "huffingtonpost.com",
  "vox.com",
  "slate.com",
  "salon.com",
  "thedailybeast.com",
  "theintercept.com",
  "motherjones.com",
  "thenation.com",
  "nationalreview.com",
  "thefederalist.com",
  "dailywire.com",
  "breitbart.com",
  "newsmax.com",
  "oann.com",
  "dailykos.com",
  "talkingpointsmemo.com",
  "rawstory.com",
  "mediaite.com",
  "theweek.com",
  "reason.com",
  "realclearpolitics.com",
  "drudgereport.com",
  "allsides.com",
  // UK / international
  "bbc.com",
  "bbc.co.uk",
  "bbci.co.uk",
  "theguardian.com",
  "guardian.co.uk",
  "theguardian.co.uk",
  "independent.co.uk",
  "the-independent.com",
  "telegraph.co.uk",
  "dailymail.co.uk",
  "dailymail.com",
  "skynews.com",
  "aljazeera.com",
  "aljazeera.net",
  "news.com.au",
  "smh.com.au",
  "theage.com.au",
  "cbc.ca",
  "globalnews.ca",
  "ctvnews.ca",
  "globeandmail.com",
  // Aggregators / “feeds”
  "msn.com",
  "flipboard.com",
  "ground.news",
  "groundnews.com",
  "newsbreak.com",
  "newsbreakapp.com",
  "smartnews.com",
  "feedly.com",
  "inoreader.com",
  "newsblur.com",
  "theoldreader.com",
  "apple.news",
];

/**
 * Hosts that live on shared Google/Apple/Yahoo/Disney/Sky frontends.
 * DNS-sinkhole only — never add their A records to nft (would block Search, iCloud, etc.).
 */
const DNS_ONLY_BLOCK_HOSTNAMES: readonly string[] = [
  "news.google.com",
  "news.google.co.uk",
  "news.google.ca",
  "news.google.com.au",
  "news.google.co.in",
  "news.google.co.nz",
  "news.google.co.za",
  "news.google.ie",
  "news.google.de",
  "news.google.fr",
  "news.google.es",
  "news.google.it",
  "news.google.nl",
  "news.google.com.mx",
  "news.google.com.br",
  "news.google.co.jp",
  "news.google.com.sg",
  "news.google.com.hk",
  "news.google.com.tw",
  "news.google.co.kr",
  "news.google.com.ar",
  "news.google.com.ph",
  "news.google.com.my",
  "news.google.co.il",
  "news.google.ae",
  "news.google.com.sa",
  "news.google.com.pk",
  "news.google.com.ng",
  "news.google.pl",
  "news.google.pt",
  "news.google.se",
  "news.google.no",
  "news.google.dk",
  "news.google.fi",
  "news.google.be",
  "news.google.at",
  "news.google.ch",
  "news.google.com.tr",
  "news.google.co.th",
  "news.google.com.vn",
  "news.google.com.co",
  "news.google.cl",
  "news.google.com.pe",
  "news-pa.googleapis.com",
  "news.apple.com",
  "news-assets.apple.com",
  "news.yahoo.com",
  "ca.news.yahoo.com",
  "uk.news.yahoo.com",
  "au.news.yahoo.com",
  "news.sky.com",
  "abcnews.go.com",
];

/** Full hostnames on shared CDNs (do not wildcard the CDN apex). */
export const PERMANENT_BLOCKLIST_RESOLVE_EXTRA: readonly string[] = [
  "www.tiktok.com",
  "m.tiktok.com",
  "api.tiktok.com",
  "api.tiktokv.com",
  "p16-tiktokcdn-com.akamaized.net",
  "v16-tiktokcdn-com.akamaized.net",
  "tiktokcdn-com.akamaized.net",
  "reddit.map.fastly.net",
  "www.reddit.com",
  "old.reddit.com",
  "oauth.reddit.com",
  "gql.reddit.com",
  "gql-fed.reddit.com",
];

export const PERMANENT_BLOCKLIST_DOMAINS: readonly string[] = [
  ...TIKTOK_DOMAINS,
  ...REDDIT_DOMAINS,
  ...NEWS_DOMAINS,
];

/**
 * Dedicated TikTok / ByteDance IPv4 prefixes (AS396986 / AS138699).
 * Do not add Google or Akamai ranges here — those are shared.
 */
export const PERMANENT_BLOCKLIST_IPV4_CIDRS: readonly string[] = [
  "71.18.0.0/16",
  "103.136.220.0/22",
  "118.26.132.0/24",
  "199.103.24.0/23",
];

export const PERMANENT_BLOCKLIST_IPV6_CIDRS: readonly string[] = [
  "2404:9dc0:cd01::/48",
  "2404:9dc0:cd03::/48",
];

const DNS_ONLY_SET = new Set(DNS_ONLY_BLOCK_HOSTNAMES.map((h) => h.toLowerCase()));

/** Google News / Discover-style hosts (not google.com itself). */
export function isGoogleNewsHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return /^news\.google\./.test(host) || host.endsWith(".news.google.com");
}

function isDnsOnlyBlockedHostname(host: string): boolean {
  if (DNS_ONLY_SET.has(host) || isGoogleNewsHostname(host)) return true;
  if (/(^|\.)news\.yahoo\.com$/.test(host)) return true;
  if (host === "news.apple.com" || host.endsWith(".news.apple.com")) return true;
  if (host === "apple.news" || host.endsWith(".apple.news")) return true;
  if (host === "news.sky.com" || host.endsWith(".news.sky.com")) return true;
  if (host === "abcnews.go.com" || host.endsWith(".abcnews.go.com")) return true;
  if (host === "news-pa.googleapis.com" || host.endsWith(".news-pa.googleapis.com")) return true;
  return false;
}

export function permanentBlocklistDnsmasqHostnames(): string[] {
  const set = new Set<string>();
  for (const h of PERMANENT_BLOCKLIST_DOMAINS) set.add(h.toLowerCase());
  for (const h of PERMANENT_BLOCKLIST_RESOLVE_EXTRA) set.add(h.toLowerCase());
  for (const h of DNS_ONLY_BLOCK_HOSTNAMES) set.add(h.toLowerCase());
  return [...set].sort();
}

/** Hostnames whose A records are safe-ish to drop in nft (not Google/Apple shared frontends). */
export function permanentBlocklistResolveHostnames(): string[] {
  const set = new Set<string>();
  for (const h of PERMANENT_BLOCKLIST_DOMAINS) set.add(h.toLowerCase());
  for (const h of PERMANENT_BLOCKLIST_RESOLVE_EXTRA) set.add(h.toLowerCase());
  return [...set].filter((h) => !isDnsOnlyBlockedHostname(h)).sort();
}

export function isPermanentlyBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (isDnsOnlyBlockedHostname(host)) return true;
  if (PERMANENT_BLOCKLIST_RESOLVE_EXTRA.some((d) => host === d.toLowerCase())) return true;
  return PERMANENT_BLOCKLIST_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Google search/news anycast — blocking these IPs would take down Search/Gmail/Maps. */
export function isSharedGoogleFrontendIp(ip: string): boolean {
  return /^(142\.250\.|172\.217\.|216\.58\.|74\.125\.|108\.177\.|64\.233\.|66\.102\.|72\.14\.|209\.85\.|173\.194\.|8\.8\.8\.|8\.8\.4\.)/.test(
    ip,
  );
}
