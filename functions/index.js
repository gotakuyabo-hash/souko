// zaico出庫指示受け付け用API（バーコードキー対応版）
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
        logger.info(`zaico v2へバーコードキーで出庫データを送信します。伝票番号: ${slipNum}, 項目数: ${items.length}`);

        // zaico v2 API仕様：バーコード（code）をキーにして明細を作成
        const zaicoPayload = {
            num: slipNum,
            customer_name: "受注一括出荷",
            status: "completed_delivery", // 完了ステータスにして在庫を減算
            delivery_date: todayStr,
            date_of_issue: todayStr,
            memo: "統合管理システムからの自動出庫指示",
            deliveries: items.map(item => ({
                code: item.barcode,       // バーコードの値をキーに指定
                quantity: item.pickCount, // ピック数（出庫数）
                status: "completed_delivery"
            }))
        };

        const companyId = "220891";
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
