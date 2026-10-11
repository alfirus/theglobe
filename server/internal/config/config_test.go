// Go table tests mirroring frontend/tests/config.test.ts — the P0 security
// contract every /api/* route shares. If a behavior here diverges from
// config.ts, the fix lands on THIS side (the TS suite is the ratified
// contract) unless the ADR says otherwise.
package config

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// ── helpers ───────────────────────────────────────────────────────────────

// guardRequest mirrors tests/helpers.ts apiRequest: loopback Host by default,
// no Origin unless the test sets one. Override headers per test to exercise
// the guard's deny paths.
func guardRequest(target string, headers map[string]string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func decodeJSON(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, data)
	}
	return v
}

// ── isAllowedUrl — upstream allow-list (M15 / §4.1-2) ─────────────────────

func TestIsAllowedURL_AllowsDocumented(t *testing.T) {
	allowed := []string{
		"http://localhost:1234/v1",
		"http://127.0.0.1:9999/v1",
		"https://[::1]:8080",
		"http://10.0.0.5:1234/v1",
		"http://192.168.1.10:1234/v1",
		"http://172.16.0.1:1234/v1",
		"http://172.31.255.255/v1",
		"http://100.64.0.7:1234/v1", // Tailscale / CGNAT
		"https://openrouter.ai/api/v1",
		"https://api.deepseek.com/v1",
		"https://api.xiaomimimo.com/v1",
		"https://token-plan-sgp.xiaomimimo.com/v1",
		"https://api.openai.com/v1",
		"https://api.elevenlabs.io/v1",
	}
	for _, u := range allowed {
		if !IsAllowedURL(u) {
			t.Errorf("expected allowed: %s", u)
		}
	}
}

func TestIsAllowedURL_RejectsHostile(t *testing.T) {
	rejected := []string{
		"https://evil.example.com/v1",
		"https://openrouter.ai.evil.example.com/v1", // suffix spoof
		"http://169.254.169.254/latest/meta-data",   // cloud metadata
		"http://172.32.0.1/v1",                      // just outside 172.16/12
		"http://100.63.0.1/v1",                      // just outside 100.64/10
		"http://999.1.1.1/v1",
		"ftp://openrouter.ai/v1",
		"javascript:alert(1)",
		"not-a-url",
		"",
	}
	for _, u := range rejected {
		if IsAllowedURL(u) {
			t.Errorf("expected rejected: %q", u)
		}
	}
}

func TestIsAllowedURL_ExtraHosts(t *testing.T) {
	// The env var is a comma-separated list of *hosts*, not URLs.
	t.Setenv("GLOB_ALLOWED_ORIGINS", "team-llm.internal.example")
	if !IsAllowedURL("https://team-llm.internal.example/v1") {
		t.Error("expected GLOB_ALLOWED_ORIGINS host to be allowed")
	}
	if IsAllowedURL("https://other.internal.example/v1") {
		t.Error("expected non-listed host to stay rejected")
	}
}

// ── settingsToPublic — GET /api/settings never returns key material ───────

func TestSettingsToPublic_KeyFree(t *testing.T) {
	secret := "sk-file-secret-value"
	view := SettingsToPublic(SettingsFile{
		Provider:     "lmstudio",
		SystemPrompt: "You are terse.",
		Configs: map[string]ProviderFileConfig{
			"lmstudio": {BaseURL: "http://127.0.0.1:1234/v1", Model: "m", APIKey: secret},
		},
		Agents: map[string]ProviderFileConfig{
			"hermes-agent": {BaseURL: "http://127.0.0.1:8642/v1", APIKey: "sk-agent-secret"},
		},
		TTS: &TTSFileConfig{Provider: "openai", APIKey: "sk-tts-secret"},
	})

	serialised, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	for _, leaked := range []string{secret, "sk-file-secret-value", "sk-agent-secret", "sk-tts-secret"} {
		if strings.Contains(string(serialised), leaked) {
			t.Errorf("public view leaks key material: %s", leaked)
		}
	}
	if strings.Contains(string(serialised), `"apiKey"`) {
		t.Error("public view contains an apiKey key")
	}

	if view.Provider != "lmstudio" {
		t.Errorf("provider = %q", view.Provider)
	}
	got := view.Configs["lmstudio"]
	want := PublicProviderView{BaseURL: "http://127.0.0.1:1234/v1", Model: "m", HasKey: true, TimeoutMs: 120_000}
	if got != want {
		t.Errorf("lmstudio view = %+v, want %+v", got, want)
	}
	if view.KeySource["lmstudio"] != "file" {
		t.Errorf("lmstudio keySource = %q", view.KeySource["lmstudio"])
	}
	if !view.Agents["hermes-agent"].HasKey {
		t.Error("agent hasKey should be true")
	}
	if view.TTS == nil || !view.TTS.HasKey {
		t.Error("tts hasKey should be true")
	}
	// Nothing stored ⇒ hasKey is exactly false, no partial key material.
	if SettingsToPublic(SettingsFile{}).Configs["hermes"].HasKey {
		t.Error("empty settings must report hasKey=false")
	}
}

