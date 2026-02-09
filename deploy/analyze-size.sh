#!/bin/bash
#
# analyze-size.sh - Use Claude to recommend droplet size based on project complexity
#
# Usage: ./analyze-size.sh <prompt.md>
# Output: Prints recommended size slug (e.g., s-2vcpu-4gb)
#
# Requires: ANTHROPIC_API_KEY environment variable

set -e

PROMPT_FILE="$1"

# Validate input
if [ -z "$PROMPT_FILE" ]; then
    echo "Usage: ./analyze-size.sh <prompt.md>" >&2
    exit 1
fi

if [ ! -f "$PROMPT_FILE" ]; then
    echo "Error: File not found: $PROMPT_FILE" >&2
    exit 1
fi

if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "Error: ANTHROPIC_API_KEY not set" >&2
    exit 1
fi

# Check for jq
if ! command -v jq >/dev/null 2>&1; then
    echo "Warning: jq not found, using default size" >&2
    echo "s-2vcpu-4gb"
    exit 0
fi

# Read prompt content (truncate to first 2000 chars to avoid arg limits)
PROMPT_CONTENT=$(head -c 2000 "$PROMPT_FILE")

# Create temp file for request body
TMPFILE=$(mktemp)
trap "rm -f $TMPFILE" EXIT

# Build JSON request using jq (handles all escaping properly)
jq -n \
    --arg content "Analyze this project prompt and recommend a DigitalOcean droplet size for running Claude Code to build it.

Consider:
- Number of features/sprints likely needed
- Technical complexity (microservices, real-time, etc.)
- Expected build duration

Available sizes:
- s-1vcpu-2gb (\$12/mo) - Simple apps: todo lists, basic CRUD, 1-2 sprints
- s-2vcpu-4gb (\$24/mo) - Medium apps: dashboards, auth systems, 3-5 sprints
- s-4vcpu-8gb (\$48/mo) - Complex apps: microservices, real-time, ML, 6+ sprints

Reply with ONLY the size slug, nothing else. Example: s-2vcpu-4gb

Project prompt:
$PROMPT_CONTENT" \
    '{
        model: "claude-sonnet-4-20250514",
        max_tokens: 50,
        messages: [{
            role: "user",
            content: $content
        }]
    }' > "$TMPFILE"

# Call Claude API using temp file for data
RESPONSE=$(curl -s https://api.anthropic.com/v1/messages \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d @"$TMPFILE")

# Check for errors
if echo "$RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
    ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error.message')
    echo "Error from Claude API: $ERROR_MSG" >&2
    echo "s-2vcpu-4gb"  # Default on error
    exit 0
fi

# Extract the size from response
SIZE=$(echo "$RESPONSE" | jq -r '.content[0].text' 2>/dev/null | tr -d '[:space:]')

# Validate it's a known size
case "$SIZE" in
    s-1vcpu-2gb|s-2vcpu-4gb|s-4vcpu-8gb)
        echo "$SIZE"
        ;;
    *)
        # Default if parsing fails or unknown size
        echo "s-2vcpu-4gb"
        ;;
esac
