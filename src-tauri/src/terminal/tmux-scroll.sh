#!/bin/sh
# Run as the session owner. Arguments are a tmux pane target and optional offset from the bottom.
scroll() (
set -eu
target=$1
state() { tmux display-message -p -t "$target" '#{history_size}|#{scroll_position}|#{pane_height}|#{pane_mode}|#{alternate_on}'; }
if [ "$#" -gt 1 ]; then
  desired=$2
  case "$desired" in ''|*[!0-9]*) echo 'Invalid scroll offset' >&2; exit 2;; esac
  current=$(state)
  history=${current%%|*}
  alternate=${current##*|}
  details=${current%|*}
  mode=${details##*|}
  if [ "$alternate" = 1 ]; then echo 'Application manages its own fullscreen history' >&2; exit 2; fi
  case "$mode" in ''|copy-mode) ;; *) echo 'Pane is in another mode' >&2; exit 2;; esac
  [ "$desired" -le "$history" ] || desired=$history
  if [ "$desired" -eq 0 ]; then
    if [ "$mode" = copy-mode ]; then tmux send-keys -t "$target" -X cancel; fi
  else
    if [ "$mode" != copy-mode ]; then tmux copy-mode -t "$target"; fi
    position=$(tmux display-message -p -t "$target" '#{scroll_position}')
    delta=$((desired - position))
    if [ "$delta" -gt 0 ]; then
      tmux send-keys -t "$target" -N "$delta" -X scroll-up
    elif [ "$delta" -lt 0 ]; then
      tmux send-keys -t "$target" -N "$((-delta))" -X scroll-down
    fi
  fi
fi
state
)

# One attached, non-TTY exec per session. A request is "get" or an unsigned offset.
# Nothing is evaluated as shell source; EOF releases the worker. Errors are framed
# separately so one bad request cannot desynchronise the following response.
if [ "${2:-}" = --stream ]; then
  while IFS= read -r request; do
    if [ "$request" = get ]; then
      result=$(scroll "$1" 2>/dev/null)
    else
      result=$(scroll "$1" "$request" 2>/dev/null)
    fi
    if [ "$?" -eq 0 ]; then
      printf 'ok|%s\n' "$result"
    else
      printf 'error|Unable to read or scroll tmux history\n'
    fi
  done
else
  scroll "$@"
fi
