# Claude Code system-level configuration (macOS)
# Places managed-settings.json in /Library/Application Support/ClaudeCode/
{ pkgs, ... }:
let
  managedSettingsFile = import ../claude-code/settings.nix { inherit pkgs; };
in
{
  system.activationScripts.postActivation.text = ''
    echo "Setting up Claude Code managed settings..."
    mkdir -p "/Library/Application Support/ClaudeCode"
    ln -sf ${managedSettingsFile} "/Library/Application Support/ClaudeCode/managed-settings.json"
  '';
}
