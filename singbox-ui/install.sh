#!/bin/sh
set -e
cd "$(dirname "$0")"
[ "$(id -u)" = 0 ] || { echo 'Нужен root'; exit 1; }
for file in root/usr/libexec/singbox-ui root/usr/libexec/singbox-ui-firewall root/etc/init.d/singbox-ui; do sh -n "$file"; done
if [ -x /etc/init.d/singbox-ui ]; then /etc/init.d/singbox-ui stop; fi
if pidof sing-box >/dev/null; then
 echo 'Остановите ручной sing-box через Ctrl+C, затем повторите установку.'
 exit 1
fi
for family in '' '-6'; do
 if ip $family rule show | grep '^101:' | grep -vE 'fwmark 0x200(/0xffffffff)?.*lookup 101'; then
  echo 'Приоритет 101 занят чужим правилом; установка остановлена.'; exit 1
 fi
done

backup="/root/singbox-ui-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$backup"
find root -type f | sed 's|^root/||' > "$backup/manifest"
: > "$backup/existing"
while IFS= read -r file; do [ ! -f "/$file" ] || echo "$file" >> "$backup/existing"; done < "$backup/manifest"
for file in etc/config/dhcp etc/config/firewall usr/share/luci/menu.d/luci-app-hyroute.json; do
 [ ! -f "/$file" ] || echo "$file" >> "$backup/existing"
done
tar -czf "$backup/previous.tar.gz" -C / -T "$backup/existing"
for name in hy-vpn hyroute singbox-ui singbox-ui-log; do
 if [ -x "/etc/init.d/$name" ] && "/etc/init.d/$name" enabled; then touch "$backup/enabled-$name"; fi
done
for name in hy_route sb_sni_test sbui; do
 if nft list table inet "$name" > "$backup/$name.nft" 2>/dev/null; then touch "$backup/had-$name"; fi
done
for family in 4 6; do
 opt=''; [ "$family" = 4 ] || opt='-6'
 for n in 100 101; do
  mark=0x100; [ "$n" = 100 ] || mark=0x200
  if ip $opt rule show | grep -Eq "^$n:.*fwmark $mark(/0xffffffff)?.*lookup $n"; then touch "$backup/rule-$family-$n"; fi
 done
done

cat > "$backup/rollback.sh" <<'EOF'
#!/bin/sh
cd "$(dirname "$0")" || exit 1
/etc/init.d/singbox-ui stop 2>/dev/null
/etc/init.d/singbox-ui-log stop 2>/dev/null
/etc/init.d/singbox-ui-log disable 2>/dev/null
/etc/init.d/singbox-ui disable 2>/dev/null
while IFS= read -r file; do rm -f "/$file"; done < manifest
tar -xzf previous.tar.gz -C /
for name in hy_route sb_sni_test sbui; do
 nft delete table inet "$name" 2>/dev/null
 [ ! -f "had-$name" ] || nft -f "$name.nft"
done
for family in 4 6; do
 opt=''; [ "$family" = 4 ] || opt='-6'
 for n in 100 101; do
  mark=0x100; [ "$n" = 100 ] || mark=0x200
  if [ -f "rule-$family-$n" ]; then
   ip $opt route replace local default dev lo table "$n"
   ip $opt rule show | grep -Eq "^$n:.*fwmark $mark(/0xffffffff)?.*lookup $n" || ip $opt rule add pref "$n" fwmark "$mark/0xffffffff" lookup "$n"
  fi
 done
done
for name in hy-vpn hyroute singbox-ui singbox-ui-log; do
 [ ! -f "enabled-$name" ] || "/etc/init.d/$name" enable
done
rm -f /tmp/luci-indexcache
/etc/init.d/dnsmasq restart
/etc/init.d/rpcd restart
echo 'Настройки восстановлены. Запустите нужную прежнюю службу вручную.'
EOF
chmod 700 "$backup/rollback.sh"
echo "Резервная копия: $backup"
trap 'rc=$?; if [ "$rc" != 0 ]; then echo "Ошибка установки; выполняется откат"; sh "$backup/rollback.sh"; fi' EXIT

