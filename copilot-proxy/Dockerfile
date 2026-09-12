FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV PATH=/app/node_modules/.bin:$PATH HOME=/home/node COPILOT_HOME=/home/node/.copilot
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /home/node/.copilot /app/logs/copilot-proxy && chown -R node:node /home/node/.copilot /app/logs
USER node
EXPOSE 9090
CMD ["/entrypoint.sh"]
