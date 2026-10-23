# Review-gate git hooks.
#
# The scripts live in this directory as plain POSIX shell so the same bytes can
# be run by `hooks.test.ts`. Deployment copies them into the store and puts a
# wrapper in front of each that pins PATH; the store copy is what git executes,
# so an agent cannot edit the active hooks.
{ pkgs, lib, ... }:
let
  gateHooks = [
    "pre-commit"
    "commit-msg"
    "reference-transaction"
  ];

  # A global core.hooksPath replaces the hook directory for every name, so a
  # repository's own hook under any other name would never be found. These
  # names chain it back in for a repository with a worktree; a bare repository
  # has no worktree to key trust on, so the hooks skip there. fsmonitor-watchman
  # is left out: git expects protocol output from it, and a pass-through that
  # prints nothing is worse than no hook at all.
  passThroughHooks = [
    "applypatch-msg"
    "pre-applypatch"
    "post-applypatch"
    "pre-merge-commit"
    "prepare-commit-msg"
    "post-commit"
    "pre-rebase"
    "post-checkout"
    "post-merge"
    "pre-push"
    "pre-receive"
    "update"
    "proc-receive"
    "post-receive"
    "post-update"
    "push-to-checkout"
    "pre-auto-gc"
    "post-rewrite"
    "sendemail-validate"
    "post-index-change"
    "p4-changelist"
    "p4-prepare-changelist"
    "p4-post-changelist"
    "p4-pre-submit"
  ];

  hookNames = gateHooks ++ passThroughHooks;

  scripts = pkgs.runCommand "review-gate-hooks" { } ''
    mkdir -p $out
    cp ${./_lib.sh} $out/_lib.sh
    chmod 444 $out/_lib.sh
    ${lib.concatMapStrings (name: ''
      cp ${./.}/${name} $out/${name}
      chmod 555 $out/${name}
    '') gateHooks}
    ${lib.concatMapStrings (name: ''
      cp ${./pass-through} $out/${name}
      chmod 555 $out/${name}
    '') passThroughHooks}
  '';

  hookPath = lib.makeBinPath [
    pkgs.git
    pkgs.jq
    pkgs.coreutils
    pkgs.gnugrep
    pkgs.gnused
  ];

  wrapper =
    name:
    pkgs.writeShellScript name ''
      export PATH=${hookPath}
      exec ${scripts}/${name} "$@"
    '';
in
{
  home.file = lib.listToAttrs (
    map (name: {
      name = ".config/git/hooks/${name}";
      value.source = wrapper name;
    }) hookNames
  );
}
