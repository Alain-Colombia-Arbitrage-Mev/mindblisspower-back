// Package comms: lógica pura de comunicados masivos (sin DB ni red).
package comms

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

type Segment struct {
	Status          []string `json:"status"`
	RankIDs         []int16  `json:"rank_ids"`
	PhoneCountryIDs []int16  `json:"phone_country_ids"`
	Membership      string   `json:"membership"`
	Emails          []string `json:"emails"`
}

var validStatus = map[string]bool{"pending": true, "active": true, "suspended": true}
var validMembership = map[string]bool{"active": true, "expired": true, "any": true}
var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

const MaxEmailList = 5000

func ParseSegment(raw []byte) (Segment, error) {
	var s Segment
	if len(raw) == 0 {
		raw = []byte(`{}`)
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return Segment{}, fmt.Errorf("segment json: %w", err)
	}
	s = s.Normalize()
	for _, st := range s.Status {
		if !validStatus[st] {
			return Segment{}, fmt.Errorf("segment status inválido: %q", st)
		}
	}
	if !validMembership[s.Membership] {
		return Segment{}, fmt.Errorf("segment membership inválido: %q", s.Membership)
	}
	if len(s.Emails) > MaxEmailList {
		return Segment{}, errors.New("segment emails: máximo 5000")
	}
	for _, e := range s.Emails {
		if !emailRe.MatchString(e) {
			return Segment{}, fmt.Errorf("segment email inválido: %q", e)
		}
	}
	return s, nil
}

func (s Segment) Normalize() Segment {
	if len(s.Status) == 0 {
		s.Status = []string{"active"}
	}
	if s.Membership == "" {
		s.Membership = "any"
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(s.Emails))
	for _, e := range s.Emails {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" || seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	sort.Strings(out)
	s.Emails = out
	return s
}

// AudienceQuery devuelve el SELECT parametrizado ($1..$5) que resuelve la
// audiencia elegible. Excluye SIEMPRE: blacklisted, admins, bajas, supresión y
// emails con formato inválido. Con lista de emails, los demás filtros se anulan.
func AudienceQuery(s Segment) (string, []any) {
	s = s.Normalize()
	var ranks, countries any
	membership := s.Membership
	var emails any
	status := s.Status
	if len(s.Emails) > 0 {
		emails = s.Emails
		membership = "any"
		// Con lista explícita de emails los filtros se anulan (ver doc arriba):
		// también el de estado, que por defecto es solo 'active'. Si no, un email
		// cargado a mano de una persona 'pending' o 'suspended' se caería sin aviso.
		status = []string{"pending", "active", "suspended"}
	} else {
		if len(s.RankIDs) > 0 {
			ranks = s.RankIDs
		}
		if len(s.PhoneCountryIDs) > 0 {
			countries = s.PhoneCountryIDs
		}
	}
	sql := `
SELECT p.id, p.email::text, p.first_name
  FROM mlm.person p
  LEFT JOIN mlm.affiliate a ON a.person_id = p.id
 WHERE p.status = ANY($1::text[]::mlm.person_status[])
   AND NOT p.blacklisted
   AND p.is_admin = false
   AND ($2::smallint[] IS NULL OR a.current_rank_id = ANY($2::smallint[]))
   AND ($3::smallint[] IS NULL OR p.phone_country_id = ANY($3::smallint[]))
   AND ($4::text = 'any'
        OR ($4::text = 'active'  AND EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'active'))
        OR ($4::text = 'expired' AND NOT EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'active')
                                 AND EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'expired')))
   AND ($5::text[] IS NULL OR lower(p.email::text) = ANY($5::text[]))
   AND p.email::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
   AND NOT EXISTS (SELECT 1 FROM comms.unsubscribe u WHERE u.email = p.email)
   AND NOT EXISTS (SELECT 1 FROM comms.suppressed_email se WHERE se.email = p.email)
 ORDER BY p.id`
	return sql, []any{status, ranks, countries, membership, emails}
}

// ExclusionCountsQuery: cuántos candidatos del segmento quedan fuera y por qué.
func ExclusionCountsQuery(s Segment) (string, []any) {
	_, args := AudienceQuery(s)
	sql := `
WITH base AS (
  SELECT p.id, p.email, p.blacklisted, p.is_admin
    FROM mlm.person p
    LEFT JOIN mlm.affiliate a ON a.person_id = p.id
   WHERE p.status = ANY($1::text[]::mlm.person_status[])
     AND ($2::smallint[] IS NULL OR a.current_rank_id = ANY($2::smallint[]))
     AND ($3::smallint[] IS NULL OR p.phone_country_id = ANY($3::smallint[]))
     AND ($4::text = 'any'
          OR ($4::text = 'active'  AND EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'active'))
          OR ($4::text = 'expired' AND NOT EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'active')
                                   AND EXISTS (SELECT 1 FROM mlm.affiliate_package ap WHERE ap.affiliate_id = a.id AND ap.status = 'expired')))
     AND ($5::text[] IS NULL OR lower(p.email::text) = ANY($5::text[]))
)
SELECT
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM comms.unsubscribe u WHERE u.email = base.email))        AS unsubscribed,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM comms.suppressed_email se WHERE se.email = base.email)) AS suppressed,
  count(*) FILTER (WHERE blacklisted OR is_admin)                                                       AS blacklisted,
  count(*) FILTER (WHERE email::text !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')                                  AS invalid
FROM base`
	return sql, args
}
