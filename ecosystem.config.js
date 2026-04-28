// PM2 Configuration for VPS Deployment
module.exports = {
  apps: [{
    name: 'gmail-sender',
    script: './server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    restart_delay: 4000,
    max_restarts: 10,
    min_uptime: '10s',
    
    env: {
      NODE_ENV: 'development',
      PORT: 3005
    },
    
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    
    // Logging
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    
    // Monitoring
    monitoring: false,
    pmx: false
  }]
};