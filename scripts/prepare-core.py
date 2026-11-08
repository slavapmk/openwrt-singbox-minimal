"""Install this build's entry point, fallback extension and tests into upstream."""
import argparse
from pathlib import Path
import shutil
parser=argparse.ArgumentParser()
parser.add_argument('--source',type=Path,default=Path('.upstream'))
args=parser.parse_args()
repo=Path(__file__).resolve().parents[1]
if not (args.source/'go.mod').is_file():
    raise SystemExit('Extract sing-box v1.14.4 into --source first')
target=args.source/'cmd/sing-box-min'
target.mkdir(parents=True,exist_ok=True)
shutil.copyfile(repo/'core/minimal-main.go',target/'main.go')
for name in ('fallback.go','fallback_test.go'):
    shutil.copyfile(repo/'core'/name,target/name)
