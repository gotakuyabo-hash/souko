// ポータル（index.html）の絵文字を読んで、各アプリのタブアイコンに入れるスクリプト
// あわせて、各アプリの左下に「ポータルに戻る」ボタン（🏠）をつける
// GitHub Actions でデプロイの直前に実行する（リポジトリのファイル自体は変わりません）
// ポータルで絵文字を変えれば、次のデプロイでタブのアイコンも自動で変わります
const fs = require('fs');
const path = require('path');

// 公開フォルダ（firebase.json の hosting.public）を読む。なければ public
let DIR = 'public';
try {
  const h = JSON.parse(fs.readFileSync('firebase.json', 'utf8')).hosting;
  DIR = (Array.isArray(h) ? h[0] : h).public || DIR;
} catch (e) {}

const portal = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const ICONS = {};
// 例： title: "📑 まとまるくん", desc: "…", href: "shipping-format.html"
const re = /title:\s*"([^"\s]+)\s[^"]*"[^}]*?href:\s*"([^"]+\.html)"/g;
let m;
while ((m = re.exec(portal))) ICONS[m[2]] = m[1];

const tag = e => '<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>' + e + '</text></svg>">';

// 左下の小さい🏠ボタン。押すとポータルへ。印刷のときは出さない
const BACK = `<!--portal-back-->
<a href="/" id="portal-back" title="ポータルに戻る" aria-label="ポータルに戻る">🏠</a>
<style>
#portal-back{position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483000;
  width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:20px;line-height:1;text-decoration:none;background:#fff;border:1px solid #d0d5dd;
  box-shadow:0 2px 8px rgba(0,0,0,.18);opacity:.85;transition:opacity .15s,transform .15s}
#portal-back:hover{opacity:1;transform:scale(1.08)}
@media print{#portal-back{display:none!important}}
</style>
<!--/portal-back-->`;

for (const [file, emoji] of Object.entries(ICONS)) {
  if (file === 'index.html') continue; // ポータル自身は除く
  // ポータルのリンク名と実際のファイル名が少し違うとき（chat-reply.html → chatreply.html など）も探す
  const loose = n => n.toLowerCase().replace(/[-_]/g, '');
  const real = fs.existsSync(path.join(DIR, file)) ? file
    : fs.readdirSync(DIR).find(n => loose(n) === loose(file));
  if (!real) { console.log('見つからない：' + file); continue; }
  const p = path.join(DIR, real);
  let s = fs.readFileSync(p, 'utf8');
  if (!/<\/title>/i.test(s)) { console.log('titleがない：' + file); continue; }
  s = s.replace(/^[ \t]*<link rel="icon"[^\n]*\n?/gm, ''); // 古いアイコンの行を消す
  s = s.replace(/<\/title>/i, '</title>\n' + tag(emoji));
  // ポータルに戻るボタン（すでに入っていたら入れ直す）
  s = s.replace(/<!--portal-back-->[\s\S]*?<!--\/portal-back-->\n?/g, '');
  if (/<\/body>/i.test(s)) s = s.replace(/<\/body>(?![\s\S]*<\/body>)/i, BACK + '\n</body>');
  else s += '\n' + BACK;
  fs.writeFileSync(p, s);
  console.log('OK ' + emoji + ' ' + real);
}
