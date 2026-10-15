const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp();
}

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

// 1. material_orders（資材発注など）の更新通知（即時通知）
exports.notifyMaterialOrders = onDocumentWritten(
    { document: "material_orders/{docId}" },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const docId = event.params.docId;

        let messageText = `📦 *資材発注データが更新されました！*\n>・ *ID/日付:* ${docId}`;
        await sendSlackNotification(messageText);
    }
);

// 2. shared_notes（共有ノートなど）の更新通知（即時通知）
exports.notifySharedNotes = onDocumentWritten(
    { document: "shared_notes/{docId}" },
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
    { document: "shukka_records/{dateId}" },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const dateId = event.params.dateId;

        // 15分以内の連続更新なら通知をブロック
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

// 4. staff_requests（スタッフからの要望・依頼など）の更新通知（即時通知）
exports.notifyStaffRequests = onDocumentWritten(
    { document: "staff_requests/{docId}" },
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
    { document: "warehouse_reports/{dateId}" },
    async (event) => {
        const snap = event.data;
        if (!snap || !snap.after.exists) return;
        const dateId = event.params.dateId;

        // 15分以内の連続更新なら通知をブロック
        if (!canSendNotification(`warehouse_reports_${dateId}`)) return;

        const data = snap.after.data();
        const reporterName = data.name || "未設定";

        let messageText = `📋 *日次報告チェックリストが更新されました！*\n>・ *対象日:* ${dateId}\n>・ *管理者:* ${reporterName}`;
        await sendSlackNotification(messageText);
    }
);

// 定時チェック機能（毎日15:00に warehouse_reports の未完了をチェック）
exports.checkIncompleteTasks = onSchedule(
    { schedule: "0 15 * * *", timeZone: "Asia/Tokyo" },
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

            await sendSlackNotification(messageText);
            logger.info("定時チェックのSlack通知を送信しました。");
        } catch (error) {
            logger.error("定時チェックの処理でエラーが発生しました:", error);
        }
    }
);

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
