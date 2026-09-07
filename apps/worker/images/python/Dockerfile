# Minimal Python runtime for the judge.
# python:3.12-alpine: no compile step needed for Python, so we want the
# smallest possible interpreter image. Alpine uses musl libc instead of
# glibc and has none of Debian's extra tooling — smallest attack surface
# of the three images.
FROM python:3.12-alpine

RUN adduser -D -u 10001 coderunner \
    && mkdir -p /sandbox \
    && chown coderunner:coderunner /sandbox

WORKDIR /sandbox
USER coderunner
