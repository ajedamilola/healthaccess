export interface Service {
  service_code: string;
  label: string;
  description?: string | null;
}

export interface Area {
  id: string;
  name: string;
  region?: string;
  city?: string;
}

export interface Facility {
  id: string;
  name: string;
  address: string;
  phone: string | null;
  distance_km: number | null;
  service_code?: string;
  is_demo?: boolean;
}

export interface RecordField {
  key: string;
  label: string;
  value: string | string[] | number | boolean | Record<string, unknown>;
}

export interface Projection {
  available: boolean;
  fields: RecordField[];
  read_session_id?: string;
}

export interface GrantScope {
  expires_at: Date;
  revoked_at: Date | null;
  channels: string[];
  fields: string[];
}

export interface ConsentScope {
  expires_at: Date;
  revoked_at: Date | null;
  channel: string;
  fields: string[];
}

export type SmsReply =
  | { kind: 'text'; text: string; allowAfterStop?: boolean }
  | { kind: 'emergency'; codeDigest: string }
  | {
      kind: 'facility' | 'web_lead';
      id: string;
      serviceCode?: string;
      areaId?: string | null;
      radiusKm?: number;
      /** Position in the result list, for "Option 1 of 3". */
      index?: number;
      total?: number;
      /** Emergency search results get emergency wording. */
      emergency?: boolean;
      /** Language for the listing text (en, pcm, yo, ha, ig). */
      locale?: string;
    };

export interface SmsContext {
  serviceCode?: string;
  areaId?: string;
  areaIds?: string[];
  consentId?: string | null;
  skipProfile?: boolean;
  resultIds?: string[];
  resultIndex?: number;
  resultKind?: 'directory' | 'web';
  /** Patient's saved home area, offered when no area was given. */
  suggestedAreaId?: string;
  suggestedAreaLabel?: string;
  /** Recent turns for conversational memory (encrypted at rest by the repository). */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Language for this thread (en, pcm, yo, ha, ig). */
  locale?: string;
  historyEnvelope?: string;
}

export interface SmsConversation {
  state: string;
  context: SmsContext;
}
