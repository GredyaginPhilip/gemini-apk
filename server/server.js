const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_RETRIES = 100;
const KEYS_FILE_PATH = path.join(__dirname, 'keys.json');

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function getRandomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCurrentDateTimeString() {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Samara',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  return formatter.format(new Date());
}

app.get('/api/keys', (req, res) => {
  try {
    if (fs.existsSync(KEYS_FILE_PATH)) {
      const data = fs.readFileSync(KEYS_FILE_PATH, 'utf-8');
      const keys = JSON.parse(data);
      return res.json(keys);
    } else {
      return res.json([]);
    }
  } catch (err) {
    console.error('[Keys DB Error]:', err.message);
    return res.status(500).json({ error: 'Ошибка чтения базы ключей' });
  }
});

async function uploadToGeminiFileApi(buffer, mimeType, displayName) {
  const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`;
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'start, upload, finalize',
      'X-Goog-Upload-Header-Content-Length': buffer.length.toString(),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': mimeType
    },
    body: buffer
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Ошибка загрузки в Google File API (${response.status}): ${err}`);
  }

  const data = await response.json();
  return data.file.uri;
}

async function requestStream(targetModel, payload) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;
  return await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

app.post('/api/chat', async (req, res) => {
  if (!GEMINI_API_KEY || GEMINI_API_KEY.includes('ВСТАВЬТЕ_ВАШ_API_КЛЮЧ')) {
    return res.status(500).json({ error: 'API ключ не настроен в .env' });
  }

  const { contents, systemInstruction, model = 'gemini-3.8-flash', enableSearch = false } = req.body;

  if (!contents || !Array.isArray(contents)) {
    return res.status(400).json({ error: 'Поле contents обязательно и должно быть массивом.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    for (const msg of contents) {
      if (Array.isArray(msg.parts)) {
        for (let i = 0; i < msg.parts.length; i++) {
          const part = msg.parts[i];
          if (part.inlineData && part.inlineData.data) {
            const rawBuffer = Buffer.from(part.inlineData.data, 'base64');
            if (rawBuffer.length > 12 * 1024 * 1024 || part.inlineData.mimeType.startsWith('video/')) {
              res.write(`data: ${JSON.stringify({ statusText: `Загрузка видеофайла в облачный шлюз Google (${Math.round(rawBuffer.length / 1024 / 1024)} МБ)...` })}\n\n`);
              const fileUri = await uploadToGeminiFileApi(rawBuffer, part.inlineData.mimeType, 'attachment');
              msg.parts[i] = {
                fileData: {
                  fileUri: fileUri,
                  mimeType: part.inlineData.mimeType
                }
              };
            }
          }
        }
      }
    }
  } catch (fileUploadErr) {
    res.write(`data: ${JSON.stringify({ error: `Сбой загрузки медиафайла: ${fileUploadErr.message}` })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  const currentLocalTime = getCurrentDateTimeString();
  const timeAwareInstruction = `ТОЧНОЕ ТЕКУЩЕЕ ВРЕМЯ И ДАТА: ${currentLocalTime} (Часовой пояс UTC+4, Ижевск). Ты точно знаешь сегодняшнюю дату, день недели и текущий год. Всегда опирайся на эти данные при вопросах о календаре, времени и днях недели. ${systemInstruction || 'Отвечай структурированно, понятно и лаконично.'}`;

  const requestPayload = {
    contents: contents,
    systemInstruction: { parts: [{ text: timeAwareInstruction }] },
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
  };

  if (enableSearch) {
    requestPayload.tools = [{ google_search: {} }];
  }

  let attempt = 0;
  let upstreamResponse = null;
  let isReady = false;
  let searchStripped = false;

  try {
    while (attempt < MAX_RETRIES) {
      attempt++;
      try {
        upstreamResponse = await requestStream(model, requestPayload);
      } catch (networkErr) {
        res.write(`data: ${JSON.stringify({ statusText: `Сетевой сбой. Дозваниваюсь к ${model}... Попытка ${attempt}/${MAX_RETRIES}` })}\n\n`);
        await delay(getRandomDelay(2000, 3500));
        continue;
      }

      if (upstreamResponse.status === 429 && requestPayload.tools && !searchStripped) {
        delete requestPayload.tools;
        searchStripped = true;
        res.write(`data: ${JSON.stringify({ statusText: `Поиск Google недоступен на бесплатном ключе. Отправляю напрямую в ${model}...` })}\n\n`);
        continue;
      }

      if (upstreamResponse.status === 503 || upstreamResponse.status === 429) {
        const reason = upstreamResponse.status === 503 ? '503 (Перегрузка кластера Google)' : '429 (Лимит частоты)';
        res.write(`data: ${JSON.stringify({ statusText: `${model}: ${reason}. Дозваниваюсь... Попытка ${attempt}/${MAX_RETRIES}` })}\n\n`);
        await delay(getRandomDelay(2500, 4500));
      } else {
        isReady = true;
        break;
      }
    }

    if (!isReady || !upstreamResponse || !upstreamResponse.ok) {
      const errorDetails = upstreamResponse ? await upstreamResponse.text() : 'Таймаут подключения';
      res.write(`data: ${JSON.stringify({ error: `Сбой связи с ${model} (${upstreamResponse?.status}): ${errorDetails}` })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    res.write(`data: ${JSON.stringify({ connected: true })}\n\n`);

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const jsonString = trimmed.substring(6);
          if (jsonString === '[DONE]') break;
          try {
            const parsed = JSON.parse(jsonString);
            const textPart = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (textPart) {
              res.write(`data: ${JSON.stringify({ text: textPart })}\n\n`);
            }
          } catch (jsonErr) {}
        }
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: 'Ошибка сервера: ' + err.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    currentTimeIzhevsk: getCurrentDateTimeString(),
    maxRetries: MAX_RETRIES,
    fileApiEnabled: true,
    time: new Date().toISOString()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Шлюз запущен на порту ${PORT}. База ключей подключена.`);
});
