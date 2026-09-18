# Durable Streams server, self-hosted with the Caddy plugin.
# https://durablestreams.com/deployment#self-hosted-with-caddy
#
# Durable Streams is MIT licensed (Copyright (c) 2025 durable-stream) and the
# binary bundles Caddy (Apache-2.0); see THIRD-PARTY-LICENSES at the repo root.
#
# The project ships the production server as a Caddy-plugin binary rather
# than a container image, so the first stage downloads the release tarball for
# the target architecture; the runtime stage follows the layout from the docs
# (debian-slim, binary in /usr/local/bin, Caddyfile in /etc/durable-streams).
#
# Stream data lives in /data. On Fargate that is ephemeral task storage, which
# is fine here: streams carry live assessment output, and the durable artefacts
# (reports) are persisted to Postgres/S3 by the API when a run completes.

# Only tags of the form v<version> that publish server binaries work; check
# https://github.com/durable-streams/durable-streams/releases before bumping.
ARG DS_VERSION=0.3.0

FROM debian:bookworm-slim AS download
ARG DS_VERSION
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && curl -fsSL \
    "https://github.com/durable-streams/durable-streams/releases/download/v${DS_VERSION}/durable-streams-server_${DS_VERSION}_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /tmp durable-streams-server \
  && chmod +x /tmp/durable-streams-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system durable-streams \
  && useradd --system --gid durable-streams --create-home --home-dir /home/durable-streams durable-streams \
  && mkdir -p /data && chown durable-streams:durable-streams /data
COPY --from=download /tmp/durable-streams-server /usr/local/bin/durable-streams-server
COPY Caddyfile /etc/durable-streams/Caddyfile
USER durable-streams
VOLUME /data
EXPOSE 4437
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4437/health || exit 1
CMD ["durable-streams-server", "run", "--config", "/etc/durable-streams/Caddyfile"]
