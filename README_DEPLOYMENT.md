# 🚀 Gmail Sender - VPS Deployment

## Quick Deployment Steps

### 1. **Push to GitHub** (Do this on your local machine)

```bash
# Initialize git repository (if not done)
git init
git add .
git commit -m "Initial commit - Gmail Sender App"

# Add your GitHub repository
git remote add origin https://github.com/yourusername/gmail-sender.git
git branch -M main
git push -u origin main
```

### 2. **Deploy on VPS** (Do this on your VPS)

```bash
# Clone the repository
cd /var/www/
git clone https://github.com/yourusername/gmail-sender.git
cd gmail-sender

# Make deployment script executable
chmod +x deploy.sh
chmod +x update.sh

# Run deployment
./deploy.sh
```

### 3. **Configure Environment** (On VPS)

```bash
# Edit the environment file
nano .env

# Update these values:
# - DOMAIN=your-domain.com
# - AUTH_SECRET=YourSecurePassword123!
```

### 4. **Access Your Application**

- **Local VPS**: `http://your-vps-ip:3000`
- **With Domain**: `https://your-domain.com` (if configured with nginx/SSL)

---

## 🔄 Update Workflow

When you make changes locally:

```bash
# On your local machine
git add .
git commit -m "Your changes description"
git push origin main

# On your VPS
./update.sh
```

---

## 📊 Management Commands (On VPS)

```bash
# View application status
pm2 status

# View logs
pm2 logs gmail-sender

# Restart application
pm2 restart gmail-sender

# Stop application
pm2 stop gmail-sender

# Monitor in real-time
pm2 monit
```

---

## 🎯 First-Time Setup Checklist

- [ ] GitHub repository created and code pushed
- [ ] VPS repository cloned
- [ ] Dependencies installed (`npm install`)
- [ ] Environment file configured (`.env`)
- [ ] Application deployed with PM2
- [ ] Application accessible via browser
- [ ] Gmail API credentials added via web interface
- [ ] Test email sending works

---

## 🌐 Production Configuration

### Google Cloud Console Updates

Once deployed, update your Google Cloud Console:

1. **OAuth Consent Screen** → Authorized domains: `your-domain.com`
2. **Credentials** → Add redirect URI: `https://your-domain.com/api/gmail/callback`

### Security Considerations

- ✅ Change default AUTH_SECRET
- ✅ Use HTTPS in production (nginx + Let's Encrypt)
- ✅ Set up firewall rules
- ✅ Regular backups of data files
- ✅ Monitor logs for suspicious activity

---

## 🛠️ Troubleshooting

### Common Issues:

**Application won't start:**
```bash
pm2 logs gmail-sender  # Check error logs
npm install             # Reinstall dependencies  
```

**Port already in use:**
```bash
lsof -i :3000          # See what's using port 3000
pm2 stop gmail-sender  # Stop the application
```

**Gmail authentication fails:**
- Check redirect URI in Google Cloud Console
- Verify domain configuration
- Ensure SSL certificate is valid (for HTTPS)

**Need help?**
- Check logs: `pm2 logs gmail-sender`
- Monitor resources: `htop`
- Test connectivity: `curl http://localhost:3000`