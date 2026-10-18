// 手元で動かして見るための起動（テスト用ログイン・AIは簡易版）。データはOneDriveの外に置く
// 使い方: node scripts/local.cjs  → http://localhost:8787/auth/dev-login で入る
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
let pkg;
try { pkg = require.resolve('wrangler/package.json'); }
catch { pkg = require.resolve('wrangler/package.json', { paths: [path.join(os.homedir(), '.task-app-tools')] }); }
const wrangler = path.join(path.dirname(pkg), 'bin', 'wrangler.js');
const persist = path.join(os.homedir(), '.task-app-tools', 'local-state');
const port = process.env.PORT || '8787';

spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'flick-task', '--env', 'test', '--local', '--persist-to', persist], { cwd: root, stdio: 'inherit', env: { ...process.env, CI: '1' } });
const dev = spawn(process.execPath, [wrangler, 'dev', '--env', 'test', '--port', port, '--ip', '127.0.0.1', '--persist-to', persist], { cwd: root, stdio: 'inherit', env: { ...process.env, CI: '1' } });
dev.on('exit', (code) => process.exit(code ?? 0));
