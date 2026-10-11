// Structured logging for globe-server — one greppable, machine-parseable
// line per event, mirroring frontend/src/lib/log.ts (P1-2).
//
//	[glob] stream_failed {"ts":"2026-09-27T…Z","scope":"chat","event":"stream_failed",…}
//
// Rules (card t_94fa9c65), enforced by construction, not review:
//   - never log message/prompt content, API keys or any key material —
//     lengths, counts, HTTP statuses, error names and machine codes only;
//   - every value must be scalar (string/float64/bool/nil) so records stay
//     JSON-safe and small. Callers pass secrets NOWHERE NEAR this function.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// LogLevel is a log severity. All levels write to stderr (there is no
// browser console to mirror here); the level rides inside the JSON record.
type LogLevel string

const (
	LogDebug LogLevel = "debug"
	LogInfo  LogLevel = "info"
	LogWarn  LogLevel = "warn"
	LogError LogLevel = "error"
)

// LogEvent writes one structured log line to stderr.
func LogEvent(scope, event string, fields map[string]any, level LogLevel) {
	logEvent(scope, event, fields, string(level))
}

func logEvent(scope, event string, fields map[string]any, level string) {
	record := map[string]any{
		"ts":    time.Now().UTC().Format(time.RFC3339Nano),
		"scope": scope,
		"event": event,
		"level": level,
	}
	for k, v := range fields {
		switch v.(type) {
		case string, float64, float32, int, int64, bool, nil:
			record[k] = v
		default:
			record[k] = fmt.Sprintf("%v", v)
		}
	}
	data, err := json.Marshal(record)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[glob] %s {\"scope\":%q,\"event\":%q,\"logEncodeError\":true}\n", event, scope, event)
		return
	}
	fmt.Fprintf(os.Stderr, "[glob] %s %s\n", event, data)
}

// ErrorFields is the safe error projection for catch sites: name + message,
// never a payload that could carry secrets.
func ErrorFields(err error) map[string]any {
	if err == nil {
		return map[string]any{}
	}
	return map[string]any{"errName": "Error", "err": err.Error()}
}
