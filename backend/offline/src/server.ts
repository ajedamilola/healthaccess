import { loadConfig } from './config.js';
import { createCrypto } from './security/crypto.js';
import { Repository } from './repository.js';
import { createApp } from './app.js';
import { createUssdEngine } from './channels/ussd.js';
import { createUssdHandler } from './channels/ussd-handler.js';
import { createWebSearch } from './services/web-search.js';

async function startServer() {
  const config = loadConfig();
  const crypto = createCrypto(config);
  const repository = new Repository(config, crypto);
  try {
    await repository.ready();
  } catch {
    await repository.close();
    throw new Error('Runtime database is unavailable or incorrectly privileged');
  }

  const search = config.serperApiKey
    ? createWebSearch(config)
    : {
        searchHealth: async () => [],
        discoverFacilities: async () => [],
        discoverEmergency: async () => [],
      };
  const ussdHandler = createUssdHandler({
    repository,
    crypto,
    config,
    createEngine: createUssdEngine,
    search,
  });
  const app = createApp({ config, crypto, repository, ussdHandler });
  const server = app.listen(config.port, config.host, () => {
    console.info({ event: 'server_started', port: config.port, smsTransport: config.smsTransport });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('error', () => {
    console.error({ event: 'server_listen_failed' });
    void repository.close();
    process.exitCode = 1;
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close(() => {
        void repository.close();
      });
    });
  }
}

startServer().catch(() => {
  console.error({
    event: 'server_startup_failed',
    hint: 'Check required environment keys, database connection and runtime role.',
  });
  process.exitCode = 1;
});
