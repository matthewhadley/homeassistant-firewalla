#!/bin/bash

docker run \
    --rm \
    --privileged \
    -v "$(pwd)":/data \
    homeassistant/aarch64-builder \
    --all \
    --target firewalla \
    --docker-user $DOCKER_USER \
    --docker-password $DOCKER_PASSWORD
