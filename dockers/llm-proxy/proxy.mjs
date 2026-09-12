#!/usr/bin/env node
// OpenAI-compatible passthrough proxy that records failed upstream responses
// (or all requests with --log-all).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELP = `Standalone LLM proxy

Usage:
  node proxy.mjs [options]

The proxy forwards requests unchanged and stores requests whose upstream
response status is not 200. With --log-all every request is stored.

Options:
  --port <number>       Local port (default: 8787)
  --upstream <url>      Upstream origin without a path
   --log <path>          Failure log (default: .\\requests\\requests.log)
   --bodies <path>       Failed request directory (default: .\\requests)
  --log-all             Record every request, not only failures
  --raw                 Keep recorded request bodies in their original format
  --fix-plan            Remove matching plan-to-build reminder messages
                        before forwarding; removed data is logged always and
                        saved on failure
  --help                Show this help

Environment:
  LLM_PROXY_PORT, LLM_PROXY_UPSTREAM, LLM_PROXY_LOG, LLM_PROXY_KEY
  LLM_PROXY_KEY is masked in headers, request bodies, and removed content.

Examples:
  node proxy.mjs
  node proxy.mjs --fix-plan
  node proxy.mjs --port 8788 --upstream https://llm.domain.com
`;

const hasFlag = (name) => process.argv.includes(`--${name}`);
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : dflt;
};

if (hasFlag('help')) {
  console.log(HELP);
  process.exit(0);
}

const HOST = arg('host', process.env.LLM_PROXY_HOST || '127.0.0.1');
const PORT = Number(arg('port', process.env.LLM_PROXY_PORT || 9090));
const UPSTREAM = (arg('upstream', process.env.LLM_PROXY_UPSTREAM)).replace(/\/+$/, '');
const LOG = path.resolve(arg('log', path.join(PROJECT_DIR, 'requests', 'requests.log')));
const BODIES = path.resolve(arg('bodies', path.join(PROJECT_DIR, 'requests')));
const MASK_KEY = process.env.LLM_PROXY_KEY || '';
const RAW = hasFlag('raw');
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};
const FIX_PLAN = hasFlag('fix-plan');
const LOG_ALL = hasFlag('log-all');
const PLAN_TO_BUILD_PREFIX = '<system-reminder>\nYour operational mode has changed from plan to build';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`Invalid port: ${PORT}`);
}
new URL(UPSTREAM);
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.mkdirSync(BODIES, { recursive: true });

let bodySeq = 0;
const logStream = fs.createWriteStream(LOG, { flags: 'a' });
const log = (line) => logStream.write(line + '\n');
const maskBody = (body) => MASK_KEY && body.includes(MASK_KEY) ? body.replaceAll(MASK_KEY, 'PLACEHOLDER') : body;

const maskHeaders = (headers) => {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    let masked = Array.isArray(value) ? value.join(', ') : String(value);
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'authorization') {
      masked = masked.replace(/Bearer\s+\S+/i, '******');
      if (!masked.includes('PLACEHOLDER')) masked = '******';
    } else if (/(api[_-]?key|token|secret|password)/i.test(lowerKey)) {
      masked = 'PLACEHOLDER';
    }
    out[key] = masked;
  }
  return out;
};

const prepareRequest = (rawBody) => {
  if (!FIX_PLAN || !rawBody) return { requestBody: rawBody, removedMessages: [] };

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { requestBody: rawBody, removedMessages: [] };
  }

  if (!Array.isArray(payload?.messages)) return { requestBody: rawBody, removedMessages: [] };
  const removedMessages = payload.messages.filter((message) => (
    message?.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.length === 2 &&
    message.content[1]?.text?.startsWith(PLAN_TO_BUILD_PREFIX)
  ));
  if (!removedMessages.length) return { requestBody: rawBody, removedMessages };

  payload.messages = payload.messages.filter((message) => !removedMessages.includes(message));
  return { requestBody: JSON.stringify(payload), removedMessages };
};

const shQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

const toCurl = (method, url, headers, bodyPath) => {
  const lines = [`curl ${shQuote(url)}`];
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'host' || lowerKey === 'content-length' || lowerKey === 'connection') continue;
    lines.push(`  -H ${shQuote(`${key}: ${value}`)}`);
  }
  if (bodyPath) lines.push(`  --data-binary ${shQuote(`@${bodyPath}`)}`);
  return lines.join(' \\\n');
};

const logRemovedMessages = ({ req, removedMessages }) => {
  const removedDetails = `REMOVED ${removedMessages.length} plan-to-build message(s) from ${req.method} ${req.url}:\n${maskBody(JSON.stringify(removedMessages, null, 2))}`;
  console.error(removedDetails);
  log(`# [${new Date().toISOString()}] ${removedDetails}`);
};

