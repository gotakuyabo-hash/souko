/**
 * 返送管理アプリ用 Cloud Functions（henso）
 *
 * できること
 *  - Chatworkの「自分が担当の未完了タスク」を取得し、本文から返送管理No.を読み取る
 *  - 吉田様の配送管理シート「返送管理シート」から該当行を探して返す（読み取りのみ・書き込みなし）
 *  - 画像URLが空の行は、配送シートNo.で「入力シート」の画像URLを探す
 *  - アプリの完了ボタンで、Chatworkのタスクを完了（または元に戻す）
 *  - 荷物を受領したときの状態（元払/着払 × 未開封/開封済）を返送管理シートのC列に書き込む
 *
 * 使い方
 *  コックピットの index.js と同じフォルダに置き、index.js の最後に次の1行を追加：
 *    exports.henso = require("./henso").henso;
 *  追加のインストールは不要。Chatworkトークンはコックピットと同じ CW_TOKEN_STAFF / CW_TOKEN_MATSUSHITA を使用
 *  合言葉だけ専用のSecret（HENSO_PASSPHRASE）を登録する
 */
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { GoogleAuth } = require("google-auth-library");
const crypto = require("crypto");

// コックピットで登録済みのSecretをそのまま使う
const CHATWORK_TOKEN = defineSecret("CW_TOKEN_STAFF"); // ラクロジスタッフのChatwork
const CHATWORK_TOKEN_MATSUSHITA = defineSecret("CW_TOKEN_MATSUSHITA"); // 以前のタスク（松下さん担当）用
function tokenOf(account) {
  return account === "matsushita" ? CHATWORK_TOKEN_MATSUSHITA.value() : CHATWORK_TOKEN.value();
}
// このアプリ専用の合言葉（コックピットの合言葉とは別）
//   firebase functions:secrets:set HENSO_PASSPHRASE  → 「logex」を入力
const HENSO_PASSPHRASE = defineSecret("HENSO_PASSPHRASE");

const SPREADSHEET_ID = "1oEaoz0u-heDw1UxWR6G5MDwDDj7Qd8CXixOV-1KVH98";
const RETURN_RANGE = "'返送管理シート'!A3:Z"; // 1行目=フォームURL、2行目=見出し
const INPUT_RANGE = "'入力シート'!B2:L"; // B=No、L=画像URL
const TOKEN_HOURS = 12;

// 受領ステータス（シートの既存の書き方「到着済（着払／開封済）」に合わせる）
const RECEIPT_VALUES = [
  "到着済（元払／未開封）",
  "到着済（元払／開封済）",
  "到着済（着払／未開封）",
  "到着済（着払／開封済）",
];

/* ---------- スプレッドシート読み取り（キャッシュ付き） ---------- */
const gAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets/" + SPREADSHEET_ID + "/values/";

async function accessToken() {
  const client = await gAuth.getClient();
  const t = await client.getAccessToken();
  return (t && t.token) || t;
}
async function sheetGet(range) {
  const r = await fetch(SHEETS_URL + encodeURIComponent(range), {
    headers: { Authorization: "Bearer " + (await accessToken()) },
  });
  if (!r.ok) throw new Error("シートの読み込みに失敗しました（" + r.status + "）" + (await r.text()));
  const d = await r.json();
  return d.values || [];
}
async function sheetPut(range, values) {
  const r = await fetch(SHEETS_URL + encodeURIComponent(range) + "?valueInputOption=RAW", {
    method: "PUT",
    headers: { Authorization: "Bearer " + (await accessToken()), "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  if (!r.ok) throw new Error("シートの書き込みに失敗しました（" + r.status + "）" + (await r.text()));
}

const cache = {};
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

async function findRows(nos, fresh) {
  const rows = await readRange(RETURN_RANGE, 60 * 1000, fresh);
  const items = rows.map(rowToItem).filter((x) => x.no);
  const result = {};
  nos.forEach((n) => (result[n] = items.filter((x) => x.no === n)));

  // 画像URLが空の行は入力シートから補う
  const missing = Object.values(result)
    .flat()
    .filter((x) => !x.image && x.haisoNo);
  if (missing.length) {
    const input = await readRange(INPUT_RANGE, 10 * 60 * 1000, false);
    const map = {};
    input.forEach((r) => {
      const no = normNo(r[0]);
      const url = r[10] ? String(r[10]).trim() : "";
      if (no && url && !map[no]) map[no] = url;
    });
    missing.forEach((x) => (x.image = map[x.haisoNo] || ""));
  }
  return result;
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

async function cwMyTasks(token) {
  const r = await fetch("https://api.chatwork.com/v2/my/tasks?status=open", {
    headers: { "x-chatworktoken": token },
  });
  if (r.status === 204) return [];
  if (!r.ok) throw new Error("Chatworkのタスク取得に失敗しました（" + r.status + "）");
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
  { region: "asia-northeast1", cors: true, secrets: [CHATWORK_TOKEN, CHATWORK_TOKEN_MATSUSHITA, HENSO_PASSPHRASE] },
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
        // ラクロジスタッフのタスク＋（以前の）松下さんの返送タスク
        const [staffTasks, mTasks] = await Promise.all([
          cwMyTasks(tokenOf("staff")),
          cwMyTasks(tokenOf("matsushita")).catch(() => []),
        ]);
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
        const list = staffTasks.map(toItem("staff"))
          .concat(mTasks.map(toItem("matsushita")).filter((x) => x.isReturn));

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

      if (action === "lookup" && req.method === "GET") {
        const no = normNo(req.query.no);
        if (!no) return res.status(400).json({ error: "返送管理No.を入れてください" });
        const rows = await findRows([no], fresh);
        return res.json({ no, items: rows[no] || [] });
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
        return res.json({ ok: true, prev, value: v });
      }

      return res.status(404).json({ error: "不明な操作です" });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || "サーバーでエラーが起きました" });
    }
  }
);
