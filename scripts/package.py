"""Package LuCI with the SHA-256 of the exact core supplied to this command."""
import argparse
import hashlib
import io
from pathlib import Path
import re
import shutil
import tarfile

parser=argparse.ArgumentParser()
parser.add_argument('--binary',type=Path,required=True)
args=parser.parse_args()
repo=Path(__file__).resolve().parents[1]
binary=args.binary.resolve()
data=binary.read_bytes()
if data[:6]!=bytes.fromhex('7f454c460101') or int.from_bytes(data[18:20],'little')!=8:
    raise SystemExit('Expected ELF32 little-endian MIPS binary')
checksum=hashlib.sha256(data).hexdigest()
out=repo/'dist'
out.mkdir(exist_ok=True)
target=out/'sing-box-min-linux-mipsle'
if target.resolve()!=binary:
    shutil.copyfile(binary,target)
app=repo/'singbox-ui'
files=[app/'install.sh',app/'README.md',*[p for p in sorted((app/'root').rglob('*')) if p.is_file()]]
archive=out/'singbox-ui.tar.gz'
with tarfile.open(archive,'w:gz') as tar:
    for path in files:
        content=path.read_bytes().replace(b'\r\n',b'\n')
        if path==app/'root/etc/config/singboxui':
            content=re.sub(rb"option sha256 '[a-fA-F0-9]{64}'",f"option sha256 '{checksum}'".encode(),content)
        info=tarfile.TarInfo('singbox-ui/'+path.relative_to(app).as_posix())
        info.size=len(content)
        info.mode=0o644
        if path.name=='install.sh' or 'libexec' in path.parts or 'init.d' in path.parts:
            info.mode=0o755
        if path.name in ('config.json','singboxui'):
            info.mode=0o600
        tar.addfile(info,io.BytesIO(content))
(out/'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in (target,archive)),encoding='ascii')
print(f'Core: {len(data)} bytes ({len(data)/1048576:.2f} MiB)')
print(f'SHA-256: {checksum}')
print(f'LuCI: {archive}')
