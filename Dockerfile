FROM node:20-bookworm-slim AS web
WORKDIR /app
COPY package*.json tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm ci --no-audit --no-fund && npm run build

FROM rust:1.95-trixie AS cli
WORKDIR /mssh
ARG MSSH_SOURCE=https://codeload.github.com/KirillShakhov/MultiHopSSH/tar.gz/3d204a367869b98232c4398b5452d5da200d9885
ARG MSSH_SHA256=5b4e633239fbfd05c405a57bac02398e9c2ab1078f84c7d59c52e0be60fd6e9f
RUN curl -fL --retry 3 "$MSSH_SOURCE" -o /tmp/mssh.tar.gz \
 && echo "$MSSH_SHA256  /tmp/mssh.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/mssh.tar.gz --strip-components=1
COPY patches/mssh-list.patch /tmp/mssh-list.patch
RUN patch -p1 < /tmp/mssh-list.patch && cargo build --locked --release

FROM python:3.12-slim-trixie
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=cli /mssh/target/release/mssh /usr/local/bin/mssh
ARG HOPMUX_UID=10001
ARG HOPMUX_GID=10001
RUN groupadd -g "$HOPMUX_GID" hopmux \
 && useradd -m -u "$HOPMUX_UID" -g hopmux -s /bin/sh hopmux \
 && mkdir -p /data /files /config && chown -R hopmux:hopmux /data /files /config
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server ./server
COPY --from=web /app/dist ./dist
ENV HOPMUX_CONFIG=/config/config.toml HOPMUX_DATA=/data HOPMUX_FILES=/files HOPMUX_BIND=0.0.0.0 HOPMUX_PORT=8000 HOME=/home/hopmux
USER hopmux
EXPOSE 8000
CMD ["python", "-m", "server"]
