# LLM agent configuration (Claude Code, etc.)
{ config, lib, pkgs, ... }:
let
  notesDir = "${config.home.homeDirectory}/notes/llm";
  jq = "${pkgs.jq}/bin/jq";
  isDarwin = pkgs.stdenvNoCC.isDarwin;

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

  # Claude browser extension native messaging config
  # Helium already reads Chrome's NativeMessagingHosts, so this is redundant but
  # makes the dependency explicit and future-proofs against Helium changing behavior.
  # Points to Claude.app's native host which creates a socket that Claude Code connects to.
  nativeMessagingConfig = builtins.toJSON {
    name = "com.anthropic.claude_browser_extension";
    description = "Claude Browser Extension Native Host";
    path = "/Applications/Claude.app/Contents/Helpers/chrome-native-host";
    type = "stdio";
    allowed_origins = [
      "chrome-extension://dihbgbndebgnbjfmelmegjepbnkhlgni/"
      "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/"
      "chrome-extension://dngcpimnedloihjnnfngkgjoidhnaolf/"
    ];
  };

  # Application Support paths
  heliumSupport = "Library/Application Support/net.imput.helium";
  chromeSupport = "Library/Application Support/Google/Chrome";

  # Claude extension ID (public Chrome Web Store version)
  claudeExtensionId = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
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

  # Claude Code + Helium browser integration (macOS only)
  #
  # Problem: Claude Code hardcodes Chrome's config path for extension detection.
  # Even though native messaging works (Helium reads Chrome's NativeMessagingHosts),
  # Claude Code reports "Extension: Not detected" because it looks for the extension
  # in ~/Library/Application Support/Google/Chrome/Default/Extensions/.
  #
  # Solution:
  # 1. Native messaging config in Helium's directory (explicit, future-proof)
  # 2. Symlink extension from Helium to Chrome's path (tricks detection)
  #
  # See: https://github.com/anthropics/claude-code/issues/14391
  #      https://github.com/anthropics/claude-code/issues/18075

  home.file."${heliumSupport}/NativeMessagingHosts/com.anthropic.claude_browser_extension.json" =
    lib.mkIf isDarwin {
      text = nativeMessagingConfig;
    };

  home.activation.claudeCodeHeliumSetup = lib.mkIf isDarwin (
    lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      HELIUM_EXT="$HOME/${heliumSupport}/Default/Extensions/${claudeExtensionId}"
      CHROME_EXT="$HOME/${chromeSupport}/Default/Extensions/${claudeExtensionId}"

      # Only set up if Helium has the Claude extension installed
      if [[ -d "$HELIUM_EXT" ]]; then
        mkdir -p "$(dirname "$CHROME_EXT")"

        # Symlink extension for Claude Code detection (idempotent)
        if [[ ! -e "$CHROME_EXT" ]]; then
          $DRY_RUN_CMD ln -sf "$HELIUM_EXT" "$CHROME_EXT"
          $VERBOSE_ECHO "Created Claude extension symlink for Claude Code detection"
        fi
      fi
    ''
  );
}
