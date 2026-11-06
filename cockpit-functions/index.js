/**
 * Chatwork 未読バーストコックピット用 Cloud Functions（GASからの移行版）
 *
 *   api                     … 画面から呼ぶ入口（GASの doPost と同じ使い方・同じ返し方）
 *   syncChatworkToFirestore … 1分ごとの Chatwork → Firestore 同期（GASの時間トリガーの代わり）
 *
 * ▼ 秘密の値（firebase functions:secrets:set で登録）
 *   APP_SECRET          … 画面で入力する合言葉（GASと同じものにすると、スタッフは入力し直し不要）
 *   OPENAI_API_KEY      … OpenAI（ChatGPT）APIキー
 *   CW_TOKEN_STAFF      … ラクロジスタッフアカウントのChatwork APIトークン
 *   CW_TOKEN_MATSUSHITA … 松下アカウントのChatwork APIトークン
 *
 * ▼ 普通の設定（functions/.env）
 *   STAFF_ACCOUNT_IDS … 自社スタッフ個人のChatworkアカウントID（カンマ区切り）
 *   AUTH_GEN          … 合言葉ログインの世代番号
 *   LEARN_ACCOUNT_IDS … Chatworkで直接送った返信をAI添削ログに入れる対象のアカウントID（渡辺さんの個人アカウントなど）。
 *                       ラクロジスタッフ・松下のアカウントは自動で対象になる
 *
 * ▼ GASのスクリプトプロパティに入っていたデータの保存先（Firestore）
 *   cw_server/later_{アカウント}   … 「後で対応」リスト
 *   cw_server/option_overrides   … オプション加入状況の手動修正
 *   cw_server/sync_{アカウント}    … 同期の進み具合
 *
 * ▼ ルームごとの「状況の整理」メモ
 *   cw_room_notes/{ルームID} … AIで整理して担当者が保存した状況。AI返信を作るときに一緒に渡す
 *
 * ▼ 送り状の記録
 *   shipments/{yamato|sagawa}_{追跡番号} … 発行済みCSVから取り込んだ送り状（住所・電話番号は保存しない）
 *
 * ▼ USアプリ（配送管理アプリ USyoshida.html）への出荷依頼
 *   deliveryClients/{US_CLIENT_ID}/cockpitRequests/{ID} … コックピットから送ったNo.の依頼。USアプリに一覧で出る
 *   US_CLIENT_ID は functions/.env で変更可（初期値 150）
 *
 * ▼ 要対応の仕分け（同期のときにAIが自動で判定）
 *   cw_rooms/{アカウント}_{ルームID} の triage（none=返信不要 / easy=すぐ返せる / check=要確認）と triageFor（判定したメッセージID）
 *   triageSub（要確認の種類：order=出荷依頼 / ship=出荷・追跡 / bill=請求・料金 / trouble=トラブル / system=システム / other=その他）
 *   本文コレクションの triagePoint（相手の用件・確認すること。40文字ほど）
 *
 * ▼ Chatworkで直接送った返信（コックピットを使わずに送ったもの）
 *   ai_brushup_feedback/cw_{メッセージID} … AI添削ログに「Chatwork直接」として追加（source: "chatwork_direct"）
 *   cw_sent_marks/{ルームID}             … コックピットから送った文の目印（二重に記録しないため）
 */

const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { GoogleAuth } = require("google-auth-library");

admin.initializeApp();
const db = admin.firestore();

const REGION = "asia-northeast1";
const APP_SECRET = defineSecret("APP_SECRET");
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const CW_TOKEN_STAFF = defineSecret("CW_TOKEN_STAFF");
const CW_TOKEN_MATSUSHITA = defineSecret("CW_TOKEN_MATSUSHITA");
const ALL_SECRETS = [APP_SECRET, OPENAI_API_KEY, CW_TOKEN_STAFF, CW_TOKEN_MATSUSHITA];

// 画面の「アカウント選択」の値 → トークン
const ACCOUNTS = {
  staff: CW_TOKEN_STAFF,
  matsushita: CW_TOKEN_MATSUSHITA
};

const OPENAI_MODEL = "gpt-6-luna";   // 文章がいまいちなら "gpt-6-sol" に変えると高性能（料金は上がる）

// ==============================
// 小さな道具
// ==============================

// 1つのサーバーの中だけで使う一時保存（GASの CacheService の代わり）
const memCache = new Map();
function cacheGet(key) {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.until) { memCache.delete(key); return null; }
  return hit.value;
}
function cachePut(key, value, sec) { memCache.set(key, { value, until: Date.now() + sec * 1000 }); }
function cacheRemove(key) { memCache.delete(key); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

function onlyIds(ids) {
  return (Array.isArray(ids) ? ids : []).map(String).filter(id => /^\d+$/.test(id));
}

// 並べて少しずつ実行（GASの UrlFetchApp.fetchAll の代わり）
async function inChunks(list, size, fn) {
  const out = [];
  for (let s = 0; s < list.length; s += size) {
    out.push(...await Promise.all(list.slice(s, s + size).map(fn)));
  }
  return out;
}

// JSONで保存するサーバー用データ（GASのスクリプトプロパティの代わり）
async function loadJsonDoc(id, fallback) {
  const snap = await db.collection("cw_server").doc(id).get();
  if (!snap.exists) return fallback;
  try { return JSON.parse(snap.get("json") || "null") ?? fallback; } catch (e) { return fallback; }
}
async function saveJsonDoc(id, obj) {
  await db.collection("cw_server").doc(id).set({ json: JSON.stringify(obj), updatedAt: nowSec() });
}

function getChatworkToken(account) {
  const s = ACCOUNTS[account];
  if (!s) throw new Error("アカウントの指定が正しくありません: " + account);
  const token = s.value();
  if (!token) throw new Error("Chatworkのトークンが登録されていません: " + account);
  return token;
}

// ==============================
// 入口
// ==============================
exports.api = onRequest(
  { region: REGION, cors: true, secrets: ALL_SECRETS, timeoutSeconds: 300, memory: "512MiB" },
  async (req, res) => {
    let p = {};
    try {
      if (req.method === "GET") p = req.query || {};
      else if (typeof req.body === "string") p = JSON.parse(req.body || "{}");
      else if (req.body && Object.keys(req.body).length) p = req.body;
      else p = JSON.parse((req.rawBody && req.rawBody.toString("utf8")) || "{}");
    } catch (e) {
      res.json({ status: "error", message: "リクエストの形式が正しくありません" });
      return;
    }
    res.json(await handleRequest(p));
  }
);

async function handleRequest(p) {
  try {
    // 撮影オプション一覧アプリ（倉庫用）：倉庫用パスワードで、加入セラーの一覧だけ見られる
    if (p.action === "get_option_list") {
      const pass = String(process.env.OPTION_VIEW_PASS || "");
      if (!pass) return { status: "error", message: "OPTION_VIEW_PASS（倉庫用パスワード）が設定されていません" };
      if (String(p.pass || "") !== pass && p.secret !== APP_SECRET.value()) {
        return { status: "error", code: "auth", message: "パスワードが違います" };
      }
      const r = await getOptionList(p.label, !!p.fresh);
      r.status = "success";
      return r;
    }

    const secret = APP_SECRET.value();
    if (!secret) return { status: "error", message: "APP_SECRET が登録されていません" };
    if (p.secret !== secret) return { status: "error", code: "auth", message: "認証エラー：合言葉が違います" };

    const action = p.action;
    let result;

    if (action === "ping") {
      result = {};
    } else if (action === "get_fb_token") {
      result = await getFirebaseToken(p);
    } else if (action === "get_seller_info") {
      result = await getSellerInfoByChatworkId(p.chatwork_id);
    } else if (action === "generate_ai_reply") {
      result = await generateAiReply(p);
    } else if (action === "get_ai_config") {
      result = await getAiConfigForEdit();
    } else if (action === "save_ai_config") {
      result = await saveAiConfig(p);
    } else if (action === "suggest_ai_rules") {
      result = await suggestAiRules(p);
    } else if (action === "get_room_note") {
      result = await getRoomNote(p.room_id);
    } else if (action === "save_room_note") {
      result = await saveRoomNote(p);
    } else if (action === "save_shipments") {
      result = await saveShipments(p);
    } else if (action === "find_shipments") {
      result = await findShipments(p.q);
    } else if (action === "us_request") {
      result = await createUsRequest(p);
    } else if (action === "get_questions") {
      result = await getQuestions();
    } else if (action === "close_question") {
      result = await closeQuestion(p.account, p.room_id, p.no);
    } else {
      const token = getChatworkToken(p.account);
      if (action === "get_unread_bundle") {
        result = await getUnreadBundle(token, p.account);
      } else if (action === "get_todo_bundle") {
        result = await getTodoBundle(token, p);
      } else if (action === "set_option_override") {
        result = await setOptionOverride(p);
      } else if (action === "get_option_sellers") {
        result = await getOptionSellers(token, p.label);
      } else if (action === "get_later_bundle") {
        result = await getLaterBundle(token, p.account);
      } else if (action === "get_later") {
        result = { later: await getLater(p.account) };
      } else if (action === "set_later") {
        result = { later: await setLater(p.account, p.room_ids, p.on !== false) };
      } else if (action === "get_latest_messages") {
        result = { latest: await fetchLatest(token, p.room_ids) };
      } else if (action === "get_members") {
        result = { members: await getMembersCached(token, p.room_id) };
      } else if (action === "fix_triage") {
        result = await fixTriage(p);
      } else if (action === "mark_read_batch") {
        result = await markReadBatch(token, p.room_ids);
      } else if (action === "get_rooms") {
        result = { rooms: slimRooms(await cw(token, "get", "/rooms")) };
      } else if (action === "summarize_room") {
        result = await summarizeRoom(token, p);
      } else if (action === "get_room_data") {
        result = await getChatworkRoomData(token, p.room_id);
      } else if (action === "get_room_file") {
        result = { file: await cw(token, "get", "/rooms/" + safeRid(p.room_id) + "/files/" + String(p.file_id).replace(/[^0-9]/g, "") + "?create_download_url=1") };
      } else if (action === "send_message") {
        result = await sendChatworkMessage(token, p.room_id, p.body);
        await markSentFromCockpit(p.room_id, p.body);
        if (p.done) {
          await clearAnsweredQuestion(p.account, p.room_id);
          // 送信と同時に「既読」＋「後で対応から外す」
          try { await markChatworkRead(token, p.room_id, null); } catch (e) {}
          result.later = await setLater(p.account, [p.room_id], false);
        }
      } else if (action === "get_reply_refs") {
        result = await getReplyRefs(token, p.refs);
      } else if (action === "ask_question") {
        result = await askQuestion(token, p);
      } else if (action === "sync_now") {
        result = await syncNow(p.account, token);
      } else if (action === "get_me") {
        const cfg = await getAiConfig();
        result = {
          me_id: await getMeId(p.account, token),
          owner_ids: await getOwnerIds(),   // ラクロジスタッフ・松下のアカウント
          internal_room_ids: String(cfg.internalRoomIds || "").split(/[,、\s]+/).filter(x => /^\d+$/.test(x)),
          quick_links: String(cfg.quickLinks || "")
        };
      } else if (action === "edit_message") {
        result = await editChatworkMessage(token, p.room_id, p.message_id, p.body);
        await refreshRoomMsgDoc(p.account, token, p.room_id);
      } else if (action === "delete_message") {
        result = await deleteChatworkMessage(token, p.room_id, p.message_id);
        await refreshRoomMsgDoc(p.account, token, p.room_id);
      } else if (action === "mark_read") {
        result = await markChatworkRead(token, p.room_id, p.last_chat_id);
        await clearAnsweredQuestion(p.account, p.room_id);
      } else if (action === "upload_file") {
        result = await uploadChatworkFile(token, p.room_id, p.file_data, p.file_name, p.mime_type, p.message);
        if (p.message) await markSentFromCockpit(p.room_id, p.message);
        if (p.done) {
          await clearAnsweredQuestion(p.account, p.room_id);
          try { await markChatworkRead(token, p.room_id, null); } catch (e) {}
          result.later = await setLater(p.account, [p.room_id], false);
        }
      } else {
        throw new Error("不明なアクションです: " + action);
      }
    }

    result.status = "success";
    return result;
  } catch (err) {
    console.error(err);
    return { status: "error", message: err.message };
  }
}

function safeRid(id) {
  const rid = String(id || "").replace(/[^0-9]/g, "");
  if (!rid) throw new Error("room_id がありません");
  return rid;
}

// ==============================
// Chatwork API
// ==============================
const CW_BASE = "https://api.chatwork.com/v2";

async function cwRaw(token, method, path, payload) {
  const opt = { method: method.toUpperCase(), headers: { "X-ChatWorkToken": token } };
  if (payload) {
    opt.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opt.body = new URLSearchParams(payload).toString();
  } else if (opt.method === "PUT" || opt.method === "POST") {
    opt.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opt.body = "";
  }
  return fetch(CW_BASE + path, opt);
}

// エラー時は理由を返す
async function cw(token, method, path, payload) {
  const res = await cwRaw(token, method, path, payload);
  if (res.status === 204) return null;
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) throw new Error("Chatwork API エラー (" + res.status + "): " + text);
  return text ? JSON.parse(text) : null;
}

