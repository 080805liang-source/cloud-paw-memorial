const http = require('http');
const { main } = require('./index');

const port = Number(process.env.PORT || 9000);

http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const result = await main({
    httpMethod: request.method,
    path: request.url,
    headers: request.headers,
    body: Buffer.concat(chunks).toString('utf8')
  });
  response.writeHead(result.statusCode || 200, result.headers || {});
  response.end(result.body || '');
}).listen(port);
