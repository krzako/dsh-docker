#!/usr/bin/env bash
set -euo pipefail

# Keep an interactive terminal window open after success or failure.
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

# Self-contained project registration script.
# Copy this file into any Git working tree, run it there, then delete the copy.
# It creates a protected bare repository in the already-running central bridge
# and adds a `dsh` remote to the source working tree. Existing source remotes
# (especially `origin`) are never removed or modified.
# If that bare repository already exists, this script is a STRICT NO-OP:
# it changes nothing and only prints the current bridge/source information.

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

need() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "ERROR: required command not found: $1" >&2
        exit 1
    }
}

shell_path_to_docker_source() {
    local p="$1"

    if is_windows_posix; then
        if command -v cygpath >/dev/null 2>&1; then
            cygpath -am "$p"
        else
            printf '%s\n' "$p"
        fi
        return
    fi

    # WSL Docker Desktop integration understands /mnt/c/...; native Linux
    # Docker expects the normal POSIX path.
    printf '%s\n' "$p"
}

sanitize_repo_name() {
    local name="$1"
    name="${name%.git}"
    name="$(printf '%s' "$name" | sed -E 's/[^A-Za-z0-9._-]+/-/g; s/^-+//; s/-+$//')"
    printf '%s\n' "$name"
}

label() {
    local container="$1"
    local key="$2"
    docker_cmd inspect -f "{{ index .Config.Labels \"$key\" }}" "$container"
}

read_source_remote_state() {
    SOURCE_ORIGIN_FETCH="$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null || true)"
    SOURCE_ORIGIN_PUSH="$(git -C "$PROJECT_ROOT" remote get-url --push origin 2>/dev/null || true)"
    SOURCE_DSH_FETCH="$(git -C "$PROJECT_ROOT" remote get-url dsh 2>/dev/null || true)"
    SOURCE_DSH_PUSH="$(git -C "$PROJECT_ROOT" remote get-url --push dsh 2>/dev/null || true)"

    SOURCE_ORIGIN_FETCH="${SOURCE_ORIGIN_FETCH:-'(not configured)'}"
    SOURCE_ORIGIN_PUSH="${SOURCE_ORIGIN_PUSH:-'(not configured)'}"
    SOURCE_DSH_FETCH="${SOURCE_DSH_FETCH:-'(not configured)'}"
    SOURCE_DSH_PUSH="${SOURCE_DSH_PUSH:-'(not configured)'}"
}

read_bare_config() {
    local key="$1"
    docker_cmd exec "$BRIDGE_CONTAINER" git --git-dir="$BARE_DOCKER_PATH" config --get "$key" 2>/dev/null || true
}

read_final_state() {
    BARE_HEAD_BRANCH="$(docker_cmd exec "$BRIDGE_CONTAINER" git --git-dir="$BARE_DOCKER_PATH" symbolic-ref --quiet --short HEAD 2>/dev/null || printf '%s' '(detached/unborn)')"
    BRIDGE_HEAD_FULL="$(docker_cmd exec "$BRIDGE_CONTAINER" git --git-dir="$BARE_DOCKER_PATH" rev-parse HEAD 2>/dev/null || true)"
    BRIDGE_HEAD_SHORT="$(docker_cmd exec "$BRIDGE_CONTAINER" git --git-dir="$BARE_DOCKER_PATH" rev-parse --short=12 HEAD 2>/dev/null || printf '%s' '(unborn)')"

    OBJECT_INFO="$(docker_cmd exec "$BRIDGE_CONTAINER" git --git-dir="$BARE_DOCKER_PATH" count-objects -v 2>/dev/null || true)"
    BARE_SIZE_KIB="$(printf '%s\n' "$OBJECT_INFO" | sed -n 's/^size-pack: //p')"

    REQUIRED_NAME="$(read_bare_config bridge.expectedName)"
    REQUIRED_EMAIL="$(read_bare_config bridge.expectedEmail)"
    ALLOWED_PREFIX="$(read_bare_config bridge.allowedPrefix)"
    DENY_DELETES="$(read_bare_config receive.denyDeletes)"
    DENY_NON_FF="$(read_bare_config receive.denyNonFastForwards)"
    HOOKS_PATH="$(read_bare_config core.hooksPath)"

    REQUIRED_NAME="${REQUIRED_NAME:-'(not configured)'}"
    REQUIRED_EMAIL="${REQUIRED_EMAIL:-'(not configured)'}"
    ALLOWED_PREFIX="${ALLOWED_PREFIX:-'(not configured)'}"
    DENY_DELETES="${DENY_DELETES:-'(not configured)'}"
    DENY_NON_FF="${DENY_NON_FF:-'(not configured)'}"
    HOOKS_PATH="${HOOKS_PATH:-'(not configured)'}"

    if [[ -n "$BRIDGE_HEAD_FULL" && "$SOURCE_HEAD" == "$BRIDGE_HEAD_FULL" ]]; then
        HEAD_RELATION='SAME'
    else
        HEAD_RELATION='DIFFERENT'
    fi

    # Read-only endpoint checks. No refs/config/files are changed.
    if docker_cmd exec "$BRIDGE_CONTAINER" git ls-remote "git://127.0.0.1/${PROJECT_NAME}.git" >/dev/null 2>&1; then
        DOCKER_ENDPOINT_STATUS='OK'
    else
        DOCKER_ENDPOINT_STATUS='NOT REACHABLE'
    fi

    if git ls-remote "$BRIDGE_URL_HOST" >/dev/null 2>&1; then
        HOST_ENDPOINT_STATUS='OK'
    else
        HOST_ENDPOINT_STATUS='not reachable from this shell'
    fi
}

