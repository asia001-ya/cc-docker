# Reuse an existing persistent session with one active client. The fallback
# launcher handles new sessions. Keep this in the desktop binary for old images.
target=$1
shift
if tmux has-session -t "$target" 2>/dev/null; then
  exec tmux attach-session -d -t "$target"
fi
exec "$@"
