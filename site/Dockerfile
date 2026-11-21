# Zero-dependency Node server: no packages to fetch, nothing to build.
FROM node:alpine

ENV NODE_ENV=production \
    PORT=3000 \
    LOG_FILE=/data/events.log

WORKDIR /app

COPY server.js stats.sh README.md ./
COPY site ./site

# The node image ships a non-root "node" user; give it the data volume.
RUN mkdir -p /data && chown node:node /data && chmod +x /app/stats.sh

USER node

VOLUME /data
EXPOSE 3000

# Exec form: node is PID 1 and receives SIGTERM directly; server.js
# closes the listener and exits promptly on SIGTERM.
CMD ["node", "server.js"]
