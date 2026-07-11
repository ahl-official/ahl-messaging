/**
 * PM2 process file for AHL Messaging (production).
 *
 * Fork + 1 instance is required so instrumentation.ts cron loops
 * (automation sweep, campaigns, drips, triggers, lead distribution)
 * run exactly once. Cluster mode with N workers would duplicate ticks
 * unless only NODE_APP_INSTANCE=0 runs them — fork avoids that class of bug.
 *
 * Usage on VPS:
 *   cd /opt/QHT-Messaging
 *   pm2 startOrReload ecosystem.config.cjs --update-env
 *   pm2 save
 */
module.exports = {
  apps: [
    {
      name: "qht-messaging",
      cwd: "/opt/QHT-Messaging",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3001",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "1536M",
      env: {
        NODE_ENV: "production",
        PORT: "3001",
      },
    },
  ],
};
