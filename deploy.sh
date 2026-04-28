#!/bin/bash
# Production Deployment Script
# Run this on your VPS after git pull

echo "🚀 Starting Gmail Sender deployment..."

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "server.js" ]; then
    echo -e "${RED}Error: server.js not found. Make sure you're in the app directory.${NC}"
    exit 1
fi

# Install/update dependencies
echo -e "${BLUE}📦 Installing dependencies...${NC}"
npm install --production

# Create necessary directories
echo -e "${BLUE}📁 Creating directories...${NC}"
mkdir -p logs
mkdir -p data

# Set permissions
chmod +x server.js
chmod +x app.js

# Create production environment if it doesn't exist
if [ ! -f ".env" ]; then
    echo -e "${BLUE}⚙️ Creating production environment file...${NC}"
    cp .env.production .env
    echo -e "${RED}⚠️  IMPORTANT: Edit .env file with your production settings!${NC}"
fi

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo -e "${BLUE}📦 Installing PM2...${NC}"
    npm install -g pm2
fi

# Stop existing application (if running)
echo -e "${BLUE}🛑 Stopping existing application...${NC}"
pm2 stop gmail-sender 2>/dev/null || true

# Start application with PM2
echo -e "${BLUE}🚀 Starting application with PM2...${NC}"
pm2 start ecosystem.config.js --env production

# Save PM2 configuration
pm2 save
pm2 startup

# Show status
echo -e "${GREEN}✅ Deployment completed!${NC}"
echo -e "${BLUE}📊 Application Status:${NC}"
pm2 status

echo ""
echo -e "${GREEN}🎉 Your Gmail Sender is now live!${NC}"
echo -e "${BLUE}📋 Quick Commands:${NC}"
echo "  View logs:    pm2 logs gmail-sender"
echo "  Restart app:  pm2 restart gmail-sender" 
echo "  Stop app:     pm2 stop gmail-sender"
echo "  App status:   pm2 status"
echo ""
echo -e "${BLUE}🌐 Access your application at:${NC}"
echo "  Local:  http://localhost:3000"
echo "  Domain: https://your-domain.com (if configured)"