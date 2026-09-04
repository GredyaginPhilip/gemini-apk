# ТЕХНИЧЕСКОЕ ЗАДАНИЕ (ТЗ)
## Проект: Gemini 3.8 Flash Mobile Gateway, Portal & Android Client

### 1. НАЗНАЧЕНИЕ И ЦЕЛИ СИСТЕМЫ
* Назначение: Автономное клиент-серверное мобильное решение для прямого доступа к моделям Gemini 3.x (gemini-3.8-flash) без VPN, с персональным порталом и базой ключей.
* Цели:
  1. Проксирование и обход блокировок через VPS в Нидерландах.
  2. Отказоустойчивый дозвон до 100 попыток с джиттером (2.5-4.5с) при кодах 503 и 429.
  3. Обход квот: автоотключение Google Search при отсутствии платного биллинга.
  4. Синхронизация времени: динамическое внедрение даты и времени по поясу UTC+4 (Ижевск).
  5. Мультимодальность: поддержка анализа файлов и видео до 200 МБ через Google File API.
  6. Централизованная JSON-база ключей: хранение ключей в keys.json и выдача через GET /api/keys.
  7. Мультиплатформенный клиент: защищенный веб-портал (HTTPS), PWA и автономный Android APK.

### 2. АРХИТЕКТУРА СИСТЕМЫ
Смартфон / ПК (HTTPS / SSE напрямую без VPN)
  -> Nginx (Порты 80 и 443 SSL с сертификатом тестовая-площадка-филиппа.рф)
     ├── /           -> Портал (/var/www/html/index.html)
     ├── /chat       -> PWA-чат (/var/www/gemini-app/public)
     ├── /gemini.apk -> Скачивание Android APK
     └── /api/       -> Node.js Express Gateway (127.0.0.1:3000)
            ├── GET  /api/keys   -> Чтение keys.json
            ├── GET  /api/health -> Диагностика и время UTC+4
            └── POST /api/chat   -> SSE потоковый шлюз к Gemini 3.8 Flash & Google File API

### 3. ТРЕБОВАНИЯ К КОМПОНЕНТАМ
* Серверный шлюз: Node.js 18+ LTS, Express, PM2. Потоковая передача SSE. Лимит тела 200 МБ. Интеграция Google File API для медиафайлов > 12 МБ.
* Веб-портал и PWA: Адаптивный mobile-first интерфейс, динамическая загрузка ключей через fetch('/api/keys'), safe-area, manifest.json и кэширующий sw.js.
* Android клиент: Полноэкранный WebView на Java 17, обработчик WebChromeClient.onShowFileChooser для системной галереи, перехват кнопки Назад.
* CI/CD: Сценарий GitHub Actions (.github/workflows/build-apk.yml) для облачной сборки APK без нагрузки на сервер.

### 4. СПЕЦИФИКАЦИЯ API
* POST /api/chat — передача массива contents, model, systemInstruction. Возврат потока SSE (statusText, connected, text, [DONE]).
* GET /api/keys — выдача JSON-массива активных ключей доступа.
* GET /api/health — контроль работоспособности и проверка времени сервера.
