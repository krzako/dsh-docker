#!/usr/bin/env sh

CDPATH= cd -- "$(dirname -- "$0")" || exit 1

sh tools/prepare_volumes_dir.sh

#./build.sh
docker compose up -d searxng
docker compose up -d deepseek-harness
docker compose logs -f
