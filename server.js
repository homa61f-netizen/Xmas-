const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const path = require('path');
const { kv } = require('@vercel/kv');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN || "8939362456:AAHsg7CDOZ_Dr5v2XxOXVVPZvXp6THu38ew";
const ADMIN_ID = process.env.ADMIN_ID || "8889600549";
const WEBAPP_URL = process.env.WEBAPP_URL || "https://xmas-gwhe.vercel.app";

const bot = new Telegraf(BOT_TOKEN);

// ================== Helper Functions ==================
async function getUser(userId) {
    const data = await kv.hgetall(`user:${userId}`);
    if (!data || Object.keys(data).length === 0) return null;
    return {
        user_id: userId,
        full_name: data.full_name,
        username: data.username,
        balance: parseFloat(data.balance || 0)
    };
}

async function saveUser(userId, full_name, username, balance = 0) {
    await kv.hset(`user:${userId}`, {
        full_name: full_name || 'مستخدم',
        username: username || '',
        balance: balance.toString()
    });
}

async function updateBalance(userId, newBalance) {
    await kv.hset(`user:${userId}`, { balance: newBalance.toString() });
}

async function getNextTxId() {
    return await kv.incr('tx_counter');
}

async function saveTx(tx) {
    await kv.hset(`tx:${tx.id}`, {
        user_id: tx.user_id,
        type: tx.type,
        method: tx.method,
        amount: tx.amount.toString(),
        details: tx.details || '',
        status: tx.status,
        created_at: Date.now().toString()
    });
    await kv.expire(`tx:${tx.id}`, 2592000); // 30 يوم
}

async function getTx(txId) {
    const data = await kv.hgetall(`tx:${txId}`);
    if (!data || Object.keys(data).length === 0) return null;
    return {
        id: txId,
        user_id: data.user_id,
        type: data.type,
        method: data.method,
        amount: parseFloat(data.amount),
        details: data.details,
        status: data.status,
        created_at: parseInt(data.created_at || 0)
    };
}

async function updateTxStatus(txId, status) {
    await kv.hset(`tx:${txId}`, { status });
}

// ================== Investments (Plans) ==================
async function getNextInvestId() {
    return await kv.incr('invest_counter');
}

async function saveInvestment(inv) {
    await kv.hset(`invest:${inv.id}`, {
        user_id: inv.user_id,
        plan_name: inv.plan_name,
        price: inv.price.toString(),
        return_amount: inv.return_amount.toString(),
        profit_percent: inv.profit_percent.toString(),
        status: inv.status, // ACTIVE | COMPLETED
        created_at: inv.created_at.toString(),
        expires_at: inv.expires_at.toString()
    });
    await kv.sadd(`user:${inv.user_id}:investments`, inv.id.toString());
}

async function getInvestment(invId) {
    const data = await kv.hgetall(`invest:${invId}`);
    if (!data || Object.keys(data).length === 0) return null;
    return {
        id: invId,
        user_id: data.user_id,
        plan_name: data.plan_name,
        price: parseFloat(data.price),
        return_amount: parseFloat(data.return_amount),
        profit_percent: parseFloat(data.profit_percent),
        status: data.status,
        created_at: parseInt(data.created_at),
        expires_at: parseInt(data.expires_at)
    };
}

async function updateInvestmentStatus(invId, status) {
    await kv.hset(`invest:${invId}`, { status });
}

async function getUserInvestments(userId) {
    const ids = await kv.smembers(`user:${userId}:investments`);
    if (!ids || ids.length === 0) return [];
    const results = await Promise.all(ids.map(id => getInvestment(id)));
    return results.filter(Boolean);
}

