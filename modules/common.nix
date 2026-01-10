# Common configuration shared between darwin and NixOS
# Sets up primary user with cross-platform home directory
{ self
, inputs
, config
, pkgs
, ...
}: {
  imports = [
    ./primaryUser.nix
  ];

  user = {
    description = "aviraccoon";
    home = "${
      if pkgs.stdenvNoCC.isDarwin
      then "/Users"
      else "/home"
    }/${config.user.name}";
    shell = pkgs.zsh;
  };
}
