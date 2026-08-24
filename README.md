# Festival Starlink Per-Device Paywall

Captive portal for camp Starlink: guests land on a payment page, pay with **Venmo** (admin approve), and only **that device’s MAC** gets internet.

```
Starlink (ethernet)
   → Raspberry Pi / Linux gateway (this app + Wi‑Fi AP)
   → Camp phones
```

## Features

- Per-device allowlist via **nftables** (password sharing does not unlock other phones)
- **Venmo** — guest opens pay link → taps “I’ve paid” → admin Pending → you approve (no card fees)
- **Permanent site whitelist** — Venmo, Cash App, PayPal, Zelle, and Burning Man / the Institute domains are never blocked (even for unpaid devices)
- **Crowd site whitelist** — unpaid guests request an exact URL; after **3 unique device MACs** request the same link, that hostname is opened via DNS + nftables for the whole camp
- Admin panel: price, session length, Venmo handle, comp/revoke devices, revoke site whitelist
- Captive-portal probe endpoints for iOS/Android/Windows detection
- Stripe Checkout code remains in the repo but is not shown on the guest portal

## Quick start (UI only, no firewall)

Requires **Node 22+** (uses built-in `node:sqlite`).

```bash
cp .env.example .env
# edit ADMIN_PASSWORD; leave FIREWALL_ENABLED=false for laptop testing
/usr/bin/npm install --min-release-age=0
./scripts/ensure-server.sh install   # systemd --user + tsx watch (survives Cursor sandbox)
```

Open http://127.0.0.1:8080/ (uses `DEV_CLIENT_MAC` from `.env`).  
Admin: http://127.0.0.1:8080/admin

If the browser says it can’t connect after an agent edit, run `./scripts/ensure-server.sh` (do not start the app inside a sandboxed Cursor shell).

## Festival Pi setup

Hardware: Raspberry Pi (or similar) with ethernet from Starlink and a Wi‑Fi interface for camp (`wlan0`, or a USB adapter).

### 1. Copy the app

```bash
sudo mkdir -p /opt/starlinkpayment
sudo rsync -a --exclude node_modules --exclude data ./ /opt/starlinkpayment/
cd /opt/starlinkpayment
sudo npm install --omit=dev --min-release-age=0
sudo cp .env.example .env
sudo nano .env
```

Set at least:

```env
PORT=8080
HOST=0.0.0.0
PUBLIC_URL=http://10.0.0.1:8080
ADMIN_PASSWORD=something-strong
FIREWALL_ENABLED=true
LAN_INTERFACE=wlan0
WAN_INTERFACE=eth0
PORTAL_IP=10.0.0.1
```

Stripe keys are optional (guest portal uses Venmo only).

### 2. Wi‑Fi AP + DHCP + DNS hijack

```bash
sudo SSID=CampStarlink LAN_INTERFACE=wlan0 WAN_INTERFACE=eth0 \
  bash scripts/setup-ap.sh
```

Optional WPA: `PASSPHRASE='camp-shared'` — that password only gets people to the portal; internet still requires payment per device.

### 3. Firewall only (if AP already configured)

```bash
sudo LAN_INTERFACE=wlan0 WAN_INTERFACE=eth0 PORTAL_IP=10.0.0.1 \
  bash scripts/setup-firewall.sh
```

### 4. Run on boot

```bash
sudo cp scripts/starlinkpayment.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now starlinkpayment
sudo journalctl -u starlinkpayment -f
```

### 5. Admin before guests arrive

1. Open `http://10.0.0.1:8080/admin`
2. Set price, session hours, and your **Venmo handle**
3. Comp your own phone’s MAC so you stay online

## Guest flows

| Method | What happens |
|--------|----------------|
| Venmo | Open Venmo (cellular) → pay with device code in note → “I’ve paid” → **Admin → Pending → Approve** |
| Comp | Admin comps a MAC (friends / your gear) |
| Site whitelist | Payment apps + Burning Man always open; other URLs need **3 unique MACs** → hostname opened for camp (admin can revoke crowd entries) |

Access expires after `session_hours`; the app revokes stale MACs every minute.

## Travel router note

A **GL.iNet Beryl AX (GL-MT3000)** (or similar OpenWrt travel router) can replace the Pi as the AP/NAT box: Starlink → router WAN, camp on router Wi‑Fi. Run this Node app on the router (USB/extroot) or on a small always-on host on the LAN, and point OpenNDS / equivalent captive auth at it. The Pi scripts above are the supported path for v1.

## Project layout

```
src/
  index.ts           # server entry
  routes.ts          # guest + admin HTTP
  db.ts              # SQLite schema
  firewall.ts        # nftables allow/revoke + MAC lookup + destination allowlist
  permanent-whitelist.ts  # never-block payment + Burning Man domains
  site-whitelist.ts  # permanent + crowd URL approval → dnsmasq + nft sync
  stripe.ts          # Checkout create/confirm
  views.ts      # HTML UI
scripts/
  setup-ap.sh
  setup-firewall.sh
  starlinkpayment.service
```

## Security notes

- MAC binding is good enough for camp; determined spoofing is possible.
- Keep admin on LAN; use a strong `ADMIN_PASSWORD`.
- Never commit `.env` or live Stripe keys.
