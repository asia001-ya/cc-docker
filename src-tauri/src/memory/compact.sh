set -eu
# Optional, explicit compaction migrates movable pages into contiguous ranges so
# WSL can report free pages to Windows. It can cause system-wide latency while
# running; it neither terminates processes nor drops file caches or changes any
# persistent sysctl setting. A timeout cannot hard-cancel a kernel sysctl write.
case "$(uname -r)" in
  *microsoft*WSL2*) ;;
  *) echo 'This is not a WSL2 kernel' >&2; exit 1 ;;
esac
test -w /proc/sys/vm/compact_memory
printf 'TDC_MEMORY_BEFORE\n'
cat /proc/meminfo
printf '1\n' > /proc/sys/vm/compact_memory
printf 'TDC_MEMORY_AFTER\n'
cat /proc/meminfo
