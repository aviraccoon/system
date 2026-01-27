# TrenchBroom - Quake map editor
# https://github.com/TrenchBroom/TrenchBroom
{ lib, stdenvNoCC, fetchurl, unzip }:

stdenvNoCC.mkDerivation rec {
  pname = "trenchbroom";
  version = "2025.4";

  src = fetchurl {
    url = "https://github.com/TrenchBroom/TrenchBroom/releases/download/v${version}/TrenchBroom-macOS-arm64-v${version}-Release.zip";
    sha256 = "14676w4qj5q11bffn7wmf5n9a3kdp45dkbivm5g50d4527ibr3pq";
  };

  nativeBuildInputs = [ unzip ];

  sourceRoot = ".";

  installPhase = ''
    runHook preInstall
    mkdir -p $out/Applications
    cp -r TrenchBroom.app $out/Applications/
    /usr/bin/xattr -cr $out/Applications/TrenchBroom.app
    /usr/bin/codesign --force --deep --sign - $out/Applications/TrenchBroom.app
    runHook postInstall
  '';

  meta = with lib; {
    description = "Cross-platform Quake map editor";
    homepage = "https://github.com/TrenchBroom/TrenchBroom";
    license = licenses.gpl3Only;
    platforms = platforms.darwin;
    maintainers = [ ];
  };
}
