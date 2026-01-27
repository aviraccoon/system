# ericw-tools - Quake map compiling tools (qbsp, vis, light)
# https://github.com/ericwa/ericw-tools
{ lib, stdenvNoCC, fetchurl, unzip }:

stdenvNoCC.mkDerivation rec {
  pname = "ericw-tools";
  version = "2.0.0-alpha10";

  src = fetchurl {
    url = "https://github.com/ericwa/ericw-tools/releases/download/${version}/${pname}-${version}-Darwin.zip";
    sha256 = "1p12hwfym5g92iyh15w9y8y8bj1vcbq5mss7zyfgbpx4aw03n28l";
  };

  nativeBuildInputs = [ unzip ];

  sourceRoot = ".";

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/lib
    cp qbsp vis light bsputil bspinfo maputil $out/bin/
    cp *.dylib $out/lib/

    # Fix dylib rpaths so binaries find their bundled libraries
    for bin in $out/bin/*; do
      for dylib in $out/lib/*.dylib; do
        name=$(basename "$dylib")
        /usr/bin/install_name_tool -change "@rpath/$name" "$out/lib/$name" "$bin" 2>/dev/null || true
      done
      /usr/bin/codesign --force --sign - "$bin"
    done

    runHook postInstall
  '';

  meta = with lib; {
    description = "Quake map compiling tools (qbsp, vis, light)";
    homepage = "https://github.com/ericwa/ericw-tools";
    license = licenses.gpl3Only;
    platforms = platforms.darwin;
    maintainers = [ ];
  };
}
