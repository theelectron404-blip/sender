# Project Vibe: Email Security Lab
- **Stack:** Node.js (app.js), Microsoft Graph API, Debian 12, HestiaCP.
- **Coding Style:** Clean, modular, async/await, strict error handling for SMTP.
- **Security Rule:** Never hardcode keys. Use .env. Always check for SSRF and SQLi.
- **YouTube Brand:** UI should use the "BlackBox" aesthetic (dark mode, amber text).

## Commands
- Run App: `node app.js`
- Test SMTP: `npm test smtp`
- Security Scan: `npm run scan`