# Preserve existing UI config on reinstallation.
[ ! -f /etc/config/singboxui ] || cp -p /etc/config/singboxui "$backup/settings"
[ ! -f /etc/singbox-ui/config.json ] || cp -p /etc/singbox-ui/config.json "$backup/config.json"
cp -R root/* /
if [ -f "$backup/settings" ]; then cp -p "$backup/settings" /etc/config/singboxui; fi
if [ -f "$backup/config.json" ]; then
 cp -p "$backup/config.json" /etc/singbox-ui/config.json
elif [ -f /tmp/router-sni-tproxy.json ]; then
 cp /tmp/router-sni-tproxy.json /etc/singbox-ui/config.json
elif [ -f /tmp/router-test.json ]; then
 cp /tmp/router-test.json /etc/singbox-ui/config.json
fi
chmod 700 /etc/singbox-ui
chmod 600 /etc/config/singboxui /etc/singbox-ui/config.json
chmod 755 /usr/libexec/singbox-ui /usr/libexec/singbox-ui-firewall /etc/init.d/singbox-ui /etc/init.d/singbox-ui-log

if [ -x /tmp/sing-box ] && ! /tmp/sing-box check -c /etc/singbox-ui/config.json; then
 exit 1
fi

# Stop old automations so they cannot restore obsolete tables or download Hysteria.
for name in hy-vpn hyroute; do
 if [ -x "/etc/init.d/$name" ]; then "/etc/init.d/$name" stop 2>/dev/null || true; "/etc/init.d/$name" disable; fi
done
if uci -q get firewall.hyroute >/dev/null; then
 uci set firewall.hyroute.enabled=0
fi
uci set firewall.singboxui=include
uci set firewall.singboxui.type='script'
uci set firewall.singboxui.path='/usr/libexec/singbox-ui-firewall'
uci set firewall.singboxui.fw4_compatible=1
uci commit firewall
uci -q delete dhcp.hy_vpn4 || true
uci -q delete dhcp.hy_vpn6 || true
uci -q del_list 'dhcp.@dnsmasq[0].nftset=/api.ipify.org/4#inet#hy_route#vpn4' || true
uci -q del_list 'dhcp.@dnsmasq[0].nftset=/api.ipify.org/6#inet#hy_route#vpn6' || true
if [ -f /etc/hysteria/hyroute-blocked ]; then
 while IFS= read -r item; do uci -q del_list "dhcp.@dnsmasq[0].address=/$item/" || true; done < /etc/hysteria/hyroute-blocked
fi
uci commit dhcp
for name in hy_route sb_sni_test; do nft delete table inet "$name" 2>/dev/null || true; done
for family in 4 6; do
 opt=''; [ "$family" = 4 ] || opt='-6'
 for n in 100 101; do
  mark=0x100; [ "$n" = 100 ] || mark=0x200
  if [ -f "$backup/rule-$family-$n" ]; then
   ip $opt rule del pref "$n" fwmark "$mark/0xffffffff" lookup "$n"
   ip $opt route del local default dev lo table "$n" 2>/dev/null || true
  fi
 done
done
rm -f /usr/share/luci/menu.d/luci-app-hyroute.json /tmp/luci-indexcache
/etc/init.d/dnsmasq restart
/etc/init.d/rpcd restart
if [ "$(uci -q get singboxui.main.autostart)" = 1 ]; then /etc/init.d/singbox-ui enable; fi
/etc/init.d/singbox-ui-log enable
/etc/init.d/singbox-ui-log restart
/etc/init.d/singbox-ui start
trap - EXIT
echo 'Готово: Сеть → Sing-box. Настройте источники бинарника перед перезагрузкой.'
echo "Откат: sh $backup/rollback.sh"
