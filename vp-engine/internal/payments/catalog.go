package payments

import "github.com/shopspring/decimal"

// feeRate es el 1% de manejo/activación que pagan TODOS los packs.
// Total cobrado = valor del pack + 1%. (p.ej. 50.000 → 50.500).
var (
	feeRate = decimal.NewFromFloat(0.01)
	hundred = decimal.NewFromInt(100)
)

// Pack es un paquete de inversión del catálogo (mlm.package).
type Pack struct {
	ID        int
	Name      string
	AmountUSD decimal.Decimal // valor base del pack
	PV        int
}

// FeeUSD: el 1% de activación, redondeado a centavos.
func (p Pack) FeeUSD() decimal.Decimal { return p.AmountUSD.Mul(feeRate).Round(2) }

// TotalUSD: lo que paga el cliente = pack + 1%.
func (p Pack) TotalUSD() decimal.Decimal { return p.AmountUSD.Add(p.FeeUSD()) }

// TotalCents: monto para Stripe (entero, en centavos).
func (p Pack) TotalCents() int64 { return p.TotalUSD().Mul(hundred).Round(0).IntPart() }
