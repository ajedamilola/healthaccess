import { Router } from 'express';
import { authRouter } from './modules/auth/router.js';
import { directoryRouter } from './modules/directory/router.js';
import { emergencyRouter } from './modules/emergency/router.js';
import { devicesRouter, medicationsRouter } from './modules/medications/router.js';
import { mePortalRouter, recordsRouter } from './modules/portal/router.js';
import { symptomRouter } from './modules/symptom/router.js';
import { meRouter } from './modules/users/router.js';

export const router = Router();

router.use('/auth', authRouter);
router.use('/me', meRouter);
router.use('/me', mePortalRouter);
router.use('/directory', directoryRouter);
router.use('/emergency', emergencyRouter);
router.use('/records', recordsRouter);
router.use('/symptom', symptomRouter);
router.use('/medications', medicationsRouter);
router.use('/devices', devicesRouter);

router.get('/', (_req, res) => {
  res.json({ service: 'healthaccess-online', version: 1 });
});
