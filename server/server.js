/* ============================================================================
 * ФАЙЛ: /var/www/gemini-app/server.js
 * ВЕРСИЯ: 1.0.8
 * ПОСЛЕДНЕЕ ОБНОВЛЕНИЕ: 2026-09-04 03:55:00 (UTC+4, Ижевск)
 * 
 * ИСТОРИЯ ИЗМЕНЕНИЙ (CHANGELOG):
 * ----------------------------------------------------------------------------
 * 2026-09-04 03:55 | v1.0.8 | Внедрена динамическая инъекция текущей даты и времени (UTC+4, Ижевск) в System Instruction
 * 2026-09-04 03:54 | v1.0.7 | Поддержка полного каталога моделей Gemini 3.x и улучшенный дозвон
 * 2026-09-04 03:50 | v1.0.6 | Добавлен jitter к задержкам дозвона, поддержка динамического выбора модели из клиента
 * 2026-09-04 03:48 | v1.0.5 | Умный обход 429: автоматическое снятие инструмента поиска при нулевой квоте Grounding
 * 2026-09-04 03:46 | v1.0.4 | Добавлено детальное логирование кода и ответа Google, интервал 4с для избежания 429
 * 2026-09-04 03:42 | v1.0.3 | Включен Google Search Tool, MAX_RETRIES установлен на 100, лимит json 50mb
 * 2026-09-04 03:40 | v1.0.2 | Убран fallback, внедрен настойчивый цикл дозвона (12 попыток) с SSE-уведомлениями
 * 2026-09-04 03:38 | v1.0.1 | Добавлен auto-retry при 503 и auto-failover на резервную модель
 * 2026-09-04 03:32 | v1.0.0 | Первоначальный релиз
 * ============================================================================ */

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_RETRIES = 100;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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

  const currentLocalTime = getCurrentDateTimeString();
  const timeAwareInstruction = `ТОЧНОЕ ТЕКУЩЕЕ ВРЕМЯ И ДАТА: ${currentLocalTime} (Часовой пояс UTC+4, Ижевск). Ты точно знаешь сегодняшнюю дату, день недели и текущий год. Всегда опирайся на эти данные при вопросах о календаре, времени и днях недели. ${systemInstruction || 'Отвечай структурированно, понятно и лаконично.'}`;

  const requestPayload = {
    contents: contents,
    systemInstruction: {
      parts: [{ text: timeAwareInstruction }]
    },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192
    }
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
        console.error(`[Сетевой сбой] ${networkErr.message}`);
        res.write(`data: ${JSON.stringify({ statusText: `Сетевой сбой. Дозваниваюсь к ${model}... Попытка ${attempt}/${MAX_RETRIES}` })}\n\n`);
        await delay(getRandomDelay(2000, 3500));
        continue;
      }

      console.log(`[Google API] Модель: ${model} | Попытка ${attempt}/${MAX_RETRIES} -> Статус: ${upstreamResponse.status}`);

      if (upstreamResponse.status === 429 && requestPayload.tools && !searchStripped) {
        console.log('[Квота поиска 429] Отключаем google_search и повторяем запрос...');
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
      console.error(`[Ошибка Gemini API]:`, errorDetails);
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
    console.error('[Внутренняя ошибка]', err);
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
    time: new Date().toISOString()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Шлюз Gemini запущен на порту ${PORT}. Актуальное время инициализировано.`);
});
