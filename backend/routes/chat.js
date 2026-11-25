const express = require('express');
const router = express.Router();
const { pickAutoModel, normalizeChatModel, buildThinkingConfig } = require('../config/models');

const API_KEY = process.env.GEMINI_API_KEY;
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// POST /api/chat/stream
// body: { messages, model, thinking, thinkingEffort, webSearch, systemInstruction, attachments }
router.post('/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    if (!API_KEY) { send('error', 'Thiếu GEMINI_API_KEY trong file .env'); return res.end(); }

    const {
      messages = [],
      model = 'auto',
      thinking = false,
      thinkingEffort,
      webSearch = false,
      systemInstruction,
      attachments = [],
    } = req.body;

    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const lastUserText = lastUserMsg?.parts?.map(p => p.text || '').join(' ') || '';
    const normalizedModel = normalizeChatModel(model);
    const chosenModel = normalizedModel === 'auto' ? pickAutoModel(lastUserText, { webSearch }) : normalizedModel;
    send('model', chosenModel);

    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: (m.parts || []).map(p => ({ text: p.text })),
    }));

    if (attachments.length && contents.length) {
      const lastIdx = contents.length - 1;
      if (contents[lastIdx].role === 'user') {
        for (const a of attachments) {
          contents[lastIdx].parts.push({ inlineData: { mimeType: a.mimeType, data: a.base64 } });
        }
      }
    }

    // thinkingConfig phụ thuộc từng dòng model (3.5 Flash: thinkingBudget, Hydrogen: thinkingLevel
    // gồm cả xhigh, Gemma: bật/tắt) — xem buildThinkingConfig trong config/models.js.
    const body = { contents };
    const thinkingConfig = buildThinkingConfig(chosenModel, thinking, thinkingEffort);
    if (thinkingConfig) body.generationConfig = { thinkingConfig };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    if (webSearch) body.tools = [{ google_search: {} }];

    const upstream = await fetch(`${BASE}/${chosenModel}:streamGenerateContent?alt=sse&key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text();
      send('error', errText.slice(0, 3000));
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const candidate = parsed.candidates?.[0];
          const parts = candidate?.content?.parts || [];
          for (const p of parts) {
            if (p.thought) send('thought', p.text || '');
            else if (p.text) send('chunk', p.text);
          }
          if (candidate?.groundingMetadata) send('grounding', candidate.groundingMetadata);
        } catch (e) { /* JSON chưa trọn vẹn, bỏ qua chờ chunk tiếp theo */ }
      }
    }
    send('done', {});
    res.end();
  } catch (err) {
    console.error(err);
    try { send('error', err.message); res.end(); } catch (e) {}
  }
});

module.exports = router;
