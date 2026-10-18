# Flick

開いた瞬間にメモできる、フリックで動かすタスク管理アプリ（スマホ向けWebアプリ）。

- メモ欄は開いた瞬間から入力できる（JSの読み込みも、ログインも待たない）
- カードを **右へフリック＝進める**（未着手 → 進行中 → 完了）、**左へフリック＝戻す**。端までいくと削除（「元に戻す」付き）
- ✨ボタンで、音声入力のような長いメモを **Workers AI** が短いタスクに分ける
- ログインは **Google のみ**。ログイン前に書いたメモも、ログインすると保存される
- 圏外でも開けてメモでき、つながったら自動で同期する

> 患者情報・医院の機密事項は入れない前提のアプリです。✨ボタンは、メモに「〇〇さん」「様」「歳」などがあると、AIへ送る前に一度確認を出します（完全には見分けられないので、書かないことが前提です）。

---

## 技術の選定理由

| 部分 | 使ったもの | 選んだ理由 |
|---|---|---|
| 画面 | **素の HTML / CSS / JavaScript**（フレームワーク・ビルドなし） | 「開いた瞬間メモ」のため。メモ欄は HTML に直接書き `autofocus` を付けたので、JS が届く前から入力できる。React などは読み込み・実行の分だけ遅れ、今回の規模では利点より重さが勝つ |
| 保存のしかた | **端末に先に保存 → 裏で同期**（localStorage） | 圏外・ログイン前・通信待ちでも、書いた瞬間に一覧に出る。サーバーへは変更をまとめて1回で送る（`/api/sync`） |
| 2回目以降の起動 | **Service Worker（PWA）** | 画面の部品を端末に置き、ネットを待たずに一瞬で開く。ホーム画面に追加するとアプリのように使える |
| サーバー | **Cloudflare Workers ＋ Static Assets** | 画面と API を1つにまとめて置ける。世界中の近い拠点から返すので速く、待機からの起動もほぼない。無料枠（1日10万リクエスト）で足りる |
| データベース | **Cloudflare D1**（SQLite） | Workers から直接使え、SQL で「本人のタスクだけ」を確実に絞り込める。KV は書き込みの反映に時間差があり同期に向かず、Durable Objects はこの規模には大げさ |
| AI | **Workers AI**（`@cf/meta/llama-3.3-70b-instruct-fp8-fast`、JSON 出力） | 指定どおり Cloudflare の中で完結し、外部の AI 会社にメモを送らない。日本語の質と速さのつり合いで選んだ。JSON の形を決めて出させるので、壊れた答えが返りにくい。モデルは `wrangler.jsonc` の1行で差し替えられる |
| ログイン | **Google OAuth 2.0（認可コード＋PKCE）を自前で実装** | ライブラリを足さずに Workers でそのまま動く。PKCE と state で横取り・なりすましを防ぐ。ログイン状態は乱数の鍵を Cookie（HttpOnly・Secure・SameSite=Lax）に入れ、データベースには鍵のハッシュだけを保存 |
| 使える人の制限 | `ALLOWED_EMAILS`（必須） | 公開アプリなので、決めた Google アカウントだけが使える。**未設定なら誰も入れない**（入れ忘れで全員に開かないように）。全員に開くときだけ `*` |
| AIの使いすぎ防止 | 1人1日の回数上限（`AI_DAILY_LIMIT`、標準100回） | Workers AI の無料枠を使い切られないように |
| 共用の端末 | 端末に「持ち主」を記録 | 別の人がログインしたら、前の人の未送信の変更は送らずに捨てる |
| デザイン | **Liquid Glass を CSS だけで**（`backdrop-filter` のぼかし＋半透明の白＋内側の光＋背景にゆっくり動く色のにじみ） | 画像を使わないので軽い。白ベースでも、奥の色がにじむことでガラスの厚みが出る |
| アニメーション | **CSS ＋ Web Animations API（FLIP）** | ライブラリなしで、カードの入り・並び替え・飛んでいく動き・タブの印・数字の弾み・波紋・AI 処理中の虹色の縁などを付けた。「視差効果を減らす」設定の人には動きを止める |
| フリック | **Pointer Events** ＋ `touch-action: pan-y` | 指・マウス・ペンを同じコードで扱える。縦スクロールはそのまま、横の動きだけをフリックとして拾う。距離（幅の33%）か速さ（0.55px/ミリ秒）で判定。キーボードの ←→ でも操作できる |
| 安全 | CSP・同じサイトからの書き込みだけ許可・入力の長さ制限 | 公開アプリとして、乗っ取りや他人のデータへの書き込みを防ぐ |
| テスト | **Playwright ＋ Microsoft Edge**（Windows に最初から入っている） | 実際のブラウザをスマホの大きさにして操作する。ブラウザの追加ダウンロードが要らない。テスト中だけ AI は簡易版に差し替える |

---

## 手元で動かす

必要なもの：Node.js 20 以上。

```bash
npm install
cp .dev.vars.example .dev.vars
npm test        # ブラウザで36項目を自動テスト
```

`npm test` は空のデータベースで手元サーバーを起動し、Edge（Windows 以外は Chromium）をスマホの大きさで操作します。
テスト中だけ、ログインは `/auth/dev-login`（localhost のときだけ動く）、AI は簡易版を使います。

## 公開のしかた（Cloudflare）

1. Cloudflare にログイン：`npx wrangler login`
2. Google Cloud Console で「OAuth クライアント ID（ウェブ アプリケーション）」を作る
   - 承認済みのリダイレクト URI：`https://<公開先のドメイン>/auth/callback`
3. 鍵を入れる（GitHub には置かない）
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put ALLOWED_EMAILS   # 必須。例：me@gmail.com,staff@gmail.com
   ```
4. 公開：`npx wrangler deploy`（D1 データベースは初回に自動で作られる）
5. 表を作る：`npm run db:migrate`

画面（`public/`）を変えて公開し直すときは、`public/sw.js` の `CACHE` の数字を1つ上げてください（スマホに残った古い画面を入れ替えるため）。

## ファイル

```
src/worker.js          サーバー（API・Google ログイン・Workers AI）
migrations/            データベースの表
public/index.html      画面（メモ欄とスケルトンは HTML に直接）
public/app.js          画面の動き（保存・同期・フリック・アニメーション）
public/style.css       Liquid Glass の見た目
public/sw.js           オフライン用
tests/                 ブラウザテスト
```
