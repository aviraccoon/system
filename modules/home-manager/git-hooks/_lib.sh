# Shared by the review-gate git hooks. POSIX sh; the Nix wrapper supplies a
# pinned PATH, so nothing here needs an absolute program path.
#
# The gate applies only to agent runs: pi's bash tool sets PI_SESSION_ID on
# every call and deletes it from the inherited shell environment otherwise, so
# a commit typed in a terminal is not gated. Skipping the gate by unsetting the
# variable is outside the threat model; this is a compliance gate, not a
# sandbox. The state directory is always derived from $HOME for the same
# reason: an environment override would be a one-line bypass.
#
# Running a repository's own hook is a separate decision from the gate, and
# applies to every commit: see commit_hook.

state_dir() { printf '%s\n' "$HOME/.pi/agent/state"; }
ledger_file() { printf '%s\n' "$(state_dir)/review-ledger.json"; }
off_file() { printf '%s\n' "$(state_dir)/review-gate-off"; }
exempt_file() { printf '%s\n' "$(state_dir)/review-gate-exempt.json"; }
trust_file() { printf '%s\n' "$(state_dir)/review-hooks-trust.json"; }

short() { printf '%s\n' "$1" | cut -c1-8; }

# SHA-1 and SHA-256 repositories both reach the hooks.
zero_oid() { case $1 in *[!0]*) return 1 ;; *) return 0 ;; esac; }

refuse() {
  printf '%s\n' "$*" >&2
  exit 1
}

agent_run() { test -n "${PI_SESSION_ID:-}"; }

# Off switch and exemption are user decisions; either one ends the gate.
gate_active() {
  agent_run || return 1
  test ! -e "$(off_file)" || return 1
  return 0
}

repo_root() {
  root=$(git rev-parse --show-toplevel 2>/dev/null) || return 1
  cd "$root" || return 1
  pwd -P
}

repo_exempt() {
  test -f "$(exempt_file)" || return 1
  jq -e --arg repo "$1" 'any(.repos[]?; .repo == $repo)' "$(exempt_file)" >/dev/null 2>&1
}

ledger_entry() { # repo tree -> the entry as JSON on stdout, or nothing
  test -f "$(ledger_file)" || return 1
  jq -c --arg repo "$1" --arg tree "$2" \
    '[.entries[]? | select(.repo == $repo and .tree == $tree)] | last // empty' \
    "$(ledger_file)" 2>/dev/null
}

entry_accepts() {
  printf '%s' "$1" | jq -e '(.override != null) or (.verdict.blocking == false)' >/dev/null 2>&1
}

last_reviewed_tree() {
  test -f "$(ledger_file)" || return 1
  jq -r --arg repo "$1" \
    '[.entries[]? | select(.repo == $repo)] | sort_by(.reviewedAt) | last | .tree // empty' \
    "$(ledger_file)" 2>/dev/null
}

refuse_unreadable_index() {
  refuse "review gate: cannot read the staged index (unresolved conflicts?); resolve them and re-stage."
}

refuse_message() { # repo tree reviewed-message committed-message
  printf '%s\n' "review gate: the message being committed does not match the reviewed message." >&2
  printf '%s\n' "  repo: $1" "  tree: $(short "$2")" >&2
  if [ -z "$3" ]; then
    printf '%s\n' "  reviewed: no message was recorded for this tree." >&2
  else
    printf '%s\n' "  reviewed subject: $(printf '%s\n' "$3" | sed -n '1p')" >&2
  fi
  printf '%s\n' "  commit subject:   $(printf '%s\n' "$4" | sed -n '1p')" >&2
  printf '%s\n' "  Call the review tool with the message as it will be committed; a changed message invalidates the review." >&2
  exit 1
}

