# Shared constants for LLM agent configuration (Claude Code, OpenCode, pi)
{ config, android-skills }:
let
  homeDir = config.home.homeDirectory;

  # Skills deployed to all LLM agents (Claude Code, OpenCode, pi).
  # Bundled skills auto-discovered from config/llm/skills/.
  # External skills point at other repos -- dangling symlink is fine if uncloned,
  # agents skip missing skills.
  skillsSrcDir = "${homeDir}/system/config/llm/skills";
  bundledSkills = map (name: {
    inherit name;
    source = "${skillsSrcDir}/${name}";
  }) (builtins.attrNames (builtins.readDir ../../config/llm/skills));
  externalSkills = [
    {
      name = "forepaw";
      source = "${homeDir}/dev/personal/forepaw/.agents/skills/forepaw";
    }
    # Android CLI skill, sourced from the upstream android/skills repo (flake
    # input, pinned in flake.lock; update via `nix flake update android-skills`).
    # Avoids `android init` / `android skills add`, which spray copies into every
    # detected agent dir and clash with these managed symlinks. Target is a store
    # path, so the symlink always resolves on every machine (no init needed).
    {
      name = "android-cli";
      source = "${android-skills}/devtools/android-cli";
    }
  ];
in
{
  notesDir = "${homeDir}/notes/llm";

  noNotesReminder = "File naming: YYYY-MM-DD-NN-topic.md (NN = sequence number for the day)\nJournal after orientation, when stuck/surprised, when something clicks, and at session end.";

  journalReminder = "IMPORTANT: Do NOT write journal entries at session start. Only journal after doing actual work.\nGive a brief verbal summary of previous notes if relevant, then proceed with the user's task.\nJournal entries should capture learnings, decisions, and progress - not \"session started\" or orientation notes.";

  compactionReminder = "Capture: what you learned, decisions made, what is unfinished, what the next agent should know.\nThis is part of the work, not extra work.";

  journalSkipMessage = "Journal reading was skipped for this session (NO_JOURNAL=1 environment variable set).\n\nThis means you do not have context from previous sessions. The user intentionally started fresh.\n\nYou should still write journal notes at the end of this session - the skip only affects reading, not writing.";

  vanillaMessage = "Running in vanilla mode (LLM_VANILLA=1). Custom instructions skipped.";

  # `@rules/<name>.md` splices config/llm/rules; agents.ts runs the same directive at agent load, where
  # a fence is skipped and a missing fragment only costs that definition. Here the match is textual.
  globalInstructions =
    let
      rulesDir = ../../config/llm/rules;
      ruleNames = builtins.filter (name: builtins.match ".*[.]md" name != null) (
        builtins.attrNames (builtins.readDir rulesDir)
      );
      directives = map (name: "@rules/${name}") ruleNames;
      fragments = map (name: builtins.readFile (rulesDir + "/${name}")) ruleNames;
      source = builtins.readFile ../../config/llm/instructions.md;
      spliced = builtins.replaceStrings directives fragments source;
      inlineDirective = builtins.filter (
        line:
        builtins.match ".*@rules/.*" line != null
        && builtins.match "[[:space:]]*@rules/[A-Za-z0-9._-]+[.]md[[:space:]]*" line == null
      ) (builtins.filter builtins.isString (builtins.split "\n" source));
      # A directive the splice did not resolve, or a fragment that quotes one.
      unexpanded =
        builtins.stringLength spliced
        != builtins.stringLength (builtins.replaceStrings [ "@rules/" ] [ "" ] spliced);
      noNewline = builtins.filter (
        name: builtins.match ".*\n" (builtins.readFile (rulesDir + "/${name}")) == null
      ) ruleNames;
    in
    if inlineDirective != [ ] then
      throw "instructions.md: a directive must be a line of its own, not shared with other text"
    else if unexpanded then
      throw "instructions.md: an @rules directive names no file in config/llm/rules, or a fragment quotes one"
    else if noNewline != [ ] then
      throw "a rule fragment must end with a newline: ${builtins.concatStringsSep ", " noNewline}"
    else
      builtins.replaceStrings [ "~/" ] [ "${homeDir}/" ] spliced;

  skills = bundledSkills ++ externalSkills;
}
