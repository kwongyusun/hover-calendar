#!/usr/bin/env bash
# Builds the Windows portable .exe from Linux (needs wine for setting the .exe icon).
set -e
rm -rf dist
npx electron-builder --win dir --x64 -c.win.signAndEditExecutable=false
wine ~/.cache/electron-builder/winCodeSign/winCodeSign-2.6.0/rcedit-x64.exe "dist/win-unpacked/Hover Calendar.exe" \
  --set-version-string FileDescription "Hover Calendar" --set-version-string ProductName "Hover Calendar" \
  --set-file-version 1.6.0 --set-product-version 1.6.0.0 --set-icon build/icon.ico || true
npx electron-builder --win portable --x64 --prepackaged dist/win-unpacked -c.win.signAndEditExecutable=false
