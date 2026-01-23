# LLM agent configuration (Claude Code, etc.)
{ config, pkgs, ... }:
let
  notesDir = "${config.home.homeDirectory}/notes/llm";
  jq = "${pkgs.jq}/bin/jq";

  # Shared text for no-notes reminder
  noNotesReminder = ''
    File naming: YYYY-MM-DD-NN-topic.md (NN = sequence number for the day)
    Journal after orientation, when stuck/surprised, when something clicks, and at session end.'';

  # Session start hook: reads recent journal notes and injects as context
  sessionStartScript = pkgs.writeShellScript "claude-session-start" ''
        set -euo pipefail

        NOTES_DIR="${notesDir}"
        PROJECT_NAME=$(basename "$PWD")
        PROJECT_NOTES="$NOTES_DIR/$PROJECT_NAME"

        NO_NOTES_REMINDER="${noNotesReminder}"

        output_context() {
          ${jq} -n --arg ctx "$1" '{
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: $ctx
            }
          }'
        }

        # Create directory if missing
        if [[ ! -d "$PROJECT_NOTES" ]]; then
          mkdir -p "$PROJECT_NOTES"
          output_context "No previous session notes for $PROJECT_NAME.
    Notes directory created: $PROJECT_NOTES/

    $NO_NOTES_REMINDER"
          exit 0
        fi

        # Find recent note files (last 3, sorted by name which includes date)
        RECENT_NOTES=$(find "$PROJECT_NOTES" -name "*.md" -type f | sort -r | head -3)

        # No notes yet
        if [[ -z "$RECENT_NOTES" ]]; then
          output_context "No previous session notes for $PROJECT_NAME.
    Notes directory: $PROJECT_NOTES/

    $NO_NOTES_REMINDER"
          exit 0
        fi

        # Build context from recent notes
        CONTEXT="Previous session notes for $PROJECT_NAME:"$'\n\n'
        for note in $RECENT_NOTES; do
          FILENAME=$(basename "$note")
          CONTENT=$(cat "$note")
          CONTEXT+="--- $FILENAME ---"$'\n'"$CONTENT"$'\n\n'
        done

        output_context "$CONTEXT"
  '';

  # Pre-compact hook: reminds to journal before context is lost
  preCompactScript = pkgs.writeShellScript "claude-pre-compact" ''
    set -euo pipefail

    PROJECT_NAME=$(basename "$PWD")
    PROJECT_NOTES="${notesDir}/$PROJECT_NAME"

    ${jq} -n --arg dir "$PROJECT_NOTES" '{
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext: ("CONTEXT COMPACTION IMMINENT - Journal now!\n\nWrite session notes to: " + $dir + "/\nCapture: what you learned, decisions made, what is unfinished, what the next agent should know.\n\nThis is part of the work, not extra work.")
      }
    }'
  '';
in
{
  # Generate global instructions with expanded home directory
  # (Claude Code doesn't handle ~ well in paths)
  home.file.".claude/CLAUDE.md".text =
    builtins.replaceStrings
      [ "~/" ]
      [ "${config.home.homeDirectory}/" ]
      (builtins.readFile ../../config/llm-instructions.md);

  # Ensure notes directory exists
  home.file."notes/llm/.keep".text = "";

  # Hook scripts (referenced by managed-settings.json)
  home.file.".claude/hooks/session-start.sh" = {
    source = sessionStartScript;
    executable = true;
  };

  home.file.".claude/hooks/pre-compact.sh" = {
    source = preCompactScript;
    executable = true;
  };
}
