# 🚀 VPS Deployment Guide for Gmail Multi-App Sender

## 📋 VPS Environment Setup

### 1. Environment Variables (.env)
```bash
# Server Configuration
NODE_ENV=production
PORT=3002
DOMAIN=yourdomain.com

# Authentication
AUTH_SECRET=YourSuperSecretPassword123!

# Optional: Default Gmail API (can be managed via UI instead)
GMAIL_CLIENT_ID=your-client-id
GMAIL_CLIENT_SECRET=your-client-secret
```

### 2. Required Files Structure
```
/your-app-directory/
├── app.js
├── server.js
├── .env
├── package.json
├── services/
│   ├── deliverabilityMonitor.js
│   ├── contentAnalyzer.js
│   ├── domainAuth.js
│   └── engagementSim.js
├── public/
│   └── index.html
└── data/ (auto-created)
    ├── gmail-apps.json
    ├── gmail-accounts.json
    ├── users.json
    └── blacklist.json
```

## 🔧 Multi-App Gmail Setup Process

### Step 1: Access Your VPS Dashboard
- Open `https://yourdomain.com:3002` in browser
- Login with your credentials
- Navigate to **Gmail API** tab

### Step 2: Add Gmail API Applications
1. Click **"➕ Add Gmail App"**
2. Enter a name (e.g., "Production API", "Backup API")
3. Paste your `client_secret_xxx.json` file contents
4. Click **"Add Application"**
5. Repeat for multiple Google Cloud projects

### Step 3: Authenticate Gmail Accounts
1. For each app, click **"Connect Account"**
2. Complete OAuth2 flow in popup window
3. Accounts are automatically linked to respective apps
4. Test each account with the built-in test tool

## ✅ VPS Benefits

### 🔒 Security
- All credentials stored locally on VPS
- OAuth2 tokens encrypted and auto-refreshed
- No credentials exposed in client browser

### 📈 Scalability  
- Multiple Gmail API apps from different Google Cloud projects
- Distribute sending load across multiple apps
- Independent rate limits per app

### 🛡️ Redundancy
- If one API app hits limits, others continue
- Account-level and app-level failover
- Automatic retry mechanisms

### 🎯 Management
- Web-based UI for all operations
- Real-time monitoring and statistics
- Remote account management

## 🌐 Google Cloud Console Configuration

For each Gmail API application, ensure:

### OAuth2 Consent Screen
- **Application type**: External or Internal
- **Test users**: Add your Gmail addresses (for testing phase)
- **Scopes**: `https://www.googleapis.com/auth/gmail.send`

### Credentials (OAuth 2.0 Client ID)
- **Authorized redirect URIs**: 
  ```
  https://yourdomain.com:3002/api/gmail/callback
  http://localhost:3002/api/gmail/callback  (for local testing)
  ```

### Domain Verification (Recommended)
- Verify your sending domain in Google Search Console
- Add SPF, DKIM, and DMARC DNS records
- Use the built-in domain authentication checker

## 📊 Monitoring & Analytics

The system provides:
- **Real-time deliverability monitoring**
- **Content spam analysis**
- **Domain authentication status**
- **Account rotation statistics**
- **Engagement simulation tools**

## 🚨 Production Checklist

- [ ] VPS firewall configured (allow port 3002)
- [ ] SSL certificate installed (recommended)
- [ ] Environment variables set
- [ ] Gmail API apps added and tested
- [ ] Accounts authenticated and verified
- [ ] Domain authentication configured
- [ ] Backup strategy in place
- [ ] Monitoring alerts configured

## 🛠️ Troubleshooting

### "Access blocked: webdesk has not completed verification"
- Add your email to **Test users** in OAuth consent screen
- Or publish your app after Google verification

### "Invalid redirect URI"
- Ensure redirect URI matches exactly in Google Cloud Console
- Check for http vs https mismatch

### "No Gmail accounts authenticated"
- Complete OAuth2 flow for at least one account
- Check account appears in Gmail API tab

### Rate Limits
- Add more Gmail API apps from different projects
- Accounts automatically rotate across available apps