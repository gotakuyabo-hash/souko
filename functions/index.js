const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp();
}

// zaicoのAPIトークンと会社IDを定義
const ZAICO_API_TOKEN = "JrUbGqtdGSndDtF3K8VsNtVwHZnSQKxW";
const COMPANY_ID = "220891";

// ==========================================
// Slack Webhook設定（セキュアな環境変数から取得）
// ==========================================
const slackWebhookUrlSecret = defineSecret("SLACK_WEBHOOK_URL");

// ==========================================
// クールダウン管理（他のコレクション等でも必要に応じて使用）
// ==========================================
const notificationCooldowns = {};
const COOLDOWN_TIME_MS = 15 * 60 * 1000; // 15分間

function canSendNotification(uniqueKey) {
    const now = Date.now();
    const lastTime = notificationCooldowns[uniqueKey] || 0;
    
    if (now - lastTime < COOLDOWN_TIME_MS) {
        return false;
    }
    notificationCooldowns[uniqueKey] = now;
    return true;
}

// Webhookを使った確実な通知関数（シークレットを引数で受け取る）
async function sendSlackNotification(text, webhookUrl) {
    try {
        if (!webhookUrl) {
            logger.error("❌ SLACK_WEBHOOK_URL が設定されていません。");
            return;
        }

        const messageWithMention = `<!channel>\n` + text;

        const res = await fetch(webhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                text: messageWithMention
            }),
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

// 1. material_orders の都度通知は廃止（定時まとめ通知に変更）

// 2. shared_notes（共有ノートなど）の更新通知
exports.notifySharedNotes = onDocumentWritten(
    { document: "shared_notes/{docId}", region: "asia-northeast1", secrets: [slackWebhookUrlSecret] },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const docId = event.params.docId;
        const data = snap.after.data();
        const title = data.title || data.name || "無題";

        let messageText = `📝 *共有ノートが更新されました！*\n>・ *タイトル:* ${title}\n>・ *ID:* ${docId}`;
        await sendSlackNotification(messageText, slackWebhookUrlSecret.value());
    }
);

// 3. shukka_records の都度通知は廃止（定時まとめ通知に変更）

// 4. staff_requests（スタッフからの要望・依頼など）の更新通知
exports.notifyStaffRequests = onDocumentWritten(
    { document: "staff_requests/{docId}", region: "asia-northeast1", secrets: [slackWebhookUrlSecret] },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const docId = event.params.docId;
        const data = snap.after.data();
        const staffName = data.name || data.staffName || "スタッフ";

        let messageText = `🙋 *スタッフからの要望・依頼が更新されました！*\n>・ *担当/氏名:* ${staffName}\n>・ *ID:* ${docId}`;
        await sendSlackNotification(messageText, slackWebhookUrlSecret.value());
    }
);

// 5. warehouse_reports（日次報告チェックリスト）の更新通知 ★15分クールダウンあり
exports.notifyWarehouseReports = onDocumentWritten(
    { document: "warehouse_reports/{dateId}", region: "asia-northeast1", secrets: [slackWebhookUrlSecret] },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const dateId = event.params.dateId;

        if (!canSendNotification(`warehouse_reports_${dateId}`)) return;

        const data = snap.after.data();
        const reporterName = data.name || "未設定";

        let messageText = `📋 *日次報告チェックリストが更新されました！*\n>・ *対象日:* ${dateId}\n>・ *管理者:* ${reporterName}`;
        await sendSlackNotification(messageText, slackWebhookUrlSecret.value());
    }
);

// ==========================================
// 定時まとめ通知・チェック機能
// ==========================================

// A. 未発注の資材発注通知（毎日 12:00, 15:00）
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
            
            snapshot.forEach(doc => {
                const data = doc.data();
                const itemName = data.itemName || data.title || data.name || "品名不明";
                const quantity = data.quantity || "数量不明";
                messageText += `>・ *${itemName}* （数量: ${quantity}） [ID: ${doc.id}]\n`;
            });

            await sendSlackNotification(messageText, slackWebhookUrlSecret.value());
            logger.info("未発注資材の定期通知を送信しました。");
        } catch (error) {
            logger.error("未発注資材の定期チェックでエラーが発生しました:", error);
        }
    }
);

// B. 総出荷件数の定期通知（毎日 12:00, 15:00, 17:00）
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

            await sendSlackNotification(messageText, slackWebhookUrlSecret.value());
            logger.info("総出荷件数の定期通知を送信しました。");
        } catch (error) {
            logger.error("総出荷件数の定期通知でエラーが発生しました:", error);
        }
    }
);

// C. 日次報告チェックリストの定時未完了チェック（毎日 17:30）
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

            await sendSlackNotification(messageText, slackWebhookUrlSecret.value());
            logger.info("定時チェックのSlack通知を送信しました。");
        } catch (error) {
            logger.error("定時チェックの処理でエラーが発生しました:", error);
        }
    }
);

// zaico出庫指示用API（ピンポイント逆引き・宛名指定・before_delivery対応）
exports.apiCreateZaicoShipment = onRequest(
    { region: "asia-northeast1" },
    async (req, res) => {
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

                if (inventoryList.length < perPage) {
                    hasMore = false;
                } else {
                    page++;
                }

                if (page > 30) break;
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
                    error: "zaico側に対応する在庫ID（inventory_id）が見つかりませんでした。バーコードを確認してください。" 
                });
                return;
            }

            const slipNum = "SLIP-" + Date.now();
            const todayStr = new Date().toISOString().split('T')[0];

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
                zaicoResponse: zaicoData
            });

        } catch (error) {
            logger.error("zaico出庫指示の送信でエラーが発生しました:", error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
);
