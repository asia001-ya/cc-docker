#!/bin/bash
# Exercise the session's shell handoff without loading the developer's shell profiles.
case "${1:-}" in
  -l) printf '%s\n' shell >> "$TDC_TEST_SHELL_LOG"; shift ;;
  -lc) printf '%s\n' cmd >> "$TDC_TEST_SHELL_LOG"; shift; set -- -c "$@" ;;
esac
exec "$TDC_TEST_BASH" --noprofile --norc "$@"
