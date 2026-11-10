#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

./test_instance_stop.sh
./test_instance_start.sh "$@"
