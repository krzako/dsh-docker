#!/usr/bin/env sh

CDPATH= cd -- "$(dirname -- "$0")" || exit 1

sh tools/prepare_volumes_dir.sh

./build.sh
docker compose up -d
docker compose logs -f
