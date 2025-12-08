#!/usr/bin/env bash
# Wrapper for darwin-rebuild switch that shows which running apps were updated
set -euo pipefail

# Capture running GUI apps before switch (requires System Events access)
echo "Checking running apps via System Events..."
running_apps=$(osascript -e 'tell application "System Events" to get name of every process whose background only is false' 2>/dev/null | tr ',' '\n' | sed 's/^ //')

# Run the switch, capture output while showing it
output=$(sudo darwin-rebuild --flake ".#${FLAKE_HOST:-$(hostname)}" switch 2>&1 | tee /dev/stderr)

# Extract upgraded casks (lines with "Installing <cask>")
upgraded=$(echo "$output" | grep -E '^Installing ' | sed 's/^Installing //' || true)

if [[ -n "$upgraded" ]]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Updated casks:"
    # shellcheck disable=SC2086 # Word splitting intentional - one cask per line
    printf "   %s\n" $upgraded

    # Check which updated apps were running
    needs_relaunch=""
    while IFS= read -r cask; do
        [[ -z "$cask" ]] && continue
        # Convert cask name to likely app name (e.g., visual-studio-code -> Visual Studio Code)
        app_pattern=${cask//-/ }
        if echo "$running_apps" | grep -iq "$app_pattern"; then
            needs_relaunch+="   $cask"$'\n'
        fi
    done <<< "$upgraded"

    if [[ -n "$needs_relaunch" ]]; then
        echo ""
        echo "🔄 Was running (may need relaunch):"
        echo -n "$needs_relaunch"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Auto-restart apps after upgrade. These have no unsaved state.
    auto_restart_apps=(
        # REQUIRED: These hook into system input events. Running stale processes
        # after .app bundle replacement causes system-wide issues (e.g. AltTab
        # causes ~5 second lockups on any modifier key press).
        "alt-tab:AltTab"
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
    )

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
            fi
        fi
    done
fi
