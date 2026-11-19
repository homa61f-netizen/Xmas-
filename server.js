const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const path = require('path');
const { kv } = require('@vercel/kv');

const app = express();
app.use(express.json());

// ✅ تحويل صارم لـ string + trim لمنع أي مشاكل
const BOT_TOKEN = String(process.env.BOT_TOKEN || "8908252305:AAFnTvaJNt4eNCd9-bRNIhqnmyVSEGu9NIk").trim();
const ADMIN_ID  = String(process.env.ADMIN_ID  || "8889600549").trim();
const WEBAPP_URL = String(process.env.WEBAPP_URL || "https://xmas-gwhe.vercel.app").trim();

console.log('🔍 ADMIN_ID =', JSON.stringify(ADMIN_ID), '| type =', typeof ADMIN_ID);

const bot = new Telegraf(BOT_TOKEN);

// ================== STRICT Admin Check ==================
function isAdmin(userId) {
    if (userId === undefined || userId === null) return false;
    return String(userId).trim() === ADMIN_ID;
}

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

async function getNextTxId() { return await kv.incr('tx_counter'); }

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
    await kv.expire(`tx:${tx.id}`, 2592000);
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

// ================== Investments ==================
async function getNextInvestId() { return await kv.incr('invest_counter'); }

async function saveInvestment(inv) {
    await kv.hset(`invest:${inv.id}`, {
        user_id: inv.user_id,
        plan_name: inv.plan_name,
        price: inv.price.toString(),
        return_amount: inv.return_amount.toString(),
        profit_percent: inv.profit_percent.toString(),
        status: inv.status,
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

async function matureInvestments(userId) {
    const investments = await getUserInvestments(userId);
    const now = Date.now();
    let totalAdded = 0;
    for (const inv of investments) {
        if (inv.status === 'ACTIVE' && now >= inv.expires_at) {
            const user = await getUser(userId);
            if (user) {
                await updateBalance(userId, user.balance + inv.return_amount);
                totalAdded += inv.return_amount;
            }
            await updateInvestmentStatus(inv.id, 'COMPLETED');
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

// ================== Admin Menu & State ==================
function adminMainMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('👥 قائمة المستخدمين', 'admin_users_list')],
        [Markup.button.callback('🔍 عرض رصيد مستخدم', 'admin_balance_check')],
        [Markup.button.callback('➕ إضافة رصيد', 'admin_balance_add')],
        [Markup.button.callback('➖ خصم رصيد', 'admin_balance_sub')],
        [Markup.button.callback('📊 إحصائيات سريعة', 'admin_stats')]
    ]);
}

const adminState = new Map(); // adminId -> { action, targetUser }

// ================== Bot /start ==================
bot.start(async (ctx) => {
    try {
        const u = ctx.from;
        const userId = String(u.id);

        const existing = await getUser(userId);
        const isNew = !existing;

        if (!existing) {
            await saveUser(userId, u.first_name, u.username || '', 0);
        } else {
            await saveUser(userId, u.first_name, u.username || '', existing.balance);
        }

        // إشعار الأدمن عند تسجيل مستخدم جديد
        if (isNew && !isAdmin(userId)) {
            bot.telegram.sendMessage(
                ADMIN_ID,
                `🆕 *مستخدم جديد سجّل!*\n\n` +
                `👤 ${u.first_name || 'غير معروف'}\n` +
                `🆔 \`${userId}\`\n` +
                `📛 ${u.username ? '@' + u.username : 'لا يوجد'}`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }

        // ✅ بناء الأزرار — زر الأدمن يظهر فقط لو المستخدم أدمن
        const buttons = [[Markup.button.webApp("🚀 فتح المنصة VIP", WEBAPP_URL)]];

        if (isAdmin(userId)) {
            buttons.push([Markup.button.callback('⚙️ لوحة التحكم', 'admin_panel')]);
        }

        await ctx.reply(
            `أهلاً بك ${u.first_name} في منصة الاستثمار السريع!`,
            Markup.inlineKeyboard(buttons)
        );
    } catch (e) {
        console.error('start error:', e);
    }
});

// ================== Admin Panel (محمي) ==================
bot.action('admin_panel', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        return ctx.answerCbQuery('⛔ غير مصرح لك بالوصول', { show_alert: true }).catch(() => {});
    }
    const user = await getUser(String(ctx.from.id));
    await ctx.editMessageText(
        `⚙️ *لوحة تحكم الأدمن*\n\n` +
        `💰 رصيدك: $${user ? user.balance.toFixed(2) : '0.00'}\n\n` +
        `اختر العملية:`,
        { parse_mode: 'Markdown', ...adminMainMenu() }
    ).catch(() => {});
});

// ================== Admin Stats (محمي) ==================
bot.action('admin_stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ غير مصرح', { show_alert: true }).catch(() => {});

    const totalTx = parseInt(await kv.get('tx_counter') || '0');
    const totalInv = parseInt(await kv.get('invest_counter') || '0');

    await ctx.editMessageText(
        `📊 *إحصائيات سريعة*\n\n` +
        `💳 إجمالي المعاملات: ${totalTx}\n` +
        `📈 إجمالي الاستثمارات: ${totalInv}`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع', 'admin_panel')]])
        }
    ).catch(() => {});
});

