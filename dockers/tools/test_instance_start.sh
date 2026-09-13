#!/usr/bin/env bash
#
# Start the DSH test instance (docker-compose.test.yml, project dsh-test).
#
# At startup the script first asks whether to rebuild the images before
# starting; typing exactly `yes` will rebuild before `docker compose up`.
#
# Then it asks whether to remove the old test volumes:
#   every directory in ../volumes whose name ends in `-test` (the test
#   instance's bind mounts -- discovered dynamically, nothing hardcoded)
#   plus the named volumes of the dsh-test compose project.
#
# Typing exactly `yes` stops the test stack with `docker compose down -v`
# (removing the test containers together with the named volumes) and deletes
# every `-test` directory found in the volumes dir.
# Any other answer keeps the volumes untouched. Every answer is echoed
# back, and the stack is then started in the foreground.
#
# Before anything happens the script verifies that the test instance's host
# ports (4080 web, 4310-4330 agents, 10418 git -- production plus 1000) are
# not already published by another container, so the production instance and
# the test instance can run at the same time.

set -euo pipefail

# Repo root: the compose files the scripts drive live there.
cd "$(dirname "$0")/.."

COMPOSE_FILE="${DSH_TEST_COMPOSE_FILE:-docker-compose.test.yml}"

# The only path to the host volumes directory: every bind-mount directory of
# the test instance lives in there as "<name>-test".
VOLUMES_DIR="../volumes"
# Host ports of the test instance: production ports plus 1000 (keep in sync
# with docker-compose.test.yml).
TEST_WEB_PORT="4080"
TEST_AGENT_PORTS="4310-4330"
TEST_BRIDGE_PORT="10418"

# Git Bash on Windows (MSYS) rewrites POSIX-looking arguments before the
# native docker.exe sees them; disable that (harmless on Linux/macOS).
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

# List every directory under $VOLUMES_DIR whose name ends in "-test"
# (e.g. workspaces-test, searxng-test): the test instance's bind mounts.
# Directory names are discovered dynamically -- nothing is hardcoded.
collect_test_volume_dirs() {
  local dir
  [[ -d "$VOLUMES_DIR" ]] || return 0
  for dir in "$VOLUMES_DIR"/*-test; do
    [[ -d "$dir" ]] || continue
    printf '%s\n' "$dir"
  done
}

# Strip leading/trailing whitespace.
trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Ask a yes/no question; echoes the trimmed answer.
ask() {
  local prompt="$1" answer
  if ! read -r -p "$prompt" answer; then
    echo "Error: no more input available." >&2
    exit 1
  fi
  trim "$answer"
}

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Error: $COMPOSE_FILE not found next to this script." >&2
  exit 1
fi

# Expand a port spec like 4080 or 4310-4330 into single ports.
expand_port_spec() {
  local spec="$1" lo hi
  if [[ ! "$spec" =~ ^[0-9]+(-[0-9]+)?$ ]]; then
    echo "Error: invalid port specification '$spec' (expected e.g. 4080 or 4310-4330)." >&2
    exit 1
  fi
  if [[ "$spec" == *-* ]]; then
    lo="${spec%-*}"; hi="${spec#*-}"
    if (( 10#$lo > 10#$hi )); then
      echo "Error: invalid port range '$spec'." >&2
      exit 1
    fi
    seq "$lo" "$hi"
  else
    printf '%s\n' "$spec"
  fi
}

# Fail early when a host port of the test instance is already published by
# another container (e.g. the production instance). Ports published by the
# test instance's own containers (dsh-test, dsh-git-test) are ignored, so
# restarting the test stack never trips the check.
check_test_ports_free() {
  if ! docker ps >/dev/null 2>&1; then
    echo "Warning: cannot query running containers; skipping the port check." >&2
    return 0
  fi
  local bound port conflicts=()
  bound="$(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null \
    | grep -vE '^(dsh-test|dsh-git-test)\|' \
    | grep -oE ':[0-9]+(-[0-9]+)?->' \
    | sed -E 's/^://; s/->$//' \
    | while IFS= read -r spec; do expand_port_spec "$spec"; done \
    | sort -un || true)"
  while IFS= read -r port; do
    [[ -n "$port" ]] || continue
    if grep -Fxq -- "$port" <<<"$bound"; then
      conflicts+=( "$port" )
    fi
  done < <({ expand_port_spec "$TEST_WEB_PORT"; expand_port_spec "$TEST_AGENT_PORTS"; expand_port_spec "$TEST_BRIDGE_PORT"; } | sort -un)
  if (( ${#conflicts[@]} > 0 )); then
    echo "Error: host port(s) ${conflicts[*]} are already published by another container." >&2
    echo "Move the test instance by editing the ports in $COMPOSE_FILE." >&2
    exit 1
  fi
  echo "Host ports for the test instance are free: $TEST_WEB_PORT (web), $TEST_AGENT_PORTS (agents), $TEST_BRIDGE_PORT (git)."
}

check_test_ports_free

# Rebuild the images before starting?
rebuild="$(ask "Rebuild the images before starting? Type 'yes' to rebuild: ")"

# Remove the old test volumes?
answer="$(ask "Remove the old test volumes first? Type 'yes' to remove: ")"

if [[ "$answer" == "yes" ]]; then
  echo "Removing old test volumes..."
  # Stops and removes the test containers together with every named volume
  # of the dsh-test project (compose down -v).
  compose down -v --remove-orphans
  mapfile -t test_dirs < <(collect_test_volume_dirs)
  if (( ${#test_dirs[@]} > 0 )); then
    rm -rf -- "${test_dirs[@]}"
    echo "Removed the old test volume directories: ${test_dirs[*]}"
  else
    echo "No `-test` directories found in $VOLUMES_DIR."
  fi
else
  echo "Keeping the existing test volumes (they were not removed)."
fi

if [[ "$rebuild" == "yes" ]]; then
  echo "The images will be rebuilt before starting."
  ./tools/test_instance_build.sh
else
  echo "Skipping the rebuild (existing images will be used)."
fi

echo "Starting the test instance in the foreground (Ctrl+C to stop)..."
compose up