const persistRequest = ({ req, target, upstreamStatus, requestBody, removedMessages, startedAt }) => {
  bodySeq++;
  const date = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const bodyPath = path.join(BODIES, `${String(bodySeq).padStart(4, '0')}_${date}.json`);
  let bodyToSave = maskBody(requestBody);
  if (!RAW) {
    try { bodyToSave = JSON.stringify(JSON.parse(bodyToSave), null, 2); } catch {}
  }
  fs.writeFileSync(bodyPath, bodyToSave);

  let removedPath;
  if (removedMessages.length) {
    removedPath = path.join(BODIES, `${date}_removed_content.json`);
    fs.writeFileSync(removedPath, maskBody(JSON.stringify(removedMessages, null, 2)));
  }

  const outcome = upstreamStatus === 200 ? 'OK' : 'FAILED';
  const details = `${outcome} ${req.method} ${req.url} -> ${upstreamStatus}; body=${bodyPath}${removedPath ? `; removed=${removedPath}` : ''}`;
  console.error(details);
  log(`# [${new Date().toISOString()}] ${details}`);
  log(toCurl(req.method, target, maskHeaders(req.headers), bodyPath));
  log('');
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const startedAt = Date.now();
    const { requestBody, removedMessages } = prepareRequest(rawBody);
    const target = UPSTREAM + req.url;
    if (removedMessages.length) logRemovedMessages({ req, removedMessages });
    const forwardedHeaders = { ...req.headers, host: new URL(target).host };
    delete forwardedHeaders.connection;
    forwardedHeaders['content-length'] = String(Buffer.byteLength(requestBody));
    const isHttps = target.startsWith('https:');
    const client = (isHttps ? https : http).request(
      target,
      { method: req.method, headers: forwardedHeaders, ...(isHttps ? { rejectUnauthorized: false } : {}) },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode || 502, { ...upstreamResponse.headers, ...CORS_HEADERS });
        upstreamResponse.pipe(res);
        upstreamResponse.on('end', () => {
          if (upstreamResponse.statusCode !== 200 || LOG_ALL) {
            persistRequest({
              req,
              target,
              upstreamStatus: upstreamResponse.statusCode || 502,
              requestBody,
              removedMessages,
              startedAt,
            });
          }
        });
      },
    );
    client.on('error', (error) => {
      const details = `FAILED ${req.method} ${req.url} -> CONNECT ERROR: ${error.message}`;
      console.error(details);
      log(`# [${new Date().toISOString()}] ${details}`);
      if (!res.headersSent) res.writeHead(502, { ...CORS_HEADERS, 'content-type': 'text/plain' });
      res.end('proxy error: ' + error.message);
    });
    if (requestBody) client.write(requestBody);
    client.end();
  });
});

server.listen(PORT, HOST, () => {
  log(`# proxy started ${new Date().toISOString()} upstream=${UPSTREAM} log=${LOG} fix-plan=${FIX_PLAN} log-all=${LOG_ALL}\n`);
  console.log(`proxy: http://localhost:${PORT} -> ${UPSTREAM}`);
  console.log(`log:           ${LOG}${LOG_ALL ? ' (all requests)' : ' (failures only)'}`);
  console.log(`bodies:        ${BODIES}`);
  console.log(`fix-plan:      ${FIX_PLAN ? 'enabled' : 'disabled (add --fix-plan to enable)'}`);
  console.log(`log-all:       ${LOG_ALL ? 'enabled' : 'disabled (add --log-all to enable)'}`);
});
