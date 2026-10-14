const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

// Firebase Adminの初期化（まだ書いていない場合は必要です）
if (!admin.apps.length) {
    admin.initializeApp();
}

const slackWebhookUrl = defineSecret("SLACK_WEBHOOK_URL");

// 毎日「定時（例: 18時00分）」に実行するスケジュール設定
// cron形式: "0 18 * * *" （毎日18:00）
exports.checkIncompleteTasks = onSchedule(
    { schedule: "0 15 * * *", timeZone: "Asia/Tokyo", secrets: [slackWebhookUrl] },
    async (event) => {
        const db = admin.firestore();

        try {
            // "notes" や "tasks" など、チェックリストを保存しているコレクションを指定
            const snapshot = await db.collection("warehouse_reports").where("checked", "==", false).get();

            if (snapshot.empty) {
                logger.info("未完了の項目はありません。");
                return;
            }

            // 未完了の項目がある場合、リストをまとめる
            let messageText = "⏰ *定時になりましたが、以下の未完了の項目があります！*\n";
            snapshot.forEach((doc) => {
                const data = doc.data();
                const title = data.title || "無題";
                messageText += `>・ ${title}\n`;
            });

            // Slackへ通知を送信
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
