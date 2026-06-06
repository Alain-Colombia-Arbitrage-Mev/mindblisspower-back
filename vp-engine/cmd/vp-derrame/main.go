// Command vp-derrame is a deterministic, period-by-period walkthrough of
// the binary plan for a single archetypal affiliate. It shows how PV flows
// from directs up the tree, how blocks pay, how the daily cap (T3) and the
// lifetime cap (T2) bite, how the R2 yield accrues, and how the 12-month
// capital lock decays.
//
// No randomness, no simulator. This is the presentation tool — what you
// show to a sponsor or regulator to explain the math.
//
// Usage:
//
//	vp-derrame                                  # defaults: $500 pkg, 1L+1R direct, 26 wk
//	vp-derrame --pkg 1000 --vol 1000 --periods 52
//	vp-derrame --pkg 500 --no-yield --no-lock   # plain binary only
//	vp-derrame --period-cap-factor 1.0          # generous T3
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/shopspring/decimal"

	"github.com/vicionpower/vp-engine/internal/simulator"
)

func main() {
	var (
		periods       = flag.Int("periods", 26, "periodos a recorrer (semanas)")
		pkg           = flag.Float64("pkg", 500, "precio del paquete del afiliado")
		volPerDirect  = flag.Float64("vol", 500, "PV/periodo aportado por cada directo (su recompra)")
		directsLeft   = flag.Int("dl", 1, "directos en la pierna izquierda")
		directsRight  = flag.Int("dr", 1, "directos en la pierna derecha")
		periodCapF    = flag.Float64("period-cap-factor", 0.5, "T3 = factor × PackagePrice por periodo")
		alpha         = flag.Float64("alpha", 0.45, "treasury alpha (informativo, no se aplica en este modo)")
		yieldRate     = flag.Float64("yield-rate", 0.25, "R2 anual yield (sólo si --yield)")
		yieldCadence  = flag.Int("yield-cadence", 4, "periodos entre pagos de yield")
		yieldOn       = flag.Bool("yield", true, "habilitar yield R2")
		lockOn        = flag.Bool("lock", true, "habilitar lock 12m sobre capital")
		lockPeriods   = flag.Int("lock-periods", 52, "duración del lock en periodos")
		pointsOn      = flag.Bool("points", true, "habilitar bono de puntos R3 (1 punto / bloque)")
		pointsPerBlk  = flag.Float64("points-per-block", 1.0, "puntos otorgados por cada bloque cerrado")
		pointsPerPt   = flag.Float64("points-dollars", 1.0, "$ por punto al pagarse")
		pointsCadence = flag.Int("points-cadence", 4, "periodos entre pagos de puntos")
	)
	flag.Parse()

	plan := simulator.V1Conservative()
	plan.PeriodCapFactor = decimal.NewFromFloat(*periodCapF)
	plan.TreasuryAlpha = decimal.NewFromFloat(*alpha)
	plan.YieldEnabled = *yieldOn
	plan.YieldAnnualRate = decimal.NewFromFloat(*yieldRate)
	plan.YieldCadencePeriods = *yieldCadence
	plan.PointsBonusEnabled = *pointsOn
	plan.PointsPerBlock = decimal.NewFromFloat(*pointsPerBlk)
	plan.PointsDollarsPerPoint = decimal.NewFromFloat(*pointsPerPt)
	plan.PointsCadencePeriods = *pointsCadence
	if !*lockOn {
		plan.CapitalLockPeriods = 0
	} else {
		plan.CapitalLockPeriods = *lockPeriods
	}

	pkgD := decimal.NewFromFloat(*pkg)
	volD := decimal.NewFromFloat(*volPerDirect)

	balanced := *directsLeft >= 1 && *directsRight >= 1
	r2Qual := balanced && plan.YieldEnabled
	r2Monthly := pkgD.Mul(plan.YieldAnnualRate).Div(decimal.NewFromInt(12)).RoundDown(2)

	printHeader(*periods, pkgD, *directsLeft, *directsRight, volD, plan, balanced, r2Qual, r2Monthly)

	state := newState(pkgD)

	var (
		totalBlockBonus  = decimal.Zero
		totalYieldPaid   = decimal.Zero
		totalPointsPaid  = decimal.Zero
		pointsAccrued    = decimal.Zero
		periodCap        = plan.PeriodCapFactor.Mul(pkgD)
		lifetimeCap      = plan.LifetimeCapFactor.Mul(pkgD)
		blockUSD         = plan.BonusPerBlock
		blockSize        = decimal.NewFromInt(int64(plan.BlockSize))
		volLeft          = volD.Mul(decimal.NewFromInt(int64(*directsLeft)))
		volRight         = volD.Mul(decimal.NewFromInt(int64(*directsRight)))
	)

	fmt.Printf("%-3s %9s %9s %9s %5s %8s %7s %7s %7s %7s %7s %8s\n",
		"p", "PV_L_in", "PV_R_in", "weak", "blks", "gross", "T3_cut", "T2_cut", "yield", "pts_pay", "net", "pts_acc")
	fmt.Println(strings.Repeat("-", 120))

	for p := 1; p <= *periods; p++ {
		// 1. PV entra por ambas piernas
		state.LeftPV = state.LeftPV.Add(volLeft)
		state.RightPV = state.RightPV.Add(volRight)

		// 2. Calcular weak leg y blocks
		weak := decimalMin(state.LeftPV, state.RightPV)
		blocks := weak.Div(blockSize).IntPart()
		gross := blockUSD.Mul(decimal.NewFromInt(blocks))

		// 3. Aplicar T3 (cap por periodo)
		t3Cut := decimal.Zero
		afterT3 := gross
		if afterT3.GreaterThan(periodCap) {
			t3Cut = afterT3.Sub(periodCap)
			afterT3 = periodCap
		}

		// 4. Aplicar T2 (cap de paquete acumulado)
		t2Cut := decimal.Zero
		remainingPkg := lifetimeCap.Sub(state.PackagePaid)
		afterT2 := afterT3
		if afterT2.GreaterThan(remainingPkg) {
			t2Cut = afterT2.Sub(remainingPkg)
			afterT2 = remainingPkg
			if afterT2.Sign() < 0 {
				afterT2 = decimal.Zero
			}
		}
		netBinary := afterT2

		// 5. Yield R2 si toca
		yieldThis := decimal.Zero
		if r2Qual && p%plan.YieldCadencePeriods == 0 {
			yieldThis = r2Monthly
		}

		// 5b. R3 puntos: acumular 1 punto por bloque pagado, pagar mensual.
		pointsThis := decimal.Zero
		pointsPaid := decimal.Zero
		if plan.PointsBonusEnabled && blocks > 0 {
			pointsThis = decimal.NewFromInt(blocks).Mul(plan.PointsPerBlock)
			pointsAccrued = pointsAccrued.Add(pointsThis)
		}
		if plan.PointsBonusEnabled && p%plan.PointsCadencePeriods == 0 && pointsAccrued.Sign() > 0 {
			// Convertir a USD. Caps T3/T2 ya aplicados al binario; aquí
			// reuso el cap restante del periodo + paquete para que el modelo
			// refleje "todos los caps".
			pendiente := pointsAccrued.Mul(plan.PointsDollarsPerPoint).RoundDown(2)
			// T3 restante en ESTE periodo después del binario
			t3Rem := periodCap.Sub(netBinary)
			if t3Rem.Sign() < 0 {
				t3Rem = decimal.Zero
			}
			if pendiente.GreaterThan(t3Rem) {
				pendiente = t3Rem
			}
			// T2 restante (paquete)
			pkgRem := lifetimeCap.Sub(state.PackagePaid)
			if pendiente.GreaterThan(pkgRem) {
				pendiente = pkgRem
				if pendiente.Sign() < 0 {
					pendiente = decimal.Zero
				}
			}
			pointsPaid = pendiente
			pointsAccrued = decimal.Zero
			state.PackagePaid = state.PackagePaid.Add(pointsPaid)
		}

		// 6. Consumir PV gastado
		consumed := blockSize.Mul(decimal.NewFromInt(blocks))
		state.LeftPV = state.LeftPV.Sub(consumed)
		if state.LeftPV.Sign() < 0 {
			state.LeftPV = decimal.Zero
		}
		state.RightPV = state.RightPV.Sub(consumed)
		if state.RightPV.Sign() < 0 {
			state.RightPV = decimal.Zero
		}

		// 7. Acumular
		state.PackagePaid = state.PackagePaid.Add(netBinary)
		totalBlockBonus = totalBlockBonus.Add(netBinary)
		totalYieldPaid = totalYieldPaid.Add(yieldThis)
		totalPointsPaid = totalPointsPaid.Add(pointsPaid)

		netTotal := netBinary.Add(yieldThis).Add(pointsPaid)

		fmt.Printf("%-3d %9s %9s %9s %5d %8s %7s %7s %7s %7s %7s %8s\n",
			p,
			volLeft.StringFixed(0), volRight.StringFixed(0),
			weak.StringFixed(0), blocks,
			gross.StringFixed(2),
			t3Cut.StringFixed(2), t2Cut.StringFixed(2),
			yieldThis.StringFixed(2),
			pointsPaid.StringFixed(2),
			netTotal.StringFixed(2),
			pointsAccrued.StringFixed(0),
		)

		if state.PackagePaid.GreaterThanOrEqual(lifetimeCap) {
			fmt.Printf("\n>>> Paquete CERRADO en periodo %d: PackagePaid = $%s ≥ T2 = $%s\n",
				p, state.PackagePaid.StringFixed(2), lifetimeCap.StringFixed(2))
			break
		}
	}

	// Resumen final
	fmt.Println()
	fmt.Println(strings.Repeat("=", 80))
	fmt.Println("RESUMEN")
	fmt.Println(strings.Repeat("=", 80))
	fmt.Printf("  Paquete invertido:           $%s\n", pkgD.StringFixed(2))
	fmt.Printf("  T2 (techo de por vida):       $%s   (%.0f%% del paquete)\n",
		lifetimeCap.StringFixed(2), mustFloat(plan.LifetimeCapFactor)*100)
	fmt.Printf("  T3 (techo por periodo):       $%s   (%.0f%% del paquete)\n",
		periodCap.StringFixed(2), *periodCapF*100)
	fmt.Printf("  Bono binario acumulado:       $%s\n", totalBlockBonus.StringFixed(2))
	fmt.Printf("  Yield R2 acumulado:           $%s\n", totalYieldPaid.StringFixed(2))
	fmt.Printf("  Bono puntos R3 acumulado:     $%s\n", totalPointsPaid.StringFixed(2))
	if pointsAccrued.Sign() > 0 {
		fmt.Printf("  Puntos pendientes (sin pagar): %s pts ($%s al próximo cierre mensual)\n",
			pointsAccrued.StringFixed(0),
			pointsAccrued.Mul(plan.PointsDollarsPerPoint).StringFixed(2))
	}
	fmt.Printf("  Total acreditado:             $%s\n",
		totalBlockBonus.Add(totalYieldPaid).Add(totalPointsPaid).StringFixed(2))

	if plan.CapitalLockPeriods > 0 {
		releaseAt := plan.CapitalLockPeriods
		fmt.Printf("  Capital BLOQUEADO hasta:      periodo %d (lock 12m sobre depósito)\n", releaseAt)
		if *periods < releaseAt {
			fmt.Printf("  Capital aún bloqueado al cierre de la simulación.\n")
		} else {
			fmt.Printf("  Capital LIBERADO durante la simulación.\n")
		}
	}
	if !r2Qual {
		if !plan.YieldEnabled {
			fmt.Println("  Yield R2:                     deshabilitado (--no-yield)")
		} else if !balanced {
			fmt.Printf("  Yield R2:                     NO calificado (DirectsLeft=%d, DirectsRight=%d — se necesita ≥1 en cada pierna)\n",
				*directsLeft, *directsRight)
		}
	}

	roi := decimal.Zero
	if !pkgD.IsZero() {
		roi = totalBlockBonus.Add(totalYieldPaid).Add(totalPointsPaid).Div(pkgD).Mul(decimal.NewFromInt(100))
	}
	fmt.Printf("  ROI sobre paquete (sin lock): %s%%\n", roi.StringFixed(2))

	os.Exit(0)
}

