const { execSync } = require('child_process');
const nodePath = execSync('source ~/.nvm/nvm.sh && nvm which default', { shell: '/bin/zsh' }).toString().trim();

module.exports = {
  apps: [
    {
      name: "memo-assistant",
      script: "node_modules/.bin/next",
      args: "dev --port 51373",
      cwd: __dirname,
      interpreter: nodePath,
      env: {
        NODE_ENV: "development",
        PORT: 51373,
        NEXT_DIST_DIR: ".next-pm2",
      },
      watch: false,           // Next.js handles its own HMR
      autorestart: true,      // restart if it crashes
      max_restarts: 10,
      restart_delay: 3000,    // wait 3s before restarting
      log_file: "./logs/memo-assistant.log",
      out_file: "./logs/memo-assistant-out.log",
      error_file: "./logs/memo-assistant-error.log",
      time: true,             // prefix logs with timestamp
    },
  ],
};
