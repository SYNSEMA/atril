#!/bin/sh
# install.sh — installs Atril on Linux or macOS. The real script is src/install.sh (it travels
# inside atrild too, to install Atril on another machine through SSH).
exec sh "$(cd "$(dirname "$0")" && pwd)/src/install.sh" "$@"
