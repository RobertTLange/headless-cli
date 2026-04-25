FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
  @anthropic-ai/claude-code \
  @google/gemini-cli \
  @mariozechner/pi-coding-agent \
  @openai/codex \
  opencode-ai

RUN curl https://cursor.com/install -fsS | bash \
  && if command -v cursor-agent >/dev/null 2>&1 && ! command -v agent >/dev/null 2>&1; then \
    ln -s "$(command -v cursor-agent)" /usr/local/bin/agent; \
  fi

ENV PATH="/root/.local/bin:/root/.cursor/bin:/root/.cursor/cli/bin:${PATH}"

WORKDIR /workspace