function slimRooms(rooms) {
  return (Array.isArray(rooms) ? rooms : []).map(r => ({
    room_id: r.room_id, name: r.name, unread_num: r.unread_num, last_update_time: r.last_update_time
  }));
}

// ルームの最新メッセージ（失敗しても止めない）
async function fetchMessages(token, rid) {
  try {
    const res = await cwRaw(token, "get", "/rooms/" + rid + "/messages?force=1");
    if (res.status === 204) return { code: 204, msgs: [] };
    if (res.status !== 200) return { code: res.status, msgs: null };
    const arr = JSON.parse(await res.text());
    return { code: 200, msgs: Array.isArray(arr) ? arr : [] };
  } catch (e) {
    return { code: 0, msgs: null };
  }
}

// 未読ルーム一覧 ＋ 各ルームの最新メッセージ
async function getUnreadBundle(token, account) {
  const rooms = slimRooms(await cw(token, "get", "/rooms"));
  const unreadIds = rooms.filter(r => Number(r.unread_num || 0) > 0).map(r => String(r.room_id));
  const [latest, myIds, later] = await Promise.all([fetchLatest(token, unreadIds), getMyIds(), getLater(account)]);
  return { rooms, latest, my_ids: myIds, later };
}

// 「後で対応」タブ用
async function getLaterBundle(token, account) {
  const later = await getLater(account);
  const rooms = slimRooms(await cw(token, "get", "/rooms"));
  const [latest, myIds] = await Promise.all([fetchLatest(token, later), getMyIds()]);
  return { rooms, later, latest, my_ids: myIds };
}

// 自社アカウントのID（「返信済み？」表示用）
// ラクロジスタッフ・松下のアカウントID（トークンの持ち主）
async function getOwnerIds() {
  const hit = cacheGet("owner_ids");
  if (hit) return hit;
  const ids = [];
  for (const acc of Object.keys(ACCOUNTS)) {
    const token = ACCOUNTS[acc].value();
    if (!token) continue;
    try {
      const me = await cw(token, "get", "/me");
      if (me && me.account_id) ids.push(String(me.account_id));
    } catch (e) {}
  }
  cachePut("owner_ids", ids, 21600);
  return ids;
}

const envIds = name => String(process.env[name] || "").split(/[,、\s]+/).filter(x => /^\d+$/.test(x));

async function getMyIds() {
  const hit = cacheGet("my_ids");
  if (hit) return hit;
  const ids = (await getOwnerIds()).concat(envIds("STAFF_ACCOUNT_IDS"));
  cachePut("my_ids", ids, 21600);
  return ids;
}

// Chatworkで直接送った返信を記録する対象（ラクロジスタッフ・松下・LEARN_ACCOUNT_IDS）
async function getLearnIds() {
  return (await getOwnerIds()).concat(envIds("LEARN_ACCOUNT_IDS"));
}

// 「後で対応」リスト（スタッフ全員で共有。アカウントごと）
function laterDocId(account) {
  if (!ACCOUNTS[account]) throw new Error("アカウントの指定が正しくありません: " + account);
  return "later_" + account;
}
async function getLater(account) {
  const arr = await loadJsonDoc(laterDocId(account), []);
  return Array.isArray(arr) ? arr.map(String) : [];
}
async function setLater(account, roomIds, on) {
  const ref = db.collection("cw_server").doc(laterDocId(account));
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    let list = [];
    try { list = (JSON.parse((snap.exists && snap.get("json")) || "[]") || []).map(String); } catch (e) {}
    onlyIds(roomIds).forEach(id => {
      const i = list.indexOf(id);
      if (on && i === -1) list.push(id);
      if (!on && i > -1) list.splice(i, 1);
    });
    tx.set(ref, { json: JSON.stringify(list), updatedAt: nowSec() });
    return list;
  });
}

// 指定ルームの最新メッセージ（最大5件）
const LATEST_COUNT = 5;
async function fetchLatest(token, roomIds) {
  const ids = onlyIds(roomIds);
  const latest = {};
  await inChunks(ids, 25, async id => {
    const r = await fetchMessages(token, id);
    if (r.code === 204) latest[id] = { messages: [] };
    else if (r.msgs === null) latest[id] = { error: "取得失敗 (" + r.code + ")" };
    else latest[id] = { messages: r.msgs.slice(-LATEST_COUNT) };
  });
  return latest;
}

// 複数ルームをまとめて既読
async function markReadBatch(token, roomIds) {
  let ok = 0, ng = 0;
  await inChunks(onlyIds(roomIds), 25, async id => {
    try {
      const res = await cwRaw(token, "put", "/rooms/" + id + "/messages/read");
      if (res.status === 200 || res.status === 204) ok++; else ng++;
    } catch (e) { ng++; }
  });
  return { ok, ng };
}

// ルームメンバーは6時間キャッシュ
async function getMembersCached(token, roomId) {
  const rid = String(roomId || "").replace(/[^0-9]/g, "");
  if (!rid) return [];
  const key = "members_" + rid;
  const hit = cacheGet(key);
  if (hit) return hit;
  const members = (await cw(token, "get", "/rooms/" + rid + "/members")) || [];
  const slim = members.map(m => ({ account_id: m.account_id, name: m.name }));
  cachePut(key, slim, 21600);
  return slim;
}

async function getChatworkRoomData(token, roomId) {
  const rid = safeRid(roomId);
  const messages = await cw(token, "get", "/rooms/" + rid + "/messages?force=1");
  let members = [];
  try { members = await getMembersCached(token, rid); } catch (e) { members = []; }
  return {
    messages: Array.isArray(messages) ? messages : [],
    members: Array.isArray(members) ? members : [],
    my_ids: await getMyIds()
  };
}

async function sendChatworkMessage(token, roomId, body) {
  if (!body) throw new Error("送信する本文が空です");
  await cw(token, "post", "/rooms/" + safeRid(roomId) + "/messages", { body: body, self_unread: "0" });
  return { success: true };
}

// このアカウント自身のID（自分のメッセージだけ編集・削除できるため）
// 自社の人からでも、このアカウント宛て（[To:]・返信・タスクの担当）なら「依頼」として要対応に出す
function isRequestToMe(m, meId) {
  if (!meId || !m) return false;
  if (String(m.account && m.account.account_id) === String(meId)) return false;
  const b = String(m.body || "");
  return b.indexOf("[To:" + meId + "]") !== -1 || b.indexOf("[rp aid=" + meId + " ") !== -1 || b.indexOf("[task aid=" + meId + " ") !== -1;
}

async function getMeId(account, token) {
  const key = "me_id_" + account;
  const hit = cacheGet(key);
  if (hit) return hit;
  const me = await cw(token, "get", "/me");
  const id = String((me && me.account_id) || "");
  if (id) cachePut(key, id, 21600);
  return id;
}

const safeMid = id => {
  const mid = String(id || "").replace(/[^0-9]/g, "");
  if (!mid) throw new Error("message_id がありません");
  return mid;
};

// メッセージの編集（このアカウントが送ったものだけ）
async function editChatworkMessage(token, roomId, messageId, body) {
  if (!body || !String(body).trim()) throw new Error("本文が空です");
  await cw(token, "put", "/rooms/" + safeRid(roomId) + "/messages/" + safeMid(messageId), { body: String(body) });
  return { success: true };
}

// メッセージの削除（このアカウントが送ったものだけ）
async function deleteChatworkMessage(token, roomId, messageId) {
  await cw(token, "delete", "/rooms/" + safeRid(roomId) + "/messages/" + safeMid(messageId));
  return { success: true };
}

async function markChatworkRead(token, roomId, messageId) {
  const payload = {};
  if (messageId) payload.message_id = String(messageId);
  await cw(token, "put", "/rooms/" + safeRid(roomId) + "/messages/read", payload);
  return { success: true };
}

// ファイル送信（message があれば、ファイルと一緒に本文も送る）
async function uploadChatworkFile(token, roomId, fileData, fileName, mimeType, message) {
  if (!fileData) throw new Error("ファイルが空です");
  const buf = Buffer.from(String(fileData), "base64");
  if (buf.length > 5 * 1024 * 1024) throw new Error("Chatworkに送れるファイルは5MBまでです");
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mimeType || "application/octet-stream" }), fileName || "file");
  if (message) form.append("message", String(message));
  const res = await fetch(CW_BASE + "/rooms/" + safeRid(roomId) + "/files", {
    method: "POST", headers: { "X-ChatWorkToken": token }, body: form
  });
  if (res.status < 200 || res.status >= 300) throw new Error("Chatwork API エラー (" + res.status + "): " + await res.text());
  return { success: true };
}

// ==============================
// AIの文章ルール（初期値）
//   実際に使うのは Firestore の cw_config/ai_prompt。空の項目だけ、ここの初期値を使う
// ==============================
const DEFAULT_INTERNAL_ROOM_IDS = "380072256"; // 渡辺大輔

// 番号からほかのサイトを開くリンク（1行に「名前|URL|種類」。URLの {番号} は番号に置き換わる。{番号} がなければ番号をコピーして開く）
//   種類：追跡 / Amazon / Shopee / 注文 / すべて
const DEFAULT_QUICK_LINKS = "ヤマト追跡|https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number01={番号}|追跡\n佐川追跡|https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo={番号}|追跡\n日本郵便追跡|https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1={番号}&locale=ja|追跡\nRobot-in（ri20）|https://ri20.robot-in.com/paas/admin/|すべて\nRobot-in（ri14）|https://ri14.robot-in.com/paas/admin/|すべて\n越境代行（magitech）|https://crossborder-auto.magitech-tool-lab.com/orders/daiko/|すべて\nサイバーロジ WMS|https://wms.cyber-logi.com/login.html|すべて\nzaico|https://web.zaico.co.jp/|すべて\nヤマト ビジネスメンバーズ|https://bmypage.kuronekoyamato.co.jp/bmypage/servlet/jp.co.kuronekoyamato.wur.hmp.servlet.user.HMPLGI0010JspServlet|追跡\n佐川 e-サービス|https://www.e-service.sagawa-exp.co.jp/|追跡\n";

const DEFAULT_RULES_COMMON =
  "【追加ルール】\n"
  + "・指示やチャットにない事実（日付・数量・理由・約束など）は書かない\n";

const DEFAULT_RULES_EXTERNAL =
  "・こちらから新しく連絡する時は、1行目を「いつもお世話になっております。」にする\n";

const DEFAULT_RULES_INTERNAL =
  "・社内メンバーとのやり取りなので、短く簡潔に。「いつもお世話になっております。」は付けない\n";

function aiDefaults() {
  return {
    common: DEFAULT_RULES_COMMON,
    external: DEFAULT_RULES_EXTERNAL,
    internal: DEFAULT_RULES_INTERNAL,
    internalRoomIds: DEFAULT_INTERNAL_ROOM_IDS,
    questionRoomId: "",   // 空なら社内ルームIDの1つ目
    questionToId: "",
    quickLinks: DEFAULT_QUICK_LINKS
  };
}

const AI_CONFIG_FIELDS = ["common", "external", "internal", "internalRoomIds", "questionRoomId", "questionToId", "quickLinks"];
const AI_CONFIG_REF = () => db.collection("cw_config").doc("ai_prompt");

// Firestoreに保存されている内容（1分キャッシュ）
async function loadAiConfigRaw(fresh, ttlSec) {
  if (!fresh) {
    const hit = cacheGet("ai_config");
    if (hit) return hit;
  }
  try {
    const snap = await AI_CONFIG_REF().get();
    const raw = snap.exists ? snap.data() : {};
    cachePut("ai_config", raw, ttlSec || 60);
    return raw;
  } catch (e) {
    console.error("AIルールの読み込みに失敗（初期値で動きます）: " + e.message);
    return {};
  }
}

async function getAiConfig(ttlSec) {
  const raw = await loadAiConfigRaw(false, ttlSec);
  const def = aiDefaults();
  const cfg = {};
  AI_CONFIG_FIELDS.forEach(k => { cfg[k] = (raw[k] && String(raw[k]).trim()) ? String(raw[k]) : def[k]; });
  return cfg;
}

// 各ルールの末尾に空行をそろえる
const block = s => String(s || "").replace(/\s+$/, "") + "\n\n";

function isInternalRoom(roomId, cfg) {
  const rid = String(roomId || "");
  if (!rid) return false;
  return String(cfg.internalRoomIds || "").split(/[,、\s]+/).filter(x => /^\d+$/.test(x)).indexOf(rid) !== -1;
}

async function getAiConfigForEdit() {
  const raw = await loadAiConfigRaw(true);
  return {
    saved: {
      common: raw.common || "", external: raw.external || "",
      internal: raw.internal || "", internalRoomIds: raw.internalRoomIds || "",
      questionRoomId: raw.questionRoomId || "", questionToId: raw.questionToId || "",
      quickLinks: raw.quickLinks || ""
    },
    defaults: aiDefaults(),
    updatedBy: raw.updatedBy || "",
    updatedAt: raw.updatedAt || 0
  };
}

