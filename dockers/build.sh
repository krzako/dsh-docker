#!/usr/bin/env sh
#
# Export the commit hash of the DSH source so `docker compose --build`
# passes it to the image build (the Dockerfile consumes it as the
# DSH_COMMIT_HASH build ARG).
DSH_COMMIT_HASH="$(git -C "${DSH_SOURCE:-../deepseek-harness}" rev-parse HEAD 2>/dev/null || true)"
export DSH_COMMIT_HASH
echo "DSH commit hash: ${DSH_COMMIT_HASH:-<unset>}"
CODEX_COMMIT_HASH="$(git -C "${CODEX_SOURCE:-addons/codex}" rev-parse HEAD 2>/dev/null || true)"
export CODEX_COMMIT_HASH
echo "Codex fork commit hash: ${CODEX_COMMIT_HASH:-<unset>}"

docker compose build
