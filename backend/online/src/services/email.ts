import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import { config } from '../config.js';
import { AppError } from '../middleware/error.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailTransport {
  sendMail(message: SendMailOptions): Promise<unknown>;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

export function createEmailService(
  settings: SmtpSettings | null,
  transport?: EmailTransport,
) {
  let sender = transport;
  return {
    configured: settings !== null,
    async send(message: EmailMessage): Promise<void> {
      if (!settings) {
        throw new AppError(503, 'Email delivery is not configured', 'email_unavailable');
      }
      sender ??= nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
        ...(settings.user && settings.password
          ? { auth: { user: settings.user, pass: settings.password } }
          : {}),
      });
      await sender.sendMail({
        from: settings.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}

const emailService = createEmailService(config.email);

export const emailConfigured = emailService.configured;
export const sendEmail = emailService.send;
