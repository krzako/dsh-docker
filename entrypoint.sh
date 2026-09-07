#!/bin/sh
set -eu

# Hard-force telemetry settings at runtime.
# These intentionally override values supplied with `docker run -e`.
export DSH_TELEMETRY_DISABLED=1
export DSH_TELEMETRY_MODE=DISABLED

echo "========================================"
echo " DeepSeek Harness startup"
echo "========================================"
printf 'DSH_TELEMETRY_DISABLED=%s\n' "$DSH_TELEMETRY_DISABLED"
printf 'DSH_TELEMETRY_MODE=%s\n' "$DSH_TELEMETRY_MODE"
echo "========================================"

echo ""

echo "========================================"
echo " Settings seed"
echo "========================================"

# Merge settings.seed.yaml into the user's settings document before DSH reads
# it. Provider presence, defaultInput, missing models, and compat are enforced
# on every start; the remaining seed sections apply only while the
# .settings-seed-complete flag is absent (first seed).
SETTINGS_SEED_SCRIPT="${SETTINGS_SEED_SCRIPT:-/opt/dsh-seed/seed-settings.mjs}"
if [ -f "$SETTINGS_SEED_SCRIPT" ]; then
    node "$SETTINGS_SEED_SCRIPT" || exit 1
else
    echo "No settings seed script at $SETTINGS_SEED_SCRIPT; skipping"
fi

echo "========================================"

# dsh currently binds Web UI to loopback and rejects --host 0.0.0.0.
# Keep dsh itself on 127.0.0.1:3081 and expose 0.0.0.0:3080 only
# inside the container through a tiny raw TCP relay.
#
# IMPORTANT: publish it on the Docker host as:
#   -p 127.0.0.1:3080:3080
# so it stays reachable only from the local machine.

node <<'NODE' &
const net = require('node:net');

const PUBLIC_HOST = '0.0.0.0';
const PUBLIC_PORT = 3080;
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 3081;

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST);

  client.pipe(upstream);
  upstream.pipe(client);

  const close = () => {
    client.destroy();
    upstream.destroy();
  };

  client.on('error', close);
  upstream.on('error', close);
});

server.on('error', (error) => {
  console.error('[dsh-proxy] fatal:', error);
  process.exit(1);
});

server.listen(PUBLIC_PORT, PUBLIC_HOST, () => {
  console.log(
    `[dsh-proxy] ${PUBLIC_HOST}:${PUBLIC_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`,
  );
});
NODE

/usr/local/bin/install-dsh-addons

exec node "$DSH_SOURCE_DIR/apps/cli/lib/bin.js" web \
  --port 3081 \
  --trusted-host localhost:3080 \
  --trusted-host 127.0.0.1:3080
