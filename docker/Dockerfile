# Local integration environment: a Signal K server with this plugin installed
# and a real sshd to connect the terminal to.
#
#   docker compose -f docker/docker-compose.yml up --build
#
# Signal K admin UI  http://localhost:3000  (Webapps → WeTTY Terminal)
# Terminal directly  http://localhost:3001
# Log in with        sailor / signalk

# ── Build the plugin tarball exactly the way npm publish would ──
FROM node:22-bookworm-slim AS build

WORKDIR /plugin
COPY package.json package-lock.json tsconfig.json ./
# --ignore-scripts skips the prepare hook; the build runs explicitly below so a
# failure shows up as a build failure rather than an install failure.
RUN npm ci --ignore-scripts
COPY src ./src
COPY public ./public
COPY README.md CHANGELOG.md ./
RUN npm run build \
    && mkdir -p /out \
    && npm pack --ignore-scripts --pack-destination /out

# ── Signal K server with the plugin and an sshd to talk to ──
FROM node:22-bookworm-slim

ARG SIGNALK_VERSION=latest

# python3/make/g++ are what node-pty needs to compile; openssh-server gives the
# terminal something real to connect to.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        g++ \
        make \
        openssh-server \
        procps \
        python3 \
        sshpass \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && ssh-keygen -A \
    && mkdir -p /run/sshd

# Static analysis flags both of the next two lines, and both are deliberate for
# this image: it is a throwaway local integration environment, rebuilt from
# scratch on every `docker compose up --build` and never published. The fixed
# password exists so the terminal has something to log into, and there is no
# USER directive because sshd needs root to open login sessions for `sailor`.
# Neither is a pattern to copy into a real deployment.
RUN useradd --create-home --shell /bin/bash sailor \
    && echo 'sailor:signalk' | chpasswd

ENV SIGNALK_NODE_CONFIG_DIR=/opt/signalk
WORKDIR /opt/signalk

RUN npm init -y > /dev/null \
    && npm install "signalk-server@${SIGNALK_VERSION}"

COPY --from=build /out/*.tgz /tmp/signalk-wetty.tgz
RUN npm install /tmp/signalk-wetty.tgz && rm /tmp/signalk-wetty.tgz

COPY docker/plugin-config.json /opt/signalk/plugin-config-data/signalk-wetty.json
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000 3001

# tini reaps the ssh child processes the terminal spawns.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
