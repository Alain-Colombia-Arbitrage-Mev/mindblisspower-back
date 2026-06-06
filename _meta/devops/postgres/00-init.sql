-- Bootstrap roles + database before applying schema_mlm.sql.
-- Run as postgres superuser on a fresh cluster.

CREATE ROLE migrator   LOGIN PASSWORD 'CHANGEME' CREATEDB;
CREATE ROLE replicator LOGIN PASSWORD 'CHANGEME' REPLICATION;
CREATE ROLE app_read   NOLOGIN;
CREATE ROLE app_write  LOGIN PASSWORD 'CHANGEME';
CREATE ROLE app_admin  LOGIN PASSWORD 'CHANGEME';

GRANT app_read TO app_write;
GRANT app_write TO app_admin;

CREATE DATABASE vicionpower OWNER migrator
  ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' TEMPLATE template0;

\c vicionpower
GRANT CONNECT ON DATABASE vicionpower TO app_read, app_write, app_admin;
GRANT ALL ON DATABASE vicionpower TO migrator;

-- Now run:
--   psql -U migrator -d vicionpower -f /path/to/schema_mlm.sql
-- and from the app host:
--   bunx @better-auth/cli migrate
