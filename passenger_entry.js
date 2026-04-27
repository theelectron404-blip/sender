const app = require('./app'); // Imports your logic from app.js
const http = require('http');
const server = http.createServer(app);
server.listen(process.env.PORT || 3000);