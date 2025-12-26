# Upgrading Nix

## Version locations

All version pins are in `flake.nix`:

```nix
nixpkgs.url = "github:nixos/nixpkgs/nixos-XX.YY";
url = "github:lnl7/nix-darwin/nix-darwin-XX.YY";
url = "github:nix-community/home-manager/release-XX.YY";
```

## Check latest releases

Repos:
- https://github.com/NixOS/nixpkgs
- https://github.com/LnL7/nix-darwin
- https://github.com/nix-community/home-manager
- https://git.lix.systems/lix-project/nixos-module/tags

One-liners to check latest release branches:

```bash
# nixpkgs
gh api repos/NixOS/nixpkgs/branches --paginate --jq '.[].name' | grep -E '^nixos-[0-9]+\.[0-9]+$' | sort -V | tail -3

# nix-darwin
gh api repos/LnL7/nix-darwin/branches --paginate --jq '.[].name' | grep -E '^nix-darwin-[0-9]+\.[0-9]+$' | sort -V | tail -3

# home-manager
gh api repos/nix-community/home-manager/branches --paginate --jq '.[].name' | grep -E '^release-[0-9]+\.[0-9]+$' | sort -V | tail -3
```

Note: nix-darwin often lags behind nixpkgs/home-manager by one release.

Lix uses tags instead of branches. Check the tags page manually or:

```bash
# lix-module (requires curl + jq, not gh; limit=100 for pagination)
curl -s "https://git.lix.systems/api/v1/repos/lix-project/nixos-module/tags?limit=100" | jq -r '.[].name' | sort -V | tail -5
```

The flake URL format for Lix is:
```nix
url = "https://git.lix.systems/lix-project/nixos-module/archive/X.YY.Z-N.tar.gz";
```

Lix maintains multiple version lines (e.g., 2.91.x, 2.92.x, 2.93.x). Pick the latest tag in your preferred line.

## Changelogs

- nix-darwin: https://github.com/LnL7/nix-darwin/blob/master/CHANGELOG
- home-manager: https://nix-community.github.io/home-manager/release-notes.xhtml
- nixpkgs: https://nixos.org/manual/nixos/stable/release-notes.html
- lix: https://docs.lix.systems/manual/lix/nightly/release-notes/release-notes.html

## Upgrade steps

1. Read the changelogs above for breaking changes
2. Update version strings in `flake.nix`
3. Run the upgrade:
   ```bash
   mise nix-upgrade  # or: nix-upgrade (from anywhere)
   ```
   This updates flake inputs, runs garbage collection, switches the system, and updates global mise tools.
4. If something breaks, roll back:
   ```bash
   sudo darwin-rebuild switch --rollback
   ```

## About stateVersion

`stateVersion` in `home-manager/default.nix` and `nixos/core.nix` is not a version indicator. It controls default behaviors and migration paths.

Do not change it unless:
- Fresh install on a new machine
- You've read the release notes and understand the migrations

## Release schedule

NixOS releases twice a year:
- XX.05 in May
- XX.11 in November

nix-darwin and home-manager follow the same schedule but may release slightly later.
