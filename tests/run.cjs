// テストの入口：手元サーバー（wrangler dev）を空のデータベースで起動 → ブラウザテスト → 終了
// 使い方: node tests/run.cjs
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const wrangler = path.join(path.dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const port = Number(process.env.PORT || 8799);
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'flick-e2e-'));

function log(...a) { console.log('[run]', ...a); }

log('データベースを準備:', persist);
const mig = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'flick-task', '--env', 'test', '--local', '--persist-to', persist], {
  cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' },
});
if (mig.status !== 0) { console.error(mig.stdout, mig.stderr); process.exit(1); }

log(`サーバーを起動: http://localhost:${port}`);
const server = spawn(process.execPath, [wrangler, 'dev', '--env', 'test', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--show-interactive-dev-session=false'], {
  cwd: root, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
server.stdout.on('data', (d) => { out += d; if (process.env.VERBOSE) process.stdout.write(d); });
server.stderr.on('data', (d) => { out += d; if (process.env.VERBOSE) process.stderr.write(d); });

async function waitReady() {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.ok) return;
    } catch { /* まだ起動中 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`サーバーが起動しませんでした\n${out}`);
}

function stop() {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
    else server.kill('SIGTERM');
  } catch { /* noop */ }
  try { fs.rmSync(persist, { recursive: true, force: true }); } catch { /* noop */ }
}

(async () => {
  let code = 1;
  try {
    await waitReady();
    log('起動しました');
    code = await require('./e2e.cjs').run(`http://localhost:${port}`);
  } catch (e) {
    console.error(e);
    console.error(out.slice(-3000));
  } finally {
    stop();
    process.exit(code);
  }
})();
