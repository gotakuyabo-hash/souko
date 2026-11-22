const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp();
}

// zaicoの会社ID（トークンはSecret Managerで管理）
const COMPANY_ID = "220891";
const zaicoApiTokenSecret = defineSecret("ZAICO_API_TOKEN");

// ==========================================
// Slack Webhook設定（セキュアな環境変数から取得）
// ==========================================
const slackWebhookUrlSecret = defineSecret("SLACK_WEBHOOK_URL");

// ==========================================
// クールダウン管理（Firestoreで保持）
// インスタンスが入れ替わっても、同時に複数起動しても
// 「最後に通知した時刻」を共有できるようにしています。
// ==========================================
const COOLDOWN_TIME_MS = 15 * 60 * 1000; // 15分間
const COOLDOWN_COLLECTION = "notification_cooldowns";

async function canSendNotification(uniqueKey) {
    const db = admin.firestore();
    const ref = db.collection(COOLDOWN_COLLECTION).doc(uniqueKey);

    try {
        // トランザクションで「確認」と「記録」を同時に行うため、
        // ほぼ同時に2回呼ばれても通知は1回だけになります。
        return await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const now = Date.now();
            const lastSentAt = snap.exists ? (snap.data().lastSentAt || 0) : 0;

            if (now - lastSentAt < COOLDOWN_TIME_MS) {
                return false;
            }

            tx.set(ref, {
                lastSentAt: now,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return true;
        });
    } catch (error) {
        // 判定に失敗したときは、通知漏れを防ぐため送信する側に倒します
        logger.error(`クールダウン判定でエラーが発生しました (${uniqueKey}):`, error);
        return true;
    }
}

// Webhookを使った通知関数（ボタン付き）
async function sendSlackNotification(text, webhookUrl, actionUrl = null, actionButtonText = "アプリを開く") {
    try {
        if (!webhookUrl) {
            logger.error("❌ SLACK_WEBHOOK_URL が設定されていません。");
            return;
        }

        const messageWithMention = `<!channel>\n` + text;

        const blocks = [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": messageWithMention
                }
            }
        ];

        if (actionUrl) {
            blocks.push({
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": actionButtonText,
                            "emoji": true
                        },
                        "url": actionUrl
                    }
                ]
            });
        }

        const payload = {
            blocks: blocks
        };

        const res = await fetch(webhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const errText = await res.text();
            logger.error("❌ Slack Webhook エラー:", errText);
        } else {
            logger.info("✅ Slack通知の送信に成功しました！");
        }
    } catch (error) {
        logger.error("Slack通知の送信に失敗しました:", error);
    }
}

// 2. 共有ノートの更新通知 -> notes.html
exports.notifySharedNotes = onDocumentWritten(
    { document: "shared_notes/{docId}", region: "asia-northeast1", secrets: [slackWebhookUrlSecret] },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const docId = event.params.docId;
        const data = snap.after.data();

        // 更新前と比べて、タイトル・カテゴリ・内容が変わっていなければ通知しない
        // （並び順や更新日時だけの保存、全件の一括保存などで通知が大量に飛ぶのを防ぐ）
        if (snap.before.exists) {
            const before = snap.before.data();
            const isSame =
                (before.title || "") === (data.title || "") &&
                (before.name || "") === (data.name || "") &&
                (before.category || "") === (data.category || "") &&
                (before.content || "") === (data.content || "");
            if (isSame) {
                logger.info(`共有ノート ${docId} は内容に変更がないため通知をスキップしました。`);
                return;
            }
        }

        const title = data.title || data.name || "無題";
        const category = data.category || "未分類";
        const content = data.content ? (data.content.length > 50 ? data.content.substring(0, 50) + "..." : data.content) : "内容なし";

        let messageText = `📝 *共有ノートが更新されました！*\n>・ *タイトル:* ${title}\n>・ *カテゴリ:* ${category}\n>・ *内容:* ${content}\n>・ *ID:* ${docId}`;
        await sendSlackNotification(messageText, slackWebhookUrlSecret.value(), "https://souko-2de57.web.app/notes.html", "ノートを開く");
    }
);

// 4. スタッフからの新しい依頼の通知 -> request.html
//    ・新規登録のときだけ通知（更新・完了・削除では通知しない）
exports.notifyStaffRequests = onDocumentWritten(
    { document: "staff_requests/{docId}", region: "asia-northeast1", secrets: [slackWebhookUrlSecret] },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return; // 削除
        if (snap.before.exists) return;          // 更新（完了への変更も含む）

        const docId = event.params.docId;
        const data = snap.after.data();

        const messageText = `🆕 *スタッフから新しい依頼が届きました！*\n>・ *依頼者:* ${data.from || "スタッフ"}\n>・ *宛先:* ${data.to || "未設定"}\n>・ *内容:* ${data.task || "内容なし"}\n>・ *ID:* ${docId}`;
        await sendSlackNotification(messageText, slackWebhookUrlSecret.value(), "https://souko-2de57.web.app/request.html", "依頼を確認する");
    }
);

