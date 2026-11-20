-- Personal context fields used to personalise the symptom assistant and the
-- SMS/USSD channels. Location and lifestyle values are patient-entered and are
-- never emergency-shared by default; pregnancy status is emergency eligible.

INSERT INTO "field_definitions" ("field_key", "label", "value_type", "emergency_eligible", "sort_order", "active", "updated_at")
VALUES
    ('city', 'City or town', 'STRING', false, 160, true, CURRENT_TIMESTAMP),
    ('state', 'State or region', 'STRING', false, 170, true, CURRENT_TIMESTAMP),
    ('country', 'Country', 'STRING', false, 180, true, CURRENT_TIMESTAMP),
    ('pregnancy_status', 'Pregnancy status', 'STRING', true, 190, true, CURRENT_TIMESTAMP),
    ('smoking_status', 'Smoking', 'STRING', false, 200, true, CURRENT_TIMESTAMP),
    ('alcohol_use', 'Alcohol use', 'STRING', false, 210, true, CURRENT_TIMESTAMP),
    ('activity_level', 'Physical activity', 'STRING', false, 220, true, CURRENT_TIMESTAMP)
ON CONFLICT ("field_key") DO NOTHING;
