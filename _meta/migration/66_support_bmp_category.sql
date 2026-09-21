-- 66_support_bmp_category.sql
-- Categoria dedicada para soporte BMP. Evita mezclar casos de cuenta/billetera
-- BMP con retiros generales y permite asignar agentes con specialty='bmp'.

BEGIN;

ALTER TABLE support.ticket
  DROP CONSTRAINT IF EXISTS ticket_category_chk;

ALTER TABLE support.ticket
  ADD CONSTRAINT ticket_category_chk
  CHECK (category IN (
    'access',
    'payments',
    'kyc',
    'tree',
    'bmp',
    'commissions',
    'withdrawals',
    'technical',
    'general',
    'non_support'
  ));

COMMENT ON CONSTRAINT ticket_category_chk ON support.ticket IS
  'Categorias operativas de soporte, incluyendo BMP como cola especializada.';

COMMIT;
