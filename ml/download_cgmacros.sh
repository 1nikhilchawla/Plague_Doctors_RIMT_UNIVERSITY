#!/bin/sh
# Downloads PhysioNet CGMacros 1.0.0 (CC BY-NC-SA 4.0). Does not commit the files.
# https://doi.org/10.13026/3z8q-x658
set -eu
dest="${CGMACROS_DIR:-/tmp/cgmacros}"
mkdir -p "$dest"
url="https://physionet-open.s3.amazonaws.com/cgmacros/1.0.0/CGMacros_dateshifted365.zip"
zip="$dest/CGMacros_dateshifted365.zip"
if [ ! -s "$zip" ]; then
  curl -L --fail --retry 3 -o "$zip" "$url"
fi
python3 - "$zip" "$dest/raw" << 'PY'
import os, sys, zipfile
zip_path, out_root = sys.argv[1], sys.argv[2]
os.makedirs(out_root, exist_ok=True)
with zipfile.ZipFile(zip_path) as archive:
    for name in archive.namelist():
        if not name.lower().endswith(".csv") or "/photos/" in name:
            continue
        relative = name.split("CGMacros/", 1)[-1]
        target = os.path.join(out_root, relative)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with archive.open(name) as src, open(target, "wb") as dst:
            dst.write(src.read())
print("csv files are in", out_root)
PY
