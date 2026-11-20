import type { Facility, RecordField, WebLead } from '../types.js';
import { t, type Locale } from './i18n.js';

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s)\]]+/gi;
const BARE_LINK_PATTERN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|gov|ng|uk|int|io|info|health)(?:\/[^\s)\]]*)?/gi;
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;

const LETTER_MAP: Record<string, string> = {
  '\u0253': 'b', '\u0181': 'B', '\u0257': 'd', '\u018a': 'D', '\u0199': 'k', '\u0198': 'K',
  '\u01b4': 'y', '\u01b3': 'Y', '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"',
  '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u00a0': ' ', '\u2022': '-', '\u20a6': 'N',
};

/**
 * Final control on every AI or system message sent by SMS: no links, web addresses
 * or emails; no markdown; plain characters only. Yoruba, Hausa and Igbo letters are
 * written without diacritics (as most people text) so the SMS stays GSM-7.
 */
export function channelText(text: string, options: { keepSiteNames?: string[] } = {}): string {
  let value = text.replace(URL_PATTERN, '').replace(EMAIL_PATTERN, '');
  value = value.replace(BARE_LINK_PATTERN, (match) =>
    options.keepSiteNames?.includes(match.toLowerCase()) ? match : '',
  );
  value = value
    .replace(/\*\*|__|`+/g, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[*\u2022]\s+/gm, '- ')
    .replace(/\[([^\]]*)\]\(\s*\)/g, '$1')
    .replace(/[\u0253\u0181\u0257\u018a\u0199\u0198\u01b4\u01b3\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u00a0\u2022\u20a6]/g, (c) => LETTER_MAP[c] ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    // Anything left outside printable ASCII (emoji, symbols) is dropped.
    .replace(/[^\x20-\x7e\n]/g, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/:\s*(?=\n|$)/g, (match, offset: number, whole: string) =>
      // Drop a label left dangling by a removed link ("Source: ").
      /(?:Source|Map|Link|Website)$/i.test(whole.slice(Math.max(0, offset - 8), offset)) ? '' : match,
    )
    .replace(/^\s*(?:Source|Map|Link|Website)\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return value;
}

const labels: Record<string, string> = {
  full_name: 'Name',
  date_of_birth: 'Date of birth',
  allergies: 'Allergies',
  current_medications: 'Medications',
  conditions: 'Conditions',
  blood_group: 'Blood group',
  emergency_contact_name: 'Contact name',
  emergency_contact_phone: 'Contact phone',
};

export function fieldText(fields: RecordField[]) {
  return fields
    .map((field) => {
      const value = Array.isArray(field.value) ? field.value.join(', ') : String(field.value);
      return `${labels[field.key] || field.label || field.key}: ${value}`;
    })
    .join('\n');
}

export interface ListingContext {
  index?: number;
  total?: number;
  emergency?: boolean;
  locale?: Locale;
}

/** Tidy a web address for SMS: drop postcodes, the country and repeated parts. */
export function tidyAddress(address: string): string {
  const parts: string[] = [];
  for (const [position, raw] of address.split(',').entries()) {
    // Only a number trailing a later place segment ("Lagos 100211") is a postcode;
    // house and plot numbers ("Plot 123456 Admiralty Way") are kept.
    const part = (position === 0 ? raw : raw.replace(/\s+\d{5,6}\s*$/, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (/^\d{5,6}$/.test(part) && position > 0) continue;
    if (!part || /^nigeria$/i.test(part)) continue;
    if (parts.some((existing) => existing.toLowerCase() === part.toLowerCase())) continue;
    parts.push(part);
  }
  // "1, Veta Close" reads better as "1 Veta Close".
  return parts.join(', ').replace(/^(\d+[A-Za-z]?), /, '$1 ');
}

function tidyName(name: string): string {
  return name
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:Ltd\.?|Limited|LLC|Plc)\b/gi, '')
    .trim();
}

function heading(context: ListingContext, name: string): string {
  const locale = context.locale;
  const position =
    context.total && context.total > 1 && context.index !== undefined
      ? ` ${context.index + 1}/${context.total}`
      : '';
  if (!position && context.total === 1)
    return `${t(locale, context.emergency ? 'nearestEmergency' : 'nearestOption')}: ${name}`;
  return `${t(locale, context.emergency ? 'emergencyOption' : 'option')}${position}: ${name}`;
}

function nextStep(context: ListingContext): string {
  // Older queued replies carry no position; assume more may follow rather than
  // wrongly telling the person the list is finished.
  const more =
    context.total === undefined || context.index === undefined || context.index + 1 < context.total;
  if (context.emergency) return t(context.locale, more ? 'replyMoreEmergency' : 'emergencyOnly');
  return t(context.locale, more ? 'replyMore' : 'searchAgain');
}

export function renderFacility(
  facility: Facility | null,
  serviceLabel?: string,
  context: ListingContext = {},
) {
  if (!facility)
    return 'That clinic is no longer listed. Tell me the care you need and your area, and I will search again.';
  const lines = [
    heading(context, `${facility.is_demo ? '(Demo) ' : ''}${facility.name}${serviceLabel ? ` (${serviceLabel})` : ''}`),
    tidyAddress(facility.address),
  ];
  if (Number.isFinite(Number(facility.distance_km)) && facility.distance_km !== null)
    lines.push(t(context.locale, 'aboutKm', { km: Number(facility.distance_km).toFixed(1) }));
  lines.push(facility.phone ? `${t(context.locale, 'call')}: ${facility.phone}` : t(context.locale, 'noPhone'));
  lines.push(t(context.locale, 'fromDirectory'));
  lines.push(nextStep(context));
  return channelText(lines.join('\n'));
}

export function renderWebLead(
  lead: Pick<WebLead, 'name' | 'address' | 'phone' | 'source_url'> | null,
  context: ListingContext = {},
) {
  if (!lead) return 'That listing is no longer available. Tell me your area and I will search again.';
  try {
    const url = new URL(lead.source_url);
    if (url.protocol !== 'https:') throw new Error('Invalid source');
  } catch {
    return 'That listing has no valid source. Please contact a local health facility.';
  }
  // No map or website links by SMS: name, address and phone are what people can act on.
  return channelText(
    [
      heading(context, tidyName(lead.name)),
      tidyAddress(lead.address),
      lead.phone ? `${t(context.locale, 'call')}: ${lead.phone}` : t(context.locale, 'noPhone'),
      t(context.locale, context.emergency ? 'foundOnlineShort' : 'foundOnline'),
      nextStep(context),
    ].join('\n'),
  );
}

// Segments are submitted as one message, leaving concatenation to the provider.
// Reject overflow rather than silently truncating clinical content or dropping fields.
export function smsSegments(text: string) {
  const basic =
    '@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9 !"#\u00a4%&\'()*+,-./0123456789:;<=>?\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0';
  const extended = '^{}\\[~]|\u20ac\f';
  let septets = 0;
  let gsm = true;
  for (const character of text) {
    if (basic.includes(character)) septets += 1;
    else if (extended.includes(character)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  const units = gsm ? septets : text.length;
  return {
    encoding: gsm ? 'GSM-7' : 'UCS-2',
    segments: units <= (gsm ? 160 : 70) ? 1 : Math.ceil(units / (gsm ? 153 : 67)),
  };
}
