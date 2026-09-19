# shared

Shared modules used by multiple extensions. Not an extension itself (no `index.ts`, so pi doesn't try to load it).

Extensions import from here via `../shared/module-name`. Pi loads extensions through jiti, which resolves relative imports against the symlink path under `~/.pi/agent/extensions/`, not the realpath (plain Node's ESM loader does the opposite), so imported code must exist as a sibling there too. `pi.nix` symlinks every directory under `config/llm/pi/extensions/`, including this one.
