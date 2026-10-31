# MacBook Pro M4 Pro, 48 GB RAM, 1 TB SSD, nanotexture
{ lib, ... }:
{
  imports = [
    ../../profiles/personal.nix
    ../../modules/darwin
    ../../modules/darwin/omlx-gpu-limit.nix
    ../../modules/darwin/raccache.nix
  ];

  # Machine-specific settings
  networking.hostName = "procyonid-trailblazer";

  # Linux builder VM for building aarch64-linux (NixOS configs, cross-platform packages)
  # Uses Apple Virtualization framework -- lightweight NixOS VM as a Nix remote builder
  nix.linux-builder = {
    enable = true;
    config = {
      virtualisation = {
        darwin-builder = {
          diskSize = 150 * 1024; # 150 GB -- image build needs store (~28GB) + raw (~34GB) + qcow2 conversion (~30GB)
          memorySize = 8 * 1024; # 8 GB
        };
        cores = 6;
      };
      # Disable auto-GC on the builder -- the nix-builder-vm.nix profile sets
      # min-free=1GB/max-free=3GB which causes GC to race with builds,
      # deleting store paths mid-build. mkForce to override the profile.
      nix.settings = {
        min-free = lib.mkForce 0;
        max-free = lib.mkForce 0;
        auto-optimise-store = true; # hardlink identical files, saves space with GNOME+KDE overlap
      };
      # sshd's default MaxStartups throttles past 10 unauthenticated
      # connections, and a burst of parallel remote builds can exceed that: it
      # drops a share of new ones before the banner, which libssh reports as
      # `banner exchange: Broken pipe`.
      services.openssh.settings.MaxStartups = "100:30:200";
    };
  };

  # Home-manager modules
  hm.imports = [
    ../../modules/home-manager
  ];

  # SSH config for local VMs (shared key, not NixOS-specific)
  hm.programs.ssh.settings = {
    "phantom-tanuki" = {
      HostName = "phantom-tanuki.local";
      User = "avi";
      IdentityFile = "~/.ssh/vm";
      IdentitiesOnly = true;
    };
    "192.168.64.*" = {
      user = "avi";
      identityFile = "~/.ssh/vm";
      identitiesOnly = true;
    };
  };
}