// ================== Users List (محمي) ==================
bot.action('admin_users_list', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ غير مصرح', { show_alert: true }).catch(() => {});
    await ctx.editMessageText(
        `👥 *قائمة المستخدمين*\n\n` +
        `للبحث عن مستخدم:\n\`/user <user_id>\`\n\n` +
        `مثال:\n\`/user 123456789\``,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع', 'admin_panel')]])
        }
    ).catch(() => {});
});

// ================== Balance Check (محمي) ==================
bot.action('admin_balance_check', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ غير مصرح', { show_alert: true }).catch(() => {});
    adminState.set(String(ctx.from.id), { action: 'check', targetUser: null });
    await ctx.editMessageText(
        `🔍 *عرض رصيد مستخدم*\n\nأرسل أيدي المستخدم (User ID):`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء', 'admin_cancel')]])
        }
    ).catch(() => {});
});

// ================== Balance Add (محمي) ==================
bot.action('admin_balance_add', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ غير مصرح', { show_alert: true }).catch(() => {});
    adminState.set(String(ctx.from.id), { action: 'add', targetUser: null });
    await ctx.editMessageText(
        `➕ *إضافة رصيد*\n\nأرسل أيدي المستخدم:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء', 'admin_cancel')]])
        }
    ).catch(() => {});
});

// ================== Balance Sub (محمي) ==================
bot.action('admin_balance_sub', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ غير مصرح', { show_alert: true }).catch(() => {});
    adminState.set(String(ctx.from.id), { action: 'sub', targetUser: null });
    await ctx.editMessageText(
        `➖ *خصم رصيد*\n\nأرسل أيدي المستخدم:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء', 'admin_cancel')]])
        }
    ).catch(() => {});
});

// ================== Cancel (محمي) ==================
bot.action('admin_cancel', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ غير مصرح', { show_alert: true }).catch(() => {});
    adminState.delete(String(ctx.from.id));
    await ctx.editMessageText(
        `⚙️ *لوحة تحكم الأدمن*\n\nاختر عملية:`,
        { parse_mode: 'Markdown', ...adminMainMenu() }
    ).catch(() => {});
});

// ================== Admin Commands (محمي) ==================
bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ هذا الأمر للأدمن فقط.').catch(() => {});
    const user = await getUser(String(ctx.from.id));
    await ctx.reply(
        `⚙️ *لوحة تحكم الأدمن*\n\n💰 رصيدك: $${user ? user.balance.toFixed(2) : '0.00'}`,
        { parse_mode: 'Markdown', ...adminMainMenu() }
    ).catch(() => {});
});

