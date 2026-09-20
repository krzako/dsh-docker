#!/usr/bin/env sh
#
# Shared startup helper for start.sh and tools/test_instance_start.sh:
# create every missing bind-mount host directory before `docker compose up`
# and prepare the group/setgid sharing model used by this repo:
#
#   * top-level directory: invoking user's primary group + 2775 (rwxrwsr-x)
#   * existing content: group set to the invoking user's primary group,
#     g+rwX, no write for others, setgid on every directory
#   * a ".volume-permissions-ok" marker skips the (slower) recursive pass on
#     later starts; the containers keep new files conformant themselves via
#     umask 0002 + setgid inheritance
#
# Entries the invoking user does not own (root-owned files from an earlier
# container run) cannot be fixed without root. The script prints a one-time
# hint to run:
#     sudo tools/fix_volume_permissions.sh
#
# Bind sources are discovered dynamically from the resolved compose config;
# nothing is hardcoded. Named volumes (type: volume) and single-file bind
# mounts (e.g. the settings seed yaml) are skipped.
#
# Usage: tools/prepare_volume_dirs.sh [compose-file ...]
#        (default: docker-compose.yml)

set -eu

cd "$(dirname "$0")/.."

# The invoking user even when the startup script itself was started with
# sudo: the shared group must be the original user's primary group, never
# root's.
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    HOST_GID="$(id -g "$SUDO_USER")"
else
    HOST_GID="$(id -g)"
fi

# Default: the production compose file (its config includes the dsh-git
# submodule compose, so the bridge's repos bind is covered too).
if [ "$#" -eq 0 ]; then
    set -- docker-compose.yml
fi

BIND_DIRS=""
for compose_file in "$@"; do
    [ -f "$compose_file" ] || continue
    config="$(docker compose -f "$compose_file" config 2>/dev/null)" || true
    BIND_DIRS="$BIND_DIRS$(printf '%s\n' "$config" | awk '
        /type: bind/ { inbind = 1; next }
        inbind && /source:/ { print $2; inbind = 0 }
    ')"
done

mkdir -p ../volumes
chmod 2775 ../volumes 2>/dev/null || true

HINT=0
# The here-document keeps the loop in this shell, so HINT survives it
# (a `... | while` pipeline would run the loop in a subshell).
while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    if [ ! -e "$dir" ]; then
        mkdir -p "$dir"
        echo "Created bind-mount directory: $dir"
    fi
    [ -d "$dir" ] || continue

    if ! chgrp "$HOST_GID" "$dir" 2>/dev/null || ! chmod 2775 "$dir" 2>/dev/null; then
        echo "Warning: cannot set group/permissions on $dir (not owned by this user)." >&2
        HINT=1
        continue
    fi

    # Fast path: already normalized once.
    if [ -e "$dir/.volume-permissions-ok" ]; then
        continue
    fi

    if chgrp -R "$HOST_GID" "$dir" 2>/dev/null \
        && chmod -R g+rwX,o-w "$dir" 2>/dev/null \
        && find "$dir" -type d -exec chmod g+s {} + 2>/dev/null; then
        touch "$dir/.volume-permissions-ok"
    else
        HINT=1
    fi
done <<EOF
$(printf '%s\n' "$BIND_DIRS" | sort -u)
EOF

if [ "$HINT" -eq 1 ]; then
    echo "Some volume entries are not owned by this user (root-owned files from" >&2
    echo "an earlier container run). Repair them once with:" >&2
    echo "    sudo tools/fix_volume_permissions.sh" >&2
fi
