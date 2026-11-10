#!/usr/bin/env sh

CDPATH= cd -- "$(dirname -- "$0")" || exit 1

no_logs=0

for arg in "$@"; do
  case "$arg" in
    --no-logs) no_logs=1;;
    *)
  esac
done

sh tools/prepare_volumes_dir.sh

#./build.sh
docker compose up -d searxng
docker compose up -d deepseek-harness

if [[ "$no_logs" == 0 ]]; then
	docker compose logs -f
fi
