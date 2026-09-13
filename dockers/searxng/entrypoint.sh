#!/bin/sh
# SearXNG config bootstrap wrapper (mounted over the stock image entrypoint).
#
# Runs before the stock SearXNG image entrypoint:
#   * when the ".config_loaded" flag is absent from the config volume,
#     settings.yml is generated below, with a random secret key;
#   * right after generating the config, the flag file is created, so the
#     config is NOT overwritten on subsequent container starts.
# Delete ".config_loaded" from the config volume to force a regeneration.
set -eu
umask 0002

CONFIG_PATH="${__SEARXNG_CONFIG_PATH:-/etc/searxng}"
FLAG_FILE="$CONFIG_PATH/.config_loaded"
SETTINGS_FILE="$CONFIG_PATH/settings.yml"

if [ ! -e "$FLAG_FILE" ]; then
    SECRET_KEY="$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"

    cat <<EOF
...
... SearXNG bootstrap
... generating "$SETTINGS_FILE" (random secret key) and creating the
... ".config_loaded" flag; delete the flag to regenerate the config.
...
EOF

    cat > "$SETTINGS_FILE" <<EOF
# Read the documentation before extending the defaults:
# https://docs.searxng.org/admin/settings/
use_default_settings: true

general:
  debug: false
  instance_name: "SearXNG"

search:
  default_lang: auto
  languages:
    - all
    - en
    - pl
  safe_search: 0
  autocomplete: ""
  formats:
    - html
    - json

server:
  secret_key: "$SECRET_KEY"
  limiter: false
  image_proxy: true

ui:
  default_locale: ""
EOF

    touch "$FLAG_FILE"
fi

# Hand over to the stock image entrypoint; fall back to a direct granian
# start if the stock script ever moves.
if [ -f /usr/local/searxng/entrypoint.sh ]; then
    exec /usr/local/searxng/entrypoint.sh "$@"
fi

exec /usr/local/searxng/.venv/bin/granian searx.webapp:app
