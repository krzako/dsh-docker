#!/usr/bin/env sh

CDPATH= cd -- "$(dirname -- "$0")" || exit 1

./stop.sh
./start.sh
