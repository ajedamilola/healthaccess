-- Emergency care requests resolved through live web/maps search.

-- CreateEnum
CREATE TYPE "EmergencyRequestChannel" AS ENUM ('WEB', 'SMS', 'USSD');

-- CreateEnum
CREATE TYPE "EmergencyRequestStatus" AS ENUM ('SEARCHED', 'MATCHED', 'NO_MATCH', 'FAILED');

-- CreateTable
CREATE TABLE "emergency_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID,
    "account_id" UUID,
    "channel" "EmergencyRequestChannel" NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'emergency',
    "area_id" UUID,
    "location_text" TEXT,
    "latitude" DECIMAL(8,6),
    "longitude" DECIMAL(9,6),
    "status" "EmergencyRequestStatus" NOT NULL DEFAULT 'SEARCHED',
    "results" JSONB NOT NULL DEFAULT '[]',
    "request_id" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "emergency_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "emergency_requests_account_id_created_at_idx" ON "emergency_requests"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "emergency_requests_patient_id_created_at_idx" ON "emergency_requests"("patient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "emergency_requests_channel_created_at_idx" ON "emergency_requests"("channel", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "emergency_requests" ADD CONSTRAINT "emergency_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_requests" ADD CONSTRAINT "emergency_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_requests" ADD CONSTRAINT "emergency_requests_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
