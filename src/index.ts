import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { initDb } from "./db.js";
import { ensureFirewall, expireStaleDevices, syncAllowlistFromDb } from "./firewall.js";
import { app } from "./routes.js";
import { syncSiteWhitelistNetwork } from "./site-whitelist.js";

async function main() {
  initDb();
  await ensureFirewall();
  await syncSiteWhitelistNetwork();

  setInterval(() => {
    const n = expireStaleDevices();
    if (n > 0) {
      console.log(`[expire] revoked ${n} stale device(s)`);
      void syncAllowlistFromDb();
    }
  }, 60_000).unref();

  // CDN IPs drift — refresh crowd-approved destinations periodically
  setInterval(() => {
    void syncSiteWhitelistNetwork();
  }, 15 * 60_000).unref();

  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
    },
    (info) => {
      console.log(`Starlink paywall listening on http://${info.address}:${info.port}`);
      console.log(`Public URL: ${config.publicUrl}`);
      console.log(`Admin: ${config.publicUrl}/admin`);
      console.log(`Firewall: ${config.firewallEnabled ? "enabled" : "disabled"}`);
    },
  );
  if ("requestTimeout" in server) {
    (server as { requestTimeout: number }).requestTimeout = 0;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
