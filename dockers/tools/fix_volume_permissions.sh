#!/usr/bin/env bash
#
# Repair host-side permissions on every bind-mounted volume directory of the
# DSH docker stack (all directories under ../volumes, plus every bind source
# discovered from the compose files).
#
# Sharing model (see tools/prepare_volume_dirs.sh and the compose files):
#   * containers keep their image/default users -- dsh, open-webui and
#     searxng run as root
#   * every file a container creates inherits the invoking host user's
#     primary group (setgid bit on the volume directories)
#   * umask 0002 in the container entrypoints keeps that group-writable
#   * others keep read/traverse only; nothing becomes world-writable
#
# This script normalizes EXISTING trees. Older container files are often
# root-owned, so the script needs root itself:
#
#     sudo tools/fix_volume_permissions.sh
#
# It is idempotent and safe to run repeatedly. When not run as root it still
# attempts the repair (useful for user-owned trees) but warns loudly and
# reports every operation it could not perform.

set -euo pipefail

# Repo root: the compose files and ../volumes are resolved from there.
cd "$(dirname "$0")/.."

VOLUMES_DIR="../volumes"

# Resolve the real invoking user: under sudo, SUDO_USER is the original
# account. The shared group must be that user's primary group, never root's
# (which is what plain root's own group would produce).
if [[ -n "${SUDO_USER:-}" ]]; then
    HOST_USER="$SUDO_USER"
elif [[ "$(id -u)" -eq 0 ]]; then
    HOST_USER="$(logname 2>/dev/null || true)"
else
    HOST_USER="$(id -un)"
fi
if [[ -z "$HOST_USER" ]] || { [[ "$(id -u)" -eq 0 && "$HOST_USER" == "root" ]]; }; then
    echo "Error: cannot determine the invoking user, so the shared group would" >&2
    echo "end up as 'root'. Run this script with sudo from your own account:" >&2
    echo "    sudo tools/fix_volume_permissions.sh" >&2
    echo "(not via su / sudo -i)" >&2
    exit 1
fi
HOST_UID="$(id -u "$HOST_USER")"
HOST_GID="$(id -g "$HOST_USER")"

if [[ "$(id -u)" -ne 0 ]]; then
    echo "======================================================================"
    echo "WARNING: SCRIPT SHOULD BE RUN AS ROOT (sudo)"
    echo "======================================================================"
    echo "Files created by the root containers (dsh, open-webui, searxng) are"
    echo "owned by root. Without sudo this script can only repair entries owned"
    echo "by $HOST_USER; every failure is collected and reported below."
    echo "======================================================================"
fi

echo "Host user: $HOST_USER (uid $HOST_UID, shared group $HOST_GID)"

chgrp "$HOST_GID" "$VOLUMES_DIR" 2>/dev/null || true
chmod 2775 "$VOLUMES_DIR" 2>/dev/null || true

# Discover the project-managed volume directories: bind sources from the
# resolved compose config (dynamic, nothing hardcoded) plus every directory
# under the single volumes path as a completeness net (also covers
# docker-less environments).
discover_bind_dirs() {
    local compose_file
    for compose_file in docker-compose.yml docker-compose.test.yml; do
        [[ -f "$compose_file" ]] || continue
        docker compose -f "$compose_file" config 2>/dev/null | awk '
            /type: bind/ { inbind = 1; next }
            inbind && /source:/ { print $2; inbind = 0 }
        ' || true
    done
    if [[ -d "$VOLUMES_DIR" ]]; then
        find "$VOLUMES_DIR" -mindepth 1 -maxdepth 1 -type d
    fi
}

mapfile -t BIND_DIRS < <(discover_bind_dirs | sort -u)

if [[ ${#BIND_DIRS[@]} -eq 0 ]]; then
    echo "No volume directories found (nothing to repair under $VOLUMES_DIR)."
    exit 0
fi

FAILED=0
for dir in "${BIND_DIRS[@]}"; do
    [[ -n "$dir" ]] || continue
    echo "Repairing $dir"
    if [[ ! -e "$dir" ]]; then
        mkdir -p "$dir"
        echo "  created (was missing)"
    fi
    if [[ ! -d "$dir" ]]; then
        echo "  skipped (not a directory)"
        continue
    fi

    ERRLOG="$(mktemp)"
    chgrp -R "$HOST_GID" "$dir" 2>"$ERRLOG" || true
    chmod -R g+rwX,o-w "$dir" 2>>"$ERRLOG" || true
    find "$dir" -type d -exec chmod g+s {} + 2>>"$ERRLOG" || true

    if [[ -s "$ERRLOG" ]]; then
        FAILED=1
        echo "  WARNING: $(wc -l < "$ERRLOG") operation(s) failed; first errors:"
        head -n 5 "$ERRLOG" | sed 's/^/    /'
    else
        touch "$dir/.volume-permissions-ok"
        echo "  done (group $HOST_GID, setgid on directories, no other-write)"
    fi
    rm -f "$ERRLOG"
done

if [[ "$FAILED" -eq 1 ]]; then
    echo "Repair incomplete: entries reported above could not be changed." >&2
    exit 1
fi
echo "All writable volume directories are shared with group $HOST_GID."
