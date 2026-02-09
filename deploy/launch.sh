#!/bin/bash
#
# launch.sh - End-to-end launcher for turkey-enterprise-v3
#
# Takes a project prompt.md, analyzes complexity, deploys appropriate
# droplet, and runs the orchestration.
#
# Usage: ./launch.sh <prompt.md> [options]
#
# Options:
#   --size <size>     Override auto-detected size
#   --name <name>     Custom droplet name (default: auto-derived from prompt heading)
#   --skip-analyze    Skip AI analysis, use default size
#   --dry-run         Show what would happen without executing
#   --destroy         Destroy droplet after completion
#   --login           Open interactive SSH to login to Claude Max before building
#
# Requires:
#   - ANTHROPIC_API_KEY environment variable
#   - doctl CLI authenticated
#   - SSH key in DigitalOcean

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${GREEN}[launch]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
error() { echo -e "${RED}[error]${NC} $1"; exit 1; }
info() { echo -e "${BLUE}[info]${NC} $1"; }

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# SSH configuration
SSH_KEY_FILE="${SSH_KEY_FILE:-$HOME/.ssh/id_deploy}"
SSH_OPTS="-o StrictHostKeyChecking=no -o IdentityFile=$SSH_KEY_FILE"

# Defaults
PROMPT_FILE=""
SIZE_OVERRIDE=""
SKIP_ANALYZE=false
DRY_RUN=false
DESTROY_AFTER=false
USE_TMUX=true
LOGIN_FIRST=false
DROPLET_NAME=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --size)
            SIZE_OVERRIDE="$2"
            shift 2
            ;;
        --skip-analyze)
            SKIP_ANALYZE=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --destroy)
            DESTROY_AFTER=true
            shift
            ;;
        --no-tmux)
            USE_TMUX=false
            shift
            ;;
        --login)
            LOGIN_FIRST=true
            shift
            ;;
        --name)
            DROPLET_NAME="$2"
            shift 2
            ;;
        -*)
            error "Unknown option: $1"
            ;;
        *)
            PROMPT_FILE="$1"
            shift
            ;;
    esac
done

# Banner
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║         TURKEY ENTERPRISE V3 - LAUNCHER                  ║"
echo "║                                                          ║"
echo "║  prompt.md → analyze → deploy → build                    ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Validate prompt file first
[ -z "$PROMPT_FILE" ] && error "Usage: ./launch.sh <prompt.md> [options]"
[ ! -f "$PROMPT_FILE" ] && error "File not found: $PROMPT_FILE"

# Load .env if present (before checking for API key)
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
    log "Loaded environment from .env"
fi

# Check for required env vars (skip API key check if using --login for Claude Max auth)
if [ "$LOGIN_FIRST" = false ] && [ -z "$ANTHROPIC_API_KEY" ]; then
    error "ANTHROPIC_API_KEY not set. Export it, add to deploy/.env, or use --login for Claude Max auth"
fi

# Check doctl
command -v doctl >/dev/null 2>&1 || error "doctl not found. Install: https://docs.digitalocean.com/reference/doctl/"
doctl account get >/dev/null 2>&1 || error "doctl not authenticated. Run: doctl auth init"

# Extract project name from prompt (first heading or first line)
PROJECT_NAME=$(grep -m1 '^#' "$PROMPT_FILE" | sed 's/^#\+\s*//' || head -1 "$PROMPT_FILE")
log "Project: $PROJECT_NAME"

