#!/bin/bash
# HomeFlix launcher: double-click this file to start HomeFlix.

cd "$(dirname "$0")" || exit 1
clear

# Apps started by double-click do not always see Node.js installed by Homebrew or nvm.
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.volta/bin"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

wait_and_quit() {
  echo ""
  read -n 1 -s -r -p "  Press any key to close this window."
  echo ""
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  HomeFlix needs a free program called Node.js, which is not on this Mac yet."
  echo ""
  echo "  1. Open  https://nodejs.org  and download the version marked LTS."
  echo "  2. Open the downloaded file and follow the installer."
  echo "  3. Double-click HomeFlix again."
  wait_and_quit
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  echo ""
  echo "  HomeFlix needs Node.js version 18 or newer. This Mac has $(node -v 2>/dev/null)."
  echo ""
  echo "  1. Open  https://nodejs.org  and download the version marked LTS."
  echo "  2. Open the downloaded file and follow the installer."
  echo "  3. Double-click HomeFlix again."
  wait_and_quit
fi

echo ""
echo "  Starting HomeFlix..."

node bin/homeflix.js "$@"
CODE=$?

if [ "$CODE" -ne 0 ]; then
  echo ""
  echo "  HomeFlix stopped because of a problem (see the message above)."
  wait_and_quit
fi
