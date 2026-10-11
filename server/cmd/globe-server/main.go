// Command globe-server is The Globe's Go backend (ADR-0002 Phase 1).
//
// Dev:
//
//	GLOBE_API_PORT=8787 go run ./cmd/globe-server
//
// The service binds GLOBE_API_HOST (default 127.0.0.1 — loopback only, so
// /api/* is never reachable from the LAN; the shared-secret/Origin guard in
// internal/config is the second line of defence) and shuts down cleanly on
// SIGINT/SIGTERM with in-flight requests drained.
package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/alfirus/theglobe/server/internal/config"
	"github.com/alfirus/theglobe/server/internal/server"
)

const (
	defaultHost       = "127.0.0.1"
	defaultPort       = 8787
	shutdownTimeout   = 10 * time.Second
	missingSecretWarn = "[api] API_SERVER_KEY is not set — /api/* relies on the loopback bind plus Host/Origin checks only. Set API_SERVER_KEY (BLUEPRINT.md:278) to enforce the shared secret."
)

func resolveAddr() string {
	host := strings.TrimSpace(os.Getenv("GLOBE_API_HOST"))
	if host == "" {
		host = defaultHost
	}
	port := defaultPort
	if raw := strings.TrimSpace(os.Getenv("GLOBE_API_PORT")); raw != "" {
		if p, err := strconv.Atoi(raw); err == nil && p >= 1 && p <= 65535 {
			port = p
		} else {
			config.LogEvent("main", "invalid_port_fallback", map[string]any{"port": raw}, config.LogWarn)
		}
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}

func main() {
	if err := run(); err != nil {
		config.LogEvent("main", "startup_failed", config.ErrorFields(err), config.LogError)
		os.Exit(1)
	}
}

func run() error {
	addr := resolveAddr()
	srv := &http.Server{
		Addr:              addr,
		Handler:           server.NewHandler(nil),
		ReadHeaderTimeout: 5 * time.Second,
	}

	if strings.TrimSpace(os.Getenv("API_SERVER_KEY")) == "" {
		fmt.Fprintln(os.Stderr, missingSecretWarn)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		config.LogEvent("main", "listening", map[string]any{"addr": addr}, config.LogInfo)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		config.LogEvent("main", "shutdown_started", map[string]any{}, config.LogInfo)
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return err
		}
		config.LogEvent("main", "shutdown_complete", map[string]any{}, config.LogInfo)
		return nil
	case err := <-errCh:
		return err
	}
}
