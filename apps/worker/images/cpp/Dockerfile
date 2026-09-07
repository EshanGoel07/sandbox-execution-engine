# Minimal C++ runtime for the judge: Debian "bookworm" base with gcc/g++
# already installed.
FROM gcc:13-bookworm

# Defense in depth: even though this container gets --network=none and
# cgroup limits from the runner, we still don't want the submitted program
# running as root inside the container. If something ever escapes the
# process boundary (a Docker CVE, a misconfiguration), non-root inside is
# one more wall it has to climb.
RUN useradd -m -u 10001 -s /usr/sbin/nologin coderunner \
    && mkdir -p /sandbox \
    && chown coderunner:coderunner /sandbox

WORKDIR /sandbox
USER coderunner
