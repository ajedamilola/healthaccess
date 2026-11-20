import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/middleware/error.js';
import { createEmailService } from '../src/services/email.js';

test('email service sends plain-text messages using the configured sender', async () => {
  const sent: unknown[] = [];
  const service = createEmailService(
    {
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      user: 'mailer',
      password: 'secret',
      from: 'HealthAccess <no-reply@example.test>',
    },
    {
      async sendMail(message) {
        sent.push(message);
      },
    },
  );

  assert.equal(service.configured, true);
  await service.send({
    to: 'patient@example.test',
    subject: 'Reset your password',
    text: 'Use the reset link.',
  });
  assert.deepEqual(sent, [
    {
      from: 'HealthAccess <no-reply@example.test>',
      to: 'patient@example.test',
      subject: 'Reset your password',
      text: 'Use the reset link.',
    },
  ]);
});

test('email service fails explicitly when SMTP is not configured', async () => {
  const service = createEmailService(null);
  assert.equal(service.configured, false);
  await assert.rejects(
    service.send({ to: 'patient@example.test', subject: 'Test', text: 'Test' }),
    (error: unknown) =>
      error instanceof AppError && error.status === 503 && error.code === 'email_unavailable',
  );
});

test('email service propagates provider delivery errors', async () => {
  const service = createEmailService(
    {
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      from: 'no-reply@example.test',
    },
    {
      async sendMail() {
        throw new Error('SMTP connection failed');
      },
    },
  );
  await assert.rejects(
    service.send({ to: 'patient@example.test', subject: 'Test', text: 'Test' }),
    /SMTP connection failed/,
  );
});