print_project_info() {
    local result="$1"
    local changed="$2"

    read_final_state

    printf '%s\n' '============================================================'
    printf '%s\n' 'DSH Git Bridge project information'
    printf '%s\n' '============================================================'
    printf 'Result:             %s\n' "$result"
    printf 'Changes made:       %s\n' "$changed"
    printf 'Project root:       %s\n' "$PROJECT_ROOT"
    printf 'Project name:       %s\n' "$PROJECT_NAME"
    printf 'Current branch:     %s\n' "$CURRENT_BRANCH"
    printf 'Source HEAD:        %s\n' "$SOURCE_HEAD_SHORT"
    printf 'Bridge HEAD:        %s\n' "$BRIDGE_HEAD_SHORT"
    printf 'HEAD relationship:  %s\n' "$HEAD_RELATION"
    printf 'Bare HEAD branch:   %s\n' "$BARE_HEAD_BRANCH"
    read_source_remote_state
    printf 'Source identity:    %s <%s>\n' "${GIT_NAME:-'(not configured)'}" "${GIT_EMAIL:-'(not configured)'}"
    printf 'Source origin:      %s\n' "$SOURCE_ORIGIN_FETCH"
    printf 'Source origin push: %s\n' "$SOURCE_ORIGIN_PUSH"
    printf 'Source dsh:         %s\n' "$SOURCE_DSH_FETCH"
    printf 'Source dsh push:    %s\n' "$SOURCE_DSH_PUSH"
    printf 'Required identity:  %s <%s>\n' "$REQUIRED_NAME" "$REQUIRED_EMAIL"
    printf 'Tracked changes:    %s\n' "$TRACKED_DIRTY"
    printf 'Other untracked:    %s\n' "$UNTRACKED_COUNT"
    printf 'Pack size:          %s KiB\n' "${BARE_SIZE_KIB:-0}"
    printf 'Bridge container:   %s\n' "$BRIDGE_CONTAINER"
    printf 'Bridge network:     %s\n' "$BRIDGE_NETWORK"
    printf 'Bare in bridge:     %s\n' "$BARE_DOCKER_PATH"
    printf 'Host repos source:  %s\n' "$REPOS_DOCKER_SOURCE"
    printf 'DSH remote:         %s (%s)\n' "$BRIDGE_URL_DOCKER" "$DOCKER_ENDPOINT_STATUS"
    printf 'Host remote:        %s (%s)\n' "$BRIDGE_URL_HOST" "$HOST_ENDPOINT_STATUS"
    printf '%s\n' '------------------------------------------------------------'
    printf 'Allowed prefix:     %s\n' "$ALLOWED_PREFIX"
    printf 'Delete refs:        %s\n' "$([[ "$DENY_DELETES" == true ]] && printf '%s' BLOCKED || printf 'config=%s' "$DENY_DELETES")"
    printf 'Force/non-FF push:  %s\n' "$([[ "$DENY_NON_FF" == true ]] && printf '%s' BLOCKED || printf 'config=%s' "$DENY_NON_FF")"
    printf 'Server hooks path:  %s\n' "$HOOKS_PATH"
    printf '%s\n' '------------------------------------------------------------'

    if [[ "$HEAD_RELATION" == 'DIFFERENT' ]]; then
        printf '%s\n' 'INFO: source HEAD and bridge HEAD differ.'
        printf '      Current source HEAD:   %s\n' "$SOURCE_HEAD_SHORT"
        printf '      Existing bridge HEAD:  %s\n' "$BRIDGE_HEAD_SHORT"
        printf '%s\n' '      Nothing was synchronized automatically.'
        printf '%s\n' '------------------------------------------------------------'
    fi

    if [[ "$SOURCE_IDENTITY_CONFIGURED" != yes || "$GIT_NAME" != "$REQUIRED_NAME" || "$GIT_EMAIL" != "$REQUIRED_EMAIL" ]]; then
        printf '%s\n' 'WARNING: source Git identity differs from the identity configured in the bridge.'
        printf '%s\n' '         Existing bridge configuration was NOT changed.'
        printf '%s\n' '------------------------------------------------------------'
    fi

    if [[ "$TRACKED_DIRTY" == yes ]] || (( UNTRACKED_COUNT > 0 )); then
        printf '%s\n' 'WARNING: the source working tree has uncommitted/untracked changes.'
        printf '%s\n' '         Bare repositories contain committed Git history only.'
        printf '%s\n' '------------------------------------------------------------'
    fi

    printf '%s\n' 'Clone it INSIDE your existing DSH workspace:'
    printf '  git clone "%s" <project-directory>\n' "$BRIDGE_URL_DOCKER"
    printf '%s\n' ''
    printf '%s\n' 'Then set/check identity in that DSH working copy:'
    if [[ "$REQUIRED_NAME" != '(not configured)' && "$REQUIRED_EMAIL" != '(not configured)' ]]; then
        printf '  git config user.name "%s"\n' "$REQUIRED_NAME"
        printf '  git config user.email "%s"\n' "$REQUIRED_EMAIL"
    else
        printf '  git config user.name "%s"\n' "$GIT_NAME"
        printf '  git config user.email "%s"\n' "$GIT_EMAIL"
    fi
    printf '  git config user.useConfigOnly true\n'
    printf '%s\n' ''
    printf '%s\n' 'Typical first agent branch:'
    printf '  git switch -c dsh/<task-name>\n'
    printf '  git push -u origin dsh/<task-name>\n'
    printf '%s\n' '------------------------------------------------------------'
    printf '%s\n' 'Useful host commands:'
    printf '  git ls-remote "%s"\n' "$BRIDGE_URL_HOST"
    printf '  git clone "%s"\n' "$BRIDGE_URL_HOST"
    printf '%s\n' '------------------------------------------------------------'
    printf '%s\n' 'The real repository is NOT mounted into DSH or the long-running bridge.'
    printf '%s\n' 'The bare repository has no configured remote pointing back to the real repository.'
    printf '%s\n' 'This script does NOT create or mount any DSH workspace volume.'
    printf '%s\n' 'You may now delete this copied add-to-dsh.sh from the source repository.'
    printf '%s\n' '============================================================'
}

