// Package metrics centraliza el registro Prometheus.
// Métricas específicas a cada módulo se declaran en su propio paquete.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// Registry is the shared Prometheus registry. Modules register their metrics here.
var Registry = prometheus.NewRegistry()

func init() {
	Registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
}

// MustRegister registers a collector or panics. Use only at init time.
// Re-registro idéntico es tolerado (AlreadyRegisteredError): los tests crean
// más de un Engine por proceso y las métricas son package-level de facto.
func MustRegister(cs ...prometheus.Collector) {
	for _, c := range cs {
		if err := Registry.Register(c); err != nil {
			if _, ok := err.(prometheus.AlreadyRegisteredError); ok {
				continue
			}
			panic(err)
		}
	}
}
