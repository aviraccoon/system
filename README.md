# Nix System Configuration

Personal Nix flake for macOS (nix-darwin) and NixOS.

## Get started (macOS)

1. **Set hostname** (must match a `darwinConfigurations` entry in `flake.nix`):
    ```bash
    my_hostname="my-macbook-pro"
    sudo scutil --set HostName $my_hostname
    sudo scutil --set LocalHostName $my_hostname
    sudo scutil --set ComputerName $my_hostname
    dscacheutil -flushcache
    ```

2. **Install Lix** ([docs](https://lix.systems/install/)):
    ```bash
    curl -sSf -L https://install.lix.systems/lix | sh -s -- install
    nix run nixpkgs#hello  # verify it works
    ```

3. **Clone this repo** to `~/system`

4. **Add machine config** if needed:
    - Create `machines/<hostname>/default.nix`
    - Add `darwinConfigurations` entry in `flake.nix`

5. **Optional:** Create `.env` to override hostname (see `.env.example`)

6. **First build:**
    ```bash
    nix run nix-darwin -- switch --flake .
    ```

## Rebuilding

After initial setup:
```bash
mise nix-switch      # from ~/system directory
nix-switch           # from anywhere (shell alias)
```

## Upgrading

Update flake inputs and rebuild:
```bash
mise nix-upgrade     # from ~/system directory
nix-upgrade          # from anywhere (shell alias)
```


### Homebrew

Managed via [`modules/darwin/brew.nix`](modules/darwin/brew.nix). See [docs/homebrew-vs-nixpkgs.md](docs/homebrew-vs-nixpkgs.md) for when to use Homebrew vs nixpkgs.

```bash
brew bundle check -v   # list missing dependencies
brew bundle cleanup    # list unexpected dependencies (--force to remove)
```

## Get started (NixOS)

1. [Download and install NixOS](https://nixos.org/download/)

2. Move generated config:
    ```bash
    sudo mv /etc/nixos ~/system && sudo chown -R $USER ~/system
    cd ~/system
    ```

3. Clone this repo, preserving hardware config:
    ```bash
    mv hardware-configuration.nix ..
    git init && git remote add origin https://github.com/aviraccoon/system && git fetch origin
    git reset --hard origin/main
    mv ../hardware-configuration.nix ./machines/$(hostname)/hardware.nix
    ```

4. Add `nixosConfigurations` entry in `flake.nix` for your hostname

5. Build:
    ```bash
    sudo nixos-rebuild switch --flake .
    ```

## Documentation

- [Upgrading Nix versions](docs/upgrading.md)
- [Homebrew vs nixpkgs](docs/homebrew-vs-nixpkgs.md)

## Resources

- [nix-darwin manual](https://daiderd.com/nix-darwin/manual/index.html)
- [Home Manager manual](https://nix-community.github.io/home-manager/index.xhtml)
- [Lix documentation](https://docs.lix.systems/manual/nightly/)

### Influences

- https://gitlab.canidae.systems/htw/system (main inspiration)
- https://github.com/kclejeune/system
- https://github.com/i077/system
- https://xyno.space/post/nix-darwin-introduction
- https://nixcademy.com/2024/01/15/nix-on-macos/
