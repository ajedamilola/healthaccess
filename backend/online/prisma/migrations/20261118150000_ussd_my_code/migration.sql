-- USSD "My access code" menu for phones verified to a patient.
ALTER TYPE "UssdState" ADD VALUE IF NOT EXISTS 'MY_CODE';
