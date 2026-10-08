# Homebrew packages: taps, brews (CLI), casks (GUI), and Mac App Store apps
# See docs/homebrew-vs-nixpkgs.md for when to use Homebrew vs nixpkgs
#
# NOTE: Some casks are auto-restarted after upgrade to avoid stale process issues
# (e.g. AltTab causes system lockups if not restarted). See scripts/darwin-switch.sh
{ ... }:
{
  # Add Homebrew to PATH (Apple Silicon location)
  environment.systemPath = [
    "/opt/homebrew/bin"
    "/opt/homebrew/sbin"
  ];

  # Don't quit/reopen apps during cask upgrade — darwin-switch.sh handles
  # this selectively for apps with no unsaved state (menu bar utilities).
  environment.variables.HOMEBREW_NO_UPGRADE_QUIT_CASKS = "1";

  homebrew = {
    enable = true;

    onActivation = {
      # Update and upgrade are handled in darwin-switch.sh (skippable with SKIP_BREW=1)
      autoUpdate = false;
      upgrade = false;
      cleanup = "zap";
      extraFlags = [ "--verbose" ];
    };

    global = {
      brewfile = true;
    };

    taps = [
      {
        name = "android/tap";
        trusted = true;
      }
      {
        name = "anomalyco/tap";
        trusted = true;
      }
      {
        name = "f/mcptools";
        trusted = true;
      }
      {
        name = "lzhgus/tap";
        trusted = true;
      }
      {
        name = "steamre/tools";
        trusted = true;
      }
      {
        name = "stripe/stripe-cli";
        trusted = true;
      }
      {
        name = "ungive/music-presence";
        trusted = true;
      }
    ];

    # Most CLI tools are in nixpkgs - see modules/home-manager/personal/pkgs.nix
    # Only keeping packages that must stay in Homebrew
    brews = [
      "agent-browser" # Headless browser (not in nixpkgs)
      "comby" # Structural find/replace (nixpkgs broken)
      "lilypond" # Music notation (nixpkgs build fails)
      "mas" # Mac App Store CLI (macOS-specific)
      "f/mcptools/mcp" # MCP tools (custom tap)
      {
        name = "jundot/omlx/omlx"; # MLX inference server CLI (tap: brew tap jundot/omlx https://github.com/jundot/omlx). Auto-starts as brew service.
        start_service = true;
      }
      "ollama" # LLM runtime (nixpkgs build broken)
      "anomalyco/tap/opencode" # AI coding assistant
      "openfortivpn" # FortiClient VPN CLI
      "stripe/stripe-cli/stripe" # Stripe CLI (homebrew has newer version)
      "mise" # Runtime manager (updates frequently, avoid recompiling Rust)
      "pi-coding-agent" # AI coding assistant (not in nixpkgs)
      "tectonic" # Modern LaTeX engine (not in nixpkgs for darwin)
      "uv" # Python package manager (updates frequently, avoid recompiling Rust)
      "yt-dlp" # YouTube downloader (updates frequently, prebuilt bottles)
      "weasyprint" # HTML/CSS to PDF (not in nixpkgs for darwin)
    ];

    casks = [
      {
        name = "1password"; # Password manager
        greedy = true;
      }
      {
        name = "1password-cli"; # CLI for 1Password
        greedy = true;
      }
      {
        name = "affinity"; # Photo editor
        greedy = true;
      }
      {
        name = "alcove"; # Notch dynamic island utility
        greedy = true;
      }
      {
        name = "aldente"; # Battery monitor
        greedy = true;
      }
      {
        name = "android/tap/android-cli"; # Android developer CLI tools
        greedy = true;
      }
      {
        name = "another-redis-desktop-manager"; # Redis GUI
        greedy = true;
      }
      {
        name = "appcleaner"; # Uninstall apps
        greedy = true;
      }
      {
        name = "arc"; # Browser
        greedy = true;
      }
      {
        name = "breaktimer"; # Pomodoro timer
        greedy = true;
      }
      {
        name = "bruno"; # API client
        greedy = true;
      }
      {
        name = "calibre"; # E-book manager
        greedy = true;
      }
      {
        name = "capso"; # Screenshot / video capture tool
        greedy = true;
      }
      {
        name = "claude"; # AI chat
        greedy = true;
      }
      {
        name = "claude-code@latest"; # Claude Code CLI
        greedy = true;
      }
      {
        name = "clop"; # Image/video/clipboard optimizer
        greedy = true;
      }
      {
        name = "crystalfetch"; # ISO downloader
        greedy = true;
      }
      {
        name = "steamre/tools/depotdownloader"; # Steam DepotDownloader
        greedy = true;
      }
      {
        name = "devpod"; # Dev codespaces
        greedy = true;
      }
      {
        name = "Discord"; # Chat
        greedy = true;
      }
      {
        name = "firefox"; # Browser
        greedy = true;
      }
      {
        name = "nvidia-geforce-now"; # Nvidia GeForce Now
        greedy = true;
      }
      {
        name = "ghostty"; # Terminal emulator
        greedy = true;
      }
      {
        name = "github"; # GitHub Desktop
        greedy = true;
      }
      {
        name = "gitkraken"; # Git client
        greedy = true;
      }
      {
        name = "grandperspective"; # Disk usage analyzer
        greedy = true;
      }
      {
        name = "hammerspoon"; # macOS automation (Lua scripting, used by rcmd)
        greedy = true;
      }
      {
        name = "helium-browser"; # Ungoogled Chromium browser
        greedy = true;
      }
      {
        name = "heroic"; # Game launcher
        greedy = true;
      }
      {
        name = "iterm2"; # Terminal
        greedy = true;
      }
      {
        name = "keyboard-cleaner"; # Block keys when cleaning
        greedy = true;
      }
      {
        name = "lm-studio"; # Local LLM
        greedy = true;
      }
      {
        name = "macwhisper"; # OpenAI Whisper GUI
        greedy = true;
      }
      {
        name = "music-presence"; # Music presence for Discord
        greedy = true;
      }
      {
        name = "notion"; # Note taking
        greedy = true;
      }
      {
        name = "obs"; # Video recording
        greedy = true;
      }
      {
        name = "obsidian"; # Note taking
        greedy = true;
      }
      {
        name = "opencode-desktop"; # AI coding assistant
        greedy = true;
      }
      {
        name = "orbstack"; # Instead of Docker Desktop
        greedy = true;
      }
      {
        name = "orion"; # Browser
        greedy = true;
      }
      {
        name = "pallotron-yubiswitch"; # YubiKey Nano toggle
        greedy = true;
      }
      {
        name = "raycast"; # App launcher
        greedy = true;
      }
      {
        name = "spotify"; # Music player
        greedy = true;
      }
      {
        name = "stats"; # System monitor in menu bar
        greedy = true;
      }
      {
        name = "steam"; # Game launcher
        greedy = true;
      }
      {
        name = "tableplus"; # Database client
        greedy = true;
      }
      {
        name = "tailscale-app"; # Mesh VPN
        greedy = true;
      }
      {
        name = "telegram"; # Chat
        greedy = true;
      }
      {
        name = "ticktick"; # Task manager
        greedy = true;
      }
      {
        name = "utm"; # Virtual machine manager
        greedy = true;
      }
      {
        name = "visual-studio-code"; # Code editor
        greedy = true;
      }
      {
        name = "vlc"; # Media player
        greedy = true;
      }
      {
        name = "warp"; # Terminal
        greedy = true;
      }
      {
        name = "wave"; # Wave Terminal
        greedy = true;
      }
      {
        name = "wireshark-app"; # Network protocol analyzer
        greedy = true;
      }
      {
        name = "xcodes-app"; # Xcode selector
        greedy = true;
      }
      {
        name = "yubico-authenticator"; # YubiKey authenticator (also replaces discontinued yubico-yubikey-manager)
        greedy = true;
      }
      {
        name = "zed"; # IDE
        greedy = true;
      }
      {
        name = "zen"; # Firefox-based browser
        greedy = true;
      }
    ];

    masApps = {
      # Apple
      "GarageBand" = 682658836; # Music editor
      "iMovie" = 408981434; # Video editor
      "Keynote" = 409183694; # Presentation editor
      "Numbers" = 409203825; # Spreadsheet editor
      "Pages" = 409201541; # Word processor

      # Third-party
      # "BARQ!" = 1526984545; # Furry social app # Disabled as iPad apps aren't supported
      "Flighty – Live Flight Tracker" = 1358823008; # Flight tracker
      "Mona for Mastodon" = 1659154653; # Mastodon client
      "NextDNS" = 1464122853; # DNS client
      "Playlisty for Apple Music" = 1459275972; # Move music to Apple Music
      "Playlisty for Spotify" = 6478105775; # Move music to Spotify
      "rcmd" = 1596283165; # App switcher (Right Cmd + app letter)
      "Steam Link" = 1246969117; # Remote play for Steam
      "Swift Playground" = 1496833156; # Swift tutorial
      # "Swiftgram: Telegram mod client" = 6471879502; # Telegram mod client # Disabled iPad app
      "Velja" = 1607635845; # Open links in different browsers
      "Windows App" = 1295203466; # Windows remote desktop
    };
  };
}
