# Coding Agent Environment

This container is a development and coding-agent environment built on Debian 12 (Bookworm) with Node.js 24.

The OpenAI proxy in `/openAiProxy` is started automatically in the background before the DeepSeek Harness (DSH). PostgreSQL, RabbitMQ, Redis, Traefik, and MinIO are installed and available for development, debugging, integration tests, and temporary local services, but must be started explicitly when needed.

## OpenAI proxy

A Node.js proxy application is installed in:

```text
/openAiProxy
```

Its dependencies are installed during the Docker image build with:

```bash
npm install
```

The proxy is started automatically before DSH with:

```bash
nohup node /openAiProxy/server.js
```

Runtime files:

```text
/openAiProxy/openAiProxy.log
/openAiProxy/openAiProxy.pid
```

Environment variables that can override those locations:

```text
OPENAI_PROXY_LOG
OPENAI_PROXY_PID_FILE
```

Useful commands:

```bash
cat /openAiProxy/openAiProxy.pid
tail -f /openAiProxy/openAiProxy.log
ps -fp "$(cat /openAiProxy/openAiProxy.pid)"
```

## Compression

Zstandard CLI tools are installed:

```bash
zstd
unzstd
zstdcat
```

Typical usage:

```bash
zstd file
unzstd file.zst
zstdcat file.zst
```

`zstd` is useful for compressed archives, caches, logs, and DSH/session artifacts that use Zstandard compression.

## Docker

Docker is **not available** in this environment.

Do not try to run:

```bash
docker
docker compose
docker-compose
```

Even if the repository contains files such as:

```text
Dockerfile
docker-compose.yml
docker-compose.yaml
compose.yml
compose.yaml
```

do **not** assume Docker can be used.

Instead, solve the task using the tools and services available directly inside this environment. For example:

- run Node.js applications directly with `node`, `npm`, or `pnpm`;
- run Python applications directly with `python`, `uv`, or `uvx`;
- start PostgreSQL, RabbitMQ, Redis, Traefik, or MinIO directly using their installed binaries when needed;
- inspect Dockerfiles and Compose files only as configuration/reference material and reproduce the required behavior with local commands;
- use shell scripts, environment variables, local processes, and the available networking/debugging tools instead of Docker.

Do not stop or report the task as blocked merely because a Dockerfile or Compose-based workflow is present. Find an equivalent non-Docker approach whenever possible.

## Application ports

Ports `3310` through `3330` are exposed and reserved for applications started by the coding agent. When a task requires starting an application, HTTP server, development UI, API, or other service that needs an externally reachable application port, choose a free port from this range.

The authoritative registry for port assignments is:

```text
/home/node/.used_ports
```

Treat this file as the **single source of truth** for application-port ownership. Each non-empty line must use the format:

```text
<port>: <application-name>
```

For example:

```text
3310: my app frontend
3311: my app backend
3311: my second app frontend
```

Port-allocation rules:

- Before assigning or using a port in the `3310-3330` range, always consult `/home/node/.used_ports`.
- A port listed in `/home/node/.used_ports` is considered reserved even if no process is currently listening on it. Do not reuse or overwrite it for another application merely because `ss`, `lsof`, or another runtime check shows it as idle.
- If an application already has an entry in `/home/node/.used_ports`, reuse its assigned port unless the task explicitly requires changing it.
- When assigning a new application, choose a port from `3310-3330` that is not present in the registry. As a defensive check, also verify that the chosen port is not already listening at the OS level with `ss` or `lsof`.
- Register the selected port in `/home/node/.used_ports` **before** starting the application.
- Whenever starting an application, proactively verify that its port is present in `/home/node/.used_ports`. If the mapping is missing, add it before starting the application.
- Never silently replace an existing `port: application-name` mapping with a different application. If a requested port is already assigned to another application, choose another free port or report the conflict when the exact port is mandatory.

All reads that can lead to a port decision and all modifications of the registry must be performed under an **exclusive inter-process lock** so that concurrent agents/processes cannot allocate or overwrite the same port. Use a dedicated lock file:

```text
/home/node/.used_ports.lock
```

Prefer `flock` and keep the exclusive lock held for the entire read-check-select-write transaction. Do not perform an unlocked read followed later by a separately locked write, because another process could allocate the same port in between. A safe shell pattern is:

```bash
mkdir -p /home/node
touch /home/node/.used_ports /home/node/.used_ports.lock

(
  flock -x 9

  # While this lock is held:
  # 1. read /home/node/.used_ports
  # 2. verify/reuse the application's existing assignment, or find a free port
  # 3. optionally confirm the candidate is not already listening with ss/lsof
  # 4. write the new mapping to /home/node/.used_ports before starting the app

) 9>/home/node/.used_ports.lock
```