// 5. 日次報告チェックリストの更新通知 -> checklist.html
exports.notifyWarehouseReports = onDocumentWritten(
    { document: "warehouse_reports/{dateId}", region: "asia-northeast1", secrets: [slackWebhookUrlSecret] },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const dateId = event.params.dateId;

        if (!(await canSendNotification(`warehouse_reports_${dateId}`))) return;

        const data = snap.after.data();
        const reporterName = data.name || "未設定";

        let messageText = `📋 *日次報告チェックリストが更新されました！*\n>・ *対象日:* ${dateId}\n>・ *管理者:* ${reporterName}`;
        await sendSlackNotification(messageText, slackWebhookUrlSecret.value(), "https://souko-2de57.web.app/checklist.html", "チェックリストを開く");
    }
);

// ==========================================
// 定時まとめ通知・チェック機能
// ==========================================

// A. 未発注の資材発注通知 -> material.html
exports.checkUnorderedMaterials = onSchedule(
    {
        schedule: "0 12,15 * * *",
        timeZone: "Asia/Tokyo",
        region: "asia-northeast1",
        secrets: [slackWebhookUrlSecret]
    },
    async (event) => {
        const db = admin.firestore();

        try {
            const snapshot = await db.collection("material_orders")
                .where("status", "==", "未発注")
                .get();

            if (snapshot.empty) {
                logger.info("未発注の資材はありません。");
                return;
            }

            let messageText = `📦 *【定期通知】未発注の資材一覧*\n`;
            let hasUnordered = false;

            snapshot.forEach(doc => {
                const data = doc.data();
                const items = data.itemsData || [];

                items.forEach(item => {
                    if (item.status === "未発注") {
                        hasUnordered = true;
                        const itemName = item.name || item.itemName || item.title || "品名不明";
                        const quantity = item.qty || item.quantity || "数量不明";
                        messageText += `>・ *${itemName}* （数量: ${quantity}） [ID: ${doc.id}]\n`;
                    }
                });
            });

            if (!hasUnordered) {
                logger.info("未発注の資材はありません。");
                return;
            }

            await sendSlackNotification(messageText, slackWebhookUrlSecret.value(), "https://souko-2de57.web.app/material.html", "資材発注を確認する");
            logger.info("未発注資材の定期通知を送信しました。");
        } catch (error) {
            logger.error("未発注資材の定期チェックでエラーが発生しました:", error);
        }
    }
);

// B. 総出荷件数の定期通知 -> checklist.html
exports.reportTotalShukkaCounts = onSchedule(
    {
        schedule: "0 12,15,17 * * *",
        timeZone: "Asia/Tokyo",
        region: "asia-northeast1",
        secrets: [slackWebhookUrlSecret]
    },
    async (event) => {
        const db = admin.firestore();

        try {
            const todayStr = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
            const docRef = db.collection("shukka_records").doc(todayStr);
            const docSnap = await docRef.get();

            if (!docSnap.exists) {
                logger.info(`本日の出荷件数データ (${todayStr}) はまだ存在しません。`);
                return;
            }

            const data = docSnap.data();
            let totalCount = 0;
            Object.values(data).forEach(val => {
                const num = parseInt(val, 10);
                if (!isNaN(num)) totalCount += num;
            });

            let messageText = `📊 *【定期通知】本日の総出荷件数*\n>・ *対象日:* ${todayStr}\n>・ *総合計:* ${totalCount.toLocaleString()} 件`;

            await sendSlackNotification(messageText, slackWebhookUrlSecret.value(), "https://souko-2de57.web.app/checklist.html", "出荷集計を開く");
            logger.info("総出荷件数の定期通知を送信しました。");
        } catch (error) {
            logger.error("総出荷件数の定期通知でエラーが発生しました:", error);
        }
    }
);

// C. 日次報告チェックリストの定時未完了チェック -> checklist.html
exports.checkDailyIncompleteTasks = onSchedule(
    {
        schedule: "30 17 * * *",
        timeZone: "Asia/Tokyo",
        region: "asia-northeast1",
        secrets: [slackWebhookUrlSecret]
    },
    async (event) => {
        const db = admin.firestore();

        try {
            const todayStr = new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
            const docRef = db.collection("warehouse_reports").doc(todayStr);
            const docSnap = await docRef.get();

            if (!docSnap.exists) {
                logger.info("本日の日次報告データがまだ存在しません。");
                return;
            }

            const data = docSnap.data();
            const sections = data.sections || {};
            let uncheckedItems = [];

            for (const sectionKey of Object.keys(sections)) {
                const items = sections[sectionKey] || [];
                items.forEach(item => {
                    if (item.type === "checkbox" && item.checked === false) {
                        uncheckedItems.push(item.title || "無題のチェック項目");
                    }
                });
            }

            if (uncheckedItems.length === 0) {
                logger.info("未完了の項目はありません。");
                return;
            }

            let messageText = `⏰ *定時になりましたが、以下のチェックが未完了です！* (${todayStr})\n`;
            uncheckedItems.forEach(title => {
                messageText += `>・ ${title}\n`;
            });

            await sendSlackNotification(messageText, slackWebhookUrlSecret.value(), "https://souko-2de57.web.app/checklist.html", "チェックリストを開く");
            logger.info("定時チェックのSlack通知を送信しました。");
        } catch (error) {
            logger.error("定時チェックの処理でエラーが発生しました:", error);
        }
    }
);

