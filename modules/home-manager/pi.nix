# Pi coding agent configuration
{
  config,
  lib,
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

in
{
  home.file = lib.mkMerge [
    {
      # Pi-specific agent instructions (global instructions injected separately via journal extension)
      ".pi/agent/AGENTS.md".text = ''
        # Pi Agent Instructions

        ## File Editing

        - Use edit (targeted replacement) for existing files, not write (full rewrite). Rewrites lose subtle details and make reviews harder.
        - Only use write for genuinely new files or when the entire file content is changing.
      '';

      # auth.json file storing API keys and OAuth, see auth-storage.ts in pi.
      ".pi/agent/auth.json".text = builtins.toJSON {
        # OpenRouter with ZDR (Zero Data Retention) enforced in OpenRouter settings
        openrouter = {
          type = "api_key";
          key = "!op --account GZ5VHFHUKJGHPMLTD2PZ2MUUPI read 'op://oqpoo4svevbobqjgyniixhmqca/llm-api-keys/pi/openrouter-main'";
        };
        # Z.ai Coding Plan
        zai = {
          type = "api_key";
          key = "!op --account GZ5VHFHUKJGHPMLTD2PZ2MUUPI read 'op://oqpoo4svevbobqjgyniixhmqca/llm-api-keys/pi/zai'";
        };
      };

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
          # No models array = keeps all built-in models, only overrides provider-level fields.
          # Covers both main models and the sidecar (roles.local.json routes sidecar
          # roles through this builtin provider).
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
            apiKey = "!op --account GZ5VHFHUKJGHPMLTD2PZ2MUUPI read 'op://oqpoo4svevbobqjgyniixhmqca/llm-api-keys/pi/openrouter-sidecar'";
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
      # Per-model options: ref (provider/model), thinking (off|minimal|low|medium|high),
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
