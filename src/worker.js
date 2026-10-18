// Flick — Cloudflare Worker（API・Googleログイン・Workers AI）
// 画面（public/）は Workers Static Assets が配り、/api/* と /auth/* だけこのコードが受ける。

const SESSION_COOKIE = 'flick_session';
const OAUTH_COOKIE = 'flick_oauth';
const SESSION_DAYS = 30;
const STATUSES = new Set(['todo', 'doing', 'done']);
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_TITLE = 500;
const MAX_OPS = 200;
const MAX_TASKS = 5000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/auth/')) return await handleAuth(request, env, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: 'server_error' }, 500);
    }
  },
};

/* ---------- 共通 ---------- */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, { maxAge, path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(n = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function sha256(text) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function isLocalHost(url) {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

// 別のサイトからの書き込みを断る（Cookie を悪用されないように）
function sameOrigin(request, url) {
  const origin = request.headers.get('origin');
  return !origin || origin === url.origin;
}

/* ---------- ログイン（Google） ---------- */

async function handleAuth(request, env, url) {
  const path = url.pathname;

  if (path === '/auth/login' && request.method === 'GET') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return new Response('Google login is not configured.', { status: 503 });
    }
    const state = randomToken(16);
    const verifier = randomToken(32);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${url.origin}/auth/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return new Response(null, {
      status: 302,
      headers: {
        location: auth.toString(),
        'set-cookie': cookie(OAUTH_COOKIE, `${state}.${verifier}`, { maxAge: 600, path: '/auth' }),
      },
    });
  }

  if (path === '/auth/callback' && request.method === 'GET') {
    const [savedState, verifier] = (parseCookies(request)[OAUTH_COOKIE] || '').split('.');
    const code = url.searchParams.get('code');
    if (!code || !savedState || url.searchParams.get('state') !== savedState) {
      return redirectHome('/?login=failed');
    }
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: `${url.origin}/auth/callback`,
      }),
    });
    if (!tokenRes.ok) return redirectHome('/?login=failed');
    const { id_token } = await tokenRes.json();
    // id_token は Google から HTTPS で直接受け取ったものなので、中身の確認だけ行う
    const claims = decodeJwt(id_token);
    const now = Math.floor(Date.now() / 1000);
    if (
      !claims ||
      claims.aud !== env.GOOGLE_CLIENT_ID ||
      !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) ||
      claims.exp < now ||
      !claims.email_verified
    ) {
      return redirectHome('/?login=failed');
    }
    if (!emailAllowed(env, claims.email)) return redirectHome('/?login=denied');
    return startSession(env, {
      id: `google:${claims.sub}`,
      email: claims.email,
      name: claims.name || claims.email,
      picture: claims.picture || '',
    });
  }

  // 手元のテスト専用。DEV_LOGIN=1 かつ localhost のときだけ動く（本番では必ず 404）
  if (path === '/auth/dev-login' && request.method === 'GET') {
    if (env.DEV_LOGIN !== '1' || !isLocalHost(url)) return new Response('Not found', { status: 404 });
    const email = (url.searchParams.get('email') || 'tester@example.com').slice(0, 100);
    return startSession(env, { id: `dev:${email}`, email, name: email.split('@')[0], picture: '' });
  }

  if (path === '/auth/logout' && request.method === 'POST') {
    if (!sameOrigin(request, url)) return json({ error: 'forbidden' }, 403);
    const token = parseCookies(request)[SESSION_COOKIE];
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie(SESSION_COOKIE, '', { maxAge: 0 }) });
  }

  return new Response('Not found', { status: 404 });
}

function redirectHome(location) {
  return new Response(null, {
    status: 302,
    headers: { location, 'set-cookie': cookie(OAUTH_COOKIE, '', { maxAge: 0, path: '/auth' }) },
  });
}

function decodeJwt(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(payload);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function emailAllowed(env, email) {
  const list = (env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length === 0 || list.includes(String(email).toLowerCase());
}

async function startSession(env, user) {
  const now = Date.now();
  const token = randomToken(32);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture`
    ).bind(user.id, user.email, user.name, user.picture, now),
    env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(
      await sha256(token),
      user.id,
      now + SESSION_DAYS * 86400000
    ),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
  ]);
  const headers = new Headers({ location: '/' });
  headers.append('set-cookie', cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400 }));
  headers.append('set-cookie', cookie(OAUTH_COOKIE, '', { maxAge: 0, path: '/auth' }));
  return new Response(null, { status: 302, headers });
}

async function currentUser(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`
  )
    .bind(await sha256(token), Date.now())
    .first();
}

/* ---------- API ---------- */

async function handleApi(request, env, url) {
  if (request.method !== 'GET' && !sameOrigin(request, url)) return json({ error: 'forbidden' }, 403);
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'unauthorized' }, 401);

  if (url.pathname === '/api/sync' && request.method === 'POST') return sync(request, env, user);
  if (url.pathname === '/api/ai/organize' && request.method === 'POST') return organize(request, env);
  return json({ error: 'not_found' }, 404);
}

