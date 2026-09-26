const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
}));

app.options('*', cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN || '8412641855:AAFkix8Ix-1flmiIwI5pk6kwVqicyhSlg5g';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8777895536';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY,
        first_name TEXT,
        username TEXT,
        balance REAL DEFAULT 100.0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT,
        amount REAL,
        status TEXT DEFAULT 'PENDING',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT,
        amount REAL,
        rate REAL,
        payout REAL,
        duration_seconds INTEGER,
        start_time INTEGER,
        end_time INTEGER,
        status TEXT DEFAULT 'ACTIVE'
    )`);
});

app.get('/', (req, res) => {
    res.send('Server is active and running perfectly!');
});

app.post('/api/user/auth', (req, res) => {
    const { telegram_id, first_name, username } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'Telegram ID required' });

    db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        if (!row) {
            db.run(`INSERT INTO users (telegram_id, first_name, username, balance) VALUES (?, ?, ?, 100.0)`,
                [telegram_id, first_name, username],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ telegram_id, first_name, username, balance: 100.0 });
                }
            );
        } else {
            res.json(row);
        }
    });
});

app.post('/api/deposit/request', (req, res) => {
    const { telegram_id, amount } = req.body;

    if (!telegram_id || !amount) {
        return res.status(400).json({ error: 'البيانات غير مكتملة' });
    }

    db.run(`INSERT INTO deposits (telegram_id, amount) VALUES (?, ?)`, [telegram_id, amount], function(err) {
        if (err) return res.status(500).json({ error: err.message });

        const depositId = this.lastID;
        const msgText = `📥 **طلب إيداع جديد!**\n\n👤 المستخدم ID: \`${telegram_id}\`\n💰 المبلغ المطلوب: $${amount}\n🆔 رقم الطلب: #${depositId}`;
        const opts = {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'قبول الإيداع ✅', callback_data: `dep_approve_${depositId}` },
                        { text: 'رفض الإيداع ❌', callback_data: `dep_reject_${depositId}` }
                    ]
                ]
            }
        };

        bot.sendMessage(ADMIN_CHAT_ID, msgText, opts).catch(e => console.error("خطأ إرسال رسالة البوت:", e));
        res.json({ success: true, message: 'تم إرسال طلب الإيداع لمدير المنصة' });
    });
});

app.post('/api/trade/open', (req, res) => {
    const { telegram_id, amount } = req.body;

    if (!telegram_id || !amount) {
        return res.status(400).json({ error: 'البيانات غير مكتملة' });
    }

    db.get(`SELECT balance FROM users WHERE telegram_id = ?`, [telegram_id], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user || user.balance < amount) {
            return res.status(400).json({ error: 'الرصيد المتاح غير كافٍ' });
        }

        let rate = 0.30;
        let seconds = 24 * 3600;

        if (amount >= 1000) { rate = 3.00; seconds = 7 * 24 * 3600; }
        else if (amount >= 500) { rate = 1.50; seconds = 72 * 3600; }
        else if (amount >= 100) { rate = 0.60; seconds = 48 * 3600; }

        const payout = amount + (amount * rate);
        const startTime = Date.now();
        const endTime = startTime + (seconds * 1000);

        db.run(`UPDATE users SET balance = balance - ? WHERE telegram_id = ?`, [amount, telegram_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });

            db.run(`INSERT INTO trades (telegram_id, amount, rate, payout, duration_seconds, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [telegram_id, amount, rate, payout, seconds, startTime, endTime],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, tradeId: this.lastID });
                }
            );
        });
    });
});

app.get('/api/trades/:telegram_id', (req, res) => {
    db.all(`SELECT * FROM trades WHERE telegram_id = ? ORDER BY id DESC`, [req.params.telegram_id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

bot.on('callback_query', (query) => {
    const data = query.data;

    if (data.startsWith('dep_approve_')) {
        const depositId = data.replace('dep_approve_', '');

        db.get(`SELECT * FROM deposits WHERE id = ? AND status = 'PENDING'`, [depositId], (err, dep) => {
            if (!dep) return bot.answerCallbackQuery(query.id, { text: 'الطلب غير موجود أو تم معالجته سابقاً' });

            db.run(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`, [dep.amount, dep.telegram_id]);
            db.run(`UPDATE deposits SET status = 'APPROVED' WHERE id = ?`, [depositId]);

            bot.sendMessage(dep.telegram_id, `🎉 **تم قبول طلب الإيداع الخاص بك!**\nتم إضافة $${dep.amount} إلى حسابك.`);
            bot.editMessageText(`✅ **تم قبول الإيداع #${depositId}** بمبلغ $${dep.amount}`, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            });
        });
    } else if (data.startsWith('dep_reject_')) {
        const depositId = data.replace('dep_reject_', '');

        db.get(`SELECT * FROM deposits WHERE id = ? AND status = 'PENDING'`, [depositId], (err, dep) => {
            if (!dep) return bot.answerCallbackQuery(query.id, { text: 'الطلب غير موجود أو تم معالجته سابقاً' });

            db.run(`UPDATE deposits SET status = 'REJECTED' WHERE id = ?`, [depositId]);

            bot.sendMessage(dep.telegram_id, `❌ **تم رفض طلب الإيداع الخاص بك.**`);
            bot.editMessageText(`❌ **تم رفض الإيداع #${depositId}**`, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            });
        });
    }
});

cron.schedule('*/5 * * * * *', () => {
    const now = Date.now();
    db.all(`SELECT * FROM trades WHERE status = 'ACTIVE' AND end_time <= ?`, [now], (err, trades) => {
        if (err || !trades) return;

        trades.forEach((trade) => {
            db.run(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`, [trade.payout, trade.telegram_id]);
            db.run(`UPDATE trades SET status = 'COMPLETED' WHERE id = ?`, [trade.id]);

            bot.sendMessage(trade.telegram_id, `🎯 **اكتملت خطة الأرباح بنجاح!**\nتم نزول $${trade.payout.toFixed(2)} تلقائياً في حسابك.`).catch(e => {});
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
