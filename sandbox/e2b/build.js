'use strict';
// Builds the E2B template the browser sandbox runs from.
//   E2B_API_KEY=... node sandbox/e2b/build.js [template-name]
// Run again after changing start.sh or the packages; sandboxes made earlier keep the old image.

const { Template, waitForPort, defaultBuildLogger } = require('e2b');

const name = process.argv[2] || process.env.OXY_E2B_TEMPLATE || 'oxy-browser';

const template = Template({ fileContextPath: __dirname })
  .fromImage('debian:bookworm-slim')
  .setUser('root')
  .runCmd([
    'apt-get update',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends '
      + 'chromium xvfb x11vnc novnc websockify socat curl ca-certificates procps fonts-liberation fonts-noto-color-emoji sudo',
    'rm -rf /var/lib/apt/lists/*',
    'id user >/dev/null 2>&1 || useradd -m -s /bin/bash user',
    'echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user',
    'mkdir -p /opt/oxy',
  ])
  .copy('start.sh', '/opt/oxy/start.sh', { mode: 0o755 })
  .setUser('user')
  .setWorkdir('/home/user')
  .setStartCmd('bash /opt/oxy/start.sh', waitForPort(9223));

Template.build(template, name, { onBuildLogs: defaultBuildLogger() })
  .then((info) => console.log('Built template:', info.name || name, info.templateId || ''))
  .catch((error) => { console.error('Template build failed:', error.message); process.exit(1); });
