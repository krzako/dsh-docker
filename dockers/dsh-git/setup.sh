#!/usr/bin/env bash
set -euo pipefail

# Keep an interactive terminal window open after success or failure.
# This is especially useful when the script is launched by double-click on Windows.
pause_on_exit() {
    local status=$?
    trap - EXIT

    if [[ -t 0 && -t 1 ]]; then
        printf '\nPress any key to continue...'
        IFS= read -r -n 1 _ || true
        printf '\n'
    fi

    exit "$status"
}

trap pause_on_exit EXIT

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ENV_FILE="$SCRIPT_DIR/.env"
EXAMPLE_ENV="$SCRIPT_DIR/.env.example"
SETUP_MARKER="$SCRIPT_DIR/.setup-complete"

is_windows_posix() {
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*) return 0 ;;
        *) return 1 ;;
    esac
}

docker_cmd() {
    if is_windows_posix; then
        MSYS_NO_PATHCONV=1 docker "$@"
    else
        docker "$@"
    fi
}

docker_compose() {
    # Run Compose from the bridge directory instead of passing SCRIPT_DIR as a
    # Docker CLI path. This avoids Git Bash/MSYS2 path double-conversion.
    if is_windows_posix; then
        (
            cd "$SCRIPT_DIR"
            MSYS_NO_PATHCONV=1 docker compose -f docker-compose.yml "$@"
        )
    else
        (
            cd "$SCRIPT_DIR"
            docker compose -f docker-compose.yml "$@"
        )
    fi
}

need() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "ERROR: required command not found: $1" >&2
        exit 1
    }
}

