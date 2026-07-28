FROM node:22-bookworm-slim@sha256:d415caac2f1f77b98caaf9415c5f807e14bc8d7bdea62561ea2fef4fbd08a73c

LABEL org.opencontainers.image.source=https://github.com/RobertTLange/headless-cli

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /headless-home && chown node:node /headless-home

RUN npm install -g \
  @anthropic-ai/claude-code@2.1.119 \
  @google/gemini-cli@0.39.1 \
  @mariozechner/pi-coding-agent@0.70.2 \
  @openai/codex@0.125.0 \
  opencode-ai@1.14.25

ARG TARGETARCH
ARG CURSOR_AGENT_VERSION=2026.04.17-787b533
ARG CURSOR_AGENT_SHA256_AMD64=942b2b583239497715f2390336eb8e2df3673703bd167bd59f7be33a27e15c5a
ARG CURSOR_AGENT_SHA256_ARM64=985191ffc606da1317e1399f99306481f58643f345ed2252033b011504c780ce
ARG AGY_VERSION=1.1.8
ARG AGY_SHA256_AMD64=e92e6215532b3ce84455e341944067753ad90f6d24cebcec8002ce137e5162ce
ARG AGY_SHA256_ARM64=e75cebb03fce0fcad7d3bb682eb84c356a3c50ff8fb3dc4a89d2051f34fca0ab

RUN set -eu; \
  case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
    amd64) cursor_arch="x64"; cursor_sha256="${CURSOR_AGENT_SHA256_AMD64}" ;; \
    arm64) cursor_arch="arm64"; cursor_sha256="${CURSOR_AGENT_SHA256_ARM64}" ;; \
    *) echo "unsupported Cursor Agent architecture: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
  esac; \
  cursor_tarball="/tmp/cursor-agent.tar.gz"; \
  curl "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${cursor_arch}/agent-cli-package.tar.gz" -fsSL -o "${cursor_tarball}"; \
  echo "${cursor_sha256}  ${cursor_tarball}" | sha256sum -c -; \
  mkdir -p /opt/cursor-agent \
  && tar --strip-components=1 -xzf "${cursor_tarball}" -C /opt/cursor-agent \
  && rm -f "${cursor_tarball}" \
  && ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent \
  && ln -sf /usr/local/bin/cursor-agent /usr/local/bin/agent

RUN set -eu; \
  case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
    amd64) agy_file="agy_cli_linux_x64.tar.gz"; agy_sha256="${AGY_SHA256_AMD64}" ;; \
    arm64) agy_file="agy_cli_linux_arm64.tar.gz"; agy_sha256="${AGY_SHA256_ARM64}" ;; \
    *) echo "unsupported Antigravity CLI architecture: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
  esac; \
  agy_tarball="/tmp/agy.tar.gz"; \
  curl "https://github.com/google-antigravity/antigravity-cli/releases/download/${AGY_VERSION}/${agy_file}" -fsSL -o "${agy_tarball}"; \
  echo "${agy_sha256}  ${agy_tarball}" | sha256sum -c -; \
  tar -xzf "${agy_tarball}" -C /tmp antigravity; \
  install -m 0755 /tmp/antigravity /usr/local/bin/agy; \
  rm -f "${agy_tarball}" /tmp/antigravity

ENV AGY_CLI_DISABLE_AUTO_UPDATE=true
ENV PATH="/home/node/.local/bin:/home/node/.cursor/bin:/home/node/.cursor/cli/bin:/headless-home/.local/bin:/headless-home/.cursor/bin:/headless-home/.cursor/cli/bin:/root/.local/bin:/root/.cursor/bin:/root/.cursor/cli/bin:${PATH}"

WORKDIR /workspace
