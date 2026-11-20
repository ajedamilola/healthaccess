import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { buildPatientSnapshot, languageName, snapshotCompleteness } from '../../ai/context.js';
import { prisma } from '../../db.js';
import { requireAuth } from '../../middleware/auth.js';
import { AppError } from '../../middleware/error.js';
import {
  assertStorageConfigured,
  loadMe,
  medicalEventPatchSchema,
  medicalUpdateSchema,
  profilePatchSchema,
  removeAllergy,
  removeMedicalEvent,
  updateAvatar,
  updateMedical,
  updateMedicalEvent,
  updateProfile,
} from './service.js';

export const meRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});
const uuidSchema = z.string().uuid();

meRouter.get('/', requireAuth, async (req, res) => {
  res.json(await loadMe(req.auth!.accountId));
});

// What the assistant will know about the patient when they share their record,
// and which missing details would make answers more accurate.
meRouter.get('/assistant-context', requireAuth, async (req, res) => {
  const profile = await prisma.patientProfile.findUnique({
    where: { account_id: req.auth!.accountId },
    select: { id: true },
  });
  const snapshot = profile ? await buildPatientSnapshot(profile.id) : null;
  res.json({
    snapshot,
    language: languageName(snapshot?.preferredLanguage),
    completeness: snapshotCompleteness(snapshot),
  });
});

meRouter.patch('/', requireAuth, async (req, res) => {
  const input = profilePatchSchema.parse(req.body);
  res.json(await updateProfile(req.auth!.accountId, input));
});

meRouter.put('/medical', requireAuth, async (req, res) => {
  const input = medicalUpdateSchema.parse(req.body);
  res.json(await updateMedical(req.auth!.accountId, input, req.requestId));
});

meRouter.post(
  '/avatar',
  requireAuth,
  (req, res, next) => {
    upload.single('image')(req, res, (error) => {
      if (error) {
        next(new AppError(400, 'Invalid image upload', 'invalid_upload'));
        return;
      }
      next();
    });
  },
  async (req, res) => {
    assertStorageConfigured();
    if (!req.file) {
      throw new AppError(400, 'Image file is required', 'image_required');
    }
    res.json(await updateAvatar(req.auth!.accountId, req.file.buffer));
  },
);

meRouter.delete('/allergies/:id', requireAuth, async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const removed = await removeAllergy(req.auth!.accountId, id);
  if (!removed) {
    throw new AppError(404, 'Allergy not found', 'not_found');
  }
  res.status(204).end();
});

meRouter.delete('/medical-events/:id', requireAuth, async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const removed = await removeMedicalEvent(req.auth!.accountId, id);
  if (!removed) {
    throw new AppError(404, 'Medical event not found', 'not_found');
  }
  res.status(204).end();
});

meRouter.patch('/medical-events/:id', requireAuth, async (req, res) => {
  const id = uuidSchema.parse(req.params.id);
  const input = medicalEventPatchSchema.parse(req.body);
  const event = await updateMedicalEvent(req.auth!.accountId, id, input);
  res.json({ event });
});
