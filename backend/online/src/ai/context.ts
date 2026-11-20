import { prisma } from '../db.js';

/**
 * A minimal, de-identified view of the patient used to personalise AI answers.
 * It never contains names, emails, phone numbers, patient codes or grant codes.
 */
export interface PatientSnapshot {
  ageYears: number | null;
  ageBand: string | null;
  sex: string | null;
  pregnancyStatus: string | null;
  location: {
    city: string | null;
    state: string | null;
    country: string | null;
    homeArea: string | null;
  };
  emergencyNumber: string;
  preferredLanguage: string;
  vitals: {
    heightCm: number | null;
    weightKg: number | null;
    bmi: number | null;
    bloodGroup: string | null;
    genotype: string | null;
    bloodPressure: string | null;
  };
  conditions: string[];
  medications: string[];
  allergies: Array<{ name: string; severity: string }>;
  lifestyle: {
    smoking: string | null;
    alcohol: string | null;
    activity: string | null;
  };
  pastEvents: string[];
  recentSymptoms: Array<{ name: string; severity: string | null; date: string }>;
}

export interface SnapshotCompleteness {
  /** 0-100 score of how much useful context the assistant has. */
  score: number;
  /** Human-readable missing items, most important first. */
  missing: Array<{ key: string; label: string; reason: string }>;
}

const EMERGENCY_NUMBERS: Record<string, string> = {
  NG: '112',
  GH: '112',
  KE: '999 or 112',
  ZA: '10177 or 112',
  UG: '999 or 112',
  TZ: '112',
  RW: '912 or 112',
  CM: '112',
  SN: '15',
  EG: '123',
  US: '911',
  CA: '911',
  GB: '999 or 112',
  IE: '112',
  IN: '112',
};

const COUNTRY_ALIASES: Record<string, string> = {
  nigeria: 'NG',
  ghana: 'GH',
  kenya: 'KE',
  'south africa': 'ZA',
  uganda: 'UG',
  tanzania: 'TZ',
  rwanda: 'RW',
  cameroon: 'CM',
  senegal: 'SN',
  egypt: 'EG',
  'united states': 'US',
  usa: 'US',
  canada: 'CA',
  'united kingdom': 'GB',
  uk: 'GB',
  ireland: 'IE',
  india: 'IN',
};

export function countryCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_ALIASES[trimmed.toLowerCase()] ?? null;
}

export function emergencyNumberFor(country: string | null | undefined): string {
  const code = countryCode(country);
  return (code && EMERGENCY_NUMBERS[code]) || '112';
}

const PHONE_LIKE = /\+?\d[\d\s().-]{8,}\d/g;

function clean(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(PHONE_LIKE, '[redacted]').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function list(value: unknown, max = 15): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const out: string[] = [];
  for (const item of items) {
    const text = clean(item);
    if (text && !out.some((existing) => existing.toLowerCase() === text.toLowerCase())) {
      out.push(text);
    }
    if (out.length >= max) break;
  }
  return out;
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = /(\d+(?:\.\d+)?)/.exec(value);
  return match ? Number(match[1]) : null;
}

