import type { Prisma, Severity } from '@prisma/client';
import { prisma } from '../../db.js';

export interface SymptomRecord {
  id: string;
  patient_id: string;
  account_id: string;
  name: string | null;
  severity: Severity | null;
  summary: string | null;
  include_records: boolean;
  modify_history: boolean;
  language: string;
  files: string[];
  thread_id: string | null;
  model_version: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateSymptomRecordInput {
  patient_id: string;
  account_id: string;
  include_records: boolean;
  modify_history: boolean;
  language: string;
  thread_id: string | null;
  model_version: string | null;
}

export type SymptomRecordPatch = Partial<
  Pick<SymptomRecord, 'name' | 'severity' | 'summary' | 'files' | 'model_version' | 'thread_id'>
>;

export interface SymptomStore {
  findPatientId(accountId: string): Promise<string | null>;
  findPreferredLanguage(accountId: string): Promise<string | null>;
  create(input: CreateSymptomRecordInput): Promise<SymptomRecord>;
  listByAccount(
    accountId: string,
    skip: number,
    take: number,
  ): Promise<{ items: SymptomRecord[]; total: number }>;
  findOwned(id: string, accountId: string): Promise<SymptomRecord | null>;
  updateOwned(
    id: string,
    accountId: string,
    patch: SymptomRecordPatch,
  ): Promise<SymptomRecord | null>;
  deleteOwned(id: string, accountId: string): Promise<boolean>;
}

export const prismaSymptomStore: SymptomStore = {
  async findPatientId(accountId) {
    const profile = await prisma.patientProfile.findUnique({
      where: { account_id: accountId },
      select: { id: true },
    });
    return profile?.id ?? null;
  },

  async findPreferredLanguage(accountId) {
    const profile = await prisma.patientProfile.findUnique({
      where: { account_id: accountId },
      select: { preferred_language: true },
    });
    return profile?.preferred_language ?? null;
  },

  async create(input) {
    return prisma.symptomAnalysis.create({ data: input });
  },

  async listByAccount(accountId, skip, take) {
    const where = { account_id: accountId };
    const [items, total] = await Promise.all([
      prisma.symptomAnalysis.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take,
      }),
      prisma.symptomAnalysis.count({ where }),
    ]);
    return { items, total };
  },

  async findOwned(id, accountId) {
    return prisma.symptomAnalysis.findFirst({ where: { id, account_id: accountId } });
  },

  async updateOwned(id, accountId, patch) {
    const data: Prisma.SymptomAnalysisUpdateManyMutationInput = {
      ...patch,
    };
    const result = await prisma.symptomAnalysis.updateMany({
      where: { id, account_id: accountId },
      data,
    });
    if (result.count === 0) return null;
    return prisma.symptomAnalysis.findFirst({ where: { id, account_id: accountId } });
  },

  async deleteOwned(id, accountId) {
    const result = await prisma.symptomAnalysis.deleteMany({
      where: { id, account_id: accountId },
    });
    return result.count > 0;
  },
};
