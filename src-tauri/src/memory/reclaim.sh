set -eu
# Only clean page cache and reclaimable inode/dentry caches are dropped. Anonymous
# application memory, tmpfs, files, containers and terminal processes are untouched.
case "$(uname -r)" in
  *microsoft*WSL2*) ;;
  *) echo 'This is not a WSL2 kernel' >&2; exit 1 ;;
esac
test -w /proc/sys/vm/drop_caches
printf 'TDC_MEMORY_BEFORE\n'
cat /proc/meminfo
sync
printf '3\n' > /proc/sys/vm/drop_caches
printf 'TDC_MEMORY_AFTER\n'
cat /proc/meminfo
