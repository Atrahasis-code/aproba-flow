import './lib/env';
import { app } from './app';

const port = Number(process.env.API_PORT || '4000');

app.listen({
  port,
  hostname: '0.0.0.0',
});

console.log(`AprobaFlow API listening on http://127.0.0.1:${port}`);
