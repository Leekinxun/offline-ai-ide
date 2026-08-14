# ============================================================
# Stage 1: Build frontend
# ============================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --prefer-offline --no-audit
COPY frontend/ .
RUN npm run build

# ============================================================
# Stage 2: Build backend (need native deps for node-pty)
# ============================================================
FROM node:20-slim AS backend-builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /build/backend
COPY backend/package.json backend/package-lock.json* ./
RUN npm install
COPY backend/ .
RUN npx tsc

# ============================================================
# Stage 3: Runtime — Node.js + Conda + tools
# ============================================================
FROM node:20-slim

ARG PIP_INDEX_URL
ARG PIP_EXTRA_INDEX_URL
ARG PIP_TRUSTED_HOST
ARG RUFF_VERSION=0.15.22

WORKDIR /app

# System tools for terminal usage
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    bubblewrap \
    git \
    curl \
    grep \
    wget \
    vim \
    procps \
    ca-certificates \
    build-essential \
    python3 \
    && test "$(command -v bwrap)" = /usr/bin/bwrap \
    && rm -rf /var/lib/apt/lists/*

# Git: mark /workspace as safe so mounted volumes work regardless of owner.
# System scope makes this available to the unprivileged runtime account.
RUN git config --system --add safe.directory /workspace \
    && git config --system init.defaultBranch main

# Install Miniconda
RUN if [ "$TARGETARCH" = "arm64" ] || [ "$(uname -m)" = "aarch64" ]; then \
      CONDA_URL="https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-aarch64.sh"; \
    else \
      CONDA_URL="https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh"; \
    fi && \
    wget -qO /tmp/miniconda.sh "$CONDA_URL" && \
    bash /tmp/miniconda.sh -b -p /opt/conda && \
    rm /tmp/miniconda.sh && \
    /opt/conda/bin/conda clean -afy

ENV PATH="/opt/conda/bin:$PATH"

RUN conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main && \
    conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r

# Install Python tooling in the default Conda environment used by the web
# terminal. Ruff is downloaded directly from the official PyPI file host so a
# partial internal package index cannot hide its platform wheels.
COPY requirements.txt ./requirements.txt
RUN export TARGETARCH=${TARGETARCH:-$(uname -m)}; \
    /opt/conda/bin/python -m pip install --no-cache-dir -r requirements.txt; \
    if [ "$TARGETARCH" = "arm64" ] || [ "$(uname -m)" = "aarch64" ]; then \
      RUFF_WHEEL="ruff-${RUFF_VERSION}-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.whl"; \
      RUFF_URL="https://files.pythonhosted.org/packages/1e/cc/44eaaf0844e028182f2d0a8f2190d0f359159aed0a9e5ab861d892f1ae2a/$RUFF_WHEEL"; \
      RUFF_SHA256="742a29cf29bddb7c8327895d6a10e0e6c5b38a96dd407af9b5d0857f809c0576"; \
    else \
      RUFF_WHEEL="ruff-${RUFF_VERSION}-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"; \
      RUFF_URL="https://files.pythonhosted.org/packages/f6/f9/a0d4871d12fae702eb1f41b686caf05f1f8b124dc6db6f784f53d74918fa/$RUFF_WHEEL"; \
      RUFF_SHA256="365523eb91d9224e1bcb03b022fbf0facb8f9e23792a2c53d9d4b3924bdbdebb"; \
    fi; \
    wget -qO "/tmp/$RUFF_WHEEL" "$RUFF_URL"; \
    echo "$RUFF_SHA256  /tmp/$RUFF_WHEEL" | sha256sum -c -; \
    /opt/conda/bin/python -m pip install --no-cache-dir --no-index "/tmp/$RUFF_WHEEL"; \
    rm "/tmp/$RUFF_WHEEL"; \
    /opt/conda/bin/ruff --version; \
    /opt/conda/bin/python -c "import debugpy; print(debugpy.__version__)"

# Copy backend build artifacts + production deps
COPY --from=backend-builder /build/backend/dist ./dist
COPY --from=backend-builder /build/backend/node_modules ./node_modules
COPY --from=backend-builder /build/backend/package.json .

# Copy built frontend
COPY --from=frontend-builder /build/frontend/dist ./static

# Copy shipped external plugins so Docker images work out of the box.
# Runtime state is deliberately kept outside the read-only application tree.
COPY --chown=10001:10001 plugins ./plugins
COPY --chown=10001:10001 users.json ./config/users.json
COPY --chown=10001:10001 app-settings.json ./config/app-settings.json
COPY scripts/docker-entrypoint.sh /usr/local/bin/crownforge-entrypoint
RUN chmod 0755 /usr/local/bin/crownforge-entrypoint

# The service and the terminal/agent subprocesses run as this dedicated account.
# /workspace and /app/config are the only persistent writable locations; /tmp is
# supplied as tmpfs by Compose (and the smoke test) when the root filesystem is read-only.
RUN groupadd --gid 10001 crewforge \
    && useradd --uid 10001 --gid crewforge --create-home --shell /bin/bash crewforge \
    && mkdir -p /workspace /app/plugins /app/config \
    && chown -R crewforge:crewforge /workspace /app/plugins /app/config /home/crewforge \
    && printf '%s\n' \
      '. /opt/conda/etc/profile.d/conda.sh' \
      'conda activate base' \
      >> /home/crewforge/.bashrc

EXPOSE 3000

ENV WORKSPACE_DIR=/workspace
ENV USERS_CONFIG=/app/config/users.json
ENV APP_SETTINGS_CONFIG=/app/config/app-settings.json
ENV HOME=/home/crewforge
ENV TMPDIR=/tmp
ENV DEBUGPY_PYTHON_EXECUTABLE=/opt/conda/bin/python
ENV VLLM_API_URL=http://host.docker.internal:8000/v1
ENV VLLM_API_KEY=
ENV MODEL_NAME=default
ENV STATIC_DIR=static
ENV PORT=3000
ENV MAX_AGENT_ITERATIONS=30
ENV AGENT_MAX_TOKENS=8192

USER 10001:10001

ENTRYPOINT ["/usr/local/bin/crownforge-entrypoint"]
CMD ["node", "dist/index.js"]
