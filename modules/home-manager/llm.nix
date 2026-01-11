# LLM agent configuration (Claude Code, etc.)
{ config, ... }: {
  # Symlink global instructions to Claude Code's expected location
  home.file.".claude/CLAUDE.md".source = ../../config/llm-instructions.md;

  # Ensure notes directory exists
  home.file."notes/llm/.keep".text = "";
}
