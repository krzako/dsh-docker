#!/bin/sh
if [ -z "${COPILOT_PROXY_API_KEY:-}" ]; then
    echo "[copilot-proxy] COPILOT_PROXY_API_KEY is not set; keeping the container idle without starting the proxy or the copilot headless runtime." >&2
    while :; do
        sleep 86400
    done
fi
umask 0002
mkdir -p /home/node/.copilot /home/node/.cache

# Token store: keep the CLI's non-interactive plaintext-config switch enabled
# so `copilot login` can save the token without a TTY or a system keychain.
# The runtime migrates the key from config.json to settings.json on startup,
# so once it is in settings.json there is nothing to do.
node -e '
const fs = require("fs");
let settings = {};
try { settings = JSON.parse(fs.readFileSync("/home/node/.copilot/settings.json", "utf8")); } catch {}
if (settings.storeTokenPlaintext === true) process.exit(0);
const p = "/home/node/.copilot/config.json";
let obj = {};
try { obj = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, "")); } catch {}
if (obj.storeTokenPlaintext !== true) {
  obj.storeTokenPlaintext = true;
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
}
'

HEADLESS_LOG=/app/logs/copilot-proxy/headless.log
HEADLESS_PIPE="/tmp/copilot-headless-log.$$"
COPILOT_RUNTIME_BIN=$(node -e 'process.stdout.write(require.resolve(`@github/copilot-linuxmusl-${process.arch}`))')
CLI_PID=
LOGGER_PID=
: > "$HEADLESS_LOG"

stop_runtime() {
    if [ -n "$CLI_PID" ]; then
        # This path only stops the authentication probe, before the proxy can
        # create sessions, so terminate it without an unbounded wait.
        kill -KILL "$CLI_PID" 2>/dev/null || true
        wait "$CLI_PID" 2>/dev/null || true
        CLI_PID=
    fi
    if [ -n "$LOGGER_PID" ]; then
        wait "$LOGGER_PID" 2>/dev/null || true
        LOGGER_PID=
    fi
    rm -f "$HEADLESS_PIPE"
}

wait_for_runtime() {
    i=0
    while [ "$i" -lt 60 ]; do
        if ! kill -0 "$CLI_PID" 2>/dev/null; then
            return 1
        fi
        if node -e "const n=require('net');const s=n.connect(4321,'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1))"; then
            return 0
        fi
        i=$((i+1))
        sleep 1
    done
    return 1
}

start_runtime() {
    rm -f "$HEADLESS_PIPE"
    mkfifo "$HEADLESS_PIPE"
    tee -a "$HEADLESS_LOG" < "$HEADLESS_PIPE" &
    LOGGER_PID=$!
    "$COPILOT_RUNTIME_BIN" --headless --host 127.0.0.1 --port 4321 \
        --log-level "${COPILOT_PROXY_COPILOT_SDK_LOG_LEVEL:-warning}" \
        > "$HEADLESS_PIPE" 2>&1 &
    CLI_PID=$!
    if wait_for_runtime; then
        return 0
    fi
    echo "[copilot-proxy] Copilot headless runtime failed to become ready." >&2
    stop_runtime
    return 1
}

start_runtime || exit 1

if node dist/whoami.js; then
    echo "Already authenticated."
else
    # The headless runtime reads credentials only at startup. Stop the
    # unauthenticated probe before login, then create a fresh runtime after the
    # CLI persists the device-flow token.
    stop_runtime
    echo "Not authenticated - complete the login below (a browser is required)."
    if ! copilot login --host "$COPILOT_PROXY_GHE_HOST" --device-code; then
        echo "Login not completed; restarting the unauthenticated runtime. Run login again and then restart the container." >&2
    fi
    start_runtime || exit 1
    if node dist/whoami.js; then
        echo "Authentication loaded by the Copilot runtime."
    else
        echo "[copilot-proxy] Copilot runtime is still unauthenticated after login." >&2
        exit 1
    fi
fi

nohup node dist/index.js 2>&1 | tee /app/logs/copilot-proxy/proxy.log &
wait "$CLI_PID"
