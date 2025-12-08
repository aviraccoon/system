# Homebrew packages: taps, brews (CLI), casks (GUI), and Mac App Store apps
# See docs/homebrew-vs-nixpkgs.md for when to use Homebrew vs nixpkgs
#
# NOTE: Some casks are auto-restarted after upgrade to avoid stale process issues
# (e.g. AltTab causes system lockups if not restarted). See scripts/darwin-switch.sh
{ ... }: {
  # Add Homebrew to PATH (Apple Silicon location)
  environment.systemPath = [ "/opt/homebrew/bin" "/opt/homebrew/sbin" ];

  homebrew = {
    enable = true;

    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "zap";
      extraFlags = [ "--verbose" ];
    };

    global = {
      brewfile = true;
    };

    taps = [
      "f/mcptools"
      "stripe/stripe-cli"
      "ungive/music-presence"
    ];

    # Most CLI tools are in nixpkgs - see modules/home-manager/personal/pkgs.nix
    # Only keeping packages that must stay in Homebrew
    brews = [
      "mas" # Mac App Store CLI (macOS-specific)
      "f/mcptools/mcp" # MCP tools (custom tap)
      "ollama" # LLM runtime (nixpkgs build broken)
      "stripe/stripe-cli/stripe" # Stripe CLI (homebrew has newer version)
      "uv" # Python package manager (updates frequently, avoid recompiling Rust)
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
        name = "alt-tab"; # Window switcher
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
        name = "claude"; # AI chat
        greedy = true;
      }
      {
        name = "claude-code"; # Claude Code CLI
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
        name = "cursor"; # IDE
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
        name = "jordanbaird-ice@beta"; # Menu bar hiding (macOS 26 Tahoe support)
        greedy = true;
      }
      {
        name = "keyboard-cleaner"; # Block keys when cleaning
        greedy = true;
      }
      {
        name = "linear-linear"; # Issue tracker
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
        name = "shottr"; # Screenshot tool
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
        name = "wireshark-app"; # Network protocol analyzer
        greedy = true;
      }
      {
        name = "xcodes-app"; # Xcode selector
        greedy = true;
      }
      {
        name = "yubico-authenticator"; # YubiKey authenticator
        greedy = true;
      }
      {
        name = "yubico-yubikey-manager"; # YubiKey manager
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
      "Mona for Mastodon" = 1659154653; # Mastodon client
      "NextDNS" = 1464122853; # DNS client
      "Playlisty for Apple Music" = 1459275972; # Move music to Apple Music
      "Playlisty for Spotify" = 6478105775; # Move music to Spotify
      "rcmd" = 1596283165; # App switcher (Right Cmd + app letter)
      "Steam Link" = 1246969117; # Remote play for Steam
      "Swift Playground" = 1496833156; # Swift tutorial
      # "Swiftgram: Telegram mod client" = 6471879502; # Telegram mod client # Disabled iPad app
      "Velja" = 1607635845; # Open links in different browsers
    };
  };
}
