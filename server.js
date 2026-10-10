const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const BOT_TOKEN = process.env.BOT_TOKEN || "8939362456:AAHsg7CDOZ_Dr5v2XxOXVVPZvXp6THu38ew";
const ADMIN_ID = process.env.ADMIN_ID || "8889600549";
const bot = new Telegraf(BOT_TOKEN);

// قاعدة البيانات SQLite
const db = new sqlite3.Database('./platform.db', (err) => {
    if (err) console.error("خطأ في قاعدة البيانات:", err.message);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        full_name TEXT,
        username TEXT,
        balance REAL DEFAULT 0.0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        type TEXT,
        method TEXT,
        amount REAL,
        details TEXT,
        status TEXT DEFAULT 'PENDING'
    )`);
});

// أوامر البوت عند الضغط على Start
bot.start((ctx) => {
    const u = ctx.from;
    db.run(`INSERT INTO users (user_id, full_name, username) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET full_name=?, username=?`,
        [u.id.toString(), u.first_name, u.username || '', u.first_name, u.username || '']);
    
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
    db.run(`INSERT INTO users (user_id, full_name, username) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET full_name=?, username=?`,
        [userId, name, username, name, username], (err) => {
            if(err) return res.status(500).json({success: false});
            res.json({ success: true });
        });
});

// جلب رصيد المستخدم
app.get('/api/user/:id', (req, res) => {
    db.get(`SELECT * FROM users WHERE user_id = ?`, [req.params.id], (err, row) => {
        res.json(row || { balance: 0.0 });
    });
});

// تفعيل الخطة الاستثمارية وخصم الرصيد فوراً
app.post('/api/invest', (req, res) => {
    const { userId, planName, price } = req.body;
    db.get(`SELECT balance FROM users WHERE user_id = ?`, [userId], (err, user) => {
        if (!user || user.balance < price) {
            return res.status(400).json({ success: false, error: "عذراً، رصيدك غير كافٍ لتفعيل هذه الخطة." });
        }
        db.run(`UPDATE users SET balance = balance - ? WHERE user_id = ?`, [price, userId], (err) => {
            if (err) return res.status(500).json({ success: false, error: "خطأ في الخادم" });
            
            bot.telegram.sendMessage(ADMIN_ID, `📊 **استثمار جديد!**\n\n👤 المستخدم: \`${userId}\`\n🚀 الخطة: ${planName}\n💰 المبلغ الخصم: $${price} USD`, { parse_mode: 'Markdown' }).catch(() => {});
            res.json({ success: true });
        });
    });
});

// طلب إيداع وإرساله للأدمن مع أزرار
app.post('/api/deposit', (req, res) => {
    const { userId, userName, amount, method, details } = req.body;
    if(!amount || isNaN(amount)) return res.status(400).json({ success: false });
    
    db.run(`INSERT INTO transactions (user_id, type, method, amount, details) VALUES (?, 'DEPOSIT', ?, ?, ?)`,
        [userId, method, amount, details], function(err) {
            if (err) return res.status(500).json({ success: false });
            const txId = this.lastID;
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
});

// طلب سحب وإرساله للأدمن مع أزرار
app.post('/api/withdraw', (req, res) => {
    const { userId, userName, amount, method, address } = req.body;
    db.get(`SELECT balance FROM users WHERE user_id = ?`, [userId], (err, user) => {
        if (!user || user.balance < amount) {
            return res.status(400).json({ success: false, error: "الرصيد غير كافٍ" });
        }
        db.run(`UPDATE users SET balance = balance - ? WHERE user_id = ?`, [amount, userId], (err) => {
            if(err) return res.status(500).json({ success: false });
            db.run(`INSERT INTO transactions (user_id, type, method, amount, details) VALUES (?, 'WITHDRAW', ?, ?, ?)`,
                [userId, method, amount, address], function(err) {
                    const txId = this.lastID;
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
        });
    });
});

// معالجة أزرار الأدمن (موافقة / رفض)
bot.action(/^(approve|reject)_(dep|wit)_(\d+)$/, async (ctx) => {
    const action = ctx.match[1];
    const type = ctx.match[2];
    const txId = ctx.match[3];

    db.get(`SELECT * FROM transactions WHERE id = ?`, [txId], (err, tx) => {
        if (!tx || tx.status !== 'PENDING') {
            return ctx.answerCbQuery("⚠️ تم معالجة هذا الطلب مسبقاً.");
        }

        if (action === 'approve') {
            db.run(`UPDATE transactions SET status = 'APPROVED' WHERE id = ?`, [txId]);
            if (type === 'dep') {
                db.run(`UPDATE users SET balance = balance + ? WHERE user_id = ?`, [tx.amount, tx.user_id]);
                bot.telegram.sendMessage(tx.user_id, `✅ **تمت الموافقة على إيداعك!**\nتم إضافة $${tx.amount} إلى رصيدك.`, { parse_mode: 'Markdown' }).catch(() => {});
            } else {
                bot.telegram.sendMessage(tx.user_id, `✅ **تمت الموافقة على طلب السحب!**\nتم تحويل $${tx.amount} إلى حسابك بنجاح.`, { parse_mode: 'Markdown' }).catch(() => {});
            }
            ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n🟢 **حالة الطلب: تم القبول**`).catch(() => {});
        } else {
            db.run(`UPDATE transactions SET status = 'REJECTED' WHERE id = ?`, [txId]);
            if (type === 'wit') {
                db.run(`UPDATE users SET balance = balance + ? WHERE user_id = ?`, [tx.amount, tx.user_id]);
                bot.telegram.sendMessage(tx.user_id, `❌ **تم رفض طلب السحب.**\nتم إعادة $${tx.amount} إلى رصيد محفظتك.`, { parse_mode: 'Markdown' }).catch(() => {});
            } else {
                bot.telegram.sendMessage(tx.user_id, `❌ **تم رفض طلب الإيداع الخاص بك.**`, { parse_mode: 'Markdown' }).catch(() => {});
            }
            ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n🔴 **حالة الطلب: تم الرفض**`).catch(() => {});
        }
        ctx.answerCbQuery("تمت المعالجة بنجاح").catch(() => {});
    });
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