// 保存（前の内容は cw_config_history に残す）
async function saveAiConfig(p) {
  const data = {};
  AI_CONFIG_FIELDS.forEach(k => {
    const v = String(p[k] === undefined || p[k] === null ? "" : p[k]);
    if (v.length > 20000) throw new Error("ルールが長すぎます（1項目20,000文字まで）");
    data[k] = v;
  });
  data.internalRoomIds = data.internalRoomIds.split(/[,、\s]+/).filter(x => /^\d+$/.test(x)).join(",");
  data.questionRoomId = data.questionRoomId.replace(/[^0-9]/g, "");
  data.questionToId = data.questionToId.replace(/[^0-9]/g, "");
  data.updatedBy = String(p.by || "").slice(0, 40);
  data.updatedAt = nowSec();

  await db.runTransaction(async tx => {
    const snap = await tx.get(AI_CONFIG_REF());
    if (snap.exists) {
      const prev = Object.assign({}, snap.data(), { replacedAt: data.updatedAt, replacedBy: data.updatedBy });
      tx.set(db.collection("cw_config_history").doc(data.updatedAt + "_" + crypto.randomUUID().slice(0, 8)), prev);
    }
    tx.set(AI_CONFIG_REF(), data);
  });
  cacheRemove("ai_config");
  return { ok: true, updatedAt: data.updatedAt };
}

// ==============================
// OpenAI（ChatGPT）
//   opt.system … AIの役割・文章ルール（土台になる指示）
//   opt.json   … JSONで返してほしいとき true
//   opt.timeoutMs … 1回あたりの待ち時間の上限（同期の中で使う時に指定）
//   opt.tries     … やり直しを含めた回数（初期値3）
// ==============================
async function callAI(prompt, opt = {}) {
  const apiKey = OPENAI_API_KEY.value();
  if (!apiKey) throw new Error("OPENAI_API_KEY が登録されていません");
  const messages = [];
  if (opt.system) messages.push({ role: "system", content: opt.system });
  messages.push({ role: "user", content: prompt });
  const reqBody = { model: OPENAI_MODEL, messages };
  if (opt.json) reqBody.response_format = { type: "json_object" };

  // 混雑時（429/500/502/503）や空の結果のときは、少し待って最大2回までやり直す
  let lastReason = "";
  const tries = opt.tries || 3;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify(reqBody),
      signal: opt.timeoutMs ? AbortSignal.timeout(opt.timeoutMs) : undefined
    });
    const text = await res.text();
    if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503) {
      lastReason = "AIが混み合っています (" + res.status + ")";
      continue;
    }
    if (res.status !== 200) throw new Error("OpenAI API エラー (" + res.status + "): " + text);

    const data = JSON.parse(text);
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    const out = msg && typeof msg.content === "string" ? msg.content.trim() : "";
    if (out) return out;

    if (msg && msg.refusal) { lastReason = "AIが作成を断りました (" + msg.refusal + ")"; break; }
    lastReason = "結果が空でした (" + ((data.choices && data.choices[0] && data.choices[0].finish_reason) || "理由不明") + ")";
  }
  throw new Error("AIの文章を作成できませんでした：" + lastReason);
}

// 文章の基本（画面の⚙️では変えられない固定部分）
//   ルールを増やしすぎると、軽いモデルは文章が硬く・雑になりやすいので、最小限にしている
const AI_BASE_NOTE = "【指示】は担当者の走り書きのメモです。そのまま写さず、意味をくみ取って、取引先に送る丁寧なビジネス敬語の文章に整えてください。\n\n";

// 返信案・新規発信の文章を作成
async function generateAiReply(params) {
  const roomName = params.room_name || "ルーム";
  const contextText = params.context || "";
  const customPrompt = params.custom_prompt || "";
  const cfg = await getAiConfig();
  const internal = isInternalRoom(params.room_id, cfg);
  const rules = block(String(cfg.common || "").trim() + "\n" + String((internal ? cfg.internal : cfg.external) || "").trim());
  const note = params.room_id ? (await getRoomNote(params.room_id)).summary : "";
  const qa = await qaForPrompt(params.room_id);
  const noteBlock = note
    ? "【このルームの状況（担当者が整理したもの）】\n" + note.trim() + "\n\n"
      + "この状況をふまえ、内容と食い違わない文章にしてください。状況の文をそのまま書き写したり、相手が聞いていないことまで持ち出したりはしないでください。\n\n"
    : "";

  // 役割と文章ルールは system（土台）、今回の指示と会話は user に分けて渡す
  //   → ルールをそのまま書き写したような文章になりにくい
  const system = "あなたは物流倉庫のカスタマーサポート担当です。取引先とのチャットで送るメッセージを作成します。宛名・自己紹介は不要です。丁寧かつ簡潔にしてください。\n\n"
    + rules
    + noteBlock
    + (qa ? "【参考：過去に渡辺さん（責任者）が答えたQ&A】\n" + qa + "\n"
      + "今回の内容に関係するQ&Aがあれば、その答えに沿って書いてください。関係しないQ&Aは使わないでください。\n\n" : "")
    + "出力は送信するメッセージ本文のみとし、記号（*や#）は使わないでください。";

  let prompt;
  if (params.mode === "compose") {
    if (!customPrompt) throw new Error("伝えたい内容を入力してください");
    prompt = "以下の【指示】の内容を、こちらから相手へ送るチャットメッセージにしてください。\n\n"
      + "【指示】\n" + customPrompt + "\n\n"
      + AI_BASE_NOTE
      + "【参考：このルームの最近のやり取り】\n" + (contextText || "なし");
  } else {
    prompt = "以下のチャットで、相手の最後のメッセージに対する返信文を作成してください。\n\n";
    if (customPrompt) {
      prompt += "【指示（返信で伝える内容）】\n" + customPrompt + "\n\n" + AI_BASE_NOTE;
    }
    prompt += "【これまでのメッセージ】\n" + contextText;
  }
  return { ai_reply: await callAI(prompt, { system }) };
}

// ==============================
// ルームごとの「状況の整理」メモ（cw_room_notes/{ルームID}）
// ==============================
const ROOM_NOTE_MAX = 3000;
const roomNoteRef = rid => db.collection("cw_room_notes").doc(safeRid(rid));

async function getRoomNote(roomId) {
  const rid = String(roomId || "").replace(/[^0-9]/g, "");
  if (!rid) return { summary: "", updatedAt: 0, updatedBy: "" };
  const key = "room_note_" + rid;
  const hit = cacheGet(key);
  if (hit) return hit;
  let out = { summary: "", updatedAt: 0, updatedBy: "" };
  try {
    const snap = await roomNoteRef(rid).get();
    if (snap.exists) {
      const d = snap.data();
      out = { summary: String(d.summary || ""), updatedAt: d.updatedAt || 0, updatedBy: d.updatedBy || "" };
    }
  } catch (e) {
    console.error("状況メモの読み込みに失敗: " + e.message);
  }
  cachePut(key, out, 60);
  return out;
}

async function saveRoomNote(p) {
  const rid = safeRid(p.room_id);
  const summary = String(p.summary || "").trim();
  if (summary.length > ROOM_NOTE_MAX) throw new Error("状況メモが長すぎます（" + ROOM_NOTE_MAX + "文字まで）");
  const data = {
    summary, roomName: String(p.room_name || "").slice(0, 100),
    updatedBy: String(p.by || "").slice(0, 40), updatedAt: nowSec()
  };
  await roomNoteRef(rid).set(data);
  cacheRemove("room_note_" + rid);
  return { summary: data.summary, updatedAt: data.updatedAt, updatedBy: data.updatedBy };
}

// ルームの最近のやり取り（最大40件）と、いまのメモから「状況の整理」をAIで作る（保存はしない）
async function summarizeRoom(token, p) {
  const rid = safeRid(p.room_id);
  const msgs = await cw(token, "get", "/rooms/" + rid + "/messages?force=1");
  const list = (Array.isArray(msgs) ? msgs : []).slice(-40);
  if (!list.length) throw new Error("このルームにはメッセージがありません");
  const myIds = (await getMyIds()).map(String);
  const fmt = t => new Date((t || 0) * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const lines = list.map(m => {
    const id = String(m.account && m.account.account_id);
    const who = ((m.account && m.account.name) || "") + (myIds.indexOf(id) !== -1 ? "【自社】" : "");
    return "[" + fmt(m.send_time) + "] " + who + "：" + stripTags(m.body).slice(0, 800);
  }).join("\n");
  const current = (await getRoomNote(rid)).summary;

  const prompt = "以下は、物流倉庫（自社）と相手とのChatworkルーム「" + String(p.room_name || "ルーム") + "」のやり取りです。\n"
    + "次にこのルームで返信する担当者が、すぐ状況をつかめるように整理してください。\n\n"
    + "【整理の決まり】\n"
    + "・次の見出しで、それぞれ「・」で始まる短い箇条書きにする（該当がなければ「・特になし」）\n"
    + "　【相手について】【進行中の件】【約束・期限】【こちらの対応待ち】【注意点】\n"
    + "・やり取りに書かれている事実だけを書き、推測はしない。日付は分かる範囲で入れる\n"
    + "・終わった件は書かない。いまのメモにあって、やり取りで終わったと分かる件は消す\n"
    + "・いまのメモにあって、やり取りから確認できない件はそのまま残す\n"
    + "・全体で" + 600 + "文字くらいまでにまとめる。記号（*や#）は使わない\n\n"
    + "【いまのメモ】\n" + (current || "なし") + "\n\n"
    + "【やり取り（古い順）】\n" + lines
    + "\n\n整理した内容だけを出力してください。";
  const summary = await callAI(prompt);
  return { summary: summary.slice(0, ROOM_NOTE_MAX) };
}

// ==============================
// Chatworkで直接送った返信を、AI添削ログ（ai_brushup_feedback）に入れる
// ==============================

// 文章の目印（タグ・空白を除いた本文のハッシュ）
function textMark(body) {
  const s = stripTags(body).replace(/\s+/g, "");
  return s ? crypto.createHash("sha1").update(s, "utf8").digest("hex").slice(0, 16) : "";
}

// コックピットから送った文の目印を残す（ルームごとに最新30件）
async function markSentFromCockpit(roomId, body) {
  const rid = String(roomId || "").replace(/[^0-9]/g, "");
  const mark = textMark(body);
  if (!rid || !mark) return;
  const ref = db.collection("cw_sent_marks").doc(rid);
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const marks = (snap.exists && Array.isArray(snap.get("marks"))) ? snap.get("marks") : [];
      marks.push(mark);
      tx.set(ref, { marks: marks.slice(-30), updatedAt: nowSec() });
    });
  } catch (e) {
    console.error("送信の目印を残せませんでした: " + e.message);
  }
}

// メッセージ一覧から「お客様のメッセージ → 自社の返信」の組を作る
//   since より後に送られた返信だけを対象にする（同じ返信を何度も保存しないため）
function pickReplyPairs(msgs, learnIds, myIds, since) {
  const isLearn = m => learnIds.indexOf(String(m.account && m.account.account_id)) !== -1;
  const isMine = m => isLearn(m) || myIds.indexOf(String(m.account && m.account.account_id)) !== -1;
  const pairs = [];
  msgs.forEach((m, idx) => {
    if ((m.send_time || 0) <= since || !isLearn(m)) return;
    const replyText = stripTags(m.body);
    if (replyText.length < 6) return;
    // 直前に続いているお客様のメッセージ（最大3件）をまとめて「問い合わせ」にする
    const qs = [];
    for (let j = idx - 1; j >= 0 && qs.length < 3; j--) {
      if (isMine(msgs[j])) break;
      qs.unshift(msgs[j]);
    }
    if (!qs.length) return;
    const question = qs.map(q => stripTags(q.body)).filter(s => s).join("\n").slice(0, 1500);
    if (!question) return;
    pairs.push({
      id: String(m.message_id),
      data: {
        question,
        questionSender: (qs[qs.length - 1].account && qs[qs.length - 1].account.name) || "",
        questionTime: qs[qs.length - 1].send_time || 0,
        replyText: replyText.slice(0, 3000),
        replierId: String(m.account && m.account.account_id),
        replierName: (m.account && m.account.name) || "",
        replyTime: m.send_time || 0
      }
    });
  });
  return pairs;
}

// AI添削ログ用のデータに変換
function toFeedbackLog(acc, rid, roomName, pr) {
  const d = pr.data;
  return {
    source: "chatwork_direct", messageId: pr.id,
    account: d.replierName || acc, cockpitAccount: acc, replierId: d.replierId,
    mode: "reply", tab: "Chatwork直接",
    roomId: rid, roomName: roomName || "",
    userEditedText: d.replyText, finalText: d.replyText,
    usedAi: false, draftId: null, aiGeneratedText: null, customPrompt: null, generateCount: 0,
    reusedLastSent: false,
    context: (d.questionSender ? d.questionSender + "：" : "") + d.question,
    finalLength: d.replyText.length,
    updatedAt: admin.firestore.Timestamp.fromMillis((d.replyTime || nowSec()) * 1000)
  };
}

