FROM node:24-alpine

WORKDIR /app

COPY proxy.mjs .

USER node

CMD ["node", "proxy.mjs", "--fix-plan"]
