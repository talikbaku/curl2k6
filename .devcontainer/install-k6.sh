#!/usr/bin/env bash
# Installs a pinned, checksum-verified k6 for the dev container / Codespace.
set -euo pipefail
if command -v k6 >/dev/null; then echo "k6 already installed: $(k6 version)"; exit 0; fi
K6_VERSION=${K6_VERSION:-v1.5.0}
case "$(uname -m)" in
  x86_64)        PKG=linux-amd64 ;;
  aarch64|arm64) PKG=linux-arm64 ;;
  *) echo "no k6 build for $(uname -m)" >&2; exit 1 ;;
esac
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; cd "$TMP"
BASE="https://github.com/grafana/k6/releases/download/${K6_VERSION}"
FILE="k6-${K6_VERSION}-${PKG}.tar.gz"
curl -sSfL -o "$FILE" "$BASE/$FILE"
curl -sSfL -o checksums.txt "$BASE/k6-${K6_VERSION}-checksums.txt"
EXPECTED=$(awk -v f="$FILE" '$2 == f {print $1}' checksums.txt)
ACTUAL=$(sha256sum "$FILE" | awk '{print $1}')
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo "k6 checksum mismatch for $FILE" >&2; exit 1; }
tar -xzf "$FILE"
DEST=${K6_DEST:-/usr/local/bin}
if [ -w "$DEST" ]; then install -m 0755 "k6-${K6_VERSION}-${PKG}/k6" "$DEST/k6"; else sudo install -m 0755 "k6-${K6_VERSION}-${PKG}/k6" "$DEST/k6"; fi
"$DEST/k6" version
