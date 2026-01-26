# OpenCode configuration (journal system, permissions, custom tools)
{ config, lib, pkgs, ... }:
let
  notesDir = "${config.home.homeDirectory}/notes/llm";
  configDir = "${config.xdg.configHome}/opencode";

  # Generate the opencode.json configuration
  # Note: local plugins auto-load from plugins/, no need to list them in plugin array
  opencodeConfig = {
    "$schema" = "https://opencode.ai/config.json";
    # AGENTS.md is read automatically by precedence rules
    # AGENTS.local.md needs to be explicitly included for per-project private context
    instructions = [ "AGENTS.local.md" ];
    permission = {
      "*" = "ask";
      read = "allow";
      glob = "allow";
      grep = "allow";
      list = "allow";
      todoread = "allow";
      todowrite = "allow";
      read_journal = "allow"; # Custom tool from journal plugin
    };
    provider = {
      lmstudio = {
        npm = "@ai-sdk/openai-compatible";
        name = "LM Studio (local)";
        options = {
          baseURL = "http://127.0.0.1:1234/v1";
        };
        models = {
          "zai-org/glm-4.7-flash" = {
            name = "GLM 4.7 Flash (local)";
            variants = {
              high = {
                reasoningEffort = "high";
                textVerbosity = "low";
                reasoningSummary = "auto";
              };
              low = {
                reasoningEffort = "low";
                textVerbosity = "low";
                reasoningSummary = "auto";
              };
            };
          };
          "openai/gpt-oss-20b" = {
            name = "GPT OSS 20b (local)";
          };
        };
      };
    };
  };

  # The journal plugin - provides custom tool and compaction hook
  # This needs to be a real file (not symlink) so bun can resolve node_modules
  journalPluginContent = ''
        import { tool } from "@opencode-ai/plugin";
        import type { Plugin } from "@opencode-ai/plugin";
        import { readdir, readFile, mkdir } from "node:fs/promises";
        import { join, basename } from "node:path";
        import { existsSync } from "node:fs";

        const NOTES_DIR = "${notesDir}";

        interface NotesResult {
          exists: boolean;
          path: string;
          notes: Array<{ filename: string; content: string }>;
        }

        async function getRecentNotes(projectName: string): Promise<NotesResult> {
          const projectNotes = join(NOTES_DIR, projectName);

          // Create directory if missing
          if (!existsSync(projectNotes)) {
            await mkdir(projectNotes, { recursive: true });
            return {
              exists: false,
              path: projectNotes,
              notes: [],
            };
          }

          // Find .md files
          const files = await readdir(projectNotes);
          const mdFiles = files
            .filter((f) => f.endsWith(".md"))
            .sort()
            .reverse()
            .slice(0, 3);

          if (mdFiles.length === 0) {
            return {
              exists: true,
              path: projectNotes,
              notes: [],
            };
          }

          // Read content of recent notes
          const notes = await Promise.all(
            mdFiles.map(async (filename) => {
              const content = await readFile(join(projectNotes, filename), "utf-8");
              return { filename, content };
            })
          );

          return {
            exists: true,
            path: projectNotes,
            notes,
          };
        }

        export const JournalPlugin: Plugin = async ({ directory }) => {
          const projectName = basename(directory);

          return {
            // Custom tool to read journal notes
            tool: {
              read_journal: tool({
                description:
                  "Read recent journal notes for the current project. Call this at session start to get context from previous sessions.",
                args: {},
                async execute(_args, _ctx) {
                  const result = await getRecentNotes(projectName);

                  if (result.notes.length === 0) {
                    const reminder = `File naming: YYYY-MM-DD-NN-topic.md (NN = sequence number for the day)
        Journal after orientation, when stuck/surprised, when something clicks, and at session end.`;

                    return `No previous session notes for ''${projectName}.
        Notes directory: ''${result.path}/
        ''${result.exists ? "" : "(Directory was just created)"}

        ''${reminder}`;
                  }

                  let output = `Previous session notes for ''${projectName}:\n\n`;
                  for (const note of result.notes) {
                    output += `--- ''${note.filename} ---\n''${note.content}\n\n`;
                  }
                  return output;
                },
              }),
            },

            // System prompt hook: inject journal notes automatically (like Claude Code's SessionStart)
            "experimental.chat.system.transform": async (_input, output) => {
              const result = await getRecentNotes(projectName);

              const journalReminder = `
    IMPORTANT: Do NOT write journal entries at session start. Only journal after doing actual work.
    Give a brief verbal summary of previous notes if relevant, then proceed with the user's task.
    Journal entries should capture learnings, decisions, and progress - not "session started" or orientation notes.`;

              if (result.notes.length === 0) {
                output.system.push(`
    ## Session Notes

    No previous session notes for ''${projectName}.
    Notes directory: ''${result.path}/
    ''${result.exists ? "" : "(Directory was just created)"}

    File naming: YYYY-MM-DD-NN-topic.md (NN = sequence number for the day)
    ''${journalReminder}
    `);
              } else {
                let notesContext = `## Previous Session Notes for ''${projectName}\n\n`;
                for (const note of result.notes) {
                  notesContext += `### ''${note.filename}\n''${note.content}\n\n`;
                }
                notesContext += journalReminder;
                output.system.push(notesContext);
              }
            },

            // Compaction hook: inject journal context and reminder
            "experimental.session.compacting": async (_input, output) => {
              const result = await getRecentNotes(projectName);

              output.context.push(`
    ## Journal System

    IMPORTANT: Before this context is compacted, ensure any important learnings, decisions, or progress have been captured in journal notes.

    Write session notes to: ''${result.path}/
    File naming: YYYY-MM-DD-NN-topic.md (NN = sequence number for the day)

    Capture: what you learned, decisions made, what is unfinished, what the next agent should know.
    This is part of the work, not extra work.
    `);

              // Include recent notes in compaction context for continuity
              if (result.notes.length > 0) {
                let notesContext = "\n## Recent Journal Notes\n\n";
                for (const note of result.notes) {
                  notesContext += `### ''${note.filename}\n''${note.content}\n\n`;
                }
                output.context.push(notesContext);
              }
            },
          };
        };
  '';

  # Write plugin content to a file in the Nix store
  journalPluginFile = pkgs.writeText "journal.ts" journalPluginContent;

  # Global instructions for OpenCode (same as CLAUDE.md, with path expansion)
  # Journal context is now auto-injected via experimental.chat.system.transform hook
  opencodeInstructions =
    builtins.replaceStrings
      [ "~/" ]
      [ "${config.home.homeDirectory}/" ]
      (builtins.readFile ../../config/llm-instructions.md);