read_env_value() {
    local key="$1"
    [[ -f "$ENV_FILE" ]] || return 0
    sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

container_is_managed_bridge() {
    local container="$1"
    [[ -n "$container" ]] || return 1
    [[ "$(docker_cmd inspect -f '{{ index .Config.Labels "com.dsh-git.managed" }}' "$container" 2>/dev/null || true)" == "true" ]]
}

print_setup_info() {
    local result="$1"
    local changed="$2"
    local bridge_container bridge_image bridge_port bridge_network
    local container_state repos_source actual_image

    bridge_container="$(read_env_value BRIDGE_CONTAINER)"
    bridge_image="$(read_env_value BRIDGE_IMAGE)"
    bridge_port="$(read_env_value BRIDGE_PORT)"
    bridge_network="$(read_env_value BRIDGE_NETWORK)"

    bridge_container="${bridge_container:-dsh-git}"
    bridge_image="${bridge_image:-dsh-git:local}"
    bridge_port="${bridge_port:-9418}"
    bridge_network="${bridge_network:-dsh_git}"

    container_state="not found"
    repos_source="$SCRIPT_DIR/repos"
    actual_image="$bridge_image"

    if docker_cmd inspect "$bridge_container" >/dev/null 2>&1; then
        container_state="$(docker_cmd inspect -f '{{if .State.Running}}running{{else}}{{.State.Status}}{{end}}' "$bridge_container" 2>/dev/null || printf '%s' unknown)"
        repos_source="$(docker_cmd inspect -f '{{range .Mounts}}{{if eq .Destination "/repos"}}{{.Source}}{{end}}{{end}}' "$bridge_container" 2>/dev/null || true)"
        actual_image="$(docker_cmd inspect -f '{{.Config.Image}}' "$bridge_container" 2>/dev/null || printf '%s' "$bridge_image")"
        repos_source="${repos_source:-$SCRIPT_DIR/repos}"
    fi

    echo
    printf '%s\n' '============================================================'
    printf '%s\n' 'DSH Git Bridge setup information'
    printf '%s\n' '============================================================'
    printf 'Setup result:       %s\n' "$result"
    printf 'Changes made:       %s\n' "$changed"
    printf 'Container:          %s\n' "$bridge_container"
    printf 'Container state:    %s\n' "$container_state"
    printf 'Image:              %s\n' "$actual_image"
    printf 'Host repositories:  %s\n' "$repos_source"
    printf 'Docker network:     %s\n' "$bridge_network"
    printf 'Host Git endpoint:  git://localhost:%s/<repo>.git\n' "$bridge_port"
    printf 'DSH Git endpoint:   git://%s/<repo>.git\n' "$bridge_container"
    printf '%s\n' '------------------------------------------------------------'
    printf '%s\n' 'Your DSH container only needs access to the bridge network.'
    printf '%s\n' 'Add this ONCE to the existing DSH compose configuration:'
    cat <<EOF2

services:
  dsh:
    networks:
      - default
      - dsh_git

networks:
  dsh_git:
    external: true
    name: ${bridge_network}
EOF2
    printf '%s\n' '------------------------------------------------------------'
    printf '%s\n' 'No DSH workspace volume or workspace path is managed here.'
    printf '%s\n' 'Keep using your existing DSH workspace exactly as it is.'
    printf '%s\n' '------------------------------------------------------------'
    printf '%s\n' 'To add a project:'
    printf '%s\n' '  1. Copy add-to-dsh.sh into the root of that Git repository.'
    printf '%s\n' '  2. Run it there from Git Bash, MSYS2, WSL, or Linux.'
    printf '%s\n' '  3. Delete the copied script afterwards if you want.'
    printf '%s\n' '============================================================'
}

need git
need docker

docker_cmd info >/dev/null 2>&1 || {
    echo 'ERROR: Docker daemon is not reachable.' >&2
    exit 1
}

docker_cmd compose version >/dev/null 2>&1 || {
    echo 'ERROR: Docker Compose v2 (docker compose) is required.' >&2
    exit 1
}

# Strict idempotence: after a successful setup, or when an already-created
# managed bridge container is detected (e.g. from an older script version),
# do not build, start, create, rewrite, or touch anything.
EXISTING_CONTAINER="$(read_env_value BRIDGE_CONTAINER)"
EXISTING_CONTAINER="${EXISTING_CONTAINER:-dsh-git}"

if [[ -f "$SETUP_MARKER" ]] || container_is_managed_bridge "$EXISTING_CONTAINER"; then
    echo 'INFO: DSH Git Bridge is already set up.'
    echo 'INFO: No files, containers, images, networks, or configuration were changed.'
    print_setup_info 'ALREADY EXISTS' 'NO - strict no-op'
    exit 0
fi

mkdir -p "$SCRIPT_DIR/repos"

if [[ ! -f "$ENV_FILE" ]]; then
    [[ -f "$EXAMPLE_ENV" ]] || {
        echo "ERROR: missing $EXAMPLE_ENV" >&2
        exit 1
    }

    cp "$EXAMPLE_ENV" "$ENV_FILE"
    echo "Created $ENV_FILE"
else
    echo "Using existing $ENV_FILE (setup was not previously completed)"
fi

BRIDGE_NETWORK="$(read_env_value BRIDGE_NETWORK)"
BRIDGE_CONTAINER="$(read_env_value BRIDGE_CONTAINER)"
BRIDGE_PORT="$(read_env_value BRIDGE_PORT)"

[[ -n "$BRIDGE_NETWORK" && -n "$BRIDGE_CONTAINER" && -n "$BRIDGE_PORT" ]] || {
    echo 'ERROR: .env is missing required bridge values.' >&2
    exit 1
}

echo
printf '%s\n' '== Building central Git bridge image =='
docker_compose build

BRIDGE_IMAGE="$(read_env_value BRIDGE_IMAGE)"
BRIDGE_IMAGE="${BRIDGE_IMAGE:-dsh-git:local}"

# Fail before creating/marking the service if the image cannot actually run
# git-daemon. Alpine packages git-daemon separately from the base git package.
echo '== Verifying git-daemon is present in the image =='
if ! docker_cmd run --rm --entrypoint sh "$BRIDGE_IMAGE" -c 'test -x "$(git --exec-path)/git-daemon"'; then
    echo 'ERROR: git-daemon is missing from the bridge image.' >&2
    exit 1
fi

echo '== Starting central Git bridge =='
docker_compose up -d --no-build

# Do not trust the first transient "running" state: a broken entrypoint may
# immediately enter Docker's restart loop. Require the container to remain up
# and the git-daemon process to actually be present for several checks.
BRIDGE_HEALTHY=no
for _ in 1 2 3 4 5; do
    RUNNING="$(docker_cmd inspect -f '{{.State.Running}}' "$BRIDGE_CONTAINER" 2>/dev/null || true)"
    if [[ "$RUNNING" == 'true' ]] && \
       docker_cmd exec "$BRIDGE_CONTAINER" sh -c "ps 2>/dev/null | grep '[g]it daemon' >/dev/null" 2>/dev/null; then
        BRIDGE_HEALTHY=yes
    else
        BRIDGE_HEALTHY=no
        break
    fi
    sleep 1
done

if [[ "$BRIDGE_HEALTHY" != yes ]]; then
    echo "ERROR: $BRIDGE_CONTAINER did not stay healthy after startup." >&2
    docker_compose logs --no-color --tail=100 dsh-git >&2 || true
    exit 1
fi

# Marker is created only after a successful first setup. It allows future runs
# to be a strict no-op even if the bridge container is temporarily stopped.
: > "$SETUP_MARKER"

print_setup_info 'CREATED SUCCESSFULLY' 'YES - first setup'
