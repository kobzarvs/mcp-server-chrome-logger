# Chrome Logs MCP Server

MCP сервер для сбора логов Chrome и отправки их в Cursor для анализа ошибок и дебаг информации.

## Установка

```bash
npm install
```

## Запуск Chrome с удаленной отладкой

```bash
# Для macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Для Windows
start chrome --remote-debugging-port=9222

# Для Linux
google-chrome --remote-debugging-port=9222
```

## Запуск сервера

Для разработки:
```bash
npm run dev
```

Для продакшена:
```bash
npm run build
npm start
```

## API Endpoints

- `GET /api/status` - получение статуса сервера
- `POST /api/connect` - подключение к Chrome
- `POST /api/disconnect` - отключение от Chrome

## Переменные окружения

- `PORT` - порт сервера (по умолчанию 3000)
- `CHROME_HOST` - хост Chrome (по умолчанию localhost)
- `CHROME_PORT` - порт Chrome DevTools Protocol (по умолчанию 9222)# mcp-server-chrome-logger
