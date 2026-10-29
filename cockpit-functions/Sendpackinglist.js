// パッキングリストを Chatwork の決まったルームへアップロードする関数
// 分割くん（bunkatuedaban.html）の「Chatworkに送る」ボタンから呼ばれます。

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

// ラクロジスタッフアカウントのChatwork APIトークン（コックピットと同じものを使用）
const CHATWORK_API_TOKEN = defineSecret("CW_TOKEN_STAFF");

// ▼ 送り先のルームID（ChatworkのURL「#!rid12345678」の数字部分）
const PACKING_LIST_ROOM_ID = "442684516";

// ▼ 毎回の宛先（メッセージの先頭に付きます）
const TO_LINE = "[To:7964085]武田さん";

const MAX_BYTES = 5 * 1024 * 1024; // Chatworkの上限 5MB
const ALLOWED_EXT = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
};

exports.sendPackingListToChatwork = onCall(
  {
    region: "asia-northeast1",
    secrets: [CHATWORK_API_TOKEN],
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (request) => {
    const { fileName, fileBase64, message } = request.data || {};

    // --- 入力チェック ---
    if (typeof fileName !== "string" || typeof fileBase64 !== "string") {
      throw new HttpsError("invalid-argument", "ファイルが届いていません");
    }
    const safeName = fileName.replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);
    const ext = (safeName.split(".").pop() || "").toLowerCase();
    if (!ALLOWED_EXT[ext]) {
      throw new HttpsError("invalid-argument", "Excel（xlsx/xls）かCSVだけ送れます");
    }
    const buf = Buffer.from(fileBase64, "base64");
    if (buf.length === 0) {
      throw new HttpsError("invalid-argument", "ファイルが空です");
    }
    if (buf.length > MAX_BYTES) {
      throw new HttpsError("invalid-argument", "5MBを超えているため送れません");
    }
    const body = typeof message === "string" ? message.slice(0, 1000) : "";
    const text = body ? `${TO_LINE}\n${body}` : TO_LINE;

    // --- Chatworkへアップロード ---
    const form = new FormData();
    form.append("file", new Blob([buf], { type: ALLOWED_EXT[ext] }), safeName);
    form.append("message", text);

    const res = await fetch(
      `https://api.chatwork.com/v2/rooms/${PACKING_LIST_ROOM_ID}/files`,
      {
        method: "POST",
        headers: { "X-ChatWorkToken": CHATWORK_API_TOKEN.value() },
        body: form,
      }
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("Chatwork upload failed", res.status, detail);
      throw new HttpsError("internal", `Chatworkへの送信に失敗しました（${res.status}）`);
    }

    const json = await res.json().catch(() => ({}));
    return { ok: true, fileId: json.file_id || null };
  }
);
