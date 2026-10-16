// zaico出庫指示受け付け用API（zaico API連携実装版）
exports.apiCreateZaicoShipment = functions.region("asia-northeast1").https.onRequest(async (req, res) => {
    // CORSを許可するヘッダーを付与
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
        logger.info(`zaicoへ出庫データを送信します。伝票番号: ${slipNum}, 項目数: ${items.length}`);

        // zaico API の出庫データ作成エンドポイントへ送信
        // バーコード (item.barcode) と ピック数 (item.pickCount) を紐付けます
        const zaicoPayload = {
            packing_slip: {
                packing_slip_no: slipNum,
                memo: "受注一括出庫指示",
                packing_slip_items_attributes: items.map(item => ({
                    code: item.barcode,       // バーコード
                    quantity: item.pickCount  // ピック数
                }))
            }
        };

        const zaicoRes = await fetch(`https://web.zaico.co.jp/api/v1/packing_slips`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${ZAICO_API_TOKEN}`
            },
            body: JSON.stringify(zaicoPayload)
        });

        const zaicoData = await zaicoRes.json();

        if (!zaicoRes.ok) {
            logger.error("zaico API エラーレスポンス:", zaicoData);
            res.status(500).json({ success: false, error: "zaico API Error: " + JSON.stringify(zaicoData) });
            return;
        }

        logger.info("zaico 出庫登録成功:", zaicoData);
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
