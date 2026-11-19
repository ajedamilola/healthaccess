-- Each conversation now records the language chosen when it started.
ALTER TABLE "symptom_analyses" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'en';
