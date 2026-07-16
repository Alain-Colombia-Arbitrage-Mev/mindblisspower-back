-- 43_blacklist.sql — Lista negra de registro (ban por email / teléfono / nombre).
-- Estos usuarios no pueden registrarse ni permanecer registrados. El precheck de
-- registro (BFF → vp-payments) consulta mlm.is_blacklisted antes del SignUp Cognito.
--
-- Normalización (consistente entre carga CSV, barrido de mlm.person y precheck):
--   email_norm  = lower(trim(email))
--   phone_last10= últimos 10 dígitos (tolera prefijo país / formato E.164 vs local)
--   name_norm   = lower, sin acentos, espacios colapsados
-- Matching: email OR phone_last10 OR (name_norm AND birthdate) — nombre solo es
-- demasiado débil (colisiona con homónimos), se refuerza con fecha de nacimiento.

CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE IF NOT EXISTS mlm.blacklist (
    id           bigserial PRIMARY KEY,
    fullname     text,
    username     text,
    birthdate    date,
    email        text,
    phone        text,
    email_norm   text,
    phone_last10 text,
    name_norm    text,
    motive       text,
    source       text        NOT NULL DEFAULT 'lista_negra_260619',
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blacklist_email  ON mlm.blacklist (email_norm)   WHERE email_norm  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blacklist_phone  ON mlm.blacklist (phone_last10) WHERE phone_last10 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blacklist_name   ON mlm.blacklist (name_norm)    WHERE name_norm   IS NOT NULL;

-- Normalizadores (IMMUTABLE para poder usarse en índices/expresiones).
CREATE OR REPLACE FUNCTION mlm.norm_email(p text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(lower(btrim(p)), '') $$;

-- norm_phone10: últimos 10 dígitos, PERO NULL si (a) hay menos de 10 dígitos
-- (placeholders "1","0", números incompletos) o (b) todos los dígitos son iguales
-- (0000000000, 1111111111). Sin esto, teléfonos basura colisionan con miles de
-- personas y sobre-banean. Nota: teléfonos REALES compartidos (uplines que
-- registran a su downline con su propio número) siguen colisionando — por eso el
-- barrido de usuarios existentes va por EMAIL, no por teléfono.
CREATE OR REPLACE FUNCTION mlm.norm_phone10(p text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    WITH d AS (SELECT regexp_replace(coalesce(p,''), '\D', '', 'g') AS digits)
    SELECT CASE
             WHEN length(digits) < 10 THEN NULL
             WHEN right(digits,10) ~ '^(.)\1{9}$' THEN NULL  -- todos iguales
             ELSE right(digits,10)
           END
    FROM d
$$;

CREATE OR REPLACE FUNCTION mlm.norm_name(p text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT NULLIF(regexp_replace(lower(unaccent(btrim(coalesce(p,'')))), '\s+', ' ', 'g'), '')
$$;

-- is_blacklisted: ¿el candidato coincide con la lista negra? Email o teléfono
-- (identificadores fuertes) bastan; el nombre exige además fecha de nacimiento
-- para no bloquear homónimos. birthdate opcional (NULL ⇒ solo email/phone).
CREATE OR REPLACE FUNCTION mlm.is_blacklisted(
    p_email text, p_phone text, p_name text, p_birth date DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM mlm.blacklist b
         WHERE (mlm.norm_email(p_email)   IS NOT NULL AND b.email_norm   = mlm.norm_email(p_email))
            OR (mlm.norm_phone10(p_phone) IS NOT NULL AND b.phone_last10 = mlm.norm_phone10(p_phone))
            OR (mlm.norm_name(p_name)     IS NOT NULL AND b.name_norm    = mlm.norm_name(p_name)
                AND p_birth IS NOT NULL AND b.birthdate = p_birth)
    )
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON mlm.blacklist TO vp_engine;
GRANT USAGE, SELECT ON SEQUENCE mlm.blacklist_id_seq TO vp_engine;
