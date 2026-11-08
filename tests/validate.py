"""Static checks for example consistency and packaged file permissions/hash."""
import hashlib
import json
from pathlib import Path
import tarfile

repo=Path(__file__).resolve().parents[1]
config=json.loads((repo/'examples/config.json').read_text())
assert config==json.loads((repo/'singbox-ui/root/etc/singbox-ui/config.json').read_text())
tags={o['tag'] for o in config['outbounds']}
for rule in config['route']['rules']:
    if 'outbound' in rule:
        assert rule['outbound'] in tags
assert config['route']['rules'][0]['action']=='sniff'
assert next(r for r in config['route']['rules'] if r.get('action')=='reject')
assert all(o['password']=='CHANGE_ME' for o in config['outbounds'] if o['type']=='hysteria2')
for file in (repo/'singbox-ui/root/usr/share').rglob('*.json'):
    json.loads(file.read_text())
if (repo/'dist/singbox-ui.tar.gz').exists():
    digest=hashlib.sha256((repo/'dist/sing-box-min-linux-mipsle').read_bytes()).hexdigest()
    with tarfile.open(repo/'dist/singbox-ui.tar.gz') as tar:
        settings=tar.extractfile('singbox-ui/root/etc/config/singboxui').read().decode()
        assert digest in settings
        assert tar.getmember('singbox-ui/root/etc/singbox-ui/config.json').mode==0o600
        assert tar.getmember('singbox-ui/root/usr/libexec/singbox-ui').mode==0o755
print('PASS: example rules, public credentials, JSON, package hash and permissions')

update=repo/'dist/singbox-ui-update.tar.gz'
if update.exists():
    with tarfile.open(update) as tar:
        names=tar.getnames()
        assert 'singbox-ui-update/update.sh' in names
        assert not any('/root/etc/config/' in n or '/root/etc/singbox-ui/' in n for n in names)
        assert not any(n.endswith('/sing-box') for n in names)
        import subprocess
        subprocess.run(['sh', '-n'], input=tar.extractfile('singbox-ui-update/update.sh').read(), check=True)
    print('PASS: UI update excludes user settings and core; updater shell syntax')