refuse_tree() { # repo tree entry
  printf '%s\n' "review gate: this commit's tree has no clean review." >&2
  printf '%s\n' "  repo: $1" "  staged tree: $(short "$2")" >&2
  if [ -n "$3" ]; then
    blocking=$(printf '%s' "$3" | jq -r '.verdict.blocking // false' 2>/dev/null || printf 'true')
    if [ "$blocking" = "true" ]; then
      printf '%s\n' "  the recorded round for this tree is blocking:" >&2
      printf '%s' "$3" | jq -r '.verdict.reasons[]? | "    " + .' >&2
    fi
  else
    last=$(last_reviewed_tree "$1") || last=""
    if [ -n "$last" ]; then
      printf '%s\n' "  last reviewed tree: $(short "$last")" "  unreviewed delta:" >&2
      git diff --stat "$last" "$2" 2>/dev/null | sed 's/^/    /' >&2
      # The last review's tree is HEAD's, so the delta above is everything since
      # that commit. Name the baseline; the cause is not derivable from it.
      last_head=$(git rev-parse --verify 'HEAD^{tree}' 2>/dev/null) || last_head=""
      if [ -n "$last_head" ] && [ "$last_head" = "$last" ]; then
        printf '%s\n' "  the last review covered HEAD's tree ($(short "$last")), so the delta above is everything since that commit." >&2
      fi
    else
      printf '%s\n' "  no review is recorded for this repository." >&2
    fi
  fi
  printf '%s\n' "  Fix the findings and call the review tool, then commit again; only the user can let this tree through (/review-gate override)." >&2
  exit 1
}

