import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client';
import { validContactPhone } from './registration-contacts';

export const registrationCandidate = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  name: z.string().trim().min(1).max(200),
  phone: z.string().refine(validContactPhone).optional(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }).optional(),
});
export type RegistrationCandidate = z.infer<typeof registrationCandidate>;

/** Read-only parity with payments.BanDecisionFor; never uses the auth writer. */
export async function registrationAllowed(database: Pick<DB, 'execute'>, candidate: RegistrationCandidate) {
  const c = registrationCandidate.parse(candidate);
  const rows = await database.execute<{ reason: string }>(sql`
    WITH input AS (
      SELECT mlm.norm_email(${c.email}) AS email_norm,
             mlm.norm_phone10(${c.phone ?? ''}) AS phone_last10,
             mlm.norm_name(${c.name}) AS name_norm,
             ${c.birthDate ?? null}::date AS birthdate
    ),
    account AS (
      SELECT p.id,
             mlm.norm_email(p.email) AS email_norm,
             mlm.norm_phone10(p.phone_number) AS phone_last10,
             mlm.norm_name(p.first_name || ' ' || p.last_name) AS name_norm,
             p.birthday AS birthdate,
             (COALESCE(p.blacklisted,false)
               OR p.status::text IN ('suspended','banned','deleted')
               OR EXISTS (
                  SELECT 1 FROM mlm.affiliate a WHERE a.person_id=p.id
                    AND a.status::text IN ('suspended','banned','deleted')
               )) AS suspended
        FROM mlm.person p
        JOIN input i ON i.email_norm IS NOT NULL AND mlm.norm_email(p.email)=i.email_norm
       LIMIT 1
    ),
    candidate AS (
      SELECT COALESCE(i.email_norm,a.email_norm) AS email_norm,
             COALESCE(i.phone_last10,a.phone_last10) AS phone_last10,
             COALESCE(i.name_norm,a.name_norm) AS name_norm,
             COALESCE(i.birthdate,a.birthdate) AS birthdate
        FROM input i LEFT JOIN account a ON true
    ),
    blacklist_match AS (
      SELECT CASE
               WHEN c.email_norm IS NOT NULL AND b.email_norm=c.email_norm THEN 'blacklist_email'
               WHEN c.phone_last10 IS NOT NULL AND b.phone_last10=c.phone_last10 THEN 'blacklist_phone'
               WHEN c.name_norm IS NOT NULL AND b.name_norm=c.name_norm THEN 'blacklist_name'
               ELSE 'blacklist'
             END AS reason
        FROM mlm.blacklist b CROSS JOIN candidate c
       WHERE (c.email_norm IS NOT NULL AND b.email_norm=c.email_norm)
          OR (c.phone_last10 IS NOT NULL AND b.phone_last10=c.phone_last10)
          OR (c.name_norm IS NOT NULL AND b.name_norm=c.name_norm
              AND (b.birthdate IS NULL OR (c.birthdate IS NOT NULL AND b.birthdate=c.birthdate)))
       ORDER BY CASE
                  WHEN c.email_norm IS NOT NULL AND b.email_norm=c.email_norm THEN 1
                  WHEN c.phone_last10 IS NOT NULL AND b.phone_last10=c.phone_last10 THEN 2
                  ELSE 3
                END
       LIMIT 1
    )
    SELECT COALESCE(
      (SELECT 'account_suspended' FROM account WHERE suspended LIMIT 1),
      (SELECT reason FROM blacklist_match LIMIT 1),''
    ) AS reason`);
  if (rows.length !== 1 || typeof rows[0]?.reason !== 'string') throw new Error('registration_precheck_unavailable');
  return rows[0].reason === '';
}
