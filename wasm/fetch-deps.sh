#!/usr/bin/env bash
# Fetch wasi-sdk, NeuralAmpModelerCore and Eigen at the pinned versions into .deps/
set -euo pipefail
cd "$(dirname "$0")/.."
source wasm/deps.env
mkdir -p .deps && cd .deps
OS=$(uname -s); ARCH=$(uname -m)
case "$OS-$ARCH" in
  Linux-x86_64) WASI_PLAT=x86_64-linux ;; Linux-aarch64) WASI_PLAT=arm64-linux ;;
  Darwin-arm64) WASI_PLAT=arm64-macos ;; Darwin-x86_64) WASI_PLAT=x86_64-macos ;;
  *) echo "unsupported host $OS-$ARCH"; exit 1 ;;
esac
if [ ! -d wasi-sdk ]; then
  curl -fsSL -o wasi.tgz "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_PLAT}.tar.gz"
  tar xzf wasi.tgz && rm wasi.tgz && mv wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_PLAT} wasi-sdk
fi
fetch() { # dir repo commit [mirror]
  if [ ! -d "$1/.git" ]; then git init -q "$1"; fi
  ( cd "$1"
    git remote remove origin 2>/dev/null || true; git remote add origin "$2"
    git fetch -q --depth 1 origin "$3" || { [ -n "${4:-}" ] && git remote set-url origin "$4" && git fetch -q --depth 1 origin "$3"; }
    git checkout -q FETCH_HEAD )
}
fetch NeuralAmpModelerCore "$NAM_CORE_REPO" "$NAM_CORE_COMMIT"
fetch eigen "$EIGEN_REPO" "$EIGEN_COMMIT" "$EIGEN_MIRROR"
echo "deps ready in .deps/"