bot.command('user', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ هذا الأمر للأدمن فقط.').catch(() => {});
    const parts = ctx.message.text.split(' ');
    if (!parts[1]) return ctx.reply('❌ استخدم: /user <user_id>').catch(() => {});
    const target = await getUser(parts[1]);
    if (!target) return ctx.reply('❌ المستخدم غير موجود.').catch(() => {});
    await ctx.reply(
        `👤 *بيانات المستخدم*\n\n` +
        `🆔 \`${target.user_id}\`\n` +
        `📛 ${target.full_name}\n` +
        `🔗 ${target.username ? '@' + target.username : 'لا يوجد'}\n` +
        `💰 *$${target.balance.toFixed(2)}*`,
        { parse_mode: 'Markdown' }
    ).catch(() => {});
});

// ================== Admin Text Handler (محمي) ==================
bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;

    const adminId = String(ctx.from.id);
    if (!isAdmin(adminId)) return; // ← حماية صارمة

    const state = adminState.get(adminId);
    if (!state) return;

    const text = ctx.message.text.trim();

    // المرحلة 1: استلام الآيدي
    if (!state.targetUser) {
        if (!/^\d+$/.test(text)) return ctx.reply('❌ أرسل أيدي رقمي صحيح.').catch(() => {});
        const target = await getUser(text);
        if (!target) return ctx.reply('❌ المستخدم غير موجود.').catch(() => {});

        state.targetUser = text;
        adminState.set(adminId, state);

        const actionLabel = { check: 'الرصيد', add: 'المبلغ', sub: 'المبلغ' }[state.action];

        await ctx.reply(
            `👤 *${target.full_name}* (\`${text}\`)\n` +
            `💰 *الرصيد:* $${target.balance.toFixed(2)}\n\n` +
            (state.action === 'check' ? `✅ هذا رصيد المستخدم.` : `📝 أرسل ${actionLabel}:`),
            {
                parse_mode: 'Markdown',
                ...(state.action === 'check'
                    ? Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع', 'admin_panel')]])
                    : Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء', 'admin_cancel')]]))
            }
        ).catch(() => {});

        if (state.action === 'check') adminState.delete(adminId);
        return;
    }

    // المرحلة 2: استلام المبلغ
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) return ctx.reply('❌ أرسل مبلغاً صحيحاً.').catch(() => {});

    const target = await getUser(state.targetUser);
    if (!target) {
        adminState.delete(adminId);
        return ctx.reply('❌ المستخدم غير موجود.').catch(() => {});
    }

    let newBalance = target.balance;
    let actionLabel = '';

    if (state.action === 'add') {
        newBalance = target.balance + amount;
        actionLabel = '➕ إضافة';
    } else if (state.action === 'sub') {
        if (target.balance < amount) return ctx.reply(`❌ الرصيد ($${target.balance.toFixed(2)}) أقل من المبلغ.`).catch(() => {});
        newBalance = target.balance - amount;
        actionLabel = '➖ خصم';
    }

    await updateBalance(state.targetUser, newBalance);
    adminState.delete(adminId);

    await ctx.reply(
        `✅ *تمت العملية!*\n\n` +
        `👤 ${target.full_name} (\`${state.targetUser}\`)\n` +
        `📝 ${actionLabel} $${amount.toFixed(2)}\n` +
        `💰 قبل: $${target.balance.toFixed(2)}\n` +
        `💰 بعد: $${newBalance.toFixed(2)}`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 لوحة التحكم', 'admin_panel')]])
        }
    ).catch(() => {});

    bot.telegram.sendMessage(
        state.targetUser,
        `💳 *تحديث رصيدك*\n\n${actionLabel} *$${amount.toFixed(2)}*\n💰 الرصيد الحالي: *$${newBalance.toFixed(2)}*`,
        { parse_mode: 'Markdown' }
    ).catch(() => {});
});

