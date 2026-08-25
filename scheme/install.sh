#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
APP="$HOME/Applications/OrcaTab.app"
PLIST="$APP/Contents/Info.plist"
PLIST_BUDDY="/usr/libexec/PlistBuddy"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

mkdir -p "$HOME/Applications"
cd "$REPO_ROOT"
/usr/bin/osacompile -o "$APP" scheme/handler.applescript

if "$PLIST_BUDDY" -c "Print :CFBundleIdentifier" "$PLIST" >/dev/null 2>&1; then
  "$PLIST_BUDDY" -c "Set :CFBundleIdentifier dev.local.orcatab" "$PLIST"
else
  "$PLIST_BUDDY" -c "Add :CFBundleIdentifier string dev.local.orcatab" "$PLIST"
fi

if ! "$PLIST_BUDDY" -c "Print :CFBundleURLTypes" "$PLIST" >/dev/null 2>&1; then
  "$PLIST_BUDDY" -c "Add :CFBundleURLTypes array" "$PLIST"
  "$PLIST_BUDDY" -c "Add :CFBundleURLTypes:0 dict" "$PLIST"
  "$PLIST_BUDDY" -c "Add :CFBundleURLTypes:0:CFBundleURLName string OrcaTab" "$PLIST"
  "$PLIST_BUDDY" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST"
  "$PLIST_BUDDY" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string orcatab" "$PLIST"
fi

"$LSREGISTER" -f "$APP"
printf '已安装 OrcaTab URL handler。验证：open "orcatab://claude/<sid>"\n'
