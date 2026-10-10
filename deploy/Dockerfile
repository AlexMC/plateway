# syntax=docker/dockerfile:1.7
# The CAD service with headless Bambu Studio, for linux/amd64. Build from the repository root:
#   docker build --platform linux/amd64 -f deploy/Dockerfile -t plateway .

# Bambu Studio's Linux AppImage, pinned by sha256 and extracted (no FUSE at run time). Keep the version in step with
# cad/tests/fixtures/coupon-slice-reference.json, which the golden-output test checks.
FROM python:3.12-slim-trixie AS bambu
ARG BAMBU_VERSION=v02.08.03.66
ARG BAMBU_APPIMAGE=BambuStudio_ubu24-v02.08.03.66-20260909013025.AppImage
ARG BAMBU_SHA256=711d909a75a3f5778795cc4229fca46efdd0fe6917c1de00ad992a055507739d
ADD --checksum=sha256:${BAMBU_SHA256} \
    https://github.com/bambulab/BambuStudio/releases/download/${BAMBU_VERSION}/${BAMBU_APPIMAGE} /tmp/bambu.AppImage
# Blank the AppImage magic in the ELF padding (bytes 8-10) so binfmt emulation on arm64 build hosts accepts it.
RUN cd /tmp && printf '\0\0\0' | dd of=bambu.AppImage bs=1 seek=8 count=3 conv=notrunc 2>/dev/null \
 && chmod +x bambu.AppImage && ./bambu.AppImage --appimage-extract >/dev/null \
 && rm bambu.AppImage && mv squashfs-root /opt/bambu-studio \
 && rm -rf /opt/bambu-studio/usr/share/doc

FROM python:3.12-slim-trixie AS slicer
# Libraries the slicer links against (the GTK/WebKit/GL stack, after the 3dprint4me recipe). The CLI never opens a
# display, so there is no X server or xvfb.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgtk-3-0t64 libwebkit2gtk-4.1-0 libgl1 libegl1 libglu1-mesa libgstreamer1.0-0 \
      libgstreamer-plugins-base1.0-0 libwayland-client0 libwayland-server0 libdbus-1-3 libfontconfig1 \
      libavcodec61 libavutil59 libswscale8 \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=bambu /opt/bambu-studio /opt/bambu-studio
ENV BAMBU_STUDIO_CLI=/opt/bambu-studio/AppRun

# The browser app (Vite, `base: '/app/'`), built natively on the build host: its output is static files.
FROM --platform=$BUILDPLATFORM node:22-slim AS ui
WORKDIR /ui
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
COPY cad/profiles ./cad/profiles
COPY docs/plans/examples ./docs/plans/examples
RUN npx vite build

# The service's sources, readable by the unprivileged user whatever the checkout's file modes, and owned by root.
# The landing site goes to `/` (its build tools stay out) and the app to `/app/` (`cad/service/app.py`).
FROM --platform=$BUILDPLATFORM busybox:1.36 AS sources
COPY site/index.html site/library.html site/gallery.html site/feedback.html site/styles.css site/favicon.svg \
     site/favicon.ico site/apple-touch-icon.png site/site.webmanifest site/gallery.css site/library.css /out/site/
COPY site/fonts /out/site/fonts
COPY site/hero /out/site/hero
COPY site/img /out/site/img
COPY site/js /out/site/js
COPY site/legal /out/site/legal
COPY cad /out/cad
COPY docs /out/docs
COPY src/plan/plan.schema.json /out/src/plan/plan.schema.json
COPY --from=ui /ui/dist /out/dist
RUN chmod -R u=rwX,go=rX /out

FROM slicer
COPY --from=ghcr.io/astral-sh/uv:0.7.12 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    PATH=/app/.venv/bin:$PATH \
    PYTHONPATH=/app \
    MPLCONFIGDIR=/tmp/matplotlib
RUN useradd --system --uid 10001 --create-home --home-dir /home/plateway --shell /usr/sbin/nologin plateway \
 && install -d -o plateway -g plateway -m 0700 /home/plateway/projects
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project && rm -rf /root/.cache/uv
COPY --from=sources /out/ ./
USER plateway
# The project directory is created above so a named volume mounted on it starts owned by `plateway`.
ENV HOME=/home/plateway TRAIN_PROJECT_DIR=/home/plateway/projects
CMD ["python", "-m", "cad.service.app"]
