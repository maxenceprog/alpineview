#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_NAME=lidalps3d

source "$(conda info --base)/etc/profile.d/conda.sh"
if ! conda env list | grep -q "^${ENV_NAME} "; then
  conda env create -f "$HERE/environment.yml" -n "$ENV_NAME"
fi
conda activate "$ENV_NAME"

# alpineview_builder
cd "$HERE"
cmake -S . -B build/release -DCMAKE_BUILD_TYPE=Release
cmake --build build/release -j"$(nproc)"
ln -sf "$HERE/build/release/src/alpineview_builder" "$CONDA_PREFIX/bin/alpineview_builder"

# PoissonRecon
cd "$HERE/third-parties/PoissonRecon"
CPATH="$CONDA_PREFIX/include" LIBRARY_PATH="$CONDA_PREFIX/lib" \
  make poissonrecon -j"$(nproc)"
ln -sf "$HERE/third-parties/PoissonRecon/Bin/Linux/PoissonRecon" "$CONDA_PREFIX/bin/poissonrecon"
