const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");

// SlackのWebhook URLを安全なシークレットとして定義
const slackWebhookUrl = defineSecret("SLACK_WEBHOOK_URL");

exports.notifySlackOnNewNote = onDocumentCreated(
    { document: "notes/{noteId}", secrets: [slackWebhookUrl] }, 
    async (event) => {
        const snap = event.data;
        if (!snap) {
            return;
        }

        const newValue = snap.data();
        const title = newValue.title || "無題のノート";
        const author = newValue.author || "不明なユーザー";

        // Slackに送るメッセージ
        const slackMessage = {
            text: `📝 *新しいノートが追加されました!*\n> *タイトル:* ${title}\n> *作成者:* ${author}`
        };

        try {
            // シークレットから取得したURLを使用
            await fetch(slackWebhookUrl.value(), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(slackMessage),
            });

            logger.info("Slack通知の送信に成功しました");
        } catch (error) {
            logger.error("Slack通知の送信に失敗しました:", error);
        }
    }
);
