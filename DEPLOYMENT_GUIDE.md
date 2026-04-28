# 🚀 VPS Deployment Guide - Gmail Sender

## 📋 Prerequisites
- **VPS**: Ubuntu 20.04+ with root access
- **Domain**: Pointing to your VPS IP address
- **SSL Certificate**: Let's Encrypt (we'll set this up)

---

## 🎯 Quick Deployment Steps

### **Step 1: Prepare Your VPS**

```bash
# Connect to your VPS
ssh root@your-vps-ip

# Run the deployment script
curl -o deploy-vps.sh https://raw.githubusercontent.com/your-repo/deploy-vps.sh
chmod +x deploy-vps.sh
./deploy-vps.sh
```

### **Step 2: Upload Your Application**

```bash
# From your local machine, upload files to VPS
scp -r . root@your-vps-ip:/var/www/gmail-sender/

# Or use Git (recommended)
cd /var/www/gmail-sender
git clone https://github.com/your-repo/gmail-sender.git .
```

### **Step 3: Configure Environment**

```bash
cd /var/www/gmail-sender

# Copy production environment
cp .env.production .env

# Edit configuration
nano .env
```

**Update .env file:**
```bash
NODE_ENV=production
PORT=3000
DOMAIN=your-domain.com
AUTH_SECRET=YourVerySecurePasswordHere123!
```

### **Step 4: Install Dependencies**

```bash
npm install
mkdir logs
```

### **Step 5: Set up SSL Certificate**

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Get SSL certificate
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
```

### **Step 6: Configure Nginx**

```bash
# Copy nginx configuration
sudo cp nginx.conf /etc/nginx/sites-available/gmail-sender

# Update domain name in config
sudo nano /etc/nginx/sites-available/gmail-sender

# Enable site
sudo ln -s /etc/nginx/sites-available/gmail-sender /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### **Step 7: Start Application with PM2**

```bash
# Start the application
npm run pm2:start

# Check status
npm run pm2:status

# View logs
npm run pm2:logs
```

---

## 🔧 Google Cloud Console Configuration

### **Update OAuth Settings for Production**

1. **Go to**: Google Cloud Console → APIs & Services → Credentials
2. **Edit** your OAuth 2.0 Client ID
3. **Add Production Redirect URI**:
   ```
   https://your-domain.com/api/gmail/callback
   ```
4. **OAuth Consent Screen** → Update:
   - **Authorized domains**: `your-domain.com`
   - **Application homepage**: `https://your-domain.com`

### **Required Scopes** (OAuth Consent Screen → Scopes):
```
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/userinfo.email
```

---

## 🎮 Post-Deployment Usage

### **Access Your Application**
- **URL**: `https://your-domain.com`
- **Login**: Use the credentials you set in AUTH_SECRET

### **Add Gmail API Apps**
1. **Go to**: Gmail API tab
2. **Click**: "Add Gmail App"
3. **Upload**: Your Google OAuth2 JSON credentials
4. **Connect**: Gmail accounts for each app

### **Production Benefits**
- ✅ **HTTPS Security**: SSL encryption
- ✅ **Process Management**: PM2 auto-restart
- ✅ **Rate Limiting**: Nginx protection
- ✅ **Multiple Apps**: Scalable Gmail API management
- ✅ **Monitoring**: Logs and status tracking

---

## 📊 Management Commands

### **Application Management**
```bash
# Restart application
npm run pm2:restart

# Stop application  
npm run pm2:stop

# View logs
npm run pm2:logs

# Monitor in real-time
pm2 monit
```

### **SSL Certificate Renewal**
```bash
# Auto-renewal (already set up)
sudo certbot renew --dry-run
```

### **Nginx Management**
```bash
# Test configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx

# View Nginx logs
sudo tail -f /var/log/nginx/error.log
```

---

## 🛡️ Security Features

### **Built-in Security**
- ✅ **HTTPS Only**: SSL encryption
- ✅ **Rate Limiting**: API protection
- ✅ **Security Headers**: XSS protection
- ✅ **Process Isolation**: PM2 management
- ✅ **Authentication**: Secure login system

### **Firewall Configuration**
```bash
# Enable UFW firewall
sudo ufw enable
sudo ufw allow ssh
sudo ufw allow 'Nginx Full'
```

---

## 🚨 Troubleshooting

### **Common Issues**

**1. "Cannot connect"**
- Check if PM2 is running: `npm run pm2:status`
- Check Nginx: `sudo systemctl status nginx`
- Check logs: `npm run pm2:logs`

**2. "Gmail OAuth Error"**
- Verify redirect URI in Google Cloud Console
- Ensure domain matches exactly
- Check SSL certificate is valid

**3. "Port already in use"**
- Check what's using port 3000: `lsof -i :3000`
- Kill process: `sudo kill -9 <PID>`
- Restart: `npm run pm2:restart`

### **Monitoring**
```bash
# System resources
htop

# Disk usage
df -h

# Application status
pm2 status

# Real-time logs
pm2 logs --lines 100
```

---

## 🎯 Production Checklist

- [ ] VPS configured with Node.js 18+
- [ ] Domain pointing to VPS IP
- [ ] SSL certificate installed
- [ ] Nginx configured and running
- [ ] Application deployed with PM2
- [ ] Google Cloud Console updated
- [ ] Gmail API credentials uploaded
- [ ] Test email sending works
- [ ] Monitoring and logs checked
- [ ] Firewall configured
- [ ] Backup strategy in place

**🎉 Your Gmail Sender is now live and production-ready!**