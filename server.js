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
        status: tx.status
    });
    await kv.expire(`tx:${tx.id}`, 604800); // 7 أيام
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
        status: data.status
    };
}

async function updateTxStatus(txId, status) {
    await kv.hset(`tx:${txId}`, { status });
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
        ctx.reply("حدث خطأ، حاول مرة أخرى.").catch(() => {});
    }
});

// ================== API Routes ==================

// تسجيل المستخدم
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
        res.json({ success: true });
    } catch (e) {
        console.error('register error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// جلب رصيد المستخدم
app.get('/api/user/:id', async (req, res) => {
    try {
        const user = await getUser(req.params.id);
        res.json(user || { balance: 0 });
    } catch (e) {
        console.error('getUser error:', e);
        res.status(500).json({ balance: 0 });
    }
});

// تفعيل خطة استثمارية
app.post('/api/invest', async (req, res) => {
    try {
        const { userId, planName, price } = req.body;
        const user = await getUser(userId);

        if (!user || user.balance < price) {
            return res.status(400).json({ success: false, error: "عذراً، رصيدك غير كافٍ لتفعيل هذه الخطة." });
        }

        await updateBalance(userId, user.balance - price);

        await bot.telegram.sendMessage(
            ADMIN_ID,
            `📊 *استثمار جديد!*\n\n👤 المستخدم: \`${userId}\`\n🚀 الخطة: ${planName}\n💰 المبلغ الخصم: $${price} USD`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});

        res.json({ success: true });
    } catch (e) {
        console.error('invest error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// طلب إيداع
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

        await bot.telegram.sendMessage(ADMIN_ID,
            `📥 *طلب إيداع جديد!*\n\n👤 المستخدم: ${userName || 'مستخدم'} (\`${userId}\`)\n💰 المبلغ: *$${amount} USD*\n🌐 الوسيلة: ${method}\n🔍 التفاصيل: \`${details || 'لا توجد'}\``,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ موافقة', `approve_dep_${txId}`), Markup.button.callback('❌ رفض', `reject_dep_${txId}`)]
                ])
            }
        ).catch(() => {});

        res.json({ success: true });
    } catch (e) {
        console.error('deposit error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// طلب سحب
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, userName, amount, method, address } = req.body;
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

        await bot.telegram.sendMessage(ADMIN_ID,
            `📤 *طلب سحب جديد!*\n\n👤 المستخدم: ${userName || 'مستخدم'} (\`${userId}\`)\n💸 المبلغ: *$${amount} USD*\n🌐 الوسيلة: ${method}\n📍 العنوان/الرقم: \`${address}\``,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ موافقة', `approve_wit_${txId}`), Markup.button.callback('❌ رفض', `reject_wit_${txId}`)]
                ])
            }
        ).catch(() => {});

        res.json({ success: true });
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

// ================== Health Check ==================
app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
});

// ================== Serve Frontend ==================
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

module.exports = app;
