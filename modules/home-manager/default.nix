# Home-manager configuration
{
  config,
  lib,
  pkgs,
  pkgs-unstable,
  ...
}:
let
  isDarwin = pkgs.stdenvNoCC.isDarwin;

  # Custom macOS packages not in nixpkgs (only evaluated on Darwin)
  applaymidi = if isDarwin then pkgs.callPackage ../../packages/applaymidi.nix { } else null;
  trenchbroom = if isDarwin then pkgs.callPackage ../../packages/trenchbroom.nix { } else null;
  godot-4-6 =
    if isDarwin then
      pkgs.callPackage ../../packages/godot.nix {
        version = "4.6.2";
        sha256 = "01q8nlkrghbcpv971s309ryynwpbi2w0ailpwjq9vidmwij2lsv6";
      }
    else
      null;
  librequake = pkgs.callPackage ../../packages/librequake.nix { };
  ericw-tools = if isDarwin then pkgs.callPackage ../../packages/ericw-tools.nix { } else null;
  vkquake = if isDarwin then pkgs.callPackage ../../packages/vkquake.nix { } else null;
  forepaw = if isDarwin then pkgs.callPackage ../../packages/forepaw.nix { } else null;

  # GNU tool symlinks (Darwin): expose GNU versions as g-prefixed names alongside
  # BSD defaults at /usr/bin/. On Linux these utilities are already GNU by default.
  # Symlink (not shell wrapper) so there's no fork overhead per invocation.
  gnuTool =
    name: pkg:
    pkgs.runCommand "g${name}" { } ''
      mkdir -p $out/bin
      ln -s ${pkg}/bin/${name} $out/bin/g${name}
    '';
  gnuWrappers = lib.optionals isDarwin [
    (gnuTool "sed" pkgs.gnused)
    (gnuTool "awk" pkgs.gawk)
    (gnuTool "grep" pkgs.gnugrep)
    (gnuTool "find" pkgs.findutils)
    (gnuTool "date" pkgs.coreutils)
  ];

  # GitHub CLI wrapper: authenticates via `op read` (1Password, full token in
  # memory only), falls back to sops-nix read-only token.
  gh-wrapper = pkgs.writeShellScriptBin "gh" ''
    #!/usr/bin/env bash
    if command -v op >/dev/null 2>&1 && [[ -r /run/secrets/github_op_reference ]]; then
      ref="$(< /run/secrets/github_op_reference)"
      account=""
      if [[ -r /run/secrets/github_op_account ]]; then
        account="$(< /run/secrets/github_op_account)"
      fi
      token="$(op read "''${ref}" ''${account:+--account "''${account}"} 2>/dev/null)" && export GH_TOKEN="$token"
    fi
    if [[ -z "$GH_TOKEN" ]] && [[ -r /run/secrets/github_access_token ]]; then
      export GH_TOKEN="$(< /run/secrets/github_access_token)"
    fi
    exec ${pkgs.gh}/bin/gh "$@"
  '';

  # All custom macOS .app packages — symlinks are generated automatically
  customApps = lib.optionals isDarwin [
    applaymidi
    trenchbroom
    godot-4-6
    vkquake
  ];

  # Generate home.file entries from each package's $out/Applications/ contents
  customAppLinks = lib.mergeAttrsList (
    map (
      pkg:
      let
        apps = builtins.attrNames (builtins.readDir "${pkg}/Applications");
      in
      lib.listToAttrs (
        map (name: {
          name = "Applications/${name}";
          value = {
            source = "${pkg}/Applications/${name}";
          };
        }) apps
      )
    ) customApps
  );
