const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const BOT_TOKEN = process.env.BOT_TOKEN || "8939362456:AAHsg7CDOZ_Dr5v2XxOXVVPZvXp6THu38ew";
const ADMIN_ID = process.env.ADMIN_ID || "8889600549";
const bot = new Telegraf(BOT_TOKEN);

// التخزين المؤقت في الذاكرة لضمان عمل المنصة بثبات تام على Vercel
const memoryDb = {
    users: {},
    transactions: []
};

let txCounter = 1;

// أوامر البوت عند الضغط على Start
bot.start((ctx) => {
    const u = ctx.from;
    const userId = u.id.toString();
    
    if (!memoryDb.users[userId]) {
        memoryDb.users[userId] = {
            user_id: userId,
            full_name: u.first_name,
            username: u.username || '',
            balance: 0.0
        };
    } else {
        memoryDb.users[userId].full_name = u.first_name;
        memoryDb.users[userId].username = u.username || '';
    }
    
    const webAppUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://xmas-n11fcwtmy-gwhe.vercel.app";
    
    ctx.reply(`أهلاً بك ${u.first_name} في منصة الاستثمار السريع!`, 
        Markup.inlineKeyboard([
            [Markup.button.webApp("🚀 فتح المنصة VIP", webAppUrl)]
        ])
    );
});

// تسجيل المستخدم من الـ Web App تلقائياً
app.post('/api/register', (req, res) => {
    const { userId, name, username } = req.body;
    if (!userId) return res.status(400).json({ success: false });

    if (!memoryDb.users[userId]) {
        memoryDb.users[userId] = {
            user_id: userId,
            full_name: name || 'مستخدم',
            username: username || '',
            balance: 0.0
        };
    }
    res.json({ success: true });
});

// جلب رصيد المستخدم
app.get('/api/user/:id', (req, res) => {
    const userId = req.params.id;
    const user = memoryDb.users[userId] || { balance: 0.0 };
    res.json(user);
});

// تفعيل الخطة الاستثمارية وخصم الرصيد فوراً
app.post('/api/invest', (req, res) => {
    const { userId, planName, price } = req.body;
    const user = memoryDb.users[userId];

    if (!user || user.balance < price) {
        return res.status(400).json({ success: false, error: "عذراً، رصيدك غير كافٍ لتفعيل هذه الخطة." });
    }

    user.balance -= price;

    bot.telegram.sendMessage(ADMIN_ID, `📊 **استثمار جديد!**\n\n👤 المستخدم: \`${userId}\`\n🚀 الخطة: ${planName}\n💰 المبلغ الخصم: $${price} USD`, { parse_mode: 'Markdown' }).catch(() => {});
    res.json({ success: true });
});

// طلب إيداع وإرساله للأدمن مع أزرار
app.post('/api/deposit', (req, res) => {
    const { userId, userName, amount, method, details } = req.body;
    if(!amount || isNaN(amount)) return res.status(400).json({ success: false });
    
    const txId = txCounter++;
    const tx = {
        id: txId,
        user_id: userId,
        type: 'DEPOSIT',
        method: method,
        amount: amount,
        details: details,
        status: 'PENDING'
    };
    memoryDb.transactions.push(tx);

    bot.telegram.sendMessage(ADMIN_ID, 
        `📥 **طلب إيداع جديد!**\n\n👤 المستخدم: ${userName || 'مستخدم'} (\`${userId}\`)\n💰 المبلغ: **$${amount} USD**\n🌐 الوسيلة: ${method}\n🔍 التفاصيل: \`${details || 'لا توجد'}\``,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ موافقة', `approve_dep_${txId}`), Markup.button.callback('❌ رفض', `reject_dep_${txId}`)]
            ])
        }
    ).catch(() => {});
    
    res.json({ success: true });
});

// طلب سحب وإرساله للأدمن مع أزرار
app.post('/api/withdraw', (req, res) => {
    const { userId, userName, amount, method, address } = req.body;
    const user = memoryDb.users[userId];

    if (!user || user.balance < amount) {
        return res.status(400).json({ success: false, error: "الرصيد غير كافٍ" });
    }

    user.balance -= amount;

    const txId = txCounter++;
    const tx = {
        id: txId,
        user_id: userId,
        type: 'WITHDRAW',
        method: method,
        amount: amount,
        details: address,
        status: 'PENDING'
    };
    memoryDb.transactions.push(tx);

    bot.telegram.sendMessage(ADMIN_ID,
        `📤 **طلب سحب جديد!**\n\n👤 المستخدم: ${userName || 'مستخدم'} (\`${userId}\`)\n💸 المبلغ: **$${amount} USD**\n🌐 الوسيلة: ${method}\n📍 العنوان/الرقم: \`${address}\``,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ موافقة', `approve_wit_${txId}`), Markup.button.callback('❌ رفض', `reject_wit_${txId}`)]
            ])
        }
    ).catch(() => {});

    res.json({ success: true });
});

// معالجة أزرار الأدمن (موافقة / رفض)
bot.action(/^(approve|reject)_(dep|wit)_(\d+)$/, async (ctx) => {
    const action = ctx.match[1];
    const type = ctx.match[2];
    const txId = parseInt(ctx.match[3]);

    const tx = memoryDb.transactions.find(t => t.id === txId);

    if (!tx || tx.status !== 'PENDING') {
        return ctx.answerCbQuery("⚠️ تم معالجة هذا الطلب مسبقاً.");
    }

    const user = memoryDb.users[tx.user_id];

    if (action === 'approve') {
        tx.status = 'APPROVED';
        if (type === 'dep') {
            if (user) user.balance += tx.amount;
            bot.telegram.sendMessage(tx.user_id, `✅ **تمت الموافقة على إيداعك!**\nتم إضافة $${tx.amount} إلى رصيدك.`, { parse_mode: 'Markdown' }).catch(() => {});
        } else {
            bot.telegram.sendMessage(tx.user_id, `✅ **تمت الموافقة على طلب السحب!**\nتم تحويل $${tx.amount} إلى حسابك بنجاح.`, { parse_mode: 'Markdown' }).catch(() => {});
        }
        ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n🟢 **حالة الطلب: تم القبول**`).catch(() => {});
    } else {
        tx.status = 'REJECTED';
        if (type === 'wit') {
            if (user) user.balance += tx.amount;
            bot.telegram.sendMessage(tx.user_id, `❌ **تم رفض طلب السحب.**\nتم إعادة $${tx.amount} إلى رصيد محفظتك.`, { parse_mode: 'Markdown' }).catch(() => {});
        } else {
            bot.telegram.sendMessage(tx.user_id, `❌ **تم رفض طلب الإيداع الخاص بك.**`, { parse_mode: 'Markdown' }).catch(() => {});
        }
        ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n🔴 **حالة الطلب: تم الرفض**`).catch(() => {});
    }
    ctx.answerCbQuery("تمت المعالجة بنجاح").catch(() => {});
});

// استقبال وتوجيه تحديثات تليجرام Webhook
app.post(`/api/webhook`, (req, res) => {
    bot.handleUpdate(req.body, res).then(() => {
        res.status(200).send('OK');
    }).catch(err => {
        res.status(500).send(err.toString());
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

module.exports = app;
