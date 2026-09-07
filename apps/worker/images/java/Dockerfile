# Minimal Java runtime for the judge.
# eclipse-temurin is the standard OpenJDK distribution image; -jdk (not -jre)
# because we need javac to compile submissions, not just the JVM to run them.
FROM eclipse-temurin:21-jdk-jammy

RUN useradd -m -u 10001 -s /usr/sbin/nologin coderunner \
    && mkdir -p /sandbox \
    && chown coderunner:coderunner /sandbox

WORKDIR /sandbox
USER coderunner
