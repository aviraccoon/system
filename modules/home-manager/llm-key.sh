#!/usr/bin/env bash
# Print one LLM tooling secret by name. For a named secret, stdout carries the value
# and nothing else. Strict mode comes from `writeShellApplication` in `llm-keys.nix`;
# `op` and coreutils come from PATH, not from nix.
#
#   apiKey = "!llm-key openrouter-main";

pi_base=op://oqpoo4svevbobqjgyniixhmqca/llm-api-keys/pi
generic_base=op://oqpoo4svevbobqjgyniixhmqca/llm-api-keys/generic
items=(openrouter-main zai openrouter-sidecar artificialanalysis)
account_file="${XDG_CONFIG_HOME:-$HOME/.config}/llm/1password-account"
log_file="${XDG_STATE_HOME:-$HOME/.local/state}/llm-key.log"

die() {
  printf 'llm-key: %s\n' "$1" >&2
  exit 1
}

# A log that cannot be written must not fail the read.
log() {
  local dir size=0
  dir="$(dirname "$log_file")"
  [[ -d "$dir" ]] || mkdir -p "$dir" 2>/dev/null || return 0
  if [[ -f "$log_file" ]]; then
    size="$(wc -c <"$log_file" 2>/dev/null || printf 0)"
    size="${size//[[:space:]]/}"
  fi
  if (( ${size:-0} > 262144 )); then
    mv -f "$log_file" "$log_file.old" 2>/dev/null || true
  fi
  printf '%s pid=%s ppid=%s cwd=%q %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$PPID" "$PWD" "$*" \
    >>"$log_file" 2>/dev/null || true
}

account="${LLM_KEY_ACCOUNT:-}"
account="${account//[[:space:]]/}"
if [[ -z "$account" && -r "$account_file" ]]; then
  account="$(<"$account_file")"
  account="${account//[[:space:]]/}"
fi
opcmd=(op)
if [[ -n "$account" ]]; then
  opcmd+=(--account "$account")
fi

usage='usage: llm-key <name|op://reference>\n       llm-key --names\n       llm-key --check\n'

case "${1:-}" in
  "")
    printf '%b' "$usage" >&2
    exit 2
    ;;
  -h | --help)
    printf '%b' "$usage"
    exit 0
    ;;
  --names)
    printf '%s\n' "${items[@]}"
    exit 0
    ;;
  --check)
    log "start check"
    if ! command -v op >/dev/null 2>&1; then
      log "no-op check"
      die "op (1Password CLI) is not on PATH"
    fi
    if "${opcmd[@]}" vault list --format json >/dev/null 2>&1; then
      log "ok check"
      printf 'llm-key: vault answers (account=%s)\n' "${account:-unset}"
      exit 0
    fi
    log "fail check"
    die "vault did not answer; unlock 1Password and retry (account=${account:-unset})"
    ;;
  op://*)
    ref="$1"
    name="${1##*/}"
    ;;
  *)
    name="$1"
    case "$name" in
      openrouter-main | zai | openrouter-sidecar) ref="$pi_base/$name" ;;
      artificialanalysis) ref="$generic_base/artificialanalysis" ;;
      *) die "unknown secret name: $name (try: llm-key --names)" ;;
    esac
    ;;
esac

# Log first: pi kills this command at 10 s, so a read that never returns leaves
# only this line.
log "start name=$name"

if ! command -v op >/dev/null 2>&1; then
  log "no-op name=$name"
  die "op (1Password CLI) is not on PATH"
fi

if ! value="$("${opcmd[@]}" read "$ref" 2>/dev/null)"; then
  log "fail name=$name"
  die "could not read $name; unlock 1Password, and check $account_file if more than one account exists"
fi
[[ -n "$value" ]] || {
  log "empty name=$name"
  die "empty value for $name"
}

log "ok name=$name"
printf '%s\n' "$value"
