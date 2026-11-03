{ pkgs, ... }:
let
  llm-key = pkgs.writeShellApplication {
    name = "llm-key";
    text = builtins.readFile ./llm-key.sh;
  };

  llm-key-checked = pkgs.runCommand "llm-key-checked" { } ''
    mkdir -p stub "$out/bin"
    cat > stub/op <<'STUB'
    #!/usr/bin/env bash
    printf '%s\n' "$*" >> "$OP_LOG"
    [[ "''${FAKE_RC:-0}" == 0 ]] || exit "$FAKE_RC"
    printf '%s\n' "''${FAKE_VALUE:-}"
    STUB
    chmod +x stub/op

    export HOME=$PWD/home XDG_STATE_HOME=$PWD/state XDG_CONFIG_HOME=$PWD/config
    mkdir -p "$HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME"
    export OP_LOG=$PWD/op.log PATH=$PWD/stub:$PATH
    key=${llm-key}/bin/llm-key

    # every advertised name resolves
    [ "$("$key" --names)" = "$(printf 'openrouter-main\nzai\nopenrouter-sidecar\nartificialanalysis')" ]
    for name in $("$key" --names); do
      FAKE_VALUE=sk "$key" "$name" >/dev/null
    done

    : >"$OP_LOG"
    FAKE_VALUE=sk-test "$key" openrouter-main >value.txt
    [ "$(cat value.txt)" = sk-test ]
    [ "$(wc -l <value.txt)" -eq 1 ]
    FAKE_VALUE=sk-zai "$key" zai >value.txt
    FAKE_VALUE=sk-sidecar "$key" openrouter-sidecar >value.txt
    FAKE_VALUE=sk-aa "$key" artificialanalysis >value.txt
    FAKE_VALUE=sk-ref "$key" 'op://vault/item/field' >value.txt
    grep -q 'read op://.*/llm-api-keys/pi/openrouter-main' "$OP_LOG"
    grep -q 'read op://.*/llm-api-keys/pi/zai' "$OP_LOG"
    grep -q 'read op://.*/llm-api-keys/pi/openrouter-sidecar' "$OP_LOG"
    grep -q 'read op://.*/llm-api-keys/generic/artificialanalysis' "$OP_LOG"
    grep -q 'read op://vault/item/field' "$OP_LOG"
    # no account flag by default
    if grep -q -- '--account' "$OP_LOG"; then echo "account flag passed by default"; exit 1; fi

    # each failure exits non-zero with empty stdout
    if "$key" nope >out 2>/dev/null; then exit 1; fi
    [ ! -s out ]
    if FAKE_RC=1 "$key" zai >out 2>/dev/null; then exit 1; fi
    [ ! -s out ]
    if FAKE_VALUE= "$key" zai >out 2>/dev/null; then exit 1; fi
    [ ! -s out ]

    # log first; never the value
    grep -q 'start name=openrouter-main' "$XDG_STATE_HOME/llm-key.log"
    if grep -q sk-test "$XDG_STATE_HOME/llm-key.log"; then echo "secret in the log"; exit 1; fi

    # --check: env beats the file, which beats no flag
    "$key" --check | grep -q 'account=unset'
    mkdir -p "$XDG_CONFIG_HOME/llm"
    printf 'file-account\n' >"$XDG_CONFIG_HOME/llm/1password-account"
    "$key" --check | grep -q 'account=file-account'
    grep -q -- '--account file-account' "$OP_LOG"
    LLM_KEY_ACCOUNT=env-account "$key" --check | grep -q 'account=env-account'
    grep -q -- '--account env-account' "$OP_LOG"
    if FAKE_RC=1 "$key" --check >/dev/null 2>&1; then exit 1; fi

    # help exits 0, no arguments exits 2
    "$key" --help >/dev/null
    rc=0
    "$key" >/dev/null 2>&1 || rc=$?
    [ "$rc" -eq 2 ]

    cp ${llm-key}/bin/llm-key "$out/bin/"
    # the installed artifact, not the store input: this is what lands on PATH
    "$out/bin/llm-key" --names | grep -q '^openrouter-main$'
  '';
in
{
  home.packages = [ llm-key-checked ];
}
