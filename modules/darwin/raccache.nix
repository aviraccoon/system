# Offsite backup twice daily (13:00, 19:30) to the configured destinations.
#
# The job is the raccache CLI, which reads everything machine-specific
# (~/.config/raccache/{config,targets,destinations,devices,ignore}) at run time.
# launchd has no shell profile, so the runtime and the tools it calls are passed
# by path: without them the run finds no bun, no rclone and no git. Calendar jobs
# missed while the machine is asleep run at wake.
#
# Secrets come from sops: the template below renders the rclone credentials and
# the ntfy URL as an env file that the runner loads and hands to rclone. The
# remote *shape* (which bucket, which endpoint) stays in ~/.config/rclone and the
# machine manifests, so nothing machine-specific lands in this repo.
{ pkgs, config, ... }:

let
  cli = "${config.user.home}/system/config/cli/raccache/raccache.ts";
  sopsFile = ../../secrets/raccache.yaml;
  owner = config.user.name;
in
{
  sops.secrets.raccache_r2_access_key_id = { inherit sopsFile owner; key = "r2_access_key_id"; };
  sops.secrets.raccache_r2_secret_access_key = { inherit sopsFile owner; key = "r2_secret_access_key"; };
  sops.secrets.raccache_b2_account = { inherit sopsFile owner; key = "b2_account"; };
  sops.secrets.raccache_b2_key = { inherit sopsFile owner; key = "b2_key"; };
  sops.secrets.raccache_crypt_password = { inherit sopsFile owner; key = "crypt_password"; };
  sops.secrets.raccache_crypt_password2 = { inherit sopsFile owner; key = "crypt_password2"; };
  sops.secrets.raccache_ntfy_url = { inherit sopsFile owner; key = "ntfy_url"; };

  sops.templates."raccache.env" = {
    inherit owner;
    mode = "0400";
    content = ''
      RCLONE_CONFIG_B2_ACCOUNT=${config.sops.placeholder.raccache_b2_account}
      RCLONE_CONFIG_B2_KEY=${config.sops.placeholder.raccache_b2_key}
      RCLONE_CONFIG_B2CRYPT_PASSWORD=${config.sops.placeholder.raccache_crypt_password}
      RCLONE_CONFIG_B2CRYPT_PASSWORD2=${config.sops.placeholder.raccache_crypt_password2}
      RCLONE_CONFIG_R2_ACCESS_KEY_ID=${config.sops.placeholder.raccache_r2_access_key_id}
      RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=${config.sops.placeholder.raccache_r2_secret_access_key}
      RACCACHE_NTFY_URL=${config.sops.placeholder.raccache_ntfy_url}
    '';
  };

  launchd.user.agents.raccache.serviceConfig = {
    ProgramArguments = [
      "${pkgs.bun}/bin/bun"
      cli
      "run"
    ];
    StartCalendarInterval = [
      {
        Hour = 13;
        Minute = 0;
      }
      {
        Hour = 19;
        Minute = 30;
      }
    ];
    EnvironmentVariables = {
      RCLONE = "${pkgs.rclone}/bin/rclone";
      GIT = "${pkgs.git}/bin/git";
    };
    ProcessType = "Background";
    StandardOutPath = "${config.user.home}/Library/Logs/raccache.stdout.log";
    StandardErrorPath = "${config.user.home}/Library/Logs/raccache.stderr.log";
  };
}
