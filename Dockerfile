FROM node:20-bookworm-slim AS web
WORKDIR /app
COPY package*.json tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm ci --no-audit --no-fund && npm run build

FROM python:3.12-slim-trixie
ARG MSSH_URL=https://github.com/KirillShakhov/MultiHopSSH/releases/download/1.2.0/mssh-linux-x86_64
ARG MSSH_SHA256=4098137e1467de8212e82b6d1ae1b3bc761db4a38191510df72b6ac570ed9ca2
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && curl -fL --retry 3 "$MSSH_URL" -o /tmp/mssh \
 && echo "$MSSH_SHA256  /tmp/mssh" | sha256sum -c - \
 && install -m 0755 /tmp/mssh /usr/local/bin/mssh \
 && rm /tmp/mssh \
 && useradd -m -u 10001 -s /bin/sh hopmux \
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
