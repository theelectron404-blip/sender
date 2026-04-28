#!/bin/bash
# VPS Deployment Script for Gmail Sender

echo "🚀 Starting VPS deployment..."

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 for process management
sudo npm install -g pm2

# Install nginx (optional, for reverse proxy)
sudo apt install -y nginx

# Create app directory
sudo mkdir -p /var/www/gmail-sender
sudo chown $USER:$USER /var/www/gmail-sender

echo "✅ VPS environment prepared!"
echo "📁 Upload your files to: /var/www/gmail-sender"