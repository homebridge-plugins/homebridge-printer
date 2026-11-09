#!/bin/sh
# Print command for CUPS ippeveprinter (-c test/printcmd.sh): reports HP-style ink levels
# (a tri-colour and a black cartridge) and takes ~8 s per job, so tests can see "printing".
echo "ATTR: marker-names=\"Tri-color Cartridge\",\"Black Cartridge\" marker-colors=#00FFFF#FF00FF#FFFF00,#000000 marker-levels=60,8 marker-low-levels=10,10 marker-high-levels=100,100 marker-types=ink-cartridge,ink-cartridge" >&2
sleep 8
