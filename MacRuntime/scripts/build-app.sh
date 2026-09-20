#!/bin/zsh
set -euo pipefail

adam_runtime_dir=${0:A:h:h}
swift build --package-path "$adam_runtime_dir" -c release --product AdamMacApp
adam_bin_dir=$(swift build --package-path "$adam_runtime_dir" -c release --product AdamMacApp --show-bin-path)
adam_bundle="$adam_runtime_dir/.build/Adam.app"
adam_contents="$adam_bundle/Contents"

mkdir -p "$adam_contents/MacOS"
cp "$adam_bin_dir/AdamMacApp" "$adam_contents/MacOS/AdamMacApp"
cp "$adam_runtime_dir/Sources/AdamMacApp/Info.plist" "$adam_contents/Info.plist"

/usr/libexec/PlistBuddy \
  -c 'Set :CFBundleIdentifier ai.oxy.adam.mac' \
  -c 'Set :CFBundleExecutable AdamMacApp' \
  -c 'Set :CFBundleShortVersionString 0.1' \
  -c 'Set :CFBundleVersion 1' \
  "$adam_contents/Info.plist"

xattr -cr "$adam_bundle"
codesign --force --sign - "$adam_bundle"
echo "$adam_bundle"
