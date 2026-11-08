#!/bin/sh
# Run on the computer, not on OpenWrt. Reuses the installed UI and JSON.
set -eu
repo=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
router=${1:-root@192.168.100.1}
binary=${2:-$repo/dist/sing-box-min-linux-mipsle}
[ -s "$binary" ] || { echo "Missing binary: $binary" >&2; exit 1; }
checksum=$(sha256sum "$binary")
checksum=${checksum%% *}
ssh "$router" '/etc/init.d/singbox-ui stop && rm -f /tmp/sing-box'
scp -O "$binary" "$router:/tmp/sing-box"
ssh "$router" "chmod 700 /tmp/sing-box &&
 printf '%s\\n' '$checksum  /tmp/sing-box' | sha256sum -c - &&
 /tmp/sing-box version &&
 /tmp/sing-box check -c /etc/singbox-ui/config.json &&
 uci set singboxui.main.sha256='$checksum' &&
 uci commit singboxui &&
 /etc/init.d/singbox-ui start"
printf '%s\n' 'Core updated. Make sure saved Bin source URLs serve this new binary before reboot.'
