#!/bin/sh
# Starts sshd (what the terminal connects to) and then the Signal K server in
# the foreground so the container lives and dies with it.
set -e

/usr/sbin/sshd

# signalk-server takes its listen port from PORT (src/ports.ts); it has no -p
# flag, so passing one silently leaves the server on its default port.
export PORT=3000
exec npx signalk-server --sample-nmea0183-data
