FROM alpine:3.20

# Docker CLI + docker compose plugin
RUN apk add --no-cache docker-cli docker-compose

COPY update.sh /update.sh
RUN chmod +x /update.sh

ENTRYPOINT ["/update.sh"]