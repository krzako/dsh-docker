# syntax=docker/dockerfile:1

# =============================================================================
# External service images used only as artifact sources
# =============================================================================

FROM traefik:v2.4 AS traefik_source
FROM minio/minio:RELEASE.2025-02-03T21-03-04Z AS minio_source


# =============================================================================
# Redis
#
# `redis:alpine` is currently Redis 8.10.1, but Alpine binaries are built
# against musl and should not be copied directly into Debian Bookworm.
# Build the same Redis release natively for Bookworm instead.
# =============================================================================

FROM node:24-bookworm AS redis_builder

ARG REDIS_VERSION=8.10.1
ARG REDIS_DOWNLOAD_SHA=e5cae2686231290bf55ae5cc4da01e646c3424233cae7618ebf3a64250ef1583

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        build-essential \
        libssl-dev \
        pkg-config \
        wget \
    && rm -rf /var/lib/apt/lists/* \
    && wget -O /tmp/redis.tar.gz \
        "https://github.com/redis/redis/releases/download/${REDIS_VERSION}/redis-full.tar.gz" \
    && echo "${REDIS_DOWNLOAD_SHA}  /tmp/redis.tar.gz" | sha256sum -c - \
    && mkdir -p /usr/src/redis /out \
    && tar -xzf /tmp/redis.tar.gz -C /usr/src/redis --strip-components=1 \
    && rm /tmp/redis.tar.gz \
    && make -C /usr/src/redis/src -j"$(nproc)" BUILD_TLS=yes \
        redis-server redis-cli redis-benchmark \
    && install -m 0755 /usr/src/redis/src/redis-server /out/redis-server \
    && install -m 0755 /usr/src/redis/src/redis-cli /out/redis-cli \
    && install -m 0755 /usr/src/redis/src/redis-benchmark /out/redis-benchmark \
    && ln -s redis-server /out/redis-sentinel \
    && ln -s redis-server /out/redis-check-aof \
    && ln -s redis-server /out/redis-check-rdb


# =============================================================================
# DeepSeek Harness builder
# =============================================================================

FROM node:24-bookworm AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        python3 \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/deepseek-harness

# Copy the DSH source tree supplied by docker-compose as dsh_source.
COPY --from=dsh_source / /opt/deepseek-harness/

# Install dependencies without running lifecycle scripts yet.
RUN CI=true npx -y pnpm@11.7.0 install \
    --frozen-lockfile

# Determine the real Git commit used for the build.
#
# Preferred:
#   dsh_source itself contains usable Git metadata.
#
# Fallback:
#   dsh_source is a Git submodule whose .git file points outside its Docker
#   build context. In that case use dsh_docker_git_source, which points to the
#   real host-side Git directory for the submodule.
#
# DSH_CLIENT_COMMIT_HASH prevents the DSH build script from having to run
# `git rev-parse HEAD` against the copied source tree.
RUN --mount=type=bind,from=dsh_source,target=/tmp/dsh-source,ro \
    --mount=type=bind,from=dsh_docker_git_source,target=/tmp/dsh-docker-git-source,ro \
    set -eu; \
    \
    if DSH_COMMIT="$(git -C /tmp/dsh-source rev-parse --verify HEAD 2>/dev/null)"; then \
        echo "Using Git metadata from dsh_source"; \
    elif DSH_COMMIT="$(git \
        --git-dir=/tmp/dsh-docker-git-source \
        --work-tree=/tmp/dsh-source \
        rev-parse --verify HEAD 2>/dev/null)"; then \
        echo "Using fallback Git metadata from dsh_docker_git_source"; \
    else \
        echo "ERROR: Cannot determine DSH Git commit." >&2; \
        echo "Neither dsh_source nor dsh_docker_git_source contains usable Git metadata." >&2; \
        exit 1; \
    fi; \
    \
    echo "Building DSH commit: ${DSH_COMMIT}"; \
    DSH_CLIENT_COMMIT_HASH="${DSH_COMMIT}" \
        npx -y pnpm@11.7.0 build


# =============================================================================
# Runtime / coding-agent environment
# =============================================================================

FROM node:24-bookworm AS runtime


# -----------------------------------------------------------------------------
# Base system / development / debugging tools
# -----------------------------------------------------------------------------

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        git-lfs \
        openssh-client \
        nano \
        curl \
        wget \
        jq \
        less \
        procps \
        iproute2 \
        dnsutils \
        netcat-openbsd \
        lsof \
        ripgrep \
        fd-find \
        file \
        tree \
        unzip \
        zip \
        zstd \
        rsync \
        shellcheck \
        sqlite3 \
        build-essential \
        pkg-config \
        gnupg \
        xz-utils \
        libssl3 \
		htop \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd


# -----------------------------------------------------------------------------
# PostgreSQL 16.4
#
# postgis/postgis:16-3.4 uses PostgreSQL 16.4-1.pgdg110+2 on Debian 11.
# This image is Debian 12, so use the equivalent PGDG Bookworm build:
# 16.4-1.pgdg120+2.
# -----------------------------------------------------------------------------

ARG POSTGRES_VERSION=16.4-1.pgdg120+2

RUN install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL \
        https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && printf '%s\n' \
        'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt-archive.postgresql.org/pub/repos/apt bookworm-pgdg-archive main' \
        > /etc/apt/sources.list.d/pgdg-archive.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        "postgresql-16=${POSTGRES_VERSION}" \
        "postgresql-client-16=${POSTGRES_VERSION}" \
        "libpq5=${POSTGRES_VERSION}" \
        "libpq-dev=${POSTGRES_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/lib/postgresql/16/bin:${PATH}"


# -----------------------------------------------------------------------------
# RabbitMQ 4.0.7 + management
#
# RabbitMQ 4.0.7 supports Erlang/OTP 26.2 through 27.x. Pin the Bookworm
# Team RabbitMQ repository to Erlang 27.x and install the exact RabbitMQ
# generic Unix distribution used by the official image family.
# -----------------------------------------------------------------------------

ARG RABBITMQ_VERSION=4.0.7
ENV RABBITMQ_HOME=/opt/rabbitmq
ENV PATH="${RABBITMQ_HOME}/sbin:${PATH}"

RUN curl -1sLf \
        'https://keys.openpgp.org/vks/v1/by-fingerprint/0A9AF2115F4687BD29803A206B73A36E6026DFCA' \
        | gpg --dearmor -o /usr/share/keyrings/com.rabbitmq.team.gpg \
    && printf '%s\n' \
        'deb [arch=amd64 signed-by=/usr/share/keyrings/com.rabbitmq.team.gpg] https://deb1.rabbitmq.com/rabbitmq-erlang/debian/bookworm bookworm main' \
        'deb [arch=amd64 signed-by=/usr/share/keyrings/com.rabbitmq.team.gpg] https://deb2.rabbitmq.com/rabbitmq-erlang/debian/bookworm bookworm main' \
        > /etc/apt/sources.list.d/rabbitmq-erlang.list \
    && printf '%s\n' \
        'Package: erlang-base erlang-asn1 erlang-crypto erlang-eldap erlang-ftp erlang-inets erlang-mnesia erlang-os-mon erlang-parsetools erlang-public-key erlang-runtime-tools erlang-snmp erlang-ssl erlang-syntax-tools erlang-tftp erlang-tools erlang-xmerl' \
        'Pin: version 1:27.*' \
        'Pin-Priority: 1001' \
        > /etc/apt/preferences.d/rabbitmq-erlang-27 \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        erlang-base \
        erlang-asn1 \
        erlang-crypto \
        erlang-eldap \
        erlang-ftp \
        erlang-inets \
        erlang-mnesia \
        erlang-os-mon \
        erlang-parsetools \
        erlang-public-key \
        erlang-runtime-tools \
        erlang-snmp \
        erlang-ssl \
        erlang-syntax-tools \
        erlang-tftp \
        erlang-tools \
        erlang-xmerl \
    && rm -rf /var/lib/apt/lists/* \
    && RABBITMQ_SOURCE_URL="https://github.com/rabbitmq/rabbitmq-server/releases/download/v${RABBITMQ_VERSION}/rabbitmq-server-generic-unix-latest-toolchain-${RABBITMQ_VERSION}.tar.xz" \
    && wget -O /tmp/rabbitmq.tar.xz "${RABBITMQ_SOURCE_URL}" \
    && mkdir -p "${RABBITMQ_HOME}" /etc/rabbitmq/conf.d \
    && tar -xJf /tmp/rabbitmq.tar.xz -C "${RABBITMQ_HOME}" --strip-components=1 \
    && rm /tmp/rabbitmq.tar.xz \
    && sed -i 's/^SYS_PREFIX=.*$/SYS_PREFIX=/' "${RABBITMQ_HOME}/sbin/rabbitmq-defaults" \
    && rabbitmq-plugins enable --offline rabbitmq_management rabbitmq_prometheus \
    && RABBITMQADMIN="$(find "${RABBITMQ_HOME}/plugins" -path '*/priv/www/cli/rabbitmqadmin' -print -quit)" \
    && test -n "${RABBITMQADMIN}" \
    && install -m 0755 "${RABBITMQADMIN}" /usr/local/bin/rabbitmqadmin


