#!/usr/bin/env bash
# Bootstrap / refresh the Starlink paywall nftables captive portal.
# Run as root on the gateway (Raspberry Pi / Linux travel-router host).
set -euo pipefail

LAN_INTERFACE="${LAN_INTERFACE:-wlan0}"
WAN_INTERFACE="${WAN_INTERFACE:-eth0}"
PORTAL_IP="${PORTAL_IP:-10.0.0.1}"
PORTAL_PORT="${PORTAL_PORT:-8080}"
TABLE="starlink_paywall"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

command -v nft >/dev/null || { echo "nftables (nft) is required" >&2; exit 1; }

# Enable forwarding
sysctl -w net.ipv4.ip_forward=1 >/dev/null

# Masquerade LAN -> WAN (idempotent-ish: flush our nat postrouting chain if present)
nft list table inet "${TABLE}" &>/dev/null && nft delete table inet "${TABLE}" || true

nft -f - <<EOF
table inet ${TABLE} {
  set allowed_macs {
    type ether_addr
    flags interval
  }

  set allowed_dests {
    type ipv4_addr
    flags interval
  }

  set blocked_dests {
    type ipv4_addr
    flags interval
  }

  set blocked_dests6 {
    type ipv6_addr
    flags interval
  }

  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    iifname "${LAN_INTERFACE}" ether saddr @allowed_macs accept
    iifname "${LAN_INTERFACE}" ip daddr @allowed_dests tcp dport { 80, 443 } accept
    iifname "${LAN_INTERFACE}" tcp dport { 80, 443 } dnat ip to ${PORTAL_IP}:${PORTAL_PORT}
    iifname "${LAN_INTERFACE}" udp dport 53 accept
    iifname "${LAN_INTERFACE}" tcp dport 53 accept
    iifname "${LAN_INTERFACE}" ip daddr ${PORTAL_IP} tcp dport ${PORTAL_PORT} accept
  }

  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    oifname "${WAN_INTERFACE}" masquerade
  }

  chain forward {
    type filter hook forward priority filter; policy drop;
    ip daddr @blocked_dests drop
    ip6 daddr @blocked_dests6 drop
    ct state established,related accept
    iifname "${LAN_INTERFACE}" oifname "${WAN_INTERFACE}" ether saddr @allowed_macs accept
    iifname "${LAN_INTERFACE}" oifname "${WAN_INTERFACE}" ip daddr @allowed_dests accept
    iifname "${WAN_INTERFACE}" oifname "${LAN_INTERFACE}" ct state established,related accept
    iifname "${LAN_INTERFACE}" ip daddr ${PORTAL_IP} accept
  }

  chain input {
    type filter hook input priority filter; policy accept;
    iifname "${LAN_INTERFACE}" tcp dport ${PORTAL_PORT} accept
    iifname "${LAN_INTERFACE}" udp dport 53 accept
    iifname "${LAN_INTERFACE}" tcp dport 53 accept
  }
}
EOF

echo "nftables table '${TABLE}' installed."
echo "  LAN=${LAN_INTERFACE} WAN=${WAN_INTERFACE} portal=${PORTAL_IP}:${PORTAL_PORT}"
echo "Allow MACs with: nft add element inet ${TABLE} allowed_macs '{ aa:bb:cc:dd:ee:ff }'"
echo "Crowd-approved site IPs go in: allowed_dests"
echo "Always-blocked destinations (TikTok, Reddit, news) go in: blocked_dests / blocked_dests6"