func TestSettingsToPublic_NeverLeaksEnvKey(t *testing.T) {
	t.Setenv("HERMES_API_KEY_MIMO", "env-secret-value")
	view := SettingsToPublic(SettingsFile{})
	serialised, _ := json.Marshal(view)
	if strings.Contains(string(serialised), "env-secret-value") {
		t.Error("public view leaks an env-provided key")
	}
	if view.KeySource["mimo"] != "env" {
		t.Errorf("mimo keySource = %q, want env", view.KeySource["mimo"])
	}
	if !view.Configs["mimo"].HasKey {
		t.Error("mimo hasKey should be true")
	}
}

// ── resolveConfig — key precedence ────────────────────────────────────────

func TestResolveConfig_Precedence(t *testing.T) {
	file := SettingsFile{Configs: map[string]ProviderFileConfig{
		"lmstudio": {APIKey: "file-key"},
	}}

	t.Setenv("HERMES_API_KEY_LMSTUDIO", "provider-env-key")
	t.Setenv("HERMES_API_KEY", "generic-env-key")
	if got := ResolveConfig(ProviderLMStudio, file).APIKey; got != "file-key" {
		t.Errorf("file should win, got %q", got)
	}
	if got := ResolveConfig(ProviderLMStudio, SettingsFile{}).APIKey; got != "provider-env-key" {
		t.Errorf("per-provider env should win, got %q", got)
	}

	t.Setenv("HERMES_API_KEY_LMSTUDIO", "")
	if got := ResolveConfig(ProviderLMStudio, SettingsFile{}).APIKey; got != "generic-env-key" {
		t.Errorf("generic env should win, got %q", got)
	}

	t.Setenv("HERMES_API_KEY", "")
	resolved := ResolveConfig(ProviderLMStudio, SettingsFile{})
	if resolved.APIKey != "" || resolved.Source != KeySourceNone {
		t.Errorf("no key anywhere should yield empty/none, got %+v", resolved)
	}
}

func TestResolveConfig_Defaults(t *testing.T) {
	t.Setenv("HERMES_API_KEY", "")
	t.Setenv("HERMES_API_KEY_DEEPSEEK", "")
	resolved := ResolveConfig(ProviderDeepseek, SettingsFile{})
	if resolved.BaseURL != "https://api.deepseek.com/v1" || resolved.Model != "deepseek-chat" {
		t.Errorf("deepseek defaults wrong: %+v", resolved)
	}
	if resolved.Source != KeySourceNone {
		t.Errorf("keySource = %q, want none", resolved.Source)
	}
	// No key anywhere ⇒ the resolved key is the empty string, never a default.
	if got := ResolveConfig(ProviderHermes, SettingsFile{}).APIKey; got != "" {
		t.Errorf("hermes key should be empty, got %q", got)
	}
}

func TestResolveConfig_TrimsAndOverrides(t *testing.T) {
	resolved := ResolveConfig(ProviderLMStudio, SettingsFile{Configs: map[string]ProviderFileConfig{
		"lmstudio": {BaseURL: "  http://127.0.0.1:9999/v1  ", Model: "stub-model"},
	}})
	if resolved.BaseURL != "http://127.0.0.1:9999/v1" || resolved.Model != "stub-model" {
		t.Errorf("file overrides not applied: %+v", resolved)
	}
}

// ── resolveProviderTimeoutMs ──────────────────────────────────────────────

