const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- الإعدادات الأساسية ---
const BOT_TOKEN = process.env.BOT_TOKEN || "ضع_توكن_البوت_هنا";
const ADMIN_ID = process.env.ADMIN_ID || "ضع_ايدي_الادمن_هنا";
const bot = new Telegraf(BOT_TOKEN);

// --- 1. إنشاء قاعدة البيانات SQLite ---
const db = new sqlite3.Database('./platform.db', (err) => {
    if (err) console.error("خطأ في قاعدة البيانات:", err.message);
    else console.log("تم الاتصال بقاعدة البيانات بنجاح.");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        full_name TEXT,
        username TEXT,
        balance REAL DEFAULT 0.0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS investments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        plan_name TEXT,
        amount REAL,
        return_amount REAL,
        end_time INTEGER,
        status TEXT DEFAULT 'ACTIVE'
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

// --- 2. محرك الأرباح التلقائي بعد 24 ساعة ---
setInterval(() => {
    const now = Date.now();
    db.all(`SELECT * FROM investments WHERE status = 'ACTIVE' AND end_time <= ?`, [now], (err, rows) => {
        if (err || !rows) return;
        rows.forEach(inv => {
            db.run(`UPDATE users SET balance = balance + ? WHERE user_id = ?`, [inv.return_amount, inv.user_id]);
            db.run(`UPDATE investments SET status = 'COMPLETED' WHERE id = ?`, [inv.id]);
            bot.telegram.sendMessage(inv.user_id, `🎉 **اكتملت خطتك الاستثمارية!**\n\nالخطة: ${inv.plan_name}\nتم إضافة **$${inv.return_amount.toFixed(2)} USD** إلى محفظتك.`, { parse_mode: 'Markdown' }).catch(() => {});
        });
    });
}, 30000); // يفحص كل 30 ثانية

// --- 3. أوامر البوت ---
bot.start((ctx) => {
    const u = ctx.from;
    db.run(`INSERT INTO users (user_id, full_name, username) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET full_name=?, username=?`,
        [u.id.toString(), u.first_name, u.username || '', u.first_name, u.username || '']);
    
    ctx.reply(`أهلاً بك ${u.first_name} في منصة الاستثمار السريع!`, 
        Markup.inlineKeyboard([
            [Markup.button.webApp("🚀 فتح المنصة VIP", process.env.VERCEL_URL || "https://your-domain.vercel.app")]
        ])
    );
});

// --- 4. معالجة قرارات الأدمن (موافقة / رفض) ---
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
            ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n🟢 **حالة الطلب: تم القبول**`);
        } else {
            db.run(`UPDATE transactions SET status = 'REJECTED' WHERE id = ?`, [txId]);
            if (type === 'wit') {
                // إعادة المبلغ المخصوم في حالة رفض السحب
                db.run(`UPDATE users SET balance = balance + ? WHERE user_id = ?`, [tx.amount, tx.user_id]);
                bot.telegram.sendMessage(tx.user_id, `❌ **تم رفض طلب السحب.**\nتم إعادة $${tx.amount} إلى رصيد محفظتك.`, { parse_mode: 'Markdown' }).catch(() => {});
            } else {
                bot.telegram.sendMessage(tx.user_id, `❌ **تم رفض طلب الإيداع الخاص بك.**`, { parse_mode: 'Markdown' }).catch(() => {});
            }
            ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n🔴 **حالة الطلب: تم الرفض**`);
        }
    });
});

// --- 5. مسارات الـ API للواجهة الأمامية ---
app.get('/api/user/:id', (req, res) => {
    db.get(`SELECT * FROM users WHERE user_id = ?`, [req.params.id], (err, row) => {
        res.json(row || { balance: 0.0 });
    });
});

app.post('/api/deposit', (req, res) => {
    const { userId, userName, amount, method, details } = req.body;
    db.run(`INSERT INTO transactions (user_id, type, method, amount, details) VALUES (?, 'DEPOSIT', ?, ?, ?)`,
        [userId, method, amount, details], function(err) {
            if (err) return res.status(500).json({ success: false });
            const txId = this.lastID;
            bot.telegram.sendMessage(ADMIN_ID, 
                `📥 **طلب إيداع جديد!**\n\n👤 المستخدم: ${userName} (\`${userId}\`)\n💰 المبلغ: **$${amount} USD**\n🌐 الوسيلة: ${method}\n🔍 التفاصيل: \`${details}\``,
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

app.post('/api/withdraw', (req, res) => {
    const { userId, userName, amount, method, address } = req.body;
    db.get(`SELECT balance FROM users WHERE user_id = ?`, [userId], (err, user) => {
        if (!user || user.balance < amount) {
            return res.status(400).json({ success: false, error: "الرصيد غير كافٍ" });
        }
        // خصم المبلغ فوراً
        db.run(`UPDATE users SET balance = balance - ? WHERE user_id = ?`, [amount, userId]);
        db.run(`INSERT INTO transactions (user_id, type, method, amount, details) VALUES (?, 'WITHDRAW', ?, ?, ?)`,
            [userId, method, amount, address], function(err) {
                const txId = this.lastID;
                bot.telegram.sendMessage(ADMIN_ID,
                    `📤 **طلب سحب جديد!**\n\n👤 المستخدم: ${userName} (\`${userId}\`)\n💸 المبلغ: **$${amount} USD**\n🌐 الوسيلة: ${method}\n📍 العنوان/الرقم: \`${address}\``,
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

bot.launch();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`السيرفر يعمل على المنفذ ${PORT}`));
