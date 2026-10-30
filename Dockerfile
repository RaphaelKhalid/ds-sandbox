# Base image: Debian with Node + npm baked in (OpenCode installs via npm).
# Pinned by digest (node:22-bookworm-slim, Node v22.23.4, pulled 2026-10-29) so a rebuild can't silently change it.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

# The tools the agent gets inside the sandbox. Keep it lean; add more later.
# git: read/commit the repo.  ripgrep: fast code search OpenCode uses.
# python3/pip: most recon + security scripts are Python.  curl/ca-certificates: TLS + fetching.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git ripgrep python3 python3-pip curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install the OpenCode CLI globally so any user can run `opencode`.
RUN npm install -g opencode-ai@1.19.5

# Create an unprivileged user. The agent NEVER runs as root in the box.
RUN useradd --create-home --shell /bin/bash agent

# Bake in the OpenCode config as a root-owned, read-only file the agent can read
# but never rewrite. Default = review leash; build with
#   --build-arg DS_CONFIG=opencode.hunt.json
# to bake the hunt leash instead.
ARG DS_CONFIG=opencode.json
COPY ${DS_CONFIG} /home/agent/.config/opencode/opencode.json

# Pin HOME so OpenCode reliably finds the baked config at ~/.config/opencode.
ENV HOME=/home/agent
USER agent

# Where your repo copy gets mounted at run time.
WORKDIR /work

# Default to a shell; we launch opencode by hand once we're inside.
CMD ["bash"]
