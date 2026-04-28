#!/bin/bash
# Quick Update Script for VPS
# Use this for quick updates without full deployment

echo "🔄 Quick update deployment..."

# Pull latest changes
git pull origin main

# Install any new dependencies
npm install --production

# Restart application
pm2 restart gmail-sender

echo "✅ Update completed!"
pm2 status