FROM alpine:3.22

RUN apk add --no-cache git git-daemon

RUN mkdir -p /opt/git-hooks /repos

COPY entrypoint.sh /usr/local/bin/dsh-git-entrypoint
COPY pre-receive /opt/git-hooks/pre-receive

RUN sed -i 's/\r$//' \
      /usr/local/bin/dsh-git-entrypoint \
      /opt/git-hooks/pre-receive \
    && chmod 0555 \
      /usr/local/bin/dsh-git-entrypoint \
      /opt/git-hooks/pre-receive

ENTRYPOINT ["/usr/local/bin/dsh-git-entrypoint"]
