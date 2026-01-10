# Git configuration with 1Password SSH signing
{ pkgs, pkgs-unstable, ... }: {
  programs.git = {
    enable = true;
    package = pkgs-unstable.git;
    lfs.enable = true;

    settings = {
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
    };

    ignores = [
      ".DS_Store"
    ];
  };
}
