# Egress proxy: the only container on both the internal sandbox network and the internet.
# It forwards HTTPS (CONNECT on 443) to hosts in allow.txt and refuses everything else.
# Pinned by digest (debian:bookworm-slim, pulled 2026-10-29).
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3

RUN apt-get update \
    && apt-get install -y --no-install-recommends tinyproxy \
    && rm -rf /var/lib/apt/lists/*

COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY allow.txt /etc/tinyproxy/allow.txt

# Runs unprivileged; 8888 needs no capabilities. Logs (including refusals) go to stdout: `docker logs ds-proxy`.
USER nobody
EXPOSE 8888
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