# The tree must have a recorded round that is not blocking, and when a message
# is supplied, it must equal the reviewed message.
#
# Only the backstop passes a message, and it reads the commit object, so the
# comparison never has to re-derive git's cleanup mode. The other hooks check
# the tree alone: commit-msg sees the message before git cleans it.
require_review() { # repo tree [message]
  repo=$1
  tree=$2
  entry=$(ledger_entry "$repo" "$tree") || entry=""
  if [ -n "$entry" ] && entry_accepts "$entry"; then
    if [ $# -ge 3 ]; then
      stored=$(printf '%s' "$entry" | jq -r '.message // ""')
      # An override recorded before any review has no message to compare; the
      # override authorizes the tree, so the message cannot be checked.
      unchecked=$(printf '%s' "$entry" | jq -r '(.override != null) and ((.message // "") == "")')
      if [ "$stored" != "$3" ] && [ "$unchecked" != "true" ]; then
        refuse_message "$repo" "$tree" "$stored" "$3"
      fi
    fi
    return 0
  fi
  refuse_tree "$repo" "$tree" "$entry"
}

repo_hook_path() { # name -> path of the repository's own hook, or failure
  common=$(git rev-parse --git-common-dir 2>/dev/null) || return 1
  case $common in
    /*) ;;
    *) common="$PWD/$common" ;;
  esac
  hook="$common/hooks/$1"
  test -x "$hook" || return 1
  printf '%s\n' "$hook"
}

hook_trusted() { # repo name path
  hash=$(sha256sum "$3" | cut -d' ' -f1) || return 1
  test -f "$(trust_file)" || return 1
  jq -e --arg repo "$1" --arg hook "$2" --arg hash "$hash" \
    'any(.hooks[]?; .repo == $repo and .hook == $hook and .sha256 == $hash)' \
    "$(trust_file)" >/dev/null 2>&1
}

# A repository hook is code that arrived with the repository, so it runs only
# when the user trusted that exact content. An untrusted hook that decides the
# commit refuses it; any other untrusted hook is skipped with a warning, since
# failing a checkout, a push or a merge would be a wider blast radius than the
# commit rule it enforces.
commit_hook() {
  case $1 in
    pre-commit | commit-msg | prepare-commit-msg | pre-merge-commit) return 0 ;;
    *) return 1 ;;
  esac
}

refuse_untrusted_hook() { # name path
  hash=$(sha256sum "$2" | cut -d' ' -f1)
  printf '%s\n' "review gate: the repository's $1 hook is not trusted." >&2
  printf '%s\n' "  hook: $2" "  sha256: $hash" >&2
  printf '%s\n' "  The user runs /review-gate trust-hooks to trust exactly this content." >&2
  exit 1
}

warn_untrusted_hook() { # name path reason
  printf '%s\n' "review gate: skipping the repository's $1 hook: $3." >&2
  printf '%s\n' "  hook: $2" >&2
}

# A bare repository has no worktree, so there is no path to key trust on.
run_repo_hook() { # name [args...]
  name=$1
  shift
  hook=$(repo_hook_path "$name") || return 0
  repo=$(repo_root) || {
    warn_untrusted_hook "$name" "$hook" "no worktree to key trust on"
    return 0
  }
  if hook_trusted "$repo" "$name" "$hook"; then
    "$hook" "$@" || exit $?
    return 0
  fi
  if commit_hook "$name"; then
    refuse_untrusted_hook "$name" "$hook"
  fi
  warn_untrusted_hook "$name" "$hook" "it is not trusted"
  return 0
}

# For hooks whose stdin is git's payload: read it first, then feed the same
# bytes to the repository hook through a temp file, so both see the input.
run_repo_hook_with_input() { # name input [args...]
  name=$1
  input=$2
  shift 2
  hook=$(repo_hook_path "$name") || return 0
  repo=$(repo_root) || {
    warn_untrusted_hook "$name" "$hook" "no worktree to key trust on"
    return 0
  }
  if ! hook_trusted "$repo" "$name" "$hook"; then
    if commit_hook "$name"; then
      refuse_untrusted_hook "$name" "$hook"
    fi
    warn_untrusted_hook "$name" "$hook" "it is not trusted"
    return 0
  fi
  tmp=$(mktemp "${TMPDIR:-/tmp}/review-gate-hook.XXXXXX")
  printf '%s\n' "$input" >"$tmp"
  status=0
  "$hook" "$@" <"$tmp" || status=$?
  rm -f "$tmp"
  test "$status" -eq 0 || exit "$status"
}

# A merge or cherry-pick in progress, or a rebase rewriting history, is not a
# commit being made now; the state file is what says so. REVERT_HEAD is not in
# the list: `git revert -n` leaves it behind, and the commit that follows would
# then carry an unreviewed tree past every hook.
history_in_progress() {
  for marker in MERGE_HEAD CHERRY_PICK_HEAD rebase-merge rebase-apply; do
    path=$(git rev-parse --git-path "$marker" 2>/dev/null) || continue
    if [ -e "$path" ]; then return 0; fi
  done
  return 1
}

# A commit the repository already knows: on a ref, in FETCH_HEAD, or named by a
# reflog. None of those is history being created now.
commit_is_known() { # oid
  if [ -n "$(git for-each-ref --contains "$1" --count=1 --format='%(refname)')" ]; then
    return 0
  fi
  fetch_head=$(git rev-parse --git-path FETCH_HEAD)
  if [ -f "$fetch_head" ] && grep -q "^$1" "$fetch_head"; then
    return 0
  fi
  if git log -g --all --format=%H 2>/dev/null | grep -qx "$1"; then
    return 0
  fi
  return 1
}

# True when this ref update records a tree the gate has not seen: a new commit
# on HEAD or a branch. Everything else (rewind, branch creation, fetch,
# fast-forward, tags, stash, ORIG_HEAD/AUTO_MERGE bookkeeping) is not a commit
# being made now. Ref name and OID shape are the first filters because git
# signals those other writes through the same hook.
ref_records_new_commit() { # new
  new=$1
  case $new in
    *[!0-9a-f]*) return 1 ;;
  esac
  case ${#new} in
    40 | 64) ;;
    *) return 1 ;;
  esac
  if zero_oid "$new"; then return 1; fi
  git rev-parse --verify --quiet "$new^{commit}" >/dev/null 2>&1 || return 1
  # A rewind, branch creation, fast-forward, pull or reset to a reflog entry
  # names a commit the repository already knows; that is not new history.
  if commit_is_known "$new"; then
    return 1
  fi
  return 0
}
