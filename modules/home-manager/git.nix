# Git configuration with 1Password SSH signing
{
  config,
  pkgs-unstable,
  ...
}:
{
  programs.git = {
    enable = true;
    package = pkgs-unstable.git;
    lfs.enable = true;

    settings = {
      # User identity + commit-signing key (1Password SSH key, registered on GitHub)
      user = {
        name = "aviraccoon";
        email = "368677+aviraccoon@users.noreply.github.com";
        signingkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHwxJ/uQQtFgsmDDiUfMTDjlLl/aSihCeAuGukVKBVEA";
      };
      init.defaultBranch = "main";
      pull.rebase = true;
      rebase.autoStash = true;
      push.autoSetupRemote = true;
      gpg.format = "ssh";
      "gpg.ssh".program = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
      commit.gpgsign = true;
      merge.conflictStyle = "zdiff3";
      diff.algorithm = "histogram";
      rerere.enabled = true;
      rebase.autoSquash = true;
      rebase.updateRefs = true;
      fetch.prune = true;
      branch.sort = "-committerdate";
      help.autocorrect = "prompt";
      core.pager = "delta";
      # Review-gate hooks; the scripts are deployed by ./git-hooks. A repository
      # that sets its own core.hooksPath shadows them, and /review-gate status
      # reports the gate inactive there.
      core.hooksPath = "${config.home.homeDirectory}/.config/git/hooks";
      interactive.diffFilter = "delta --color-only";
      delta = {
        dark = true;
        line-numbers = true;
        navigate = true; # n/N to jump between diff sections
        pager = "less --mouse";
      };
    };

    ignores = [
      ".DS_Store"
      "AGENTS.local.md"
      "CLAUDE.local.md"
      "mise.local.toml"
      ".lsp/"
    ];
  };
}
