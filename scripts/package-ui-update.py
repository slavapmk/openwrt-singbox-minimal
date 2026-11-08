"""Package only UI/runtime files; never include user settings, JSON or core."""
import io
from pathlib import Path
import tarfile

repo = Path(__file__).resolve().parents[1]
root = repo / 'singbox-ui/root'
out = repo / 'dist'
out.mkdir(exist_ok=True)
update = b'''#!/bin/sh
set -eu
cd "$(dirname "$0")"
[ -f /etc/config/singboxui ] && [ -f /etc/singbox-ui/config.json ] || {
 echo 'Existing singbox-ui installation required; use install.sh for a clean install.' >&2
 exit 1
}
find root/usr/libexec root/etc/init.d -type f | while IFS= read -r file; do sh -n "$file"; done
cp -R root/* /
chmod 755 /usr/libexec/singbox-ui* /etc/init.d/singbox-ui
rm -f /tmp/luci-indexcache
rm -rf /tmp/luci-modulecache
/etc/init.d/singbox-ui restart
/etc/init.d/rpcd restart
echo 'UI updated; core restarting. Reload the LuCI page.'
'''
archive = out / 'singbox-ui-update.tar.gz'
with tarfile.open(archive, 'w:gz') as tar:
    entries = [('update.sh', update, 0o755)]
    for path in sorted(root.rglob('*')):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if rel.parts[:2] in [('etc', 'config'), ('etc', 'singbox-ui')]:
            continue
        executable = 'libexec' in rel.parts or 'init.d' in rel.parts
        entries.append(('root/' + rel.as_posix(), path.read_bytes(), 0o755 if executable else 0o644))
    for name, content, mode in entries:
        info = tarfile.TarInfo('singbox-ui-update/' + name)
        info.size, info.mode = len(content), mode
        tar.addfile(info, io.BytesIO(content))
print(archive)
