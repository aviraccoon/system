# vkQuake - Vulkan Quake engine (QuakeSpasm fork)
# https://github.com/Novum/vkQuake
# Signed and notarized macOS build from Mac Source Ports
{ lib, stdenvNoCC, fetchurl }:

stdenvNoCC.mkDerivation rec {
  pname = "vkquake";
  version = "1.33.1";

  src = fetchurl {
    url = "https://github.com/MacSourcePorts/MSPBuildSystem/releases/download/vkQuake_${version}/vkQuake-${version}.dmg";
    sha256 = "04p56ykwnzk1hjbvwcwli2y2mipqfhsfg8fc6isv3wib33857nmq";
  };

  dontUnpack = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/Applications
    /usr/bin/hdiutil attach "$src" -nobrowse -readonly -mountpoint mnt
    cp -r mnt/vkQuake.app $out/Applications/
    /usr/bin/hdiutil detach mnt
    runHook postInstall
  '';

  meta = with lib; {
    description = "Vulkan Quake engine (QuakeSpasm fork)";
    homepage = "https://github.com/Novum/vkQuake";
    license = licenses.gpl2Only;
    platforms = platforms.darwin;
    maintainers = [ ];
  };
}