function cleanTask(t) {
  if (!t || typeof t !== 'object' || !ID_RE.test(String(t.id))) return null;
  const title = String(t.title ?? '').trim().slice(0, MAX_TITLE);
  if (!title || !STATUSES.has(t.status)) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : Date.now());
  return { id: t.id, title, status: t.status, moved_at: num(t.moved_at), created_at: num(t.created_at), updated_at: num(t.updated_at) };
}

// 端末にたまった変更（追加・変更・削除）をまとめて受け取り、最新の一覧を返す
async function sync(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const puts = Array.isArray(body.puts) ? body.puts.slice(0, MAX_OPS).map(cleanTask).filter(Boolean) : [];
  const dels = Array.isArray(body.dels) ? body.dels.slice(0, MAX_OPS).filter((id) => ID_RE.test(String(id))) : [];

  const stmts = [];
  for (const t of puts) {
    // 同じIDが別の人のものなら更新しない。古い変更で新しい内容を上書きしない
    stmts.push(
      env.DB.prepare(
        `INSERT INTO tasks (id, user_id, title, status, moved_at, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE (SELECT COUNT(*) FROM tasks WHERE user_id = ?2) < ${MAX_TASKS}
            OR EXISTS (SELECT 1 FROM tasks WHERE id = ?1)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status,
           moved_at = excluded.moved_at, updated_at = excluded.updated_at
         WHERE tasks.user_id = excluded.user_id AND excluded.updated_at >= tasks.updated_at`
      ).bind(t.id, user.id, t.title, t.status, t.moved_at, t.created_at, t.updated_at)
    );
  }
  for (const id of dels) {
    stmts.push(env.DB.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').bind(id, user.id));
  }
  if (stmts.length) await env.DB.batch(stmts);

  const { results } = await env.DB.prepare(
    `SELECT id, title, status, moved_at, created_at, updated_at FROM tasks
     WHERE user_id = ? ORDER BY moved_at DESC`
  )
    .bind(user.id)
    .all();
  return json({ user: { email: user.email, name: user.name, picture: user.picture }, tasks: results });
}

/* ---------- Workers AI：音声入力のメモをタスクに分ける ---------- */

const AI_SYSTEM = [
  'あなたはタスク整理のアシスタントです。',
  'ユーザーのメモ（音声入力のため、言い間違い・つなぎ言葉・句読点の抜けがあります）を読み、',
  '実行できる具体的なタスクに分けてください。',
  '各タスクは日本語で、40文字以内の短い命令形（例：「歯ブラシを発注する」）にします。',
  'メモにないことを付け足さないでください。タスクは最大10件。',
].join('');

async function organize(request, env) {
  let text;
  try {
    text = String((await request.json()).text || '').trim().slice(0, 2000);
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (!text) return json({ error: 'empty' }, 400);

  if (env.AI_MOCK === '1') return json({ tasks: mockOrganize(text) });

  try {
    const result = await env.AI.run(env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: AI_SYSTEM },
        { role: 'user', content: text },
      ],
      max_tokens: 600,
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: {
          type: 'object',
          properties: { tasks: { type: 'array', items: { type: 'string' } } },
          required: ['tasks'],
        },
      },
    });
    const tasks = readTasks(result?.response);
    if (!tasks.length) return json({ error: 'ai_empty' }, 502);
    return json({ tasks });
  } catch (err) {
    console.error('AI error', err);
    return json({ error: 'ai_failed' }, 502);
  }
}

function readTasks(response) {
  let data = response;
  if (typeof data === 'string') {
    const m = data.match(/\{[\s\S]*\}/);
    try {
      data = JSON.parse(m ? m[0] : data);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(data?.tasks) ? data.tasks : [];
  return list
    .map((t) => String(typeof t === 'object' ? t?.title ?? '' : t).trim().slice(0, 100))
    .filter(Boolean)
    .slice(0, 10);
}

// テスト用：AIの代わりに「、」「。」改行・「あと」「それと」で区切るだけ
function mockOrganize(text) {
  return text
    .split(/[、。\n]|あと|それと/)
    .map((s) => s.replace(/^(えー|えっと|あの)/, '').trim())
    .filter((s) => s.length > 1)
    .slice(0, 10);
}
