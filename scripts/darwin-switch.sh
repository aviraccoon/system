#!/usr/bin/env bash
# Wrapper for darwin-rebuild switch that shows which running apps were updated
set -euo pipefail

# Capture current system for diff after switch
old_system=$(readlink /run/current-system)

# Capture running GUI apps before switch (requires System Events access)
echo "Checking running apps via System Events..."
running_apps=$(osascript -e 'tell application "System Events" to get name of every process whose background only is false' 2>/dev/null | tr ',' '\n' | sed 's/^ //')

# Run the switch, capture output while showing it
output=$(sudo darwin-rebuild --flake ".#${FLAKE_HOST:-$(hostname)}" switch 2>&1 | tee /dev/stderr)

# Extract upgraded casks (lines with "Upgrading <cask> cask. It is installed")
upgraded=$(echo "$output" | grep -E '^Upgrading .* cask\. It is installed' | sed 's/^Upgrading //' | sed 's/ cask\. It is installed.*//' || true)

if [[ -n "$upgraded" ]]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Updated casks:"
    # shellcheck disable=SC2086 # Word splitting intentional - one cask per line
    printf "   %s\n" $upgraded

    # Auto-restart apps after upgrade. These have no unsaved state.
    # Format: "cask-name:ProcessName"
    # To find process name: pgrep -l <pattern> while app is running
    auto_restart_apps=(
        # REQUIRED: These hook into system input events. Running stale processes
        # after .app bundle replacement causes system-wide issues.
        "hammerspoon:Hammerspoon"

        # OPTIONAL: Menu bar utilities - nice to restart for consistency
        "alcove:Alcove"
        "aldente:AlDente"
        "clop:Clop"
        "jordanbaird-ice:Ice"
        "music-presence:Music Presence"
        "raycast:Raycast"
        "shottr:Shottr"
        "stats:Stats"
        "steelseries-gg:SteelSeriesGG"
        "pallotron-yubiswitch:yubiswitch"
        "yubico-authenticator:Yubico Authenticator"
        "yubico-yubikey-manager:ykman-gui"
    )

    restarted_casks=""
    for entry in "${auto_restart_apps[@]}"; do
        cask="${entry%%:*}"
        app="${entry##*:}"
        if echo "$upgraded" | grep -q "$cask"; then
            if pgrep -x "$app" > /dev/null; then
                echo ""
                echo "🔄 Restarting $app..."
                killall "$app" 2>/dev/null
                sleep 1
                open -a "$app"
                echo "✓ $app restarted"
                restarted_casks+="$cask"$'\n'
            fi
        fi
    done

    # Check which running apps need manual restart (updated but not auto-restarted)
    needs_manual=""
    while IFS= read -r cask; do
        [[ -z "$cask" ]] && continue
        # Skip if this cask was auto-restarted
        if echo "$restarted_casks" | grep -q "^${cask}$"; then
            continue
        fi
        # Find the .app bundle and check if its executable is running
        pattern="${cask//-/ }"
        app_path=$(find /Applications -maxdepth 1 -iname "*$pattern*.app" 2>/dev/null | head -1)
        # Fallback: try last word (e.g., jordanbaird-ice -> ice)
        if [[ -z "$app_path" ]]; then
            last_word="${cask##*-}"
            app_path=$(find /Applications -maxdepth 1 -iname "*$last_word*.app" 2>/dev/null | head -1)
        fi
        if [[ -n "$app_path" ]]; then
            executable=$(defaults read "$app_path/Contents/Info" CFBundleExecutable 2>/dev/null)
            # Match full path since macOS shows full path in COMM for some apps
            if [[ -n "$executable" ]] && ps -eo comm | grep -q "$app_path/Contents/MacOS/$executable"; then
                needs_manual+="   $cask"$'\n'
            fi
        fi
    done <<< "$upgraded"

    if [[ -n "$needs_manual" ]]; then
        echo ""
        echo "⚠️  Needs manual restart:"
        echo -n "$needs_manual"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi

# Show what changed in Nix packages
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📦 Nix package changes:"
nvd --color always diff "$old_system" /run/current-system
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
