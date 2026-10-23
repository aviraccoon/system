# macOS system preferences: dock, Finder, menu bar, security
{ ... }:
{
  # Enable Touch ID for sudo
  security.pam.services.sudo_local.touchIdAuth = true;

  system.defaults = {
    dock = {
      autohide = true;
      mru-spaces = false;

      wvous-bl-corner = 1; # Disabled
      wvous-br-corner = 1; # Disabled
      wvous-tl-corner = 1; # Disabled
      wvous-tr-corner = 1; # Disabled

      persistent-apps = [
        "/System/Applications/Apps.app"
        "/Applications/Orion.app"
        "/Applications/Ghostty.app"
        "/Applications/Zed.app"
        "/Applications/Visual Studio Code.app"
        "/Applications/Obsidian.app"
        "/System/Applications/Calendar.app"
        "/Applications/Telegram.app"
        "/Applications/Discord.app"
        "/System/Applications/Music.app"
        "/System/Applications/System Settings.app"
      ];
    };

    finder = {
      AppleShowAllExtensions = true;
      FXPreferredViewStyle = "clmv"; # Column view
      ShowPathbar = true;
      ShowStatusBar = true;
    };

    menuExtraClock = {
      Show24Hour = true;
      ShowDate = 0;
      ShowDayOfWeek = true;
      ShowSeconds = true;
    };

    screensaver = {
      askForPassword = true;
    };
  };
}
