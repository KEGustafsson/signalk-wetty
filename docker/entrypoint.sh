#!/bin/sh
# Starts sshd (what the terminal connects to) and then the Signal K server in
# the foreground so the container lives and dies with it.
set -e

/usr/sbin/sshd

exec npx signalk-server --sample-nmea0183-data -p 3000
