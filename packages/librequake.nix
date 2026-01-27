# LibreQuake - Free Quake game data
# https://github.com/MissLavender-LQ/LibreQuake
{ lib, stdenvNoCC, fetchurl, unzip }:

stdenvNoCC.mkDerivation rec {
  pname = "librequake";
  version = "0.09-beta";

  src = fetchurl {
    url = "https://github.com/MissLavender-LQ/LibreQuake/releases/download/v${version}/full.zip";
    sha256 = "0gfg9dgb76d86qymw2v5i197dhdb8l65x8cv9wj1c4l16lxlcgk2";
  };

  nativeBuildInputs = [ unzip ];

  sourceRoot = ".";

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/quake
    cp -r full/id1 $out/share/quake/
    runHook postInstall
  '';

  meta = with lib; {
    description = "Free Quake-compatible game data";
    homepage = "https://github.com/MissLavender-LQ/LibreQuake";
    license = licenses.gpl2Only;
    platforms = platforms.all;
    maintainers = [ ];
  };
}
