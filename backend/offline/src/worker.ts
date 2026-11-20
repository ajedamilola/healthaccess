import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createCrypto } from './security/crypto.js';
import { Repository } from './repository.js';
import { createSmsEngine, HELP, UNAVAILABLE } from './channels/sms.js';
import {
  channelText,
  fieldText,
  renderFacility,
  renderWebLead,
  smsSegments,
} from './channels/render.js';
import { toLocale } from './channels/i18n.js';
import { createAssistant } from './services/assistant.js';
import { createWebSearch } from './services/web-search.js';
import { createSmsProvider } from './providers/africastalking.js';

export async function runWorker() {
  const config = loadConfig();
  const crypto = createCrypto(config);
  const repository = new Repository(config, crypto);
  await repository.ready();
  const search = config.serperApiKey
    ? createWebSearch(config)
    : {
        searchHealth: async () => [],
        discoverFacilities: async () => [],
        discoverEmergency: async () => [],
      };
  const assistant = createAssistant(config, { search, repository });
  const provider = createSmsProvider(config);
  const workerId = randomUUID();
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      stopping = true;
    });
  let nextMaintenance = 0;
  console.info({
    event: 'worker_started',
    smsTransport: config.smsTransport,
    aiEnabled: config.aiEnabled,
  });

  while (!stopping) {
    if (Date.now() >= nextMaintenance) {
      try {
        await repository.maintain();
      } catch {
        console.error({ event: 'retention_maintenance_failed' });
      } finally {
        nextMaintenance = Date.now() + 60000;
      }
    }
    try {
      const inbox = await repository.claimInbox(workerId);
      if (inbox) {
        try {
          await repository.processInbox(inbox, async (body, scoped, conversation) => {
            const engine = createSmsEngine({
              config,
              crypto,
              repository: scoped,
              assistant,
              search,
            });
            return engine.process(body.text, conversation);
          });
        } catch {
          await repository.failInbox(inbox);
          console.error({ event: 'sms_processing_failed', jobId: inbox.id });
        }
      }
      const outbox = await repository.claimOutbox(workerId);
      if (outbox) {
        let sendAttempted = false;
        try {
          const rendered = await repository.renderOutbox(outbox);
          if (rendered.suppressed) {
            await repository.finishOutbox(outbox, {
              state: 'expired',
              providerMessageId: null,
              retryable: false,
            });
          } else {
            let text: string;
            switch (rendered.reply.kind) {
              case 'text':
                // Final control: no links, markdown or symbols reach a basic phone.
                text = channelText(rendered.reply.text) || channelText(HELP);
                break;
              case 'emergency':
                text =
                  rendered.projection?.available && rendered.projection.fields?.length
                    ? `Emergency summary (patient-selected information):\n${fieldText(rendered.projection.fields)}`
                    : UNAVAILABLE;
                break;
              case 'facility':
                text = renderFacility(rendered.facility || null, undefined, {
                  index: rendered.reply.index,
                  total: rendered.reply.total,
                  emergency: rendered.reply.emergency,
                  locale: toLocale(rendered.reply.locale) ?? undefined,
                });
                break;
              case 'web_lead':
                text = renderWebLead(rendered.lead || null, {
                  index: rendered.reply.index,
                  total: rendered.reply.total,
                  emergency: rendered.reply.emergency,
                  locale: toLocale(rendered.reply.locale) ?? undefined,
                });
                break;
            }
            if (smsSegments(text).segments > config.smsMaxSegments) {
              text =
                'The permitted information is too long for a safe SMS reply. Use USSD or the secure patient/practitioner portal. No fields have been truncated.';
            }
            sendAttempted = true;
            const result = await provider.send({ to: rendered.phone, text });
            await repository.finishOutbox(outbox, result);
          }
        } catch {
          await repository.finishOutbox(outbox, {
            state: sendAttempted ? 'unknown' : 'failed',
            providerMessageId: null,
            retryable: !sendAttempted,
          });
        }
      }
    } catch {
      console.error({ event: 'worker_dependency_failure' });
    }
    if (!stopping) await delay(config.workerPollMs);
  }
  await repository.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorker().catch(() => {
    console.error({ event: 'worker_startup_failed' });
    process.exitCode = 1;
  });
}
