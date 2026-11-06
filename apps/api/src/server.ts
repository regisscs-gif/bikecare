import { buildApp } from './app';
import { config } from './config';
import { createDb } from './db/client';
import { startBackgroundJobs } from './jobs';
import { expoPushSender } from './services/notify';

const db = createDb();
const app = await buildApp({ db, sender: expoPushSender });
startBackgroundJobs(app.deps);
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`API em http://localhost:${config.port}`);