need git
need docker

docker_cmd info >/dev/null 2>&1 || {
    echo 'ERROR: Docker daemon is not reachable.' >&2
    exit 1
}

# Find the unique running bridge. Set DSH_GIT_CONTAINER when more than
# one bridge exists or when using a custom container name.
if [[ -n "${DSH_GIT_CONTAINER:-}" ]]; then
    BRIDGE_CONTAINER="$DSH_GIT_CONTAINER"
else
    mapfile -t BRIDGES < <(docker_cmd ps --filter 'label=com.dsh-git.managed=true' --format '{{.Names}}')
    if (( ${#BRIDGES[@]} == 0 )); then
        echo 'ERROR: no running DSH Git Bridge container was found.' >&2
        echo 'Run ./setup.sh in the central dsh-git project first.' >&2
        exit 1
    elif (( ${#BRIDGES[@]} > 1 )); then
        echo 'ERROR: more than one DSH Git Bridge container is running:' >&2
        printf '  %s\n' "${BRIDGES[@]}" >&2
        echo 'Set DSH_GIT_CONTAINER=<name> and run again.' >&2
        exit 1
    fi
    BRIDGE_CONTAINER="${BRIDGES[0]}"
fi

RUNNING="$(docker_cmd inspect -f '{{.State.Running}}' "$BRIDGE_CONTAINER" 2>/dev/null || true)"
[[ "$RUNNING" == 'true' ]] || {
    echo "ERROR: bridge container is not running: $BRIDGE_CONTAINER" >&2
    exit 1
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"

if [[ -z "$PROJECT_ROOT" ]]; then
    echo 'ERROR: add-to-dsh.sh must be placed inside a Git working tree.' >&2
    exit 1
fi

PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd -P)"
BASE_NAME="$(basename "$PROJECT_ROOT")"
PROJECT_NAME="$(sanitize_repo_name "${DSH_BRIDGE_PROJECT_NAME:-$BASE_NAME}")"

[[ -n "$PROJECT_NAME" ]] || {
    echo 'ERROR: could not derive a valid project name.' >&2
    exit 1
}

GIT_NAME="$(git -C "$PROJECT_ROOT" config --get user.name || true)"
GIT_EMAIL="$(git -C "$PROJECT_ROOT" config --get user.email || true)"
SOURCE_IDENTITY_CONFIGURED=yes
if [[ -z "$GIT_NAME" || -z "$GIT_EMAIL" ]]; then
    SOURCE_IDENTITY_CONFIGURED=no
fi

CURRENT_BRANCH="$(git -C "$PROJECT_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || printf '%s' '(detached HEAD)')"
SOURCE_HEAD="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"
SOURCE_HEAD_SHORT="$(git -C "$PROJECT_ROOT" rev-parse --short=12 HEAD)"

# Ignore the copied helper itself when reporting untracked source files.
SCRIPT_PREFIX="$(git -C "$SCRIPT_DIR" rev-parse --show-prefix 2>/dev/null || true)"
SCRIPT_REL="${SCRIPT_PREFIX}$(basename "${BASH_SOURCE[0]}")"
TRACKED_DIRTY=no
if ! git -C "$PROJECT_ROOT" diff --quiet --ignore-submodules -- || \
   ! git -C "$PROJECT_ROOT" diff --cached --quiet --ignore-submodules --; then
    TRACKED_DIRTY=yes
fi
UNTRACKED_COUNT="$(git -C "$PROJECT_ROOT" ls-files --others --exclude-standard | awk -v self="$SCRIPT_REL" '$0 != self {n++} END {print n+0}')"

BRIDGE_NETWORK="$(label "$BRIDGE_CONTAINER" 'com.dsh-git.network')"
BRIDGE_PORT="$(label "$BRIDGE_CONTAINER" 'com.dsh-git.host-port')"
BRIDGE_IMAGE="$(docker_cmd inspect -f '{{.Config.Image}}' "$BRIDGE_CONTAINER")"
BRIDGE_USER="$(docker_cmd inspect -f '{{.Config.User}}' "$BRIDGE_CONTAINER")"
REPOS_DOCKER_SOURCE="$(docker_cmd inspect -f '{{range .Mounts}}{{if eq .Destination "/repos"}}{{.Source}}{{end}}{{end}}' "$BRIDGE_CONTAINER")"

for value_name in BRIDGE_NETWORK BRIDGE_PORT REPOS_DOCKER_SOURCE; do
    [[ -n "${!value_name}" && "${!value_name}" != '<no value>' ]] || {
        echo "ERROR: bridge metadata is incomplete: $value_name" >&2
        exit 1
    }
done

PROJECT_DOCKER_SOURCE="$(shell_path_to_docker_source "$PROJECT_ROOT")"
BARE_DOCKER_PATH="/repos/${PROJECT_NAME}.git"
BRIDGE_URL_DOCKER="git://${BRIDGE_CONTAINER}/${PROJECT_NAME}.git"
BRIDGE_URL_HOST="git://localhost:${BRIDGE_PORT}/${PROJECT_NAME}.git"

# Snapshot source remotes before any write. `origin` is read-only metadata for
# this script: it is never removed, renamed, or rewritten.
ORIGIN_EXISTED_BEFORE=no
ORIGIN_FETCH_BEFORE="$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null || true)"
ORIGIN_PUSH_BEFORE="$(git -C "$PROJECT_ROOT" remote get-url --push origin 2>/dev/null || true)"
if [[ -n "$ORIGIN_FETCH_BEFORE" ]]; then
    ORIGIN_EXISTED_BEFORE=yes
fi

DSH_EXISTED_BEFORE=no
DSH_FETCH_BEFORE="$(git -C "$PROJECT_ROOT" remote get-url dsh 2>/dev/null || true)"
DSH_PUSH_BEFORE="$(git -C "$PROJECT_ROOT" remote get-url --push dsh 2>/dev/null || true)"
if [[ -n "$DSH_FETCH_BEFORE" ]]; then
    DSH_EXISTED_BEFORE=yes
fi

# Strict no-op for already-registered projects. We only read current state and
# print the same useful information as after first registration.
if docker_cmd exec "$BRIDGE_CONTAINER" sh -c 'test -e "$1"' sh "$BARE_DOCKER_PATH"; then
    if [[ "$(docker_cmd exec "$BRIDGE_CONTAINER" git --git-dir="$BARE_DOCKER_PATH" rev-parse --is-bare-repository 2>/dev/null || true)" != true ]]; then
        echo "ERROR: $BARE_DOCKER_PATH already exists but is not a valid bare Git repository." >&2
        echo 'Nothing was changed.' >&2
        exit 1
    fi

    echo 'INFO: this project already exists in the DSH Git Bridge.'
    echo 'INFO: No refs, objects, config, hooks, files, or repository settings were changed.'
    print_project_info 'ALREADY EXISTS' 'NO - strict no-op'
    exit 0
fi

# First registration only: refuse to overwrite/retarget an existing `dsh`
# remote. The user must resolve that conflict explicitly.
if [[ "$DSH_EXISTED_BEFORE" == yes ]] && \
   { [[ "$DSH_FETCH_BEFORE" != "$BRIDGE_URL_HOST" ]] || [[ "$DSH_PUSH_BEFORE" != "$BRIDGE_URL_HOST" ]]; }; then
    echo 'ERROR: source repository already has a remote named `dsh` pointing elsewhere.' >&2
    echo "  fetch: $DSH_FETCH_BEFORE" >&2
    echo "  push:  $DSH_PUSH_BEFORE" >&2
    echo "  wanted: $BRIDGE_URL_HOST" >&2
    echo 'Nothing was changed.' >&2
    exit 1
fi

# A new registration needs an identity to configure the server-side policy.
if [[ "$SOURCE_IDENTITY_CONFIGURED" != yes ]]; then
    echo 'ERROR: Git user.name and user.email must be configured for first registration.' >&2
    echo 'For example:' >&2
    echo '  git config user.name "Your Name"' >&2
    echo '  git config user.email "you@example.com"' >&2
    echo 'Nothing was created or changed in the bridge.' >&2
    exit 1
fi

printf '%s\n' '============================================================'
printf '%s\n' 'Adding project to DSH Git Bridge'
printf '%s\n' '============================================================'
printf 'Project root:       %s\n' "$PROJECT_ROOT"
printf 'Project name:       %s\n' "$PROJECT_NAME"
printf 'Current branch:     %s\n' "$CURRENT_BRANCH"
printf 'Source HEAD:        %s\n' "$SOURCE_HEAD_SHORT"
printf 'Git identity:       %s <%s>\n' "$GIT_NAME" "$GIT_EMAIL"
printf 'Tracked changes:    %s\n' "$TRACKED_DIRTY"
printf 'Other untracked:    %s\n' "$UNTRACKED_COUNT"
printf 'Bridge container:   %s\n' "$BRIDGE_CONTAINER"
printf 'Bridge network:     %s\n' "$BRIDGE_NETWORK"
printf 'Bare in bridge:     %s\n' "$BARE_DOCKER_PATH"
printf 'Host repos source:  %s\n' "$REPOS_DOCKER_SOURCE"
printf 'DSH remote:         %s\n' "$BRIDGE_URL_DOCKER"
printf 'Host remote:        %s\n' "$BRIDGE_URL_HOST"
printf '%s\n' '------------------------------------------------------------'

if [[ "$TRACKED_DIRTY" == yes ]] || (( UNTRACKED_COUNT > 0 )); then
    echo 'WARNING: the source working tree has uncommitted/untracked changes.'
    echo '         Bare clone contains committed Git history only; those files are'
    echo '         NOT copied into the bridge.'
    echo '------------------------------------------------------------'
fi

echo '[1/5] Creating protected bare repository through a short-lived helper...'

# The helper receives the real project read-only and /repos from the running
# bridge. The long-running bridge itself never sees the real project path.
DOCKER_USER_ARGS=()
if [[ -n "$BRIDGE_USER" ]]; then
    DOCKER_USER_ARGS=(--user "$BRIDGE_USER")
fi

docker_cmd run --rm \
    "${DOCKER_USER_ARGS[@]}" \
    --volumes-from "$BRIDGE_CONTAINER" \
    --mount "type=bind,src=${PROJECT_DOCKER_SOURCE},dst=/source,readonly" \
    -e "REPO=/repos/${PROJECT_NAME}.git" \
    -e "GIT_NAME=${GIT_NAME}" \
    -e "GIT_EMAIL=${GIT_EMAIL}" \
    --entrypoint sh \
    "$BRIDGE_IMAGE" \
    -c '
        set -eu
        export HOME=/tmp
        export GIT_CONFIG_COUNT=1
        export GIT_CONFIG_KEY_0=safe.directory
        export GIT_CONFIG_VALUE_0="*"

        # Race-safe: never modify an already-existing destination.
        if [ -e "$REPO" ]; then
            echo "ERROR: $REPO appeared while registering; refusing to modify it." >&2
            exit 42
        fi

        git clone --bare --no-local /source "$REPO"

        git --git-dir="$REPO" config receive.denyDeletes true
        git --git-dir="$REPO" config receive.denyNonFastForwards true
        git --git-dir="$REPO" config core.hooksPath /opt/git-hooks
        git --git-dir="$REPO" config bridge.expectedName "$GIT_NAME"
        git --git-dir="$REPO" config bridge.expectedEmail "$GIT_EMAIL"
        git --git-dir="$REPO" config bridge.allowedPrefix "dsh/"

        # Export only after all protection settings are installed.
        : > "$REPO/git-daemon-export-ok"
    '

echo '[2/5] Server-side protection installed.'

echo '[3/5] Adding source remote `dsh` without touching existing remotes...'
if [[ "$DSH_EXISTED_BEFORE" != yes ]]; then
    git -C "$PROJECT_ROOT" remote add dsh "$BRIDGE_URL_HOST"
fi

# Regression guard: if `origin` existed before, it must still exist with
# exactly the same fetch/push URLs. This script never writes to `origin`.
if [[ "$ORIGIN_EXISTED_BEFORE" == yes ]]; then
    ORIGIN_FETCH_AFTER="$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null || true)"
    ORIGIN_PUSH_AFTER="$(git -C "$PROJECT_ROOT" remote get-url --push origin 2>/dev/null || true)"
    if [[ "$ORIGIN_FETCH_AFTER" != "$ORIGIN_FETCH_BEFORE" || "$ORIGIN_PUSH_AFTER" != "$ORIGIN_PUSH_BEFORE" ]]; then
        echo 'ERROR: safety check failed: source `origin` changed unexpectedly.' >&2
        echo "  before fetch: $ORIGIN_FETCH_BEFORE" >&2
        echo "  after fetch:  $ORIGIN_FETCH_AFTER" >&2
        echo "  before push:  $ORIGIN_PUSH_BEFORE" >&2
        echo "  after push:   $ORIGIN_PUSH_AFTER" >&2
        exit 1
    fi
fi

DSH_FETCH_AFTER="$(git -C "$PROJECT_ROOT" remote get-url dsh 2>/dev/null || true)"
DSH_PUSH_AFTER="$(git -C "$PROJECT_ROOT" remote get-url --push dsh 2>/dev/null || true)"
if [[ "$DSH_FETCH_AFTER" != "$BRIDGE_URL_HOST" || "$DSH_PUSH_AFTER" != "$BRIDGE_URL_HOST" ]]; then
    echo 'ERROR: failed to configure the source `dsh` remote as expected.' >&2
    exit 1
fi

echo '[4/5] Verifying repository without changing it...'
if ! docker_cmd exec "$BRIDGE_CONTAINER" git ls-remote "git://127.0.0.1/${PROJECT_NAME}.git" >/dev/null 2>&1; then
    echo 'ERROR: repository was created, but git-daemon endpoint verification failed.' >&2
    exit 1
fi

echo '[5/5] Reading final state...'
print_project_info 'CREATED SUCCESSFULLY' 'YES - first registration'
