/**
 * PM2 process definitions.   pm2 start ecosystem.config.cjs --env production
 *
 * Keep secrets in per-process env files (chmod 600). Only `last60-rewards` may hold the payout
 * signing key and SCHEDULE_ENCRYPTION_KEY; the API and web processes never need them.
 *
 * Env files are loaded by the runtime (`bun --env-file`, `node --env-file`): PM2 has no
 * `env_file` option and silently ignores it. `--env-file` also stops Bun from auto-loading a
 * root `.env`, which would otherwise hand every process (including the API) the same secrets.
 *
 * Exit code 78 = invalid configuration: PM2 stops restarting (stop_exit_codes) instead of
 * hot-looping, so the error stays visible in `pm2 logs`.
 */
const common = {
  // Run bun as the command, not as a PM2 interpreter: PM2's Bun wrapper require()s the entrypoint,
  // which fails on modules with top-level await.
  script: "bun",
  interpreter: "none",
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
      // Local single-node replica set; data in ./.mongo-dev. Omit this app when using Atlas.
      ...common,
      name: "last60-mongo",
      args: "--env-file=.env.mongo scripts/dev-mongo.ts",
    },
    {
      ...common,
      name: "last60-indexer",
      args: "--env-file=.env.indexer apps/worker/src/indexer.ts",
      env: { WORKER_HEALTH_PORT: "4101" },
    },
    {
      ...common,
      name: "last60-rewards",
      args: "--env-file=.env.rewards apps/worker/src/rewards.ts",
      env: { WORKER_HEALTH_PORT: "4102" },
      // A single active rewards leader is enforced by a lease; extra instances stand by safely.
      instances: 1,
    },
    {
      ...common,
      name: "last60-api",
      args: "--env-file=.env.api apps/api/src/index.ts",
    },
    {
      name: "last60-web",
      cwd: `${__dirname}/apps/web`,
      // Next is hoisted to the workspace root. Loopback only: nginx is the public entry point.
      script: "../../node_modules/next/dist/bin/next",
      args: "start -p 3060 -H 127.0.0.1",
      interpreter: "node",
      node_args: "--env-file=../../.env.web",
      autorestart: true,
      time: true,
    },
  ],
};
