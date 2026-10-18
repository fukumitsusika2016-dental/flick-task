// ブラウザを実際に操作するテスト（Playwright）。スマホの画面サイズで行う。
// テストのタスクはすべて架空の内容。
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const SHOTS = path.resolve(__dirname, '..', 'test-results');
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP' };

async function launch() {
  const channel = process.env.PW_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined);
  try {
    return await chromium.launch({ channel, headless: !process.env.HEADED });
  } catch (e) {
    if (!channel) throw e;
    return chromium.launch({ headless: !process.env.HEADED });
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, msg, timeout = 5000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(80);
  }
  throw new Error(`${msg}（最後の値: ${last && last.message ? last.message : JSON.stringify(last)}）`);
}

async function run(base) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await launch();
  const results = [];
  const pageErrors = [];

  async function newPhone(opts = {}) {
    const ctx = await browser.newContext({ ...PHONE, baseURL: base, ...opts });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(`console: ${m.text()}`); });
    return { ctx, page };
  }

  async function login(page, email) {
    await page.goto(`/auth/dev-login?email=${encodeURIComponent(email)}`);
    await page.waitForSelector('body:not(.is-loading)');
    await page.waitForSelector('#account:not([hidden])');
  }

  async function addMemo(page, text) {
    await page.locator('#memo').fill(text);
    await page.keyboard.press('Enter');
    await page.locator('.card-wrap', { hasText: text }).first().waitFor();
  }

  async function swipe(page, text, dx, { steps = 10, delay = 12 } = {}) {
    const card = page.locator('.card-wrap', { hasText: text }).first().locator('.card');
    const box = await card.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) { await page.mouse.move(x + (dx * i) / steps, y + i * 0.3); await sleep(delay); }
    await page.mouse.up();
  }

  async function counts(page) {
    return page.evaluate(() => Object.fromEntries(['todo', 'doing', 'done'].map((s) => [s, Number(document.querySelector(`[data-count="${s}"]`).textContent)])));
  }

  async function serverTasks(page) {
    return page.evaluate(async () => {
      const r = await fetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      return r.ok ? (await r.json()).tasks : { status: r.status };
    });
  }

  async function test(name, fn) {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - t0 });
      console.log(`  ✓ ${name}`);
    } catch (e) {
      results.push({ name, ok: false, ms: Date.now() - t0, err: e.message });
      console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
    }
  }

  console.log('\nブラウザテスト（スマホ 390×844）\n');

  /* ---- 1. 開いた瞬間メモ ---- */
  await test('開いた瞬間、JSの読み込みを待たずにメモ欄へ入力できる', async () => {
    const { ctx, page } = await newPhone();
    // app.js をわざと1.5秒遅らせても、HTMLだけで書き始められること
    await page.route('**/app.js', async (route) => { await sleep(1500); await route.continue(); });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const active = await page.evaluate(() => document.activeElement && document.activeElement.id);
    assert(active === 'memo', `最初に選ばれている欄が memo ではない: ${active}`);
    await page.keyboard.type('早いメモ');
    await page.waitForSelector('body:not(.is-loading)');
    assert((await page.locator('#memo').inputValue()) === '早いメモ', 'JSが読み込まれたあとに入力が消えた');
    await ctx.close();
  });

  await test('書きかけのメモは再読み込みしても残る', async () => {
    const { ctx, page } = await newPhone();
    await page.goto('/');
    await page.locator('#memo').fill('書きかけ');
    await page.reload();
    await page.waitForSelector('body:not(.is-loading)');
    assert((await page.locator('#memo').inputValue()) === '書きかけ', '下書きが消えた');
    await ctx.close();
  });

  /* ---- 2. 全画面スケルトン ---- */
  await test('読み込み中は全画面スケルトンが出て、終わると消える', async () => {
    const { ctx, page } = await newPhone();
    await page.route('**/api/sync', async (route) => { await sleep(1200); await route.continue(); });
    await page.goto('/');
    await page.waitForFunction(() => document.querySelector('#memo') && window.getComputedStyle(document.body).display);
    assert(await page.evaluate(() => document.body.classList.contains('is-loading')), '読み込み中の印がない');
    const sk = await page.locator('#skeleton').boundingBox();
    assert(sk && sk.height >= 800 && sk.width >= 380, `スケルトンが画面いっぱいでない: ${JSON.stringify(sk)}`);
    assert((await page.locator('.sk-card').count()) >= 5, 'スケルトンのカードが足りない');
    await page.screenshot({ path: path.join(SHOTS, '01_skeleton.png') });
    await page.waitForSelector('body:not(.is-loading)', { timeout: 6000 });
    await waitFor(async () => Number(await page.locator('#skeleton').evaluate((el) => getComputedStyle(el).opacity)) < 0.05, 'スケルトンが消えない');
    await ctx.close();
  });

  /* ---- 3. ログイン（Googleのみ） ---- */
  await test('未ログインのときは「ログイン」ボタンだけが出る（キャッチコピーなし）', async () => {
    const { ctx, page } = await newPhone();
    await page.goto('/');
    await page.waitForSelector('body:not(.is-loading)');
    assert(await page.locator('#login').isVisible(), 'ログインボタンが見えない');
    assert(!(await page.locator('#account').isVisible()), 'アカウントボタンが出ている');
    assert((await page.locator('#login').getAttribute('href')) === '/auth/login', 'ログインのリンク先が違う');
    const text = (await page.locator('#app').innerText()).replace(/\s+/g, ' ');
    assert(text.length < 60, `画面の文字が多すぎる（キャッチコピー？）: ${text}`);
    await page.screenshot({ path: path.join(SHOTS, '02_logged_out.png') });
    await ctx.close();
  });

  await test('ログインはGoogleの画面へ正しく案内する（PKCE・state付き）', async () => {
    const res = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    assert(res.status === 302, `302ではない: ${res.status}`);
    const loc = new URL(res.headers.get('location'));
    assert(loc.origin === 'https://accounts.google.com', `行き先がGoogleでない: ${loc.origin}`);
    const p = loc.searchParams;
    assert(p.get('client_id') === 'test-client.apps.googleusercontent.com', 'client_id が違う');
    assert(p.get('redirect_uri') === `${base}/auth/callback`, `redirect_uri が違う: ${p.get('redirect_uri')}`);
    assert(p.get('scope') === 'openid email profile', 'scope が違う');
    assert(p.get('code_challenge_method') === 'S256' && p.get('code_challenge'), 'PKCEがない');
    assert(p.get('state') && p.get('state').length >= 16, 'state がない');
    const sc = res.headers.get('set-cookie') || '';
    assert(/HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc), `Cookieの設定が弱い: ${sc}`);
  });

  await test('Googleから戻ったときの state が違えば、ログインさせない', async () => {
    const { ctx, page } = await newPhone();
    await page.goto('/auth/callback?code=x&state=wrong');
    await page.waitForSelector('#toast.show');
    assert(/ログインできませんでした/.test(await page.locator('#toast').innerText()), 'エラー表示がない');
    assert(new URL(page.url()).search === '', 'URLの ?login=failed が消えていない');
    assert(await page.locator('#login').isVisible(), 'ログインしてしまった');
    await ctx.close();
  });

  await test('ログインしていないとAPIは使えない（401）・別サイトからの書き込みは断る（403）', async () => {
    const r1 = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert(r1.status === 401, `401ではない: ${r1.status}`);
    const r2 = await fetch(`${base}/api/ai/organize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"a"}' });
    assert(r2.status === 401, `AIが401ではない: ${r2.status}`);
    const r3 = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert(r3.status === 403, `別サイトからの書き込みが403ではない: ${r3.status}`);
    const r4 = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert(r4.status === 403, `別サイトからのログアウトが403ではない: ${r4.status}`);
    const r5 = await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert(r5.status === 415, `JSON以外の送信が415ではない: ${r5.status}`);
  });

  await test('画面の安全設定（CSPなど）が付いている', async () => {
    const r = await fetch(`${base}/`);
    const csp = r.headers.get('content-security-policy') || '';
    assert(/default-src 'self'/.test(csp) && /script-src 'self'/.test(csp), `CSPがない: ${csp}`);
    assert(r.headers.get('x-content-type-options') === 'nosniff', 'nosniff がない');
  });

  /* ---- 4. ログイン前に書いたメモ → ログイン後にサーバーへ ---- */
  await test('ログイン前に書いたメモも、ログインするとサーバーに保存される', async () => {
    const { ctx, page } = await newPhone();
    await page.goto('/');
    await page.waitForSelector('body:not(.is-loading)');
    await addMemo(page, 'ログイン前のメモ');
    await login(page, 'early@example.com');
    await waitFor(async () => {
      const t = await serverTasks(page);
      return Array.isArray(t) && t.some((x) => x.title === 'ログイン前のメモ');
    }, 'サーバーに保存されていない');
    await ctx.close();
  });

  /* ---- 5. メイン：追加・フリック ---- */
  const { ctx: mainCtx, page } = await newPhone();
  await login(page, 'alice@example.com');

  await test('Enterでタスクを追加でき、入力欄はすぐ次を書ける', async () => {
    await addMemo(page, '歯ブラシを発注する');
    await addMemo(page, '研修の資料を読む');
    assert((await page.locator('#memo').inputValue()) === '', '入力欄が空にならない');
    assert(await page.evaluate(() => document.activeElement.id === 'memo'), '入力欄から選択が外れた');
    const c = await counts(page);
    assert(c.todo === 2, `未着手の数が2ではない: ${JSON.stringify(c)}`);
    const first = await page.locator('.card-wrap .title').first().innerText();
    assert(first === '研修の資料を読む', `新しいタスクが一番上にない: ${first}`);
    await waitFor(async () => (await serverTasks(page)).length === 2, 'サーバーに2件保存されない');
    await page.screenshot({ path: path.join(SHOTS, '03_added.png') });
  });

  await test('空のままEnterを押してもタスクは増えない', async () => {
    await page.locator('#memo').fill('   ');
    await page.keyboard.press('Enter');
    await sleep(300);
    assert((await counts(page)).todo === 2, '空のタスクが追加された');
    await page.locator('#memo').fill('');
  });

  await test('右へフリック → 「進行中」に移る（数も変わる）', async () => {
    await swipe(page, '歯ブラシを発注する', 260);
    await waitFor(async () => (await counts(page)).doing === 1, '進行中が1にならない');
    const c = await counts(page);
    assert(c.todo === 1, `未着手が1ではない: ${JSON.stringify(c)}`);
    assert((await page.locator('.card-wrap', { hasText: '歯ブラシを発注する' }).count()) === 0, '未着手の一覧に残っている');
    await page.waitForSelector('#toast.show');
    const tw = await page.locator('#toast').evaluate((el) => ({ h: el.offsetHeight, sw: el.scrollWidth, w: el.clientWidth }));
    assert(tw.h < 70, `通知が折り返している: ${JSON.stringify(tw)}`);
  });

  await test('短く素早いフリックでも反応する（速さで判定）', async () => {
    await page.locator('.tab[data-status="doing"]').click();
    await page.locator('.card-wrap', { hasText: '歯ブラシを発注する' }).waitFor();
    await swipe(page, '歯ブラシを発注する', 90, { steps: 3, delay: 8 });
    await waitFor(async () => (await counts(page)).done === 1, '素早いフリックで完了にならない');
  });

  await test('少しだけ動かして離すと、元の位置に戻る（変化なし）', async () => {
    await page.locator('.tab[data-status="todo"]').click();
    await page.locator('.card-wrap', { hasText: '研修の資料を読む' }).waitFor();
    await swipe(page, '研修の資料を読む', 50, { steps: 10, delay: 40 });
    await sleep(600);
    const c = await counts(page);
    assert(c.todo === 1 && c.doing === 0, `少し動かしただけで変わった: ${JSON.stringify(c)}`);
    const tr = await page.locator('.card-wrap', { hasText: '研修の資料を読む' }).locator('.card').evaluate((el) => el.style.transform);
    assert(!tr || tr === 'none', `カードが戻っていない: ${tr}`);
  });

  await test('指を止めてから離したときは、払ったことにしない（誤操作防止）', async () => {
    const card = page.locator('.card-wrap', { hasText: '研修の資料を読む' }).locator('.card');
    const box = await card.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 3; i++) { await page.mouse.move(x + i * 30, y); await sleep(8); }
    await sleep(300);
    await page.mouse.up();
    await sleep(600);
    const c = await counts(page);
    assert(c.todo === 1 && c.doing === 0, `止めてから離したのに変わった: ${JSON.stringify(c)}`);
  });

  await test('完了タブで左へフリック → 「進行中」に戻る', async () => {
    await page.locator('.tab[data-status="done"]').click();
    await page.locator('.card-wrap', { hasText: '歯ブラシを発注する' }).waitFor();
    await page.screenshot({ path: path.join(SHOTS, '04_done_tab.png') });
    await swipe(page, '歯ブラシを発注する', -260);
    await waitFor(async () => (await counts(page)).doing === 1 && (await counts(page)).done === 0, '進行中に戻らない');
  });

  await test('通知の「元に戻す」で直前の操作を取り消せる', async () => {
    await page.locator('#toast.show .toast-action').click();
    await waitFor(async () => (await counts(page)).done === 1, '元に戻らない');
    await page.locator('.card-wrap', { hasText: '歯ブラシを発注する' }).waitFor();
  });

  await test('未着手で左へフリック → 削除、「元に戻す」で復活', async () => {
    await page.locator('.tab[data-status="todo"]').click();
    await swipe(page, '研修の資料を読む', -260);
    await waitFor(async () => (await counts(page)).todo === 0, '削除されない');
    await waitFor(async () => (await serverTasks(page)).every((t) => t.title !== '研修の資料を読む'), 'サーバーから消えない');
    await page.locator('#toast.show .toast-action').click();
    await waitFor(async () => (await counts(page)).todo === 1, '復活しない');
    await waitFor(async () => (await serverTasks(page)).some((t) => t.title === '研修の資料を読む'), 'サーバーに戻らない');
  });

  await test('フリック中は、行き先（進行中へ／削除など）が色つきで見える', async () => {
    const card = page.locator('.card-wrap', { hasText: '研修の資料を読む' }).locator('.card');
    const box = await card.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(x + i * 22, y); await sleep(15); }
    const hint = await page.locator('.card-wrap', { hasText: '研修の資料を読む' }).locator('.card-action.left').evaluate((el) => ({ text: el.innerText, cls: el.className, op: getComputedStyle(el).opacity }));
    // カードが横にはみ出しても、画面が縮小されずメモ欄が見えたままであること
    const view = await page.evaluate(() => { const r = document.querySelector('#composer').getBoundingClientRect(); return { w: innerWidth, h: innerHeight, bottom: r.bottom, sw: document.documentElement.scrollWidth }; });
    await page.screenshot({ path: path.join(SHOTS, '05_swiping.png') });
    for (let i = 7; i >= 0; i--) { await page.mouse.move(x + i * 22, y); await sleep(15); }
    await page.mouse.up();
    assert(/進行中へ/.test(hint.text) && /doing/.test(hint.cls), `行き先の表示が違う: ${JSON.stringify(hint)}`);
    assert(view.w === 390 && view.sw <= 390 && view.bottom <= view.h, `フリック中に画面が縮小・メモ欄が画面外: ${JSON.stringify(view)}`);
    assert(Number(hint.op) > 0.5, `行き先の表示が薄い: ${hint.op}`);
    await sleep(500);
    assert((await counts(page)).todo === 1, '戻したのに変わった');
  });

  await test('キーボードの→でも操作できる（フリックできない人向け）', async () => {
    await page.locator('.card-wrap', { hasText: '研修の資料を読む' }).locator('.card').focus();
    await page.keyboard.press('ArrowRight');
    await waitFor(async () => (await counts(page)).doing === 1, '→で進行中にならない');
    await page.locator('#toast.show .toast-action').click();
    await waitFor(async () => (await counts(page)).todo === 1, '元に戻らない');
  });

  await test('動きが止まっても（別アプリへ切り替えなど）、フリックは途中で止まらず完了する', async () => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 }); // 画面の動きを全部止める
    await page.locator('.card-wrap', { hasText: '研修の資料を読む' }).locator('.card').focus();
    await page.keyboard.press('ArrowRight');
    await sleep(1200);
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
    const c = await counts(page);
    assert(c.doing === 1 && c.todo === 0, `動きが止まると完了しない: ${JSON.stringify(c)}`);
    await page.locator('#toast.show .toast-action').click();
    await waitFor(async () => (await counts(page)).todo === 1, '元に戻らない');
    await cdp.detach();
  });

  /* ---- 6. 編集シート ---- */
  await test('タップで編集シートが開き、名前とステータスを変えられる', async () => {
    await page.locator('.tab[data-status="todo"]').click();
    await page.locator('.card-wrap', { hasText: '研修の資料を読む' }).locator('.card').click();
    await page.waitForSelector('#sheet[open]');
    await sleep(600);
    await page.screenshot({ path: path.join(SHOTS, '06_sheet.png') });
    await page.locator('#sheet-title').fill('研修の資料を読んでまとめる');
    await page.locator('#sheet [data-set="doing"]').click();
    await page.locator('#sheet button[type="submit"]').click();
    await waitFor(async () => !(await page.locator('#sheet').evaluate((d) => d.open)), 'シートが閉じない');
    await waitFor(async () => (await counts(page)).doing === 1, '進行中にならない');
    await waitFor(async () => (await serverTasks(page)).some((t) => t.title === '研修の資料を読んでまとめる' && t.status === 'doing'), 'サーバーに反映されない');
  });

  await test('編集シートの「削除」で消せる', async () => {
    await page.locator('#memo').fill('消すためのタスク');
    await page.keyboard.press('Enter');
    await page.locator('.card-wrap', { hasText: '消すためのタスク' }).locator('.card').click();
    await page.waitForSelector('#sheet[open]');
    await page.locator('#sheet-delete').click();
    await waitFor(async () => (await page.locator('.card-wrap', { hasText: '消すためのタスク' }).count()) === 0, '削除されない');
  });

  /* ---- 7. Workers AI ---- */
  await test('✨ボタン：音声入力のような長いメモを、AIで複数のタスクに分ける', async () => {
    await page.locator('#memo').fill('えっと牛乳を買う、銀行で振り込みをする、あと会議の資料を作る');
    await page.locator('#ai').click();
    await waitFor(async () => (await counts(page)).todo === 3, 'AIで3件に分かれない', 8000);
    const titles = await page.locator('.card-wrap .title').allInnerTexts();
    assert(titles[0] === '牛乳を買う' && titles[1] === '銀行で振り込みをする' && titles[2] === '会議の資料を作る', `順番か中身が違う: ${titles}`);
    assert((await page.locator('#memo').inputValue()) === '', 'メモ欄が空にならない');
    await waitFor(async () => /3件/.test(await page.locator('#toast.show').innerText()), '件数の通知がない');
    await page.screenshot({ path: path.join(SHOTS, '07_ai.png') });
  });

  await test('✨ボタン：患者さんの情報らしき言葉があれば、AIへ送る前に確認する', async () => {
    const before = (await counts(page)).todo;
    await page.locator('#memo').fill('Aさんの義歯を調整する');
    await page.locator('#ai').click();
    await waitFor(async () => /患者さんの情報/.test(await page.locator('#toast.show').innerText()), '確認が出ない');
    await sleep(400);
    assert((await counts(page)).todo === before, '確認の前にAIへ送られた');
    assert((await page.locator('#memo').inputValue()) === 'Aさんの義歯を調整する', 'メモが消えた');
    await page.locator('#toast.show .toast-action').click();
    await waitFor(async () => (await counts(page)).todo === before + 1, '「このまま送る」で送られない', 8000);
  });

  await test('AIは1人1日の回数に上限がある', async () => {
    const { ctx, page: p2 } = await newPhone();
    await login(p2, 'limit@example.com');
    const statuses = await p2.evaluate(async () => {
      const out = [];
      for (let i = 0; i < 31; i++) {
        const r = await fetch('/api/ai/organize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '牛乳を買う' }) });
        out.push(r.status);
      }
      return out;
    });
    assert(statuses.slice(0, 30).every((s) => s === 200) && statuses[30] === 429, `上限が効かない: ${statuses.join(',')}`);
    await ctx.close();
  });

  await test('✨ボタン：メモが空なら何もせず欄を揺らす', async () => {
    await page.locator('#memo').fill('');
    await page.locator('#ai').click();
    assert(await page.locator('#composer').evaluate((el) => el.classList.contains('shake')), '揺れない');
  });

  /* ---- 8. 保存・同期 ---- */
  await test('再読み込みしても、サーバーから同じ内容が戻る', async () => {
    const before = await counts(page);
    const total = before.todo + before.doing + before.done;
    await waitFor(async () => (await serverTasks(page)).length === total, 'サーバーへの保存が終わらない');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('body:not(.is-loading)');
    await waitFor(async () => JSON.stringify(await counts(page)) === JSON.stringify(before), `数が違う: 前 ${JSON.stringify(before)}`);
  });

  await test('他の人のタスクは見えない・書き換えられない', async () => {
    const aliceTasks = await serverTasks(page);
    const { ctx, page: bob } = await newPhone();
    await login(bob, 'bob@example.com');
    const bobTasks = await serverTasks(bob);
    assert(Array.isArray(bobTasks) && bobTasks.length === 0, `他人のタスクが見える: ${JSON.stringify(bobTasks)}`);
    // 同じIDで上書きを試みる
    const target = aliceTasks[0];
    await bob.evaluate(async (t) => {
      await fetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ puts: [{ ...t, title: 'のっとり', updated_at: Date.now() + 1e6 }], dels: [] }) });
      await fetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ puts: [], dels: [t.id] }) });
    }, target);
    const after = await serverTasks(page);
    const same = after.find((t) => t.id === target.id);
    assert(same && same.title === target.title, `他人に書き換え・削除された: ${JSON.stringify(same)}`);
    await ctx.close();
  });

  await test('電波がなくても開ける・メモでき、つながったら同期する', async () => {
    await page.reload();
    await page.waitForSelector('body:not(.is-loading)');
    await waitFor(() => page.evaluate(() => !!navigator.serviceWorker.controller), 'Service Worker が動いていない', 8000);
    await mainCtx.setOffline(true);
    await page.reload();
    await page.waitForSelector('body:not(.is-loading)', { timeout: 8000 });
    assert((await counts(page)).todo >= 1, 'オフラインでタスクが表示されない');
    await addMemo(page, '圏外で書いたメモ');
    await mainCtx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitFor(async () => (await serverTasks(page)).some((t) => t.title === '圏外で書いたメモ'), 'つながったあと同期されない', 8000);
  });

  /* ---- 9. 見た目 ---- */
  await test('スマホ幅（375px・390px）で横にはみ出さない・文字が大きめ', async () => {
    for (const width of [375, 390]) {
      await page.setViewportSize({ width, height: 812 });
      await sleep(300);
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      assert(sw <= width, `${width}px で横にはみ出す: ${sw}`);
    }
    const fs = await page.locator('.card .title').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    assert(fs >= 17, `文字が小さい: ${fs}px`);
    const memoFs = await page.locator('#memo').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    assert(memoFs >= 16, `メモ欄の文字が16px未満（iPhoneで拡大されてしまう）: ${memoFs}`);
    await page.setViewportSize({ width: 390, height: 844 });
  });

  await test('Liquid Glass：ガラス（背景ぼかし・半透明）と白ベース', async () => {
    const g = await page.locator('.card').first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { bf: s.backdropFilter || s.webkitBackdropFilter, bg: s.backgroundImage };
    });
    assert(/blur\(/.test(g.bf), `背景ぼかしがない: ${g.bf}`);
    assert(/rgba\(255, 255, 255/.test(g.bg), `半透明の白でない: ${g.bg}`);
    const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert(body === 'rgb(244, 246, 251)', `白ベースでない: ${body}`);
    await page.screenshot({ path: path.join(SHOTS, '08_main.png') });
  });

  await test('アニメーション：タブの印が滑る・カードが流れて入る', async () => {
    const t0 = await page.locator('.tab-indicator').evaluate((el) => getComputedStyle(el).transitionDuration);
    assert(parseFloat(t0) > 0.2, 'タブの印に動きがない');
    await page.locator('.tab[data-status="todo"]').click();
    await page.locator('.tab[data-status="doing"]').click();
    const anim = await page.evaluate(() => document.getAnimations().length);
    assert(anim > 2, `動いているアニメーションが少ない: ${anim}`);
    const ind = await page.locator('.tab-indicator').evaluate((el) => el.style.transform);
    assert(ind === 'translateX(100%)', `タブの印が移動していない: ${ind}`);
  });

  await test('共用端末：別の人がログインしても、前の人の未送信メモは混ざらない', async () => {
    const { ctx, page: p } = await newPhone();
    await login(p, 'staff1@example.com');
    await ctx.setOffline(true);
    await addMemo(p, 'スタッフ1の未送信メモ');
    await ctx.clearCookies(); // ログインの期限切れと同じ状態
    await ctx.setOffline(false);
    await login(p, 'staff2@example.com');
    await sleep(800);
    const tasks = await serverTasks(p);
    assert(Array.isArray(tasks) && tasks.length === 0, `前の人のメモが送られた: ${JSON.stringify(tasks)}`);
    assert((await p.locator('.card-wrap', { hasText: 'スタッフ1の未送信メモ' }).count()) === 0, '前の人のメモが表示されている');
    await ctx.close();
  });

  await test('ログアウトの通信に失敗したら、ログアウトしたことにしない', async () => {
    await mainCtx.setOffline(true);
    await page.locator('#account').click();
    await page.waitForSelector('#account-sheet[open]');
    await page.locator('#logout').click();
    await waitFor(async () => /ログアウトできませんでした/.test(await page.locator('#toast.show').innerText()), '失敗の通知が出ない');
    assert(await page.locator('#account').isVisible(), 'ログアウト扱いになった');
    await mainCtx.setOffline(false);
    await page.keyboard.press('Escape');
    await waitFor(async () => !(await page.locator('#account-sheet').evaluate((d) => d.open)), 'シートが閉じない');
  });

  /* ---- 10. ログアウト ---- */
  await test('ログアウトすると、この端末のタスクも消える', async () => {
    await page.locator('#account').click();
    await page.waitForSelector('#account-sheet[open]');
    assert(/alice@example.com/.test(await page.locator('#account-sheet').innerText()), 'メールアドレスが出ない');
    await page.locator('#logout').click();
    await page.waitForSelector('#login:not([hidden])');
    const c = await counts(page);
    assert(c.todo + c.doing + c.done === 0, `タスクが残っている: ${JSON.stringify(c)}`);
    const r = await serverTasks(page);
    assert(r.status === 401, 'ログアウト後もAPIが使える');
  });

  await mainCtx.close();

  await test('画面のエラー（JSの例外・CSP違反など）が1つもない', async () => {
    assert(pageErrors.length === 0, pageErrors.join('\n'));
  });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n結果: ${results.length - failed.length} / ${results.length} 合格${failed.length ? `（不合格 ${failed.length}）` : ''}`);
  fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 2));
  return failed.length ? 1 : 0;
}

module.exports = { run };
