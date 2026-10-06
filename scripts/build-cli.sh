#!/usr/bin/env bash
# Build release archives without a C toolchain or a web build.
set -euo pipefail

version=${1:?usage: scripts/build-cli.sh VERSION [OUTPUT_DIRECTORY]}
output=${2:-dist/cli}
if [[ ! "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([-+][a-zA-Z0-9.-]+)?$ && "$version" != "dev" ]]; then
  echo "invalid release version: $version" >&2
  exit 1
fi

mkdir -p "$output"
output=$(cd "$output" && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

archives=()
for target in darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64; do
  os=${target%/*}
  arch=${target#*/}
  name="timeclock_${version#v}_${os}_${arch}"
  mkdir "$stage/$name"
  binary=timeclock
  if [[ "$os" == windows ]]; then binary=timeclock.exe; fi
  echo "Building $name"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build \
    -trimpath -ldflags "-s -w -X main.version=$version" \
    -o "$stage/$name/$binary" ./cmd/timeclock
  cp LICENSE README.md "$stage/$name/"
  if [[ "$os" == windows ]]; then
    archive="$name.zip"
    # zip updates existing archives, so create a fresh one in the staging directory.
    (cd "$stage" && zip -q -r "$archive" "$name")
    mv "$stage/$archive" "$output/$archive"
  else
    archive="$name.tar.gz"
    tar -czf "$output/$archive" -C "$stage" "$name"
  fi
  archives+=("$archive")
done

(cd "$output" && shasum -a 256 "${archives[@]}" > SHA256SUMS)
echo "Archives and SHA256SUMS written to $output"
