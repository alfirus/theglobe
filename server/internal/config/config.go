// Package config is the Go port of frontend/src/lib/config.ts — the single
// validated config + /api/* guard module for The Globe (ADR-0002 Phase 1).
//
// This ports BEHAVIOR, not lines: same JSON schema, same env contracts, same
// URL allow-list, same assertApiRequest rules, same error strings. Anything
// security-relevant here (timing-safe secret compare, Origin/fetch-metadata
// checks, loopback-Host rule, key-free public view) must stay in lockstep
// with config.ts until Phase 3 retires the TS routes.
//
// Secret-handling standard (ratified v2, Alya t_cc46938d):
//   - resolved keys are never logged, never echoed, never error-surfaced;
//   - DEFAULTS carries no apiKey field (C4);
//   - GET /api/settings is built by whitelisting fields, never a passthrough.
package config

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
)

// ── providers ─────────────────────────────────────────────────────────────

// Providers lists every documented uplink provider, in canonical order.
var Providers = []string{
	"hermes",
	"lmstudio",
	"opencode",
	"openrouter",
	"deepseek",
	"openclaw",
	"mimo",
}

// Provider is a valid uplink provider id.
type Provider string

const (
	ProviderHermes     Provider = "hermes"
	ProviderLMStudio   Provider = "lmstudio"
	ProviderOpencode   Provider = "opencode"
	ProviderOpenrouter Provider = "openrouter"
	ProviderDeepseek   Provider = "deepseek"
	ProviderOpenclaw   Provider = "openclaw"
	ProviderMimo       Provider = "mimo"
)

// IsProvider reports whether id is a known provider.
func IsProvider(id string) bool {
	for _, p := range Providers {
		if id == p {
			return true
		}
	}
	return false
}

// ProviderDefault is a non-secret provider default. Deliberately has no
// ApiKey field (C4 removal).
type ProviderDefault struct {
	BaseURL string
	Model   string
}

