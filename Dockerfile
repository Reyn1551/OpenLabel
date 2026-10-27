# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies first so the layer is reused while source changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src

# GitHub Pages needs a subpath; a self-hosted container serves the root.
ARG VITE_BASE=/
ENV VITE_BASE=${VITE_BASE}
# `vite build` only: the image does not copy tests/ or playwright.config.ts,
# which tsconfig references. The CI "Lint, test, build" job type-checks the
# full repository, so the image skips the redundant tsc pass.
RUN npx vite build

# ---- serve -----------------------------------------------------------------
# Unprivileged nginx listens on 8080 and runs as uid 101.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
USER 101:101

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

LABEL org.opencontainers.image.title="OpenLabel" \
      org.opencontainers.image.description="Local-first image annotation studio with few-shot auto-labeling" \
      org.opencontainers.image.source="https://github.com/Reyn1551/OpenLabel" \
      org.opencontainers.image.licenses="Apache-2.0"