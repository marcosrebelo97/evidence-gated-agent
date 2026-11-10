# Image where the agent, the setup and the gates on its commit run in container mode.
# Build: docker build -f docker/runner.Dockerfile -t evidence-gated-agent-runner docker/
#
# It holds tools only: the repository, the contract directory and a throwaway HOME are
# bind-mounted per run, and the container runs as the host user with a read-only root.
# Add here whatever the target project's gates need (another Node version, Python, a CA).
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Pinned: an upgrade is a deliberate change to the image, never an update during a run.
ARG CLAUDE_CODE_VERSION=2.1.322
RUN npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

ENV DISABLE_AUTOUPDATER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
