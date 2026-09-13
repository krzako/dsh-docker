FROM node:24-alpine

WORKDIR /app

COPY proxy.mjs .

USER node

ENTRYPOINT ["/bin/sh", "-c", "umask 0002; exec \"$@\"", "--"]

CMD ["node", "proxy.mjs", "--fix-plan"]
