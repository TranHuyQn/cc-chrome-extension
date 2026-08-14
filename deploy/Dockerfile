FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/*.js ./
EXPOSE 8787
ENV CC_CHROME_MODE=http
ENV CC_CHROME_PORT=8787
# The server now defaults to loopback (127.0.0.1) so a local single-user
# install is safe out of the box. This container is the shared-VPS case
# behind Caddy (see deploy/), so it opts back in to listening on all
# interfaces — otherwise Caddy could never reach it.
ENV CC_CHROME_HOST=0.0.0.0
CMD ["node", "index.js", "--http"]
