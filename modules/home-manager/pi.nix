# Pi coding agent configuration
{
  config,
  lib,
  pkgs,
  android-skills,
  ...
}:
let
  piConfigDir = "${config.home.homeDirectory}/.pi/agent";

  # Source directory for pi extensions
  piExtSrcDir = "${config.home.homeDirectory}/system/config/llm/pi/extensions";

  # Canonical web-search provider clients live in the MCP tree (the multi-host
  # survivor) and are imported by the pi web-search extension via a bridge
  # symlink (web-search-core) — same sibling-import pattern as shared/. The repo
  # symlink at config/llm/pi/extensions/web-search-core covers tsc; this var
  # backs the runtime symlink created in the activation below.
  webSearchCoreSrc = "${config.home.homeDirectory}/system/config/llm/mcp/web-search/providers";

  # Auto-discover extension directories from source.
  # Dirs with index.ts are extensions; dirs without are shared modules.
  # All are symlinked live — edit + /reload works without nix-switch.
  allExtDirs = builtins.filter (
    name: (builtins.readDir ../../config/llm/pi/extensions).${name} == "directory"
  ) (builtins.attrNames (builtins.readDir ../../config/llm/pi/extensions));

  # Shared skills list (bundled + external like forepaw)
  shared = import ./llm-shared.nix { inherit config android-skills; };
  inherit (shared) skills;

  # Managed keys for auth.json; the piAuth activation deploys it as a real file
  # instead of home.file (see home.activation.piAuth).
  piAuthFile = pkgs.writeText "pi-auth.json" (
    builtins.toJSON {
      # OpenRouter with ZDR (Zero Data Retention) enforced in OpenRouter settings
      openrouter = {
        type = "api_key";
        key = "!llm-key openrouter-main";
      };
      # Z.ai Coding Plan
      zai = {
        type = "api_key";
        key = "!llm-key zai";
      };
    }
  );

  piAuth = pkgs.writeShellApplication {
    name = "pi-auth";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.jq
    ];
    text = builtins.readFile ./pi-auth.sh;
  };

  # The merge runs only during a switch, against the real file, so a mistake in
  # it is found by the person switching. This drives the same script against
  # throwaway files, and the activation runs this checked artifact rather than
  # the plain wrapper, so `nix build` cannot skip the check.
  piAuthChecked =
    pkgs.runCommand "pi-auth-checked"
      {
        nativeBuildInputs = [
          pkgs.coreutils
          pkgs.jq
        ];
      }
      ''
        mkdir -p "$out/bin"
        script=${piAuth}/bin/pi-auth
        managed=${piAuthFile}
        target="$PWD/sub/auth.json"

        # No file yet, and no directory to hold it: the deployed file lands with
        # pi's mode, and every provider in it is a key reference, never a key.
        "$script" "$managed" "$target"
        jq -e '(length > 0) and all(.[]; .type == "api_key" and (.key | startswith("!llm-key ")))' "$target" >/dev/null
        [ "$(stat -c %a "$target")" = 600 ]

        # A provider added with pi's /login survives whole, and every managed
        # provider holds its managed value over the stale copy.
        jq '. as $t | {"example-oauth": {"type":"oauth","access":"a","refresh":"r","expires":0}} + ($t | map_values(.key = "stale"))' \
          "$target" >"$PWD/next.json"
        mv -f "$PWD/next.json" "$target"
        "$script" "$managed" "$target"
        jq -e --slurpfile m "$managed" '($m[0] | length) > 0 and ."example-oauth".refresh == "r" and (. as $t | $m[0] | to_entries | all(.[]; $t[.key] == .value))' "$target" >/dev/null

        # A store-style symlink is replaced by a real file; the linked file is
        # left intact, and the providers it held do not reach the new one.
        jq '. + {"link-only": {"type":"api_key","key":"x"}}' "$target" >"$PWD/linked.json"
        ln -sf "$PWD/linked.json" "$target"
        "$script" "$managed" "$target"
        jq -e '(has("link-only") | not) and all(.[]; .type == "api_key")' "$target" >/dev/null
        jq -e 'has("link-only")' "$PWD/linked.json" >/dev/null

        # Invalid JSON fails the switch, says why, and is left alone.
        printf 'not json\n' >"$target"
        if "$script" "$managed" "$target" 2>"$PWD/err.txt"; then
          echo 'accepted invalid JSON'
          exit 1
        fi
        [ "$(cat "$target")" = 'not json' ]
        [ -s "$PWD/err.txt" ]
        # The abandoned staged file holds credentials; it must not be readable.
        [ ! -e "$target.new" ] || [ "$(stat -c %a "$target.new")" = 600 ]

        # The copy under $out/bin, the path the activation runs.
        cp "$script" "$out/bin/"
        "$out/bin/pi-auth" "$managed" "$PWD/copied.json"
        jq -e 'all(.[]; .type == "api_key")' "$PWD/copied.json" >/dev/null
      '';

