/**
 * 返送管理アプリ用 Cloud Functions（henso）
 *
 * できること
 *  - Chatworkの「自分が担当の未完了タスク」を取得し、本文から返送管理No.を読み取る
 *  - 吉田様の配送管理シート「返送管理シート」から該当行を探して返す（読み取りのみ・書き込みなし）
 *  - 画像URLが空の行は、配送シートNo.で「入力シート」の画像URLを探す
 *  - アプリの完了ボタンで、Chatworkのタスクを完了（または元に戻す）
 *  - 荷物を受領したときの状態（元払/着払 × 未開封/開封済）を返送管理シートのC列に書き込む
 *  - 読み書きするシートは、配送管理アプリ（USyoshida.html）と同じ設定を使う
 *  - 完了したタスクを Firestore（henso_history）に記録し、過去の返送品（返送・破棄など）を探せる
 *    アプリ導入前の分は、Chatworkの完了済みタスク（直近100件まで）から自動で取り込む
 *  - 「破棄した」ボタンで、破棄した日時と作業者を Firestore（henso_haiki/{返送No.}）に記録する（シートには書かない）
 *    （Firestore の deliveryClients/150 の sheetId）。どちらのアプリで差し替えても両方に反映される
 *
 * 使い方
 *  コックピットの index.js と同じフォルダに置き、index.js の最後に次の1行を追加：
 *    exports.henso = require("./henso").henso;
 *  追加のインストールは不要。Chatworkトークンはコックピットと同じ CW_TOKEN_STAFF（ラクロジスタッフ）を使用
 *  合言葉だけ専用のSecret（HENSO_PASSPHRASE）を登録する
 */
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { GoogleAuth } = require("google-auth-library");
const crypto = require("crypto");
const admin = require("firebase-admin"); // initializeApp は index.js 側で済んでいる

// コックピットで登録済みのSecretをそのまま使う
const CHATWORK_TOKEN = defineSecret("CW_TOKEN_STAFF"); // ラクロジスタッフのChatwork
// 表示・完了はラクロジスタッフ担当のタスクだけ
function tokenOf() {
  return CHATWORK_TOKEN.value();
}
// このアプリ専用の合言葉（コックピットの合言葉とは別）
//   firebase functions:secrets:set HENSO_PASSPHRASE  → 「logex」を入力
const HENSO_PASSPHRASE = defineSecret("HENSO_PASSPHRASE");

// シートは配送管理アプリと共通の設定（deliveryClients/150）を使う。設定が無いときだけ、この初期値を使う
const CLIENT_ID = "150"; // 吉田様のお客様ID（配送管理アプリの「お客様ID」と同じ）
const DEFAULT_SPREADSHEET_ID = "1o_BGcdN5SwnbLeomJ1qch-NSN2YcQk8MT1N2aMWexL0";
const REQUIRED_TABS = ["返送管理シート", "入力シート"];
const RETURN_RANGE = "'返送管理シート'!A3:Z"; // 1行目=フォームURL、2行目=見出し
const INPUT_RANGE = "'入力シート'!B2:L"; // B=No、L=画像URL
const TOKEN_HOURS = 12;
// 吉田様とのChatworkルーム（DHLラベル・EMS書類を探す場所）
const RETURN_ROOM_ID = "400289258";

// 受領ステータス（シートの既存の書き方「到着済（着払／開封済）」に合わせる）
const RECEIPT_VALUES = [
  "到着済（元払／未開封）",
  "到着済（元払／開封済）",
  "到着済（着払／未開封）",
  "到着済（着払／開封済）",
];

/* ---------- スプレッドシート読み取り（キャッシュ付き） ---------- */
const gAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets/";

