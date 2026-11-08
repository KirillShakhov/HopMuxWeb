FROM node:20-bookworm-slim AS web
WORKDIR /app
COPY package*.json tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm ci --no-audit --no-fund && npm run build

FROM python:3.12-slim-trixie
ARG MSSH_URL=https://github.com/KirillShakhov/HopMux/releases/download/1.1.0/mssh-linux-x86_64.tar.gz
ARG MSSH_SHA256=7e9a377a0b63e678074015c35e87f458f3386693c14c585d05b32c6a7a2c04ee
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar && rm -rf /var/lib/apt/lists/* \
 && curl -fL --retry 3 "$MSSH_URL" -o /tmp/mssh.tar.gz \
 && echo "$MSSH_SHA256  /tmp/mssh.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/mssh.tar.gz -C /tmp mssh-linux-x86_64/mssh \
 && install -m 0755 /tmp/mssh-linux-x86_64/mssh /usr/local/bin/mssh \
 && rm -rf /tmp/mssh* \
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
