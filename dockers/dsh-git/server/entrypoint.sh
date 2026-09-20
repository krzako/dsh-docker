#!/bin/sh
set -eu

umask 0002

# The bridge intentionally exposes only repositories containing
# git-daemon-export-ok. add-to-dsh.sh creates that marker only after all
# protection settings are installed.
#
# safe.directory=* is process-local configuration inherited by receive-pack.
# It avoids Docker Desktop / bind-mount ownership mismatches without writing a
# mutable global gitconfig into the image.
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0='safe.directory'
export GIT_CONFIG_VALUE_0='*'

exec git daemon \
    --reuseaddr \
    --verbose \
    --base-path=/repos \
    --enable=receive-pack \
    --listen=0.0.0.0 \
    --port=9418 \
    /repos