/* ---------- シートの設定（Firestore） ---------- */
const CONFIG_REF = () => admin.firestore().collection("deliveryClients").doc(CLIENT_ID);
let cfgMem = null; // { id, t }
async function sheetId() {
  if (cfgMem && Date.now() - cfgMem.t < 60 * 1000) return cfgMem.id;
  let id = DEFAULT_SPREADSHEET_ID;
  try {
    const snap = await CONFIG_REF().get();
    const d = snap.exists ? snap.data() : null;
    if (d && d.sheetId) id = d.sheetId;
  } catch (e) { console.error("deliveryClients/" + CLIENT_ID + " を読めません: " + e.message); }
  if (cfgMem && cfgMem.id !== id) clearSheetCache();
  cfgMem = { id, t: Date.now() };
  return id;
}
async function valuesUrl() {
  return SHEETS_BASE + (await sheetId()) + "/values/";
}
async function serviceAccountEmail() {
  try { const c = await gAuth.getCredentials(); return (c && c.client_email) || ""; } catch (e) { return ""; }
}
function parseSheetId(s) {
  const v = String(s || "").trim();
  const m = v.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(v) ? v : "";
}
// シートが開けるか・必要なタブと見出しがそろっているかを確かめる
async function inspectSheet(id) {
  const headers = { Authorization: "Bearer " + (await accessToken()) };
  const r = await fetch(SHEETS_BASE + id + "?fields=properties.title,sheets.properties.title", { headers });
  if (r.status === 403) {
    const sa = await serviceAccountEmail();
    throw new Error("このシートを開く権限がありません。シートの共有に" + (sa ? "「" + sa + "」" : "サーバー用アカウント") + "を「編集者」で追加してください");
  }
  if (r.status === 404) throw new Error("シートが見つかりません。URLを確認してください");
  if (!r.ok) throw new Error("シートを確認できませんでした（" + r.status + "）");
  const d = await r.json();
  const tabs = (d.sheets || []).map((x) => x.properties.title);
  const missing = REQUIRED_TABS.filter((t) => !tabs.includes(t));
  if (missing.length) throw new Error("「" + missing.join("」「") + "」のタブが見つかりません");
  const h = await fetch(SHEETS_BASE + id + "/values/" + encodeURIComponent("'返送管理シート'!A2:C2"), { headers });
  const hv = h.ok ? ((await h.json()).values || [[]])[0] : [];
  if (!/ステータス/.test(String(hv[2] || ""))) {
    throw new Error("返送管理シートのC列（2行目）が「ステータス」になっていません。列の並びを確認してください");
  }
  return { title: (d.properties && d.properties.title) || "" };
}

