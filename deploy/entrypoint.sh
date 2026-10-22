#!/bin/sh
set -eu
# The server applies pending migrations before accepting connections.
exec node src/server.js
