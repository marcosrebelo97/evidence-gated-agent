# Test image for the container suite: git, node and the fake agent, nothing else.
FROM node:22-alpine
RUN apk add --no-cache git
COPY fake-agent.mjs /opt/fake-agent.mjs
