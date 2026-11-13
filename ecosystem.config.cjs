// PM2 process file. Start with: pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'samadhan-notify',
      script: 'dist/index.js',
      cwd: __dirname,
      exec_mode: 'fork', // one process: token API + queue worker + receipt poller
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '400M',
      kill_timeout: 20000,
      shutdown_with_message: true, // Windows has no SIGINT for child processes; PM2 sends 'shutdown'
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: false, // log lines already carry timestamps
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
