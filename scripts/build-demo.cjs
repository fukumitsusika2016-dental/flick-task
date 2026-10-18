// スマホで試す「見本版」を1ファイルにまとめて作る（claude.ai の非公開ページ用）
// 別ファイルの CSS・JS は読み込めないので、ページの中に埋め込む
// 使い方: node scripts/build-demo.cjs <出力先フォルダ>
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'demo-build'));
const read = (f) => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const css = read('style.css');
const js = read('app.js');
if (/<\/script/i.test(js) || /<\/style/i.test(css)) throw new Error('埋め込めない文字列があります');

let body = read('index.html').match(/<body[^>]*>([\s\S]*)<\/body>/)[1];
body = body.replace('<div id="app" class="app">', '<div id="app" class="app" data-demo="1">');

const html = `<title>Flick 見本版</title>\n<style>\n${css}\n</style>\n<script>document.body.classList.add("is-loading")</script>\n${body.trim()}\n<script>\n${js}\n</script>\n`;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log(`作成: ${path.join(out, 'index.html')}（${html.length}文字）`);
