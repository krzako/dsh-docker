#!/usr/bin/env bash
#
# Remove the per-provider settings-seed flag inside the DSH container. The
# next container start then re-applies that provider's seeded settings,
# including its API key wiring to the environment variable delivered through
# .env / docker-compose.
#
# Runs on the host. All container work goes through `docker compose exec`.

set -euo pipefail

# Repo root: the compose files the scripts drive live there.
cd "$(dirname "$0")/.."

SERVICE="${DSH_COMPOSE_SERVICE:-deepseek-harness}"
SEED_SCRIPT="${SETTINGS_SEED_SCRIPT:-/opt/dsh-seed/seed-settings.mjs}"

compose_exec() {
  docker compose exec -T "$SERVICE" "$@"
}

require_running_service() {
  if ! docker compose ps --status running --services 2>/dev/null | grep -Fxq "$SERVICE"; then
    echo "Error: service '$SERVICE' is not running. Start it first with: docker compose up -d" >&2
    exit 1
  fi
}

# Read one line and keep asking until the value matches one of the allowed
# values. An empty input selects the default when one exists. The selection
# is the only thing written to stdout, so it can be captured; prompts and
# error messages go to stderr.
# $1 = prompt text, $2 = default value (empty string = no default),
# remaining arguments = allowed values.
pick_from_list() {
  local prompt="$1"
  local default="$2"
  shift 2
  local allowed=("$@")
  local choice value
  while true; do
    if ! read -r -p "$prompt" choice; then
      echo "Error: no more input available." >&2
      exit 1
    fi
    if [[ -z "$choice" && -n "$default" ]]; then
      printf '%s\n' "$default"
      return 0
    fi
    for value in "${allowed[@]}"; do
      if [[ "$choice" == "$value" ]]; then
        printf '%s\n' "$value"
        return 0
      fi
    done
    echo "Invalid value, try again." >&2
  done
}

# Run one seed-script listing inside the container and return its non-empty
# output lines. Fails the script when the exec or the script fails.
list_from_container() {
  local raw
  raw="$(compose_exec node "$SEED_SCRIPT" "$@")" || {
    echo "Error: failed to run '$SEED_SCRIPT $*' in the container." >&2
    exit 1
  }
  mapfile -t lines < <(printf '%s\n' "$raw" | grep -v '^$' || true)
  local line
  for line in "${lines[@]}"; do
    printf '%s\n' "$line"
  done
}

require_running_service

mapfile -t adapters < <(list_from_container --list-adapters)
if [[ ${#adapters[@]} -eq 0 ]]; then
  echo "Error: no adapters found in the settings seed." >&2
  exit 1
fi

default_adapter=""
if [[ ${#adapters[@]} -eq 1 ]]; then
  default_adapter="${adapters[0]}"
fi

echo "Available adapters:"
for adapter in "${adapters[@]}"; do
  if [[ "$adapter" == "$default_adapter" ]]; then
    echo "  $adapter (default)"
  else
    echo "  $adapter"
  fi
done
if [[ -n "$default_adapter" ]]; then
  echo "Press Enter without typing a value to select the default."
fi
adapter="$(pick_from_list "Select the adapter to reset: " "$default_adapter" "${adapters[@]}")"

echo ""
mapfile -t providers < <(list_from_container --list-providers --adapter "$adapter")
if [[ ${#providers[@]} -eq 0 ]]; then
  echo "Error: no providers found for adapter '$adapter' in the settings seed." >&2
  exit 1
fi

echo "Providers for adapter '$adapter':"
for provider in "${providers[@]}"; do
  echo "  $provider"
done
provider="$(pick_from_list "Select the provider to reset: " "" "${providers[@]}")"

echo ""
compose_exec node "$SEED_SCRIPT" --reset-api-key --adapter "$adapter" --provider "$provider"
