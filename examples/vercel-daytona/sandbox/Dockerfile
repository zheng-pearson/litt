FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git unzip python3 build-essential procps ripgrep && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/vellum
COPY source.tar /tmp/vellum-source.tar
RUN tar -xf /tmp/vellum-source.tar -C /opt/vellum && rm /tmp/vellum-source.tar
RUN mkdir -p /app && ln -s /opt/vellum/assistant /app/assistant && ln -s /app/assistant/docker-node-launcher.sh /usr/local/bin/node
RUN bun install --frozen-lockfile
RUN cd /opt/vellum/cli && bun link && cd /opt/vellum/assistant && bun link && cd /opt/vellum/gateway && bun link && cd /opt/vellum/credential-executor && bun link
RUN cd /opt/vellum/meta && bun link @vellumai/cli @vellumai/assistant @vellumai/vellum-gateway @vellumai/credential-executor && bun link
COPY bootstrap.ts /opt/vellum-demo/bootstrap.ts
ENV VELLUM_ENVIRONMENT=local VELLUM_DISABLE_PLATFORM=true
CMD ["sleep", "infinity"]