# Auto-derive droplet name from project heading if not explicitly set
if [ -z "$DROPLET_NAME" ]; then
    DROPLET_NAME=$(echo "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' \
        | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//' \
        | sed 's/-$//' | cut -c1-63)
    DROPLET_NAME="${DROPLET_NAME:-turkey-enterprise-v3}"
fi
log "Droplet name: $DROPLET_NAME"

# ============================================================
# STEP 1: Analyze and determine size
# ============================================================

if [ -n "$SIZE_OVERRIDE" ]; then
    SIZE="$SIZE_OVERRIDE"
    log "Using override size: $SIZE"
elif [ "$SKIP_ANALYZE" = true ] || ([ "$LOGIN_FIRST" = true ] && [ -z "$ANTHROPIC_API_KEY" ]); then
    echo ""
    echo "Select droplet size:"
    echo "  1) s-1vcpu-2gb  - 2GB RAM, 1 vCPU (\$12/mo) - Light"
    echo "  2) s-2vcpu-4gb  - 4GB RAM, 2 vCPU (\$24/mo) - Medium"
    echo "  3) s-4vcpu-8gb  - 8GB RAM, 4 vCPU (\$48/mo) - Heavy"
    echo ""
    read -p "Choice [1-3]: " SIZE_CHOICE
    case "$SIZE_CHOICE" in
        1) SIZE="s-1vcpu-2gb" ;;
        3) SIZE="s-4vcpu-8gb" ;;
        *) SIZE="s-2vcpu-4gb" ;;
    esac
    log "Selected size: $SIZE"
else
    log "Analyzing prompt complexity..."
    SIZE=$("$SCRIPT_DIR/analyze-size.sh" "$PROMPT_FILE")
    log "Recommended size: $SIZE"
fi

# Show size details
case "$SIZE" in
    s-1vcpu-2gb)
        info "Size: 2GB RAM, 1 vCPU (\$12/mo) - Light workload"
        ;;
    s-2vcpu-4gb)
        info "Size: 4GB RAM, 2 vCPU (\$24/mo) - Medium workload"
        ;;
    s-4vcpu-8gb)
        info "Size: 8GB RAM, 4 vCPU (\$48/mo) - Heavy workload"
        ;;
esac

# Dry run check
if [ "$DRY_RUN" = true ]; then
    echo ""
    warn "DRY RUN - Would execute:"
    echo "  Droplet name: $DROPLET_NAME"
    echo "  1. Deploy droplet with size: $SIZE"
    echo "  2. Upload prompt: $PROMPT_FILE"
    echo "  3. Run: turkey-enterprise-v3 run \"$PROJECT_NAME\" --spec prompt.md"
    [ "$DESTROY_AFTER" = true ] && echo "  4. Destroy droplet after completion"
    exit 0
fi

# ============================================================
# STEP 2: Deploy droplet
# ============================================================

log "Deploying droplet..."
"$SCRIPT_DIR/deploy.sh" --size "$SIZE" --name "$DROPLET_NAME"

# Get droplet IP
sleep 2
DROPLET_IP=$(doctl compute droplet list --format Name,PublicIPv4 --no-header \
    | grep "^${DROPLET_NAME} " | awk '{print $2}' || true)

[ -z "$DROPLET_IP" ] && error "Could not get droplet IP"
log "Droplet IP: $DROPLET_IP"

# Quick SSH check (deploy.sh already verified SSH works)
if ! ssh -o ConnectTimeout=10 $SSH_OPTS root@"$DROPLET_IP" "echo ok" 2>/dev/null; then
    warn "SSH check failed, but continuing anyway..."
fi

# ============================================================
# STEP 3: Upload prompt and environment
# ============================================================

log "Uploading prompt file..."
scp $SSH_OPTS "$PROMPT_FILE" root@"$DROPLET_IP":/workspace/prompt.md

# Upload .env if present
if [ -f "$SCRIPT_DIR/.env" ]; then
    log "Uploading environment..."
    scp $SSH_OPTS "$SCRIPT_DIR/.env" root@"$DROPLET_IP":/app/.env
fi

# Fix ownership for turkey user
ssh $SSH_OPTS root@"$DROPLET_IP" "chown -R turkey:turkey /workspace /app"

# ============================================================
# STEP 3.5: Interactive Claude login (optional)
# ============================================================

