#!/bin/bash
set -e

PROJECT_ROOT=$(realpath $(cd $(dirname "$0"); pwd -P)/../../)
DEST=$PROJECT_ROOT/build/bin

cd $PROJECT_ROOT/build/get_static_params

GOOS=linux GOARCH=amd64 go build -o $DEST/get_static_params_amd64
echo "wrote $DEST/get_static_params_amd64"
GOOS=linux GOARCH=arm64 go build -o $DEST/get_static_params_arm64
echo "wrote $DEST/get_static_params_arm64"
GOOS=windows GOARCH=amd64 go build -o $DEST/get_static_params_amd64_win.exe
echo "wrote $DEST/get_static_params_amd64_win.exe"
