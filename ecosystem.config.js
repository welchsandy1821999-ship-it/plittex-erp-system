const path = require("path");

module.exports = {
  apps: [
    {
      name: "plittex-erp",
      cwd: __dirname,
      script: path.join(__dirname, "web.js"),
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
