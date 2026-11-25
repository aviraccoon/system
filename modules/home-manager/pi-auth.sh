#!/usr/bin/env bash
# Deploy pi's credential file as a real file: the managed keys merged over
# whatever was already in it. The managed file carries `!llm-key` references, not
# key bodies. The merge only adds and overrides: a provider deleted from the
# managed file stays in the target and is removed by hand.
# pi locks `<realpath>.lock`, which cannot be created in the read-only store while
# the file is a store symlink, so the file must be real. Strict mode comes from
# `writeShellApplication` in `pi.nix`. A switch overlapping a token refresh can
# overwrite the newer token.
#
#   pi-auth <managed.json> <target>

# Everything written here carries credentials; keep it unreadable until chmod.
umask 077
managed=$1
target=$2

# A symlink cannot host the lock; the file it points at keeps its own bytes.
if [[ -L "$target" ]]; then
  rm -f "$target"
fi

mkdir -p "$(dirname "$target")"
if [[ -f "$target" ]]; then
  jq -s '.[0] + .[1]' "$target" "$managed" >"$target.new"
else
  jq . "$managed" >"$target.new"
fi
chmod 600 "$target.new"
mv -f "$target.new" "$target"