// Defaults maps each provider to its non-secret defaults.
var Defaults = map[Provider]ProviderDefault{
	ProviderHermes:     {BaseURL: "", Model: "hermes-agent"},
	ProviderLMStudio:   {BaseURL: "http://127.0.0.1:1234/v1", Model: ""},
	ProviderOpencode:   {BaseURL: "http://localhost:8765/v1", Model: ""},
	ProviderOpenrouter: {BaseURL: "https://openrouter.ai/api/v1", Model: ""},
	ProviderDeepseek:   {BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-chat"},
	ProviderOpenclaw:   {BaseURL: "", Model: ""},
	// Xiaomi MiMo (OpenAI-compatible). Pay-as-you-go endpoint; Token Plan
	// users override the base URL with their regional endpoint
	// (https://token-plan-{cn,sgp,ams}.xiaomimimo.com/v1).
	ProviderMimo: {BaseURL: "https://api.xiaomimimo.com/v1", Model: "mimo-v2-flash"},
}

// KeySource records where a resolved key came from; `KeySource != "none"`
// is exactly HasKey.
type KeySource string

const (
	KeySourceEnv  KeySource = "env"
	KeySourceFile KeySource = "file"
	KeySourceNone KeySource = "none"
)

// ResolvedConfig is the full resolved config for one provider or agent.
// ApiKey must never be logged or echoed back.
type ResolvedConfig struct {
	BaseURL   string
	Model     string
	APIKey    string
	Source    KeySource
	TimeoutMs int64
}

// ApiKeyEnvName returns the per-provider env var: HERMES_API_KEY_<PROVIDER>.
func ApiKeyEnvName(provider Provider) string {
	return "HERMES_API_KEY_" + strings.ToUpper(string(provider))
}

// GenericAPIKeyEnv is the last-resort env var covering every provider.
const GenericAPIKeyEnv = "HERMES_API_KEY"

// ProviderFileConfig is one provider/agent override block in the settings file.
// An explicitly stored empty string means "clear this field" (rotation path)
// and must survive the round trip, so no omitempty on the string fields.
type ProviderFileConfig struct {
	BaseURL   string `json:"baseUrl"`
	Model     string `json:"model"`
	APIKey    string `json:"apiKey"`
	TimeoutMs int64  `json:"timeoutMs,omitempty"` // 0 = absent (valid range is >= 5000)
}

// ── TTS engines ───────────────────────────────────────────────────────────

// TTSProviders lists every TTS engine, in canonical order.
var TTSProviders = []string{"system", "piper", "edge", "openai", "elevenlabs"}

// TTSProvider is a valid TTS engine id.
type TTSProvider string

const (
	TTSSystem     TTSProvider = "system"
	TTSPiper      TTSProvider = "piper"
	TTSEdge       TTSProvider = "edge"
	TTSOpenAI     TTSProvider = "openai"
	TTSElevenlabs TTSProvider = "elevenlabs"
)

// IsTTSProvider reports whether id is a known TTS engine.
func IsTTSProvider(id string) bool {
	for _, p := range TTSProviders {
		if id == p {
			return true
		}
	}
	return false
}

// TTSFileConfig is the `tts` section of the settings file.
type TTSFileConfig struct {
	Provider  string `json:"provider,omitempty"`
	Voice     string `json:"voice"`
	Model     string `json:"model"`
	BaseURL   string `json:"baseUrl"`
	APIKey    string `json:"apiKey"`
	ModelPath string `json:"modelPath"`
}

// ── agents / uplink modes ─────────────────────────────────────────────────

// Agents lists every agent uplink entry.
var Agents = []string{"hermes-agent", "openclaw-agent"}

// Agent is a valid agent gateway id.
type Agent string

const (
	AgentHermes   Agent = "hermes-agent"
	AgentOpenclaw Agent = "openclaw-agent"
)

// IsAgent reports whether id is a known agent.
func IsAgent(id string) bool {
	return id == string(AgentHermes) || id == string(AgentOpenclaw)
}

// UplinkModes lists the valid uplink sections.
var UplinkModes = []string{"provider", "agent"}

// UplinkMode selects which section carries chat.
type UplinkMode string

const (
	UplinkProvider UplinkMode = "provider"
	UplinkAgent    UplinkMode = "agent"
)

// IsUplinkMode reports whether id is a known uplink mode.
func IsUplinkMode(id string) bool {
	return id == string(UplinkProvider) || id == string(UplinkAgent)
}

// DefaultUplinkMode is the uplink section used when the file names none.
const DefaultUplinkMode = UplinkProvider

// DefaultAgent is the agent used when uplinkMode is agent but no agent is named.
const DefaultAgent = AgentHermes

// AgentDefaults maps each agent to its non-secret defaults (no ApiKey — C4).
var AgentDefaults = map[Agent]ProviderDefault{
	// Remote Hermes agent gateway (OpenAI-compatible chat surface).
	AgentHermes: {BaseURL: "", Model: "hermes-agent"},
	// Remote OpenClaw gateway (OpenAI-compatible chat surface).
	AgentOpenclaw: {BaseURL: "", Model: ""},
}

// AgentKeyEnvName returns the per-agent env var:
// HERMES_API_KEY_HERMES_AGENT / HERMES_API_KEY_OPENCLAW_AGENT.
func AgentKeyEnvName(agent Agent) string {
	return "HERMES_API_KEY_" + strings.ToUpper(strings.ReplaceAll(string(agent), "-", "_"))
}

// ── settings file ─────────────────────────────────────────────────────────

// SettingsFile mirrors the .globe-settings.json schema.
type SettingsFile struct {
	Provider     string                        `json:"provider,omitempty"`
	SystemPrompt string                        `json:"systemPrompt,omitempty"`
	Configs      map[string]ProviderFileConfig `json:"configs,omitempty"`
	TTS          *TTSFileConfig                `json:"tts,omitempty"`
	UplinkMode   string                        `json:"uplinkMode,omitempty"`
	Agent        string                        `json:"agent,omitempty"`
	Agents       map[string]ProviderFileConfig `json:"agents,omitempty"`
}

// SettingsFilename is the settings file name, read from the process cwd.
const SettingsFilename = ".globe-settings.json"

// MaxSettingsBytes caps the settings file at 64 KiB.
const MaxSettingsBytes = 64 * 1024

// SettingsPath returns the absolute settings file path (cwd + filename),
// matching config.ts `path.join(process.cwd(), '.globe-settings.json')`.
func SettingsPath() string {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	return filepath.Join(cwd, SettingsFilename)
}

// ReadSettings reads .globe-settings.json. Any read/parse failure yields an
// empty SettingsFile (never an error). A missing file is the normal
// fresh-setup case and stays silent; anything else is logged once per read.
func ReadSettings() SettingsFile {
	return readSettingsFrom(SettingsPath())
}

func readSettingsFrom(path string) SettingsFile {
	stat, err := os.Stat(path)
	if err != nil {
		if !os.IsNotExist(err) {
			logEvent("config", "settings_read_failed", map[string]any{
				"errName": "OSError",
				"err":     err.Error(),
			}, "warn")
		}
		return SettingsFile{}
	}
	if !stat.Mode().IsRegular() || stat.Size() > MaxSettingsBytes {
		logEvent("config", "settings_read_failed", map[string]any{
			"errName": "OSError",
			"err":     "settings file is not a regular file or exceeds 64 KiB",
		}, "warn")
		return SettingsFile{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		logEvent("config", "settings_read_failed", map[string]any{
			"errName": "OSError",
			"err":     err.Error(),
		}, "warn")
		return SettingsFile{}
	}
	var probe any
	if err := json.Unmarshal(data, &probe); err != nil {
		// Truncated JSON silently reset every provider in TS once — it is
		// logged and still degrades to {}.
		logEvent("config", "settings_read_failed", map[string]any{
			"errName": "SyntaxError",
			"err":     err.Error(),
		}, "warn")
		return SettingsFile{}
	}
	if _, ok := probe.(map[string]any); !ok {
		return SettingsFile{}
	}
	var out SettingsFile
	if err := json.Unmarshal(data, &out); err != nil {
		return SettingsFile{}
	}
	return out
}

// WriteSettings persists the settings file (caller must have validated /
// sanitised the value). Mode 0600 applies on creation, mirroring
// fs.writeFileSync(..., { mode: 0o600 }).
func WriteSettings(s SettingsFile) error {
	return writeSettingsTo(SettingsPath(), s)
}

func writeSettingsTo(path string, s SettingsFile) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

// ── provider resolution ───────────────────────────────────────────────────

// ResolveConfig resolves the full config for a provider.
//
// apiKey precedence (ratified): settings file → per-provider env → generic
// env → "". The file is the user-visible source of truth — a key typed into
// the UI during a live test must win over a stale environment value.
// baseUrl/model: settings file overrides Defaults.
func ResolveConfig(provider Provider, settings SettingsFile) ResolvedConfig {
	var override ProviderFileConfig
	if settings.Configs != nil {
		override = settings.Configs[string(provider)]
	}
	fileKey := strings.TrimSpace(override.APIKey)
	envKey := strings.TrimSpace(os.Getenv(ApiKeyEnvName(provider)))
	genericKey := strings.TrimSpace(os.Getenv(GenericAPIKeyEnv))

	apiKey := firstNonEmpty(fileKey, envKey, genericKey)

	var source KeySource
	switch {
	case apiKey == "":
		source = KeySourceNone
	case fileKey != "":
		source = KeySourceFile
	default:
		source = KeySourceEnv
	}

	base := strings.TrimSpace(override.BaseURL)
	if base == "" {
		base = Defaults[provider].BaseURL
	}
	model := strings.TrimSpace(override.Model)
	if model == "" {
		model = Defaults[provider].Model
	}

	return ResolvedConfig{
		BaseURL:   base,
		Model:     model,
		APIKey:    apiKey,
		Source:    source,
		TimeoutMs: ResolveProviderTimeoutMs(numberOrNil(override.TimeoutMs)),
	}
}

// ── per-provider uplink timeout ───────────────────────────────────────────

// DefaultProviderTimeoutMs is the default wall-clock budget for one provider
// uplink (chat stream / health probe).
const DefaultProviderTimeoutMs = 120_000

const minProviderTimeoutMs = 5_000
const maxProviderTimeoutMs = 600_000

// ResolveProviderTimeoutMs clamps a settings-file timeoutMs (or falls back
// to the default). Non-numbers, NaN/Inf and non-positive values yield the
// default; anything else is rounded and clamped to 5 s – 10 min.
func ResolveProviderTimeoutMs(raw any) int64 {
	f, ok := toFiniteFloat(raw)
	if !ok || f <= 0 {
		return DefaultProviderTimeoutMs
	}
	return clampInt64(int64(math.Round(f)), minProviderTimeoutMs, maxProviderTimeoutMs)
}

// HasKey reports whether a key is available for the provider — never exposes
// any part of it.
func HasKey(provider Provider, settings SettingsFile) bool {
	return ResolveConfig(provider, settings).Source != KeySourceNone
}

// ── agent uplink resolution ───────────────────────────────────────────────

// ResolveAgent resolves the full config for an agent gateway. Same contract
// as providers: settings file (agents.<id>) → per-agent env
// (HERMES_API_KEY_HERMES_AGENT / _OPENCLAW_AGENT) → generic env → "".
func ResolveAgent(agent Agent, settings SettingsFile) ResolvedConfig {
	var override ProviderFileConfig
	if settings.Agents != nil {
		override = settings.Agents[string(agent)]
	}
	fileKey := strings.TrimSpace(override.APIKey)
	envKey := strings.TrimSpace(os.Getenv(AgentKeyEnvName(agent)))
	genericKey := strings.TrimSpace(os.Getenv(GenericAPIKeyEnv))

	apiKey := firstNonEmpty(fileKey, envKey, genericKey)

	var source KeySource
	switch {
	case apiKey == "":
		source = KeySourceNone
	case fileKey != "":
		source = KeySourceFile
	default:
		source = KeySourceEnv
	}

	base := strings.TrimSpace(override.BaseURL)
	if base == "" {
		base = AgentDefaults[agent].BaseURL
	}
	model := strings.TrimSpace(override.Model)
	if model == "" {
		model = AgentDefaults[agent].Model
	}

	return ResolvedConfig{
		BaseURL:   base,
		Model:     model,
		APIKey:    apiKey,
		Source:    source,
		TimeoutMs: ResolveProviderTimeoutMs(numberOrNil(override.TimeoutMs)),
	}
}

// Uplink is the active uplink — provider or agent — resolved in one call.
type Uplink struct {
	Mode   UplinkMode
	ID     string
	Config ResolvedConfig
}

// ResolveUplink resolves the active uplink from settings.
func ResolveUplink(settings SettingsFile) Uplink {
	mode := UplinkMode(settings.UplinkMode)
	if !IsUplinkMode(settings.UplinkMode) {
		mode = DefaultUplinkMode
	}
	if mode == UplinkAgent {
		agent := Agent(settings.Agent)
		if !IsAgent(settings.Agent) {
			agent = DefaultAgent
		}
		return Uplink{Mode: mode, ID: string(agent), Config: ResolveAgent(agent, settings)}
	}
	provider := Provider(settings.Provider)
	if !IsProvider(settings.Provider) {
		provider = ProviderHermes
	}
	return Uplink{Mode: mode, ID: string(provider), Config: ResolveConfig(provider, settings)}
}

// ── upstream origin allow-list ────────────────────────────────────────────

var implicitAllowedHosts = []string{
	"openrouter.ai",
	"api.deepseek.com",
	"*.xiaomimimo.com",
	// Cloud TTS upstreams (POST /api/tts `openai` / `elevenlabs` engines).
	"api.openai.com",
	"api.elevenlabs.io",
}

var ipv4Pattern = regexp.MustCompile(`^\d{1,3}(\.\d{1,3}){3}$`)

func allowedExtraHosts() []string {
	var out []string
	for _, entry := range strings.Split(os.Getenv("GLOB_ALLOWED_ORIGINS"), ",") {
		entry = strings.TrimSpace(strings.ToLower(entry))
		if entry != "" {
			out = append(out, entry)
		}
	}
	return out
}

// IsAllowedURL is the allow-list for upstream provider origins. Allows
// http(s) only, plus loopback / RFC1918 private ranges / the 100.64.0.0/10
// CGNAT range (how Tailscale addresses a remote machine — a remote LM Studio
// over a tailnet arrives as 100.x.y.z) and the explicit host allow-list
// (defaults + GLOB_ALLOWED_ORIGINS). 100.64/10 is only routable inside the
// local tailnet/VPN, never the open internet. Everything else is rejected —
// including link-local/cloud-metadata addresses (169.254.x.x), which never
// match a private range here.
func IsAllowedURL(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	host = strings.TrimPrefix(host, "[")
	host = strings.TrimSuffix(host, "]")

	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}

	if ipv4Pattern.MatchString(host) {
		parts := strings.Split(host, ".")
		a, _ := strconv.Atoi(parts[0])
		b, _ := strconv.Atoi(parts[1])
		if a == 10 {
			return true
		}
		if a == 192 && b == 168 {
			return true
		}
		if a == 172 && b >= 16 && b <= 31 {
			return true
		}
		// Tailscale / CGNAT shared range 100.64.0.0/10.
		if a == 100 && b >= 64 && b <= 127 {
			return true
		}
		return false
	}

	allowed := append(append([]string{}, implicitAllowedHosts...), allowedExtraHosts()...)
	for _, entry := range allowed {
		if strings.HasPrefix(entry, "*.") {
			if strings.HasSuffix(host, entry[1:]) {
				return true
			}
		} else if host == entry {
			return true
		}
	}
	return false
}

// ── settings payload validation (POST /api/settings) ─────────────────────

const (
	maxBaseURL      = 2048
	maxModel        = 512
	maxAPIKey       = 512
	maxSystemPrompt = 8000
	maxTTSModelPath = 1024
	maxTTSVoice     = 256
)

// ValidationError is raised for an invalid settings value. It never carries
// key material — messages name the field, never the value (except URLs,
// which are validated allow-list membership, same as TS).
type ValidationError struct {
	Msg string
}

func (e *ValidationError) Error() string { return e.Msg }

func assertString(value any, label string, max int) (string, error) {
	s, ok := value.(string)
	if !ok {
		return "", &ValidationError{Msg: label + " must be a string"}
	}
	if len(s) > max {
		return "", &ValidationError{Msg: fmt.Sprintf("%s exceeds %d characters", label, max)}
	}
	return s, nil
}

func clampTimeoutMs(value any, label string) (int64, error) {
	f, ok := toFiniteFloat(value)
	if !ok {
		return 0, &ValidationError{Msg: label + " must be a number"}
	}
	return clampInt64(int64(math.Round(f)), minProviderTimeoutMs, maxProviderTimeoutMs), nil
}

// SanitizeSettingsBody validates + sanitises a POST /api/settings body.
//
// Unknown *fields* are dropped (whitelist projection) — never a blanket 400,
// so a client that posts its whole settings blob still saves. Known fields
// with invalid *values* (wrong type, over length cap, non-allow-listed URL)
// are rejected with an error: silently accepting a hostile upstream URL is
// the §4.1-2 pivot primitive.
func SanitizeSettingsBody(body map[string]any) (SettingsFile, error) {
	var out SettingsFile

	if v, present := nonNull(body, "provider"); present {
		s, ok := v.(string)
		if !ok || !IsProvider(s) {
			return SettingsFile{}, &ValidationError{Msg: fmt.Sprintf("Unknown provider: %v", v)}
		}
		if s != "" {
			out.Provider = s
		}
	}

	if v, present := nonNull(body, "systemPrompt"); present {
		s, err := assertString(v, "systemPrompt", maxSystemPrompt)
		if err != nil {
			return SettingsFile{}, err
		}
		if s != "" {
			out.SystemPrompt = s
		}
	}

	if v, present := nonNull(body, "uplinkMode"); present {
		s, ok := v.(string)
		if !ok || !IsUplinkMode(s) {
			return SettingsFile{}, &ValidationError{Msg: fmt.Sprintf("Unknown uplink mode: %v", v)}
		}
		if s != "" {
			out.UplinkMode = s
		}
	}

	if v, present := nonNull(body, "agent"); present {
		s, ok := v.(string)
		if !ok || !IsAgent(s) {
			return SettingsFile{}, &ValidationError{Msg: fmt.Sprintf("Unknown agent: %v", v)}
		}
		if s != "" {
			out.Agent = s
		}
	}

	if v, present := body["agents"]; present && v != nil {
		obj, ok := v.(map[string]any)
		if !ok {
			return SettingsFile{}, &ValidationError{Msg: "agents must be an object"}
		}
		agents := map[string]ProviderFileConfig{}
		for id, value := range obj {
			if !IsAgent(id) {
				return SettingsFile{}, &ValidationError{Msg: "Unknown agent: " + id}
			}
			entry, ok := value.(map[string]any)
			if !ok || entry == nil {
				return SettingsFile{}, &ValidationError{Msg: fmt.Sprintf("agents.%s must be an object", id)}
			}
			clean, hasAny, err := sanitizeProviderBlock(entry, "agents."+id)
			if err != nil {
				return SettingsFile{}, err
			}
			if hasAny {
				agents[id] = clean
			}
		}
		if len(agents) > 0 {
			out.Agents = agents
		}
	}

	if v, present := body["configs"]; present && v != nil {
		obj, ok := v.(map[string]any)
		if !ok {
			return SettingsFile{}, &ValidationError{Msg: "configs must be an object"}
		}
		configs := map[string]ProviderFileConfig{}
		for id, value := range obj {
			if !IsProvider(id) {
				return SettingsFile{}, &ValidationError{Msg: "Unknown provider: " + id}
			}
			entry, ok := value.(map[string]any)
			if !ok || entry == nil {
				return SettingsFile{}, &ValidationError{Msg: fmt.Sprintf("configs.%s must be an object", id)}
			}
			clean, hasAny, err := sanitizeProviderBlock(entry, "configs."+id)
			if err != nil {
				return SettingsFile{}, err
			}
			if hasAny {
				configs[id] = clean
			}
		}
		if len(configs) > 0 {
			out.Configs = configs
		}
	}

	if v, present := body["tts"]; present && v != nil {
		obj, ok := v.(map[string]any)
		if !ok {
			return SettingsFile{}, &ValidationError{Msg: "tts must be an object"}
		}
		clean := TTSFileConfig{}
		hasAny := false
		if pv, ppresent := nonNull(obj, "provider"); ppresent {
			s, ok := pv.(string)
			if !ok || !IsTTSProvider(s) {
				return SettingsFile{}, &ValidationError{Msg: fmt.Sprintf("Unknown TTS provider: %v", pv)}
			}
			if s != "" {
				clean.Provider = s
				hasAny = true
			}
		}
		// Empty strings are explicit clears, same contract as LLM fields.
		for _, field := range []struct {
			key string
			max int
			set func(string)
		}{
			{"voice", maxTTSVoice, func(s string) { clean.Voice = s }},
			{"model", maxModel, func(s string) { clean.Model = s }},
			{"baseUrl", maxBaseURL, func(s string) { clean.BaseURL = s }},
			{"apiKey", maxAPIKey, func(s string) { clean.APIKey = s }},
			{"modelPath", maxTTSModelPath, func(s string) { clean.ModelPath = s }},
		} {
			if fv, fpresent := obj[field.key]; fpresent && fv != nil {
				s, err := assertString(fv, "tts."+field.key, field.max)
				if err != nil {
					return SettingsFile{}, err
				}
				if field.key == "baseUrl" && s != "" && !IsAllowedURL(s) {
					return SettingsFile{}, &ValidationError{Msg: "URL not allowed: " + s}
				}
				field.set(s)
				hasAny = true
			}
		}
		if hasAny {
			out.TTS = &clean
		}
	}

	return out, nil
}

// SanitizeSettingsJSON is SanitizeSettingsBody for a raw request body. A
// non-object body (including arrays and scalars) is rejected.
func SanitizeSettingsJSON(data []byte) (SettingsFile, error) {
	var probe any
	if err := json.Unmarshal(data, &probe); err != nil {
		return SettingsFile{}, &ValidationError{Msg: "Body must be a JSON object"}
	}
	obj, ok := probe.(map[string]any)
	if !ok {
		return SettingsFile{}, &ValidationError{Msg: "Body must be a JSON object"}
	}
	return SanitizeSettingsBody(obj)
}

// sanitizeProviderBlock sanitises one configs.<id> / agents.<id> block. An
// empty string is an explicit "clear this field" (rotation, switching
// providers) — it is stored so the file no longer shadows env/defaults.
// hasAny reports whether at least one field was explicitly sent (even as ""),
// so explicit clears are emitted instead of dropped.
func sanitizeProviderBlock(entry map[string]any, label string) (ProviderFileConfig, bool, error) {
	var clean ProviderFileConfig
	hasAny := false
	for _, key := range []struct {
		name string
		max  int
		set  func(string)
	}{
		{"baseUrl", maxBaseURL, func(s string) { clean.BaseURL = s }},
		{"model", maxModel, func(s string) { clean.Model = s }},
		{"apiKey", maxAPIKey, func(s string) { clean.APIKey = s }},
	} {
		if raw, present := entry[key.name]; present && raw != nil {
			s, err := assertString(raw, label+"."+key.name, key.max)
			if err != nil {
				return ProviderFileConfig{}, false, err
			}
			if key.name == "baseUrl" && s != "" && !IsAllowedURL(s) {
				return ProviderFileConfig{}, false, &ValidationError{Msg: "URL not allowed: " + s}
			}
			key.set(s)
			hasAny = true
		}
	}
	// Per-uplink timeout (ms): a positive number, clamped into range.
	// Invalid values are rejected — a silently-accepted hostile timeout is
	// the same pivot class as §4.1-2's hostile URL.
	if raw, present := entry["timeoutMs"]; present && raw != nil {
		ms, err := clampTimeoutMs(raw, label+".timeoutMs")
		if err != nil {
			return ProviderFileConfig{}, false, err
		}
		clean.TimeoutMs = ms
		hasAny = true
	}
	return clean, hasAny, nil
}

// nonNull reports a field that is present and neither undefined (absent) nor
// null (nil) nor the empty-string "not set" sentinel used for the scalar
// top-level selectors.
func nonNull(obj map[string]any, key string) (any, bool) {
	v, ok := obj[key]
	if !ok || v == nil {
		return nil, false
	}
	if s, isStr := v.(string); isStr && s == "" {
		return nil, false
	}
	return v, true
}

// MergeSettings merges a sanitised patch into stored settings
// (field-by-field, no clobbering), reproducing TS's mergeSettings spreads
// exactly — including the explicit-clear ("") rotation path.
//
// The typed patch has already lost per-field presence (an absent field and
// an explicit "" both read as ""), so presence is taken from raw — the
// original request map passed to SanitizeSettingsBody. Fields absent (or
// null) in raw keep their stored values; fields present in raw come from the
// sanitised patch, even when "". Top-level scalars need no raw lookup: the
// sanitiser only sets them when they were explicitly sent and non-empty,
// matching TS's `!== undefined` checks.
func MergeSettings(current, patch SettingsFile, raw map[string]any) SettingsFile {
	merged := current

	if patch.Provider != "" {
		merged.Provider = patch.Provider
	}
	if patch.SystemPrompt != "" {
		merged.SystemPrompt = patch.SystemPrompt
	}
	if patch.UplinkMode != "" {
		merged.UplinkMode = patch.UplinkMode
	}
	if patch.Agent != "" {
		merged.Agent = patch.Agent
	}

	if rawTTS, ok := raw["tts"].(map[string]any); ok && rawTTS != nil && patch.TTS != nil {
		if merged.TTS == nil {
			merged.TTS = &TTSFileConfig{}
		}
		base := *merged.TTS
		p := *patch.TTS
		if v, sent := rawTTS["provider"]; sent && v != nil {
			if s, isStr := v.(string); isStr && s != "" {
				base.Provider = p.Provider
			}
		}
		for _, key := range []struct {
			name string
			set  func(*TTSFileConfig, string)
		}{
			{"voice", func(t *TTSFileConfig, s string) { t.Voice = s }},
			{"model", func(t *TTSFileConfig, s string) { t.Model = s }},
			{"baseUrl", func(t *TTSFileConfig, s string) { t.BaseURL = s }},
			{"apiKey", func(t *TTSFileConfig, s string) { t.APIKey = s }},
			{"modelPath", func(t *TTSFileConfig, s string) { t.ModelPath = s }},
		} {
			if v, sent := rawTTS[key.name]; sent && v != nil {
				var val string
				switch key.name {
				case "voice":
					val = p.Voice
				case "model":
					val = p.Model
				case "baseUrl":
					val = p.BaseURL
				case "apiKey":
					val = p.APIKey
				case "modelPath":
					val = p.ModelPath
				}
				key.set(&base, val)
			}
		}
		merged.TTS = &base
	}

	mergeBlocks := func(rawKey string, patchBlocks, currentBlocks map[string]ProviderFileConfig) map[string]ProviderFileConfig {
		rawBlocks, ok := raw[rawKey].(map[string]any)
		if !ok || rawBlocks == nil {
			return currentBlocks
		}
		if currentBlocks == nil {
			currentBlocks = map[string]ProviderFileConfig{}
		}
		for id, rv := range rawBlocks {
			rblock, ok := rv.(map[string]any)
			if !ok || rblock == nil {
				continue // sanitise already rejected this; defensive
			}
			pblock := patchBlocks[id]
			base := currentBlocks[id]
			if v, sent := rblock["baseUrl"]; sent && v != nil {
				base.BaseURL = pblock.BaseURL
			}
			if v, sent := rblock["model"]; sent && v != nil {
				base.Model = pblock.Model
			}
			if v, sent := rblock["apiKey"]; sent && v != nil {
				base.APIKey = pblock.APIKey
			}
			if v, sent := rblock["timeoutMs"]; sent && v != nil {
				base.TimeoutMs = pblock.TimeoutMs
			}
			currentBlocks[id] = base
		}
		return currentBlocks
	}
	merged.Configs = mergeBlocks("configs", patch.Configs, merged.Configs)
	merged.Agents = mergeBlocks("agents", patch.Agents, merged.Agents)

	return merged
}

// ApplySettingsPatch sanitises a raw POST /api/settings body and merges it
// into the stored settings in one call — the Phase 2 handler's entry point.
func ApplySettingsPatch(current SettingsFile, raw map[string]any) (SettingsFile, error) {
	if raw == nil {
		return SettingsFile{}, &ValidationError{Msg: "Body must be a JSON object"}
	}
	patch, err := SanitizeSettingsBody(raw)
	if err != nil {
		return SettingsFile{}, err
	}
	return MergeSettings(current, patch, raw), nil
}

// ── public (key-free) settings view ───────────────────────────────────────

// PublicTTSSettings is the key-free TTS view for GET /api/settings —
// whitelisted, never a passthrough. There is no apiKey field anywhere in
// this tree — nothing to delete.
type PublicTTSSettings struct {
	Provider  string `json:"provider"`
	Voice     string `json:"voice,omitempty"`
	Model     string `json:"model,omitempty"`
	BaseURL   string `json:"baseUrl,omitempty"`
	ModelPath string `json:"modelPath,omitempty"`
	HasKey    bool   `json:"hasKey"`
	Source    string `json:"keySource"`
}

// PublicProviderView is one provider/agent entry in the public view.
type PublicProviderView struct {
	BaseURL   string `json:"baseUrl"`
	Model     string `json:"model"`
	HasKey    bool   `json:"hasKey"`
	TimeoutMs int64  `json:"timeoutMs"`
}

// PublicSettings is the GET /api/settings response, built by whitelisting
// fields. There is no apiKey key anywhere in the returned tree.
type PublicSettings struct {
	Provider       string                        `json:"provider,omitempty"`
	SystemPrompt   string                        `json:"systemPrompt,omitempty"`
	Configs        map[string]PublicProviderView `json:"configs"`
	KeySource      map[string]string             `json:"keySource"`
	TTS            *PublicTTSSettings            `json:"tts,omitempty"`
	UplinkMode     string                        `json:"uplinkMode,omitempty"`
	Agent          string                        `json:"agent,omitempty"`
	Agents         map[string]PublicProviderView `json:"agents"`
	AgentKeySource map[string]string             `json:"agentKeySource"`
}

// SettingsToPublic builds the GET /api/settings response by whitelisting fields.
func SettingsToPublic(settings SettingsFile) PublicSettings {
	out := PublicSettings{
		Configs:        map[string]PublicProviderView{},
		KeySource:      map[string]string{},
		Agents:         map[string]PublicProviderView{},
		AgentKeySource: map[string]string{},
	}

	if IsProvider(settings.Provider) {
		out.Provider = settings.Provider
	}
	if settings.SystemPrompt != "" {
		out.SystemPrompt = settings.SystemPrompt
	}
	if IsUplinkMode(settings.UplinkMode) {
		out.UplinkMode = settings.UplinkMode
	}
	if IsAgent(settings.Agent) {
		out.Agent = settings.Agent
	}
	out.TTS = SettingsToPublicTTS(settings)

	for _, p := range Providers {
		resolved := ResolveConfig(Provider(p), settings)
		out.Configs[p] = PublicProviderView{
			BaseURL:   resolved.BaseURL,
			Model:     resolved.Model,
			HasKey:    resolved.Source != KeySourceNone,
			TimeoutMs: resolved.TimeoutMs,
		}
		out.KeySource[p] = string(resolved.Source)
	}

	for _, a := range Agents {
		resolved := ResolveAgent(Agent(a), settings)
		out.Agents[a] = PublicProviderView{
			BaseURL:   resolved.BaseURL,
			Model:     resolved.Model,
			HasKey:    resolved.Source != KeySourceNone,
			TimeoutMs: resolved.TimeoutMs,
		}
		out.AgentKeySource[a] = string(resolved.Source)
	}

	return out
}

// ── TTS engine resolution (Hermes-style engine table) ─────────────────────

// ResolvedTTS is the resolved TTS engine. APIKey is server-side only.
type ResolvedTTS struct {
	Provider  TTSProvider
	Voice     string
	Model     string
	BaseURL   string
	APIKey    string
	Source    KeySource
	ModelPath string
}

// DefaultTTSProvider is the default TTS engine: the OS-native voice — zero
// setup on every platform.
const DefaultTTSProvider = TTSSystem

// DefaultTTSOpenAIBaseURL is the default `openai` engine endpoint.
const DefaultTTSOpenAIBaseURL = "https://api.openai.com/v1"

// DefaultTTSOpenAIModel is the default `openai` engine model.
const DefaultTTSOpenAIModel = "gpt-4o-mini-tts"

// DefaultTTSElevenlabsModel is the default `elevenlabs` engine model.
const DefaultTTSElevenlabsModel = "eleven_multilingual_v2"

// ResolveTTS resolves the TTS engine from settings (file wins, system
// default). Cloud-engine key precedence mirrors the LLM rule: settings file
// → engine-specific env (VOICE_TOOLS_OPENAI_KEY / OPENAI_API_KEY for openai,
// ELEVENLABS_API_KEY for elevenlabs) → "". piper needs no key.
func ResolveTTS(settings SettingsFile) ResolvedTTS {
	var tts TTSFileConfig
	if settings.TTS != nil {
		tts = *settings.TTS
	}
	provider := TTSProvider(tts.Provider)
	if !IsTTSProvider(tts.Provider) {
		provider = DefaultTTSProvider
	}

	apiKey := ""
	source := KeySourceNone
	if provider == TTSOpenAI || provider == TTSElevenlabs {
		fileKey := strings.TrimSpace(tts.APIKey)
		var envKey string
		if provider == TTSOpenAI {
			envKey = strings.TrimSpace(os.Getenv("VOICE_TOOLS_OPENAI_KEY"))
			if envKey == "" {
				envKey = strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
			}
		} else {
			envKey = strings.TrimSpace(os.Getenv("ELEVENLABS_API_KEY"))
		}
		apiKey = firstNonEmpty(fileKey, envKey)
		switch {
		case apiKey == "":
			source = KeySourceNone
		case fileKey != "":
			source = KeySourceFile
		default:
			source = KeySourceEnv
		}
	}

	model := strings.TrimSpace(tts.Model)
	if model == "" {
		if provider == TTSElevenlabs {
			model = DefaultTTSElevenlabsModel
		} else {
			model = DefaultTTSOpenAIModel
		}
	}
	base := strings.TrimSpace(tts.BaseURL)
	if base == "" {
		base = DefaultTTSOpenAIBaseURL
	}

	return ResolvedTTS{
		Provider:  provider,
		Voice:     strings.TrimSpace(tts.Voice),
		Model:     model,
		BaseURL:   base,
		APIKey:    apiKey,
		Source:    source,
		ModelPath: firstNonEmpty(strings.TrimSpace(os.Getenv("PIPER_MODEL")), strings.TrimSpace(tts.ModelPath)),
	}
}

// SettingsToPublicTTS builds the key-free TTS view for GET /api/settings.
func SettingsToPublicTTS(settings SettingsFile) *PublicTTSSettings {
	resolved := ResolveTTS(settings)
	out := &PublicTTSSettings{
		Provider: string(resolved.Provider),
		HasKey:   resolved.Source != KeySourceNone,
		Source:   string(resolved.Source),
	}
	if resolved.Voice != "" {
		out.Voice = resolved.Voice
	}
	if resolved.Provider == TTSOpenAI || resolved.Provider == TTSElevenlabs {
		out.Model = resolved.Model
		if resolved.Provider == TTSOpenAI {
			out.BaseURL = resolved.BaseURL
		}
	}
	if resolved.Provider == TTSPiper && resolved.ModelPath != "" {
		out.ModelPath = resolved.ModelPath
	}
	return out
}

// ResolveTTSModelPath resolves the Piper model path from PIPER_MODEL or
// settings, validating existence.
//
// D5: both failure branches name the exact path that was looked for (and
// where it came from), so POST /api/tts's 503 tells ops in one look what to
// fix.
func ResolveTTSModelPath(settings SettingsFile) (modelPath string, errMsg string) {
	resolved := ResolveTTS(settings)
	source := "tts.modelPath in settings"
	if strings.TrimSpace(os.Getenv("PIPER_MODEL")) != "" {
		source = "PIPER_MODEL env var"
	}

	if resolved.ModelPath == "" {
		return "", fmt.Sprintf(
			"TTS model not configured — no path in PIPER_MODEL (env) or tts.modelPath (settings file read: %s)",
			SettingsPath(),
		)
	}

	stat, err := os.Stat(resolved.ModelPath)
	if err != nil || !stat.Mode().IsRegular() {
		return "", fmt.Sprintf("TTS model file not found: %s (from %s)", resolved.ModelPath, source)
	}
	return resolved.ModelPath, ""
}

// ── TTS synthesis budget (D5) ─────────────────────────────────────────────

// DefaultTTSTimeoutMs is the default wall-clock budget for one POST /api/tts
// synthesis. Measured on the target machine (piper 1.2.0 +
// en_US-lessac-medium.onnx, idle): a short sentence is 0.6–0.8 s; a
// full-length (~2.8 k char, 184 s of audio) reply is 27.6 s. The old
// hard-coded 30 s cap sat on top of that, so anything longer — or a loaded
// machine — returned 504. 120 s clears a worst-case body with room to spare.
const DefaultTTSTimeoutMs = 120_000

const minTTSTimeoutMs = 1_000
const maxTTSTimeoutMs = 600_000

// ResolveTTSTimeoutMs reads TTS_TIMEOUT_MS from env, clamped to
// [1 s, 10 min]. Unset, empty, non-numeric or non-positive ⇒ the default.
// Read per request so ops can tune it without a code change.
func ResolveTTSTimeoutMs() int64 {
	raw := strings.TrimSpace(os.Getenv("TTS_TIMEOUT_MS"))
	if raw == "" {
		return DefaultTTSTimeoutMs
	}
	parsed, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed <= 0 {
		return DefaultTTSTimeoutMs
	}
	return clampInt64(int64(math.Round(parsed)), minTTSTimeoutMs, maxTTSTimeoutMs)
}

// ── streaming TTS concurrency cap (P1-4) ──────────────────────────────────

// DefaultTTSMaxConcurrent is the default number of TTS engine processes that
// may run at once across every TTS route.
const DefaultTTSMaxConcurrent = 2

const minTTSMaxConcurrent = 1
const maxTTSMaxConcurrent = 4

// ResolveTTSMaxConcurrent reads TTS_MAX_CONCURRENT, clamped to [1, 4].
func ResolveTTSMaxConcurrent() int64 {
	raw := strings.TrimSpace(os.Getenv("TTS_MAX_CONCURRENT"))
	if raw == "" {
		return DefaultTTSMaxConcurrent
	}
	parsed, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed <= 0 {
		return DefaultTTSMaxConcurrent
	}
	return clampInt64(int64(math.Round(parsed)), minTTSMaxConcurrent, maxTTSMaxConcurrent)
}

// ── shared-secret guard for /api/* (P0-4) ─────────────────────────────────

func safeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// isLoopbackHost mirrors config.ts exactly, quirk included: a single
// trailing ":<digits>" is stripped before the localhost/127.0.0.1/::1 test.
func isLoopbackHost(host string) bool {
	name := strings.ToLower(host)
	if idx := strings.LastIndex(name, ":"); idx >= 0 {
		if _, err := strconv.Atoi(name[idx+1:]); err == nil {
			name = name[:idx]
		}
	}
	name = strings.TrimPrefix(name, "[")
	name = strings.TrimSuffix(name, "]")
	return name == "localhost" || name == "127.0.0.1" || name == "::1"
}

var bearerPrefix = regexp.MustCompile(`(?i)^Bearer\s+`)

func headerKeyMatches(r *http.Request, key string) bool {
	if bearer := strings.TrimSpace(bearerPrefix.ReplaceAllString(r.Header.Get("Authorization"), "")); bearer != "" && safeEqual(bearer, key) {
		return true
	}
	if h := strings.TrimSpace(r.Header.Get("X-Api-Key")); h != "" && safeEqual(h, key) {
		return true
	}
	return false
}

// APIError is the guard's rejection: the route must return it verbatim.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return e.Message }

// Write renders the guard rejection as {"error": ...} JSON.
func (e *APIError) Write(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.Status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": e.Message})
}

func reject(status int, message string) *APIError {
	return &APIError{Status: status, Message: message}
}

var warnedMissingSecret atomic.Bool

// AssertAPIRequest is the guard for every /api/* route. It returns nil when
// the request may proceed, otherwise the rejection the route must return.
//
// Rules (EM integration flag #2, ratified by Alya §4.3):
//  1. Origin, when present, must be a parseable http(s) origin matching our
//     own host exactly. "Origin: null" and any foreign origin → 403.
//     "Sec-Fetch-Site: cross-site" → 403.
//  2. A valid shared secret (API_SERVER_KEY as "Authorization: Bearer *** or
//     "X-API-Key", compared timing-safely) always admits the caller.
//  3. Same-origin exemption: a request proving it came from the app
//     (loopback Host + browser same-origin evidence) is admitted without the
//     secret. With a secret configured, absence of Origin is only acceptable
//     on a browser GET ("Sec-Fetch-Site: same-origin") or when a Referer
//     names our own origin.
//  4. Host must be loopback (kills DNS rebinding). Off-loopback requests
//     need the secret.
func AssertAPIRequest(r *http.Request) *APIError {
	host := r.Host
	origin := r.Header.Get("Origin")
	site := r.Header.Get("Sec-Fetch-Site")

	// 1. Origin / fetch-metadata checks
	if origin != "" {
		if origin == "null" {
			return reject(403, "Cross-origin request rejected")
		}
		matched := false
		if u, err := url.Parse(origin); err == nil {
			if (u.Scheme == "http" || u.Scheme == "https") && host != "" && u.Host == host {
				matched = true
			}
		}
		if !matched {
			return reject(403, "Cross-origin request rejected")
		}
	}
	if site == "cross-site" {
		return reject(403, "Cross-origin request rejected")
	}

	// 2. Shared secret (timing-safe), either accepted header spelling
	key := strings.TrimSpace(os.Getenv("API_SERVER_KEY"))
	if key == "" && warnedMissingSecret.CompareAndSwap(false, true) {
		fmt.Fprintln(os.Stderr, "[api] API_SERVER_KEY is not set — /api/* relies on the loopback bind plus Host/Origin checks only. Set API_SERVER_KEY (BLUEPRINT.md:278) to enforce the shared secret.")
	}
	if key != "" && headerKeyMatches(r, key) {
		return nil
	}

	// 3. Same-origin exemption
	if isLoopbackHost(host) {
		if key == "" {
			return nil // no secret configured — loopback bind + Host check are the control
		}
		if origin != "" || site == "same-origin" || r.Header.Get("Referer") != "" {
			return nil
		}
		return reject(401, "Unauthorized")
	}

	return reject(401, "Unauthorized — this host is not loopback; set API_SERVER_KEY to reach /api/*")
}

// ── outbound auth headers ─────────────────────────────────────────────────

// BearerHeaders returns the Authorization header for server-side outbound
// calls. Never log the result.
func BearerHeaders(apiKey string) map[string]string {
	if apiKey == "" {
		return map[string]string{}
	}
	return map[string]string{"Authorization": "Bearer " + apiKey}
}

// ProviderHeaders returns the auth headers for an upstream provider call.
// Never log the result. Most providers take the OpenAI-standard
// Authorization: Bearer; Xiaomi MiMo instead authenticates with the api-key
// header — both are sent for mimo so either contract succeeds.
func ProviderHeaders(provider Provider, apiKey string) map[string]string {
	if apiKey == "" {
		return map[string]string{}
	}
	if provider == ProviderMimo {
		return map[string]string{"Authorization": "Bearer " + apiKey, "api-key": apiKey}
	}
	return BearerHeaders(apiKey)
}

// RandomTestKey returns a random throwaway key for tests — never a real credential.
func RandomTestKey() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}

// ── small helpers ─────────────────────────────────────────────────────────

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func clampInt64(v, min, max int64) int64 {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// toFiniteFloat converts JSON-ish numbers to float64. Strings, nil, NaN and
// ±Inf are not numbers.
func toFiniteFloat(v any) (float64, bool) {
	var f float64
	switch n := v.(type) {
	case float64:
		f = n
	case float32:
		f = float64(n)
	case int:
		f = float64(n)
	case int64:
		f = float64(n)
	case int32:
		f = float64(n)
	case json.Number:
		parsed, err := n.Float64()
		if err != nil {
			return 0, false
		}
		f = parsed
	default:
		return 0, false
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// numberOrNil maps a stored int64 timeout (0 = absent) to the any form
// ResolveProviderTimeoutMs expects.
func numberOrNil(ms int64) any {
	if ms == 0 {
		return nil
	}
	return float64(ms)
}
