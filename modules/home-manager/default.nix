# Home-manager configuration
{ config, lib, pkgs, pkgs-unstable, ... }:
let
  isDarwin = pkgs.stdenvNoCC.isDarwin;

  # Custom macOS packages not in nixpkgs (only evaluated on Darwin)
  applaymidi = if isDarwin then pkgs.callPackage ../../packages/applaymidi.nix { } else null;
  trenchbroom = if isDarwin then pkgs.callPackage ../../packages/trenchbroom.nix { } else null;
  godot-4-6 =
    if isDarwin then
      pkgs.callPackage ../../packages/godot.nix
        {
          version = "4.6";
          sha256 = "0fzdhmhjf56qbl1bkvpsg200ic2dclr27xjfmcbz280452vcw5gw";
        } else null;
  librequake = pkgs.callPackage ../../packages/librequake.nix { };

  # All custom macOS .app packages — symlinks are generated automatically
  customApps = lib.optionals isDarwin [ applaymidi trenchbroom godot-4-6 ];

  # Generate home.file entries from each package's $out/Applications/ contents
  customAppLinks = lib.mergeAttrsList (map
    (pkg:
      let apps = builtins.attrNames (builtins.readDir "${pkg}/Applications");
      in lib.listToAttrs (map
        (name: {
          name = "Applications/${name}";
          value = { source = "${pkg}/Applications/${name}"; };
        })
        apps)
    )
    customApps);
in
{
  imports = [
    ./1password.nix
    ./direnv.nix
    ./git.nix
    ./llm.nix
    ./opencode.nix
    ./shell.nix
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
      nixpkgs-fmt # Nix code formatter
      nvd # Nix version diff tool
      sops # Secrets management
    ])
    ++
    # Stable packages (versions match homebrew)
    (with pkgs; [
      age # Encryption tool
      assimp # 3D model importer
      bat # Cat with syntax highlighting
      binwalk # Firmware analysis
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
      grpcurl # curl for gRPC
      gum # TUI components for scripts
      hexyl # Hex viewer
      htmlq # jq for HTML
      hyperfine # CLI benchmarking
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
      openal # 3D audio library
      optipng # PNG optimizer
      opusTools # Opus encoder/decoder
      p7zip # 7z archive support
      pigz # Parallel gzip
      plantuml # UML diagrams
      pngquant # PNG compressor
      procs # Modern ps replacement
      qpdf # PDF manipulation
      quakespasm # Quake source port
      raylib # Game programming library
      SDL2 # Game dev library
      # sfml - multimedia library, no darwin (miniaudio dep)
      # sfxr - retro sound effect generator, no darwin (miniaudio dep)
      fontforge # Font editor
      gnupg # GPG encryption
      google-cloud-sdk # GCloud CLI
      mosh # Mobile shell
      nil # Nix language server
      rsync # File transfer
      sd # Modern sed replacement
      speedtest-cli # Internet speed test
      svgo # SVG optimizer
      tealdeer # Tldr pages (simplified man)
      tig # Git TUI (history, blame)
      timidity # MIDI player
      tokei # Code statistics
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
      btop # Process viewer (prettier htop)
      coreutils # GNU core utilities
      # csvkit # CSV tools - broken in 25.11 (agate test failure)
      exiftool # Image metadata editor
      fastfetch # System info
      fswatch # File system watcher
      furnace # Multi-system chiptune tracker
      gh # GitHub CLI
      htop # Process viewer
      lazygit # Git TUI
      imagemagick # Image processing
      jq # JSON processor
      just # Command runner (Makefile alternative)
      lynx # Text-based web browser
      # mise - in Homebrew (updates frequently, avoid recompiling Rust)
      mtr # Network diagnostic tool
      mysql80 # MySQL client
      ncdu # Disk usage analyzer
      neovim # Vim fork
      nmap # Network scanner
      oxipng # PNG optimizer (multithreaded)
      pandoc # Markdown to PDF converter
      poppler # PDF rendering library
      pv # Pipe viewer
      rclone # Remote storage
      ripgrep # Search tool
      shellcheck # Shell script linter
      scc # Code complexity analyzer
      tree # Directory tree viewer
      watch # Execute a command periodically
      yazi # Terminal file manager
      yt-dlp # YouTube downloader
      yubikey-manager # YubiKey manager
    ]);

  # Dotfiles managed by Home Manager (symlinked from Nix store)
  home.file = {
    # Example: ".screenrc".source = ./dotfiles/screenrc;
    # QuakeSpasm game data
    ".quakespasm/id1".source = "${librequake}/share/quake/id1";
  } // customAppLinks;

  # Environment variables for user session
  home.sessionVariables = {
    EDITOR = "nvim";
  } // lib.optionalAttrs pkgs.stdenvNoCC.isDarwin {
    # Obsidian vault path (iCloud)
    VAULT_PATH = "${config.home.homeDirectory}/Library/Mobile Documents/iCloud~md~obsidian/Documents/raccoon-life";
  };

  # Enable Home Manager to manage itself
  programs.home-manager.enable = true;
}
