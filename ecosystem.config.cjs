/**
 * PM2 process definitions.   pm2 start ecosystem.config.cjs --env production
 *
 * Keep secrets in per-process env files (chmod 600). Only `last60-rewards` may hold the payout
 * signing key and SCHEDULE_ENCRYPTION_KEY; the API and web processes never need them.
 *
 * Exit code 78 = invalid configuration: PM2 stops restarting (stop_exit_codes) instead of
 * hot-looping, so the error stays visible in `pm2 logs`.
 */
const common = {
  interpreter: "bun",
  cwd: __dirname,
  autorestart: true,
  max_restarts: 50,
  min_uptime: "10s",
  exp_backoff_restart_delay: 200,
  stop_exit_codes: [78],
  kill_timeout: 20000,
  time: true,
  merge_logs: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: "last60-indexer",
      script: "apps/worker/src/indexer.ts",
      env_file: ".env.indexer",
      env: { WORKER_HEALTH_PORT: "4101" },
    },
    {
      ...common,
      name: "last60-rewards",
      script: "apps/worker/src/rewards.ts",
      env_file: ".env.rewards",
      env: { WORKER_HEALTH_PORT: "4102" },
      // A single active rewards leader is enforced by a lease; extra instances stand by safely.
      instances: 1,
    },
    {
      ...common,
      name: "last60-api",
      script: "apps/api/src/index.ts",
      env_file: ".env.api",
    },
    {
      name: "last60-web",
      cwd: `${__dirname}/apps/web`,
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      interpreter: "node",
      env_file: "../../.env.web",
      autorestart: true,
      time: true,
    },
  ],
};
