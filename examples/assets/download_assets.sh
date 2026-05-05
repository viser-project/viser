#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Downloading assets to: $SCRIPT_DIR"
echo ""
echo ""

echo "==========================================================="
echo "Downloading Record3D example..."
wget -nv https://brentyi.github.io/viser-example-assets/2022-12-16--10-24-43.r3d -O "$SCRIPT_DIR/record3d_dance.r3d"
unzip -qo "$SCRIPT_DIR/record3d_dance.r3d" -d "$SCRIPT_DIR/record3d_dance"
rm "$SCRIPT_DIR/record3d_dance.r3d"
echo ""

echo "==========================================================="
echo "Download Cal logo..."
wget -nv https://brentyi.github.io/viser-example-assets/Cal_logo.png -O "$SCRIPT_DIR/Cal_logo.png"
echo ""

echo "==========================================================="
echo "Download SMPLH_NEUTRAL.npz..."
wget -nv https://brentyi.github.io/viser-example-assets/SMPLH_NEUTRAL.zip -O "$SCRIPT_DIR/SMPLH_NEUTRAL.zip"
unzip -qo "$SCRIPT_DIR/SMPLH_NEUTRAL.zip" -d "$SCRIPT_DIR"
rm "$SCRIPT_DIR/SMPLH_NEUTRAL.zip"
echo ""

echo "==========================================================="
echo "Download colmap_garden..."
wget -nv https://brentyi.github.io/viser-example-assets/colmap_garden.zip -O "$SCRIPT_DIR/colmap_garden.zip"
unzip -qo "$SCRIPT_DIR/colmap_garden.zip" -d "$SCRIPT_DIR/"  # Already contains a subdirectory.
echo ""

echo "==========================================================="
echo "Download dragon.obj..."
wget -nv https://brentyi.github.io/viser-example-assets/dragon.obj -O "$SCRIPT_DIR/dragon.obj"
echo ""

echo "==========================================================="
echo "Download nike.splat..."
wget -nv https://brentyi.github.io/viser-example-assets/nike.splat -O "$SCRIPT_DIR/nike.splat"
echo ""