// AI添削ログから「AI文章ルール」の改善案を作る
async function suggestAiRules(p) {
  const samples = Array.isArray(p.samples) ? p.samples.slice(0, 60) : [];
  if (samples.length < 3) throw new Error("直された例が少ないため、改善案を作れません（3件以上必要です）");
  const cfg = await getAiConfig();
  const cut = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; };

  const lines = samples.map((s, i) =>
    "■例" + (i + 1) + "（" + (s.mode === "compose" ? "新規発信" : "返信") + "・" + (s.internal ? "社内" : "社外")
    + "・" + (s.level || "") + "）\n"
    + "AIへの指示：" + cut(s.prompt, 300) + "\n"
    + "AI案：\n" + cut(s.ai, 600) + "\n"
    + (s.sent ? "実際に送った文：\n" + cut(s.sent, 600) : "（このAI案は送られなかった）")
  ).join("\n\n");

  const prompt = "あなたは、物流倉庫のカスタマーサポートで使うAI返信ツールの「文章ルール」を改善する担当です。\n"
    + "下の【いまのルール】でAIが文章を作り、スタッフが【直された例】のように手直しして送りました。\n"
    + "スタッフが何度も同じように直している点を見つけ、ルールに反映した改善版を作ってください。\n\n"
    + "【改善の決まり】\n"
    + "・2件以上の例で同じ直し方が見られるものだけをルールにする。1件だけの直しは findings に書くだけにする\n"
    + "・スタッフが後から足した具体的な事実（追跡番号、金額、数量、原因など）はAIが知り得ないので、ルールにしない\n"
    + "・お客様の名前、会社名、ルーム名、URL、番号などの固有の情報はルールに書かない\n"
    + "・いまのルールで問題が出ていない部分は消さない。言い回しも必要な時以外は変えない\n"
    + "・書式はいまのルールと同じく、【見出し】と「・」で始まる短い箇条書きにする。各ルールは長くしすぎない\n"
    + "・社内ルームだけの直しは internal に、社外ルームだけの直しは external に、両方なら common に入れる\n"
    + "・「指示の言葉をそのまま使う」「短く言い切る」など、文章を雑・失礼にする方向のルールは作らない。丁寧さは保ったまま直す\n\n"
    + "【出力】次のJSONだけを返す\n"
    + "{\"findings\": [\"気づき（何件の例で、どう直されていたか）を1文ずつ\"], "
    + "\"common\": \"共通ルールの改善版の全文\", \"external\": \"社外ルールの改善版の全文\", \"internal\": \"社内ルールの改善版の全文\"}\n"
    + "変更が不要な項目は、いまのルールをそのまま入れる。\n\n"
    + "【いまのルール：共通】\n" + cfg.common + "\n\n"
    + "【いまのルール：社外】\n" + cfg.external + "\n\n"
    + "【いまのルール：社内】\n" + cfg.internal + "\n\n"
    + "【直された例】\n" + lines;

  const text = await callAI(prompt, { json: true });
  let data;
  try {
    data = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch (e) {
    throw new Error("AIの改善案を読み取れませんでした。もう一度お試しください");
  }
  const pick = k => (typeof data[k] === "string" && data[k].trim()) ? data[k] : cfg[k];
  return {
    findings: Array.isArray(data.findings) ? data.findings.map(String).slice(0, 20) : [],
    current: { common: cfg.common, external: cfg.external, internal: cfg.internal, internalRoomIds: cfg.internalRoomIds },
    proposed: { common: pick("common"), external: pick("external"), internal: pick("internal") }
  };
}

// ==============================
// セラー情報検索（ルーム名に含まれる管理番号で検索）
//   ※ 各スプレッドシートを、Cloud Functions のサービスアカウントに「閲覧者」で共有しておくこと
// ==============================
/**
 * ▼ 追加で表示したい列はシートごとに「extraFields」に書きます
 *   label  … 画面に出す項目名
 *   col    … 列のアルファベット（例: "K"）
 *   header … 列の見出し名（含まれていればOK。列がずれても追従します）
 *   yesno  … ◯×で表示したい時に指定（任意） { yes: "◯にする文字", no: "×にする文字" } ※空欄は×
 *   fixed  … 列を見ずに常に同じ値を表示（例: fixed: "◯"）
 */
const SELLER_SHEETS = [
  {
    sheetLabel: "シート1",
    spreadsheetId: "1oOqn_2OSkubEV5xUky0jl7QvSkoeSawLGvn5l2Xgx10", sheetName: "フォームの回答 1", kanriCol: 0,
    extraFields: [
      { label: "動画撮影オプション", header: "動画撮影オプション", yesno: { yes: "利用する", no: "利用しない" } }
    ]
  },
  {
    sheetLabel: "シート2",
    spreadsheetId: "1hsEfgrnPw7nBw9Er6tfO1_jZgbL7_PuIVmw34n8Dy0w", sheetName: "フォームの回答 1", kanriCol: 22,
    extraFields: [
      { label: "動画撮影オプション", header: "動画オプション", yesno: { yes: "はい", no: "いいえ" } }
    ]
  },
  {
    sheetLabel: "シート3",
    spreadsheetId: "1n_1x-OIfeqWdv9J0eOYVMcAjKEtOb9KHkiFO4zoXV2k", sheetName: "フォームの回答 1", kanriCol: 23,
    extraFields: [
      { label: "動画撮影オプション", header: "動画撮影オプション", yesno: { yes: "利用する", no: "利用しない" } }
    ]
  },
  {
    sheetLabel: "シート4",
    spreadsheetId: "1QFgSUeyvPFFtrTmla4lC3qEstpujfsjLdGw01yNoQtQ", sheetName: "フォームの回答 1", kanriCol: 18,
    extraFields: [
      { label: "動画撮影オプション", header: "動画撮影オプション", yesno: { yes: "利用する", no: "利用しない" } }
    ]
  },
  {
    sheetLabel: "シート5",
    spreadsheetId: "1Kgg23A-U5beQVuARzOQw70YZ1psUoQkQnUSQ0IljxFI", sheetName: "フォームの回答 1", kanriCol: 9,
    extraFields: [
      { label: "動画撮影オプション", fixed: "◯" }
    ]
  }
];

const sheetsAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });

async function readSheetValues(spreadsheetId, sheetName) {
  const client = await sheetsAuth.getClient();
  const url = "https://sheets.googleapis.com/v4/spreadsheets/" + spreadsheetId + "/values/"
    + encodeURIComponent("'" + sheetName.replace(/'/g, "''") + "'") + "?valueRenderOption=FORMATTED_VALUE";
  const res = await client.request({ url });
  return (res.data && res.data.values) || [];
}

function colLetterToIndex(letter) {
  const s = String(letter).trim().toUpperCase();
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1;
}

function resolveExtraCols(fields, headers) {
  return (fields || []).map(f => {
    if (f.fixed !== undefined) return { label: f.label, idx: -1, fixed: String(f.fixed) };
    let idx = -1;
    if (f.col) idx = colLetterToIndex(f.col);
    else if (f.header) idx = headers.findIndex(h => String(h).indexOf(f.header) !== -1);
    return { label: f.label || f.header || f.col, idx, yesno: f.yesno || null };
  });
}

// ◯×表示に変換（「利用しない」を先に判定して誤判定を防ぐ）
function toMaruBatsu(value, yesno) {
  const v = String(value || "").trim();
  if (!v) return "×";
  if (yesno.no && v.indexOf(yesno.no) !== -1) return "×";
  if (yesno.yes && v.indexOf(yesno.yes) !== -1) return "◯";
  return v;
}

const cell = v => (v === undefined || v === null) ? "" : String(v);

// 全角英数字を半角にして小文字化
function normalize(s) {
  return String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .trim()
    .toLowerCase();
}

// 管理番号が「単独の番号として」ルーム名に含まれているか
function containsKanri(text, kanri) {
  let from = 0;
  while (true) {
    const idx = text.indexOf(kanri, from);
    if (idx === -1) return false;
    const before = idx > 0 ? text.charAt(idx - 1) : "";
    const after = text.charAt(idx + kanri.length);
    if (!/[0-9a-z]/.test(before) && !/[0-9a-z]/.test(after)) return true;
    from = idx + 1;
  }
}

const SELLER_CACHE_SEC = 600; // 10分

async function loadSellerRows(t, useCache) {
  const key = "seller_rows_" + t;
  if (useCache) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }
  const conf = SELLER_SHEETS[t];
  const rows = [];
  const data = await readSheetValues(conf.spreadsheetId, conf.sheetName);
  if (data.length >= 2) {
    const headers = data[0].map(cell);
    let colName = -1, colShop = -1, colId = -1, colPass = -1;
    headers.forEach((h0, c) => {
      const h = h0.trim();
      if (h.indexOf("お名前") !== -1) colName = c;
      if (h.indexOf("ショップ名") !== -1) colShop = c;
      if (h === "ID" || h.indexOf("ログインID") !== -1) colId = c;
      if (h === "PW" || h.indexOf("パスワード") !== -1 || h.indexOf("rakko.tools") !== -1) colPass = c;
    });
    const extraCols = resolveExtraCols(conf.extraFields, headers);
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const raw = row[conf.kanriCol];
      if (raw === undefined || raw === null || raw === "") continue;
      const k = normalize(raw);
      if (k.length < 2) continue;
      rows.push({
        k,
        kanriNo: cell(raw),
        name: colName !== -1 && row[colName] ? cell(row[colName]) : "不明",
        shopName: colShop !== -1 && row[colShop] ? cell(row[colShop]) : "不明",
        id: colId !== -1 && row[colId] ? cell(row[colId]) : "未登録",
        pass: colPass !== -1 && row[colPass] ? cell(row[colPass]) : "未登録",
        sheetLabel: conf.sheetLabel || "",
        extras: extraCols.map(ec => {
          if (ec.fixed !== undefined) return { label: ec.label, value: ec.fixed };
          if (ec.idx < 0) return { label: ec.label, value: "（列が見つかりません）" };
          if (ec.yesno) return { label: ec.label, value: toMaruBatsu(row[ec.idx], ec.yesno) };
          return { label: ec.label, value: cell(row[ec.idx]) || "未登録" };
        })
      });
    }
  }
  cachePut(key, rows, SELLER_CACHE_SEC);
  return rows;
}

async function findSeller(searchKey, useCache) {
  let best = null, bestLen = 0;
  const all = await Promise.all(SELLER_SHEETS.map((_, t) =>
    loadSellerRows(t, useCache).catch(e => { console.error("シート" + (t + 1) + "を開けません: " + e.message); return []; })
  ));
  all.forEach(rows => rows.forEach(r => {
    if (r.k.length > bestLen && containsKanri(searchKey, r.k)) { best = r; bestLen = r.k.length; }
  }));
  return best;
}

async function getSellerInfoByChatworkId(keyword) {
  if (!keyword) return { seller: { error: "検索キーワードが空です" } };
  const searchKey = normalize(keyword);
  if (searchKey.length < 2) return { seller: { error: "検索キーワードが短すぎます" } };

  // まずキャッシュで検索 → 見つからなければシートを読み直して再検索（新規セラー対策）
  const best = (await findSeller(searchKey, true)) || (await findSeller(searchKey, false));
  if (!best) return { seller: { error: "見つかりません" } };

  const ovAll = await getOptionOverrides();
  const extras = (best.extras || []).map(e => {
    const o = (ovAll[e.label] || {})[best.k];
    return o ? { label: e.label, value: o.v, manual: true, note: o.note || "" } : e;
  });
  return {
    seller: {
      kanriNo: best.kanriNo, name: best.name, shopName: best.shopName,
      id: best.id, pass: best.pass, sheetLabel: best.sheetLabel, extras
    }
  };
}

