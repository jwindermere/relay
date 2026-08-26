#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$RELAY_TEST_COMMAND_LOG"
