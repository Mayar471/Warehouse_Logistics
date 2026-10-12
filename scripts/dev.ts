import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const api = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], {
  stdio: 'inherit',
  env: { ...process.env, APP_MODE: 'demo' },
});
const web = spawn(
  process.execPath,
  [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'],
  { stdio: 'inherit' },
);
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  api.kill();
  web.kill();
}
api.on('exit', stop);
web.on('exit', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
