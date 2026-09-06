// OpenAI-compatible API proxy z logowaniem parametrow requestow.
// Prompt w logach obcinany do 15 znakow (zalezy nam glownie na parametrach).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  try {
    const txt = fs.readFileSync(file, 'utf-8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch (e) {}
}
loadEnv(path.join(__dirname, '.env'));

const PORT = parseInt(process.env.PORT || '3099', 10);
// BACKEND_URL zawiera /v1; z requesta klienta usuwamy przedni /v1
const BACKEND = process.env.BACKEND_URL || 'http://host.docker.internal:1234/v1';
const ENV_KEY = process.env.OPENAI_API_KEY || '';
const PROMPT_LIMIT = 15;

// Klucze ktore zostaja w pelni (identyfikatory, nie prompt)
const KEEP_FULL = { model: true, id: true };

function truncDeep(value, key) {
  if (typeof value === 'string') {
    if (KEEP_FULL[key]) return value;
    return value.length <= PROMPT_LIMIT ? value : value.slice(0, PROMPT_LIMIT) + '...';
  }
  if (Array.isArray(value)) {
    return value.map(function (v) { return truncDeep(v, key); });
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = truncDeep(value[k], k);
    }
    return out;
  }
  return value;
}

function sanitize(body) {
  if (!body || typeof body !== 'object') return body;
  const copy = JSON.parse(JSON.stringify(body));
  return truncDeep(copy, null);
}

function maskAuth(h) {
  const o = Object.assign({}, h);
  for (const k of Object.keys(o)) {
    if (/^(authorization|x-api-key)$/i.test(k) && typeof o[k] === 'string' && o[k].length > 8) {
      o[k] = '********' + o[k].slice(-4);
    }
  }
  return o;
}

function logRequest(method, url, headers, bodyRaw) {
  let parsed = null;
  try { parsed = JSON.parse(bodyRaw); } catch (e) {}
  const sep = '='.repeat(80);
  console.log('');
  console.log(sep);
  console.log(new Date().toISOString() + ' ' + method + ' ' + url);
  console.log('-'.repeat(80));
  console.log('HEADERS:');
  const safeHeaders = maskAuth(headers);
  for (const k of Object.keys(safeHeaders)) {
    if (typeof safeHeaders[k] === 'string' && safeHeaders[k].length > PROMPT_LIMIT) {
      safeHeaders[k] = safeHeaders[k].slice(0, PROMPT_LIMIT) + '...';
    }
  }
  console.log(JSON.stringify(safeHeaders, null, 2));
  if (parsed !== null) {
    console.log('BODY (prompt skrocony do ' + PROMPT_LIMIT + ' znakow):');
    console.log(JSON.stringify(sanitize(parsed), null, 2));
  } else if (bodyRaw.length > 0) {
    console.log('RAW BODY:');
    console.log(bodyRaw.slice(0, 500));
  }
  console.log(sep);
}

const server = http.createServer(function (req, res) {
  const chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    const bodyRaw = Buffer.concat(chunks).toString('utf-8');

    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', backend: BACKEND, uptime: process.uptime() }));
      return;
    }

    logRequest(req.method, req.url, req.headers, bodyRaw);

    let key = ENV_KEY;
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) key = auth.slice(7);

    // BACKEND juz zawiera /v1 - usuwamy przedni /v1 z requesta klienta
    let p = req.url;
    if (p.startsWith('/v1')) p = p.slice(3);
    const target = new URL(BACKEND + p);
    const transport = target.protocol === 'https:' ? https : http;

    const headers = Object.assign({}, req.headers);
    delete headers['transfer-encoding'];
    delete headers['content-length'];
    headers.host = target.host;
    if (key) headers.authorization = 'Bearer ' + key;
    else delete headers.authorization;
    headers['content-length'] = Buffer.byteLength(bodyRaw);

    const t0 = Date.now();
    const proxyReq = transport.request(target, { method: req.method, headers }, function (proxyRes) {
      console.log('  -> ' + proxyRes.statusCode + ' w ' + (Date.now() - t0) + ' ms');
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', function (err) {
      console.log('  -> PROXY ERROR: ' + err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Proxy error: ' + err.message, type: 'proxy_error' } }));
      } else {
        res.destroy();
      }
    });

    proxyReq.write(bodyRaw);
    proxyReq.end();
  });
});

server.listen(PORT, function () {
  console.log('');
  console.log('OpenAI-compatible proxy: http://localhost:' + PORT);
  console.log('Backend: ' + BACKEND);
  console.log('API key z env: ' + (ENV_KEY ? 'tak' : 'nie (uzyj naglowka Bearer)'));
  console.log('Logi: wszystkie parametry, prompt obciety do ' + PROMPT_LIMIT + ' znakow');
  console.log('');
});
