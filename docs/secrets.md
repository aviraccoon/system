# Secrets Management with SOPS

This repo uses [sops-nix](https://github.com/Mic92/sops-nix) for managing secrets. Secrets are encrypted with [age](https://github.com/FiloSottile/age) and stored in git.

## How it works

1. Secrets are encrypted in `secrets/*.yaml` files
2. Each machine/user has an age key that can decrypt them
3. During `nix-switch`, secrets are decrypted to `/run/secrets/`

## Age key locations

SOPS looks for age keys in these locations (in order):

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/sops/age/keys.txt` |
| Linux | `~/.config/sops/age/keys.txt` |

The key file contains both private and public keys:

```
# created: 2025-12-26T18:00:00Z
# public key: age1abc123...
AGE-SECRET-KEY-1XXXXX...
```

**NEVER commit this file.** It's your private key.

## Common commands

```bash
# Edit secrets (decrypts → editor → re-encrypts on save)
sops secrets/example.yaml

# View decrypted secrets
sops --decrypt secrets/example.yaml

# Encrypt a new file
sops --encrypt secrets/new.yaml > secrets/new.yaml.enc
mv secrets/new.yaml.enc secrets/new.yaml

# Or create and encrypt in one step
sops secrets/new.yaml  # Creates with template, encrypts on save
```

## Adding a new machine

1. Generate an age key on the new machine:
   ```bash
   age-keygen -o keys.txt
   # Move to correct location based on platform (see table above)
   ```

2. Add the public key to `.sops.yaml`:
   ```yaml
   keys:
     - &avi age1abc...  # existing
     - &new-machine age1xyz...  # new

   creation_rules:
     - path_regex: secrets/.*\.yaml$
       key_groups:
         - age:
             - *avi
             - *new-machine
   ```

3. Re-encrypt secrets so the new machine can decrypt them:
   ```bash
   sops updatekeys secrets/example.yaml
   ```

## Using secrets in Nix

Add to your darwin or NixOS config:

```nix
# Declare the secret
sops.secrets.api_token = {
  sopsFile = ../../secrets/example.yaml;
  # Optional: override owner/permissions
  # owner = "avi";
  # mode = "0400";
};

# Secret is available at runtime as a file
# /run/secrets/api_token
```

Read the secret in a script or config:

```nix
environment.etc."my-app/config".text = ''
  API_TOKEN_FILE=/run/secrets/api_token
'';
```

## Bootstrap on fresh machine

On a fresh machine without your age key:

1. Clone repo via HTTPS (not SSH, since you don't have keys yet)
2. Copy your age key from backup/password manager to the correct location
3. Run `nix-switch`

Alternatively, generate a new key and re-encrypt secrets from another machine.

## Rotating keys

If a key is compromised:

1. Remove the old key from `.sops.yaml`
2. Generate a new key
3. Add the new public key to `.sops.yaml`
4. Re-encrypt all secrets:
   ```bash
   for f in secrets/*.yaml; do sops updatekeys "$f"; done
   ```
5. Commit and push
