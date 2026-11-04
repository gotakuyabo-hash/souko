// ポータル（index.html）の絵文字を読んで、各アプリのタブアイコンに入れるスクリプト
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

for (const [file, emoji] of Object.entries(ICONS)) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) { console.log('見つからない：' + file); continue; }
  let s = fs.readFileSync(p, 'utf8');
  if (!/<\/title>/i.test(s)) { console.log('titleがない：' + file); continue; }
  s = s.replace(/^[ \t]*<link rel="icon"[^\n]*\n?/gm, ''); // 古いアイコンの行を消す
  s = s.replace(/<\/title>/i, '</title>\n' + tag(emoji));
  fs.writeFileSync(p, s);
  console.log('OK ' + emoji + ' ' + file);
}
