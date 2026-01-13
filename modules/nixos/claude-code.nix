# Claude Code system-level configuration (NixOS)
# Places managed-settings.json in /etc/claude-code/
{ pkgs, ... }:
let
  managedSettingsFile = import ../claude-code/settings.nix { inherit pkgs; };
in
{
  environment.etc."claude-code/managed-settings.json".source = managedSettingsFile;
}