func TestResolveProviderTimeoutMs(t *testing.T) {
	cases := []struct {
		name string
		raw  any
		want int64
	}{
		{"nil", nil, 120_000},
		{"string", "nope", 120_000},
		{"negative", -1, 120_000},
		{"zero", 0, 120_000},
		{"clamp-min", 1, 5_000},
		{"clamp-max", 999_999_999, 600_000},
		{"rounds", 30_000.6, 30_001},
		{"passthrough", 30_000, 30_000},
	}
	for _, tc := range cases {
		if got := ResolveProviderTimeoutMs(tc.raw); got != tc.want {
			t.Errorf("%s: got %d, want %d", tc.name, got, tc.want)
		}
	}
}

// ── sanitizeSettingsBody + mergeSettings — POST /api/settings ─────────────

func TestSanitize_RejectsHostileURL(t *testing.T) {
	if _, err := SanitizeSettingsBody(map[string]any{
		"configs": map[string]any{"lmstudio": map[string]any{"baseUrl": "https://evil.example.com"}},
	}); err == nil {
		t.Error("hostile upstream URL must be rejected")
	}
	if _, err := SanitizeSettingsBody(map[string]any{
		"configs": map[string]any{"lmstudio": map[string]any{"baseUrl": "http://169.254.169.254"}},
	}); err == nil {
		t.Error("hostile metadata URL must be rejected")
	} else if !strings.Contains(err.Error(), "URL not allowed") {
		t.Errorf("wrong error: %v", err)
	}
}

func TestSanitize_RejectsUnknownIDsAndTypes(t *testing.T) {
	cases := []struct {
		name string
		body map[string]any
		want string
	}{
		{"unknown provider", map[string]any{"provider": "not-a-provider"}, "Unknown provider"},
		{"unknown agent", map[string]any{"agent": "hal-9000"}, "Unknown agent"},
		{"unknown mode", map[string]any{"uplinkMode": "sideways"}, "Unknown uplink mode"},
		{"wrong type", map[string]any{"configs": map[string]any{"hermes": map[string]any{"model": 42}}}, "must be a string"},
		{"configs not object", map[string]any{"configs": "nope"}, "configs must be an object"},
		{"tts not object", map[string]any{"tts": 42}, "tts must be an object"},
		{"unknown tts provider", map[string]any{"tts": map[string]any{"provider": "shout"}}, "Unknown TTS provider"},
	}
	for _, tc := range cases {
		if _, err := SanitizeSettingsBody(tc.body); err == nil {
			t.Errorf("%s: expected error containing %q", tc.name, tc.want)
		} else if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: error %q does not contain %q", tc.name, err.Error(), tc.want)
		}
	}
	if _, err := SanitizeSettingsJSON([]byte(`"nope"`)); err == nil {
		t.Error("scalar body must be rejected")
	} else if !strings.Contains(err.Error(), "Body must be a JSON object") {
		t.Errorf("wrong error: %v", err)
	}
	if _, err := SanitizeSettingsJSON([]byte(`[1,2]`)); err == nil {
		t.Error("array body must be rejected")
	}
}

