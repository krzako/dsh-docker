#!/usr/bin/env sh

sh tools/prepare_volumes_dir.sh

./build.sh
docker compose up -d
docker compose logs -f
