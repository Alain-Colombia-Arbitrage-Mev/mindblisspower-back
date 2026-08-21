-- 56_ban_engine_name_match.sql
-- Refuerza el motor SQL de blacklist para permitir vetos por nombre exacto
-- normalizado cuando la fila mlm.blacklist fue creada sin birthdate.

CREATE OR REPLACE FUNCTION mlm.is_blacklisted(
    p_email text, p_phone text, p_name text, p_birth date DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
          FROM mlm.blacklist b
         WHERE (mlm.norm_email(p_email)   IS NOT NULL AND b.email_norm   = mlm.norm_email(p_email))
            OR (mlm.norm_phone10(p_phone) IS NOT NULL AND b.phone_last10 = mlm.norm_phone10(p_phone))
            OR (mlm.norm_name(p_name)     IS NOT NULL AND b.name_norm    = mlm.norm_name(p_name)
                AND (b.birthdate IS NULL OR (p_birth IS NOT NULL AND b.birthdate = p_birth)))
    )
$$;