func TestSanitize_DropsUnknownFields(t *testing.T) {
	patch, err := SanitizeSettingsBody(map[string]any{
		"provider":  "deepseek",
		"evilField": "exfiltrate-me",
		"configs":   map[string]any{"lmstudio": map[string]any{"baseUrl": "http://127.0.0.1:1234/v1", "nested": true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if patch.Provider != "deepseek" {
		t.Errorf("provider = %q", patch.Provider)
	}
	serialised, _ := json.Marshal(patch)
	for _, dropped := range []string{"evilField", "nested", "exfiltrate-me"} {
		if strings.Contains(string(serialised), dropped) {
			t.Errorf("unknown field survived sanitise: %s", dropped)
		}
	}
	want := ProviderFileConfig{BaseURL: "http://127.0.0.1:1234/v1"}
	if patch.Configs["lmstudio"] != want {
		t.Errorf("lmstudio patch = %+v, want %+v", patch.Configs["lmstudio"], want)
	}
}

func TestSanitize_EmptyAPIKeyIsExplicitClear(t *testing.T) {
	raw := map[string]any{"configs": map[string]any{"lmstudio": map[string]any{"apiKey": ""}}}
	patch, err := SanitizeSettingsBody(raw)
	if err != nil {
		t.Fatal(err)
	}
	if patch.Configs["lmstudio"] != (ProviderFileConfig{APIKey: ""}) || len(patch.Configs) != 1 {
		t.Errorf("explicit clear must be emitted: %+v", patch.Configs)
	}
	merged := MergeSettings(SettingsFile{Configs: map[string]ProviderFileConfig{
		"lmstudio": {APIKey: "old-key", Model: "keep-me"},
	}}, patch, raw)
	got := merged.Configs["lmstudio"]
	if got.APIKey != "" || got.Model != "keep-me" {
		t.Errorf("rotation merge wrong: %+v", got)
	}
}

func TestMerge_KeepsUntouchedFields(t *testing.T) {
	raw := map[string]any{"configs": map[string]any{"lmstudio": map[string]any{"model": "new-model"}}}
	patch, err := SanitizeSettingsBody(raw)
	if err != nil {
		t.Fatal(err)
	}
	merged := MergeSettings(SettingsFile{Configs: map[string]ProviderFileConfig{
		"lmstudio": {BaseURL: "http://127.0.0.1:1234/v1", APIKey: "keep-key"},
	}}, patch, raw)
	got := merged.Configs["lmstudio"]
	if got.BaseURL != "http://127.0.0.1:1234/v1" || got.APIKey != "keep-key" || got.Model != "new-model" {
		t.Errorf("per-field merge wrong: %+v", got)
	}
}

func TestMerge_TopLevelScalars(t *testing.T) {
	raw := map[string]any{"provider": "deepseek", "systemPrompt": "Be terse.", "uplinkMode": "agent", "agent": "openclaw-agent"}
	patch, err := SanitizeSettingsBody(raw)
	if err != nil {
		t.Fatal(err)
	}
	merged := MergeSettings(SettingsFile{Provider: "hermes"}, patch, raw)
	if merged.Provider != "deepseek" || merged.SystemPrompt != "Be terse." ||
		merged.UplinkMode != "agent" || merged.Agent != "openclaw-agent" {
		t.Errorf("top-level merge wrong: %+v", merged)
	}
}

func TestApplySettingsPatch_EndToEnd(t *testing.T) {
	current := SettingsFile{Configs: map[string]ProviderFileConfig{
		"lmstudio": {BaseURL: "http://127.0.0.1:1234/v1", APIKey: "old", Model: "m"},
	}}
	merged, err := ApplySettingsPatch(current, decodeJSON(t, []byte(
		`{"configs":{"lmstudio":{"apiKey":""}},"tts":{"provider":"piper","modelPath":"/models/voice.onnx"}}`)))
	if err != nil {
		t.Fatal(err)
	}
	if merged.Configs["lmstudio"].APIKey != "" || merged.Configs["lmstudio"].Model != "m" {
		t.Errorf("configs merge wrong: %+v", merged.Configs["lmstudio"])
	}
	if merged.TTS == nil || merged.TTS.Provider != "piper" || merged.TTS.ModelPath != "/models/voice.onnx" {
		t.Errorf("tts merge wrong: %+v", merged.TTS)
	}
}

// ── assertApiRequest — shared-secret guard for /api/* ─────────────────────

func TestGuard_LoopbackNoSecret(t *testing.T) {
	t.Setenv("API_SERVER_KEY", "")
	if err := AssertAPIRequest(guardRequest("http://localhost:5173/api/stats", nil)); err != nil {
		t.Errorf("loopback same-origin with no secret must pass: %v", err)
	}
}

func TestGuard_RejectsCrossOrigin(t *testing.T) {
	t.Setenv("API_SERVER_KEY", "")
	for _, h := range []map[string]string{
		{"Origin": "https://evil.example.com"},
		{"Origin": "null"},
		{"Sec-Fetch-Site": "cross-site"},
	} {
		if err := AssertAPIRequest(guardRequest("http://localhost:5173/api/chat", h)); err == nil {
			t.Errorf("headers %v must be rejected", h)
		} else if err.Status != 403 {
			t.Errorf("headers %v: status %d, want 403", h, err.Status)
		}
	}
}

func TestGuard_OffLoopbackRequiresSecret(t *testing.T) {
	t.Setenv("API_SERVER_KEY", "shared-secret-value")

	denied := AssertAPIRequest(guardRequest("http://globe.example.com/api/chat", map[string]string{"Host": "globe.example.com"}))
	if denied == nil || denied.Status != 401 {
		t.Errorf("off-loopback without secret must be 401, got %v", denied)
	}

	if err := AssertAPIRequest(guardRequest("http://globe.example.com/api/chat", map[string]string{
		"Host": "globe.example.com", "Authorization": "Bearer shared-secret-value",
	})); err != nil {
		t.Errorf("valid Bearer secret must pass: %v", err)
	}

	if err := AssertAPIRequest(guardRequest("http://globe.example.com/api/chat", map[string]string{
		"Host": "globe.example.com", "X-Api-Key": "shared-secret-value",
	})); err != nil {
		t.Errorf("valid X-API-Key secret must pass: %v", err)
	}

	wrong := AssertAPIRequest(guardRequest("http://globe.example.com/api/chat", map[string]string{
		"Host": "globe.example.com", "Authorization": "Bearer nope",
	}))
	if wrong == nil || wrong.Status != 401 {
		t.Errorf("wrong secret must be 401, got %v", wrong)
	}
}

func TestGuard_LoopbackNeedsEvidenceWhenSecretSet(t *testing.T) {
	t.Setenv("API_SERVER_KEY", "shared-secret-value")
	// Loopback Host, but neither Origin nor Sec-Fetch-Site nor Referer.
	if err := AssertAPIRequest(guardRequest("http://localhost:5173/api/chat", nil)); err == nil {
		t.Error("loopback without browser evidence must be 401 when a secret is set")
	} else if err.Status != 401 {
		t.Errorf("status %d, want 401", err.Status)
	}

	for _, h := range []map[string]string{
		{"Sec-Fetch-Site": "same-origin"},
		{"Origin": "http://localhost:5173"},
		{"Referer": "http://localhost:5173/"},
	} {
		if err := AssertAPIRequest(guardRequest("http://localhost:5173/api/chat", h)); err != nil {
			t.Errorf("headers %v must pass with evidence: %v", h, err)
		}
	}
}

// ── PROVIDERS table ───────────────────────────────────────────────────────

func TestProviderTables(t *testing.T) {
	want := []string{"hermes", "lmstudio", "opencode", "openrouter", "deepseek", "openclaw", "mimo"}
	if len(Providers) != len(want) {
		t.Fatalf("providers = %v", Providers)
	}
	for i, p := range want {
		if Providers[i] != p {
			t.Fatalf("providers = %v, want %v", Providers, want)
		}
	}
	// DEFAULTS carries no apiKey field (C4) — assert on the serialised form
	// so a future field addition trips this test.
	serialised, _ := json.Marshal(Defaults)
	if strings.Contains(string(serialised), "apiKey") {
		t.Error("Defaults must not carry an apiKey field")
	}
	if len(Agents) != 2 || Agents[0] != "hermes-agent" || Agents[1] != "openclaw-agent" {
		t.Errorf("agents = %v", Agents)
	}
}

// ── agents / uplink ───────────────────────────────────────────────────────

func TestResolveAgent_Precedence(t *testing.T) {
	t.Setenv("HERMES_API_KEY_HERMES_AGENT", "agent-env-key")
	t.Setenv("HERMES_API_KEY", "generic-env-key")
	got := ResolveAgent(AgentHermes, SettingsFile{})
	if got.APIKey != "agent-env-key" || got.Source != KeySourceEnv {
		t.Errorf("per-agent env should win: %+v", got)
	}
	t.Setenv("HERMES_API_KEY_HERMES_AGENT", "")
	got = ResolveAgent(AgentHermes, SettingsFile{})
	if got.APIKey != "generic-env-key" {
		t.Errorf("generic env should win: %+v", got)
	}
	file := SettingsFile{Agents: map[string]ProviderFileConfig{"hermes-agent": {APIKey: "file-key"}}}
	if got := ResolveAgent(AgentHermes, file); got.APIKey != "file-key" || got.Source != KeySourceFile {
		t.Errorf("file should win: %+v", got)
	}
}

func TestResolveUplink(t *testing.T) {
	up := ResolveUplink(SettingsFile{})
	if up.Mode != UplinkProvider || up.ID != "hermes" {
		t.Errorf("default uplink wrong: %+v", up)
	}
	up = ResolveUplink(SettingsFile{UplinkMode: "agent"})
	if up.Mode != UplinkAgent || up.ID != "hermes-agent" {
		t.Errorf("agent uplink wrong: %+v", up)
	}
	up = ResolveUplink(SettingsFile{UplinkMode: "sideways", Provider: "deepseek"})
	if up.Mode != UplinkProvider || up.ID != "deepseek" {
		t.Errorf("invalid mode should fall back to provider: %+v", up)
	}
}

// ── TTS resolution ────────────────────────────────────────────────────────

func TestResolveTTS_Defaults(t *testing.T) {
	r := ResolveTTS(SettingsFile{})
	if r.Provider != TTSSystem || r.Source != KeySourceNone || r.APIKey != "" {
		t.Errorf("default tts wrong: %+v", r)
	}
	if r.Model != DefaultTTSOpenAIModel || r.BaseURL != DefaultTTSOpenAIBaseURL {
		t.Errorf("default tts model/base wrong: %+v", r)
	}
}

func TestResolveTTS_CloudKeys(t *testing.T) {
	t.Setenv("VOICE_TOOLS_OPENAI_KEY", "voice-key")
	t.Setenv("OPENAI_API_KEY", "")
	r := ResolveTTS(SettingsFile{TTS: &TTSFileConfig{Provider: "openai"}})
	if r.APIKey != "voice-key" || r.Source != KeySourceEnv {
		t.Errorf("openai env key wrong: %+v", r)
	}
	t.Setenv("VOICE_TOOLS_OPENAI_KEY", "")
	t.Setenv("OPENAI_API_KEY", "openai-key")
	r = ResolveTTS(SettingsFile{TTS: &TTSFileConfig{Provider: "openai"}})
	if r.APIKey != "openai-key" {
		t.Errorf("OPENAI_API_KEY fallback wrong: %+v", r)
	}
	t.Setenv("ELEVENLABS_API_KEY", "el-key")
	r = ResolveTTS(SettingsFile{TTS: &TTSFileConfig{Provider: "elevenlabs"}})
	if r.APIKey != "el-key" || r.Model != DefaultTTSElevenlabsModel {
		t.Errorf("elevenlabs wrong: %+v", r)
	}
	// Piper needs no key; env model path wins over the file.
	t.Setenv("PIPER_MODEL", "/env/model.onnx")
	r = ResolveTTS(SettingsFile{TTS: &TTSFileConfig{Provider: "piper", ModelPath: "/file/model.onnx"}})
	if r.ModelPath != "/env/model.onnx" || r.Source != KeySourceNone {
		t.Errorf("piper model path wrong: %+v", r)
	}
}

func TestResolveTTSModelPath_ErrorsNamePathAndSource(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	t.Setenv("PIPER_MODEL", "")

	_, msg := ResolveTTSModelPath(SettingsFile{})
	if !strings.Contains(msg, "TTS model not configured") || !strings.Contains(msg, ".globe-settings.json") {
		t.Errorf("unconfigured error must name the settings file: %q", msg)
	}

	t.Setenv("PIPER_MODEL", filepath.Join(dir, "missing.onnx"))
	_, msg = ResolveTTSModelPath(SettingsFile{})
	if !strings.Contains(msg, "TTS model file not found") ||
		!strings.Contains(msg, "missing.onnx") ||
		!strings.Contains(msg, "PIPER_MODEL env var") {
		t.Errorf("missing-model error must name path + source: %q", msg)
	}

	// Existing file resolves.
	model := filepath.Join(dir, "voice.onnx")
	if err := os.WriteFile(model, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIPER_MODEL", model)
	got, msg := ResolveTTSModelPath(SettingsFile{})
	if msg != "" || got != model {
		t.Errorf("existing model should resolve: %q %q", got, msg)
	}
}

func TestResolveTTSTimeoutMs(t *testing.T) {
	t.Setenv("TTS_TIMEOUT_MS", "")
	if got := ResolveTTSTimeoutMs(); got != 120_000 {
		t.Errorf("default = %d", got)
	}
	t.Setenv("TTS_TIMEOUT_MS", "banana")
	if got := ResolveTTSTimeoutMs(); got != 120_000 {
		t.Errorf("junk = %d", got)
	}
	t.Setenv("TTS_TIMEOUT_MS", "10")
	if got := ResolveTTSTimeoutMs(); got != 1_000 {
		t.Errorf("clamp-min = %d", got)
	}
	t.Setenv("TTS_TIMEOUT_MS", "99999999")
	if got := ResolveTTSTimeoutMs(); got != 600_000 {
		t.Errorf("clamp-max = %d", got)
	}
}

func TestResolveTTSMaxConcurrent(t *testing.T) {
	t.Setenv("TTS_MAX_CONCURRENT", "")
	if got := ResolveTTSMaxConcurrent(); got != 2 {
		t.Errorf("default = %d", got)
	}
	t.Setenv("TTS_MAX_CONCURRENT", "99")
	if got := ResolveTTSMaxConcurrent(); got != 4 {
		t.Errorf("clamp-max = %d", got)
	}
	t.Setenv("TTS_MAX_CONCURRENT", "0")
	if got := ResolveTTSMaxConcurrent(); got != 2 {
		t.Errorf("non-positive = %d", got)
	}
}

// ── outbound headers ──────────────────────────────────────────────────────

func TestProviderHeaders(t *testing.T) {
	if h := ProviderHeaders(ProviderDeepseek, ""); len(h) != 0 {
		t.Errorf("empty key must yield no headers: %v", h)
	}
	if h := ProviderHeaders(ProviderDeepseek, "k"); h["Authorization"] != "Bearer k" || len(h) != 1 {
		t.Errorf("standard provider headers wrong: %v", h)
	}
	// mimo sends both Authorization and api-key.
	h := ProviderHeaders(ProviderMimo, "k")
	if h["Authorization"] != "Bearer k" || h["api-key"] != "k" {
		t.Errorf("mimo headers wrong: %v", h)
	}
	if h := BearerHeaders(""); len(h) != 0 {
		t.Errorf("empty bearer must yield no headers: %v", h)
	}
}

func TestRandomTestKey(t *testing.T) {
	a, b := RandomTestKey(), RandomTestKey()
	if len(a) != 32 || a == b {
		t.Errorf("random keys must be 32 hex chars and differ: %q %q", a, b)
	}
}

// ── settings file I/O ─────────────────────────────────────────────────────

func TestReadWriteSettings_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)

	if got := ReadSettings(); len(got.Configs) != 0 || got.Provider != "" {
		t.Errorf("missing file must yield empty settings: %+v", got)
	}

	want := SettingsFile{
		Provider: "lmstudio",
		Configs:  map[string]ProviderFileConfig{"lmstudio": {Model: "m", APIKey: "k"}},
	}
	if err := WriteSettings(want); err != nil {
		t.Fatal(err)
	}
	got := ReadSettings()
	if got.Provider != "lmstudio" || got.Configs["lmstudio"].Model != "m" {
		t.Errorf("round trip wrong: %+v", got)
	}
	// 0600 on creation. POSIX-only assertion: Windows ACLs have no Unix
	// permission bits (Node's { mode: 0o600 } is likewise POSIX-only), so
	// the mode contract is enforced where it exists.
	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(dir, SettingsFilename))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Errorf("settings file perm = %o, want 600", info.Mode().Perm())
		}
	}
}

func TestReadSettings_DegradesToEmpty(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	path := filepath.Join(dir, SettingsFilename)

	if err := os.WriteFile(path, []byte("{truncated"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := ReadSettings(); got.Provider != "" || len(got.Configs) != 0 {
		t.Errorf("truncated JSON must yield empty: %+v", got)
	}

	if err := os.WriteFile(path, []byte(`[1,2]`), 0600); err != nil {
		t.Fatal(err)
	}
	if got := ReadSettings(); got.Provider != "" {
		t.Errorf("array JSON must yield empty: %+v", got)
	}

	// Oversized file (>64 KiB) is refused.
	big := append([]byte(`{"provider":"hermes","systemPrompt":"`), []byte(strings.Repeat("x", 70*1024))...)
	big = append(big, []byte(`"}`)...)
	if err := os.WriteFile(path, big, 0600); err != nil {
		t.Fatal(err)
	}
	if got := ReadSettings(); got.Provider != "" {
		t.Errorf("oversized file must yield empty: %+v", got.Provider)
	}
}
