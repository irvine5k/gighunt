import { createServer } from './server.js';

const port = Number(process.env.GIGHUNT_PORT ?? 4317);
const { app, token, bootstrapNonce } = await createServer();
await app.listen({ host: '127.0.0.1', port });
app.log.info(`Dashboard: http://127.0.0.1:${port}/?bootstrap=${bootstrapNonce()}`);
app.log.info(`CLI/MCP token stored securely with owner-only permissions; token prefix: ${token.slice(0, 4)}…`);
