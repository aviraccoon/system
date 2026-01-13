# Claude Code managed settings - shared definition
# Used by darwin and nixos modules for platform-specific placement
#
# Managed settings have highest precedence and cannot be overridden by user settings
# See: https://docs.anthropic.com/en/docs/claude-code/settings
{ pkgs }:
let
  # Hook scripts path (scripts installed via home-manager llm.nix)
  hookScriptsPath = "~/.claude/hooks";

  settings = {
    hooks = {
      # Runs at session start - injects recent journal context
      SessionStart = [{
        hooks = [{
          type = "command";
          command = "${hookScriptsPath}/session-start.sh";
        }];
      }];
      # Runs before context compaction - reminder to journal
      PreCompact = [{
        hooks = [{
          type = "command";
          command = "${hookScriptsPath}/pre-compact.sh";
        }];
      }];
    };
  };
in
pkgs.writeText "claude-managed-settings.json" (builtins.toJSON settings)
