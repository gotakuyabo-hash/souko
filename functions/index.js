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

// zaico出庫指示用API（必要な商品だけピンポイントで在庫IDを逆引きして送信）
exports.apiCreateZaicoShipment = functions.region("asia-northeast1").https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    try {
        const items = req.body.items; // フロントから送られてきた出荷対象の配列（barcode, pickCount など）
        if (!items || !Array.isArray(items) || items.length === 0) {
            res.status(400).json({ success: false, error: "Invalid items data" });
            return;
        }

        const companyId = "220891";
        logger.info(`出荷対象 ${items.length} 件のinventory_idをzaicoからピンポイントで取得します...`);

        // 1. zaicoから全件取得する代わりに、必要なバーコードごとにinventory_idを逆引きする
        // （※zaicoの検索機能や全件から該当分をマッピングできるように効率よく取得、あるいは必要最小限のページネーション）
        // ※もしzaico APIにコード検索パラメータがあれば理想ですが、確実な方法として、
        // キャッシュを持たない場合は最小限のフェッチでマッチングさせます。
        
        // ここでは、zaicoの在庫一覧から該当するバーコードのIDを効率よく探すため、
        // ページネーションを回しつつ「必要なコードが見つかったら即座に抽出する」仕組みにします。
        const targetBarcodes = new Set(items.map(item => String(item.barcode).trim()));
        const codeToInventoryIdMap = new Map();

        let page = 1;
        let hasMore = true;
        const perPage = 100;

        // 全てのコードが見つかるか、ページが尽きるまで取得（通常は数ページでヒットします）
        while (hasMore && codeToInventoryIdMap.size < targetBarcodes.size) {
            const url = `https://web.zaico.co.jp/api/v2/orgs/companies/${companyId}/inventories.json?page=${page}&per_page=${perPage}`;
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

            // 取得したリストの中から、今回の出荷対象のバーコードと一致するものを探す
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

            // 無限ループ防止（安全装置）
            if (page > 30) break;
        }

        // 2. 取得できた inventory_id をもとに、出庫データの明細（deliveries）を組み立てる
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

       // 3. zaicoへ出庫指示（packing_slips.json）をPOST送信
        const slipNum = "SLIP-" + Date.now();
        const todayStr = new Date().toISOString().split('T')[0];

        const zaicoPayload = {
            num: slipNum,
            customer_name: "受注一括出荷",
            status: "before_delivery", // ← ここを before_delivery に変更しました
            delivery_date: todayStr,
            date_of_issue: todayStr,
            memo: "統合管理システムからのピンポイント出庫指示",
            deliveries: deliveries
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
            count: deliveries.length,
            missingCount: missingBarcodes.length,
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
