require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '30mb' }));

// Frontend tĩnh
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// API routes
app.use('/api/chat', require('./routes/chat'));
app.use('/api/image', require('./routes/image'));
app.use('/api/video', require('./routes/video'));
app.use('/api/tts', require('./routes/tts'));
app.use('/api/search', require('./routes/search'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/files', require('./routes/files'));
app.use('/api/agent-browser', require('./routes/agentBrowser'));
app.use('/api/agent', require('./routes/agent'));

app.get('/health', (req, res) => {
  res.json({ ok: true, hasApiKey: !!process.env.GEMINI_API_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 My-AI đang chạy tại http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.log('⚠️  Chưa thấy GEMINI_API_KEY trong .env — copy .env.example thành .env rồi dán API key free của bạn vào.');
  }
});