in
{
  home.file = lib.mkMerge [
    {
      # Pi-specific agent instructions (global instructions injected separately via journal extension)
      ".pi/agent/AGENTS.md".text = ''
        # Pi Agent Instructions

        ## File Editing

        - Use patch (targeted replacement) for existing files, not write (full rewrite). Rewrites lose subtle details and make reviews harder.
        - Only use write for genuinely new files or when the entire file content is changing.
      '';

      # Custom model providers (LM Studio local models, etc.)
      # Pi reloads this on /model -- no restart needed.
      # Models defined here are available as both main models (in pi's model picker)
      # and sidecar models (via roles.json refs like "provider/model-id").
      ".pi/agent/models.json".text = builtins.toJSON {
        providers = {
          # Category: Local providers

          lmstudio = {
            tags = [ "local" ];
            baseUrl = "http://127.0.0.1:1234/v1";
            api = "openai-completions";
            apiKey = "lm-studio";
            models = [
              # byteshape's Qwen has a better perf than Unsloth's
              # See https://byteshape.com/blogs/Qwen3.6-35B-A3B/
              {
                id = "byteshape/qwen3.6-35b-a3b";
                name = "Byteshape Qwen3.6 35B A3B (local)";
                reasoning = true;
                input = [
                  "text"
                  "image"
                ];
                contextWindow = 262144;
                maxTokens = 16384;
                cost = {
                  input = 0;
                  output = 0;
                  cacheRead = 0;
                  cacheWrite = 0;
                };
                compat = {
                  supportsDeveloperRole = false;
                  supportsReasoningEffort = false;
                  thinkingFormat = "qwen-chat-template";
                };
              }
            ];
          };
          # oMLX: MLX inference server with tiered KV cache, continuous batching.
          # Shares ~/.lmstudio/models/ with LM Studio. Auto-starts via brew service.
          # requestParams per-role in roles.json override oMLX global sampling defaults.
          # Global Qwen defaults: temp=0.6, top_p=0.95, top_k=20 (precise coding).
          # Sidecar roles override to: temp=0.7, top_p=0.8, top_k=20 (concise non-thinking).
          omlx = {
            tags = [ "local" ];
            baseUrl = "http://127.0.0.1:8124/v1";
            api = "openai-completions";
            apiKey = "not-needed";
            models = [
              {
                id = "Qwen3.6-35B-A3B-UD-MLX-4bit";
                name = "Qwen 3.6 35B A3B UD (oMLX)";
                reasoning = true;
                input = [
                  "text"
                  "image"
                ];
                contextWindow = 262144;
                maxTokens = 16384;
                cost = {
                  input = 0;
                  output = 0;
                  cacheRead = 0;
                  cacheWrite = 0;
                };
              }
              {
                id = "Qwen3.8-27B-4bit";
                name = "Qwen 3.8 27B 4-bit (oMLX)";
                reasoning = true;
                input = [
                  "text"
                  "image"
                ];
                contextWindow = 262144;
                maxTokens = 16384;
                cost = {
                  input = 0;
                  output = 0;
                  cacheRead = 0;
                  cacheWrite = 0;
                };
              }
              {
                id = "gemma-4-31b-it-UD-MLX-4bit";
                name = "Gemma 4 31B UD 4bit";
                reasoning = true;
                input = [
                  "text"
                  "image"
                ];
                contextWindow = 262144;
                maxTokens = 16384;
                cost = {
                  input = 0;
                  output = 0;
                  cacheRead = 0;
                  cacheWrite = 0;
                };
              }
            ];
          };

          # Category: Cloud providers

          # Built-in openrouter provider — tags and ZDR config for model-policy extension.
          # models entries add to the built-in catalog (an entry reusing an existing id
          # replaces it), so listing one here does not drop the rest. Covers both main
          # models and the sidecar (roles.local.json routes sidecar roles through this
          # builtin provider).
          # The ZDR policy is enforced in the OpenRouter account settings; openRouterRouting
          # only adds the request-level assertion on top of it.
          # Per-model routing tweaks (e.g. sort/throughput floors) live in modelOverrides.
          openrouter = {
            tags = [
              "zdr"
              "cloud"
            ];
            compat = {
              openRouterRouting = {
                zdr = true;
                data_collection = "deny";
              };
            };
            # Per-model routing tweaks: sort by price with a throughput floor so
            # slow cheap endpoints become fallbacks (rolling 5-min percentiles,
            # not hard caps). Refresh values via `scripts/model-scan.ts --endpoints ...`.
            modelOverrides = {
              "deepseek/deepseek-v4-flash-0731" = {
                compat = {
                  openRouterRouting = {
                    sort = "price"; # single model per request, partition is a no-op
                    preferred_min_throughput = {
                      p50 = 40; # typical requests clear 40 tok/s
                      p90 = 50; # worst-case (90th pct) still clears 50 tok/s
                    };
                  };
                };
              };
            };
          };

          # z.ai GLM Coding plan
          # Should be included by default, but keeping it commented here in case some changes need to be made.
          # zai = {
          #   models = [
          #     {
          #       id = "glm-5.2";
          #       name = "GLM-5.2 (z.ai)";
          #       reasoning = true;
          #       input = [ "text" ];
          #       contextWindow = 1000000;
          #       maxTokens = 131072;
          #       cost = { input = 0; output = 0; cacheRead = 0; cacheWrite = 0; };
          #       compat = {
          #         supportsDeveloperRole = false;
          #         thinkingFormat = "zai";
          #         zaiToolStream = true;
          #       };
          #       thinkingLevelMap = {
          #         low = "high";
          #         high = "max";
          #         xhigh = "max";
          #       };
          #     }
          #   ];
          # };

          openrouter-sidecar = {
            tags = [
              "zdr"
              "cloud"
            ];
            baseUrl = "https://openrouter.ai/api/v1";
            api = "openai-completions";
            apiKey = "!llm-key openrouter-sidecar";
            compat = {
              openRouterRouting = {
                zdr = true;
                data_collection = "deny";
              };
            };
            models = [
              {
                id = "deepseek/deepseek-v4-flash";
                name = "DeepSeek V4 Flash (Sidecar)";
                reasoning = false;
                input = [ "text" ];
                contextWindow = 163840;
                maxTokens = 4096;
                cost = {
                  input = 0.1;
                  output = 0.19;
                  cacheRead = 0;
                  cacheWrite = 0;
                };
              }
            ];
          };
        };
      };

      # Model roles config for sidecar LLM calls (used by permission gate explain, draft suggestion, etc.)
      # Per-model options: ref (provider/model), thinking (off|minimal|low|medium|high|xhigh|max),
      # maxAttempts (retry with filtering, default 1 -- useful for weaker/local models).
      # requestParams: per-model extra API params injected via pi's onPayload hook.
      #   Used for provider-specific options (e.g. oMLX thinking control).
      #   chat_template_kwargs.enable_thinking=false: skip CoT for fast responses
      #   thinking_budget=N: cap thinking tokens (max_tokens includes thinking)
      ".pi/agent/roles.json".text = builtins.toJSON {
        explain = {
          maxTokens = 256;
          models = [
            {
              ref = "omlx/Qwen3.6-35B-A3B-UD-MLX-4bit";
              thinking = "off";
              maxAttempts = 2;
              requestParams = {
                chat_template_kwargs = {
                  enable_thinking = false;
                };
                temperature = 0.7;
                top_p = 0.8;
                top_k = 20;
              };
            }
            {
              ref = "openrouter-sidecar/deepseek/deepseek-v4-flash";
              thinking = "off";
            }
            {
              ref = "omlx/gemma-4-31b-it-UD-MLX-4bit";
              thinking = "off";
              maxAttempts = 2;
              requestParams = {
                chat_template_kwargs = {
                  enable_thinking = false;
                };
              };
            }
            {
              ref = "omlx/Qwen3.6-27B-4bit";
              thinking = "off";
              maxAttempts = 2;
              requestParams = {
                chat_template_kwargs = {
                  enable_thinking = false;
                };
                temperature = 0.7;
                top_p = 0.8;
                top_k = 20;
              };
            }
            {
              ref = "zai/glm-4.5-air";
              thinking = "off";
            }
            {
              ref = "zai/glm-4.7-flash";
              thinking = "off";
            }
            {
              ref = "anthropic/claude-haiku-4-5";
              thinking = "off";
            }
            {
              ref = "lmstudio/qwen/qwen3.5-9b";
              thinking = "off";
              maxAttempts = 2;
            }
          ];
        };
        draft = {
          maxTokens = 128;
          models = [
            {
              ref = "omlx/Qwen3.6-35B-A3B-UD-MLX-4bit";
              thinking = "off";
              maxAttempts = 2;
              requestParams = {
                chat_template_kwargs = {
                  enable_thinking = false;
                };
                temperature = 0.7;
                top_p = 0.8;
                top_k = 20;
              };
            }
            {
              ref = "openrouter-sidecar/deepseek/deepseek-v4-flash";
              thinking = "off";
            }
            {
              ref = "omlx/gemma-4-31b-it-UD-MLX-4bit";
              thinking = "off";
              maxAttempts = 2;
              requestParams = {
                chat_template_kwargs = {
                  enable_thinking = false;
                };
              };
            }
            {
              ref = "omlx/Qwen3.6-27B-4bit";
              thinking = "off";
              maxAttempts = 2;
              requestParams = {
                chat_template_kwargs = {
                  enable_thinking = false;
                };
                temperature = 0.7;
                top_p = 0.8;
                top_k = 20;
              };
            }
            {
              ref = "zai/glm-4.5-air";
              thinking = "off";
            }
            {
              ref = "zai/glm-4.7-flash";
              thinking = "off";
            }
            {
              ref = "anthropic/claude-haiku-4-5";
              thinking = "off";
            }
            {
              ref = "lmstudio/qwen/qwen3.5-9b";
              thinking = "off";
              maxAttempts = 2;
            }
          ];
        };
        # Default for subagents that declare neither `role` nor `model` (rpc.ts's
        # DEFAULT_SUBAGENT_ROLE). A fallback chain like any other role, so /sidecar-models
        # edits it; a consumer project cannot rely on it, which is what `model:` is for.
        # Two entries on purpose: the retry plan is [m0, m0, m1] under MAX_ATTEMPTS, so a
        # third model is never attempted — a local fallback belongs in slot 1.
        subagent = {
          models = [
            {
              ref = "openrouter/deepseek/deepseek-v4.1-flash";
              thinking = "high";
            }
            {
              ref = "openrouter/z-ai/glm-5.3-flash";
              thinking = "high";
            }
          ];
        };
        vision = {
          maxTokens = 4096;
          models = [
            { ref = "openrouter/google/gemini-2.5-flash-lite"; }
            {
              ref = "omlx/Qwen3.6-35B-A3B-UD-MLX-4bit";
              thinking = "off";
              maxAttempts = 2;
              requestParams = {
                thinking_budget = 1024;
                temperature = 0.7;
                top_p = 0.8;
                top_k = 20;
              };
            }
            {
              ref = "omlx/gemma-4-31b-it-UD-MLX-4bit";
              thinking = "off";
              maxAttempts = 2;
              requestParams = {
                thinking_budget = 1024;
              };
            }
            {
              ref = "omlx/Qwen3.6-27B-4bit";
              thinking = "off";
              maxAttempts = 2;
              requestParams = {
                thinking_budget = 1024;
                temperature = 0.7;
                top_p = 0.8;
                top_k = 20;
              };
            }
            {
              ref = "zai/glm-4.6v-flash";
              thinking = "off";
            }
          ];
        };
      };

    }

    # Agent definitions: symlinked to live source.
    {
      ".pi/agent/agents".source =
        config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/system/config/llm/pi/agents";
    }

    # Prompt templates (slash commands): symlinked to live source.
    {
      ".pi/agent/prompts".source =
        config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/system/config/llm/pi/prompts";
    }

    # Skills: whole-directory symlinks to live sources (shared list defined in llm-shared.nix).
    (lib.listToAttrs (
      map (s: {
        name = ".pi/agent/skills/${s.name}";
        value.source = config.lib.file.mkOutOfStoreSymlink s.source;
      }) skills
    ))
  ];

  # auth.json must be a real file (pi-auth.sh has the mechanism); the script merges
  # the managed keys over the existing file, so OAuth tokens from pi's `/login`
  # survive a switch.
  home.activation.piAuth = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    $DRY_RUN_CMD ${piAuthChecked}/bin/pi-auth "${piAuthFile}" "${piConfigDir}/auth.json"
  '';

  # Extensions deployed to ~/.pi/agent/extensions/ for auto-discovery.
  # All are symlinked to live source — edit + /reload works without nix-switch.
  home.activation.piExtensions = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    $DRY_RUN_CMD mkdir -p "${piConfigDir}/extensions"

    # Extension + shared directories (auto-discovered, symlinked to live source)
    # Pi only loads dirs with index.ts as extensions; shared dirs are just for imports.
    ${lib.concatMapStringsSep "\n    " (name: ''
      ext_link="${piConfigDir}/extensions/${name}"
      ext_target="${piExtSrcDir}/${name}"
      if [[ -L "$ext_link" ]] && [[ "$(readlink "$ext_link")" == "$ext_target" ]]; then
        : # already correct
      else
        $DRY_RUN_CMD ln -sfn "$ext_target" "$ext_link"
        echo "pi: linked ${name} -> $ext_target"
      fi
    '') allExtDirs}

    # Bridge: expose the canonical (MCP-tree) web-search providers to the pi
    # web-search extension as a sibling import (../web-search-core/...). Pi
    # resolves relative imports from the symlink path, so it needs this entry
    # in the runtime extensions dir; allExtDirs skips it (it's not under
    # piExtSrcDir), so it's wired explicitly here.
    core_link="${piConfigDir}/extensions/web-search-core"
    if [[ -L "$core_link" ]] && [[ "$(readlink "$core_link")" == "${webSearchCoreSrc}" ]]; then
      : # already correct
    else
      $DRY_RUN_CMD ln -sfn "${webSearchCoreSrc}" "$core_link"
      echo "pi: linked web-search-core -> ${webSearchCoreSrc}"
    fi
  '';
}
