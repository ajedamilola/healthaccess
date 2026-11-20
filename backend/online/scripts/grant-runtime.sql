-- Runtime role grants for the online and offline services.
-- Idempotent (GRANT is repeatable). Run as the schema owner or a superuser after
-- migrations, e.g. `psql "$DATABASE_URL_ADMIN" -f scripts/grant-runtime.sql`.
-- This script never creates roles or passwords.

GRANT USAGE ON SCHEMA public TO healthaccess_offline;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO healthaccess_offline;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO healthaccess_offline;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO healthaccess_offline;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO healthaccess_offline;

-- Cover objects created later by the database owner role, when it exists and
-- the current user may manage its default privileges.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'healthaccess_owner') THEN
    BEGIN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE healthaccess_owner IN SCHEMA public '
        || 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO healthaccess_offline';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE healthaccess_owner IN SCHEMA public '
        || 'GRANT USAGE, SELECT ON SEQUENCES TO healthaccess_offline';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping healthaccess_owner default privileges: insufficient privilege';
    END;
  END IF;
END $$;

-- Online runtime role is optional in environments that only run the offline worker.
-- Both names are covered so older and newer deployments keep working.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['healthaccess_online', 'healthaccess_web']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', role_name);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', role_name);
      EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', role_name);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
        role_name
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
        role_name
      );
    ELSE
      RAISE NOTICE '% role does not exist; skipping grants', role_name;
    END IF;
  END LOOP;
END $$;

-- LangGraph agent memory. Create the schema and run the checkpointer setup once
-- with an administrator connection; the runtime role only gets DML. The AI layer
-- skips setup when ai_agent_state.checkpoint_migrations already exists.
CREATE SCHEMA IF NOT EXISTS ai_agent_state;

GRANT USAGE, CREATE ON SCHEMA ai_agent_state TO healthaccess_offline;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai_agent_state TO healthaccess_offline;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ai_agent_state TO healthaccess_offline;
ALTER DEFAULT PRIVILEGES IN SCHEMA ai_agent_state
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO healthaccess_offline;
ALTER DEFAULT PRIVILEGES IN SCHEMA ai_agent_state
  GRANT USAGE, SELECT ON SEQUENCES TO healthaccess_offline;

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['healthaccess_online', 'healthaccess_web']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT USAGE, CREATE ON SCHEMA ai_agent_state TO %I', role_name);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai_agent_state TO %I', role_name);
      EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ai_agent_state TO %I', role_name);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA ai_agent_state GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
        role_name
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA ai_agent_state GRANT USAGE, SELECT ON SEQUENCES TO %I',
        role_name
      );
    END IF;
  END LOOP;
END $$;