if [ "$LOGIN_FIRST" = true ]; then
    echo ""
    echo "============================================================"
    echo "  CLAUDE MAX LOGIN"
    echo "============================================================"
    echo ""
    info "You are now on the droplet as the 'turkey' user."
    info ""
    info "To authenticate with Claude Max:"
    info "  1. Run:  claude"
    info "  2. Follow the login prompts to authenticate your Max account"
    info "  3. Once authenticated, type:  exit"
    info ""
    info "The build will start automatically after you exit."
    echo "============================================================"
    echo ""

    ssh $SSH_OPTS -t root@"$DROPLET_IP" \
        "sudo -u turkey -i bash -c 'cd /workspace && exec bash'"

    log "Login session ended. Continuing with build..."
fi

# ============================================================
# STEP 4: Run orchestration (interactive SSH session)
# ============================================================

# Create the orchestration script on the droplet
ssh $SSH_OPTS root@"$DROPLET_IP" << 'SETUP'
cat > /workspace/run-orchestration.sh << 'SCRIPT'
#!/bin/bash
set -e

# Load environment
if [ -f /app/.env ]; then
    set -a
    source /app/.env
    set +a
fi

cd /workspace

# Get project name from prompt
PROJECT_NAME=$(grep -m1 '^#' prompt.md | sed 's/^#\+\s*//' || head -1 prompt.md)

echo ""
echo "============================================================"
echo "  TURKEY ENTERPRISE V3 - ORCHESTRATION"
echo "============================================================"
echo ""
echo "  Project: $PROJECT_NAME"
echo "  Spec:    /workspace/prompt.md"
echo ""
echo "============================================================"
echo ""

# Run orchestration with verbose output
turkey-enterprise-v3 run "$PROJECT_NAME" --spec prompt.md --verbose
SCRIPT
chmod +x /workspace/run-orchestration.sh
SETUP

if [ "$USE_TMUX" = true ]; then
    # Install tmux if not present
    ssh $SSH_OPTS root@"$DROPLET_IP" \
        "command -v tmux >/dev/null || apt-get install -y tmux" 2>/dev/null

    log "Starting orchestration in tmux session 'build'..."
    log ""
    info "Keybindings:"
    info "  Ctrl+B, D    - Detach (build continues in background)"
    info "  Ctrl+C       - Cancel current operation"
    info ""
    info "To reattach later:  ssh root@$DROPLET_IP -t 'tmux attach -t build'"
    info ""

    # Start or attach to tmux session
    ssh $SSH_OPTS -t root@"$DROPLET_IP" \
        "tmux new-session -A -s build 'cd /workspace && ./run-orchestration.sh; exec bash'"

    ORCHESTRATION_EXIT=$?
else
    log "Starting interactive SSH session..."
    log "You will see the build process in real-time."
    echo ""

    # SSH interactively with TTY allocation
    ssh $SSH_OPTS -t root@"$DROPLET_IP" \
        "cd /workspace && ./run-orchestration.sh"

    ORCHESTRATION_EXIT=$?
fi

# ============================================================
# STEP 5: Cleanup (optional)
# ============================================================

if [ "$DESTROY_AFTER" = true ]; then
    log "Destroying droplet..."
    "$SCRIPT_DIR/deploy.sh" --destroy --name "$DROPLET_NAME"
fi

# ============================================================
# Summary
# ============================================================

echo ""
echo "============================================================"
if [ $ORCHESTRATION_EXIT -eq 0 ]; then
    echo -e "${GREEN}  LAUNCH COMPLETE${NC}"
else
    echo -e "${RED}  LAUNCH FAILED (exit code: $ORCHESTRATION_EXIT)${NC}"
fi
echo "============================================================"
echo ""
echo "  Droplet:    $DROPLET_NAME"
echo "  Droplet IP: $DROPLET_IP"
echo "  Size:       $SIZE"
echo "  Project:    $PROJECT_NAME"
echo ""
echo "  SSH:        ssh root@$DROPLET_IP"
echo "  Workspace:  /workspace"
echo "  Status:     turkey-enterprise-v3 status"
echo "  Resume:     turkey-enterprise-v3 resume"
echo ""
[ "$DESTROY_AFTER" = true ] && echo "  (Droplet was destroyed)"
echo "============================================================"

exit $ORCHESTRATION_EXIT
