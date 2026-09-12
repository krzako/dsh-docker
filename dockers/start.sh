#!/usr/bin/env sh

./build.sh
docker compose up -d
docker compose logs -f
