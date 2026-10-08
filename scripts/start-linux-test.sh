#!/usr/bin/env bash
set -euo pipefail

t3_repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
t3_artifact_dir="${T3CODE_TEST_ARTIFACT_DIR:-$t3_repo_dir/artifacts/linux-test}"
mkdir -p -- "$t3_artifact_dir"
t3_artifact_dir="$(cd -- "$t3_artifact_dir" && pwd)"
cd -- "$t3_repo_dir"
export PATH="$t3_repo_dir/node_modules/.bin:$PATH"
export T3CODE_DESKTOP_UPDATE_REPOSITORY="${T3CODE_DESKTOP_UPDATE_REPOSITORY:-Byte-Kitsune/t3code}"

if ! command -v vp >/dev/null 2>&1; then
  echo "Vite+ (vp) is required to install dependencies and build the current checkout." >&2
  exit 1
fi
echo "Installing the current checkout's dependencies…"
vp install --frozen-lockfile
t3_source_commit="$(git rev-parse --short=12 HEAD)"
t3_package_version="$(node -p 'JSON.parse(require("node:fs").readFileSync("apps/server/package.json", "utf8")).version.split(/[+-]/)[0]')"
t3_build_version="$t3_package_version-preview.local.$t3_source_commit"
echo "Building $t3_build_version from the current local sources (including uncommitted changes)…"
node scripts/build-desktop-artifact.ts \
  --platform linux --arch x64 --target AppImage \
  --build-version "$t3_build_version" --output-dir "$t3_artifact_dir"

t3_appimage="$t3_artifact_dir/T3-Code-$t3_build_version-x86_64.AppImage"
if [[ ! -f "$t3_appimage" ]]; then
  echo "The build did not produce the expected AppImage: $t3_appimage" >&2
  exit 1
fi
if [[ "${T3CODE_BUILD_ONLY:-0}" == "1" ]]; then
  echo "Built $t3_appimage"
  exit 0
fi
t3_test_base="${XDG_DATA_HOME:-$HOME/.local/share}/byte-kitsune/t3code-monolith-test"
export T3CODE_HOME="$t3_test_base/t3"
export XDG_CONFIG_HOME="$t3_test_base/config"
export T3CODE_DISABLE_AUTO_UPDATE=true
mkdir -p -- "$T3CODE_HOME" "$XDG_CONFIG_HOME"
echo "Starting the freshly built app. Close an older test instance first."
exec "$t3_appimage" --appimage-extract-and-run "$@"
