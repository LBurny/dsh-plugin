#!/usr/bin/env bash
# Dev helper: shoot the sandbox's remote proxy origin (the page a phone gets),
# keeping the proxy token out of the command line / transcript.
# usage: bash tools/visual/shot-proxy.sh [shot.mjs args...]
set -euo pipefail
cd "$(dirname "$0")/../.."
URL=$(node -e "
const r=require('./.sandbox/dsh-remote.json');
process.stdout.write('http://127.0.0.1:'+r.port+'/?token='+r.token);
")
exec node tools/visual/shot.mjs --url "$URL" "$@"
