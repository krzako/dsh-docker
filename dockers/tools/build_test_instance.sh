#!/usr/bin/env bash
set -euo pipefail

# Repo root: the compose files the scripts drive live there.
cd "$(dirname "$0")/.."

COMPOSE_FILE="${DSH_TEST_COMPOSE_FILE:-docker-compose.test.yml}"

# Commit hash of the DSH source, consumed by the Dockerfile as the
# DSH_COMMIT_HASH build ARG (docker compose passes it to the build).
DSH_COMMIT_HASH="$(git -C "${DSH_SOURCE:-../deepseek-harness}" rev-parse HEAD 2>/dev/null || true)"
export DSH_COMMIT_HASH
echo "DSH commit hash: ${DSH_COMMIT_HASH:-<unset>}"
docker compose -f "$COMPOSE_FILE" build
