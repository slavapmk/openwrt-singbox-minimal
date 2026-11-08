"""Exercise the shipped shell functions with isolated command doubles (no router)."""
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'singbox-ui/root/usr/libexec/singbox-ui').read_text()
FUNCTIONS = SOURCE[SOURCE.index('fail()'):SOURCE.index('case "$1" in')]
DISPATCH = SOURCE[SOURCE.index('case "$1" in'):]

class Routing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        (self.path / 'config.json').write_text('{"inbounds": [{"type":"tproxy","listen_port":2500}]}\n')
        (self.path / 'settings').write_text("config main 'main'\n option transparent '1'\n option interface 'br-lan'\n option port '2500'\n option autostart '1'\n option gogc '100'\n")
        mock = self.path / 'jsonfilter'
        mock.write_text('''#!/usr/bin/env python3
import json, sys
c=json.load(open(sys.argv[sys.argv.index('-i')+1]))
assert sys.argv[-1] == '@.inbounds[@.type="tproxy"].listen_port'
for i in c['inbounds']:
 if i.get('type') == 'tproxy': print(i.get('listen_port', ''))
''')
        mock.chmod(0o755)
        self.prefix = f'''BASE='{self.path}'
TMP='{self.path}'
BIN='{self.path}/core'
transparent=1; interface=br-lan; port=2500; autostart=1
{FUNCTIONS}
logger() {{ :; }}
uci() {{ cat "$TMP/settings"; }}
ip() {{ echo "$*" >> "$TMP/ip.calls"; }}
nft() {{
 case "$1" in
 list) [ -f "$TMP/active.nft" ];;
 -c) [ ! -f "$TMP/reject" ];;
 -f) cp "$2" "$TMP/active.nft";;
 delete) rm -f "$TMP/active.nft";;
 esac
}}
'''
    def run_shell(self, code, ok=True):
        r = subprocess.run((['busybox', 'ash'] if shutil.which('busybox') else ['sh']) + ['-c', self.prefix + code], text=True,
                           capture_output=True, env={**os.environ, 'PATH': str(self.path)+':'+os.environ['PATH']})
        if ok:
            self.assertEqual(r.returncode, 0, r.stderr)
        else:
            self.assertNotEqual(r.returncode, 0)
        return r

    def test_recreate_preserves_bypass_and_local_destination(self):
        self.run_shell('routes_on; routes_on')
        rules = (self.path / 'active.nft').read_text()
        self.assertTrue(rules.startswith('delete table inet sbui\n'))
        self.assertEqual(rules.count('bypass-dnat-replies'), 1)
        self.assertLess(rules.index('ct status dnat'), rules.index('tproxy ip to'))
        self.assertLess(rules.index('fib daddr type local return'), rules.index('tproxy ip to'))
        self.assertEqual(list(self.path.glob('routes.*')), [])

    def test_invalid_nft_keeps_active_rules(self):
        (self.path / 'active.nft').write_text('original')
        (self.path / 'reject').touch()
        self.run_shell('routes_on', ok=False)
        self.assertEqual((self.path / 'active.nft').read_text(), 'original')
        self.assertFalse((self.path / 'ip.calls').exists())
        self.assertEqual(list(self.path.glob('routes.*')), [])

    def test_port_on_other_inbound_does_not_validate(self):
        (self.path / 'config.json').write_text(json.dumps({'inbounds':[
            {'type':'tproxy','listen_port':2501}, {'type':'mixed','listen_port':2500}]}))
        self.run_shell('routes_on', ok=False)
        self.assertFalse((self.path / 'active.nft').exists())

    def test_disable_removes_rules(self):
        self.run_shell('routes_on; transparent=0; routes_on')
        self.assertFalse((self.path / 'active.nft').exists())
        self.assertIn('rule del', (self.path / 'ip.calls').read_text())

    def test_routing_changes_do_not_require_core_restart(self):
        first = self.run_shell('core_signature').stdout
        p = self.path / 'settings'
        p.write_text(p.read_text().replace("'br-lan'", "'br-guest'").replace("'2500'", "'2600'")
                     .replace("transparent '1'", "transparent '0'").replace("autostart '1'", "autostart '0'"))
        self.assertEqual(first, self.run_shell('core_signature').stdout)
        p.write_text(p.read_text().replace("gogc '100'", "gogc '50'"))
        self.assertNotEqual(first, self.run_shell('core_signature').stdout)

    def test_json_change_requires_core_restart(self):
        first = self.run_shell('core_signature').stdout
        with (self.path / 'config.json').open('a') as f: f.write(' ')
        self.assertNotEqual(first, self.run_shell('core_signature').stdout)

    def apply(self, changed=False):
        (self.path / 'core').touch()
        (self.path / 'core').chmod(0o700)
        active = self.path / 'config.json'
        (self.path / 'config.pending.json').write_text(active.read_text())
        dispatch = DISPATCH.replace('/etc/init.d/singbox-ui', 'service_mock')
        self.run_shell('''
get_settings() { :; }
assets() { :; }
core_running() { return 0; }
service_mock() { echo "$1" >> "$TMP/service.calls"; }
core_signature > "$TMP/core.signature"
''' + ("echo '#change' >> \"$TMP/settings\"\n" if changed else '') +
                       'set -- apply\n' + dispatch)

    def test_apply_unchanged_json_does_not_restart_or_replace_previous(self):
        (self.path / 'config.previous.json').write_text('previous')
        self.apply()
        self.assertEqual((self.path / 'service.calls').read_text(), 'enable\n')
        self.assertEqual((self.path / 'config.previous.json').read_text(), 'previous')
        self.assertFalse((self.path / 'config.pending.json').exists())
        self.assertIn('bypass-dnat-replies', (self.path / 'active.nft').read_text())

    def test_apply_core_change_restarts(self):
        self.apply(changed=True)
        self.assertIn('restart', (self.path / 'service.calls').read_text())

    def test_check_does_not_promote_pending(self):
        self.run_shell('''
check_config() { echo "$1"; }
set -- check
''' + DISPATCH)
        self.assertFalse((self.path / 'config.pending.json').exists())

if __name__ == '__main__':
    unittest.main()
