#!/bin/bash
#
# turkey-enterprise-v3 DigitalOcean Deployment Script
#
# Deploys the orchestrator to a DigitalOcean droplet with:
# - Docker pre-installed
# - Claude Code CLI
# - Sufficient memory for AI workloads
#
# Prerequisites:
# - doctl CLI installed and authenticated
# - SSH key added to DigitalOcean account
# - ANTHROPIC_API_KEY set
#
# Usage:
#   ./deploy.sh                    # Deploy with defaults
#   ./deploy.sh --size s-2vcpu-4gb # Deploy with custom size
#   ./deploy.sh --name my-project  # Deploy with custom droplet name
#   ./deploy.sh --destroy          # Destroy the droplet
#   ./deploy.sh --destroy --name x # Destroy a specific droplet

set -e

# Configuration
PROJECT=""  # set via --name, defaults below
REGION="${REGION:-nyc1}"
# Default: 2GB RAM, 1 vCPU - minimum recommended for Claude Code
# For heavy workloads, use s-2vcpu-4gb ($24/mo) or s-4vcpu-8gb ($48/mo)
SIZE="${SIZE:-s-1vcpu-2gb}"
IMAGE="docker-20-04"
SSH_KEY_FILE="${SSH_KEY_FILE:-$HOME/.ssh/id_deploy}"
SSH_OPTS="-o StrictHostKeyChecking=no -o IdentityFile=$SSH_KEY_FILE"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[deploy]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
error() { echo -e "${RED}[error]${NC} $1"; exit 1; }

# Parse arguments
DESTROY=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --size) SIZE="$2"; shift 2 ;;
        --region) REGION="$2"; shift 2 ;;
        --name) PROJECT="$2"; shift 2 ;;
        --destroy) DESTROY=true; shift ;;
        *) shift ;;
    esac
done

# Default project name if not provided
PROJECT="${PROJECT:-turkey-enterprise-v3}"

# Check prerequisites
check_prereqs() {
    log "Checking prerequisites..."

    command -v doctl >/dev/null 2>&1 || error "doctl not found. Install: https://docs.digitalocean.com/reference/doctl/"

    doctl account get >/dev/null 2>&1 || error "doctl not authenticated. Run: doctl auth init"

    SSH_KEY=$(doctl compute ssh-key list --format FingerPrint --no-header | head -1)
    [ -z "$SSH_KEY" ] && error "No SSH key found in DigitalOcean. Add one at https://cloud.digitalocean.com/account/security"

    log "Prerequisites OK"
}

# Destroy droplet
destroy_droplet() {
    log "Destroying droplet: $PROJECT"

    DROPLET_ID=$(doctl compute droplet list --format Name,ID --no-header | grep "^${PROJECT} " | awk '{print $2}' || true)

    if [ -z "$DROPLET_ID" ]; then
        warn "Droplet $PROJECT not found"
        exit 0
    fi

    doctl compute droplet delete "$DROPLET_ID" --force
    log "Droplet destroyed"
    exit 0
}

# Get or create droplet
get_or_create_droplet() {
    log "Checking for existing droplet..."

    EXISTING=$(doctl compute droplet list --format Name,ID,PublicIPv4 --no-header | grep "^${PROJECT} " || true)

    if [ -n "$EXISTING" ]; then
        DROPLET_IP=$(echo "$EXISTING" | awk '{print $3}')
        log "Found existing droplet: $DROPLET_IP"
    else
        log "Creating new droplet: $PROJECT ($SIZE in $REGION)"

        doctl compute droplet create "$PROJECT" \
            --image "$IMAGE" \
            --size "$SIZE" \
            --region "$REGION" \
            --ssh-keys "$SSH_KEY" \
            --wait

        # Get the IP
        sleep 5
        DROPLET_IP=$(doctl compute droplet list --format Name,PublicIPv4 --no-header | grep "^${PROJECT} " | awk '{print $2}')

        log "Droplet created: $DROPLET_IP"

        # Wait for SSH
        log "Waiting for SSH..."
        for i in {1..30}; do
            if ssh -o ConnectTimeout=5 $SSH_OPTS -o BatchMode=yes root@"$DROPLET_IP" "echo SSH OK" 2>/dev/null; then
                log "SSH ready"
                sleep 5  # Extra buffer for SSH to stabilize
                break
            fi
            sleep 10
        done

        # Provision the droplet
        provision_droplet
    fi
}

