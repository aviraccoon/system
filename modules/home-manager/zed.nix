# Zed editor configuration
{
  config,
  lib,
  pkgs,
  pkgs-unstable,
  ...
}:
let
  zedConfigDir = "${config.xdg.configHome}/zed";

  # JSONC header (Zed supports comments in settings.json)
  settingsHeader = ''
    // Zed settings
    // Managed by Nix - edit in modules/home-manager/zed.nix
    // Docs: https://zed.dev/docs/reference/all-settings
  '';

  # Biome formatter config (reused across JS/TS/CSS/JSON languages)
  biomeFormatter = {
    formatter = {
      language_server = {
        name = "biome";
      };
    };
    code_actions_on_format = {
      "source.fixAll.biome" = true;
      "source.organizeImports.biome" = true;
    };
  };

  zedSettings = {
    git_panel = {
      group_by = "staging";
      tree_view = true;
    };
    colorize_brackets = true;
    auto_update = false;

    agent = {
      show_turn_stats = true;
      default_model = {
        provider = "lmstudio";
        model = "zai-org/glm-4.7-flash";
      };
      favorite_models = [ ];
      model_parameters = [ ];
    };

    telemetry = {
      diagnostics = false;
      metrics = false;
    };

    icon_theme = {
      mode = "dark";
      light = "Zed (Default)";
      dark = "Zed (Default)";
    };

    ui_font_size = 16;
    buffer_font_size = 15;

    theme = {
      mode = "dark";
      light = "Tokyo Night Light";
      dark = "Tokyo Night";
    };

    lsp = {
      "bash-language-server".initialization_options = {
        diagnosticsIgnorePatterns = [ "**/node_modules" ];
      };
      vtsls = {
        settings = {
          typescript.updateImportsOnFileMove.enabled = "always";
          javascript.updateImportsOnFileMove.enabled = "always";
        };
        enable_lsp_tasks = true;
      };
      biome.binary = {
        path = "biome";
        arguments = [ "lsp-proxy" ];
      };
    };

    languages = {
      JavaScript = biomeFormatter;
      TypeScript = biomeFormatter;
      TSX = biomeFormatter;
      JSON = biomeFormatter;
      JSONC = biomeFormatter;
      CSS = biomeFormatter;
      GraphQL = biomeFormatter;
      Nix = {
        formatter.external = {
          command = "nixfmt";
          arguments = [ ];
        };
      };
    };
  };

  zedSettingsFile = pkgs.writeText "zed-settings.json" (builtins.toJSON zedSettings);

in
{
  # Zed settings - copied (not symlinked) so Zed can modify if needed
  # Shows diff warning if local changes exist before overwriting
  home.activation.zedSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    settings_target="${zedConfigDir}/settings.json"
    settings_formatted=$(mktemp --suffix=.json)

    # Format JSON with biome and prepend JSONC header
    {
      printf '%s' '${settingsHeader}'
      ${pkgs-unstable.biome}/bin/biome format --stdin-file-path=settings.json < "${zedSettingsFile}"
    } > "$settings_formatted"

    $DRY_RUN_CMD mkdir -p "${zedConfigDir}"

    # Compare formatted JSON (normalize existing file for fair comparison)
    if [[ -f "$settings_target" ]]; then
      existing_formatted=$(mktemp --suffix=.json)
      # Strip comments for comparison, fall back to raw copy if biome fails
      ${pkgs.gnused}/bin/sed '/^[[:space:]]*\/\//d' "$settings_target" | \
        ${pkgs-unstable.biome}/bin/biome format --stdin-file-path=settings.json > "$existing_formatted" 2>/dev/null \
        || cp "$settings_target" "$existing_formatted"
      new_without_comments=$(${pkgs.gnused}/bin/sed '/^[[:space:]]*\/\//d' "$settings_formatted")

      if ! echo "$new_without_comments" | ${pkgs.diffutils}/bin/diff -q "$existing_formatted" - > /dev/null 2>&1; then
        echo "WARNING: Zed settings differ from Nix-managed version"
        echo "Diff (existing vs new):"
        echo "$new_without_comments" | ${pkgs.diffutils}/bin/diff "$existing_formatted" - || true
        echo ""
        echo "Overwriting with Nix-managed version..."
      fi
      rm -f "$existing_formatted"
    fi

    $DRY_RUN_CMD cp -f "$settings_formatted" "$settings_target"
    $DRY_RUN_CMD chmod 644 "$settings_target"
    rm -f "$settings_formatted"
  '';
}
