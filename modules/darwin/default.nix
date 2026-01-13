# Shared darwin (macOS) configuration for all machines
{ ... }: {
  imports = [
    ../common.nix
    ./rosetta.nix
    ./brew.nix
    ./claude-code.nix
    ./core.nix
    ./preferences.nix
  ];
}