# -----------------------------------------------------------------------------
# Redis 8.10.1
# Native Bookworm build corresponding to the current redis:alpine release.
# -----------------------------------------------------------------------------

COPY --from=redis_builder /out/ /usr/local/bin/


# -----------------------------------------------------------------------------
# Traefik v2.4
# Copy only its portable executable; do not inherit its base filesystem or
# entrypoint.
# -----------------------------------------------------------------------------

COPY --from=traefik_source /usr/local/bin/traefik /usr/local/bin/traefik


# -----------------------------------------------------------------------------
# MinIO + MinIO Client
# Exact binaries from minio/minio:RELEASE.2025-02-03T21-03-04Z.
# -----------------------------------------------------------------------------

COPY --from=minio_source /usr/bin/minio /usr/local/bin/minio
COPY --from=minio_source /usr/bin/mc /usr/local/bin/mc


# -----------------------------------------------------------------------------
# uv + Python 3.12
# -----------------------------------------------------------------------------

COPY --from=ghcr.io/astral-sh/uv:0.12.9 \
    /uv /uvx /usr/local/bin/

ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_BIN_DIR=/usr/local/bin

RUN uv python install 3.12 --default


# -----------------------------------------------------------------------------
# Node / pnpm
# -----------------------------------------------------------------------------

