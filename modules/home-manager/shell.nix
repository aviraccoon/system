# Shell configuration: zsh with powerlevel10k, bash, keybindings, and mise
{ config
, lib
, pkgs
, systemFlakeDir
, ...
}:
let
  # Platform-aware command that handles Terminal.app requirement on macOS
  # (Homebrew can kill the current terminal during switch)
  nixCommand = cmd:
    if pkgs.stdenvNoCC.isDarwin then ''
      if [[ $TERM_PROGRAM == 'Apple_Terminal' ]]; then
        (cd ${systemFlakeDir} && mise ${cmd})
      else
        echo 'Opening Terminal.app to run ${cmd}...'
        osascript -e 'tell app "Terminal" to do script "cd ${systemFlakeDir} && /opt/homebrew/bin/mise ${cmd}"'
      fi
    '' else ''
      (cd ${systemFlakeDir} && mise ${cmd})
    '';
in
{
  # atuin: shell history in SQLite with fuzzy search
  # Usage: Ctrl+R for interactive search, `atuin search <query>` for CLI
  # Docs: https://docs.atuin.sh/cli/configuration/config/
  programs.atuin = {
    enable = true;
    enableZshIntegration = true;
    enableBashIntegration = true;
    settings = {
      auto_sync = false; # No cloud sync - local only
      update_check = false; # Managed by nix
      style = "compact"; # Less vertical space
      inline_height = 20; # Max rows for inline display
      enter_accept = true; # Execute immediately on Enter
      filter_mode_shell_up_key_binding = "session"; # Up arrow = current session only
      workspaces = true; # Filter by git repo when in one
      # show_help = false; # Uncomment once familiar with keybindings
    };
  };

  # zoxide: smarter cd that learns your habits
  # Usage: z <partial-path> (e.g., "z proj" jumps to ~/dev/project-name)
  programs.zoxide = {
    enable = true;
    enableZshIntegration = true;
    enableBashIntegration = true;
  };

  programs.zsh = {
    enable = true;

    shellAliases = {
      vault = "cd \"$VAULT_PATH\""; # Jump to Obsidian vault
      nix-switch = nixCommand "nix-switch"; # Build and activate system config
      nix-upgrade = nixCommand "nix-upgrade"; # Update flake inputs and switch
      nix-build = "(cd ${systemFlakeDir} && mise nix-build)"; # Build without activating
      nix-diff = "(cd ${systemFlakeDir} && mise nix-diff)"; # Show pending changes
    };

    history = {
      extended = true;
    };

    historySubstringSearch = {
      enable = true;
    };

    initContent = ''
      # p10k instant prompt
      local P10K_INSTANT_PROMPT="${config.xdg.cacheHome}/p10k-instant-prompt-''${(%):-%n}.zsh"
      [[ ! -r "$P10K_INSTANT_PROMPT" ]] || source "$P10K_INSTANT_PROMPT"

      # Preserve macOS UTF-8 handling
      setopt COMBINING_CHARS

      # macOS keybindings for function keys, arrows, etc.
      typeset -g -A key
      key[Home]="''${terminfo[khome]}"
      key[End]="''${terminfo[kend]}"
      key[Delete]="''${terminfo[kdch1]}"
      key[Up]="''${terminfo[kcuu1]}"
      key[Down]="''${terminfo[kcud1]}"
      key[Left]="''${terminfo[kcub1]}"
      key[Right]="''${terminfo[kcuf1]}"
      key[PageUp]="''${terminfo[kpp]}"
      key[PageDown]="''${terminfo[knp]}"

      [[ -n "''${key[Delete]}" ]] && bindkey "''${key[Delete]}" delete-char
      [[ -n "''${key[Home]}" ]] && bindkey "''${key[Home]}" beginning-of-line
      [[ -n "''${key[End]}" ]] && bindkey "''${key[End]}" end-of-line
      [[ -n "''${key[Up]}" ]] && bindkey "''${key[Up]}" up-line-or-search
      [[ -n "''${key[Down]}" ]] && bindkey "''${key[Down]}" down-line-or-search
      [[ -n "''${key[Left]}" ]] && bindkey "''${key[Left]}" backward-char
      [[ -n "''${key[Right]}" ]] && bindkey "''${key[Right]}" forward-char

      # mise activation (Homebrew path for faster updates)
      eval "$(/opt/homebrew/bin/mise activate zsh)"

      ${lib.optionalString pkgs.stdenvNoCC.isDarwin ''
        # OrbStack CLI and completions
        source ~/.orbstack/shell/init.zsh 2>/dev/null || :

        # Check nixpkgs (stable + unstable) and homebrew versions
        # Usage: nixpkgs-check-version <package> [package2] ...
        nixpkgs-check-version() {
          for pkg in "$@"; do
            echo "$pkg:"
            echo "  stable:   $(nix eval --json nixpkgs#$pkg --apply 'p:{version=p.version;darwin=builtins.elem"aarch64-darwin"p.meta.platforms;}' 2>/dev/null || echo 'not found')"
            echo "  unstable: $(nix eval --json github:NixOS/nixpkgs/nixpkgs-unstable#$pkg --apply 'p:{version=p.version;darwin=builtins.elem"aarch64-darwin"p.meta.platforms;}' 2>/dev/null || echo 'not found')"
            brew_ver=$(brew info --json=v2 "$pkg" 2>/dev/null | jq -r '.formulae[0].versions.stable // empty')
            echo "  homebrew: ''${brew_ver:-not found}"
            echo "  history:  https://repology.org/project/$pkg/history"
          done
        }
      ''}

      # Fix PATH order: nix paths should come before system paths
      # Must be at end of initContent, after mise and brew which prepend to PATH
      # See: https://github.com/NixOS/nix/issues/4169
      export PATH="/etc/profiles/per-user/$USER/bin:/run/current-system/sw/bin:/nix/var/nix/profiles/default/bin:$PATH"
    '';

    plugins = [
      {
        name = "powerlevel10k";
        src = pkgs.zsh-powerlevel10k;
        file = "share/zsh-powerlevel10k/powerlevel10k.zsh-theme";
      }
      {
        name = "powerlevel10k-config";
        src = lib.cleanSource ./zsh-plugins/p10k;
        file = "p10k.zsh";
      }
      {
        name = "friday";
        src = lib.cleanSource ./zsh-plugins/friday;
        file = "friday.sh";
      }
    ];
  };

  programs.bash = {
    enable = true;
    initExtra = ''
      # mise activation (Homebrew path for faster updates)
      eval "$(/opt/homebrew/bin/mise activate bash)"
    '';
  };
}
