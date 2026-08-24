#!/usr/bin/env bash
# Configure a Raspberry Pi as Wi-Fi AP + NAT gateway in front of Starlink.
# eth0 = Starlink, wlan0 = camp SSID (adjust via env).
set -euo pipefail

LAN_INTERFACE="${LAN_INTERFACE:-wlan0}"
WAN_INTERFACE="${WAN_INTERFACE:-eth0}"
PORTAL_IP="${PORTAL_IP:-10.0.0.1}"
SSID="${SSID:-CampStarlink}"
PASSPHRASE="${PASSPHRASE:-}"   # empty = open network (captive portal gates access)
CHANNEL="${CHANNEL:-6}"
COUNTRY="${COUNTRY:-US}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y hostapd dnsmasq iptables nftables dnsutils

systemctl stop hostapd dnsmasq || true
systemctl unmask hostapd || true

# Static LAN address
cat >/etc/network/interfaces.d/starlink-paywall <<EOF
allow-hotplug ${LAN_INTERFACE}
iface ${LAN_INTERFACE} inet static
  address ${PORTAL_IP}
  netmask 255.255.255.0
EOF

ip link set "${LAN_INTERFACE}" down || true
ip addr flush dev "${LAN_INTERFACE}" || true
ip addr add "${PORTAL_IP}/24" dev "${LAN_INTERFACE}"
ip link set "${LAN_INTERFACE}" up

# DHCP + DNS hijack to portal for captive detection
cat >/etc/dnsmasq.d/starlink-paywall.conf <<EOF
interface=${LAN_INTERFACE}
bind-interfaces
dhcp-range=10.0.0.50,10.0.0.200,255.255.255.0,12h
dhcp-option=3,${PORTAL_IP}
dhcp-option=6,${PORTAL_IP}
address=/#/${PORTAL_IP}
EOF

# hostapd
wpa_block=""
if [[ -n "${PASSPHRASE}" ]]; then
  wpa_block=$(cat <<WPA
wpa=2
wpa_passphrase=${PASSPHRASE}
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
WPA
)
fi

cat >/etc/hostapd/hostapd.conf <<EOF
interface=${LAN_INTERFACE}
driver=nl80211
ssid=${SSID}
hw_mode=g
channel=${CHANNEL}
country_code=${COUNTRY}
ieee80211n=1
wmm_enabled=1
auth_algs=1
ignore_broadcast_ssid=0
${wpa_block}
EOF

cat >/etc/default/hostapd <<EOF
DAEMON_CONF="/etc/hostapd/hostapd.conf"
EOF

# Persist IP forwarding
grep -q 'net.ipv4.ip_forward=1' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >>/etc/sysctl.conf
sysctl -w net.ipv4.ip_forward=1 >/dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAN_INTERFACE="${LAN_INTERFACE}" WAN_INTERFACE="${WAN_INTERFACE}" PORTAL_IP="${PORTAL_IP}" \
  bash "${SCRIPT_DIR}/setup-firewall.sh"

systemctl enable hostapd dnsmasq
systemctl restart dnsmasq
systemctl restart hostapd

echo
echo "AP ready: SSID=${SSID} portal=${PORTAL_IP}"
echo "Next: install Node app, copy systemd unit, set .env, enable starlinkpayment.service"
