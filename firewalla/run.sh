#!/usr/bin/with-contenv bashio

# add date to default bashio log timestamp
declare __BASHIO_LOG_TIMESTAMP="%Y-%m-%d %T"

FIREWALLA_VERSION=$(cat VERSION)
FIREWALLA_IP="$(bashio::config 'firewalla_ip')"
FIREWALLA_PUBLIC_KEY_STRING="$(bashio::config 'public_key_string')"
FIREWALLA_PRIVATE_KEY_STRING="$(bashio::config 'private_key_string')"
FIREWALLA_INTERVAL="$(bashio::config 'interval')"
FIREWALLA_DEBUG="$(bashio::config 'debug')"

export FIREWALLA_VERSION
export FIREWALLA_IP
export FIREWALLA_PUBLIC_KEY_STRING
export FIREWALLA_PRIVATE_KEY_STRING
export FIREWALLA_INTERVAL
export FIREWALLA_DEBUG

bashio::log.info "Starting node service."
npm run --silent start

