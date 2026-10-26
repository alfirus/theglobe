// Basic loopback rate limiter for the process/file-serving /api/* handlers
// (P2-4, Go half of the TS $lib/rateLimit.ts control).
//
// One global sliding-window bucket per route: the server only binds
// loopback, so per-client keying buys nothing. Limits are generous;
// excess returns a 429 *APIError with a Retry-After hint, before any file
// is opened or engine spawned.
package config

import (
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// RateLimitBucket is a throttle bucket — one per request class.
type RateLimitBucket string

const (
	// BucketFilesList throttles GET /api/files.
	BucketFilesList RateLimitBucket = "files-list"
	// BucketFiles throttles GET /api/files/:name (up to 10 MiB per hit).
	BucketFiles RateLimitBucket = "files"
)

var rateLimits = map[RateLimitBucket]int{
	BucketFilesList: 120,
	BucketFiles:     120,
}

const rateWindow = time.Minute

var (
	rateMu   sync.Mutex
	rateHits = map[RateLimitBucket][]time.Time{}
)

// CheckRateLimit admits one request into bucket, or returns a 429 *APIError.
// now is a parameter so tests can drive the window deterministically.
func CheckRateLimit(bucket RateLimitBucket, now time.Time) *APIError {
	rateMu.Lock()
	defer rateMu.Unlock()
	cutoff := now.Add(-rateWindow)
	seen := rateHits[bucket][:0]
	for _, t := range rateHits[bucket] {
		if t.After(cutoff) {
			seen = append(seen, t)
		}
	}
	if len(seen) >= rateLimits[bucket] {
		return &APIError{Status: http.StatusTooManyRequests, Message: "Rate limit exceeded"}
	}
	rateHits[bucket] = append(seen, now)
	return nil
}

// RetryAfter reports the whole-second backoff for a rejected bucket.
func RetryAfter(bucket RateLimitBucket, now time.Time) int {
	rateMu.Lock()
	defer rateMu.Unlock()
	seen := rateHits[bucket]
	if len(seen) == 0 {
		return 1
	}
	retryAfter := int((rateWindow - now.Sub(seen[0])).Seconds()) + 1
	if retryAfter < 1 {
		return 1
	}
	return retryAfter
}

// ResetRateLimits drops all buckets. Test hook only.
func ResetRateLimits() {
	rateMu.Lock()
	defer rateMu.Unlock()
	rateHits = map[RateLimitBucket][]time.Time{}
}

// WriteRateLimited renders a 429 with a Retry-After header (JSON body, same
// shape as APIError.Write).
func WriteRateLimited(w http.ResponseWriter, bucket RateLimitBucket) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", strconv.Itoa(RetryAfter(bucket, time.Now())))
	w.WriteHeader(http.StatusTooManyRequests)
	_, _ = fmt.Fprintln(w, `{"error":"Rate limit exceeded"}`)
}