// Chatworkのタグを外して読みやすくする
function stripTags(s) {
  return String(s || "")
    .replace(/\[download:\d+\]([\s\S]*?)\[\/download\]/g, "📎$1")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// ==============================
// オプション加入セラーの一覧（連絡用）
// ==============================
async function getOptionSellers(token, label) {
  label = String(label || "動画撮影オプション");
  const rooms = slimRooms(await cw(token, "get", "/rooms")).map(r => ({ r, n: normalize(r.name) }));
  const ov = (await getOptionOverrides())[label] || {};
  const seen = {};
  const sellers = [];

  const findRoom = k => {
    let match = null;
    rooms.forEach(x => {
      if (containsKanri(x.n, k) && (!match || (x.r.last_update_time || 0) > (match.last_update_time || 0))) match = x.r;
    });
    return match;
  };
  const pushSeller = (base, k, o) => {
    const match = findRoom(k);
    sellers.push({
      kanriNo: base.kanriNo, name: base.name, shopName: base.shopName, sheetLabel: base.sheetLabel,
      manual: !!o, note: o ? (o.note || "") : "", by: o ? (o.by || "") : "",
      room_id: match ? match.room_id : null,
      room_name: match ? match.name : "",
      unread_num: match ? Number(match.unread_num || 0) : 0,
      last_update_time: match ? (match.last_update_time || 0) : 0
    });
  };

  for (let t = 0; t < SELLER_SHEETS.length; t++) {
    let rows = [];
    try { rows = await loadSellerRows(t, true); } catch (e) {}
    rows.forEach(row => {
      if (seen[row.k]) return;
      const o = ov[row.k];
      const ex = (row.extras || []).filter(e => e.label === label)[0];
      const value = o ? o.v : (ex ? ex.value : "");
      if (value !== "◯") return;
      seen[row.k] = true;
      pushSeller(row, row.k, o);
    });
  }

  // シートに見当たらないが、手動で「加入」にしたセラー
  Object.keys(ov).forEach(k => {
    const o = ov[k];
    if (o.v !== "◯" || seen[k]) return;
    seen[k] = true;
    pushSeller({ kanriNo: o.kanriNo || k, name: "不明", shopName: "（シートに見当たりません）", sheetLabel: "手動" }, k, o);
  });

  // 手動で「未加入」にしたセラー
  const removed = Object.keys(ov).filter(k => ov[k].v === "×").map(k => ({
    kanriNo: ov[k].kanriNo || k, note: ov[k].note || "", by: ov[k].by || "", at: ov[k].at || 0
  }));

  sellers.sort((a, b) =>
    ((b.unread_num > 0) - (a.unread_num > 0)) || ((!!b.room_id) - (!!a.room_id)) || (b.last_update_time - a.last_update_time));
  return { label, sellers, removed };
}

// ==============================
// 撮影オプション一覧アプリ用（Chatworkは使わない、表示専用）
//   スプレッドシートの回答に、コックピットで手動修正した内容（Firestore の option_overrides）を反映して返す
// ==============================
async function getOptionList(label, fresh) {
  label = String(label || "動画撮影オプション");
  const cacheKey = "option_list_" + label;
  const hit = fresh ? null : cacheGet(cacheKey);   // 🔄のときはキャッシュを使わない
  if (hit) return hit;

  // 手動修正（コックピットの「🎥 撮影オプション」で変更した内容）
  const ov = {};
  try {
    const snap = await db.collection("option_overrides").where("label", "==", label).get();
    snap.forEach(d => {
      const o = d.data();
      const k = normalize(o.k || o.kanriNo || "");
      if (k.length >= 2) ov[k] = o;
    });
  } catch (e) {
    console.error("手動修正の読み込みに失敗: " + e.message);
  }

  const seen = {};
  const sellers = [];
  for (let t = 0; t < SELLER_SHEETS.length; t++) {
    let rows = [];
    try { rows = await loadSellerRows(t, true); } catch (e) { console.error("シート" + (t + 1) + "を開けません: " + e.message); }
    rows.forEach(row => {
      if (seen[row.k]) return;
      const o = ov[row.k];
      const ex = (row.extras || []).filter(e => e.label === label)[0];
      const value = o ? o.v : (ex ? ex.value : "");
      if (value !== "◯") return;
      seen[row.k] = true;
      sellers.push({ kanriNo: row.kanriNo, shopName: row.shopName, name: row.name, sheetLabel: row.sheetLabel, manual: !!o, note: o ? (o.note || "") : "" });
    });
  }
  // シートにないが、手動で「加入」にしたセラー
  Object.keys(ov).forEach(k => {
    const o = ov[k];
    if (o.v !== "◯" || seen[k]) return;
    seen[k] = true;
    sellers.push({ kanriNo: o.kanriNo || k, shopName: o.shopName || "（シートに見当たりません）", name: "", sheetLabel: "手動", manual: true, note: o.note || "" });
  });

  sellers.sort((a, b) => String(a.kanriNo).localeCompare(String(b.kanriNo), "ja", { numeric: true }));
  const result = { label, sellers, updatedAt: nowSec() };
  cachePut(cacheKey, result, 120);   // 2分キャッシュ
  return result;
}

// オプション加入状況の手動修正（シートより優先）
async function getOptionOverrides() {
  const obj = await loadJsonDoc("option_overrides", {});
  return (obj && typeof obj === "object") ? obj : {};
}

async function setOptionOverride(p) {
  const label = String(p.label || "動画撮影オプション");
  const kanriRaw = String(p.kanri || "").trim();
  const k = normalize(kanriRaw);
  if (k.length < 2) throw new Error("管理番号を正しく入力してください");
  const value = String(p.value || "");
  if (value !== "◯" && value !== "×" && value !== "") throw new Error("指定が正しくありません");

  const ref = db.collection("cw_server").doc("option_overrides");
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    let all = {};
    try { all = JSON.parse((snap.exists && snap.get("json")) || "{}") || {}; } catch (e) {}
    if (!all[label]) all[label] = {};
    if (value === "") {
      delete all[label][k];
    } else {
      all[label][k] = {
        v: value, kanriNo: kanriRaw,
        note: String(p.note || "").slice(0, 200),
        by: String(p.by || "").slice(0, 40),
        at: nowSec()
      };
    }
    tx.set(ref, { json: JSON.stringify(all), updatedAt: nowSec() });
  });
  return { ok: true };
}

// ==============================
// 要対応タブ用
// ==============================
const TODO_MAX_FETCH = 100;

async function getTodoBundle(token, p) {
  const handled = p.handled || {};
  const baseline = Number(p.baseline) || 0;
  const rooms = slimRooms(await cw(token, "get", "/rooms"));

  let cands = rooms.filter(r => {
    const rid = String(r.room_id);
    const eff = Object.prototype.hasOwnProperty.call(handled, rid)
      ? Number(handled[rid]) || 0
      : (Number(r.unread_num || 0) > 0 ? 0 : baseline);
    return (r.last_update_time || 0) > eff;
  }).sort((a, b) => (b.last_update_time || 0) - (a.last_update_time || 0));

  const truncated = cands.length > TODO_MAX_FETCH;
  cands = cands.slice(0, TODO_MAX_FETCH);

  const [latest, myIds, later] = await Promise.all([
    fetchLatest(token, cands.map(r => String(r.room_id))), getMyIds(), getLater(p.account)
  ]);
  return { rooms, latest, my_ids: myIds, later, truncated };
}

// ==============================
// Chatwork → Firestore 同期（1分ごと）
// ==============================
const SYNC_FETCH_BUDGET = 25;
const SYNC_RECENT_DAYS = 14;
const SYNC_MSG_KEEP = 20;

// メッセージ本文を置くコレクション名（合言葉から作る推測できない名前。GASと同じ計算）
function msgCollection() {
  const hex = crypto.createHash("sha256").update((APP_SECRET.value() || "") + ":cwm", "utf8").digest("hex");
  return "cwm_" + hex.slice(0, 32);
}

// Firestoreに置くメッセージ本文（最新20件）
function slimMsgsForDoc(msgs) {
  return msgs.slice(-SYNC_MSG_KEEP).map(m => ({
    message_id: String(m.message_id),
    send_time: m.send_time || 0,
    body: String(m.body || "").slice(0, 5000),
    account: {
      account_id: String((m.account && m.account.account_id) || ""),
      name: (m.account && m.account.name) || "",
      avatar_image_url: (m.account && m.account.avatar_image_url) || ""
    }
  }));
}

// 編集・削除の直後に、そのルームの本文をFirestoreで更新（ほかのスタッフの画面にもすぐ反映）
async function refreshRoomMsgDoc(account, token, roomId) {
  try {
    const rid = safeRid(roomId);
    const got = await fetchMessages(token, rid);
    if (got.msgs === null) return;
    const last = got.msgs[got.msgs.length - 1];
    await db.collection(msgCollection()).doc(account + "_" + rid).set({
      account, roomId: rid, lastMsgId: last ? String(last.message_id) : "", messages: slimMsgsForDoc(got.msgs)
    }, { merge: true });
  } catch (e) {
    console.error("本文の更新に失敗: " + e.message);
  }
}

// 400件ずつまとめて書き込み
async function commitWrites(writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    writes.slice(i, i + 400).forEach(w => {
      if (w.del) batch.delete(w.ref);
      else if (w.merge) batch.set(w.ref, w.data, { merge: true });
      else batch.set(w.ref, w.data);
    });
    await batch.commit();
  }
}
const wPatch = (col, id, data) => ({ ref: db.collection(col).doc(id), data, merge: true });
const wSet = (col, id, data) => ({ ref: db.collection(col).doc(id), data });
const wDel = (col, id) => ({ ref: db.collection(col).doc(id), del: true });

// 同期の二重実行を防ぐ
//   サーバーは1台だけ（maxInstances: 1）にして、動いている間は次の回を休む。
//   以前は Firestore で鍵をかけていたが、毎分の読み込みが増えるのでやめた
let syncRunning = false;

exports.syncChatworkToFirestore = onSchedule(
  { schedule: "every 1 minutes", timeZone: "Asia/Tokyo", region: REGION, secrets: ALL_SECRETS, timeoutSeconds: 120, memory: "512MiB", retryCount: 0, maxInstances: 1, concurrency: 1 },
  async () => {
    if (syncRunning) return;
    syncRunning = true;
    try {
      const myIds = await getMyIds();
      const learn = await buildLearn();
      for (const acc of Object.keys(ACCOUNTS)) {
        const token = ACCOUNTS[acc].value();
        if (!token) continue;
        try {
          await syncAccount(acc, token, myIds, learn);
        } catch (e) {
          console.error(acc + ": " + e.message);
          try {
            await db.collection("cw_sync_status").doc(acc).set(
              { account: acc, lastErrorAt: nowSec(), lastError: String(e.message).slice(0, 300) }, { merge: true });
          } catch (e2) {}
        }
      }
    } finally {
      syncRunning = false;
    }
  }
);

// 直接返信をログに入れる対象と、社内ルーム
async function buildLearn() {
  const learn = { ids: await getLearnIds(), internal: [] };
  try {
    const cfg = await getAiConfig(600);   // 同期では10分キャッシュ（読み込み回数を抑える）
    learn.internal = String(cfg.internalRoomIds || "").split(/[,、\s]+/).filter(x => /^\d+$/.test(x));
    learn.questionRoomId = questionRoomOf(cfg);
  } catch (e) {}
  return learn;
}

// 🔄ボタン：今すぐChatworkを確認して Firestore に反映（画面は自動で更新される）
const lastSyncNow = {};
async function syncNow(account, token) {
  if (!ACCOUNTS[account]) throw new Error("アカウントの指定が正しくありません: " + account);
  const now = Date.now();
  if (lastSyncNow[account] && now - lastSyncNow[account] < 10000) return { skipped: true };   // 連打よけ（10秒）
  lastSyncNow[account] = now;
  await syncAccount(account, token, await getMyIds(), await buildLearn(), { freshState: true });
  return { synced: true, later: await getLater(account) };
}

// 同期の進み具合はサーバーのメモリに持ち、Firestoreは「起動直後に1回読む」「変わった時だけ書く」
//   （毎分 Firestore を読み書きしないので、読み込み回数が大きく減る）
const syncStateMem = {};
async function loadSyncState(key, fresh) {
  if (fresh || !syncStateMem[key]) {
    const obj = await loadJsonDoc(key, {});
    syncStateMem[key] = { obj, json: JSON.stringify(obj) };
  }
  return syncStateMem[key].obj;
}
async function saveSyncState(key, obj) {
  const json = JSON.stringify(obj);
  const cur = syncStateMem[key];
  if (cur && cur.json === json) return;   // 変化なし → 書かない
  await saveJsonDoc(key, obj);
  syncStateMem[key] = { obj, json };
}

const syncStatusMem = {};

// 自社かどうかの判定などを変えた時に上げる（上げると、最近のルームを1回だけ取り直す）
const SYNC_VER = 2;