When updating the registry, preserve all unrelated existing entries. Do not truncate, recreate, or rewrite the file from stale data outside the lock. Release the lock only after the registry contains the final assignment.

## Runtime and package managers

### Node.js

Available commands:

```bash
node --version
npm --version
pnpm --version
corepack --version
```

Installed environment:

- Node.js 24 (from `node:24-bookworm`)
- pnpm 11.7.0, activated through Corepack

### Python

Python is managed by `uv`, not by Debian packages.

Available commands:

```bash
python --version
python3 --version
python3.12 --version
uv --version
uvx --version
```

Installed environment:

- CPython 3.12.x managed by `uv`
- `python`, `python3`, and `python3.12` resolve to the uv-managed Python
- uv-managed Python installations live under `/opt/uv/python`

Prefer `uv` for Python environments and dependencies, for example:

```bash
uv venv
uv pip install <package>
uv run <command>
uvx <tool>
```

## Native build toolchain

A complete Debian build toolchain is installed via `build-essential`.

Available commands include:

```bash
gcc --version
g++ --version
make --version
pkg-config --version
```

Use it for native Node.js modules, Python packages with native extensions, C/C++ projects, and other source builds.

## PostgreSQL

PostgreSQL 16.4 is installed using the Debian 12 / Bookworm PGDG build corresponding to the PostgreSQL version used by `postgis/postgis:16-3.4`.

Installed package version:

```text
16.4-1.pgdg120+2
```

Available commands include:

```bash
postgres --version
psql --version
pg_dump --version
pg_restore --version
initdb --version
pg_ctl --version
createdb --version
dropdb --version
```

PostgreSQL binaries are available from:

```text
/usr/lib/postgresql/16/bin
```

`libpq` and its development headers are also installed (`libpq5`, `libpq-dev`).

PostgreSQL is not started automatically. Create/use a writable data directory when starting a temporary server as the `node` user.

## RabbitMQ

RabbitMQ 4.0.7 is installed with Erlang/OTP 27.x.

The following plugins are enabled offline in the installation:

- `rabbitmq_management`
- `rabbitmq_prometheus`

Available commands include:

```bash
rabbitmq-server
rabbitmqctl
rabbitmq-diagnostics
rabbitmq-plugins
rabbitmqadmin
erl
```

RabbitMQ home:

```text
/opt/rabbitmq
```

RabbitMQ is not started automatically.

## Redis

Redis 8.10.1 is built natively for Debian Bookworm with TLS support.

Available commands include:

```bash
redis-server --version
redis-cli --version
redis-benchmark
redis-sentinel
redis-check-aof
redis-check-rdb
```

Redis is not started automatically.

For a temporary local instance, a simple development invocation is:

```bash
redis-server --bind 127.0.0.1 --port 6379
```

## Traefik

Traefik v2.4 is available as a standalone binary copied from the official `traefik:v2.4` image.

```bash
traefik version
traefik --help
```

Traefik is not started automatically.

## MinIO

MinIO binaries are copied from:

```text
minio/minio:RELEASE.2025-02-03T21-03-04Z
```

Available commands:

```bash
minio --version
mc --version
```

- `minio` - MinIO object-storage server
- `mc` - MinIO client

MinIO is not started automatically.

When starting MinIO, use writable directories owned by the `node` user, for example somewhere under `/home/node` or another mounted writable volume.

## Git and source-control tools

Available commands include:

```bash
git
git-lfs
ssh
scp
ssh-keygen
```

Useful supporting tools include `rsync`, `diff`, and standard GNU utilities included with Debian.

## Search, files, and text processing

Available tools include:

```bash
rg          # ripgrep - fast repository text search
fd          # friendly file finder (Debian fdfind exposed as fd)
jq          # JSON processing
tree        # directory trees
file        # file type inspection
less        # pager
nano        # terminal editor
shellcheck  # shell-script analysis
```

Examples:

```bash
rg "TODO|FIXME" .
rg -l "someSymbol" src/
fd package.json
jq '.scripts' package.json
tree -L 2
```

## Networking and diagnostics

Available tools include:

```bash
curl
wget
ip
ss
dig
nslookup
nc
lsof
ps
top
pgrep
pkill
```

Useful examples:

```bash
curl -v http://localhost:3000/health
nc -vz host 5432
ss -lntp
dig example.com
lsof -i :3000
ps aux
```

## Archives and local databases

Available commands include:

```bash
zip
unzip
xz
sqlite3
```


## Important operational note

Do not assume PostgreSQL, RabbitMQ, Redis, Traefik, or MinIO are already running just because their binaries are installed. Check first, for example with `ss`, `ps`, or the service-specific CLI, and start only the service required for the current task.
