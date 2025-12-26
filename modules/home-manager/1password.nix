# 1Password integration: SSH agent, CLI completions, plugin aliases, and SSH config
# Adapted from https://github.com/kclejeune/system
{ config
, lib
, pkgs
, ...
}:
let
  home = config.home.homeDirectory;
  darwinSockPath = "${home}/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock";
  sockPath = "${home}/.1password/agent.sock";
  aliases = {
    gh = "op plugin run -- gh";
    cachix = "op plugin run -- cachix";
    # brew = "op plugin run -- brew";
  };
in
{
  home.sessionVariables = {
    SSH_AUTH_SOCK = sockPath;
    OP_PLUGIN_ALIASES_SOURCED = 1;
    # Fix macOS LC_CTYPE=UTF-8 (invalid on Linux) - use valid locale instead
    LC_CTYPE = "en_US.UTF-8";
  };

  home.file.sock = lib.mkIf pkgs.stdenvNoCC.isDarwin {
    source = config.lib.file.mkOutOfStoreSymlink darwinSockPath;
    target = ".1password/agent.sock";
  };
  programs.bash = {
    initExtra = lib.mkIf pkgs.stdenvNoCC.isDarwin ''
      if command -v op >/dev/null; then
        source <(op completion bash)
      fi
    '';
    shellAliases = aliases;
  };
  programs.fish = {
    interactiveShellInit = lib.mkIf pkgs.stdenvNoCC.isDarwin ''
      op completion fish | source
    '';
    shellAliases = aliases;
  };
  programs.zsh = {
    initContent = lib.mkIf pkgs.stdenvNoCC.isDarwin ''
      if command -v op >/dev/null; then
        eval "$(op completion zsh)"; compdef _op op
      fi
    '';
    shellAliases = aliases;
  };
  programs.ssh = {
    enable = true;
    enableDefaultConfig = false;
    includes = lib.optionals pkgs.stdenvNoCC.isDarwin [
      # Added by OrbStack: 'orb' SSH host for Linux machines
      # This only works if it's at the top of ssh_config (before any Host blocks).
      "~/.orbstack/ssh/config"
    ] ++ [
      # 1Password configs
      "~/.ssh/1Password/config"
    ];
    matchBlocks = {
      # Default settings for all hosts
      "*" = {
        controlMaster = "auto";
        controlPersist = "10m";
      };
      "gamediscoverco" = {
        user = "discoverer";
        localForwards = [{
          bind.port = 23306;
          host.address = "127.0.0.1";
          host.port = 3306;
        }];
      };
      "raccpat-public" = {
        hostname = "176.9.147.244";
      };
    };
  };
}
