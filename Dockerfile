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
  && cursor_agent_dir="$(dirname "$(readlink -f /root/.local/bin/cursor-agent)")" \
  && mkdir -p /opt/cursor-agent \
  && cp -R "${cursor_agent_dir}/." /opt/cursor-agent/ \
  && ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent \
  && ln -sf /usr/local/bin/cursor-agent /usr/local/bin/agent

ENV PATH="/root/.local/bin:/root/.cursor/bin:/root/.cursor/cli/bin:${PATH}"

WORKDIR /workspace
