#!/usr/bin/env bash
set -euo pipefail

APP="$HOME/Applications/OrcaTab.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [[ -d "$APP" ]]; then
  "$LSREGISTER" -u "$APP"
  /bin/rm -rf "$APP"
fi

printf '已卸载 OrcaTab URL handler。\n'
