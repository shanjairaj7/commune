#!/bin/bash

# Stripe Local Testing Setup Script
# This script sets up Stripe webhook forwarding for local development

set -e

echo "🔧 Stripe Local Testing Setup"
echo "=============================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Stripe CLI is installed
if ! command -v stripe &> /dev/null; then
    echo -e "${RED}❌ Stripe CLI not found${NC}"
    echo "Install it with: brew install stripe/stripe-cli/stripe"
    exit 1
fi

echo -e "${GREEN}✅ Stripe CLI found${NC}"
echo ""

# Check if .env.local exists
if [ ! -f .env.local ]; then
    echo -e "${RED}❌ .env.local not found${NC}"
    echo "Please create .env.local first"
    exit 1
fi

# Check if test API key is set
if grep -q "STRIPE_SECRET_KEY=sk_test_YOUR_TEST_KEY_HERE" .env.local; then
    echo -e "${YELLOW}⚠️  You need to add your Stripe test API key to .env.local${NC}"
    echo ""
    echo "Steps:"
    echo "1. Go to: https://dashboard.stripe.com/test/apikeys"
    echo "2. Copy your 'Secret key' (starts with sk_test_...)"
    echo "3. Replace STRIPE_SECRET_KEY in .env.local"
    echo ""
    read -p "Press Enter after you've added the test key..."
fi

# Extract the test API key from .env.local
TEST_KEY=$(grep "^STRIPE_SECRET_KEY=" .env.local | cut -d '=' -f2)

if [[ ! $TEST_KEY == sk_test_* ]]; then
    echo -e "${RED}❌ Invalid test API key. Must start with sk_test_${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Test API key found${NC}"
echo ""

# Start Stripe webhook forwarding
echo "🚀 Starting Stripe webhook forwarding..."
echo ""
echo "This will:"
echo "  1. Forward Stripe webhooks to http://localhost:8000/api/webhooks/stripe"
echo "  2. Generate a webhook signing secret (whsec_...)"
echo "  3. Display the secret for you to add to .env.local"
echo ""
echo -e "${YELLOW}Keep this terminal open while testing!${NC}"
echo ""

# Run stripe listen and capture the webhook secret
stripe listen --forward-to localhost:8000/api/webhooks/stripe --api-key "$TEST_KEY"