async function syncAccount(acc, token, myIds, learn, opt = {}) {
  const ownerIds = await getOwnerIds();   // ラクロジスタッフ・松下のアカウント
  let meId = "";
  try { meId = await getMeId(acc, token); } catch (e) {}
  const msgCol = msgCollection();
  const stateKey = "sync_" + acc;
  const state = await loadSyncState(stateKey, opt.freshState);   // 🔄からの時は、定期同期と食い違わないよう Firestore から読む
  const rooms = slimRooms(await cw(token, "get", "/rooms"));
  const now = nowSec();
  const recent = now - SYNC_RECENT_DAYS * 86400;
  const writes = [];
  const need = [];
  const newState = {};
  const triageTargets = [];

  rooms.forEach(r => {
    const rid = String(r.room_id);
    const st = state[rid] || {};
    const lu = r.last_update_time || 0;
    const un = Number(r.unread_num || 0);
    newState[rid] = { u: lu, n: un, m: st.m || 0, v: st.v || 0 };
    if (st.tm) newState[rid].tm = st.tm;
    // 仕分けを入れる前から同期済みのルームも、1回だけ取り直して仕分ける（tm がまだないルーム）
    // 判定のしかたを変えた時（SYNC_VER を上げた時）も、1回だけ取り直す
    const stale = (lu > (st.m || 0) || !st.tm || st.v !== SYNC_VER) && (lu >= recent || un > 0);
    if (stale) need.push(r);
    if (st.u !== lu || st.n !== un || !state[rid]) {
      writes.push(wPatch("cw_rooms", acc + "_" + rid, { account: acc, roomId: rid, name: r.name || "", unread: un, lastUpdate: lu }));
    }
  });

  // 更新が新しいルームから順に、最新メッセージを確認
  need.sort((a, b) => (b.last_update_time || 0) - (a.last_update_time || 0));
  const batch = need.slice(0, SYNC_FETCH_BUDGET);
  await inChunks(batch, 25, async r => {
    const rid = String(r.room_id);
    const got = await fetchMessages(token, rid);
    if (got.msgs === null) return; // 取得失敗は次回に持ち越し
    const msgs = got.msgs;

    // 渡辺さんへの質問ルームなら、届いた回答を質問リストに反映
    if (learn && learn.questionRoomId === rid) {
      try { await detectAnswers(rid, msgs); } catch (e) { console.error("回答の読み取りに失敗: " + e.message); }
    }

    // Chatworkで直接送った返信をAI添削ログへ（社内ルームは除く。前回確認した時より後の返信だけ。
    //   コックピットから送った文は、送信時の目印と一致するので除く）
    if (learn && learn.ids.length && learn.internal.indexOf(rid) === -1) {
      const pairs = pickReplyPairs(msgs, learn.ids, myIds, (state[rid] && state[rid].m) || 0);
      if (pairs.length) {
        let marks = [];
        try {
          const ms = await db.collection("cw_sent_marks").doc(rid).get();
          if (ms.exists && Array.isArray(ms.get("marks"))) marks = ms.get("marks");
        } catch (e) {}
        pairs.forEach(pr => {
          if (marks.indexOf(textMark(pr.data.replyText)) !== -1) return;
          writes.push(wSet("ai_brushup_feedback", "cw_" + pr.id, toFeedbackLog(acc, rid, r.name, pr)));
        });
      }
    }

    const meta = { msgUpdate: r.last_update_time || 0, lastMsgId: "", lastMsgTime: 0, lastMine: false, custTimes: [] };
    // 社内ルーム（渡辺さんとのルームなど）では、渡辺さんなど STAFF_ACCOUNT_IDS の人の発言は「相手からの連絡」として扱う
    //   （自社扱いにすると、渡辺さんからの連絡が要対応に出なくなるため）
    const mineIds = (learn && learn.internal.indexOf(rid) !== -1) ? ownerIds : myIds;
    // 自社の人の発言でも、このアカウント宛ての依頼（[To:]・返信・タスク）は「相手からの連絡」として扱う
    const isMineMsg = m => mineIds.indexOf(String(m.account && m.account.account_id)) !== -1 && !isRequestToMe(m, meId);
    if (msgs.length) {
      const last = msgs[msgs.length - 1];
      let lastMineIdx = -1;
      msgs.forEach((m, idx) => { if (isMineMsg(m)) lastMineIdx = idx; });
      meta.lastMsgId = String(last.message_id);
      meta.lastMsgTime = last.send_time || 0;
      meta.lastMine = lastMineIdx === msgs.length - 1;
      meta.custTimes = msgs.slice(lastMineIdx + 1).map(m => m.send_time || 0).slice(0, 20);
    }
    const msgDoc = {
      account: acc, roomId: rid, lastMsgId: meta.lastMsgId, msgUpdate: meta.msgUpdate,
      messages: slimMsgsForDoc(msgs)
    };
    // 仕分け：最後がお客様の発言で、まだ判定していないメッセージなら判定する
    const st = state[rid] || {};
    if (msgs.length && !meta.lastMine) {
      if (String(st.tm || "") === meta.lastMsgId) {
        newState[rid].tm = st.tm;   // 判定済み（前回の結果がFirestoreに残っている）
      } else {
        triageTargets.push({ rid, name: r.name || "", msgs, mineIds, meId, isMineMsg, meta, msgDoc, prevM: st.m || 0 });
      }
    } else {
      meta.triage = "";
      meta.triageSub = "";
      meta.triageFixed = false;
      meta.triageFor = "";
      newState[rid].tm = meta.lastMsgId || "empty";   // 判定不要（最後が自社・メッセージなし）
    }
    writes.push(wPatch("cw_rooms", acc + "_" + rid, meta));
    writes.push(wPatch(msgCol, acc + "_" + rid, msgDoc));   // 上書きではなく追記（判定済みの用件メモを消さないため）
    newState[rid].m = r.last_update_time || 0;
    newState[rid].v = SYNC_VER;
  });

  // 仕分け（AI）。失敗したルームは「未取得」に戻して、次の同期でもう一度判定する
  if (triageTargets.length) {
    const results = await triageRooms(triageTargets);
    triageTargets.forEach(t => {
      const res = results[t.rid];
      if (res) {
        t.meta.triage = res.cat;
        t.meta.triageSub = res.sub;
        t.meta.triageFixed = false;
        t.meta.triageFor = t.meta.lastMsgId;
        t.msgDoc.triagePoint = res.point;
        t.msgDoc.triageFor = t.meta.lastMsgId;
        newState[t.rid].tm = t.meta.lastMsgId;
      } else {
        newState[t.rid].m = t.prevM;
      }
    });
  }

  // 退出・削除されたルームはFirestoreからも消す
  Object.keys(state).forEach(rid => {
    if (!newState[rid]) {
      writes.push(wDel("cw_rooms", acc + "_" + rid));
      writes.push(wDel(msgCol, acc + "_" + rid));
    }
  });

  // 動作確認用の記録は、変化があった時か10分に1回だけ書く（毎分の書き込みを減らす）
  const pending = Math.max(0, need.length - batch.length);
  const statusKey = rooms.length + "_" + pending;
  const lastStatus = syncStatusMem[acc] || {};
  if (writes.length || lastStatus.key !== statusKey || now - (lastStatus.at || 0) >= 600) {
    writes.push(wPatch("cw_sync_status", acc, { account: acc, lastRunAt: now, rooms: rooms.length, pending, lastError: "" }));
    syncStatusMem[acc] = { key: statusKey, at: now };
  }
  await commitWrites(writes);
  await saveSyncState(stateKey, newState);

}

// ==============================
// 返信先のメッセージ（どのメッセージへの返信か）を取ってくる。1回20件まで
// ==============================
async function getReplyRefs(token, refs) {
  const list = (Array.isArray(refs) ? refs : []).slice(0, 20).map(r => ({
    rid: String((r && r.room_id) || "").replace(/[^0-9]/g, ""),
    mid: String((r && r.message_id) || "").replace(/[^0-9]/g, "")
  })).filter(r => r.rid && r.mid);
  const out = {};
  await inChunks(list, 5, async r => {
    const key = r.rid + "-" + r.mid;
    try {
      const m = await cw(token, "get", "/rooms/" + r.rid + "/messages/" + r.mid);
      out[key] = {
        name: (m && m.account && m.account.name) || "",
        body: stripTags(m && m.body).slice(0, 300),
        time: (m && m.send_time) || 0
      };
    } catch (e) {
      out[key] = { error: "返信先のメッセージが見つかりませんでした（削除されたか、別のルームのメッセージです）" };
    }
  });
  return { refs: out };
}

// ==============================
// 送り状の記録（shipments）
//   コックピットの「🚚 送り状」タブに、ヤマトB2・佐川e飛伝の発行済みCSVをドラッグして取り込む
//   shipments/{yamato|sagawa}_{追跡番号}：追跡番号・配送会社・出荷日・お届け先名・注文番号・品名、検索用の keys
//   住所・電話番号は保存しない
// ==============================
const SHIP_CARRIERS = { yamato: "ヤマト運輸", sagawa: "佐川急便" };

// 検索用にそろえる（全角→半角・大文字・空白とハイフンを除く）
function shipNorm(s) {
  return String(s || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\u3000\-‐－−ー―]/g, "")
    .toUpperCase();
}
function shipNormName(s) {
  return String(s || "").replace(/[\s\u3000]/g, "").replace(/(様|殿|御中)$/, "");
}

function shipKeys(r) {
  const keys = new Set();
  const add = k => { k = String(k || ""); if (k.length >= 4 && k.length <= 60) keys.add(k); };
  add(shipNorm(r.tracking));
  add(shipNorm(r.orderNo));
  add(shipNormName(r.name));
  (r.texts || []).forEach(t => {
    const s = String(t || "");
    // (No.10266,10267) の No.
    const m = s.match(/No\.?\s*([\d,，、\s]+)/i);
    if (m) m[1].split(/[,，、\s]+/).filter(Boolean).forEach(n => add(String(Number(n))));
    // 注文番号らしい英数字（5文字以上）
    (s.match(/[A-Za-z0-9Ａ-Ｚａ-ｚ０-９][A-Za-z0-9Ａ-Ｚａ-ｚ０-９\-‐－_]{4,}/g) || []).forEach(x => add(shipNorm(x)));
  });
  return Array.from(keys).slice(0, 30);
}

async function saveShipments(p) {
  const rows = Array.isArray(p.rows) ? p.rows : [];
  if (!rows.length) throw new Error("取り込む行がありません");
  if (rows.length > 500) throw new Error("1回に送れるのは500行までです");
  const writes = [];
  rows.forEach(r => {
    const carrier = SHIP_CARRIERS[r.carrier] ? r.carrier : "";
    const tracking = String(r.tracking || "").replace(/[^0-9]/g, "");
    if (!carrier || tracking.length < 10 || tracking.length > 14) return;
    const texts = (Array.isArray(r.texts) ? r.texts : []).map(t => String(t || "").trim()).filter(Boolean).slice(0, 8);
    const data = {
      carrier, carrierName: SHIP_CARRIERS[carrier], tracking,
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || "")) ? r.date : "",
      name: String(r.name || "").trim().slice(0, 60),
      orderNo: String(r.orderNo || "").trim().slice(0, 60),
      items: texts.join(" / ").slice(0, 300),
      file: String(r.file || "").slice(0, 100),
      importedAt: nowSec()
    };
    data.keys = shipKeys({ tracking, orderNo: data.orderNo, name: data.name, texts });
    writes.push(wPatch("shipments", carrier + "_" + tracking, data));
  });
  await commitWrites(writes);
  return { saved: writes.length, skipped: rows.length - writes.length };
}

async function findShipments(q) {
  const raw = String(q || "").trim();
  if (!raw) throw new Error("番号か名前を入力してください");
  const cands = Array.from(new Set([shipNorm(raw), shipNormName(raw)])).filter(k => k.length >= 4);
  // 5〜6桁の No. は先頭の0を外した形でも探す
  if (/^\d{5,6}$/.test(shipNorm(raw))) cands.push(String(Number(shipNorm(raw))));
  if (!cands.length) throw new Error("4文字以上で入力してください");
  const found = {};
  for (const k of Array.from(new Set(cands)).slice(0, 3)) {
    const snap = await db.collection("shipments").where("keys", "array-contains", k).limit(30).get();
    snap.forEach(d => {
      const x = d.data();
      found[d.id] = { carrier: x.carrier, carrierName: x.carrierName, tracking: x.tracking, date: x.date, name: x.name, orderNo: x.orderNo, items: x.items };
    });
  }
  const list = Object.values(found).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 30);
  return { shipments: list };
}

// ==============================
// USアプリ（配送管理アプリ）への出荷依頼
//   チャットのNo.をUSアプリの「コックピットからの依頼」に届ける。USアプリでタップするとそのNo.で検索できる
//   同じルーム・同じNo.の組み合わせで未完了の依頼があれば、新しく作らない
// ==============================
async function createUsRequest(p) {
  const clientId = String(process.env.US_CLIENT_ID || "150").replace(/[^0-9a-zA-Z_-]/g, "") || "150";
  const nos = Array.from(new Set((Array.isArray(p.nos) ? p.nos : String(p.nos || "").split(/[\s,、，]+/))
    .map(x => String(x).replace(/[^0-9]/g, "")).filter(x => x.length >= 1 && x.length <= 7).map(x => String(Number(x)))))
    .filter(x => x !== "0");
  if (!nos.length) throw new Error("No.を入力してください");
  if (nos.length > 100) throw new Error("一度に送れるNo.は100件までです");
  const rid = String(p.room_id || "").replace(/[^0-9]/g, "");
  const sorted = nos.slice().sort((a, b) => Number(a) - Number(b));
  const id = crypto.createHash("sha1").update(rid + ":" + sorted.join(","), "utf8").digest("hex").slice(0, 20);
  const ref = db.collection("deliveryClients").doc(clientId).collection("cockpitRequests").doc(id);
  const snap = await ref.get();
  if (snap.exists && snap.get("status") === "open") return { existed: true, nos: sorted, id };
  await ref.set({
    nos: sorted, status: "open",
    roomId: rid, roomName: String(p.room_name || "").slice(0, 100),
    text: String(p.text || "").slice(0, 1000), memo: String(p.memo || "").slice(0, 500),
    account: String(p.account || ""), by: String(p.by || "").slice(0, 40),
    createdAt: admin.firestore.FieldValue.serverTimestamp(), createdAtSec: nowSec(),
    doneAt: null, doneBy: ""
  });
  return { existed: false, nos: sorted, id };
}

