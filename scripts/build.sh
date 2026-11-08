#!/bin/sh
set -eu
repo=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$repo"
mkdir -p .upstream dist
if [ ! -f .upstream/go.mod ]; then
 archive=$(mktemp)
 trap 'rm -f "$archive"' EXIT
 curl -fL https://codeload.github.com/SagerNet/sing-box/tar.gz/refs/tags/v1.14.4 -o "$archive"
 tar -xzf "$archive" --strip-components=1 -C .upstream
 rm -f "$archive"
 trap - EXIT
fi
python3 scripts/prepare-core.py
export GOTOOLCHAIN=local
CGO_ENABLED=0 go -C .upstream test -tags with_quic ./cmd/sing-box-min
CGO_ENABLED=0 go -C .upstream build -trimpath -buildvcs=false -tags with_quic \
 -ldflags '-s -w -buildid= -checklinkname=0' -o ../dist/check ./cmd/sing-box-min
dist/check check -c examples/config.json
dist/check check -c examples/config-fallback.json
CGO_ENABLED=0 GOOS=linux GOARCH=mipsle GOMIPS=softfloat \
 go -C .upstream build -trimpath -buildvcs=false -tags with_quic \
 -ldflags '-s -w -buildid= -checklinkname=0' -o ../dist/sing-box-min-linux-mipsle ./cmd/sing-box-min
python3 scripts/package.py --binary dist/sing-box-min-linux-mipsle
python3 scripts/package-ui-update.py
python3 tests/validate.py