async function accessToken() {
  const client = await gAuth.getClient();
  const t = await client.getAccessToken();
  return (t && t.token) || t;
}
async function sheetGet(range) {
  const r = await fetch((await valuesUrl()) + encodeURIComponent(range), {
    headers: { Authorization: "Bearer " + (await accessToken()) },
  });
  if (!r.ok) throw new Error("シートの読み込みに失敗しました（" + r.status + "）" + (await r.text()));
  const d = await r.json();
  return d.values || [];
}
async function sheetPut(range, values) {
  const r = await fetch((await valuesUrl()) + encodeURIComponent(range) + "?valueInputOption=RAW", {
    method: "PUT",
    headers: { Authorization: "Bearer " + (await accessToken()), "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  if (!r.ok) throw new Error("シートの書き込みに失敗しました（" + r.status + "）" + (await r.text()));
}

const cache = {};
function clearSheetCache() { Object.keys(cache).forEach((k) => delete cache[k]); }
async function readRange(range, ttlMs, fresh) {
  const c = cache[range];
  if (!fresh && c && Date.now() - c.t < ttlMs) return c.v;
  const v = await sheetGet(range);
  cache[range] = { t: Date.now(), v };
  return v;
}

/* ---------- 文字の整形 ---------- */
function toHalf(s) {
  return String(s || "").replace(/[０-９Ａ-Ｚａ-ｚ．：＃]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
}
function normNo(s) {
  const m = toHalf(s).match(/\d+/);
  return m ? String(parseInt(m[0], 10)) : "";
}

// Chatworkのタグを取り除いて読みやすくする
function cleanBody(b) {
  return String(b || "")
    .replace(/\[To:\d+\][^\n]*?(?:さん|様)/g, "")
    .replace(/\[To:\d+\]/g, "")
    .replace(/\[rp aid=\d+[^\]]*\]/g, "")
    .replace(/\[piconname:\d+\]|\[picon:\d+\]/g, "")
    .replace(/\[qtmeta[^\]]*\]/g, "")
    .replace(/\[\/?(info|title|code|qt|hr)\]/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 本文から返送管理No.を読み取る（例：返送管理No.12 / 返送No:12 / 返送管理シートNO．１２）
function extractNos(text) {
  const t = toHalf(text);
  const re =
    /返送(?:管理)?(?:シート)?\s*(?:の)?\s*(?:No|NO|no|№|番号)?\s*[.:#]?\s*(\d{1,5})/g;
  const set = new Set();
  let m;
  while ((m = re.exec(t)) !== null) set.add(String(parseInt(m[1], 10)));
  return [...set];
}

/* ---------- 返送管理シートの行 ---------- */
function rowToItem(r, i) {
  const g = (n) => (r[n] == null ? "" : String(r[n]).trim());
  return {
    rowNumber: i + 3,
    no: normNo(g(0)),
    haisoNo: normNo(g(1)),
    status: g(2),
    store: g(3),
    name: g(6),
    orderNo: g(8),
    asin: g(9),
    title: g(10),
    qty: g(11),
    image: g(12),
    reason: g(14),
    label: g(21), // DHLラベル、EMS引継ぎ
    comment: g(24),
    returnDate: g(25),
  };
}

// 画像URLが空の行は、配送No.で入力シートの画像を補う
async function fillImages(items) {
  const missing = items.filter((x) => !x.image && x.haisoNo);
  if (!missing.length) return;
  const input = await readRange(INPUT_RANGE, 10 * 60 * 1000, false);
  const map = {};
  input.forEach((r) => {
    const no = normNo(r[0]);
    const url = r[10] ? String(r[10]).trim() : "";
    if (no && url && !map[no]) map[no] = url;
  });
  missing.forEach((x) => (x.image = map[x.haisoNo] || ""));
}

async function allItems(fresh) {
  const rows = await readRange(RETURN_RANGE, 60 * 1000, fresh);
  return rows.map(rowToItem).filter((x) => x.no);
}

async function findRows(nos, fresh) {
  const items = await allItems(fresh);
  const result = {};
  nos.forEach((n) => (result[n] = items.filter((x) => x.no === n)));
  await fillImages(Object.values(result).flat());
  return result;
}

// 検索用に文字をそろえる（全角半角・大文字小文字・スペース・ハイフンの違いを無視）
function normText(s) {
  return toHalf(String(s || ""))
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000\-‐－]/g, "");
}
const byNoDesc = (a, b) => Number(b.no) - Number(a.no);

// 受領の記録（Firestore：henso_received/{返送No.}）
// シートのステータスが「DHL」「完了」などに変わっても、タスクを完了するまで一覧に残すため
const RECEIVED_COL = "henso_received";
async function loadReceivedMarks() {
  const snap = await admin.firestore().collection(RECEIVED_COL).get();
  const set = new Set();
  snap.forEach((d) => set.add(d.id));
  return set;
}
async function markReceived(nos, status) {
  if (!nos.length) return;
  const db = admin.firestore();
  for (let i = 0; i < nos.length; i += 400) {
    const batch = db.batch();
    nos.slice(i, i + 400).forEach((no) =>
      batch.set(db.collection(RECEIVED_COL).doc(no), { no, status: status || "", at: Date.now() }, { merge: true })
    );
    await batch.commit();
  }
}
async function unmarkReceived(no) {
  await admin.firestore().collection(RECEIVED_COL).doc(no).delete();
}

/* ---------- 完了したタスクの記録（Firestore：henso_history/{taskId}） ---------- */
// Chatworkでは完了済みタスクを直近100件までしか取れないため、完了した時点で記録を残しておく
const HISTORY_COL = "henso_history";
function historyDoc(v, source, doneAt) {
  return {
    taskId: Number(v.taskId),
    roomId: String(v.roomId || ""),
    roomName: v.roomName || "",
    nos: v.nos || [],
    kind: v.kind || { key: "", label: "" },
    body: String(v.body || "").slice(0, 3000),
    assignedBy: v.assignedBy || "",
    limitTime: v.limitTime || 0,
    messageId: v.messageId || "0",
    doneAt: doneAt || 0, // アプリで完了したときだけ日時が分かる（Chatworkから取り込んだ分は0）
    source, // "app" または "chatwork"
    savedAt: Date.now(),
  };
}
async function saveHistoryFromTask(token, roomId, taskId) {
  const t = await cwTask(token, roomId, taskId);
  const v = taskView({ ...t, room: { room_id: Number(roomId), name: "" } });
  if (!v.nos.length) return; // 返送No.の無いタスクは記録しない
  await admin.firestore().collection(HISTORY_COL).doc(String(taskId)).set(historyDoc(v, "app", Date.now()));
}
async function deleteHistory(taskId) {
  await admin.firestore().collection(HISTORY_COL).doc(String(taskId)).delete();
}

// Chatworkの完了済みタスクのうち、まだ記録していない返送タスクを取り込む（2分に1回まで）
let lastSync = 0;
async function syncDoneTasks(existingIds, force) {
  if (!force && Date.now() - lastSync < 2 * 60 * 1000) return 0;
  lastSync = Date.now();
  const done = await cwMyTasks(tokenOf(), "done");
  const add = done.map(taskView).filter((v) => v.nos.length && !existingIds.has(String(v.taskId)));
  const db = admin.firestore();
  for (let i = 0; i < add.length; i += 400) {
    const batch = db.batch();
    add.slice(i, i + 400).forEach((v) =>
      batch.set(db.collection(HISTORY_COL).doc(String(v.taskId)), historyDoc(v, "chatwork", 0))
    );
    await batch.commit();
  }
  return add.length;
}
async function loadHistory(fresh) {
  const col = admin.firestore().collection(HISTORY_COL);
  let snap = await col.get();
  const ids = new Set(snap.docs.map((d) => d.id));
  const added = await syncDoneTasks(ids, fresh).catch((e) => { console.error("完了タスクの取り込み失敗: " + e.message); return 0; });
  if (added) snap = await col.get();
  return snap.docs.map((d) => d.data());
}

/* ---------- 破棄の記録（Firestore：henso_haiki/{返送No.}） ---------- */
const HAIKI_COL = "henso_haiki";
async function loadHaikiMarks() {
  const snap = await admin.firestore().collection(HAIKI_COL).get();
  const map = {};
  snap.forEach((d) => (map[d.id] = d.data()));
  return map;
}
// 破棄の対象：C列が「破棄」、または破棄のタスクを完了したもの、またはすでに記録があるもの
function isHaikiTarget(x) {
  return x.status === "破棄" || !!x.haiki || (x.history || []).some((h) => h.kind && h.kind.key === "haiki");
}

// 過去の返送品として扱うステータス（返送管理シートC列）
//   進行中（返品承認・到着済・空欄）は除く。絞り込みボタンもこの並び
const PAST_STATUSES = ["破棄", "完了", "DHL", "EMS", "有在庫", "返品ラベル発行不可"];
function isPastStatus(s) {
  return PAST_STATUSES.includes(String(s || "").trim());
}

// Chatworkタスクを画面用の形にする
function taskView(t) {
  const body = cleanBody(t.body);
  return {
    taskId: t.task_id,
    messageId: String(t.message_id || "0"),
    roomId: t.room && t.room.room_id,
    roomName: (t.room && t.room.name) || "",
    assignedBy: (t.assigned_by_account && t.assigned_by_account.name) || "",
    limitTime: t.limit_time || 0,
    body,
    nos: extractNos(body),
    kind: kindOf(body),
  };
}

// 返送管理シートのC列（ステータス）を書き換える
// 行がずれていないか、A列のNo.を確かめてから書く
async function writeStatus(no, rowNumber, value) {
  const row = Number(rowNumber);
  if (!Number.isInteger(row) || row < 3) throw new Error("行の指定が正しくありません");
  const check = await sheetGet(`'返送管理シート'!A${row}:C${row}`);
  const r = check[0] || [];
  if (normNo(r[0]) !== normNo(no)) {
    throw new Error("シートの行が動いたようです。「更新」を押してからもう一度お試しください");
  }
  const prev = r[2] == null ? "" : String(r[2]);
  await sheetPut(`'返送管理シート'!C${row}`, [[value]]);
  delete cache[RETURN_RANGE];
  return prev;
}

/* ---------- 合言葉ログイン ---------- */
function sign(exp, key) {
  return crypto.createHmac("sha256", "henso:" + key).update(String(exp)).digest("hex");
}
function issueToken(key) {
  const exp = Date.now() + TOKEN_HOURS * 3600 * 1000;
  return exp + "." + sign(exp, key);
}
function verifyToken(tok, key) {
  const [exp, sig] = String(tok || "").split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp, key);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function samePass(a, b) {
  const h = (s) => crypto.createHash("sha256").update(String(s || "")).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

/* ---------- 作業内容の判定（タスク本文から） ---------- */
function kindOf(body) {
  if (/破棄/.test(body)) return { key: "haiki", label: "破棄" };
  if (/DHL/i.test(body)) return { key: "dhl", label: "DHL集荷" };
  if (/EMS/i.test(body)) return { key: "ems", label: "EMS集荷" };
  if (/在庫/.test(body)) return { key: "zaiko", label: "在庫に戻す" };
  return { key: "", label: "" };
}

/* ---------- Chatwork ---------- */
// ルームのファイル一覧から「返送管理シートNo.○○」の付いたファイル（DHLラベル・EMS書類）を探す
const fileCache = {};
async function cwRoomFiles(token, roomId, fresh) {
  const c = fileCache[roomId];
  if (!fresh && c && Date.now() - c.t < 2 * 60 * 1000) return c.v;
  const r = await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/files`, {
    headers: { "x-chatworktoken": token },
  });
  let v = [];
  if (r.ok && r.status !== 204) v = await r.json();
  fileCache[roomId] = { t: Date.now(), v };
  return v;
}
function filesByNo(files) {
  const map = {};
  files.forEach((f) => {
    const m = toHalf(f.filename).match(/返送管理(?:シート)?\s*No\.?\s*(\d+)/i);
    if (!m) return;
    const no = String(parseInt(m[1], 10));
    (map[no] = map[no] || []).push({ fileId: f.file_id, filename: f.filename, uploaded: f.upload_time });
  });
  Object.values(map).forEach((list) => list.sort((a, b) => b.uploaded - a.uploaded));
  return map;
}
async function cwFileUrl(token, roomId, fileId) {
  const r = await fetch(
    `https://api.chatwork.com/v2/rooms/${roomId}/files/${fileId}?create_download_url=1`,
    { headers: { "x-chatworktoken": token } }
  );
  if (!r.ok) throw new Error("ファイルを開けませんでした（" + r.status + "）");
  const d = await r.json();
  if (!d.download_url) throw new Error("ファイルのURLが取得できませんでした");
  return d.download_url;
}

async function cwMyTasks(token, status) {
  const r = await fetch("https://api.chatwork.com/v2/my/tasks?status=" + (status === "done" ? "done" : "open"), {
    headers: { "x-chatworktoken": token },
  });
  if (r.status === 204) return [];
  if (!r.ok) throw new Error("Chatworkのタスク取得に失敗しました（" + r.status + "）");
  return r.json();
}
async function cwTask(token, roomId, taskId) {
  const r = await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/tasks/${taskId}`, {
    headers: { "x-chatworktoken": token },
  });
  if (!r.ok) throw new Error("Chatworkのタスクを読めませんでした（" + r.status + "）");
  return r.json();
}
async function cwSetStatus(token, roomId, taskId, status) {
  const r = await fetch(
    `https://api.chatwork.com/v2/rooms/${roomId}/tasks/${taskId}/status`,
    {
      method: "PUT",
      headers: {
        "x-chatworktoken": token,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "body=" + status,
    }
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error("Chatworkの更新に失敗しました（" + r.status + "）" + text);
  }
  return r.json().catch(() => ({}));
}

/* ---------- 入口 ---------- */
exports.henso = onRequest(
  { region: "asia-northeast1", cors: true, secrets: [CHATWORK_TOKEN, HENSO_PASSPHRASE] },
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    const action = req.path.split("/").filter(Boolean).pop();
    const pass = HENSO_PASSPHRASE.value();

    try {
      if (action === "login" && req.method === "POST") {
        if (!samePass(req.body && req.body.pass, pass)) {
          return res.status(401).json({ error: "合言葉が違います" });
        }
        return res.json({ token: issueToken(pass) });
      }

      const auth = String(req.get("Authorization") || "").replace(/^Bearer\s+/, "");
      if (!verifyToken(auth, pass)) {
        return res.status(401).json({ error: "ログインしてください" });
      }

      const fresh = req.query.fresh === "1";

      if (action === "tasks" && req.method === "GET") {
        // ラクロジスタッフ担当のタスクだけ
        const staffTasks = await cwMyTasks(tokenOf());
        const toItem = (account) => (t) => {
          const body = cleanBody(t.body);
          const nos = extractNos(body);
          return {
            account,
            taskId: t.task_id,
            messageId: String(t.message_id || "0"),
            roomId: t.room && t.room.room_id,
            roomName: (t.room && t.room.name) || "",
            assignedBy: (t.assigned_by_account && t.assigned_by_account.name) || "",
            limitTime: t.limit_time || 0,
            body,
            nos,
            kind: kindOf(body),
            isReturn: nos.length > 0 || /返送|返品|破棄/.test(body),
          };
        };
        const list = staffTasks.map(toItem("staff"));

        const allNos = [...new Set(list.flatMap((x) => x.nos))];
        const rows = allNos.length ? await findRows(allNos, fresh) : {};

        // 返送タスクのあるルームのファイル（DHLラベル・EMS書類）
        const roomIds = [...new Set(list.filter((x) => x.nos.length).map((x) => x.roomId))];
        const filesMap = {};
        await Promise.all(roomIds.map(async (rid) => {
          const files = await cwRoomFiles(tokenOf("staff"), rid, fresh).catch(() => []);
          filesMap[rid] = filesByNo(files);
        }));

        list.forEach((x) => {
          x.rows = x.nos.map((n) => ({
            no: n,
            items: rows[n] || [],
            files: (filesMap[x.roomId] && filesMap[x.roomId][n]) || [],
          }));
        });
        // 新しく追加されたタスクが上（メッセージIDが大きいほど新しい）
        list.sort((a, b) => {
          const x = BigInt(/^\d+$/.test(a.messageId) ? a.messageId : "0");
          const y = BigInt(/^\d+$/.test(b.messageId) ? b.messageId : "0");
          return x === y ? b.taskId - a.taskId : (y > x ? 1 : -1);
        });
        return res.json({ tasks: list, loadedAt: Date.now() });
      }

      if (action === "file" && req.method === "GET") {
        const { roomId, fileId } = req.query;
        if (!/^\d+$/.test(String(roomId)) || !/^\d+$/.test(String(fileId))) {
          return res.status(400).json({ error: "ファイルの指定が正しくありません" });
        }
        const url = await cwFileUrl(tokenOf("staff"), roomId, fileId);
        return res.json({ url });
      }

      // 受領：名前 → 品名 → 注文番号 の順に探す
      if (action === "search" && req.method === "GET") {
        const q = normText(req.query.q);
        if (!q) return res.status(400).json({ error: "名前・品名・注文番号のどれかを入れてください" });
        const items = await allItems(fresh);
        for (const field of ["name", "title", "orderNo"]) {
          const hits = items.filter((x) => normText(x[field]).includes(q)).sort(byNoDesc).slice(0, 30);
          if (hits.length) {
            await fillImages(hits);
            return res.json({ matchedBy: field, items: hits });
          }
        }
        return res.json({ matchedBy: "", items: [] });
      }

      // タスク完了：受領済みの荷物と、その未完了タスク
      //   ・ステータスが「到着済」のもの
      //   ・一度受領したもの（Firestoreに記録あり）で、まだ未完了タスクが残っているもの
      if (action === "received" && req.method === "GET") {
        const [items, myTasks, marks] = await Promise.all([
          allItems(fresh),
          cwMyTasks(tokenOf()),
          loadReceivedMarks(),
        ]);
        const tasks = myTasks.map(taskView);
        items.forEach((x) => (x.tasks = tasks.filter((t) => t.nos.includes(x.no))));

        // 「到着済」なのに記録がないもの（アプリ導入前の分など）は記録しておく
        const arrived = items.filter((x) => /到着/.test(x.status));
        const newMarks = arrived.filter((x) => !marks.has(x.no));
        await markReceived(newMarks.map((x) => x.no), "");
        newMarks.forEach((x) => marks.add(x.no));

        const received = items.filter(
          (x) => /到着/.test(x.status) || (marks.has(x.no) && x.tasks.length > 0)
        );
        await fillImages(received);
        const files = await cwRoomFiles(tokenOf(), RETURN_ROOM_ID, fresh)
          .then(filesByNo)
          .catch(() => ({}));
        received.forEach((x) => {
          x.files = files[x.no] || [];
          x.roomId = (x.tasks[0] && x.tasks[0].roomId) || RETURN_ROOM_ID;
        });
        // タスクが来ているものを上に、その中は新しい順
        received.sort((a, b) => (b.tasks.length > 0) - (a.tasks.length > 0) || byNoDesc(a, b));
        return res.json({ items: received, loadedAt: Date.now() });
      }

      // 過去の返送品：返送管理シートC列のステータスで探す（完了したタスクの記録もあわせて表示）
      //   q なし → 過去のステータス（破棄・完了・DHL・EMS・有在庫・返品ラベル発行不可）のもの
      //   q あり → シート全体から返送No.・名前・品名・注文番号・ASINで探す（ステータスは問わない）
      //   status を指定すると、C列がそのステータスのものだけ
      if (action === "history" && req.method === "GET") {
        const q = normText(req.query.q);
        const qNo = /^\d+$/.test(q) ? String(parseInt(q, 10)) : "";
        const status = String(req.query.status || "").trim();
        const haikiFilter = String(req.query.haiki || ""); // "todo"=まだ記録なし / "done"=破棄済み
        const [items, hist, haikiMarks] = await Promise.all([allItems(fresh), loadHistory(fresh), loadHaikiMarks()]);
        const byNo = {};
        hist.forEach((h) => (h.nos || []).forEach((n) => (byNo[n] = byNo[n] || []).push(h)));
        items.forEach((x) => {
          x.history = (byNo[x.no] || []).slice().sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0) || b.taskId - a.taskId);
          x.haiki = haikiMarks[x.no] || null;
          x.haikiTarget = isHaikiTarget(x);
        });

        let list = q
          ? items.filter((x) => x.no === qNo || ["name", "title", "orderNo", "asin"].some((f) => normText(x[f]).includes(q)))
          : items.filter((x) => isPastStatus(x.status));
        if (status) list = list.filter((x) => x.status === status);
        // 破棄の記録あり・なしの件数（絞り込み前）
        const haikiCounts = {
          todo: list.filter((x) => x.haikiTarget && !x.haiki).length,
          done: list.filter((x) => x.haikiTarget && x.haiki).length,
        };
        if (haikiFilter === "todo") list = list.filter((x) => x.haikiTarget && !x.haiki);
        if (haikiFilter === "done") list = list.filter((x) => x.haikiTarget && x.haiki);
        // ステータスごとの件数（絞り込みボタンに表示）
        const counts = {};
        (q ? items.filter((x) => x.no === qNo || ["name", "title", "orderNo", "asin"].some((f) => normText(x[f]).includes(q))) : items)
          .forEach((x) => { if (isPastStatus(x.status)) counts[x.status] = (counts[x.status] || 0) + 1; });

        const total = list.length;
        list = list.sort(byNoDesc).slice(0, 50);
        await fillImages(list);
        const files = await cwRoomFiles(tokenOf(), RETURN_ROOM_ID, fresh).then(filesByNo).catch(() => ({}));
        list.forEach((x) => {
          x.files = files[x.no] || [];
          x.roomId = RETURN_ROOM_ID;
        });
        return res.json({ items: list, total, counts, haikiCounts, statuses: PAST_STATUSES, loadedAt: Date.now() });
      }

      // 破棄した記録をつける（undo: true で取り消し）。シートには書き込まない
      if (action === "haiki" && req.method === "POST") {
        const { no, by, undo } = req.body || {};
        const n = normNo(no);
        if (!n) return res.status(400).json({ error: "返送No.の指定が正しくありません" });
        const ref = admin.firestore().collection(HAIKI_COL).doc(n);
        if (undo) {
          await ref.delete();
          return res.json({ ok: true, no: n, haiki: null });
        }
        const name = String(by || "").trim().slice(0, 30);
        if (!name) return res.status(400).json({ error: "作業者の名前を入れてください" });
        const data = { no: n, at: Date.now(), by: name };
        await ref.set(data);
        return res.json({ ok: true, no: n, haiki: data });
      }

      if (action === "lookup" && req.method === "GET") {
        const no = normNo(req.query.no);
        if (!no) return res.status(400).json({ error: "返送管理No.を入れてください" });
        // シートの行・この番号の未完了タスク・ラベル類をまとめて返す
        const [rows, myTasks] = await Promise.all([
          findRows([no], fresh),
          cwMyTasks(tokenOf()),
        ]);
        const tasks = myTasks
          .map((t) => {
            const body = cleanBody(t.body);
            return {
              taskId: t.task_id,
              roomId: t.room && t.room.room_id,
              roomName: (t.room && t.room.name) || "",
              assignedBy: (t.assigned_by_account && t.assigned_by_account.name) || "",
              limitTime: t.limit_time || 0,
              body,
              nos: extractNos(body),
              kind: kindOf(body),
            };
          })
          .filter((t) => t.nos.includes(no));
        const roomId = (tasks[0] && tasks[0].roomId) || RETURN_ROOM_ID;
        const files = await cwRoomFiles(tokenOf(), roomId, fresh)
          .then((f) => filesByNo(f)[no] || [])
          .catch(() => []);
        return res.json({ no, items: rows[no] || [], tasks, files, roomId });
      }

      if (action === "status" && req.method === "POST") {
        const { roomId, taskId, status, account } = req.body || {};
        if (!/^\d+$/.test(String(roomId)) || !/^\d+$/.test(String(taskId))) {
          return res.status(400).json({ error: "タスクの指定が正しくありません" });
        }
        if (status !== "done" && status !== "open") {
          return res.status(400).json({ error: "statusは done か open です" });
        }
        await cwSetStatus(tokenOf(account), roomId, taskId, status);
        // 過去の返送品で探せるように記録する（記録に失敗しても完了そのものは成功扱い）
        try {
          if (status === "done") await saveHistoryFromTask(tokenOf(account), roomId, taskId);
          else await deleteHistory(taskId);
        } catch (e) { console.error("完了の記録に失敗: " + e.message); }
        return res.json({ ok: true, status });
      }

      if (action === "receipt" && req.method === "POST") {
        const { no, rowNumber, value, undo } = req.body || {};
        const v = String(value == null ? "" : value);
        // 通常は4種類のどれか。「元に戻す」のときだけ前の値をそのまま戻す
        if (!undo && !RECEIPT_VALUES.includes(v)) {
          return res.status(400).json({ error: "受領ステータスの値が正しくありません" });
        }
        if (v.length > 100) return res.status(400).json({ error: "値が長すぎます" });
        const prev = await writeStatus(no, rowNumber, v);
        // 受領の記録（「元に戻す」で到着済以外に戻したときは記録も消す）
        if (/到着/.test(v)) await markReceived([normNo(no)], v);
        else await unmarkReceived(normNo(no));
        return res.json({ ok: true, prev, value: v });
      }

      // 設定：読み書きするシート
      if (action === "config" && req.method === "GET") {
        const id = await sheetId();
        const out = { sheetId: id, sheetTitle: "", serviceAccount: await serviceAccountEmail(), problem: "" };
        try { out.sheetTitle = (await inspectSheet(id)).title; }
        catch (e) { out.problem = e.message; }
        return res.json(out);
      }
      if (action === "config" && req.method === "POST") {
        const id = parseSheetId(req.body && req.body.sheetUrl);
        if (!id) return res.status(400).json({ error: "シートのURLを正しく貼り付けてください" });
        const { title } = await inspectSheet(id);
        // 配送管理アプリと同じドキュメントの sheetId だけを書き換える（ほかの設定はそのまま）
        await CONFIG_REF().set({
          sheetId: id,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: "返送アプリ",
        }, { merge: true });
        clearSheetCache();
        cfgMem = { id, t: Date.now() };
        return res.json({ sheetId: id, sheetTitle: title });
      }

      return res.status(404).json({ error: "不明な操作です" });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || "サーバーでエラーが起きました" });
    }
  }
);
