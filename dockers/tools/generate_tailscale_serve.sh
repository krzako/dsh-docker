#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./generate_tailscale_serve.sh --host HOST --map IN:OUT [--map IN:OUT ...] [--format json|compose] [-o FILE]

Examples:
  ./generate_tailscale_serve.sh --host deepseek-harness --map 4080:4080 --map 4300-4399:3300-3399 -o tailscale-serve.json
  ./generate_tailscale_serve.sh --host deepseek-harness --map 4300-4399:3300-3399 --format compose -o tailscale-serve.compose.yaml
EOF
}

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

host=""
format="json"
output=""
declare -a mapping_args=()
declare -a source_ports=()
declare -a target_ports=()
declare -A seen_ports=()

while (( $# > 0 )); do
  case "$1" in
    --host|--map|--format|-o|--output)
      (( $# >= 2 )) || die "Missing value for $1"
      case "$1" in
        --host) host=$2 ;;
        --map) mapping_args+=("$2") ;;
        --format) format=$2 ;;
        -o|--output) output=$2 ;;
      esac
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -n "$host" ]] || die 'Provide --host'
[[ "$host" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "Invalid hostname: $host"
(( ${#mapping_args[@]} > 0 )) || die 'Provide at least one --map'
[[ "$format" == json || "$format" == compose ]] || die "Invalid --format: $format"

# Returns range bounds via RANGE_START and RANGE_END.
parse_range() {
  local value=$1 first last
  [[ "$value" =~ ^([0-9]{1,5})(-([0-9]{1,5}))?$ ]] || die "Invalid port/range: $value"
  first=$((10#${BASH_REMATCH[1]}))
  if [[ -n "${BASH_REMATCH[3]:-}" ]]; then
    last=$((10#${BASH_REMATCH[3]}))
  else
    last=$first
  fi
  (( first >= 1 && last <= 65535 && first <= last )) || die "Port/range outside 1-65535 or reversed: $value"
  RANGE_START=$first
  RANGE_END=$last
}

for mapping in "${mapping_args[@]}"; do
  [[ "$mapping" =~ ^([^:]+):([^:]+)$ ]] || die "Invalid --map: $mapping (expected IN:OUT)"
  in_range=${BASH_REMATCH[1]}
  out_range=${BASH_REMATCH[2]}

  parse_range "$in_range"
  in_start=$RANGE_START
  in_end=$RANGE_END
  parse_range "$out_range"
  out_start=$RANGE_START
  out_end=$RANGE_END

  (( in_end - in_start == out_end - out_start )) || die "Different range sizes: $mapping"
  for (( p=in_start; p<=in_end; p++ )); do
    [[ ! -v seen_ports[$p] ]] || die "Duplicate Tailscale port: $p"
    seen_ports[$p]=1
    source_ports+=("$p")
    target_ports+=("$((out_start + p - in_start))")
  done
done

emit_json() {
  local i total=${#source_ports[@]}
  printf '{\n  "TCP": {\n'
  for (( i=0; i<total; i++ )); do
    printf '    "%s": {\n      "TCPForward": "%s:%s"\n    }' \
      "${source_ports[i]}" "$host" "${target_ports[i]}"
    if (( i < total - 1 )); then printf ','; fi
    printf '\n'
  done
  printf '  }\n}\n'
}

emit_output() {
  if [[ "$format" == compose ]]; then
    printf 'configs:\n  tailscale-serve:\n    content: |\n'
    emit_json | sed 's/^/      /'
  else
    emit_json
  fi
}

if [[ -n "$output" ]]; then
  emit_output > "$output"
  printf 'Generated %d TCP mappings in %s\n' "${#source_ports[@]}" "$output" >&2
else
  emit_output
fi
