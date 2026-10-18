#!/usr/bin/env bash
# Only fixture settings beneath TDC_TEST_DIR are read; host credentials are never loaded.
set -euo pipefail
settings=
args=("$@")
for (( i=0; i<${#args[@]}; i++ )); do
  case "${args[i]}" in
    --) break ;;
    --settings) settings=${args[i+1]:-}; break ;;
    --settings=*) settings=${args[i]#--settings=}; break ;;
  esac
done
settings_json=
if [[ "$settings" == "$TDC_TEST_DIR/"* && -f "$settings" ]]; then
  settings_json=$(cat -- "$settings")
elif [[ "$settings" == \{* ]]; then
  settings_json=$settings
fi
{
  printf '%s\0' "$PWD" "${CLAUDE_CONFIG_DIR-}" "${TDC_SESSION_ID-}" \
    "${CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN-}" "${ANTHROPIC_API_KEY-}" \
    "${ANTHROPIC_AUTH_TOKEN-}" "${ANTHROPIC_BASE_URL-}" "$settings_json" "$#"
  if (( $# )); then printf '%s\0' "$@"; fi
} >> "$TDC_TEST_LOG"
printf '%s' "${TDC_TEST_STDOUT-}"
printf '%s' "${TDC_TEST_STDERR-}" >&2
exit "${TDC_TEST_EXIT_CODE:-0}"
