# Homebrew vs nixpkgs

## Where packages are defined

- **nixpkgs**: `modules/home-manager/default.nix` - CLI tools managed by Nix
- **Homebrew brews**: `modules/darwin/brew.nix` - CLI tools that must stay in Homebrew
- **Homebrew casks**: `modules/darwin/brew.nix` - GUI apps (managed by nix-darwin)
- **Mac App Store**: `modules/darwin/brew.nix` - Apps installed via `mas`

## When to use which

Prefer nixpkgs when possible:
- Reproducible across machines
- Atomic rollbacks
- Works on macOS and Linux

Keep in Homebrew:
- macOS-specific tools (`mas`)
- Custom taps not in nixpkgs
- Casks (GUI apps) - nix-darwin manages these via `homebrew.casks`

## Check nixpkgs darwin compatibility

Web: https://search.nixos.org/packages (check "Platforms" section for aarch64-darwin)

CLI:
```bash
# Check version and Apple Silicon support
nix eval --json nixpkgs#<package> --apply 'pkg: { version = pkg.version; darwin = builtins.elem "aarch64-darwin" pkg.meta.platforms; }'
# Output: {"darwin":true,"version":"1.7.1"}
```

## Compare versions

Use the `nixpkgs-check-version` shell function (defined in shell.nix):

```bash
nixpkgs-check-version neovim ripgrep jq
```

Output:
```
neovim:
  stable:   {"darwin":true,"version":"0.10.2"}
  unstable: {"darwin":true,"version":"0.11.5"}
  homebrew: 0.11.5
```

Homebrew and nixpkgs-unstable usually have similar (latest) versions. nixpkgs stable lags behind.

## Package name differences

Some packages have different names in nixpkgs:

| Homebrew | nixpkgs |
|----------|---------|
| `ykman` | `yubikey-manager` |
| `poppler` | `poppler_utils` |
| `mysql-client@8.0` | `mysql80` |
| `stripe` | `stripe-cli` |

Use `nix search nixpkgs <name>` to find the correct package name.

## Packages that must stay in Homebrew

- `mas` - Mac App Store CLI, macOS-specific
- Custom taps not available in nixpkgs
- Casks (GUI apps) - managed via `homebrew.casks` in brew.nix

## Packages better in Homebrew

Some packages work in nixpkgs but are better kept in Homebrew:

- **Fast-moving compiled packages** (e.g., `mise`, `uv`) - Rust/Go packages that update frequently will recompile on every update. Homebrew provides prebuilt bottles.
- **Broken builds** (e.g., `ollama`) - Sometimes nixpkgs-unstable has build failures. Check Hydra or try building before committing.

To check update frequency:
```bash
curl -s "https://api.github.com/repos/NixOS/nixpkgs/commits?path=pkgs/by-name/uv/uv/package.nix&per_page=10" | jq -r '.[].commit.committer.date[:10]'
```
