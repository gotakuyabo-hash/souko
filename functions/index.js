const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp();
}

const slackWebhookUrl = defineSecret("SLACK_WEBHOOK_URL");

exports.checkIncompleteTasks = onSchedule(
    { schedule: "0 15 * * *", timeZone: "Asia/Tokyo", secrets: [slackWebhookUrl] },
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
                logger.info("未完了のチェック項目はありません。");
                return;
            }

            let messageText = `⏰ *定時になりましたが、以下のチェックが未完了です！* (${todayStr})\n`;
            uncheckedItems.forEach(title => {
                messageText += `>・ ${title}\n`;
            });

            await fetch(slackWebhookUrl.value(), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ text: messageText }),
            });

            logger.info("定時チェックのSlack通知を送信しました。");
        } catch (error) {
            logger.error("定時チェックの処理でエラーが発生しました:", error);
        }
    }
);
