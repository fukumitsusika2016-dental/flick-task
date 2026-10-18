// Flick — 画面の動き（フレームワークなし）
// 方針：タスクはまず端末に保存して即表示 → 裏でサーバー（Cloudflare D1）と同期する。
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const STATUSES = ['todo', 'doing', 'done'];
  const LS = { tasks: 'flick.tasks', ops: 'flick.ops', draft: 'flick.draft', tab: 'flick.tab', user: 'flick.user', owner: 'flick.owner' };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 動きの終わりを待つ。ただし画面の描画が止まっても（別アプリへ切り替えなど）、決まった時間で必ず先へ進む
  const settle = (anim, ms) => Promise.race([anim.finished.catch(() => {}), sleep(ms)]);

  const store = {
    read(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 容量不足などは無視 */ } },
    remove(k) { try { localStorage.removeItem(k); } catch { /* noop */ } },
  };

  const state = {
    tasks: new Map(Object.entries(store.read(LS.tasks, {}))),
    ops: store.read(LS.ops, {}), // id -> {op:'put', task} | {op:'del'}
    tab: STATUSES.includes(store.read(LS.tab, 'todo')) ? store.read(LS.tab, 'todo') : 'todo',
    user: undefined, // undefined=確認中 / null=未ログイン / object=ログイン中
    syncing: false,
    syncAgain: false,
    epoch: 0, // ログアウトで増やす。通信中だった同期の結果を捨てるため
  };

  // 見本版（サーバーなし。スマホで見た目と操作を試す用）：ログイン・同期をせず、AIは簡易版
  const DEMO = !!document.querySelector('#app[data-demo]');

  const memo = $('#memo');
  const composer = $('#composer');
  const list = $('#list');
  const els = new Map(); // id -> <li>

  /* ---------- メモ欄：開いた瞬間から書ける ---------- */
  // HTMLの autofocus で既に入力できる。JSが来る前に打った文字は消さない
  if (!memo.value) memo.value = store.read(LS.draft, '');
  if (document.activeElement !== memo) memo.focus({ preventScroll: true });
  autosize();
  updateComposer();

  memo.addEventListener('input', () => {
    store.write(LS.draft, memo.value);
    autosize();
    updateComposer();
  });
  memo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = memo.value.trim();
    if (!text) return shake();
    clearMemo();
    switchTab('todo', { silent: true });
    const t = addTask(text);
    render({ fresh: new Set([t.id]) });
    memo.focus({ preventScroll: true });
  });

  function autosize() {
    memo.style.height = 'auto';
    memo.style.height = `${memo.scrollHeight}px`;
  }
  function updateComposer() { composer.classList.toggle('has-text', memo.value.trim().length > 0); }
  function clearMemo() { memo.value = ''; store.write(LS.draft, ''); autosize(); updateComposer(); }
  function shake() {
    composer.classList.remove('shake');
    void composer.offsetWidth;
    composer.classList.add('shake');
    vibrate(20);
  }

  // iPhoneでキーボードが出たときもメモ欄をキーボードの上に置く
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onVV = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', `${Math.round(kb)}px`);
    };
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
  }

  /* ---------- タスクの操作（端末に保存 → 同期） ---------- */
  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function addTask(title, movedAt = Date.now()) {
    const now = Date.now();
    const t = { id: uid(), title: title.slice(0, 500), status: 'todo', moved_at: movedAt, created_at: now, updated_at: now };
    putTask(t);
    return t;
  }

  function putTask(t) {
    state.tasks.set(t.id, t);
    state.ops[t.id] = { op: 'put', task: { ...t } };
    persist();
    scheduleSync();
  }

  function deleteTask(id) {
    state.tasks.delete(id);
    state.ops[id] = { op: 'del' };
    persist();
    scheduleSync();
  }

  function setStatus(id, status) {
    const t = state.tasks.get(id);
    if (!t || t.status === status) return;
    const now = Date.now();
    putTask({ ...t, status, moved_at: now, updated_at: now });
  }

  function persist() {
    store.write(LS.tasks, Object.fromEntries(state.tasks));
    store.write(LS.ops, state.ops);
  }

  let syncTimer;
  function scheduleSync(delay = 350) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, delay);
  }

  async function sync() {
    if (DEMO) { setTimeout(() => { setUser(null); $('#login').hidden = true; ready(); }, 700); return; }
    if (state.syncing) { state.syncAgain = true; return; }
    state.syncing = true;
    const epoch = state.epoch;
    const sent = Object.entries(state.ops).slice(0, 200);
    const puts = sent.filter(([, o]) => o.op === 'put').map(([, o]) => o.task);
    const dels = sent.filter(([, o]) => o.op === 'del').map(([id]) => id);
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        // owner：この端末のデータの持ち主。別の人がログインしたら、サーバーは前の人の変更を受け取らない
        body: JSON.stringify({ puts, dels, owner: store.read(LS.owner, null) }),
      });
      if (epoch !== state.epoch) return;
      if (res.status === 401) { setUser(null); return; }
      if (!res.ok) throw new Error(`sync ${res.status}`);
      const data = await res.json();
      if (epoch !== state.epoch) return;
      if (data.ownerMismatch) {
        // 前の人の残りは送らずに捨てる（共用の端末で混ざらないように）
        state.ops = {};
      } else {
        // 送った変更のうち、送信中に上書きされていないものを消す
        for (const [id, o] of sent) if (state.ops[id] === o) delete state.ops[id];
      }
      store.write(LS.owner, data.user.id);
      const next = new Map(data.tasks.map((t) => [t.id, t]));
      for (const [id, o] of Object.entries(state.ops)) {
        if (o.op === 'put') next.set(id, o.task); else next.delete(id);
      }
      state.tasks = next;
      setUser(data.user);
      persist();
      render();
      if (Object.keys(state.ops).length) state.syncAgain = true;
    } catch (err) {
      // 圏外など：端末の内容のまま使い続ける
      if (state.user === undefined) setUser(store.read(LS.user, null));
    } finally {
      state.syncing = false;
      ready();
      if (state.syncAgain && state.user) { state.syncAgain = false; scheduleSync(50); }
    }
  }

  /* ---------- ログイン状態 ---------- */
  function setUser(user) {
    state.user = user || null;
    if (user) store.write(LS.user, user); else store.remove(LS.user);
    const loginEl = $('#login');
    const acc = $('#account');
    loginEl.hidden = !!user;
    acc.hidden = !user;
    if (user) {
      fillAvatar(acc, user);
      fillAvatar($('#who-avatar'), user);
      $('#who-name').textContent = user.name || '';
      $('#who-email').textContent = user.email || '';
    }
  }

  function fillAvatar(el, user) {
    el.textContent = '';
    if (user.picture) {
      const img = new Image();
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = user.picture;
      img.onerror = () => { el.textContent = (user.name || user.email || '?').slice(0, 1).toUpperCase(); };
      el.append(img);
    } else {
      el.textContent = (user.name || user.email || '?').slice(0, 1).toUpperCase();
    }
  }

  $('#account').addEventListener('click', () => openSheet($('#account-sheet')));
  // 未送信の変更を送り切る（最大3回）
  async function flush() {
    for (let i = 0; i < 3 && Object.keys(state.ops).length; i++) {
      while (state.syncing) await sleep(50);
      clearTimeout(syncTimer);
      await sync();
    }
  }

  $('#logout').addEventListener('click', async () => {
    await flush();
    if (Object.keys(state.ops).length) {
      toast(`未送信の変更が${Object.keys(state.ops).length}件あります`, 'それでもログアウト', logout);
      return;
    }
    logout();
  });

  async function logout() {
    let ok = false;
    try { ok = (await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })).ok; } catch { /* 圏外 */ }
    if (!ok) { toast('ログアウトできませんでした。通信を確認してください'); return; }
    // 共用の端末でも残らないように、この端末のタスクも消す
    state.epoch++;
    clearTimeout(syncTimer);
    state.tasks.clear();
    state.ops = {};
    store.remove(LS.owner);
    persist();
    render();
    setUser(null);
    await closeSheet($('#account-sheet'));
    toast('ログアウトしました');
  }

  /* ---------- 全画面スケルトン ---------- */
  let isReady = false;
  function ready() {
    if (isReady) return;
    isReady = true;
    document.body.classList.remove('is-loading');
    // 消えたあとのスケルトンは止めて外す（裏で光の動きを回し続けない）
    const sk = $('#skeleton');
    setTimeout(() => { sk.hidden = true; }, 600);
    render({ stagger: true });
    const p = new URLSearchParams(location.search);
    if (p.has('login')) {
      toast(p.get('login') === 'denied' ? 'このアカウントでは使えません' : 'ログインできませんでした');
      history.replaceState(null, '', '/');
    }
  }
  setTimeout(() => { if (!isReady) { setUser(store.read(LS.user, null)); ready(); } }, 5000);

  /* ---------- タブ ---------- */
  const tabs = [...document.querySelectorAll('.tab')];
  tabs.forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.status)));

  function switchTab(status, { silent = false } = {}) {
    if (state.tab === status) return;
    const dir = STATUSES.indexOf(status) > STATUSES.indexOf(state.tab) ? 1 : -1;
    state.tab = status;
    store.write(LS.tab, status);
    updateTabs();
    if (!silent) render({ stagger: true, dir });
  }

  function updateTabs() {
    const i = STATUSES.indexOf(state.tab);
    tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.status === state.tab)));
    $('.tab-indicator').style.transform = `translateX(${i * 100}%)`;
  }

  const lastCounts = {};
  function updateCounts() {
    const c = { todo: 0, doing: 0, done: 0 };
    for (const t of state.tasks.values()) c[t.status]++;
    for (const s of STATUSES) {
      const el = document.querySelector(`[data-count="${s}"]`);
      if (lastCounts[s] !== undefined && lastCounts[s] !== c[s]) {
        el.classList.remove('bump');
        void el.offsetWidth;
        el.classList.add('bump');
      }
      lastCounts[s] = c[s];
      el.textContent = c[s];
    }
  }

  /* ---------- 一覧の表示（FLIPで滑らかに並び替え） ---------- */
  function render({ fresh = new Set(), stagger = false } = {}) {
    updateTabs();
    updateCounts();
    const items = [...state.tasks.values()]
      .filter((t) => t.status === state.tab)
      .sort((a, b) => b.moved_at - a.moved_at || b.created_at - a.created_at);

    const before = new Map();
    if (!stagger) for (const [id, el] of els) before.set(id, el.getBoundingClientRect().top);

    if (stagger) { list.textContent = ''; els.clear(); }
    const keep = new Set(items.map((t) => t.id));
    for (const [id, el] of els) if (!keep.has(id)) { el.remove(); els.delete(id); }

    items.forEach((t, i) => {
      let el = els.get(t.id);
      if (!el) {
        el = createCard(t);
        els.set(t.id, el);
        if (stagger || fresh.has(t.id)) {
          el.classList.add('enter');
          el.style.setProperty('--d', `${stagger ? Math.min(i, 10) * 55 : 0}ms`);
          if (fresh.has(t.id)) el.classList.add('new');
          el.addEventListener('animationend', (e) => { if (e.target === el) el.classList.remove('enter'); }, { once: true });
        }
      } else {
        updateCard(el, t);
      }
      if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
    });

    if (!reduceMotion && !stagger) {
      for (const [id, el] of els) {
        const old = before.get(id);
        if (old === undefined) continue;
        const dy = old - el.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) {
          el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 520, easing: 'cubic-bezier(.34,1.4,.64,1)' });
        }
      }
    }
    $('#empty').hidden = items.length > 0 || document.body.classList.contains('is-loading');
  }

  const ICON = {
    doing: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    done: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    todo: '<svg viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
    delete: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
  };
  const LABEL = { doing: '進行中へ', done: '完了', todo: '未着手へ', delete: '削除' };

  // 右へフリック＝進める、左へフリック＝戻す。端では削除
  function actionFor(status, dir) {
    if (dir > 0) return { todo: 'doing', doing: 'done', done: 'delete' }[status];
    return { todo: 'delete', doing: 'todo', done: 'doing' }[status];
  }

  function createCard(t) {
    const li = document.createElement('li');
    li.className = 'card-wrap';
    li.dataset.id = t.id;
    li.innerHTML = `
      <div class="card-action left"></div>
      <div class="card-action right"></div>
      <div class="card glass" tabindex="0" role="button">
        <span class="dot" aria-hidden="true"></span>
        <div class="body"><p class="title"></p><time></time></div>
      </div>`;
    updateCard(li, t);
    attachSwipe(li);
    return li;
  }

  function updateCard(li, t) {
    const card = $('.card', li);
    card.dataset.status = t.status;
    $('.title', li).textContent = t.title;
    const time = $('time', li);
    time.dateTime = new Date(t.moved_at).toISOString();
    time.textContent = relTime(t.moved_at);
    card.setAttribute('aria-label', `${t.title}（右へフリックで${LABEL[actionFor(t.status, 1)]}、左へで${LABEL[actionFor(t.status, -1)]}）`);
  }

  function relTime(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return `${Math.floor(s / 60)}分前`;
    if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  setInterval(() => { for (const [id, el] of els) { const t = state.tasks.get(id); if (t) $('time', el).textContent = relTime(t.moved_at); } }, 60000);

  /* ---------- フリック（スワイプ）でステータス変更 ---------- */
  function attachSwipe(li) {
    const card = $('.card', li);
    const leftBg = $('.card-action.left', li);
    const rightBg = $('.card-action.right', li);
    let sx = 0, sy = 0, dx = 0, pid = null, lock = null, armed = false, samples = [];

    card.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pid = e.pointerId; sx = e.clientX; sy = e.clientY; dx = 0; lock = null; armed = false;
      samples = [{ x: e.clientX, t: performance.now() }];
    });

    card.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid) return;
      const mx = e.clientX - sx, my = e.clientY - sy;
      if (lock === null) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        lock = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
        if (lock === 'x') { card.setPointerCapture(pid); li.classList.add('dragging'); }
      }
      if (lock !== 'x') return;
      e.preventDefault();
      samples.push({ x: e.clientX, t: performance.now() });
      if (samples.length > 6) samples.shift();
      const t = state.tasks.get(li.dataset.id);
      if (!t) return;
      const act = actionFor(t.status, Math.sign(mx) || 1);
      dx = mx;
      const w = card.offsetWidth;
      const visual = act ? dx : dx * 0.25;
      card.style.transform = `translateX(${visual}px) rotate(${visual / 60}deg)`;
      const bg = dx > 0 ? leftBg : rightBg;
      const other = dx > 0 ? rightBg : leftBg;
      other.style.opacity = 0;
      bg.className = `card-action ${dx > 0 ? 'left' : 'right'} ${act}`;
      bg.innerHTML = dx > 0 ? `${ICON[act]}<span>${LABEL[act]}</span>` : `<span>${LABEL[act]}</span>${ICON[act]}`;
      bg.style.opacity = Math.min(1, Math.abs(dx) / 60);
      const nowArmed = Math.abs(dx) > w * 0.33;
      if (nowArmed !== armed) { armed = nowArmed; bg.classList.toggle('armed', armed); if (armed) vibrate(12); }
    });

    const finish = (e, cancelled) => {
      if (e.pointerId !== pid) return;
      pid = null;
      li.classList.remove('dragging');
      if (lock === null && !cancelled) { openEditor(li.dataset.id); return; }
      if (lock !== 'x') return;
      const last = samples[samples.length - 1], first = samples[0];
      // 指を止めてから離したときは「払った」とみなさない
      const idle = last ? performance.now() - last.t : Infinity;
      const v = idle < 80 && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0; // px/ms
      const w = card.offsetWidth;
      const flick = Math.abs(v) > 0.55 && Math.sign(v) === Math.sign(dx) && Math.abs(dx) > 30;
      if (!cancelled && (Math.abs(dx) > w * 0.33 || flick)) commit(li, Math.sign(dx));
      else snapBack(li);
    };
    card.addEventListener('pointerup', (e) => finish(e, false));
    card.addEventListener('pointercancel', (e) => finish(e, true));

    // キーボードでも操作できるように（←→で変更、Enterで編集）
    card.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); commit(li, 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); commit(li, -1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(li.dataset.id); }
    });
  }

  function snapBack(li) {
    const card = $('.card', li);
    card.style.transform = '';
    li.querySelectorAll('.card-action').forEach((b) => { b.style.opacity = 0; b.classList.remove('armed'); });
  }

  async function commit(li, dir) {
    const id = li.dataset.id;
    const t = state.tasks.get(id);
    if (!t || li.dataset.leaving) return;
    const act = actionFor(t.status, dir);
    li.dataset.leaving = '1';
    vibrate(act === 'delete' ? [10, 40, 18] : 18);
    const card = $('.card', li);
    const w = card.offsetWidth;
    if (!reduceMotion) {
      const from = getComputedStyle(card).transform;
      card.style.transition = 'none';
      await settle(card.animate(
        [{ transform: from === 'none' ? 'none' : from, opacity: 1 }, { transform: `translateX(${dir * (w + 60)}px) rotate(${dir * 9}deg)`, opacity: 0 }],
        { duration: 300, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' }
      ), 400);
      await settle(li.animate([{ height: `${li.offsetHeight}px`, marginBottom: '0px' }, { height: '0px', marginBottom: '-12px' }], { duration: 220, easing: 'ease-out', fill: 'forwards' }), 320);
    }
    const prev = { ...t };
    if (act === 'delete') {
      deleteTask(id);
      render();
      toast('削除しました', '元に戻す', () => { putTask({ ...prev, updated_at: Date.now() }); render({ fresh: new Set([id]) }); });
    } else {
      setStatus(id, act);
      render();
      toast(`${LABEL[act].replace('へ', '')}にしました`, '元に戻す', () => {
        setStatus(id, prev.status);
        const cur = state.tasks.get(id);
        if (cur) putTask({ ...cur, moved_at: prev.moved_at });
        render({ fresh: new Set([id]) });
      });
    }
  }

  /* ---------- 編集シート ---------- */
  const sheet = $('#sheet');
  const sheetTitle = $('#sheet-title');
  let editing = null;

  function openEditor(id) {
    const t = state.tasks.get(id);
    if (!t) return;
    editing = id;
    sheetTitle.value = t.title;
    markSeg(t.status);
    openSheet(sheet);
  }
  function markSeg(status) {
    sheet.querySelectorAll('[data-set]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.set === status)));
  }
  sheet.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => {
    if (!editing) return;
    setStatus(editing, b.dataset.set);
    markSeg(b.dataset.set);
    vibrate(10);
    render();
  }));
  $('#sheet-delete').addEventListener('click', async () => {
    if (!editing) return;
    const prev = state.tasks.get(editing);
    const id = editing;
    editing = null;
    await closeSheet(sheet);
    deleteTask(id);
    render();
    if (prev) toast('削除しました', '元に戻す', () => { putTask({ ...prev, updated_at: Date.now() }); render({ fresh: new Set([id]) }); });
  });
  sheet.addEventListener('close', saveEditor);
  sheet.addEventListener('submit', (e) => { e.preventDefault(); closeSheet(sheet); });

  function saveEditor() {
    if (!editing) return;
    const t = state.tasks.get(editing);
    const title = sheetTitle.value.trim();
    editing = null;
    if (t && title && title !== t.title) {
      putTask({ ...t, title: title.slice(0, 500), updated_at: Date.now() });
      render();
    }
  }

  function openSheet(d) {
    d.classList.remove('closing');
    if (!d.open) d.showModal();
  }
  function closeSheet(d) {
    return new Promise((resolve) => {
      if (!d.open) return resolve();
      if (reduceMotion) { d.close(); return resolve(); }
      d.classList.add('closing');
      setTimeout(() => { d.classList.remove('closing'); d.close(); resolve(); }, 280);
    });
  }
  // 背景を押したら閉じる
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => {
    if (e.target === d) closeSheet(d);
  }));

  /* ---------- Workers AI：メモをタスクに分ける ---------- */
  const aiBtn = $('#ai');
  // 患者さんの情報らしい言葉。入っていたらAIへ送る前に一度止める（完全には見分けられない）
  const SENSITIVE = /(さん|様|さま|ちゃん|くん|氏|歳|才|号室|患者|生年月日|保険証|介護度|要介護)/;
  let confirmedText = null;
  aiBtn.addEventListener('click', async () => {
    const text = memo.value.trim();
    if (!text) return shake();
    if (DEMO) { await demoAI(text); return; }
    if (!state.user) { toast('AIはログインすると使えます', 'ログイン', () => { location.href = '/auth/login'; }); return; }
    if (SENSITIVE.test(text) && confirmedText !== text) {
      vibrate(20);
      toast('患者さんの情報は入っていませんか？', 'このまま送る', () => { confirmedText = text; aiBtn.click(); });
      return;
    }
    composer.classList.add('thinking');
    aiBtn.disabled = true;
    try {
      const res = await fetch('/api/ai/organize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text }),
      });
      if (res.status === 401) { setUser(null); throw new Error('unauthorized'); }
      if (res.status === 429) { toast('今日のAIの回数を使い切りました'); return; }
      if (!res.ok) throw new Error(`ai ${res.status}`);
      const { tasks } = await res.json();
      if (!tasks || !tasks.length) throw new Error('empty');
      clearMemo();
      switchTab('todo', { silent: true });
      // 上から順に、ひとつずつ流れ込むように追加
      const base = Date.now();
      for (let i = 0; i < tasks.length; i++) {
        const t = addTask(tasks[i], base - i);
        render({ fresh: new Set([t.id]) });
        if (!reduceMotion) await new Promise((r) => setTimeout(r, 110));
      }
      vibrate([10, 30, 10]);
      toast(`${tasks.length}件のタスクにしました`);
    } catch {
      toast('AIで分けられませんでした');
    } finally {
      composer.classList.remove('thinking');
      aiBtn.disabled = false;
      memo.focus({ preventScroll: true });
    }
  });

  // 見本版のAI：句読点や「あと」「それと」で区切るだけ（本物は Workers AI）
  async function demoAI(text) {
    composer.classList.add('thinking');
    await sleep(900);
    composer.classList.remove('thinking');
    const tasks = text.split(/[、。\n]|あと|それと/).map((x) => x.replace(/^(えー|えっと|あの)/, '').trim()).filter((x) => x.length > 1).slice(0, 10);
    if (!tasks.length) return shake();
    clearMemo();
    switchTab('todo', { silent: true });
    const base = Date.now();
    for (let i = 0; i < tasks.length; i++) {
      const t = addTask(tasks[i], base - i);
      render({ fresh: new Set([t.id]) });
      if (!reduceMotion) await sleep(110);
    }
    toast(`${tasks.length}件のタスクにしました（見本版のAI）`);
  }

  /* ---------- 通知（元に戻す付き） ---------- */
  const toastEl = $('#toast');
  let toastTimer;
  function toast(text, actionLabel = '', action = null) {
    clearTimeout(toastTimer);
    $('.toast-text', toastEl).textContent = text;
    const btn = $('.toast-action', toastEl);
    btn.textContent = actionLabel;
    btn.onclick = action ? () => { hideToast(); action(); } : null;
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add('show'));
    toastTimer = setTimeout(hideToast, action ? 6500 : 2400);
  }
  function hideToast() {
    toastEl.classList.remove('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 350);
  }

  /* ---------- 小さな演出 ---------- */
  function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch { /* noop */ } }

  document.addEventListener('pointerdown', (e) => {
    const host = e.target.closest('.icon-btn, .tab, .btn, .pill, .seg button, .toast-action');
    if (!host || reduceMotion) return;
    const r = host.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.width = s.style.height = `${size}px`;
    s.style.left = `${e.clientX - r.left - size / 2}px`;
    s.style.top = `${e.clientY - r.top - size / 2}px`;
    host.append(s);
    s.addEventListener('animationend', () => s.remove());
  });

  /* ---------- 起動 ---------- */
  updateTabs();
  sync();
  window.addEventListener('online', () => scheduleSync(0));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(0); });

  if (!DEMO && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    // 新しい版が入ったら知らせる（初回のインストールでは出さない）
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('新しい版があります', '更新', () => location.reload());
    });
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
