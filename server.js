const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const { setIo } = require('./app');
const bounceMonitor = require('./services/bounceMonitor');

const BASE_PORT = Number.parseInt(process.env.PORT || '3005', 10);
const MAX_PORT_RETRIES = 20;

const server = http.createServer(app);
const io = new Server(server);

setIo(io);

io.on('connection', (socket) => {
    console.log(`Dashboard connected: ${socket.id}`);
    socket.on('disconnect', () => console.log(`Dashboard disconnected: ${socket.id}`));
});

let activePort = BASE_PORT;
let retries = 0;

server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        if (retries < MAX_PORT_RETRIES) {
            retries += 1;
            activePort += 1;
            console.warn(`[Server] Port in use. Retrying on http://localhost:${activePort}`);
            setTimeout(() => server.listen(activePort), 120);
            return;
        }
        console.error(`[Server] Could not bind after ${MAX_PORT_RETRIES} retries starting from port ${BASE_PORT}.`);
        process.exitCode = 1;
        return;
    }

    console.error('[Server] Fatal startup error:', err && err.message ? err.message : err);
    process.exitCode = 1;
});

server.listen(activePort, '0.0.0.0', () => {
    console.log(`Notification server running at http://0.0.0.0:${activePort}`);
   
    bounceMonitor.start(io);
});