// ==============================
// 渡辺さんへの質問リスト
//   ① カードの「👤 渡辺さんに聞く」→ 質問ルーム（社内ルーム）に投稿し、同じルームに渡辺さん担当のタスクも作る。
//      cw_questions/Q{番号} に保存（taskId も）。ルームは「後で対応」へ
//   ② 渡辺さんがChatworkで質問メッセージに「返信（↩）」して答える → 同期のときに読み取って「回答済み」に
//      → ルームを「後で対応」から外し、要対応に戻す（カードに回答が表示される）
//      → タスクも自動で完了にする（取り下げた時も完了にする）
//   ③ 回答済みのQ&Aは cw_server/qa_recent（最新40件）にもためて、AI返信作成の参考に渡す
//   カードの表示用に、ルームの最新の質問を cw_rooms/{アカウント}_{ルームID} の question にも入れる
// ==============================
const QA_KEEP = 40;

function questionRoomOf(cfg) {
  const q = String(cfg.questionRoomId || "").replace(/[^0-9]/g, "");
  if (q) return q;
  return String(cfg.internalRoomIds || "").split(/[,、\s]+/).filter(x => /^\d+$/.test(x))[0] || "";
}

async function nextQuestionNo() {
  const ref = db.collection("cw_server").doc("question_seq");
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const n = (snap.exists ? Number(snap.get("n")) || 0 : 0) + 1;
    tx.set(ref, { n, updatedAt: nowSec() });
    return n;
  });
}

