# Development + test image for working on the service (not the production image).
# Node 24 on Fedora: it runs reliably on 4K *and* 16K page kernels (Apple Silicon /
# Asahi Linux). Chromium is only used to print docs (PROMPT_LOG.md -> PDF) and
# ffmpeg to render the asciinema demo to MP4.
FROM docker.io/library/fedora:43

RUN dnf -y install --setopt=install_weak_deps=False \
      nodejs24 nodejs24-npm \
      chromium chromium-headless \
      ffmpeg-free \
      git util-linux procps-ng which findutils jq curl \
      google-noto-sans-fonts google-noto-sans-mono-fonts google-noto-emoji-fonts dejavu-sans-fonts \
    && dnf clean all \
    && for b in node npm npx; do [ -e /usr/bin/$b ] || ln -s /usr/bin/$b-24 /usr/bin/$b; done \
    && node --version && npm --version

RUN fc-cache -f >/dev/null && echo 'umask 022' > /etc/profile.d/umask.sh

ENV CHROMIUM_PATH=/usr/lib64/chromium-browser/headless_shell

WORKDIR /work
# Run with `--init` so child processes are reaped.
CMD ["sleep", "infinity"]