// zaico出庫指示用API
exports.apiCreateZaicoShipment = onRequest(
    { region: "asia-northeast1", timeoutSeconds: 300, secrets: [zaicoApiTokenSecret] },
    async (req, res) => {
        const ZAICO_API_TOKEN = zaicoApiTokenSecret.value();
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.status(204).send('');
            return;
        }

        try {
            const items = req.body.items;
            const customerName = req.body.customerName || "受注一括出荷";

            if (!items || !Array.isArray(items) || items.length === 0) {
                res.status(400).json({ success: false, error: "Invalid items data" });
                return;
            }

            const codeToInventoryIdMap = new Map();
            const zaicoHeaders = { "Authorization": `Bearer ${ZAICO_API_TOKEN}` };

            // ① 画面から zaicoの商品ID（inventoryId）が届いた商品は、IDで1件ずつ確認する（全件を探すより速い）
            //    念のため、zaico側のバーコードが一致したときだけ使う（違えば②で探し直す）
            const withId = [];
            const seen = new Set();
            for (const item of items) {
                const bc = String(item.barcode).trim();
                const id = String(item.inventoryId || "").trim();
                if (id && bc && !seen.has(bc)) { seen.add(bc); withId.push({ bc, id }); }
            }
            let idHits = 0;
            const CONCURRENCY = 5;
            for (let i = 0; i < withId.length; i += CONCURRENCY) {
                await Promise.all(withId.slice(i, i + CONCURRENCY).map(async ({ bc, id }) => {
                    try {
                        const r = await fetch(`https://web.zaico.co.jp/api/v2/orgs/companies/${COMPANY_ID}/inventories/${encodeURIComponent(id)}.json`, { method: "GET", headers: zaicoHeaders });
                        if (!r.ok) return;
                        const d = await r.json();
                        const inv = d.inventory || d.data || d;
                        const invCode = String(inv.code || inv.inventory_code || "").trim();
                        if (invCode === bc) { codeToInventoryIdMap.set(bc, inv.id || inv.inventory_id || id); idHits++; }
                    } catch (e) {
                        logger.warn(`inventory_id ${id} の確認に失敗しました。一覧から探します。`, e.message);
                    }
                }));
            }

            // ② IDがない・確認できなかった商品だけ、在庫一覧をページ順に探す
            const targetBarcodes = new Set(items.map(item => String(item.barcode).trim()).filter(bc => !codeToInventoryIdMap.has(bc)));
            logger.info(`出荷対象 ${items.length} 件：IDで確認 ${idHits} 件／一覧から探す ${targetBarcodes.size} 件`);
            let foundInScan = 0;

            let page = 1;
            let hasMore = targetBarcodes.size > 0;
            const perPage = 100;
            const MAX_PAGES = 1000; // 最大10万件まで検索

            while (hasMore && foundInScan < targetBarcodes.size) {
                const url = `https://web.zaico.co.jp/api/v2/orgs/companies/${COMPANY_ID}/inventories.json?page=${page}&per_page=${perPage}`;
                const inventoriesRes = await fetch(url, { method: "GET", headers: zaicoHeaders });

                if (!inventoriesRes.ok) {
                    const errText = await inventoriesRes.text();
                    throw new Error(`zaico在庫の検索に失敗しました (page ${page}): ${errText}`);
                }

                const inventoriesData = await inventoriesRes.json();
                const inventoryList = inventoriesData.inventories || inventoriesData.data || [];

                if (inventoryList.length === 0) {
                    hasMore = false;
                    break;
                }

                for (const inv of inventoryList) {
                    const invCode = String(inv.code || inv.inventory_code || "").trim();
                    if (targetBarcodes.has(invCode) && !codeToInventoryIdMap.has(invCode)) {
                        codeToInventoryIdMap.set(invCode, inv.id || inv.inventory_id);
                        foundInScan++;
                    }
                }

                // 最終ページまで読み切ったら終了（MAX_PAGESは無限ループ防止の安全装置）
                if (inventoryList.length < perPage || page >= MAX_PAGES) {
                    if (page >= MAX_PAGES) {
                        logger.warn(`在庫検索が安全上限 (${MAX_PAGES}ページ) に達しました。`);
                    }
                    hasMore = false;
                } else {
                    page++;
                }
            }

            // 出庫予定日：画面から届いた日付（YYYY-MM-DD）を使い、なければ日本時間の当日
            const jstToday = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
            const reqDate = String(req.body.estimatedDeliveryDate || '').trim();
            const scheduledDate = /^\d{4}-\d{2}-\d{2}$/.test(reqDate) ? reqDate : jstToday;

            const deliveries = [];
            const missingBarcodes = [];

            for (const item of items) {
                const bc = String(item.barcode).trim();
                const inventoryId = codeToInventoryIdMap.get(bc);

                if (inventoryId) {
                    deliveries.push({
                        inventory_id: String(inventoryId),
                        quantity: String(item.pickCount),
                        estimated_delivery_date: scheduledDate // 出庫予定日
                    });
                } else {
                    missingBarcodes.push(bc);
                }
            }

            if (deliveries.length === 0) {
                res.status(400).json({
                    success: false,
                    error: "zaico側に対応する在庫ID（inventory_id）が見つかりませんでした。バーコードを確認してください。",
                    missingBarcodes: missingBarcodes
                });
                return;
            }

            const slipNum = "SLIP-" + Date.now();

            const todayStr = new Date().toLocaleDateString('ja-JP', {
                timeZone: 'Asia/Tokyo',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }).replace(/\//g, '-');

            const zaicoPayload = {
                num: slipNum,
                customer_name: customerName,
                status: "before_delivery",
                delivery_date: todayStr,
                date_of_issue: todayStr,
                deliveries: deliveries
            };

            const zaicoRes = await fetch(`https://web.zaico.co.jp/api/v2/orgs/companies/${COMPANY_ID}/packing_slips.json`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${ZAICO_API_TOKEN}`
                },
                body: JSON.stringify(zaicoPayload)
            });

            const zaicoData = await zaicoRes.json();

            if (!zaicoRes.ok) {
                logger.error("zaico v2 API エラーレスポンス:", zaicoData);
                res.status(500).json({ success: false, error: "zaico API Error: " + JSON.stringify(zaicoData) });
                return;
            }

            logger.info("zaico v2 出庫登録成功:", zaicoData);
            res.json({
                success: true,
                slipNum: slipNum,
                count: deliveries.length,
                missingCount: missingBarcodes.length,
                missingBarcodes: missingBarcodes,
                inventoryIds: Object.fromEntries(codeToInventoryIdMap),
                zaicoResponse: zaicoData
            });

        } catch (error) {
            logger.error("zaico出庫指示の送信でエラーが発生しました:", error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
);

// zaico在庫一覧API（まとまるくん「zaicoから選ぶ」・商品マスタ登録用）
// apiCreateZaicoShipment と同じ v2 API・会社ID・トークンを使う。
// 全件を1回で読むと時間切れになるため、?page=1 から数ページ分ずつ返し、画面側が nextPage を順に呼ぶ
const pickText = (v) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return String(v.name || v.title || "");
    return String(v);
};

exports.apiListZaicoInventories = onRequest(
    { region: "asia-northeast1", timeoutSeconds: 120, memory: "512MiB", secrets: [zaicoApiTokenSecret] },
    async (req, res) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            res.status(204).send('');
            return;
        }

        try {
            const ZAICO_API_TOKEN = zaicoApiTokenSecret.value();
            const perPage = 100;
            const startPage = Math.max(1, parseInt(req.query.page, 10) || 1);
            const pagesPerCall = Math.min(20, Math.max(1, parseInt(req.query.pages, 10) || 10)); // 1回で最大1,000件程度
            const items = [];
            let nextPage = null;
            let fields = null;

            for (let page = startPage; page < startPage + pagesPerCall; page++) {
                const url = `https://web.zaico.co.jp/api/v2/orgs/companies/${COMPANY_ID}/inventories.json?page=${page}&per_page=${perPage}`;
                const r = await fetch(url, { method: "GET", headers: { "Authorization": `Bearer ${ZAICO_API_TOKEN}` } });
                if (!r.ok) {
                    const errText = await r.text();
                    throw new Error(`zaico在庫一覧の取得に失敗しました (page ${page}, ${r.status}): ${errText.slice(0, 300)}`);
                }
                const data = await r.json();
                const list = data.inventories || data.data || [];

                for (const inv of list) {
                    items.push({
                        id: inv.id || inv.inventory_id,
                        title: pickText(inv.title || inv.name),
                        code: String(inv.code || inv.inventory_code || "").trim(), // 出庫登録と同じ項目で照合
                        place: pickText(inv.place || inv.location),
                        quantity: inv.quantity ?? inv.logical_quantity ?? "",
                        unit: pickText(inv.unit),
                        category: pickText(inv.category),
                        // 依頼まとめ管理（irai.html）の「zaico在庫」でショップごとに分けるため
                        // グループと追加項目（「ショップ名」など）もそのまま返す
                        user_group: inv.user_group ?? inv.group ?? inv.user_groups ?? inv.groups ?? null,
                        optional_attributes: inv.optional_attributes ?? inv.optional_attribute_values ?? inv.custom_fields ?? null
                    });
                    if (!fields) fields = Object.keys(inv); // zaicoが返す項目名（うまく分けられないときの確認用）
                }
                if (list.length < perPage) { nextPage = null; break; }
                nextPage = page + 1;
            }

            res.json({ success: true, page: startPage, nextPage, count: items.length, fields, items });
        } catch (error) {
            logger.error("zaico在庫一覧の取得でエラーが発生しました:", error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
);

// ==========================================
// zaicoの商品1件の「ショップ名」（追加項目）と「数量」を書き換えるAPI（依頼まとめ管理 irai.html の「zaico在庫」から使う）
// ・ログインした社内の人だけが使えるように、FirebaseのIDトークンを確認する
// ・送られてきた項目だけを書き換える（ショップ名だけ／数量だけ／両方）。ほかの追加項目はそのまま
// ・数量は「画面で見ていた数量（expectQuantity）」とzaicoの今の数量が違えば書き換えない（その間の入出庫を消さないため）
// ・書き換えたあと、zaicoから読み直して本当に変わったか確かめてから返事をする
// ・delete: true のときは商品を削除する。削除の直前の内容を Firestore の zaico_deleted_inventories に残す
//   （在庫が残っている商品は、画面で見ていた数量 expectQuantity と今の数量が同じときだけ削除する）
// ==========================================
const ZAICO_DELETED_COL = "zaico_deleted_inventories";
const SHOP_ATTR_NAME = "ショップ名";
// 使ってよい人（どちらかに当てはまる人だけ）。両方とも空のときは、ログインしている人なら誰でも使える
const SHOP_EDIT_ALLOWED_EMAILS = [];   // 例: ["taro@example.com"]
const SHOP_EDIT_ALLOWED_DOMAINS = [];  // 例: ["logex.jp"]

const attrName = (a) => String((a && (a.name ?? a.title ?? a.label ?? a.optional_attribute_name ?? a.key)) || "").trim();
const attrValue = (a) => {
    const v = a && (a.value ?? a.val ?? a.content ?? a.text);
    return v === null || v === undefined ? "" : String(typeof v === "object" ? (v.name ?? v.value ?? "") : v).trim();
};
function readShop(inv) {
    const a = inv.optional_attributes ?? inv.optional_attribute_values ?? inv.custom_fields;
    if (Array.isArray(a)) { const f = a.find(x => attrName(x) === SHOP_ATTR_NAME); return f ? attrValue(f) : ""; }
    if (a && typeof a === "object") return String(a[SHOP_ATTR_NAME] ?? "").trim();
    return "";
}
// zaicoのエラーを、画面でわかる日本語にする
const zaicoErrJa = (t) => /stocktaking/i.test(String(t)) ? "zaicoで棚卸の最中のため、変更・削除できません。zaicoで棚卸を終えてから、もう一度お試しください" : "";
const readCode = (inv) => String(inv.code ?? inv.inventory_code ?? "").trim();
const ZAICO_CODE_LOG_COL = "zaico_code_changes";
// バーコード（QRコード・バーコードの値）を変えたら、まとまるくんの商品マスタ（product_masters）も新しい値に直す
// ・単品：barcode が前の値のSKU
// ・セット品：中身（components）の barcode が前の値のもの
// ・前の値がほかのzaico商品にも付いているときは、この商品のIDでつながっているものだけ（別の商品を書き換えないため）
async function fixProductMasters(oldCode, newCode, inventoryId, oldShared) {
    const db = admin.firestore();
    const col = db.collection("product_masters");
    const touched = new Map();   // ドキュメントID → { ref, data }
    const mine = (bc, zid) => !!oldCode && bc === oldCode && (!oldShared || String(zid || "") === String(inventoryId));
    const singles = [];
    if (oldCode) (await col.where("barcode", "==", oldCode).get()).forEach(d => singles.push(d));
    singles.forEach(d => {
        const m = d.data();
        if (m.isSet) return;
        if (!mine(String(m.barcode || "").trim(), m.zaicoItemId)) return;
        touched.set(d.id, { ref: d.ref, data: { barcode: newCode, zaicoItemId: String(inventoryId) }, sku: d.id });
    });
    let sets = 0;
    (await col.where("isSet", "==", true).get()).forEach(d => {
        const m = d.data();
        if (!Array.isArray(m.components)) return;
        let hit = false;
        const comps = m.components.map(c => {
            const bc = String(c && c.barcode || "").trim();
            if (!mine(bc, c && c.zaicoItemId) || bc === newCode) return c;
            hit = true;
            return Object.assign({}, c, { barcode: newCode, zaicoItemId: String(inventoryId) });
        });
        if (hit) { touched.set(d.id, { ref: d.ref, data: { components: comps }, sku: d.id, isSet: true }); sets++; }
    });
    const list = [...touched.values()];
    for (let i = 0; i < list.length; i += 400) {
        const batch = db.batch();
        list.slice(i, i + 400).forEach(t => batch.set(t.ref, Object.assign({}, t.data, { updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: "zaicoバーコード変更" }), { merge: true }));
        await batch.commit();
    }
    return { skus: list.filter(t => !t.isSet).map(t => t.sku), sets: list.filter(t => t.isSet).map(t => t.sku) };
}
const readQty = (inv) => { const n = Number(inv.quantity ?? inv.logical_quantity); return isNaN(n) ? null : n; };

exports.apiUpdateZaicoShop = onRequest(
    { region: "asia-northeast1", timeoutSeconds: 60, secrets: [zaicoApiTokenSecret] },
    async (req, res) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
        if (req.method !== 'POST') { res.status(405).json({ success: false, error: "POSTで送ってください" }); return; }

        // ① ログインの確認
        let email = "";
        try {
            const m = String(req.get('Authorization') || "").match(/^Bearer\s+(.+)$/i);
            if (!m) throw new Error("no token");
            const decoded = await admin.auth().verifyIdToken(m[1]);
            email = String(decoded.email || "").toLowerCase();
            if (!email || decoded.email_verified === false) throw new Error("no email");
        } catch (e) {
            res.status(401).json({ success: false, error: "ログインを確認できませんでした。ログインし直してください" });
            return;
        }
        const okEmail = SHOP_EDIT_ALLOWED_EMAILS.map(x => x.toLowerCase()).includes(email);
        const okDomain = SHOP_EDIT_ALLOWED_DOMAINS.some(d => email.endsWith("@" + d.toLowerCase()));
        if ((SHOP_EDIT_ALLOWED_EMAILS.length || SHOP_EDIT_ALLOWED_DOMAINS.length) && !okEmail && !okDomain) {
            res.status(403).json({ success: false, error: `${email} にはzaicoの商品を変更する許可がありません` });
            return;
        }

        try {
            const b = req.body || {};
            const id = String(b.inventoryId || "").trim();
            if (!/^\d+$/.test(id)) { res.status(400).json({ success: false, error: "在庫IDがありません" }); return; }
            const wantDelete = b.delete === true;
            const wantShop = Object.prototype.hasOwnProperty.call(b, "shop");
            const wantQty = Object.prototype.hasOwnProperty.call(b, "quantity");
            const wantCode = Object.prototype.hasOwnProperty.call(b, "code");
            const code = wantCode ? String(b.code || "").trim() : "";
            if (wantCode && !code) { res.status(400).json({ success: false, error: "バーコードを空欄にはできません" }); return; }
            if (code.length > 100) { res.status(400).json({ success: false, error: "バーコードが長すぎます" }); return; }
            if (!wantDelete && !wantShop && !wantQty && !wantCode) { res.status(400).json({ success: false, error: "変更する項目がありません" }); return; }
            const shop = wantShop ? String(b.shop || "").trim() : "";
            if (shop.length > 100) { res.status(400).json({ success: false, error: "ショップ名が長すぎます" }); return; }
            const qty = wantQty ? Number(b.quantity) : null;
            if (wantQty && (!isFinite(qty) || qty < 0)) { res.status(400).json({ success: false, error: "在庫数は0以上の数で入れてください" }); return; }

            const ZAICO_API_TOKEN = zaicoApiTokenSecret.value();
            const url = `https://web.zaico.co.jp/api/v2/orgs/companies/${COMPANY_ID}/inventories/${encodeURIComponent(id)}.json`;
            const headers = { "Authorization": `Bearer ${ZAICO_API_TOKEN}`, "Content-Type": "application/json" };
            const getInv = async () => {
                const r = await fetch(url, { method: "GET", headers });
                const t = await r.text();
                if (!r.ok) throw new Error(`zaicoの商品を読めませんでした (${r.status}): ${t.slice(0, 300)}`);
                const d = JSON.parse(t);
                return d.inventory || d.data || d;
            };

            // ② 今の内容を読む
            const inv = await getInv();
            const beforeShop = readShop(inv), beforeQty = readQty(inv), beforeCode = readCode(inv);

            // ── 削除 ──
            if (wantDelete) {
                const expect = b.expectQuantity;
                if (expect !== undefined && expect !== null && expect !== "" && Number(expect) !== beforeQty) {
                    res.status(409).json({ success: false, conflict: true, inventoryId: id, currentQuantity: beforeQty,
                        error: `zaicoの在庫数が ${expect} から ${beforeQty} に変わっています（その間に入出庫がありました）。内容を確かめてから、もう一度削除してください` });
                    return;
                }
                // 削除の前に、今の内容をまるごと残す（間違えて消したときに作り直せるように）
                const db = admin.firestore();
                const logRef = db.collection(ZAICO_DELETED_COL).doc();
                await logRef.set({
                    inventoryId: id, title: String(inv.title || inv.name || ""), code: String(inv.code || inv.inventory_code || ""),
                    shop: beforeShop, quantity: beforeQty, unit: String(inv.unit || ""), place: String(inv.place || ""),
                    raw: JSON.parse(JSON.stringify(inv)), deletedBy: email, deletedAt: admin.firestore.FieldValue.serverTimestamp(), status: "deleting"
                });
                const dr = await fetch(url, { method: "DELETE", headers });
                const dt = await dr.text();
                if (!dr.ok && dr.status !== 404) {
                    await logRef.update({ status: "failed", error: dt.slice(0, 500) });
                    throw new Error(zaicoErrJa(dt) || `zaicoで削除できませんでした (${dr.status}): ${dt.slice(0, 300)}`);
                }
                // 本当に消えたか確かめる
                const chk = await fetch(url, { method: "GET", headers });
                const gone = chk.status === 404;
                await logRef.update({ status: gone ? "deleted" : "unconfirmed" });
                logger.info(`zaico商品を削除 ${id}「${inv.title || ""}」（在庫${beforeQty}）by ${email}（確認${gone ? "OK" : "NG"}）`);
                if (!gone) {
                    res.status(500).json({ success: false, inventoryId: id, error: "zaicoは削除を受け付けましたが、まだ商品が残っています。zaicoの画面で確認してください" });
                    return;
                }
                await writeInvPatch(id, null, email);
                res.json({ success: true, deleted: true, inventoryId: id, backupId: logRef.id });
                return;
            }
            const payload = {};
            if (wantQty && beforeQty !== qty) {
                // 画面を開いてからzaicoの数量が変わっていたら、上書きしない
                if (b.expectQuantity !== undefined && b.expectQuantity !== null && b.expectQuantity !== "" && Number(b.expectQuantity) !== beforeQty) {
                    res.status(409).json({ success: false, conflict: true, inventoryId: id, currentQuantity: beforeQty,
                        error: `zaicoの在庫数が ${b.expectQuantity} から ${beforeQty} に変わっています（その間に入出庫がありました）。読み直してから、もう一度入れてください` });
                    return;
                }
                payload.quantity = String(qty);
            }
            if (wantCode && beforeCode !== code) {
                // 画面を開いてからzaicoのバーコードが変わっていたら、上書きしない
                if (b.expectCode !== undefined && b.expectCode !== null && String(b.expectCode).trim() !== beforeCode) {
                    res.status(409).json({ success: false, conflict: true, inventoryId: id, currentQuantity: beforeQty, currentCode: beforeCode,
                        error: `zaicoのバーコードが「${b.expectCode}」から「${beforeCode}」に変わっています。読み直してから、もう一度入れてください` });
                    return;
                }
                payload.code = code;
            }
            if (wantShop && beforeShop !== shop) {
                // ショップ名だけ差し替える（ほかの追加項目はそのまま送り返す）
                // ※zaico v2 の書き込みは { "項目名": "値" } のオブジェクト形式（配列だと400エラー）
                const cur = inv.optional_attributes ?? inv.optional_attribute_values ?? null;
                const attrs = {};
                if (Array.isArray(cur)) cur.forEach(a => { const k = attrName(a); if (k) attrs[k] = attrValue(a); });
                else if (cur && typeof cur === "object") Object.keys(cur).forEach(k => { const v = cur[k]; attrs[k] = v === null || v === undefined ? "" : String(typeof v === "object" ? (v.value ?? v.name ?? "") : v); });
                attrs[SHOP_ATTR_NAME] = shop;
                payload.optional_attributes = attrs;
            }
            if (!Object.keys(payload).length) {
                res.json({ success: true, verified: true, unchanged: true, inventoryId: id, shop: beforeShop, quantity: beforeQty });
                return;
            }

            // ③ 書き換え（PUTが使えなければPATCHで）
            const body = JSON.stringify(payload);
            let r = await fetch(url, { method: "PUT", headers, body });
            if (r.status === 404 || r.status === 405) r = await fetch(url, { method: "PATCH", headers, body });
            const rt = await r.text();
            if (!r.ok) throw new Error(zaicoErrJa(rt) || `zaicoで書き換えられませんでした (${r.status}): ${rt.slice(0, 300)}`);

            // ④ 読み直して確かめる
            const afterInv = await getInv();
            const afterShop = readShop(afterInv), afterQty = readQty(afterInv), afterCode = readCode(afterInv);
            const ng = [];
            if (payload.code !== undefined && afterCode !== code) ng.push(`バーコードが「${afterCode}」のまま`);
            if (payload.optional_attributes && afterShop !== shop) ng.push(`ショップ名が「${afterShop}」のまま`);
            if (payload.quantity !== undefined && afterQty !== qty) ng.push(`在庫数が ${afterQty} のまま`);
            logger.info(`zaico商品を変更 ${id} by ${email}：` +
                (payload.optional_attributes ? `ショップ名「${beforeShop}」→「${shop}」 ` : "") +
                (payload.quantity !== undefined ? `在庫数 ${beforeQty}→${qty} ` : "") +
                (payload.code !== undefined ? `バーコード「${beforeCode}」→「${code}」 ` : "") + (ng.length ? "（確認NG：" + ng.join("・") + "）" : "（確認OK）"));
            if (ng.length) {
                res.status(500).json({ success: false, verified: false, inventoryId: id, shop: afterShop, quantity: afterQty,
                    error: `zaicoは受け付けましたが、${ng.join("・")}でした。送り方を調整する必要があります`, zaicoResponse: rt.slice(0, 500) });
                return;
            }
            await writeInvPatch(id, slimInv(afterInv), email);   // 在庫の写しにもすぐ反映
            // バーコードを変えたら、まとまるくんの商品マスタも直して、変更の記録を残す
            let masters = null, masterError = "";
            if (payload.code !== undefined) {
                try { masters = await fixProductMasters(beforeCode, code, id, b.oldCodeShared === true); }
                catch (e) { masterError = e.message; logger.error("商品マスタのバーコードを直せませんでした:", e); }
                try {
                    await admin.firestore().collection(ZAICO_CODE_LOG_COL).add({
                        inventoryId: id, title: String(inv.title || inv.name || ""), before: beforeCode, after: code,
                        masters: masters || null, masterError, by: email, at: admin.firestore.FieldValue.serverTimestamp()
                    });
                } catch (e) { logger.warn("バーコード変更の記録を残せませんでした:", e.message); }
            }
            res.json({ success: true, verified: true, inventoryId: id, before: { shop: beforeShop, quantity: beforeQty, code: beforeCode },
                shop: afterShop, quantity: afterQty, code: afterCode, masters, masterError });
        } catch (error) {
            logger.error("zaicoの商品変更でエラーが発生しました:", error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
);

// ==========================================
// zaicoの在庫一覧の「写し」を Firestore に置く（まとまるくん・依頼まとめ管理・配送管理アプリが同じものを見る）
//   zaico_inventory_cache/current            … { v, parts, count, at, by }（v は作り始めた時刻のミリ秒）
//   zaico_inventory_cache/current/parts/p0… … 一覧をJSONにして分けて入れる（1つのドキュメントは1MBまでのため）
//   zaico_inventory_cache/current/patches/{在庫ID} … 写しを作ったあとに変えた商品（item が null なら削除）
// アプリは parts を読んだあと、v より新しい patches を上から当てて使う
// ==========================================
const ZINV_COL = "zaico_inventory_cache";
const ZINV_PART = 200000;   // 1つに入れる文字数（日本語が多くても1MBを超えないように）
const zinvRef = () => admin.firestore().collection(ZINV_COL).doc("current");
function slimInv(inv) {
    return {
        id: String(inv.id || inv.inventory_id || ""), title: pickText(inv.title || inv.name),
        code: String(inv.code || inv.inventory_code || "").trim(), place: pickText(inv.place || inv.location),
        quantity: inv.quantity ?? inv.logical_quantity ?? "", unit: pickText(inv.unit), category: pickText(inv.category),
        shop: readShop(inv)
    };
}
async function syncZaicoInventory(by) {
    const token = zaicoApiTokenSecret.value();
    const start = Date.now();
    const items = [];
    for (let page = 1; page <= 1000; page++) {
        const url = `https://web.zaico.co.jp/api/v2/orgs/companies/${COMPANY_ID}/inventories.json?page=${page}&per_page=100`;
        const r = await fetch(url, { method: "GET", headers: { "Authorization": `Bearer ${token}` } });
        if (!r.ok) throw new Error(`zaico在庫一覧の取得に失敗しました (page ${page}, ${r.status}): ${(await r.text()).slice(0, 300)}`);
        const data = await r.json();
        const list = data.inventories || data.data || [];
        list.forEach(inv => items.push(slimInv(inv)));
        if (list.length < 100) break;
    }
    const json = JSON.stringify(items);
    const n = Math.max(1, Math.ceil(json.length / ZINV_PART));
    const db = admin.firestore(), ref = zinvRef();
    const batch = db.batch();
    for (let i = 0; i < n; i++) batch.set(ref.collection("parts").doc("p" + i), { v: start, i, s: json.slice(i * ZINV_PART, (i + 1) * ZINV_PART) });
    for (let i = n; i < n + 10; i++) batch.delete(ref.collection("parts").doc("p" + i));   // 前より短くなったときの残りを消す
    batch.set(ref, { v: start, parts: n, count: items.length, at: new Date().toISOString(), by: by || "" });
    await batch.commit();
    // 写しに入った変更（作り始める前の patches）は片付ける
    const old = await ref.collection("patches").where("at", "<=", start).get();
    for (let i = 0; i < old.docs.length; i += 400) {
        const b = db.batch();
        old.docs.slice(i, i + 400).forEach(d => b.delete(d.ref));
        await b.commit();
    }
    logger.info(`zaico在庫の写しを更新しました：${items.length}件（${n}分割）by ${by || ""}`);
    return { count: items.length, v: start };
}
// 在庫修正・削除のあと、その商品だけ写しに反映する（item が null なら削除）
async function writeInvPatch(id, item, by) {
    try {
        await zinvRef().collection("patches").doc(String(id)).set({ at: Date.now(), item: item || null, by: by || "" });
    } catch (e) { logger.warn("在庫の写しに反映できませんでした:", e.message); }
}

// 定期更新（朝7時〜夜9時のあいだ、10分ごと）
exports.scheduledZaicoInventorySync = onSchedule(
    { schedule: "every 10 minutes from 07:00 to 21:00", timeZone: "Asia/Tokyo", region: "asia-northeast1",
      timeoutSeconds: 540, memory: "512MiB", secrets: [zaicoApiTokenSecret] },
    async () => {
        try { await syncZaicoInventory("定期更新"); }
        catch (e) { logger.error("zaico在庫の写しの定期更新でエラーが発生しました:", e); }
    }
);

// 手動更新（各アプリの「zaicoから読み直す」）。30秒以内に更新したばかりなら、作り直さずにそのまま返す
exports.apiSyncZaicoInventory = onRequest(
    { region: "asia-northeast1", timeoutSeconds: 540, memory: "512MiB", secrets: [zaicoApiTokenSecret] },
    async (req, res) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
        try {
            const meta = await zinvRef().get();
            const m = meta.exists ? meta.data() : null;
            if (m && Date.now() - Number(m.v || 0) < 30 * 1000) { res.json({ success: true, skipped: true, count: m.count, v: m.v }); return; }
            const by = String((req.body && req.body.by) || "手動更新").slice(0, 100);
            const r = await syncZaicoInventory(by);
            res.json({ success: true, count: r.count, v: r.v });
        } catch (error) {
            logger.error("zaico在庫の写しの更新でエラーが発生しました:", error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
);
