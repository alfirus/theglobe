#!/usr/bin/env python3
"""Warm Whisper worker for `POST /api/stt` (P1-7, non-Chromium voice input).

Protocol — newline-delimited JSON over stdio, one object per line:

  parent -> worker   {"id": 1, "path": "C:/…/clip.webm", "language": "en"}
  worker -> parent   {"id": 1, "text": "…", "ms": 412}

  On start the worker prints exactly one readiness line and keeps running:

  worker -> parent   {"ready": true,  "engine": "faster-whisper",
                      "model": "base", "python": "3.13.13"}
  worker -> parent   {"ready": false, "code": "engine_unavailable",
                      "error": "…"}            (then exit 1)

Why a warm process instead of one spawn per request: a cold
`whisper` CLI round trip measured 12.1 s on the target machine for a 10.4 s
clip (torch import + model load + decode), while this worker — model loaded
once — answers the same clip in ~1.0 s (faster-whisper, int8, CPU).

Engines, in order of preference:

  1. `faster-whisper` (CTranslate2) — BLUEPRINT's "Hermes STT" option.
     Loaded with `local_files_only=True` first: HF Hub's online cache
     validation cost 108–170 s per start on this machine, while the local
     load is 0.9 s. If the model is not cached we retry once with network
     access (first run downloads it).
  2. `openai-whisper` (torch) — fallback when only the original Whisper is
     installed (~2.2–3.3 s per 10.4 s clip warm).

Every failure is reported on stdout as JSON and never as a traceback alone:
the Node side turns it into a user-visible error, so no dictation attempt is
silently dropped.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import NoReturn


# Server-local paths must never reach the browser: Node surfaces `error` copy
# to the client (card t_c0ae5752). stderr diagnostics via log() keep the full
# paths for the ops log — only stdout JSON is sanitized here.
_ABS_PATH_RE = re.compile(
    r"[A-Za-z]:[\\/][^\s\"'`]+"  # Windows: C:\… / C:/…
    r"|(?<![\w/])"  # POSIX: /… (not mid-word, so `audio/webm` survives)
    r"/(?:[^\s\"'`/]+/)*[^\s\"'`]*"
)


def sanitize_error(message: str) -> str:
    """Replace absolute paths with their basename (or drop them when bare)."""

    def _basename(match: re.Match[str]) -> str:
        token = match.group(0)
        base = token.replace("\\", "/").rsplit("/", 1)[-1].strip().strip(".,:;\"'`")
        return base if base else ""

    return re.sub(r"\s{2,}", " ", _ABS_PATH_RE.sub(_basename, message)).strip()


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(code: str, message: str) -> NoReturn:
    """Report a startup failure on stdout (the parent turns it into UI copy)."""
    emit({"ready": False, "code": code, "error": message})
    raise SystemExit(1)


def log(message: str) -> None:
    """stderr diagnostics — the Node side captures them for the ops log."""
    sys.stderr.write(f"[stt-worker] {message}\n")
    sys.stderr.flush()


def load_faster_whisper(model_name: str):
    from faster_whisper import WhisperModel

    try:
        # Fast path: everything already on disk (see module docstring).
        return WhisperModel(model_name, device="cpu", compute_type="int8", local_files_only=True), "faster-whisper"
    except Exception as exc:
        # Cold path: let the hub fetch the model once.
        log(f"local model load failed ({type(exc).__name__}: {exc}) — retrying with network access")
        return WhisperModel(model_name, device="cpu", compute_type="int8"), "faster-whisper"


def load_openai_whisper(model_name: str):
    import whisper

    return whisper.load_model(model_name, device="cpu"), "openai-whisper"


def main() -> None:
    if sys.version_info < (3, 9):
        fail("python_too_old", f"Python 3.9+ required, found {sys.version.split()[0]}")

    model_name = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("STT_MODEL", "base")
    default_language = os.environ.get("STT_LANGUAGE", "").strip() or None

    started = time.time()
    engines = []
    try:
        import faster_whisper  # noqa: F401

        engines.append(load_faster_whisper)
    except Exception:
        pass
    try:
        import whisper  # noqa: F401

        engines.append(load_openai_whisper)
    except Exception:
        pass
    log(f"engine probe: {len(engines)} candidate(s) in {time.time() - started:.2f}s")

    if not engines:
        fail(
            "engine_unavailable",
            "No speech engine in this Python. Install one with "
            "`python -m pip install faster-whisper` (or `openai-whisper`), "
            "or point STT_PYTHON at an interpreter that has it.",
        )

    errors: list[str] = []
    model = None
    engine = ""
    for loader in engines:
        started = time.time()
        try:
            model, engine = loader(model_name)
        except Exception as exc:  # noqa: BLE001 — reported, then the next engine is tried
            errors.append(f"{loader.__name__}: {type(exc).__name__}: {sanitize_error(str(exc))[:500]}")
            continue
        load_ms = int((time.time() - started) * 1000)
        emit(
            {
                "ready": True,
                "engine": engine,
                "model": model_name,
                "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
                "loadMs": load_ms,
            }
        )
        break
    else:
        fail(
            "model_load_failed",
            f"Could not load Whisper model '{model_name}'. " + " | ".join(errors),
        )

    if model is None:  # unreachable — every branch above either sets it or exits
        fail("model_load_failed", f"No engine could load Whisper model '{model_name}'.")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            emit({"id": None, "error": "invalid request line", "code": "invalid_request"})
            continue

        rid = req.get("id")
        path = req.get("path")
        language = req.get("language") or default_language
        if not path:
            emit({"id": rid, "error": "missing audio path", "code": "invalid_request"})
            continue

        started = time.time()
        try:
            if engine == "faster-whisper":
                segments, _info = model.transcribe(
                    path,
                    language=language,
                    vad_filter=True,
                )
                text = " ".join(seg.text for seg in segments).strip()
            else:
                result = model.transcribe(path, language=language, fp16=False, verbose=False)
                text = (result.get("text") or "").strip()
            emit({"id": rid, "text": text, "ms": int((time.time() - started) * 1000)})
        except Exception as exc:  # noqa: BLE001 — one bad clip must not kill the worker
            detail = sanitize_error(str(exc))[:500]
            text = f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__
            emit({"id": rid, "error": text, "code": "transcribe_failed"})


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        # Parent went away (server restart) — leave quietly.
        sys.exit(0)