in
{
  imports = [
    ./1password.nix
    ./direnv.nix
    ./fonts.nix
    ./git.nix
    ./iterm2.nix
    ./lazygit.nix
    ./llm.nix
    ./pi.nix
    ./shell.nix
    ./tmux.nix
    ./zed.nix
  ];

  # WARNING: Do not change without reading Home Manager release notes first.
  # This helps avoid breakage when HM introduces backwards incompatible changes.
  # https://nix-community.github.io/home-manager/release-notes.xhtml
  home.stateVersion = "25.11";

  # Prefer Nix packages here over Homebrew (brew.nix) when possible
  # See docs/homebrew-vs-nixpkgs.md for details and version checking
  home.packages =
    # Stable packages
    (with pkgs; [
      devenv # Development environments
      nixfmt # Official Nix formatter
      nvd # Nix version diff tool
      rustup # Rust toolchain manager
      go # Go compiler
      nodejs # Node.js runtime
      sops # Secrets management
      typescript # TypeScript compiler
      typescript-language-server # TypeScript/JS language server
    ])
    ++
      # Stable packages (versions match homebrew)
      (with pkgs; [
        age # Encryption tool
        aria2 # Multi-connection downloader (faster than curl for large files)
        assimp # 3D model importer
        bat # Cat with syntax highlighting
        binwalk # Firmware analysis
        check-jsonschema # JSON schema validator
        chromaprint # Audio fingerprinting
        cmus # Terminal music player
        csvlens # CSV viewer TUI
        curl # HTTP client
        dasel # Query JSON, YAML, TOML, XML
        delta # Git diff viewer
        difftastic # Structural diff (syntax-aware)
        dive # Docker image layer explorer
        doggo # Modern dig replacement
        duf # Disk usage (better df)
        dust # Disk usage (better du)
        entr # Run commands on file changes
        eza # Modern ls replacement
        fd # Modern find replacement
        ffmpeg # Video processing
        flac # FLAC encoder/decoder
        fluidsynth # SoundFont synthesizer
        fx # Interactive JSON viewer
        fzf # Fuzzy finder
        glfw # OpenGL windowing
        git-absorb # Auto-fixup commits
        gifsicle # GIF optimizer
        glow # Markdown viewer
        graphviz # DOT diagrams to images
        gron # Make JSON greppable
        grpcurl # curl for gRPC
        gum # TUI components for scripts
        hexyl # Hex viewer
        htmlq # jq for HTML
        hyperfine # CLI benchmarking
        jo # JSON object creator (complement to jq)
        jless # Interactive JSON viewer
        jpegoptim # JPEG optimizer
        lame # MP3 encoder
        libavif # AVIF encoder/decoder
        libheif # HEIF/HEIC encoder/decoder
        libjxl # JPEG XL encoder/decoder
        libwebp # WebP tools (cwebp, dwebp)
        # lilypond - music notation, build fails on darwin
        love # LÖVE 2D game framework
        mediainfo # Media file metadata
        mermaid-cli # Diagrams as code
        miller # CSV/JSON swiss-army knife
        mkcert # Certificate generator
        openal # 3D audio library
        optipng # PNG optimizer
        opus-tools # Opus encoder/decoder
        p7zip # 7z archive support
        pigz # Parallel gzip
        plantuml # UML diagrams
        pngquant # PNG compressor
        procs # Modern ps replacement
        qpdf # PDF manipulation
        # quakespasm - nixpkgs SDL2 is sdl2-compat (SDL3 shim), doesn't work. Using vkQuake .app instead.
        raylib # Game programming library
        SDL2 # Game dev library
        # sfml - multimedia library, no darwin (miniaudio dep)
        # sfxr - retro sound effect generator, no darwin (miniaudio dep)
        fontforge # Font editor
        gnupg # GPG encryption
        google-cloud-sdk # GCloud CLI
        mosh # Mobile shell
        gopls # Go language server
        nil # Nix language server
        nixd # Nix language server (full-featured)
        bash-language-server # Bash/shell language server
        yaml-language-server # YAML language server
        pyright # Python language server
        slint-lsp # Slint UI language server
        taplo # TOML language server
        marksman # Markdown language server
        lemminx # XML language server
        roslyn-ls # C# language server (needs dotnet-sdk to locate)
        dotnet-sdk # .NET SDK (C# language server dependency)
        vscode-langservers-extracted # CSS/SCSS/HTML/JSON language servers
        jdt-language-server # Java language server
        zls # Zig language server
        lua-language-server # Lua language server
        dockerfile-language-server # Dockerfile language server
        powershell-editor-services # PowerShell language server
        rsync # File transfer
        sd # Modern sed replacement
        speedtest-cli # Internet speed test
        svgo # SVG optimizer
        tealdeer # Tldr pages (simplified man)
        tig # Git TUI (history, blame)
        timidity # MIDI player
        tmux # Terminal multiplexer
        tokei # Code statistics
        tree-sitter # Parser generator / AST tool
        vhs # Record terminal to GIF
        watchexec # Run commands on file changes
        wget # Downloader
        woff2 # WOFF2 font converter
        xh # HTTP client (httpie in Rust)
        yq-go # YAML processor (jq for YAML)
        zstd # Fast compression
      ])
    ++
      # Unstable packages (stable too outdated)
      (with pkgs-unstable; [
        abcmidi # ABC notation to MIDI
        act # GitHub Actions local runner
        ast-grep # Structural code search
        biome # JS/TS/JSON linter and formatter
        bun # JavaScript runtime and toolkit
        btop # Process viewer (prettier htop)
        coreutils # GNU core utilities
        # csvkit # CSV tools - broken in 25.11 (agate test failure)
        exiftool # Image metadata editor
        fastfetch # System info
        fswatch # File system watcher
        furnace # Multi-system chiptune tracker
        gh-wrapper # GitHub CLI (wraps op plugin run with sops fallback)
        htop # Process viewer
        # lazygit - managed by programs.lazygit in lazygit.nix
        imagemagick # Image processing
        jq # JSON processor
        just # Command runner (Makefile alternative)
        lynx # Text-based web browser
        # mise - in Homebrew (updates frequently, avoid recompiling Rust)
        mtr # Network diagnostic tool
        ncdu # Disk usage analyzer
        neovim # Vim fork
        nmap # Network scanner
        oxfmt # JavaScript/TypeScript formatter
        oxipng # PNG optimizer (multithreaded)
        oxlint # JavaScript/TypeScript linter
        pandoc # Markdown to PDF converter
        poppler-utils # PDF CLI tools (pdftotext, pdfinfo, pdftoppm)
        catdoc # Extract text from .doc files
        djvulibre # DjVu document tools
        visidata # TUI spreadsheet/data viewer (xlsx, csv, json, sqlite)
        xlsx2csv # Convert xlsx to csv
        sc-im # Vim-like TUI spreadsheet editor
        pv # Pipe viewer
        rclone # Remote storage
        ripgrep # Search tool
        shellcheck # Shell script linter
        scc # Code complexity analyzer
        tirith # Pre-execution command security (homograph URLs, pipe-to-shell, exfil, known-bad packages)
        tree # Directory tree viewer
        typst # Modern typesetting system (Markdown/LaTeX alternative for PDF)
        watch # Execute a command periodically
        yazi # Terminal file manager
        # yt-dlp - in Homebrew (updates frequently, prebuilt bottles)
        yubikey-manager # YubiKey manager
      ])
    ++
      # Custom packages not in nixpkgs
      lib.optionals isDarwin [
        ericw-tools # Quake map compiling (qbsp, vis, light)
        forepaw # Desktop automation CLI for AI agents
      ]
    ++ gnuWrappers;

  # Dotfiles managed by Home Manager (symlinked from Nix store)
  home.file = {
    # Example: ".screenrc".source = ./dotfiles/screenrc;
    # QuakeSpasm game data
    ".quakespasm/id1".source = "${librequake}/share/quake/id1";
    # forepaw dev build -- symlink so agents and shells both find it.
    # forepaw-stable (Nix package) is the release binary fallback.
    ".local/bin/forepaw".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/dev/personal/forepaw/.build/release/forepaw";

    # harvest CLI (time tracking; bun-run TS source)
    ".local/bin/harvest".source =
      config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/system/config/cli/harvest/harvest.ts";

    # npm: disable postinstall/preinstall scripts by default.
    # Prevents malicious or noisy lifecycle scripts from running during `npm install`.
    # Packages that genuinely need their scripts (e.g. Prisma, native modules) should
    # be installed with: npm install --ignore-scripts=false <pkg>
    ".npmrc".text = "ignore-scripts=true\n";
  }
  // customAppLinks;

  # Create writable directories needed by managed tools
  home.activation.createQuakeSpasmDirs = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    mkdir -p "$HOME/.quakespasm/custom/maps"
  '';

  home.sessionPath = [ "${config.home.homeDirectory}/.local/bin" ];

  # Environment variables for user session
  home.sessionVariables = {
    EDITOR = "nvim";
  }
  // lib.optionalAttrs pkgs.stdenvNoCC.isDarwin {
    # Obsidian vault path (iCloud)
    VAULT_PATH = "${config.home.homeDirectory}/Library/Mobile Documents/iCloud~md~obsidian/Documents/raccoon-life";
  };

  # Enable Home Manager to manage itself
  programs.home-manager.enable = true;
}
