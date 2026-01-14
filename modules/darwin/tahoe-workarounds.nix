# Workarounds for macOS 26 Tahoe bugs
# See: https://github.com/electron/electron/issues/48311
# See: https://github.com/zed-industries/zed/issues/33182
{ ... }: {
  # GPU lag: WindowServer shadow bug causes 80%+ GPU usage with Electron apps
  # CHROME_HEADLESS=1 disables window shadows for Electron apps
  # Fixed in Electron 37.6.0+ but keeping as fallback for older apps
  launchd.user.envVariables.CHROME_HEADLESS = "1";

  # Input lag: AutoFillHeuristicController causes progressive CPU lag
  # Apps become unusable over time, requiring restart
  # Apple is tracking this internally
  system.activationScripts.tahoeWorkarounds = {
    enable = true;
    text = ''
      defaults write -g NSAutoFillHeuristicControllerEnabled -bool false
    '';
  };
}
