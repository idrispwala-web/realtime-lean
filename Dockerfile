FROM node:22-alpine
WORKDIR /app
COPY .claude-plugin/plugin.json .claude-plugin/plugin.json
COPY mcp mcp
COPY skills skills
EXPOSE 8787
USER node
# Traefik only routes to a container whose Docker health is "healthy"; a short interval keeps the
# redeploy gap (during which /lean falls through to the n8n router) to a few seconds.
HEALTHCHECK --interval=5s --timeout=3s --start-period=2s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "mcp/server.mjs", "--http", "8787"]
