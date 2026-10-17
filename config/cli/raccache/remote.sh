#!/usr/bin/env bash
# Collector for `raccache status`. Runs on the backup server and prints a line
# protocol on stdout:
#   PAUSED 0|1
#   UNIT <name> <systemd-state>
#   TIMER <name> <epoch-seconds|date|->   (whatever systemctl gives us)
#   LOG <name> <one line, truncated>
#   PROGRESS <name> <rclone "Transferred: ..." line, if any>
#   SAMPLED <epoch-seconds of the size sample>
#   SIZE <path> <rclone size --json>
#   NOTE <free text>                     (rendered as an info line)
#
# Sizes are the expensive part (one recursive listing per path), so they are
# cached for SIZE_TTL seconds (default 60) and fetched in parallel. Live
# progress comes from the rclone stats lines already in the logs.
#
# Which jobs to report comes in over RACCACHE_UNITS as comma-separated
# unit=log pairs (the controller's devices.toml holds them), so nothing about a
# machine's unit names is baked into this file. Which remote paths to size is
# machine-local: one b2crypt path per line in ~/.config/raccache/status-targets.
set -u

R="${RCLONE:-$HOME/.local/bin/rclone}"
BACKUP_LOG_DIR="$HOME/backup-logs"

if [ -e "$HOME/.config/raccache/pause" ]; then
  echo "PAUSED 1"
else
  echo "PAUSED 0"
fi

UNITS=${RACCACHE_UNITS:-}
if [ -z "$UNITS" ]; then
  echo "NOTE no units configured for this device (set units in the controller's devices.toml)"
fi

for pair in $(printf '%s' "$UNITS" | tr ',' ' '); do
  unit=${pair%%=*}
  echo "UNIT $unit $(systemctl --user is-active "$unit.service" 2>/dev/null || true)"
done

for pair in $(printf '%s' "$UNITS" | tr ',' ' '); do
  unit=${pair%%=*}
  v=$(systemctl --user show -p NextElapseUSecRealtime --value --timestamp=unix "$unit.timer" 2>/dev/null || true)
  [ -n "$v" ] || v=-
  echo "TIMER $unit $v"
done

for pair in $(printf '%s' "$UNITS" | tr ',' ' '); do
  name=${pair#*=}
  f="$BACKUP_LOG_DIR/$name-$(date +%F).log"
  line=$(tail -n1 "$f" 2>/dev/null | tr -d '\r' | cut -c1-160)
  [ -n "$line" ] || line=-
  echo "LOG $name $line"
  prog=$(tail -n 200 "$f" 2>/dev/null | grep -a "^Transferred:.*ETA" | tail -n1)
  [ -n "$prog" ] || prog=$(tail -n 200 "$f" 2>/dev/null | grep -a "^Transferred:" | tail -n1)
  [ -n "$prog" ] || prog=-
  prog=$(printf '%s' "$prog" | cut -c1-110)
  echo "PROGRESS $name $prog"
done

TARGETS_FILE="$HOME/.config/raccache/status-targets"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/raccache"
CACHE_FILE="$CACHE_DIR/sizes"
SIZE_TTL="${SIZE_TTL:-60}"
mkdir -p "$CACHE_DIR"

cache_age=999999
if [ -f "$CACHE_FILE" ]; then
  mtime=$(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0)
  cache_age=$(( $(date +%s) - mtime ))
fi

if [ ! -f "$TARGETS_FILE" ]; then
  echo "NOTE no $TARGETS_FILE - list one b2crypt path per line to see sizes"
elif [ "$cache_age" -lt "$SIZE_TTL" ]; then
  cat "$CACHE_FILE"
else
  tmp=$(mktemp -d)
  i=0
  while IFS= read -r p; do
    case "$p" in "" | \#*) continue ;; esac
    i=$((i + 1))
    (
      j=$("$R" size "b2crypt:$p" --json 2>/dev/null || true)
      if [ -z "$j" ]; then
        j='{"count":0,"bytes":0}'
        : >"$tmp/failed.$(printf '%04d' "$i")"
      fi
      printf 'SIZE %s %s\n' "$p" "$j" >"$tmp/$(printf '%04d' "$i")"
    ) &
  done <"$TARGETS_FILE"
  wait
  failed=$(find "$tmp" -name 'failed.*' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$failed" -gt 0 ]; then
    # Leave the cache file (and its mtime) alone: the sample time stays honest
    # and the next call retries the failed listings.
    echo "NOTE size listing failed for $failed path(s) - showing the previous sample"
    [ -f "$CACHE_FILE" ] && cat "$CACHE_FILE"
  else
    new_cache=$(mktemp "$CACHE_DIR/sizes.new.XXXXXX")
    for f in "$tmp"/*; do
      case "$f" in *failed.*) continue ;; esac
      cat "$f" >>"$new_cache"
    done
    mv "$new_cache" "$CACHE_FILE"
    cat "$CACHE_FILE"
  fi
  rm -rf "$tmp"
fi
if [ -f "$CACHE_FILE" ]; then
  echo "SAMPLED $(stat -c %Y "$CACHE_FILE" 2>/dev/null || date +%s)"
fi
