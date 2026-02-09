# turkey-enterprise-v2 Dockerfile
# Runs the deterministic orchestrator with Claude Code CLI

FROM node:20-alpine

# Install required packages
RUN apk add --no-cache \
    git \
    openssh-client \
    curl \
    bash \
    jq

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy compiled dist and other necessary files
COPY dist/ ./dist/
COPY README.md ./

# Create working directory for projects
RUN mkdir -p /workspace

# Set working directory to workspace for orchestration
WORKDIR /workspace

# Environment variables (set at runtime)
ENV NODE_ENV=production
ENV ANTHROPIC_API_KEY=""
ENV JIRA_HOST=""
ENV JIRA_EMAIL=""
ENV JIRA_TOKEN=""
ENV JIRA_PROJECT=""

# The CLI is run interactively, not as a server
# Entry point allows running any command
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["--help"]