// ================== API: Register ==================
app.post('/api/register', async (req, res) => {
    try {
        const { userId, name, username } = req.body;
        if (!userId) return res.status(400).json({ success: false });

        const existing = await getUser(String(userId));
        const isNew = !existing;

        if (!existing) {
            await saveUser(userId, name, username, 0);
        } else {
            await saveUser(userId, name || existing.full_name, username || existing.username, existing.balance);
        }

        if (isNew && !isAdmin(userId)) {
            bot.telegram.sendMessage(
                ADMIN_ID,
                `🆕 *مستخدم جديد!*\n\n👤 ${name || 'غير معروف'}\n🆔 \`${userId}\`\n📛 ${username ? '@' + username : 'لا يوجد'}`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }

        await matureInvestments(userId);
        res.json({ success: true });
    } catch (e) {
        console.error('register error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ================== API: Get User ==================
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

// ================== API: User Stats ==================
app.get('/api/user/:id/stats', async (req, res) => {
    try {
        const userId = req.params.id;
        await matureInvestments(userId);
        const investments = await getUserInvestments(userId);
        const activeCount = investments.filter(i => i.status === 'ACTIVE').length;
        const totalProfit = investments
            .filter(i => i.status === 'COMPLETED')
            .reduce((sum, i) => sum + (i.return_amount - i.price), 0);

        const txIds = await kv.smembers(`user:${userId}:txs`).catch(() => []);
        let totalDeposit = 0;
        if (txIds && txIds.length > 0) {
            const txs = await Promise.all(txIds.map(id => getTx(id)));
            totalDeposit = txs.filter(t => t && t.type === 'DEPOSIT' && t.status === 'APPROVED')
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

// ================== API: History ==================
app.get('/api/user/:id/history', async (req, res) => {
    try {
        const userId = req.params.id;
        const txIds = await kv.smembers(`user:${userId}:txs`).catch(() => []);
        const investIds = await kv.smembers(`user:${userId}:investments`).catch(() => []);

        const txs = txIds && txIds.length > 0 ? (await Promise.all(txIds.map(id => getTx(id)))).filter(Boolean) : [];
        const invests = investIds && investIds.length > 0 ? (await Promise.all(investIds.map(id => getInvestment(id)))).filter(Boolean) : [];

        const history = [
            ...txs.map(t => ({ id: 'tx_' + t.id, type: t.type, amount: t.amount, method: t.method, details: t.details, status: t.status, created_at: t.created_at })),
            ...invests.map(i => ({ id: 'inv_' + i.id, type: 'INVEST', amount: i.price, return_amount: i.return_amount, method: i.plan_name, details: `+${i.profit_percent}%`, status: i.status, created_at: i.created_at }))
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
        await matureInvestments(userId);

        const user = await getUser(userId);
        if (!user || user.balance < price) return res.status(400).json({ success: false, error: "الرصيد غير كافٍ." });

        const planReturns = {
            'STARTER':    { profit: 30, returnAmt: 13.00 },
            'PRO':        { profit: 35, returnAmt: 67.50 },
            'VIP':        { profit: 40, returnAmt: 140.00 },
            'ELITE':      { profit: 50, returnAmt: 750.00 },
            'DIAMOND':    { profit: 60, returnAmt: 1600.00 },
            'BLACK VIP':  { profit: 80, returnAmt: 9000.00 }
        };

        const plan = planReturns[planName];
        if (!plan) return res.status(400).json({ success: false, error: "الخطة غير معروفة." });

        await updateBalance(userId, user.balance - price);

        const invId = await getNextInvestId();
        const now = Date.now();
        const expiresAt = now + (24 * 60 * 60 * 1000);

        await saveInvestment({
            id: invId, user_id: userId, plan_name: planName, price: price,
            return_amount: plan.returnAmt, profit_percent: plan.profit,
            status: 'ACTIVE', created_at: now, expires_at: expiresAt
        });

        await bot.telegram.sendMessage(ADMIN_ID,
            `📊 *استثمار جديد!*\n\n👤 \`${userId}\`\n🚀 ${planName}\n💰 $${price}\n📈 +${plan.profit}%`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});

        res.json({ success: true, investment: { id: invId, planName, price, returnAmount: plan.returnAmt, expiresAt } });
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
        await saveTx({ id: txId, user_id: userId, type: 'DEPOSIT', method, amount, details, status: 'PENDING' });
        await kv.sadd(`user:${userId}:txs`, txId.toString());

        await bot.telegram.sendMessage(ADMIN_ID,
            `📥 *إيداع جديد!*\n\n👤 ${userName || 'مستخدم'} (\`${userId}\`)\n💰 *$${amount} USD*\n🌐 ${method}\n🔍 \`${details || 'لا يوجد'}\``,
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
        if (!user || user.balance < amount) return res.status(400).json({ success: false, error: "الرصيد غير كافٍ" });

        await updateBalance(userId, user.balance - amount);

        const txId = await getNextTxId();
        await saveTx({ id: txId, user_id: userId, type: 'WITHDRAW', method, amount, details: address, status: 'PENDING' });
        await kv.sadd(`user:${userId}:txs`, txId.toString());

        await bot.telegram.sendMessage(ADMIN_ID,
            `📤 *سحب جديد!*\n\n👤 ${userName || 'مستخدم'} (\`${userId}\`)\n💸 *$${amount} USD*\n🌐 ${method}\n📍 \`${address}\``,
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

// ================== Approve/Reject (محمي) ==================
bot.action(/^(approve|reject)_(dep|wit)_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ غير مصرح', { show_alert: true }).catch(() => {});

    try {
        const action = ctx.match[1];
        const type = ctx.match[2];
        const txId = parseInt(ctx.match[3]);

        const tx = await getTx(txId);
        if (!tx || tx.status !== 'PENDING') return ctx.answerCbQuery("⚠️ تم معالجة الطلب مسبقاً.").catch(() => {});

        const user = await getUser(tx.user_id);

        if (action === 'approve') {
            await updateTxStatus(txId, 'APPROVED');
            if (type === 'dep') {
                if (user) await updateBalance(tx.user_id, user.balance + tx.amount);
                await bot.telegram.sendMessage(tx.user_id, `✅ *تمت الموافقة على إيداعك!*\nتم إضافة $${tx.amount} لرصيدك.`, { parse_mode: 'Markdown' }).catch(() => {});
            } else {
                await bot.telegram.sendMessage(tx.user_id, `✅ *تمت الموافقة على سحبك!*\nتم تحويل $${tx.amount}.`, { parse_mode: 'Markdown' }).catch(() => {});
            }
            await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n🟢 *تم القبول*`, { parse_mode: 'Markdown' }).catch(() => {});
        } else {
            await updateTxStatus(txId, 'REJECTED');
            if (type === 'wit') {
                if (user) await updateBalance(tx.user_id, user.balance + tx.amount);
                await bot.telegram.sendMessage(tx.user_id, `❌ *تم رفض السحب.*\nتم إعادة $${tx.amount}.`, { parse_mode: 'Markdown' }).catch(() => {});
            } else {
                await bot.telegram.sendMessage(tx.user_id, `❌ *تم رفض الإيداع.*`, { parse_mode: 'Markdown' }).catch(() => {});
            }
            await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n🔴 *تم الرفض*`, { parse_mode: 'Markdown' }).catch(() => {});
        }
        ctx.answerCbQuery("تمت المعالجة").catch(() => {});
    } catch (e) {
        console.error('action error:', e);
        ctx.answerCbQuery("حدث خطأ").catch(() => {});
    }
});

// ================== Webhook & Health ==================
app.post('/api/webhook', async (req, res) => {
    try {
        await bot.handleUpdate(req.body);
        res.status(200).send('OK');
    } catch (err) {
        console.error('webhook error:', err);
        res.status(500).send(err.toString());
    }
});

app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

module.exports = app;
