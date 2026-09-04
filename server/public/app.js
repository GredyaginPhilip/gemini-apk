/* ============================================================================
 * ФАЙЛ: /var/www/gemini-app/public/app.js
 * ВЕРСИЯ: 1.0.6
 * ПОСЛЕДНЕЕ ОБНОВЛЕНИЕ: 2026-09-04 03:54:00 (UTC+4, Ижевск)
 * 
 * ИСТОРИЯ ИЗМЕНЕНИЙ (CHANGELOG):
 * ----------------------------------------------------------------------------
 * 2026-09-04 03:54 | v1.0.6 | Авто-индикация текущей выбранной модели при дозвоне и генерации
 * 2026-09-04 03:50 | v1.0.5 | Передача выбранной модели из селектора model-select в API
 * 2026-09-04 03:48 | v1.0.4 | Добавлено управление флагом enableSearch через кнопку поиска в шапке
 * 2026-09-04 03:42 | v1.0.3 | Добавлена работа с файлами (inlineData base64), превью и очистка
 * 2026-09-04 03:40 | v1.0.2 | Добавлена визуализация статуса дозвона и очистка индикатора при старте генерации
 * 2026-09-04 03:38 | v1.0.1 | Исправлена очистка истории диалога при ошибках 503/API
 * 2026-09-04 03:32 | v1.0.0 | Первоначальный релиз
 * ============================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  const chatContainer = document.getElementById('chat-container');
  const chatForm = document.getElementById('chat-form');
  const promptInput = document.getElementById('prompt-input');
  const sendBtn = document.getElementById('send-btn');
  const clearBtn = document.getElementById('clear-btn');
  const attachBtn = document.getElementById('attach-btn');
  const fileInput = document.getElementById('file-input');
  const attachmentsBar = document.getElementById('attachments-bar');
  const searchToggleBtn = document.getElementById('search-toggle-btn');
  const modelSelect = document.getElementById('model-select');

  let conversationHistory = [];
  let isGenerating = false;
  let stagedFiles = [];
  let searchEnabled = false;

  searchToggleBtn.addEventListener('click', () => {
    searchEnabled = !searchEnabled;
    if (searchEnabled) {
      searchToggleBtn.classList.add('active');
      searchToggleBtn.setAttribute('title', 'Поиск Google ВКЛЮЧЕН');
    } else {
      searchToggleBtn.classList.remove('active');
      searchToggleBtn.setAttribute('title', 'Поиск Google ВЫКЛЮЧЕН');
    }
  });

  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      const base64 = await fileToBase64(file);
      stagedFiles.push({
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        base64: base64
      });
    }
    fileInput.value = '';
    renderStagedFiles();
  });

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        const base64Data = result.split(',')[1];
        resolve(base64Data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function renderStagedFiles() {
    attachmentsBar.innerHTML = '';
    if (stagedFiles.length === 0) {
      attachmentsBar.style.display = 'none';
      return;
    }
    attachmentsBar.style.display = 'flex';
    stagedFiles.forEach((f, idx) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';
      chip.textContent = f.name.length > 20 ? f.name.substring(0, 17) + '...' : f.name;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'chip-remove';
      removeBtn.innerHTML = '&times;';
      removeBtn.addEventListener('click', () => {
        stagedFiles.splice(idx, 1);
        renderStagedFiles();
      });

      chip.appendChild(removeBtn);
      attachmentsBar.appendChild(chip);
    });
  }

  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + 'px';
  });

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isGenerating && (promptInput.value.trim() !== '' || stagedFiles.length > 0)) {
        chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    }
  });

  clearBtn.addEventListener('click', () => {
    if (isGenerating) return;
    conversationHistory = [];
    stagedFiles = [];
    renderStagedFiles();
    chatContainer.innerHTML = `
      <div class="message system-message">
        <div class="message-content">История очищена. Начните новый диалог.</div>
      </div>
    `;
  });

  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = promptInput.value.trim();
    if ((!text && stagedFiles.length === 0) || isGenerating) return;

    const selectedModel = modelSelect.value;
    const currentFiles = [...stagedFiles];
    stagedFiles = [];
    renderStagedFiles();

    promptInput.value = '';
    promptInput.style.height = 'auto';

    appendUserMessage(text, currentFiles);

    const parts = [];
    currentFiles.forEach(file => {
      parts.push({
        inlineData: {
          mimeType: file.type,
          data: file.base64
        }
      });
    });

    if (text) {
      parts.push({ text: text });
    }

    conversationHistory.push({
      role: 'user',
      parts: parts
    });

    isGenerating = true;
    sendBtn.disabled = true;

    const botMessageElement = appendBotMessage(`Подключение к ${selectedModel}...`);
    const contentElement = botMessageElement.querySelector('.message-content');
    contentElement.classList.add('waiting-pulse');

    let hasError = false;
    let receivedFirstChunk = false;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: conversationHistory,
          model: selectedModel,
          enableSearch: searchEnabled,
          systemInstruction: 'Отвечай структурированно, понятно и лаконично.'
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let botFullText = '';
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
            const dataStr = trimmed.substring(6);
            if (dataStr === '[DONE]') break;

            try {
              const data = JSON.parse(dataStr);

              if (data.statusText) {
                contentElement.textContent = data.statusText;
                chatContainer.scrollTop = chatContainer.scrollHeight;
              }

              if (data.connected) {
                contentElement.textContent = `Ответ генерируется (${selectedModel})...`;
              }

              if (data.error) {
                hasError = true;
                contentElement.classList.remove('waiting-pulse');
                botFullText += `\n[${data.error}]`;
                contentElement.textContent = botFullText;
              }

              if (data.text) {
                if (!receivedFirstChunk) {
                  receivedFirstChunk = true;
                  contentElement.classList.remove('waiting-pulse');
                  contentElement.textContent = '';
                }
                botFullText += data.text;
                contentElement.textContent = botFullText;
                chatContainer.scrollTop = chatContainer.scrollHeight;
              }
            } catch (err) {}
          }
        }
      }

      if (!hasError && botFullText.trim() !== '') {
        conversationHistory.push({
          role: 'model',
          parts: [{ text: botFullText }]
        });
      } else if (hasError) {
        conversationHistory.pop();
      }
    } catch (err) {
      conversationHistory.pop();
      contentElement.classList.remove('waiting-pulse');
      contentElement.textContent = `Ошибка связи с сервером: ${err.message}`;
    } finally {
      contentElement.classList.remove('waiting-pulse');
      isGenerating = false;
      sendBtn.disabled = false;
      promptInput.focus();
    }
  });

  function appendUserMessage(text, files) {
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message', 'user-message');

    if (files && files.length > 0) {
      const attachmentsContainer = document.createElement('div');
      attachmentsContainer.className = 'message-attachments';

      files.forEach(f => {
        if (f.type.startsWith('image/')) {
          const img = document.createElement('img');
          img.className = 'chat-thumb';
          img.src = `data:${f.type};base64,${f.base64}`;
          attachmentsContainer.appendChild(img);
        } else {
          const badge = document.createElement('div');
          badge.className = 'chat-file-badge';
          badge.textContent = `📄 ${f.name}`;
          attachmentsContainer.appendChild(badge);
        }
      });
      messageDiv.appendChild(attachmentsContainer);
    }

    if (text) {
      const contentDiv = document.createElement('div');
      contentDiv.classList.add('message-content');
      contentDiv.textContent = text;
      messageDiv.appendChild(contentDiv);
    }

    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function appendBotMessage(initialText) {
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message', 'bot-message');

    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');
    contentDiv.textContent = initialText;

    messageDiv.appendChild(contentDiv);
    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return messageDiv;
  }
});
