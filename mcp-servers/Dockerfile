FROM europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:1.0.43

# Copy all MCP server dist files and node_modules
COPY config /mcp-servers/config
COPY database /mcp-servers/database
COPY deployment /mcp-servers/deployment
COPY kubernetes /mcp-servers/kubernetes
COPY logs /mcp-servers/logs
COPY metrics /mcp-servers/metrics