in
{
  # OpenCode configuration (symlink is fine - opencode doesn't write to this)
  xdg.configFile."opencode/opencode.json".text =
    builtins.toJSON opencodeConfig;

  # Global instructions - AGENTS.md takes precedence over ~/.claude/CLAUDE.md
  xdg.configFile."opencode/AGENTS.md".text = opencodeInstructions;

  # Plugin must be a real file (not symlink) so bun can resolve node_modules
  # from ~/.config/opencode/node_modules relative to the plugin file
  # package.json is NOT managed by Nix - opencode needs it writable
  home.activation.opencodePlugin = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    plugin_target="${configDir}/plugins/journal.ts"
    plugin_source="${journalPluginFile}"

    $DRY_RUN_CMD mkdir -p "${configDir}/plugins"

    # Check if existing file differs from what Nix would write
    if [[ -f "$plugin_target" ]] && ! ${pkgs.diffutils}/bin/diff -q "$plugin_source" "$plugin_target" > /dev/null 2>&1; then
      echo "WARNING: opencode plugin differs from Nix-managed version"
      echo "  Target: $plugin_target"
      echo "  Source: $plugin_source"
      echo "Diff (existing vs new):"
      ${pkgs.diffutils}/bin/diff "$plugin_target" "$plugin_source" || true
      echo ""
      echo "Overwriting with Nix-managed version..."
    fi

    $DRY_RUN_CMD cp -f "$plugin_source" "$plugin_target"
    $DRY_RUN_CMD chmod 644 "$plugin_target"
  '';
}
