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

ARG TARGETARCH

WORKDIR /app

# System tools for terminal usage
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    git \
    curl \
    wget \
    vim \
    procps \
    ca-certificates \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Git: mark /workspace as safe so mounted volumes work regardless of owner
RUN git config --global --add safe.directory /workspace \
    && git config --global init.defaultBranch main

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

# Initialize conda for bash so terminal users get conda ready
RUN conda init bash && \
    echo "conda activate base" >> /root/.bashrc

# Copy backend build artifacts + production deps
COPY --from=backend-builder /build/backend/dist ./dist
COPY --from=backend-builder /build/backend/node_modules ./node_modules
COPY --from=backend-builder /build/backend/package.json .

# Copy built frontend
COPY --from=frontend-builder /build/frontend/dist ./static

# Copy users config
COPY users.json ./users.json

# Create default workspace
RUN mkdir -p /workspace

EXPOSE 3000

ENV WORKSPACE_DIR=/workspace
ENV VLLM_API_URL=http://host.docker.internal:8000/v1
ENV VLLM_API_KEY=
ENV MODEL_NAME=default
ENV STATIC_DIR=static
ENV PORT=3000
ENV MAX_AGENT_ITERATIONS=30
ENV AGENT_MAX_TOKENS=8192

CMD ["node", "dist/index.js"]
