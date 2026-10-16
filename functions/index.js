const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const functions = require("firebase-functions");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp();
}

// zaico API トークン
const ZAICO_API_TOKEN = "JrUbGqtdGSndDtF3K8VsNtVwHZnSQKxW";

// ==========================================
// クールダウン管理（3と5のコレクション用）
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

// 1. material_orders（資材発注など）の更新通知
exports.notifyMaterialOrders = onDocumentWritten(
    { document: "material_orders/{docId}", region: "asia-northeast1" },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const docId = event.params.docId;

        let messageText = `📦 *資材発注データが更新されました！*\n>・ *ID/日付:* ${docId}`;
        await sendSlackNotification(messageText);
    }
);

// 2. shared_notes（共有ノートなど）の更新通知
exports.notifySharedNotes = onDocumentWritten(
    { document: "shared_notes/{docId}", region: "asia-northeast1" },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const docId = event.params.docId;
        const data = snap.after.data();
        const title = data.title || data.name || "無題";

        let messageText = `📝 *共有ノートが更新されました！*\n>・ *タイトル:* ${title}\n>・ *ID:* ${docId}`;
        await sendSlackNotification(messageText);
    }
);

// 3. shukka_records（出荷件数）の更新通知 ★15分クールダウンあり
exports.notifyShukkaRecords = onDocumentWritten(
    { document: "shukka_records/{dateId}", region: "asia-northeast1" },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const dateId = event.params.dateId;

        if (!canSendNotification(`shukka_records_${dateId}`)) return;

        const afterData = snap.after.data();
        let totalCount = 0;
        Object.values(afterData).forEach(val => {
            const num = parseInt(val, 10);
            if (!isNaN(num)) totalCount += num;
        });

        let messageText = `📊 *出荷件数データが更新されました！*\n>・ *対象日:* ${dateId}\n>・ *総合計:* ${totalCount.toLocaleString()} 件`;
        await sendSlackNotification(messageText);
    }
);

// 4. staff_requests（スタッフからの要望・依頼など）の更新通知
exports.notifyStaffRequests = onDocumentWritten(
    { document: "staff_requests/{docId}", region: "asia-northeast1" },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const docId = event.params.docId;
        const data = snap.after.data();
        const staffName = data.name || data.staffName || "スタッフ";

        let messageText = `🙋 *スタッフからの要望・依頼が更新されました！*\n>・ *担当/氏名:* ${staffName}\n>・ *ID:* ${docId}`;
        await sendSlackNotification(messageText);
    }
);

// 5. warehouse_reports（日次報告チェックリスト）の更新通知 ★15分クールダウンあり
exports.notifyWarehouseReports = onDocumentWritten(
    { document: "warehouse_reports/{dateId}", region: "asia-northeast1" },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const dateId = event.params.dateId;

        if (!canSendNotification(`warehouse_reports_${dateId}`)) return;

        const data = snap.after.data();
        const reporterName = data.name || "未設定";

        let messageText = `📋 *日次報告チェックリストが更新されました！*\n>・ *対象日:* ${dateId}\n>・ *管理者:* ${reporterName}`;
        await sendSlackNotification(messageText);
    }
);

// 定時チェック機能（v1の仕組み）
exports.checkDailyIncompleteTasks = functions.region("asia-northeast1").pubsub.schedule("30 17 * * *").timeZone("Asia/Tokyo").onRun(async (context) => {
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

        await sendSlackNotification(messageText);
        logger.info("定時チェックのSlack通知を送信しました。");
    } catch (error) {
        logger.error("定時チェックの処理でエラーが発生しました:", error);
    }
});

// zaico出庫指示受け付け用API（バーコード直指定版）
exports.apiCreateZaicoShipment = functions.region("asia-northeast1").https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        const items = req.body.items;
        if (!items || !Array.isArray(items) || items.length === 0) {
            res.status(400).json({ success: false, error: "Invalid items data" });
            return;
        }

        const slipNum = "SLIP-" + Date.now();
        const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const companyId = "220891";

        logger.info(`zaico v2へバーコード直指定で出庫データを送信します。伝票番号: ${slipNum}, 項目数: ${items.length}`);

        // zaicoのAPI仕様に合わせて deliveries の中にバーコードと数量を直接渡す
        const zaicoPayload = {
            num: slipNum,
            customer_name: "受注一括出荷",
            status: "completed_delivery",
            delivery_date: todayStr,
            date_of_issue: todayStr,
            memo: "統合管理システムからの自動出庫指示",
            deliveries: items.map(item => ({
                code: String(item.barcode || "").trim(), // バーコードの値をそのままキーにする
                quantity: String(item.pickCount)
            }))
        };

        const zaicoRes = await fetch(`https://web.zaico.co.jp/api/v2/orgs/companies/${companyId}/packing_slips.json`, {
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
            count: items.length,
            zaicoResponse: zaicoData
        });
    } catch (error) {
        logger.error("zaico出庫指示の送信でエラーが発生しました:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Slackへリクエストを送信する共通関数
async function sendSlackNotification(text) {
    try {
        const messageWithMention = `<!channel>\n` + text;
        await fetch(process.env.SLACK_WEBHOOK_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ text: messageWithMention }),
        });
    } catch (error) {
        logger.error("Slack通知の送信に失敗しました:", error);
    }
}
