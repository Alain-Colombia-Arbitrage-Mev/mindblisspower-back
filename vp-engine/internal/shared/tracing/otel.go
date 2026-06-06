// Package tracing setup OpenTelemetry con OTLP HTTP exporter a Grafana Cloud
// (o cualquier OTLP endpoint via OTEL_EXPORTER_OTLP_ENDPOINT).
package tracing

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	sdkresource "go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// Init creates a global tracer provider. Returns shutdown function the caller
// must defer to ensure spans are flushed before exit.
func Init(ctx context.Context, serviceName, otlpEndpoint, otlpHeaders string) (func(context.Context) error, error) {
	if otlpEndpoint == "" {
		// Tracing disabled — return noop shutdown.
		return func(context.Context) error { return nil }, nil
	}

	exporter, err := otlptrace.New(ctx, otlptracehttp.NewClient(
		otlptracehttp.WithEndpointURL(otlpEndpoint),
		otlptracehttp.WithHeaders(parseHeaders(otlpHeaders)),
	))
	if err != nil {
		return nil, fmt.Errorf("create otlp exporter: %w", err)
	}

	res, err := sdkresource.New(ctx,
		sdkresource.WithAttributes(
			semconv.ServiceName(serviceName),
		),
		sdkresource.WithProcess(),
		sdkresource.WithHost(),
	)
	if err != nil {
		return nil, fmt.Errorf("create resource: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(0.1))),
	)
	otel.SetTracerProvider(tp)

	return tp.Shutdown, nil
}

func parseHeaders(s string) map[string]string {
	// Format: "key1=value1,key2=value2"
	headers := map[string]string{}
	if s == "" {
		return headers
	}
	for _, pair := range splitAndTrim(s, ',') {
		kv := splitAndTrim(pair, '=')
		if len(kv) == 2 {
			headers[kv[0]] = kv[1]
		}
	}
	return headers
}

func splitAndTrim(s string, sep byte) []string {
	out := []string{}
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			out = append(out, trimSpace(s[start:i]))
			start = i + 1
		}
	}
	out = append(out, trimSpace(s[start:]))
	return out
}

func trimSpace(s string) string {
	i := 0
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	j := len(s)
	for j > i && (s[j-1] == ' ' || s[j-1] == '\t') {
		j--
	}
	return s[i:j]
}