# Provision new droplet
provision_droplet() {
    log "Provisioning droplet..."

    ssh -T $SSH_OPTS root@"$DROPLET_IP" << 'EOF'
set -e

echo ">>> Waiting for apt locks to be released..."
while fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/cache/apt/archives/lock >/dev/null 2>&1 || pgrep -x apt-get >/dev/null || pgrep -x dpkg >/dev/null; do
    echo "    Waiting for other apt processes to finish..."
    sleep 10
done
sleep 5  # Extra buffer after locks released

echo ">>> Installing packages..."
apt-get update
apt-get install -y git curl jq

echo ">>> Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo ">>> Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code

# jira-lite installed separately from local build

echo ">>> Installing GitHub CLI..."
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
apt-get update
apt-get install -y gh

echo ">>> Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw --force enable

echo ">>> Creating app directories..."
mkdir -p /app /workspace

echo ">>> Creating turkey user (claude code won't run as root)..."
if ! id -u turkey >/dev/null 2>&1; then
    useradd -m -s /bin/bash turkey
    echo "turkey ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/turkey
fi
usermod -aG docker turkey
chown -R turkey:turkey /workspace /app

echo ">>> Configuring git defaults..."
sudo -u turkey git config --global init.defaultBranch main
sudo -u turkey git config --global user.name "Turkey Enterprise"
sudo -u turkey git config --global user.email "turkey@localhost"

echo ">>> Provisioning complete!"
EOF

    log "Provisioning complete"
}

# Deploy the application
deploy_app() {
    log "Deploying turkey-enterprise-v3..."

    # Get the directory where this script is located
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

    # Sync project files
    log "Syncing project files..."
    rsync -avz -e "ssh -o StrictHostKeyChecking=no -i $SSH_KEY_FILE" \
        --exclude 'node_modules' --exclude '.git' --exclude 'workspace' \
        "$PROJECT_DIR/" root@"$DROPLET_IP":/app/

    # Sync jira-lite if it exists
    JIRA_LITE_DIR="$(dirname "$PROJECT_DIR")/jira-lite"
    if [ -d "$JIRA_LITE_DIR" ]; then
        log "Syncing jira-lite..."
        rsync -avz -e "ssh -o StrictHostKeyChecking=no -i $SSH_KEY_FILE" \
            --exclude 'node_modules' --exclude '.git' \
            "$JIRA_LITE_DIR/" root@"$DROPLET_IP":/opt/jira-lite/
    fi

    # Install and build on server
    log "Installing dependencies..."
    ssh -T $SSH_OPTS root@"$DROPLET_IP" << 'EOF'
cd /app
npm ci --only=production
echo ">>> Installation complete"

# Install jira-lite if synced
if [ -d /opt/jira-lite ]; then
    echo ">>> Installing jira-lite..."
    cd /opt/jira-lite
    npm ci --only=production 2>/dev/null || npm install --only=production
    npm link
fi
EOF

    # Create convenience wrapper (runs as turkey user)
    log "Creating CLI wrapper..."
    ssh -T $SSH_OPTS root@"$DROPLET_IP" << 'EOF'
cat > /usr/local/bin/turkey-enterprise-v3 << 'WRAPPER'
#!/bin/bash
cd /workspace
# Run as turkey user if currently root (claude code won't run as root)
# Source env inside the sudo to ensure vars are available
if [ "$(id -u)" = "0" ]; then
    exec sudo -u turkey bash -c '
        if [ -f /app/.env ]; then
            set -a
            source /app/.env
            set +a
        fi
        cd /workspace
        exec node /app/dist/index.js "$@"
    ' -- "$@"
else
    if [ -f /app/.env ]; then
        set -a
        source /app/.env
        set +a
    fi
    exec node /app/dist/index.js "$@"
fi
WRAPPER
chmod +x /usr/local/bin/turkey-enterprise-v3
EOF

    log "Deployment complete!"
}

