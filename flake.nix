{
  # NOTE: Some modules use mkOutOfStoreSymlink (e.g., 1Password socket).
  # This requires --impure flag for evaluation, or the symlink target
  # must exist at build time. On a fresh system, run 1Password first.
  description = "nix system flake";

  inputs = {
    # Packages
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.11";
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    # Systems
    nixos-hardware.url = "github:nixos/nixos-hardware";
    darwin = {
      # Keep version in sync with nixpkgs
      url = "github:lnl7/nix-darwin/nix-darwin-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager = {
      # See https://nix-community.github.io/home-manager/release-notes.xhtml
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    lix-module = {
      # See https://docs.lix.systems/manual/lix/nightly/release-notes/release-notes.html
      url = "https://git.lix.systems/lix-project/nixos-module/archive/2.93.3-2.tar.gz";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self
    , nixpkgs
    , nixpkgs-unstable
    , lix-module
    , darwin
    , home-manager
    , ...
    } @ inputs:
    let
      supportedSystems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;

      # Unstable packages for when stable is too outdated
      pkgs-unstable-for = system: import nixpkgs-unstable {
        inherit system;
        config.allowUnfree = true;
      };

      # Helper to create darwin configurations with common settings
      mkDarwinHost = { machine, system ? "aarch64-darwin" }:
        let pkgs-unstable = pkgs-unstable-for system; in
        darwin.lib.darwinSystem {
          inherit system;
          specialArgs = { inherit inputs self pkgs-unstable; };
          modules = [
            machine
            home-manager.darwinModules.home-manager
            ({ config, ... }: {
              home-manager.useUserPackages = true;
              home-manager.useGlobalPkgs = true;
              home-manager.backupFileExtension = "backup";
              home-manager.extraSpecialArgs = {
                inherit pkgs-unstable;
                inherit (config) systemFlakeDir;
              };
            })
            lix-module.nixosModules.default
            inputs.sops-nix.darwinModules.sops
          ];
        };
    in
    {
      # nix fmt
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixpkgs-fmt);

      darwinConfigurations."procyonid-trailblazer" = mkDarwinHost {
        machine = ./machines/procyonid-trailblazer;
      };
    };
}
