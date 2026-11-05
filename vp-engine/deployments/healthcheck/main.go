// Package main is a shell-free, loopback-only HTTP readiness probe for scratch images.
package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

func target(service, override string) (string, error) {
	port := "9090"
	switch service {
	case "vp-payments":
		port = "9095"
	case "vp-withdrawals":
		port = "9097"
	case "vp-support":
		port = "9096"
	}
	address := "http://127.0.0.1:" + port + "/health"
	if override != "" {
		address = override
	}
	parsed, err := url.Parse(address)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("invalid healthcheck URL")
	}
	ip := net.ParseIP(parsed.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return "", fmt.Errorf("healthcheck must use a loopback IP")
	}
	return address, nil
}

func probe(address string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	client := &http.Client{
		Transport:     &http.Transport{Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("healthcheck returned HTTP %d", response.StatusCode)
	}
	return nil
}

func main() {
	service := os.Getenv("SERVICE_NAME")
	if service == "vp-kb-indexer" {
		// The worker has no HTTP listener; this checks process liveness only.
		// Queue/index freshness must be monitored independently.
		executable, err := os.Readlink("/proc/1/exe")
		if err != nil || executable != "/app-bin" {
			os.Exit(1)
		}
		return
	}
	address, err := target(service, os.Getenv("HEALTHCHECK_URL"))
	if err == nil {
		err = probe(address)
	}
	if err != nil {
		// Do not print credentials, response bodies, or runtime environment values.
		fmt.Fprintln(os.Stderr, "service readiness check failed")
		os.Exit(1)
	}
}
