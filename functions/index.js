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

// 4. スタッフからの要望・依頼の更新通知 -> request.html
exports.notifyStaffRequests = onDocumentWritten(
    { document: "staff_requests/{docId}", region: "asia-northeast1", secrets: [slackWebhookUrlSecret] },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const docId = event.params.docId;
        const data = snap.after.data();

        const fromUser = data.from || "スタッフ";
        const toUser = data.to || "未設定";
        const taskContent = data.task || "内容なし";
        const status = data.status || "pending";

        let messageText = `🙋 *スタッフからの要望・依頼が更新されました！*\n>・ *依頼者:* ${fromUser}\n>・ *宛先:* ${toUser}\n>・ *内容:* ${taskContent}\n>・ *ステータス:* ${status}\n>・ *ID:* ${docId}`;
        await sendSlackNotification(messageText, slackWebhookUrlSecret.value(), "https://souko-2de57.web.app/request.html", "要望を確認する");
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

            logger.info(`出荷対象 ${items.length} 件のinventory_idをzaicoからピンポイントで取得します...`);

            const targetBarcodes = new Set(items.map(item => String(item.barcode).trim()));
            const codeToInventoryIdMap = new Map();

            let page = 1;
            let hasMore = true;
            const perPage = 100;
            const MAX_PAGES = 1000; // 最大10万件まで検索

            while (hasMore && codeToInventoryIdMap.size < targetBarcodes.size) {
                const url = `https://web.zaico.co.jp/api/v2/orgs/companies/${COMPANY_ID}/inventories.json?page=${page}&per_page=${perPage}`;
                const inventoriesRes = await fetch(url, {
                    method: "GET",
                    headers: { "Authorization": `Bearer ${ZAICO_API_TOKEN}` }
                });

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

            const deliveries = [];
            const missingBarcodes = [];

            for (const item of items) {
                const bc = String(item.barcode).trim();
                const inventoryId = codeToInventoryIdMap.get(bc);

                if (inventoryId) {
                    deliveries.push({
                        inventory_id: String(inventoryId),
                        quantity: String(item.pickCount)
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
                zaicoResponse: zaicoData
            });

        } catch (error) {
            logger.error("zaico出庫指示の送信でエラーが発生しました:", error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
);