/** Height is stored as free text; interpret metres, centimetres, or feet/inches. */
export function heightInCm(value: unknown): number | null {
  if (typeof value === 'string') {
    const feet = /(\d+)\s*(?:ft|feet|')\s*(\d+(?:\.\d+)?)?/i.exec(value);
    if (feet) return Math.round(Number(feet[1]) * 30.48 + Number(feet[2] ?? 0) * 2.54);
  }
  const raw = number(value);
  if (raw === null || raw <= 0) return null;
  if (raw < 3) return Math.round(raw * 100);
  return raw >= 50 && raw <= 250 ? Math.round(raw) : null;
}

export function weightInKg(value: unknown): number | null {
  const raw = number(value);
  if (raw === null || raw <= 0) return null;
  if (typeof value === 'string' && /lb|pound/i.test(value)) return Math.round(raw * 0.4536);
  return raw >= 2 && raw <= 400 ? Math.round(raw * 10) / 10 : null;
}

export function ageFrom(dateOfBirth: unknown, now = new Date()): number | null {
  if (typeof dateOfBirth !== 'string') return null;
  const date = new Date(dateOfBirth);
  if (Number.isNaN(date.getTime()) || date > now) return null;
  let age = now.getUTCFullYear() - date.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < date.getUTCMonth() ||
    (now.getUTCMonth() === date.getUTCMonth() && now.getUTCDate() < date.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

export function ageBand(age: number | null): string | null {
  if (age === null) return null;
  if (age < 1) return 'infant';
  if (age < 5) return 'young child (1-4)';
  if (age < 13) return 'child (5-12)';
  if (age < 18) return 'teenager (13-17)';
  if (age < 40) return 'adult (18-39)';
  if (age < 65) return 'adult (40-64)';
  return 'older adult (65+)';
}

function medicationText(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const drug = clean(record.drug, 80);
  if (!drug) return null;
  const extra = [clean(record.dose, 40), clean(record.frequency, 40)].filter(Boolean).join(', ');
  return extra ? `${drug} (${extra})` : drug;
}

export async function buildPatientSnapshot(
  patientId: string,
  now = new Date(),
): Promise<PatientSnapshot | null> {
  const profile = await prisma.patientProfile.findUnique({
    where: { id: patientId },
    select: {
      preferred_language: true,
      home_area: { select: { name: true, city: true, region: true, country_code: true } },
      field_values: { select: { field_key: true, value: true } },
      allergies: { select: { name: true, severity: true }, orderBy: { created_at: 'desc' }, take: 20 },
      medical_events: {
        select: { name: true, occurred_on: true },
        orderBy: { created_at: 'desc' },
        take: 10,
      },
      medication_schedules: {
        where: { OR: [{ end_date: null }, { end_date: { gte: now } }] },
        select: { medications: true },
        orderBy: { created_at: 'desc' },
        take: 5,
      },
      symptom_analyses: {
        where: { name: { not: null }, created_at: { gte: new Date(now.getTime() - 180 * 864e5) } },
        select: { name: true, severity: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: 6,
      },
    },
  });
  if (!profile) return null;

  const fields = new Map(profile.field_values.map((entry) => [entry.field_key, entry.value]));
  const field = (key: string) => clean(fields.get(key));
  const age = ageFrom(fields.get('date_of_birth'), now);
  const heightCm = heightInCm(fields.get('height'));
  const weightKg = weightInKg(fields.get('weight'));
  const bmi =
    heightCm && weightKg ? Math.round((weightKg / (heightCm / 100) ** 2) * 10) / 10 : null;

  const country = field('country') ?? profile.home_area?.country_code ?? null;
  const allergyNames = new Map<string, { name: string; severity: string }>();
  for (const allergy of profile.allergies) {
    const name = clean(allergy.name);
    if (name) allergyNames.set(name.toLowerCase(), { name, severity: allergy.severity });
  }
  for (const name of list(fields.get('allergies'))) {
    if (!allergyNames.has(name.toLowerCase())) {
      allergyNames.set(name.toLowerCase(), { name, severity: 'UNKNOWN' });
    }
  }

  const medications = list([
    ...list(fields.get('current_medications')),
    ...list(fields.get('existing_medications')),
    ...profile.medication_schedules.flatMap((schedule) =>
      Array.isArray(schedule.medications)
        ? schedule.medications.map(medicationText).filter((item): item is string => Boolean(item))
        : [],
    ),
  ]);

  return {
    ageYears: age,
    ageBand: ageBand(age),
    sex: field('gender'),
    pregnancyStatus: field('pregnancy_status'),
    location: {
      city: field('city') ?? profile.home_area?.city ?? null,
      state: field('state') ?? profile.home_area?.region ?? null,
      country,
      homeArea: profile.home_area
        ? [profile.home_area.name, profile.home_area.city].filter(Boolean).join(', ')
        : null,
    },
    emergencyNumber: emergencyNumberFor(country),
    preferredLanguage: profile.preferred_language || 'en',
    vitals: {
      heightCm,
      weightKg,
      bmi,
      bloodGroup: field('blood_group'),
      genotype: field('genotype'),
      bloodPressure: field('blood_pressure'),
    },
    conditions: list([...list(fields.get('conditions')), ...list(fields.get('existing_conditions'))]),
    medications,
    allergies: [...allergyNames.values()],
    lifestyle: {
      smoking: field('smoking_status'),
      alcohol: field('alcohol_use'),
      activity: field('activity_level'),
    },
    pastEvents: profile.medical_events
      .map((event) => {
        const name = clean(event.name);
        if (!name) return null;
        return event.occurred_on ? `${name} (${event.occurred_on.toISOString().slice(0, 7)})` : name;
      })
      .filter((item): item is string => Boolean(item)),
    recentSymptoms: profile.symptom_analyses
      .map((symptom) => ({
        name: clean(symptom.name) ?? '',
        severity: symptom.severity,
        date: symptom.created_at.toISOString().slice(0, 10),
      }))
      .filter((symptom) => symptom.name),
  };
}

export function snapshotCompleteness(snapshot: PatientSnapshot | null): SnapshotCompleteness {
  const checks: Array<{ key: string; label: string; reason: string; weight: number; ok: boolean }> = [
    {
      key: 'date_of_birth',
      label: 'Date of birth',
      reason: 'Age changes which causes are likely and which advice is safe.',
      weight: 20,
      ok: snapshot?.ageYears != null,
    },
    {
      key: 'gender',
      label: 'Sex or gender',
      reason: 'Some conditions and medicines depend on sex.',
      weight: 15,
      ok: Boolean(snapshot?.sex),
    },
    {
      key: 'city',
      label: 'Location',
      reason: 'Local illnesses (such as malaria), care options and the emergency number depend on where you are.',
      weight: 20,
      ok: Boolean(snapshot?.location.city || snapshot?.location.homeArea),
    },
    {
      key: 'allergies',
      label: 'Allergies',
      reason: 'So the assistant never suggests something you react to.',
      weight: 15,
      ok: Boolean(snapshot?.allergies.length),
    },
    {
      key: 'current_medications',
      label: 'Current medications',
      reason: 'To check for interactions and side effects.',
      weight: 15,
      ok: Boolean(snapshot?.medications.length),
    },
    {
      key: 'conditions',
      label: 'Long-term conditions',
      reason: 'Conditions like diabetes, asthma or sickle cell change what is urgent.',
      weight: 10,
      ok: Boolean(snapshot?.conditions.length),
    },
    {
      key: 'weight',
      label: 'Height and weight',
      reason: 'Helps judge risk and general health.',
      weight: 5,
      ok: Boolean(snapshot?.vitals.weightKg && snapshot.vitals.heightCm),
    },
  ];
  const score = checks.reduce((total, check) => total + (check.ok ? check.weight : 0), 0);
  return {
    score,
    missing: checks
      .filter((check) => !check.ok)
      .map(({ key, label, reason }) => ({ key, label, reason })),
  };
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  yo: 'Yoruba',
  ha: 'Hausa',
  ig: 'Igbo',
  fr: 'French',
  pcm: 'Nigerian Pidgin',
  sw: 'Swahili',
  ar: 'Arabic',
  pt: 'Portuguese',
};

export function languageName(code: string | null | undefined): string {
  if (!code) return 'English';
  return LANGUAGE_NAMES[code.toLowerCase().split('-')[0]!] ?? code;
}

/** Render the snapshot as compact prompt text. Omits anything unknown. */
export function renderSnapshot(snapshot: PatientSnapshot): string {
  const lines: string[] = [];
  const push = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== '') lines.push(`- ${label}: ${value}`);
  };
  push(
    'Age',
    snapshot.ageYears !== null ? `${snapshot.ageYears} years (${snapshot.ageBand})` : null,
  );
  push('Sex/gender', snapshot.sex);
  push('Pregnancy status', snapshot.pregnancyStatus);
  const place = [snapshot.location.city, snapshot.location.state, snapshot.location.country]
    .filter(Boolean)
    .join(', ');
  push('Location', place || snapshot.location.homeArea);
  push('Local emergency number', snapshot.emergencyNumber);
  push('Preferred language', languageName(snapshot.preferredLanguage));
  push('Height', snapshot.vitals.heightCm ? `${snapshot.vitals.heightCm} cm` : null);
  push('Weight', snapshot.vitals.weightKg ? `${snapshot.vitals.weightKg} kg` : null);
  push('BMI', snapshot.vitals.bmi);
  push('Blood group', snapshot.vitals.bloodGroup);
  push('Genotype', snapshot.vitals.genotype);
  push('Blood pressure (patient reported)', snapshot.vitals.bloodPressure);
  push('Long-term conditions', snapshot.conditions.join('; '));
  push('Current medications', snapshot.medications.join('; '));
  push(
    'Allergies',
    snapshot.allergies
      .map((allergy) =>
        allergy.severity === 'UNKNOWN'
          ? allergy.name
          : `${allergy.name} (${allergy.severity.toLowerCase()})`,
      )
      .join('; '),
  );
  push('Smoking', snapshot.lifestyle.smoking);
  push('Alcohol', snapshot.lifestyle.alcohol);
  push('Physical activity', snapshot.lifestyle.activity);
  push('Past medical events', snapshot.pastEvents.join('; '));
  push(
    'Recent symptom conversations',
    snapshot.recentSymptoms
      .map(
        (symptom) =>
          `${symptom.name}${symptom.severity ? ` (${symptom.severity.toLowerCase()})` : ''} on ${symptom.date}`,
      )
      .join('; '),
  );
  return lines.length ? lines.join('\n') : '- No personal details have been saved yet.';
}
