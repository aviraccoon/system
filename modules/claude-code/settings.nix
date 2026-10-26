# Claude Code managed settings - shared definition
# Used by darwin and nixos modules for platform-specific placement
#
# Managed settings have highest precedence and cannot be overridden by user settings
# See: https://docs.anthropic.com/en/docs/claude-code/settings
#
# Returns { settings, mcp } — two JSON files to deploy:
#   managed-settings.json — hooks, autoMemory, etc.
#   managed-mcp.json      — org-wide MCP servers (user-level ~/.claude.json mcpServers ignored when this is present)
{ pkgs, config }:
let
  # Hook scripts path (scripts installed via home-manager llm.nix)
  hookScriptsPath = "~/.claude/hooks";

  # Shared MCP server list (formatted for Claude Code's schema)
  mcpServers = import ../llm-mcp.nix {
    inherit pkgs;
    mcpDir = "${config.systemFlakeDir}/config/llm/mcp";
  };

  settings = {
    # Disable auto-memory, using journal context instead
    autoMemoryEnabled = false;

    hooks = {
      # Runs at session start - injects journal context split across hooks.
      # Each hook output is capped, and a part over the cap arrives truncated;
      # the split keeps one oversized part from consuming another's budget.
      SessionStart =
        builtins.map
          (part: {
            hooks = [
              {
                type = "command";
                command = "${hookScriptsPath}/session-start.sh ${part}";
              }
            ];
          })
          [
            "instructions"
            "project-instructions"
            "metadata"
            "journal:0"
            "journal:1"
            "journal:2"
          ];
      # Runs before context compaction - reminder to journal
      PreCompact = [
        {
          hooks = [
            {
              type = "command";
              command = "${hookScriptsPath}/pre-compact.sh";
            }
          ];
        }
      ];
      # Runs when subagent spawns - tells it not to journal
      SubagentStart = [
        {
          hooks = [
            {
              type = "command";
              command = "${hookScriptsPath}/subagent-start.sh";
            }
          ];
        }
      ];
    };
  };

in
{
  settings = pkgs.writeText "claude-managed-settings.json" (builtins.toJSON settings);
  mcp = pkgs.writeText "claude-managed-mcp.json" (builtins.toJSON mcpServers.toClaudeMcp);
}
