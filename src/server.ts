import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { FileOutboxMailer } from './lib/mailer.js';
import { DiskStorage } from './lib/storage.js';

const config = loadConfig();
if (config.env === 'production') {
  // Sem provedor de e-mail configurado, verificação e redefinição de senha não funcionariam.
  throw new Error('Configure um Mailer de produção em src/server.ts antes de executar com NODE_ENV=production');
}

const db = openDatabase(config.databasePath);
// Desenvolvimento: e-mails ficam em ./var/outbox (fora do Git), nunca nos logs.
const mailer = new FileOutboxMailer('./var/outbox');
const { app } = await buildApp({ config, db, mailer, storage: new DiskStorage(config.mediaDir) });

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
