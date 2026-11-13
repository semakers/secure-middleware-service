# Development + test image for working on the service (not the production image).
# Fedora base (Chromium works on 4K *and* 16K page kernels, e.g. Asahi Linux) with the
# OFFICIAL Node.js 24 build: Fedora's nodejs24 links the system ICU and segfaults in
# Intl.Segmenter (used by eslint-plugin-regexp), the official build bundles its own ICU,
# exactly like the node:24-alpine production image. Chromium is only used to print docs
# (PROMPT_LOG.md -> PDF) and ffmpeg to render the asciinema demo to MP4.
FROM docker.io/library/fedora:43

RUN dnf -y install --setopt=install_weak_deps=False \
      chromium chromium-headless \
      ffmpeg-free \
      git util-linux procps-ng which findutils jq curl \
      google-noto-sans-fonts google-noto-sans-mono-fonts google-noto-emoji-fonts dejavu-sans-fonts \
    && dnf clean all

ARG NODE_VERSION=24.22.3
ARG NODE_SHA256=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c
RUN curl -sSfLo /tmp/node.tar.xz https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 && rm /tmp/node.tar.xz \
    && node --version && npm --version
ENV PATH=/opt/node/bin:$PATH

RUN fc-cache -f >/dev/null && echo 'umask 022' > /etc/profile.d/umask.sh

ENV CHROMIUM_PATH=/usr/lib64/chromium-browser/headless_shell

WORKDIR /work
# Run with `--init` so child processes are reaped.
CMD ["sleep", "infinity"]
