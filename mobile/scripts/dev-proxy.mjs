/**
 * Мост для разработки: телефон в той же Wi-Fi сети ходит на ПК по порту 4001,
 * мост пробрасывает запросы на бэкенд, который слушает только 127.0.0.1:4000.
 * Заодно отвечает на CORS — чтобы веб-версия, открытая с телефона по адресу
 * ПК, не упиралась в список разрешённых источников бэкенда.
 *
 * Только для разработки. На рабочем сервере приложение ходит на https-адрес
 * API напрямую (EXPO_PUBLIC_API_URL), а этот файл не нужен.
 *
 *   node scripts/dev-proxy.mjs
 */
import http from 'node:http';

const TARGET = { host: '127.0.0.1', port: Number(process.env.API_PORT ?? 4000) };
const PORT = Number(process.env.PROXY_PORT ?? 4001);

const cors = (req) => ({
  'Access-Control-Allow-Origin': req.headers.origin ?? '*',
  'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'X-Request-Id, Content-Disposition',
  'Access-Control-Max-Age': '600',
});

http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors(req));
      return res.end();
    }
    const up = http.request({ ...TARGET, path: req.url, method: req.method, headers: { ...req.headers, host: `${TARGET.host}:${TARGET.port}` } }, (r) => {
      const headers = { ...r.headers };
      for (const k of Object.keys(headers)) if (k.toLowerCase().startsWith('access-control-')) delete headers[k];
      res.writeHead(r.statusCode ?? 502, { ...headers, ...cors(req) });
      r.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json', ...cors(req) });
      res.end(JSON.stringify({ error: { code: 'BAD_GATEWAY', message: 'Бэкенд не отвечает' } }));
    });
    req.pipe(up);
  })
  .listen(PORT, '0.0.0.0', () => console.log(`dev-proxy: 0.0.0.0:${PORT} -> ${TARGET.host}:${TARGET.port}`));