# Setup environment
setup_env() {
    log "Setting up environment..."

    # Check if .env exists locally
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    ENV_FILE="$SCRIPT_DIR/.env"

    if [ -f "$ENV_FILE" ]; then
        log "Uploading .env file..."
        scp $SSH_OPTS "$ENV_FILE" root@"$DROPLET_IP":/app/.env

        # Source it in bashrc for both root and turkey
        ssh -T $SSH_OPTS root@"$DROPLET_IP" << 'EOF'
# Add to root bashrc
if ! grep -q "source /app/.env" ~/.bashrc; then
    echo "set -a; source /app/.env; set +a" >> ~/.bashrc
fi

# Add to turkey bashrc
if ! grep -q "source /app/.env" /home/turkey/.bashrc; then
    echo "set -a; source /app/.env; set +a" >> /home/turkey/.bashrc
fi

# Configure jira-lite if credentials present
source /app/.env
if [ -n "$JIRA_HOST" ] && [ -n "$JIRA_EMAIL" ] && [ -n "$JIRA_TOKEN" ]; then
    echo ">>> Configuring jira-lite..."
    sudo -u turkey jira-lite init --host "$JIRA_HOST" --email "$JIRA_EMAIL" --token "$JIRA_TOKEN" 2>/dev/null || true
    if [ -n "$JIRA_PROJECT" ]; then
        sudo -u turkey jira-lite project set "$JIRA_PROJECT" 2>/dev/null || true
    fi
fi

# Configure git to use GH_TOKEN for private repos (HTTPS)
if [ -n "$GH_TOKEN" ]; then
    echo ">>> Configuring git for private repos..."
    # Configure for root
    git config --global url."https://${GH_TOKEN}@github.com/".insteadOf "https://github.com/"
    # Configure for turkey user
    sudo -u turkey git config --global url."https://${GH_TOKEN}@github.com/".insteadOf "https://github.com/"
    # Also authenticate gh CLI
    echo "$GH_TOKEN" | sudo -u turkey gh auth login --with-token 2>/dev/null || true
fi
EOF
    else
        warn "No .env file found at $ENV_FILE"
        warn "Create one with ANTHROPIC_API_KEY and optionally JIRA_* vars"
    fi
}

# Print summary
print_summary() {
    echo ""
    echo "=============================================="
    echo "  $PROJECT Deployment Complete"
    echo "=============================================="
    echo ""
    echo "  Droplet IP: $DROPLET_IP"
    echo "  Size:       $SIZE"
    echo "  Region:     $REGION"
    echo ""
    echo "  Connect:    ssh root@$DROPLET_IP"
    echo ""
    echo "  Usage on droplet:"
    echo "    cd /workspace"
    echo "    turkey-enterprise-v3 run \"Build a todo app\""
    echo "    turkey-enterprise-v3 status"
    echo "    turkey-enterprise-v3 resume"
    echo ""
    echo "  Environment:"
    echo "    Edit /app/.env to set ANTHROPIC_API_KEY"
    echo "    Source with: source /app/.env"
    echo ""
    echo "=============================================="
}

# Main
main() {
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║     turkey-enterprise-v3 DO Deployment           ║"
    echo "╚══════════════════════════════════════════════════╝"
    echo ""

    check_prereqs

    if [ "$DESTROY" = true ]; then
        destroy_droplet
    fi

    get_or_create_droplet
    deploy_app
    setup_env
    print_summary
}

main
