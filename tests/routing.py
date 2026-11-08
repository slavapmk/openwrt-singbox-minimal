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

    def startup(self, current='valid', pending=None):
        (self.path / 'config.json').write_text(current)
        (self.path / 'config.previous.json').write_text('previous')
        if pending is not None:
            (self.path / 'config.pending.json').write_text(pending)
        core = self.path / 'core'
        core.write_text('#!/bin/sh\necho started\n')
        core.chmod(0o700)
        return self.run_shell('''
get_settings() { delay=0; }
download_binary() { return 0; }
assets() { return 0; }
check_config() { ! grep -q INVALID "$1"; }
validate_tproxy() { return 0; }
routes_on() { return 0; }
set -- run
''' + DISPATCH, ok=False if 'INVALID' in (pending if pending is not None else current) else True)

    def test_invalid_active_json_never_rolls_back(self):
        self.startup(current='INVALID')
        self.assertEqual((self.path / 'config.json').read_text(), 'INVALID')
        self.assertEqual((self.path / 'config.previous.json').read_text(), 'previous')
        self.assertFalse((self.path / 'files.lock').exists())

    def test_invalid_pending_json_never_runs_old_config(self):
        r = self.startup(pending='INVALID')
        self.assertNotIn('started', r.stdout)
        self.assertEqual((self.path / 'config.pending.json').read_text(), 'INVALID')
        self.assertEqual((self.path / 'config.json').read_text(), 'valid')

    def test_valid_saved_json_is_applied_on_start(self):
        r = self.startup(pending='new')
        self.assertIn('started', r.stdout)
        self.assertEqual((self.path / 'config.json').read_text(), 'new')
        self.assertEqual((self.path / 'config.previous.json').read_text(), 'valid')
        self.assertFalse((self.path / 'files.lock').exists())

    def test_file_lock_rejects_second_writer(self):
        r = self.run_shell('acquire_files; acquire_files; rc=$?; release_files; exit "$rc"', ok=False)
        self.assertIn('уже выполняется', r.stderr)
        self.assertFalse((self.path / 'files.lock').exists())

    def test_delete_bin_only_removes_ram_copy(self):
        (self.path / 'core').write_text('ELF')
        self.run_shell('''
require_stopped() { return 0; }
config_load() { :; }
acquire_files
set -- files-job remove-bin ''
''' + DISPATCH)
        self.assertFalse((self.path / 'core').exists())
        self.assertTrue((self.path / 'config.json').exists())
        self.assertEqual((self.path / 'files.state').read_text().strip(), 'done')
        self.assertFalse((self.path / 'files.lock').exists())

    def test_running_service_blocks_manual_file_changes(self):
        (self.path / 'core').write_text('ELF')
        self.run_shell('''
require_stopped() { return 1; }
acquire_files
set -- files-job remove-bin ''
''' + DISPATCH, ok=False)
        self.assertEqual((self.path / 'core').read_text(), 'ELF')
        self.assertFalse((self.path / 'files.lock').exists())

    def test_private_logs_do_not_replay_syslog_after_clear(self):
        (self.path / 'app.log.old').write_text('older\n')
        (self.path / 'app.log').write_text('recent\n')
        self.assertEqual(self.run_shell('read_logs').stdout, 'older\nrecent\n')
        (self.path / 'app.log.old').unlink()
        (self.path / 'app.log').write_text('')
        self.assertEqual(self.run_shell('read_logs').stdout, '')
        (self.path / 'app.log').write_text('new event\n')
        self.assertEqual(self.run_shell('read_logs').stdout, 'new event\n')

    def test_failed_geo_refresh_reports_error_and_keeps_existing_file(self):
        (self.path / 'rules').mkdir()
        (self.path / 'rules/test.srs').write_text('existing')
        self.run_shell('''
config_get_bool() { eval "$1=1"; }
config_get() {
 case "$3" in filename) eval "$1=test.srs";; url) eval "$1=https://example.test/test.srs";; sha256) eval "$1=''";; esac
}
wget() { return 1; }
force_assets=1
asset geo
''', ok=False)
        self.assertEqual((self.path / 'rules/test.srs').read_text(), 'existing')
        self.assertFalse((self.path / 'rules/test.srs.part').exists())

    def test_bin_wrong_hash_is_rejected(self):
        (self.path / 'rules').mkdir()
        self.run_shell('''
hash=0000000000000000000000000000000000000000000000000000000000000000
config_list_foreach() { collect https://example.test/bin; }
wget() { echo bad > "$5"; }
download_binary
''', ok=False)
        self.assertFalse((self.path / 'core').exists())
        self.assertFalse((self.path / 'binary.part').exists())

    def test_cached_bin_is_verified_without_fetching(self):
        (self.path / 'core').write_text('cached')
        self.run_shell('''
hash=$(sha256sum "$BIN" | cut -d ' ' -f1)
wget() { echo unexpected >&2; return 1; }
download_binary
''')
        self.assertTrue(os.access(self.path / 'core', os.X_OK))

    def test_geo_url_change_refreshes_cached_file(self):
        (self.path / 'rules').mkdir()
        self.run_shell('''
config_get_bool() { eval "$1=1"; }
config_get() {
 case "$3" in filename) eval "$1=test.srs";; url) eval "$1=$source_url";; sha256) eval "$1=''";; esac
}
wget() { echo "$6" > "$5"; }
force_assets=0
source_url=https://example.test/old
asset geo
source_url=https://example.test/new
asset geo
''')
        self.assertEqual((self.path / 'rules/test.srs').read_text().strip(), 'https://example.test/new')

if __name__ == '__main__':
    unittest.main()
