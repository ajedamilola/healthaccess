import type { Config } from '../config.js';
import type { Crypto } from '../security/crypto.js';
import type { Repository } from '../repository.js';
import type { UssdCallback } from '../app.js';
import type { createUssdEngine, UssdSearch } from './ussd.js';

const EXPIRED = 'END Session ended or expired. Please redial.';

export function parseUssdPath(text: string): string[] {
  if (text === '') return [];
  const tokens = text.split('*');
  if (
    tokens.length > 50 ||
    tokens.some((token) => !token.trim() || token.length > 120 || /[\x00-\x1f\x7f]/.test(token))
  ) {
    throw new Error('Invalid USSD path');
  }
  return tokens;
}

export function createUssdHandler({
  repository,
  crypto,
  createEngine,
  config,
  search,
}: {
  repository: Pick<Repository, 'withUssdSession'>;
  crypto: Pick<Crypto, 'digestPhone' | 'fingerprint' | 'digestCode'>;
  createEngine: typeof createUssdEngine;
  config: Config;
  search?: UssdSearch;
}) {
  return async (body: UssdCallback, requestId: string) => {
    let tokens;
    try {
      tokens = parseUssdPath(body.text);
    } catch {
      return EXPIRED;
    }
    const phoneDigest = crypto.digestPhone(body.phoneNumber);
    const fingerprint = crypto.fingerprint(body.text);
    return repository.withUssdSession(body, requestId, async (session, scopedRepository) => {
      if (
        !session ||
        session.phoneDigest !== phoneDigest ||
        session.serviceCode !== body.serviceCode ||
        new Date(session.expiresAt) <= new Date()
      )
        return EXPIRED;
      const depth = tokens.length;
      const same = depth === session.inputDepth && session.inputFingerprint === fingerprint;
      const next =
        depth === session.inputDepth + 1 &&
        crypto.fingerprint(tokens.slice(0, -1).join('*')) === session.inputFingerprint;
      const initial = session.inputDepth === -1 && depth === 0;
      if (!same && !next && !initial) return EXPIRED;
      if (session.state === 'END' && !same) return EXPIRED;
      const engine = createEngine({ repository: scopedRepository, config, crypto, search });
      const result = same
        ? await engine.replay(session)
        : await engine.transition(session, initial ? null : tokens[depth - 1]);
      if (
        !result?.response ||
        !/^(CON|END) /.test(result.response) ||
        result.response.length > config.ussdMaxChars
      ) {
        throw new Error('Invalid USSD renderer output');
      }
      await scopedRepository.saveSession({
        ...result,
        inputDepth: depth,
        inputFingerprint: fingerprint,
      });
      return result.response;
    });
  };
}