// ================== Auto-mature investments (24h) ==================
async function matureInvestments(userId) {
    const investments = await getUserInvestments(userId);
    const now = Date.now();
    let totalAdded = 0;

    for (const inv of investments) {
        if (inv.status === 'ACTIVE' && now >= inv.expires_at) {
            // أضف العائد (رأس المال + الربح) للرصيد
            const user = await getUser(userId);
            if (user) {
                await updateBalance(userId, user.balance + inv.return_amount);
                totalAdded += inv.return_amount;
            }
            await updateInvestmentStatus(inv.id, 'COMPLETED');

            // أرسل إشعار للمستخدم
            bot.telegram.sendMessage(userId,
                `🎉 *خطة ${inv.plan_name} انتهت!*\n\n` +
                `💰 رأس المال: $${inv.price}\n` +
                `📈 الربح: $${(inv.return_amount - inv.price).toFixed(2)}\n` +
                `✅ *الإجمالي المضاف: $${inv.return_amount.toFixed(2)}*`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }
    }
    return totalAdded;
}

// ================== Bot /start ==================
bot.start(async (ctx) => {
    try {
        const u = ctx.from;
        const userId = u.id.toString();

        const existing = await getUser(userId);
        if (!existing) {
            await saveUser(userId, u.first_name, u.username || '', 0);
        } else {
            await saveUser(userId, u.first_name, u.username || '', existing.balance);
        }

        await ctx.reply(`أهلاً بك ${u.first_name} في منصة الاستثمار السريع!`,
            Markup.inlineKeyboard([
                [Markup.button.webApp("🚀 فتح المنصة VIP", WEBAPP_URL)]
            ])
        );
    } catch (e) {
        console.error('start error:', e);
    }
});

// ================== API: Register ==================
app.post('/api/register', async (req, res) => {
    try {
        const { userId, name, username } = req.body;
        if (!userId) return res.status(400).json({ success: false });

        const existing = await getUser(userId);
        if (!existing) {
            await saveUser(userId, name, username, 0);
        } else {
            await saveUser(userId, name || existing.full_name, username || existing.username, existing.balance);
        }

        // معالجة الخطط المنتهية
        await matureInvestments(userId);

        res.json({ success: true });
    } catch (e) {
        console.error('register error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ================== API: Get User (with auto-mature) ==================
app.get('/api/user/:id', async (req, res) => {
    try {
        const userId = req.params.id;
        await matureInvestments(userId);
        const user = await getUser(userId);
        res.json(user || { balance: 0 });
    } catch (e) {
        console.error('getUser error:', e);
        res.status(500).json({ balance: 0 });
    }
});

// ================== API: Get User Stats ==================
app.get('/api/user/:id/stats', async (req, res) => {
    try {
        const userId = req.params.id;
        await matureInvestments(userId);

        const investments = await getUserInvestments(userId);
        const activeCount = investments.filter(i => i.status === 'ACTIVE').length;
        const totalProfit = investments
            .filter(i => i.status === 'COMPLETED')
            .reduce((sum, i) => sum + (i.return_amount - i.price), 0);

        // إجمالي الإيداع
        const txIds = await kv.smembers(`user:${userId}:txs`).catch(() => []);
        let totalDeposit = 0;
        if (txIds && txIds.length > 0) {
            const txs = await Promise.all(txIds.map(id => getTx(id)));
            totalDeposit = txs
                .filter(t => t && t.type === 'DEPOSIT' && t.status === 'APPROVED')
                .reduce((s, t) => s + t.amount, 0);
        }

        res.json({
            activePlans: activeCount,
            totalProfit: totalProfit.toFixed(2),
            totalDeposit: totalDeposit.toFixed(2),
            totalInvestments: investments.length
        });
    } catch (e) {
        console.error('stats error:', e);
        res.status(500).json({ activePlans: 0, totalProfit: '0.00', totalDeposit: '0.00' });
    }
});

// ================== API: Get User History ==================
app.get('/api/user/:id/history', async (req, res) => {
    try {
        const userId = req.params.id;
        const txIds = await kv.smembers(`user:${userId}:txs`).catch(() => []);
        const investIds = await kv.smembers(`user:${userId}:investments`).catch(() => []);

        const txs = txIds && txIds.length > 0
            ? (await Promise.all(txIds.map(id => getTx(id)))).filter(Boolean)
            : [];
        const invests = investIds && investIds.length > 0
            ? (await Promise.all(investIds.map(id => getInvestment(id)))).filter(Boolean)
            : [];

        const history = [
            ...txs.map(t => ({
                id: 'tx_' + t.id,
                type: t.type,
                amount: t.amount,
                method: t.method,
                details: t.details,
                status: t.status,
                created_at: t.created_at
            })),
            ...invests.map(i => ({
                id: 'inv_' + i.id,
                type: 'INVEST',
                amount: i.price,
                return_amount: i.return_amount,
                method: i.plan_name,
                details: `+${i.profit_percent}%`,
                status: i.status,
                created_at: i.created_at
            }))
        ].sort((a, b) => b.created_at - a.created_at);

        res.json(history);
    } catch (e) {
        console.error('history error:', e);
        res.status(500).json([]);
    }
});

// ================== API: Invest ==================
app.post('/api/invest', async (req, res) => {
    try {
        const { userId, planName, price } = req.body;

        // معالجة أي خطط منتهية أولاً
        await matureInvestments(userId);

        const user = await getUser(userId);
        if (!user || user.balance < price) {
            return res.status(400).json({ success: false, error: "عذراً، رصيدك غير كافٍ لتفعيل هذه الخطة." });
        }

        // احسب العائد
        const planReturns = {
            'STARTER':    { profit: 30, returnAmt: 13.00 },
            'PRO':        { profit: 35, returnAmt: 67.50 },
            'VIP':        { profit: 40, returnAmt: 140.00 },
            'ELITE':      { profit: 50, returnAmt: 750.00 },
            'DIAMOND':    { profit: 60, returnAmt: 1600.00 },
            'BLACK VIP':  { profit: 80, returnAmt: 9000.00 }
        };

        const plan = planReturns[planName];
        if (!plan) {
            return res.status(400).json({ success: false, error: "الخطة غير معروفة." });
        }

        // خصم الرصيد
        await updateBalance(userId, user.balance - price);

        // إنشاء الاستثمار
        const invId = await getNextInvestId();
        const now = Date.now();
        const expiresAt = now + (24 * 60 * 60 * 1000); // 24 ساعة

        await saveInvestment({
            id: invId,
            user_id: userId,
            plan_name: planName,
            price: price,
            return_amount: plan.returnAmt,
            profit_percent: plan.profit,
            status: 'ACTIVE',
            created_at: now,
            expires_at: expiresAt
        });

        // إشعار للأدمن
        await bot.telegram.sendMessage(
            ADMIN_ID,
            `📊 *استثمار جديد!*\n\n👤 المستخدم: \`${userId}\`\n🚀 الخطة: ${planName}\n💰 المبلغ: $${price} USD\n📈 الربح المتوقع: +${plan.profit}%\n⏰ ينتهي بعد 24 ساعة`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});

        res.json({
            success: true,
            investment: {
                id: invId,
                planName,
                price,
                returnAmount: plan.returnAmt,
                expiresAt: expiresAt
            }
        });
    } catch (e) {
        console.error('invest error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ================== API: Deposit ==================
app.post('/api/deposit', async (req, res) => {
    try {
        const { userId, userName, amount, method, details } = req.body;
        if (!amount || isNaN(amount)) return res.status(400).json({ success: false });

        const txId = await getNextTxId();
        await saveTx({
            id: txId,
            user_id: userId,
            type: 'DEPOSIT',
            method: method,
            amount: amount,
            details: details,
            status: 'PENDING'
        });
        await kv.sadd(`user:${userId}:txs`, txId.toString());

        await bot.telegram.sendMessage(ADMIN_ID,
            `📥 *طلب إيداع جديد!*\n\n👤 المستخدم: ${userName || 'مستخدم'} (\`${userId}\`)\n💰 المبلغ: *$${amount} USD*\n🌐 الوسيلة: ${method}\n🔍 التفاصيل: \`${details || 'لا توجد'}\``,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ موافقة', `approve_dep_${txId}`), Markup.button.callback('❌ رفض', `reject_dep_${txId}`)]
                ])
            }
        ).catch(() => {});

        res.json({ success: true, txId });
    } catch (e) {
        console.error('deposit error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ================== API: Withdraw ==================
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, userName, amount, method, address } = req.body;

        await matureInvestments(userId);

        const user = await getUser(userId);
        if (!user || user.balance < amount) {
            return res.status(400).json({ success: false, error: "الرصيد غير كافٍ" });
        }

        await updateBalance(userId, user.balance - amount);

        const txId = await getNextTxId();
        await saveTx({
            id: txId,
            user_id: userId,
            type: 'WITHDRAW',
            method: method,
            amount: amount,
            details: address,
            status: 'PENDING'
        });
        await kv.sadd(`user:${userId}:txs`, txId.toString());

        await bot.telegram.sendMessage(ADMIN_ID,
            `📤 *طلب سحب جديد!*\n\n👤 المستخدم: ${userName || 'مستخدم'} (\`${userId}\`)\n💸 المبلغ: *$${amount} USD*\n🌐 الوسيلة: ${method}\n📍 العنوان: \`${address}\``,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ موافقة', `approve_wit_${txId}`), Markup.button.callback('❌ رفض', `reject_wit_${txId}`)]
                ])
            }
        ).catch(() => {});

        res.json({ success: true, txId });
    } catch (e) {
        console.error('withdraw error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ================== Admin Actions ==================
bot.action(/^(approve|reject)_(dep|wit)_(\d+)$/, async (ctx) => {
    try {
        const action = ctx.match[1];
        const type = ctx.match[2];
        const txId = parseInt(ctx.match[3]);

        const tx = await getTx(txId);
        if (!tx || tx.status !== 'PENDING') {
            return ctx.answerCbQuery("⚠️ تم معالجة هذا الطلب مسبقاً.");
        }

        const user = await getUser(tx.user_id);

        if (action === 'approve') {
            await updateTxStatus(txId, 'APPROVED');
            if (type === 'dep') {
                if (user) await updateBalance(tx.user_id, user.balance + tx.amount);
                await bot.telegram.sendMessage(tx.user_id,
                    `✅ *تمت الموافقة على إيداعك!*\nتم إضافة $${tx.amount} إلى رصيدك.`,
                    { parse_mode: 'Markdown' }).catch(() => {});
            } else {
                await bot.telegram.sendMessage(tx.user_id,
                    `✅ *تمت الموافقة على طلب السحب!*\nتم تحويل $${tx.amount} إلى حسابك بنجاح.`,
                    { parse_mode: 'Markdown' }).catch(() => {});
            }
            await ctx.editMessageText(
                `${ctx.callbackQuery.message.text}\n\n🟢 *حالة الطلب: تم القبول*`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        } else {
            await updateTxStatus(txId, 'REJECTED');
            if (type === 'wit') {
                if (user) await updateBalance(tx.user_id, user.balance + tx.amount);
                await bot.telegram.sendMessage(tx.user_id,
                    `❌ *تم رفض طلب السحب.*\nتم إعادة $${tx.amount} إلى رصيد محفظتك.`,
                    { parse_mode: 'Markdown' }).catch(() => {});
            } else {
                await bot.telegram.sendMessage(tx.user_id,
                    `❌ *تم رفض طلب الإيداع الخاص بك.*`,
                    { parse_mode: 'Markdown' }).catch(() => {});
            }
            await ctx.editMessageText(
                `${ctx.callbackQuery.message.text}\n\n🔴 *حالة الطلب: تم الرفض*`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }
        ctx.answerCbQuery("تمت المعالجة بنجاح").catch(() => {});
    } catch (e) {
        console.error('action error:', e);
        ctx.answerCbQuery("حدث خطأ").catch(() => {});
    }
});

// ================== Telegram Webhook ==================
app.post('/api/webhook', async (req, res) => {
    try {
        await bot.handleUpdate(req.body);
        res.status(200).send('OK');
    } catch (err) {
        console.error('webhook error:', err);
        res.status(500).send(err.toString());
    }
});

// ================== Health ==================
app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
});

// ================== Serve Frontend ==================
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

module.exports = app;
