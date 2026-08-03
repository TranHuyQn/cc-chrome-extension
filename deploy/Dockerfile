FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/*.js ./
EXPOSE 8787
ENV CC_CHROME_MODE=http
ENV CC_CHROME_PORT=8787
CMD ["node", "index.js", "--http"]
