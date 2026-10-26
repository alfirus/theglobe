// Tests for the P2-4 loopback rate limiter.
package config

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCheckRateLimit_AdmitsThenRejects(t *testing.T) {
	ResetRateLimits()
	now := time.Now()
	for i := 0; i < 120; i++ {
		if err := CheckRateLimit(BucketFilesList, now); err != nil {
			t.Fatalf("hit %d rejected early: %v", i, err)
		}
	}
	if err := CheckRateLimit(BucketFilesList, now); err == nil {
		t.Fatal("hit 121 admitted, want 429")
	} else if err.Status != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", err.Status)
	}
}

func TestCheckRateLimit_WindowSlides(t *testing.T) {
	ResetRateLimits()
	now := time.Now()
	for i := 0; i < 120; i++ {
		if err := CheckRateLimit(BucketFiles, now); err != nil {
			t.Fatalf("hit %d rejected early: %v", i, err)
		}
	}
	later := now.Add(61 * time.Second)
	if err := CheckRateLimit(BucketFiles, later); err != nil {
		t.Fatalf("post-window hit rejected: %v", err)
	}
}

func TestCheckRateLimit_BucketsAreIndependent(t *testing.T) {
	ResetRateLimits()
	now := time.Now()
	for i := 0; i < 120; i++ {
		if err := CheckRateLimit(BucketFilesList, now); err != nil {
			t.Fatalf("list hit %d rejected early: %v", i, err)
		}
	}
	if err := CheckRateLimit(BucketFiles, now); err != nil {
		t.Fatalf("files bucket throttled by list bucket: %v", err)
	}
}

func TestWriteRateLimited_Shape(t *testing.T) {
	ResetRateLimits()
	now := time.Now()
	for i := 0; i < 120; i++ {
		CheckRateLimit(BucketFiles, now)
	}
	w := httptest.NewRecorder()
	WriteRateLimited(w, BucketFiles)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Error("missing Retry-After header")
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}
