#!/bin/sh
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

/app/node_modules/.bin/copilot --headless --host 127.0.0.1 --port 4321 \
    --log-level "${COPILOT_PROXY_COPILOT_SDK_LOG_LEVEL:-warning}" 2>&1 |
    tee /app/logs/copilot-proxy/headless.log &
CLI_PID=$!

i=0
while [ "$i" -lt 60 ]; do
    if node -e "const n=require('net');const s=n.connect(4321,'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1))"; then
        break
    fi
    i=$((i+1))
    sleep 1
done

if node dist/whoami.js; then
    echo "Already authenticated."
else
    echo "Not authenticated - complete the login below (a browser is required)."
    copilot login --host "$COPILOT_PROXY_GHE_HOST" --device-code || echo "Login not completed - run it again later with: docker exec -it copilot-proxy copilot login --host $COPILOT_PROXY_GHE_HOST --device-code"
fi

nohup node dist/index.js 2>&1 | tee /app/logs/copilot-proxy/proxy.log &
wait "$CLI_PID"