async function askQuestion(token, p) {
  const rid = safeRid(p.room_id);
  const cfg = await getAiConfig();
  const qRoom = questionRoomOf(cfg);
  if (!qRoom) throw new Error("質問を送る社内ルームが設定されていません（⚙️で設定できます）");
  const roomName = String(p.room_name || "").slice(0, 80);
  const context = String(p.context || "").slice(0, 3000);
  const by = String(p.by || "").slice(0, 40);
  let question = String(p.note || "").trim().slice(0, 1000);

  if (!question) {
    if (!context) throw new Error("聞きたいことを入力してください");
    question = (await callAI(
      "以下は、物流倉庫（自社）とお客様のチャットです。スタッフが返信する前に、責任者の渡辺さんに確認したいことを、"
      + "渡辺さんへの質問として1〜2文でまとめてください。社内向けなので挨拶や敬語の飾りは不要です。"
      + "チャットに書かれていないことは足さないでください。質問文だけを出力してください。\n\n"
      + "【ルーム】" + roomName + "\n【チャット（古い順。【自社】は自社の発言）】\n" + context,
      { timeoutMs: 40000 }
    )).slice(0, 500);
  }

  const no = await nextQuestionNo();
  const label = "Q-" + no;
  // お客様の最後の発言（カードの文から【自社】以外の最後の1件）
  const lines = context.split(/\n{2,}/).filter(s => s.trim());
  const lastCust = lines.slice().reverse().find(s => s.indexOf("【自社】") !== 0) || "";
  const toLine = cfg.questionToId ? "[To:" + String(cfg.questionToId).replace(/[^0-9]/g, "") + "]\n" : "";
  const body = toLine
    + "[info][title]❓ " + label + "　" + roomName + "[/title]"
    + (lastCust ? "【お客様】" + lastCust.slice(0, 300) + "\n\n" : "")
    + "【聞きたいこと】" + question
    + (by ? "\n（質問：" + by + "）" : "")
    + "[/info]"
    + "このメッセージに「返信」して答えてください（返信するとタスクも自動で完了します）";

  // 質問ルームのメンバーでないアカウント（松下アカウントなど）から聞いた時は、メンバーのアカウントで送る
  //   回答が届いたら、聞いたアカウント側のカードに戻す（p.account で記録）
  let posted = null, lastErr = null, postedBy = "";
  const order = [p.account].concat(Object.keys(ACCOUNTS).filter(a => a !== p.account));
  for (const acc of order) {
    try {
      const tk = acc === p.account ? token : getChatworkToken(acc);
      posted = await cw(tk, "post", "/rooms/" + qRoom + "/messages", { body, self_unread: "0" });
      postedBy = acc;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!posted) throw new Error("質問ルームに送れませんでした（どのアカウントもそのルームのメンバーでない可能性があります）：" + (lastErr ? lastErr.message : ""));

  // 渡辺さん担当のタスクを作る（宛先のアカウントIDが設定されている時だけ。失敗しても質問は送れているので止めない）
  let taskId = "", taskError = "";
  const toId = String(cfg.questionToId || "").replace(/[^0-9]/g, "");
  if (toId) {
    try {
      const taskBody = label + "　" + roomName + "\n" + question.slice(0, 300)
        + "\n（社内ルームの質問メッセージに返信してください。返信すると自動で完了します）";
      const tk = postedBy === p.account ? token : getChatworkToken(postedBy);
      const t = await cw(tk, "post", "/rooms/" + qRoom + "/tasks", { body: taskBody, to_ids: toId, limit_type: "none" });
      taskId = String((t && Array.isArray(t.task_ids) && t.task_ids[0]) || "");
    } catch (e) {
      taskError = e.message;
      console.error("質問タスクを作れませんでした: " + e.message);
    }
  }

  const now = nowSec();
  const data = {
    no, label, status: "open", account: p.account, roomId: rid, roomName,
    question, customerText: lastCust.slice(0, 500), askedBy: by, askedAt: now,
    questionRoomId: qRoom, cwMessageId: String((posted && posted.message_id) || ""), postedBy,
    taskId, taskDone: false,
    answer: "", answeredBy: "", answeredAt: 0
  };
  await db.collection("cw_questions").doc("Q" + no).set(data);
  await db.collection("cw_rooms").doc(p.account + "_" + rid).set({ question: roomQuestion(data) }, { merge: true });
  const later = await setLater(p.account, [rid], true);
  return { no, label, question, later, taskId, taskError };
}

// 質問タスクを完了にする
//   タスクを作ったアカウント（依頼者）で完了にし、だめならほかのアカウントでも試す。
//   失敗しても回答の処理は止めない（失敗した理由は cw_questions の taskError に残す）
async function completeQuestionTask(id, q) {
  if (!q || !q.taskId || q.taskDone) return;
  const tokens = [];
  const order = [q.postedBy].concat(Object.keys(ACCOUNTS).filter(a => a !== q.postedBy));
  order.forEach(a => { try { if (a && ACCOUNTS[a]) tokens.push(getChatworkToken(a)); } catch (e) {} });
  let lastErr = null;
  for (const tk of tokens) {
    try {
      await cw(tk, "put", "/rooms/" + q.questionRoomId + "/tasks/" + q.taskId + "/status", { body_status: "done" });
      await db.collection("cw_questions").doc(id).set({ taskDone: true, taskDoneAt: nowSec() }, { merge: true });
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  const msg = lastErr ? lastErr.message : "トークンがありません";
  console.error("質問タスク（" + (q.label || id) + "）を完了にできませんでした: " + msg);
  try { await db.collection("cw_questions").doc(id).set({ taskError: msg.slice(0, 300) }, { merge: true }); } catch (e) {}
}

// カード表示用（cw_rooms に入れる分）
function roomQuestion(q) {
  return {
    no: q.no, label: q.label, status: q.status, question: String(q.question || "").slice(0, 300),
    answer: String(q.answer || "").slice(0, 1000), answeredBy: q.answeredBy || "", askedBy: q.askedBy || "",
    askedAt: q.askedAt || 0, answeredAt: q.answeredAt || 0
  };
}

// 質問ルームのメッセージから回答を探す
async function detectAnswers(qRoomId, msgs) {
  const snap = await db.collection("cw_questions").where("status", "==", "open").get();
  if (snap.empty) return;
  const open = [];
  snap.forEach(d => { const q = d.data(); if (q.questionRoomId === qRoomId) open.push({ id: d.id, q }); });
  if (!open.length) return;

  for (const { id, q } of open) {
    const hit = msgs.find(m => {
      const mid = String(m.message_id);
      const body = String(m.body || "");
      if (mid === q.cwMessageId || (m.send_time || 0) < (q.askedAt || 0)) return false;
      if (body.indexOf("[info][title]❓") !== -1) return false;   // ほかの質問の投稿
      // 質問メッセージへの「返信（↩）」だけを回答として扱う
      return !!(q.cwMessageId && body.indexOf("-" + q.cwMessageId + "]") !== -1 && /\[rp aid=\d+ to=\d+-\d+\]/.test(body));
    });
    if (!hit) continue;
    const answer = stripTags(String(hit.body).replace(/\[rp aid=\d+ to=\d+-\d+\][^\n]*\n?/, "")).trim().slice(0, 2000);
    const done = Object.assign({}, q, {
      status: "answered", answer: answer || "（本文なし）",
      answeredBy: (hit.account && hit.account.name) || "", answeredAt: hit.send_time || nowSec(),
      answerMessageId: String(hit.message_id)
    });
    // 二重に処理しないよう、まだ open の時だけ更新
    const ok = await db.runTransaction(async tx => {
      const ref = db.collection("cw_questions").doc(id);
      const cur = await tx.get(ref);
      if (!cur.exists || cur.get("status") !== "open") return false;
      tx.set(ref, done);
      return true;
    });
    if (!ok) continue;
    await completeQuestionTask(id, q);
    await db.collection("cw_rooms").doc(q.account + "_" + q.roomId).set({ question: roomQuestion(done) }, { merge: true });
    try { await setLater(q.account, [q.roomId], false); } catch (e) {}
    // 要対応に戻す（「未対応に戻す」と同じ）
    await db.collection("cw_handled").doc(q.account + "_" + q.roomId).set({
      account: q.account, roomId: q.roomId, handledAt: 0, reopen: true, by: "渡辺さん回答", auto: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await db.collection("cw_handled_log").add({
      account: q.account, roomId: q.roomId, roomName: q.roomName || "", action: "reopen", by: "渡辺さん回答 " + q.label,
      at: admin.firestore.FieldValue.serverTimestamp()
    });
    // Q&Aの蓄積（AI返信の参考用）
    const ref = db.collection("cw_server").doc("qa_recent");
    await db.runTransaction(async tx => {
      const s2 = await tx.get(ref);
      let list = [];
      try { list = JSON.parse((s2.exists && s2.get("json")) || "[]") || []; } catch (e) {}
      list = [{ no: q.no, roomId: q.roomId, roomName: q.roomName || "", q: String(q.question).slice(0, 300), a: done.answer.slice(0, 600), at: done.answeredAt }]
        .concat(list.filter(x => x.no !== q.no)).slice(0, QA_KEEP);
      tx.set(ref, { json: JSON.stringify(list), updatedAt: nowSec() });
    });
    cacheRemove("qa_recent");
  }
}

// 対応済み・送信して完了の時：回答済みの質問はカードから外す（質問リストには残る）
async function clearAnsweredQuestion(account, roomId) {
  try {
    const rid = String(roomId || "").replace(/[^0-9]/g, "");
    if (!rid || !ACCOUNTS[account]) return;
    const ref = db.collection("cw_rooms").doc(account + "_" + rid);
    const snap = await ref.get();
    const q = snap.exists ? snap.get("question") : null;
    if (q && q.status === "answered") await ref.set({ question: null }, { merge: true });
  } catch (e) {
    console.error("質問の表示を外せませんでした: " + e.message);
  }
}

// 質問リスト画面用
async function getQuestions() {
  const snap = await db.collection("cw_questions").where("status", "==", "open").get();
  const open = [];
  snap.forEach(d => {
    const q = d.data();
    open.push({ no: q.no, label: q.label, account: q.account, roomId: q.roomId, roomName: q.roomName, question: q.question, customerText: q.customerText, askedBy: q.askedBy, askedAt: q.askedAt });
  });
  open.sort((a, b) => a.askedAt - b.askedAt);
  return { open, answered: await loadQaRecent() };
}

// 質問の取り下げ（未回答の質問をやめる時）
async function closeQuestion(account, roomId, no) {
  const n = Number(no) || 0;
  if (!n) throw new Error("質問の番号がありません");
  const ref = db.collection("cw_questions").doc("Q" + n);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("質問が見つかりません");
  const q = snap.data();
  if (q.status === "open") await ref.set({ status: "cancelled", cancelledAt: nowSec() }, { merge: true });
  await completeQuestionTask("Q" + n, q);   // ChatworkのAPIではタスクを消せないので、完了にしておく
  await db.collection("cw_rooms").doc(q.account + "_" + q.roomId).set({ question: null }, { merge: true });
  return { ok: true };
}

async function loadQaRecent() {
  const hit = cacheGet("qa_recent");
  if (hit) return hit;
  const list = await loadJsonDoc("qa_recent", []);
  const out = Array.isArray(list) ? list : [];
  cachePut("qa_recent", out, 60);
  return out;
}

// AI返信に渡すQ&A（同じルームのものを先に、全体で最大15件）
async function qaForPrompt(roomId) {
  try {
    const rid = String(roomId || "").replace(/[^0-9]/g, "");
    const list = await loadQaRecent();
    if (!list.length) return "";
    const same = list.filter(x => String(x.roomId) === rid);
    const other = list.filter(x => String(x.roomId) !== rid);
    return same.concat(other).slice(0, 15).map(x =>
      "Q（" + (String(x.roomId) === rid ? "このルーム" : "別のルーム") + "）：" + x.q + "\nA：" + x.a
    ).join("\n\n");
  } catch (e) {
    return "";
  }
}

// ==============================
// 要対応の仕分け（同期のときに、新しく届いたお客様の連絡をAIが3つに分ける）
//   none  … 返信不要（お礼・了解だけなど）→ まとめて対応済みにできる
//   easy  … 調べなくても返せる
//   check … 返信の前に確認が必要
//   迷ったときは check にする（返信が必要な連絡を「返信不要」にしないため）
// ==============================
const TRIAGE_PER_CALL = 5;           // 1回のAI呼び出しで判定するルーム数（少ないほど1件ずつ丁寧に読む）
const TRIAGE_MSGS = 10;              // 1ルームあたりAIに渡す直近のメッセージ数
const TRIAGE_CHARS = 600;            // 1メッセージあたりAIに渡す文字数
const TRIAGE_FIX_EXAMPLES = 30;      // 手で直した仕分けを、お手本として何件渡すか
const TRIAGE_CATS = ["none", "easy", "check"];
// 要確認（check）の2次仕分け
const TRIAGE_SUBS = ["order", "ship", "bill", "trouble", "system", "other"];

async function triageRooms(targets) {
  const out = {};
  const examples = await loadTriageExamples();
  const chunks = [];
  for (let i = 0; i < targets.length; i += TRIAGE_PER_CALL) chunks.push(targets.slice(i, i + TRIAGE_PER_CALL));
  await Promise.all(chunks.map(async list => {
    try {
      Object.assign(out, await triageChunk(list, examples));
    } catch (e) {
      console.error("仕分けに失敗（次の同期でやり直します）: " + e.message);
    }
  }));
  return out;
}

// 手で直した仕分け（cw_triage_fixes）を、AIへのお手本として読む
async function loadTriageExamples() {
  try {
    const qs = await db.collection("cw_triage_fixes").orderBy("at", "desc").limit(TRIAGE_FIX_EXAMPLES).get();
    const lines = [];
    qs.forEach(d => {
      const x = d.data();
      const text = String(x.text || "").replace(/\s+/g, " ").trim().slice(0, 160);
      if (!text || TRIAGE_CATS.indexOf(x.cat) === -1) return;
      lines.push("・「" + text + "」→ " + x.cat + (x.cat === "check" && x.sub ? "（" + x.sub + "）" : "")
        + (x.before ? "　※AIは " + x.before + (x.beforeSub ? "（" + x.beforeSub + "）" : "") + " と誤判定" : ""));
    });
    return lines.join("\n");
  } catch (e) {
    console.error("仕分けのお手本を読めませんでした: " + e.message);
    return "";
  }
}

// 画面で仕分けを直した時：cw_rooms を直して、お手本として記録する
async function fixTriage(p) {
  const acc = String(p.account || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const rid = String(p.room_id || "").replace(/[^0-9]/g, "");
  const cat = String(p.cat || "");
  let sub = String(p.sub || "");
  if (!acc || !rid || TRIAGE_CATS.indexOf(cat) === -1) throw new Error("仕分けの指定が正しくありません");
  if (cat !== "check") sub = "";
  else if (TRIAGE_SUBS.indexOf(sub) === -1) sub = "other";
  const ref = db.collection("cw_rooms").doc(acc + "_" + rid);
  const snap = await ref.get();
  const cur = snap.exists ? snap.data() : {};
  await ref.set({ triage: cat, triageSub: sub, triageFixed: true }, { merge: true });
  await db.collection("cw_triage_fixes").add({
    account: acc, roomId: rid, roomName: String(p.room_name || cur.name || "").slice(0, 80),
    text: String(p.text || "").slice(0, 600),
    cat, sub, before: String(cur.triage || ""), beforeSub: String(cur.triageSub || ""),
    msgId: String(cur.lastMsgId || ""), by: String(p.by || "").slice(0, 40),
    at: admin.firestore.FieldValue.serverTimestamp()
  });
  return { ok: true };
}

async function triageChunk(list, examples) {
  const fmt = t => new Date((t || 0) * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const blocks = list.map(t => {
    const msgs = t.msgs.slice(-TRIAGE_MSGS);
    const isMine = t.isMineMsg || (m => t.mineIds.indexOf(String(m.account && m.account.account_id)) !== -1);
    let lastMineIdx = -1;
    msgs.forEach((m, i) => { if (isMine(m)) lastMineIdx = i; });
    const lines = msgs.map((m, i) => {
      const mine = isMine(m);
      const body = String(m.body || "");
      // 宛先のしるし（[To:]・返信）から、だれ宛てかを書き添える
      let to = "";
      if (!mine) {
        if (t.meId && (body.indexOf("[To:" + t.meId + "]") !== -1 || body.indexOf("[rp aid=" + t.meId + " ") !== -1)) to = "（宛先：自社）";
        else if (/\[toall\]/i.test(body)) to = "（宛先：全員）";
        else if (/\[To:\d+\]|\[rp aid=\d+ /.test(body)) to = "（宛先：自社以外の人）";
      }
      const tag = mine ? "【自社】" : (i > lastMineIdx ? "【未返信】" : "");
      return "[" + fmt(m.send_time) + "] " + tag + ((m.account && m.account.name) || "") + to + "：" + stripTags(body).slice(0, TRIAGE_CHARS);
    }).join("\n");
    return "■ルームID:" + t.rid + "（" + t.name.slice(0, 40) + "）\n" + lines;
  }).join("\n\n");

  const system = "あなたは物流倉庫（発送代行）のカスタマーサポートで、届いたチャットを仕分ける担当です。"
    + "各ルームの【未返信】の発言（自社が最後に発言した後に届いた、相手の発言すべて）をまとめて読み、こちらが何をすべきかを判定します。"
    + "最後の1件だけで判断しないこと（例：質問の後に「よろしくお願いします」が来ていても、質問が残っていれば返信が必要）。\n\n"
    + "【分類】\n"
    + "none：返信しなくてよい。次のどれかに当てはまる\n"
    + "　・【未返信】がすべて、お礼・了解・承知・挨拶・スタンプだけ、こちらの連絡への「確認しました」だけ\n"
    + "　・自社以外の人どうしのやり取りで、自社に何も求めていない（宛先：自社以外の人 で、自社への依頼がない）\n"
    + "　・システムの自動通知、定型のお知らせ、全員向けの周知で、自社がすることがない\n"
    + "　【未返信】に質問・依頼・報告・相談・期限のある連絡が1つでも含まれていれば none にしない\n"
    + "easy：倉庫や社内で調べなくても返信できる。受け取りのお礼、日程の承諾、決まっている手順の案内など（出荷・発送の依頼は easy にしない）\n"
    + "check：返信の前に確認や判断が必要。出荷・発送の依頼、在庫・入荷・出荷状況・追跡番号・料金・請求・破損・誤出荷・現物の確認、社内での相談が必要なもの\n"
    + "迷ったときは check にする。\n\n"
    + "【sub】check のときだけ、確認の種類を1つ選ぶ（check 以外は空文字）\n"
    + "order：出荷・発送の依頼（No.や注文番号を挙げて「出荷してください」「発送お願いします」、再発送・追加発送の依頼など）\n"
    + "ship：すでに出した荷物についての、出荷状況・発送日・追跡番号・配送状況・届かない（未着）の問い合わせ\n"
    + "bill：請求・料金・見積・支払い・請求書の問い合わせ\n"
    + "trouble：破損・誤出荷・数量違い・紛失・返品・クレームなどのトラブル\n"
    + "system：システム・ツール・ログイン・API・ショップとの連携・設定などの問い合わせ\n"
    + "other：上のどれにも当てはまらないもの（在庫・入荷の確認、相談など）\n"
    + "複数に当てはまるときは trouble ＞ order ＞ bill ＞ ship ＞ system の順で優先する。\n\n"
    + "【point】相手が求めていることを40文字以内で。check のときは、確認すべきことを入れる（例：「入荷予定日の確認。在庫数を確認して回答」）。none のときは空でよい。\n\n"
    + "【出力】次のJSONだけを返す\n"
    + "{\"rooms\": [{\"id\": \"ルームID\", \"cat\": \"none|easy|check\", \"sub\": \"order|ship|bill|trouble|system|other|\", \"point\": \"...\"}]}";

  const sys = system + (examples ? "\n\n【お手本：以前スタッフが手で直した仕分け（同じような連絡は同じように分ける）】\n" + examples : "");
  const text = await callAI("次のルームを仕分けてください。\n\n" + blocks, { system: sys, json: true, timeoutMs: 60000, tries: 2 });
  let data;
  try { data = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch (e) { throw new Error("仕分け結果を読み取れませんでした"); }
  const ids = new Set(list.map(t => t.rid));
  const res = {};
  (Array.isArray(data.rooms) ? data.rooms : []).forEach(x => {
    const id = String((x && x.id) || "").replace(/[^0-9]/g, "");
    const cat = String((x && x.cat) || "").trim();
    if (!ids.has(id) || TRIAGE_CATS.indexOf(cat) === -1) return;
    let sub = String((x && x.sub) || "").trim();
    if (cat !== "check") sub = "";
    else if (TRIAGE_SUBS.indexOf(sub) === -1) sub = "other";
    res[id] = { cat, sub, point: String(x.point || "").replace(/\s+/g, " ").trim().slice(0, 60) };
  });
  return res;
}

// ==============================
// 合言葉ログイン（Firestoreの通行証を発行）
//   ※ Cloud Functions のサービスアカウントに「サービス アカウント トークン作成者」の権限が必要
// ==============================
async function getFirebaseToken(p) {
  const gen = Number(process.env.AUTH_GEN || 1);
  const dev = String(p.device_id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
  const token = await admin.auth().createCustomToken("cockpit_" + dev, { cockpit: true, gen });
  return { token, gen };
}

// 返送タスクアプリ（henso.html）用
exports.henso = require("./henso").henso;


// ==============================
// 分割くん（bunkatuedaban.html）：元のパッキングリストをChatworkへ送る
// ラクロジスタッフのアカウントから、決まったグループへ武田さん宛で投稿
// ==============================
const PACKING_LIST_ROOM_ID = "442684516";
const PACKING_LIST_TO_LINE = "[To:7964085]武田さん";
const PACKING_LIST_MAX_BYTES = 5 * 1024 * 1024; // Chatworkの上限 5MB
const PACKING_LIST_EXT = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv"
};

exports.sendPackingListToChatwork = onCall(
  { region: REGION, secrets: [CW_TOKEN_STAFF], memory: "256MiB", timeoutSeconds: 60 },
  async (request) => {
    const { fileName, fileBase64, message } = request.data || {};

    if (typeof fileName !== "string" || typeof fileBase64 !== "string") {
      throw new HttpsError("invalid-argument", "ファイルが届いていません");
    }
    const safeName = fileName.replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);
    const ext = (safeName.split(".").pop() || "").toLowerCase();
    if (!PACKING_LIST_EXT[ext]) {
      throw new HttpsError("invalid-argument", "Excel（xlsx/xls）かCSVだけ送れます");
    }
    const buf = Buffer.from(fileBase64, "base64");
    if (buf.length === 0) throw new HttpsError("invalid-argument", "ファイルが空です");
    if (buf.length > PACKING_LIST_MAX_BYTES) {
      throw new HttpsError("invalid-argument", "5MBを超えているため送れません");
    }
    const body = typeof message === "string" ? message.slice(0, 1000) : "";
    const text = body ? `${PACKING_LIST_TO_LINE}\n${body}` : PACKING_LIST_TO_LINE;

    const form = new FormData();
    form.append("file", new Blob([buf], { type: PACKING_LIST_EXT[ext] }), safeName);
    form.append("message", text);

    const res = await fetch(`https://api.chatwork.com/v2/rooms/${PACKING_LIST_ROOM_ID}/files`, {
      method: "POST",
      headers: { "X-ChatWorkToken": CW_TOKEN_STAFF.value() },
      body: form
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("Chatwork upload failed", res.status, detail);
      throw new HttpsError("internal", `Chatworkへの送信に失敗しました（${res.status}）`);
    }
    const json = await res.json().catch(() => ({}));
    return { ok: true, fileId: json.file_id || null };
  }
);
