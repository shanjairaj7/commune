#!/bin/bash

# Quick script to help you get Stripe test keys
# This opens the necessary Stripe dashboard pages

echo "🔑 Opening Stripe Dashboard Pages..."
echo ""

echo "1️⃣  Opening API Keys page..."
open "https://dashboard.stripe.com/test/apikeys"
sleep 2

echo "2️⃣  Opening Products page..."
open "https://dashboard.stripe.com/test/products"
sleep 1

echo ""
echo "📋 Next Steps:"
echo ""
echo "1. From API Keys page:"
echo "   - Copy 'Secret key' (sk_test_...)"
echo "   - Paste into .env.local as STRIPE_SECRET_KEY"
echo ""
echo "2. From Products page:"
echo "   - Create 4 products (Agent Pro Monthly/Yearly, Business Monthly/Yearly)"
echo "   - Copy each price ID (price_...)"
echo "   - Paste into .env.local"
echo ""
echo "3. Then run: ./setup-stripe-local.sh"
echo ""
