# Godot - Game engine
# https://godotengine.org/
# Pass `version` and `sha256` to get a specific release.
{ lib, stdenvNoCC, fetchurl, unzip, version, sha256 }:

stdenvNoCC.mkDerivation {
  pname = "godot";
  inherit version;

  src = fetchurl {
    url = "https://github.com/godotengine/godot/releases/download/${version}-stable/Godot_v${version}-stable_macos.universal.zip";
    inherit sha256;
  };

  nativeBuildInputs = [ unzip ];

  sourceRoot = ".";

  installPhase = ''
    runHook preInstall
    mkdir -p $out/Applications
    cp -r Godot.app "$out/Applications/Godot ${version}.app"
    /usr/libexec/PlistBuddy -c "Set :CFBundleName 'Godot ${version}'" \
      "$out/Applications/Godot ${version}.app/Contents/Info.plist"
    /usr/bin/xattr -cr "$out/Applications/Godot ${version}.app"
    /usr/bin/codesign --force --deep --sign - "$out/Applications/Godot ${version}.app"
    runHook postInstall
  '';

  meta = with lib; {
    description = "Godot game engine ${version}";
    homepage = "https://godotengine.org/";
    license = licenses.mit;
    platforms = platforms.darwin;
    maintainers = [ ];
  };
}
