const { onRequest } = require("firebase-functions/v2/https");
const functions = require("firebase-functions");
const logger = require("firebase-functions/logger");

// zaico出庫指示用API（memo削除 & customer_nameを引数で受け取る仕様）
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
        const customerName = req.body.customerName || "受注一括出荷";

        if (!items || !Array.isArray(items) || items.length === 0) {
            res.status(400).json({ success: false, error: "Invalid items data" });
            return;
        }

        const companyId = "220891";
        logger.info(`出荷対象 ${items.length} 件のinventory_idをzaicoからピンポイントで取得します...`);

        const targetBarcodes = new Set(items.map(item => String(item.barcode).trim()));
        const codeToInventoryIdMap = new Map();

        let page = 1;
        let hasMore = true;
        const perPage = 100;

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