type affState struct {
	LeftPV       decimal.Decimal
	RightPV      decimal.Decimal
	PackagePaid  decimal.Decimal
}

func newState(_ decimal.Decimal) *affState {
	return &affState{
		LeftPV:      decimal.Zero,
		RightPV:     decimal.Zero,
		PackagePaid: decimal.Zero,
	}
}

func decimalMin(a, b decimal.Decimal) decimal.Decimal {
	if a.LessThan(b) {
		return a
	}
	return b
}

func mustFloat(d decimal.Decimal) float64 {
	f, _ := d.Float64()
	return f
}

func printHeader(periods int, pkg decimal.Decimal, dl, dr int, vol decimal.Decimal,
	plan simulator.PlanConfig, balanced, r2Qual bool, r2Monthly decimal.Decimal) {
	fmt.Println(strings.Repeat("=", 80))
	fmt.Println("vp-derrame — walkthrough determinista del derrame binario para 1 afiliado")
	fmt.Println(strings.Repeat("=", 80))
	fmt.Printf("Paquete activo:        $%s\n", pkg.StringFixed(2))
	fmt.Printf("Directos:              %d L + %d R   (balanced=%v)\n", dl, dr, balanced)
	fmt.Printf("Volumen por directo:   $%s PV / periodo\n", vol.StringFixed(2))
	fmt.Printf("Block size / bono:     %d puntos / $%s\n", plan.BlockSize, plan.BonusPerBlock.StringFixed(2))
	fmt.Printf("T3 por periodo:        %s × $%s = $%s\n",
		plan.PeriodCapFactor.StringFixed(2), pkg.StringFixed(2),
		plan.PeriodCapFactor.Mul(pkg).StringFixed(2))
	fmt.Printf("T2 vida (paquete):     %s × $%s = $%s\n",
		plan.LifetimeCapFactor.StringFixed(2), pkg.StringFixed(2),
		plan.LifetimeCapFactor.Mul(pkg).StringFixed(2))
	if plan.YieldEnabled {
		fmt.Printf("R2 yield:              %.0f%%/año → $%s cada %d periodos (qualified=%v)\n",
			mustFloat(plan.YieldAnnualRate)*100, r2Monthly.StringFixed(2),
			plan.YieldCadencePeriods, r2Qual)
	} else {
		fmt.Println("R2 yield:              deshabilitado")
	}
	if plan.PointsBonusEnabled {
		fmt.Printf("R3 puntos:             %s pt/bloque × $%s/pt cada %d periodos\n",
			plan.PointsPerBlock.StringFixed(2),
			plan.PointsDollarsPerPoint.StringFixed(2),
			plan.PointsCadencePeriods)
	} else {
		fmt.Println("R3 puntos:             deshabilitado")
	}
	if plan.CapitalLockPeriods > 0 {
		fmt.Printf("Lock de capital:       %d periodos (12m si periodo=semana)\n", plan.CapitalLockPeriods)
	} else {
		fmt.Println("Lock de capital:       deshabilitado")
	}
	fmt.Printf("Horizonte:             %d periodos\n", periods)
	fmt.Println()
}