RUN corepack enable \
    && corepack prepare pnpm@11.7.0 --activate


# -----------------------------------------------------------------------------
# OpenAI proxy
#
# The `llama-proxy` directory must be present in the main Docker build context.
# Dependencies are installed at image-build time.
# -----------------------------------------------------------------------------

COPY --chown=node:node llama-proxy/ /llama-proxy/

RUN cd /llama-proxy \
    && npm install \
    && chown -R node:node /llama-proxy


# -----------------------------------------------------------------------------
# DSH runtime
# -----------------------------------------------------------------------------

ENV DSH_TELEMETRY_DISABLED=1 \
    DSH_TELEMETRY_MODE=DISABLED \
    DSH_SOURCE_DIR=/opt/deepseek-harness

COPY --from=builder --chown=node:node \
    /opt/deepseek-harness \
    /opt/deepseek-harness

RUN mkdir -p /home/node/.dsh \
    && chown -R node:node /home/node/.dsh

# Agent-readable documentation of the bundled development environment.
COPY --chown=node:node environment.md /home/node/environment.md
ENV AGENT_ENVIRONMENT_FILE=/home/node/environment.md

COPY --chown=node:node entrypoint.sh /usr/local/bin/dsh-entrypoint
RUN chmod 0555 /usr/local/bin/dsh-entrypoint

# Settings seed: merged into $DSH_HOME/settings.yaml at every container start.
COPY --chown=node:node settings.seed.yaml /opt/dsh-seed/settings.seed.yaml
COPY --chown=node:node addons/seed-settings/seed-settings.mjs /opt/dsh-seed/seed-settings.mjs

# Build-time self-test of the settings seed merge logic. The test resolves its
# seed document at ../../settings.seed.yaml, so mirror that layout in a
# temporary directory and drop it after the run. The harness checkout copied
# above provides the yaml package the merge script loads.
COPY --chown=node:node addons/seed-settings /opt/dsh-seed-selftest/addons/seed-settings
COPY --chown=node:node settings.seed.yaml /opt/dsh-seed-selftest/settings.seed.yaml
RUN cd /opt/dsh-seed-selftest/addons/seed-settings \
    && node --test seed-settings.test.mjs \
    && rm -rf /opt/dsh-seed-selftest

# Start llama-proxy in the background before handing control to the original
# DSH entrypoint. Logs and the background PID are kept in the DSH home.
RUN cat > /usr/local/bin/dsh-entrypoint-with-proxy <<'EOF'
#!/bin/sh
set -eu

PROXY_LOG="${OPENAI_PROXY_LOG:-/llama-proxy/llama-proxy.log}"
PROXY_PID_FILE="${OPENAI_PROXY_PID_FILE:-/llama-proxy/llama-proxy.pid}"

mkdir -p "$(dirname "${PROXY_LOG}")" "$(dirname "${PROXY_PID_FILE}")"

nohup node /llama-proxy/server.js >>"${PROXY_LOG}" 2>&1 &
echo "$!" > "${PROXY_PID_FILE}"

exec /usr/local/bin/dsh-entrypoint "$@"
EOF

RUN chmod 0555 /usr/local/bin/dsh-entrypoint-with-proxy

# Build-time sanity checks for the bundled toolchain/services.
RUN node --version \
    && pnpm --version \
    && python --version \
    && uv --version \
    && postgres --version \
    && psql --version \
    && erl -noshell -eval 'io:format("Erlang/OTP ~s~n", [erlang:system_info(otp_release)]), halt().' \
    && rabbitmqctl version \
    && redis-server --version \
    && redis-cli --version \
    && traefik version \
    && minio --version \
    && mc --version \
    && test -f /llama-proxy/server.js \
    && node --check /opt/dsh-seed/seed-settings.mjs \
    && test -f /opt/dsh-seed/settings.seed.yaml \
    && test -x /usr/local/bin/dsh-entrypoint-with-proxy

USER node
WORKDIR /home/node

# llama-proxy is started automatically in the background immediately before DSH.
# PostgreSQL, RabbitMQ, Redis, Traefik and MinIO remain opt-in services/tools.
EXPOSE 3080

ENTRYPOINT ["/usr/local/bin/dsh-entrypoint-with-proxy"]
