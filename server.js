const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());

// قائمة الجوائز والاحتمالات (الوزن / Weight)
const PRIZES = [
  { id: 1, text: "10 USDT", color: "#3b82f6", weight: 5 },
  { id: 2, text: "حظ سعيد المره الجايه", color: "#64748b", weight: 45 },
  { id: 3, text: "5 USDT", color: "#10b981", weight: 15 },
  { id: 4, text: "خصم 50%", color: "#f59e0b", weight: 20 },
  { id: 5, text: "1 USDT", color: "#8b5cf6", weight: 25 },
  { id: 6, text: "لا توجد جائزة", color: "#ef4444", weight: 40 }
];

// دالة اختيار الجائزة حسب الاحتمالات
function getRandomPrize() {
  const totalWeight = PRIZES.reduce((acc, p) => acc + p.weight, 0);
  let randomNum = Math.random() * totalWeight;
  
  for (let i = 0; i < PRIZES.length; i++) {
    if (randomNum < PRIZES[i].weight) {
      return { prize: PRIZES[i], index: i };
    }
    randomNum -= PRIZES[i].weight;
  }
  return { prize: PRIZES[0], index: 0 };
}

// API للحصول على الجوائز
app.get('/api/prizes', (req, res) => {
  res.json({ prizes: PRIZES });
});

// API عملية التدوير
app.post('/api/spin', (req, res) => {
  const { userId } = req.body;
  
  // اختيار الجائزة
  const result = getRandomPrize();
  
  res.json({
    success: true,
    prizeIndex: result.index,
    prize: result.prize
  });
});

// الصفحة الرئيسية (Telegram Mini App Frontend)
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>عجلة الحظ - Telegram Mini App</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0f172a;
      color: #fff;
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      overflow: hidden;
    }
    h1 { margin-bottom: 20px; font-size: 24px; color: #38bdf8; text-align: center; }
    
    .wheel-container {
      position: relative;
      width: 320px;
      height: 320px;
      margin-bottom: 30px;
    }
    
    .pointer {
      position: absolute;
      top: -15px;
      left: 50%;
      transform: translateX(-50%);
      width: 0;
      height: 0;
      border-left: 15px solid transparent;
      border-right: 15px solid transparent;
      border-top: 25px solid #ef4444;
      z-index: 10;
    }
    
    canvas {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      box-shadow: 0 0 20px rgba(56, 189, 248, 0.4);
      transition: transform 4s cubic-bezier(0.15, 0.99, 0.18, 1);
    }
    
    button {
      background: linear-gradient(135deg, #38bdf8, #2563eb);
      color: #fff;
      border: none;
      padding: 14px 40px;
      font-size: 18px;
      font-weight: bold;
      border-radius: 30px;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(56, 189, 248, 0.4);
      transition: transform 0.2s, opacity 0.2s;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button:active { transform: scale(0.95); }
    
    #resultModal {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.8);
      justify-content: center;
      align-items: center;
      z-index: 100;
    }
    .modal-content {
      background: #1e293b;
      padding: 30px;
      border-radius: 20px;
      text-align: center;
      max-width: 80%;
      border: 1px solid #38bdf8;
    }
    .modal-content h2 { margin-bottom: 10px; color: #4ade80; }
    .modal-content button { margin-top: 15px; font-size: 14px; padding: 10px 20px; }
  </style>
</head>
<body>

  <h1>🎯 جرب حظك واكسب!</h1>

  <div class="wheel-container">
    <div class="pointer"></div>
    <canvas id="wheel" width="320" height="320"></canvas>
  </div>

  <button id="spinBtn">أدر العجلة الآن 🎲</button>

  <div id="resultModal">
    <div class="modal-content">
      <h2>🎉 مبروك!</h2>
      <p id="resultText"></p>
      <button onclick="closeModal()">إغلاق</button>
    </div>
  </div>

  <script>
    const tg = window.Telegram?.WebApp;
    if (tg) tg.expand();

    let prizes = [];
    let isSpinning = false;
    let currentRotation = 0;

    const canvas = document.getElementById('wheel');
    const ctx = canvas.getContext('2d');
    const spinBtn = document.getElementById('spinBtn');

    // جلب الجوائز من API
    async function loadPrizes() {
      const res = await fetch('/api/prizes');
      const data = await res.json();
      prizes = data.prizes;
      drawWheel();
    }

    function drawWheel() {
      const numSlices = prizes.length;
      const sliceAngle = (2 * Math.PI) / numSlices;

      prizes.forEach((prize, i) => {
        const startAngle = i * sliceAngle;
        const endAngle = startAngle + sliceAngle;

        ctx.beginPath();
        ctx.moveTo(160, 160);
        ctx.arc(160, 160, 160, startAngle, endAngle);
        ctx.fillStyle = prize.color;
        ctx.fill();
        ctx.stroke();

        // رسم النص
        ctx.save();
        ctx.translate(160, 160);
        ctx.rotate(startAngle + sliceAngle / 2);
        ctx.textAlign = "right";
        ctx.fillStyle = "#fff";
        ctx.font = "bold 14px system-ui";
        ctx.fillText(prize.text, 140, 5);
        ctx.restore();
      });
    }

    spinBtn.addEventListener('click', async () => {
      if (isSpinning) return;
      isSpinning = true;
      spinBtn.disabled = true;

      try {
        const res = await fetch('/api/spin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: tg?.initDataUnsafe?.user?.id || 'guest' })
        });
        const data = await res.json();

        if (data.success) {
          const sliceAngle = 360 / prizes.length;
          // حساب زاوية الوقوف الصحيحة تحت السهم أعلى العجلة
          const prizeIndex = data.prizeIndex;
          const targetAngle = 360 - (prizeIndex * sliceAngle + sliceAngle / 2) - 90;
          
          const extraTurns = 5 * 360; // 5 دورات كاملة
          currentRotation += extraTurns + (targetAngle - (currentRotation % 360));
          
          canvas.style.transform = \`rotate(\${currentRotation}deg)\`;

          setTimeout(() => {
            document.getElementById('resultText').innerText = \`حصلت على: \${data.prize.text}\`;
            document.getElementById('resultModal').style.display = 'flex';
            isSpinning = false;
            spinBtn.disabled = false;
          }, 4000);
        }
      } catch (e) {
        alert("حدث خطأ أثناء الاتصال بالسيرفر!");
        isSpinning = false;
        spinBtn.disabled = false;
      }
    });

    function closeModal() {
      document.getElementById('resultModal').style.display = 'none';
    }

    loadPrizes();
  </script>
</body>
</html>
  `);
});

// تصدير app لتشغيله كـ Serverless على Vercel
module.exports = app;

// تشغيل السيرفر محلياً عند عدم وجود Vercel
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
