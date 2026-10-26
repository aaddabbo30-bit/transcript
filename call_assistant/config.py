"""Settings and file locations.

Everything the user owns (memory, call summaries, settings, logs) lives in one
folder that is easy to find: ``Documents\\Call Assistant`` on Windows.
Set the ``CALL_ASSISTANT_HOME`` environment variable to use another folder.

The Anthropic API key is never stored here: it is read from the
``ANTHROPIC_API_KEY`` environment variable.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

APP_NAME = "Call Assistant"
APP_DIR = Path(__file__).resolve().parent.parent  # the folder the user unzipped

WHISPER_MODELS = ["tiny", "base", "small", "medium", "large-v3-turbo"]
CALL_LANGUAGES = ["auto", "it", "en"]
UI_LANGUAGES = ["it", "en"]

# USD per million tokens. Estimates used only for the cost shown in the window;
# check https://claude.com/pricing for current prices.
DEFAULT_PRICING: dict[str, dict[str, float]] = {
    "claude-haiku-5-5": {"input": 0.10, "output": 0.50, "cache_write": 0.125, "cache_read": 0.01},
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_write": 2.50, "cache_read": 0.20},
    "claude-opus-5-5": {"input": 4.00, "output": 20.00, "cache_write": 5.00, "cache_read": 0.20},
}

DEFAULT_SETTINGS: dict[str, Any] = {
    "ui_language": "it",
    "call_language": "auto",
    "capture_microphone": True,
    "capture_system_audio": True,
    # Part of a device name, e.g. "Headset". Empty = Windows default device.
    "microphone_device": "",
    "speaker_device": "",
    "whisper_model": "small",
    "whisper_device": "cpu",
    "whisper_compute_type": "int8",
    "whisper_beam_size": 1,
    # Fast, cheap model for the live insights...
    "insight_model": "claude-haiku-5-5",
    "insight_effort": "low",
    "insight_interval_seconds": 25,
    "insight_transcript_window_seconds": 240,
    # ...and a stronger model, once per call, for the final summary.
    "summary_model": "claude-opus-5-5",
    "summary_effort": "medium",
    "window": {"x": None, "y": None, "width": 400, "height": 700, "alpha": 0.96, "topmost": True,
               "show_transcript": True},
    "pricing_usd_per_million_tokens": DEFAULT_PRICING,
}


def _windows_documents_dir() -> Path | None:
    """The real Documents folder, also when OneDrive redirects it."""
    try:
        import ctypes
        from ctypes import wintypes

        buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
        # CSIDL_PERSONAL = 5 (Documents), SHGFP_TYPE_CURRENT = 0
        if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0 and buf.value:
            return Path(buf.value)
    except Exception:  # pragma: no cover - Windows only
        log.exception("Could not resolve the Documents folder")
    return None


def default_home() -> Path:
    override = os.environ.get("CALL_ASSISTANT_HOME")
    if override:
        return Path(override).expanduser()
    docs = _windows_documents_dir() if sys.platform == "win32" else None
    if docs is None:
        docs = Path.home() / "Documents"
    return docs / APP_NAME


@dataclass(frozen=True)
class Paths:
    home: Path

    @property
    def memory(self) -> Path:
        return self.home / "memory"

    @property
    def calls(self) -> Path:
        return self.home / "calls"

    @property
    def logs(self) -> Path:
        return self.home / "logs"

    @property
    def settings_file(self) -> Path:
        return self.home / "settings.json"

    @property
    def models(self) -> Path:
        return APP_DIR / "models"

    def ensure(self) -> "Paths":
        for p in (self.home, self.memory, self.calls, self.logs):
            p.mkdir(parents=True, exist_ok=True)
        return self


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


class Settings:
    """User preferences stored as JSON. Thread-safe reads and writes."""

    def __init__(self, path: Path, data: dict[str, Any]):
        self.path = path
        self._data = data
        self._lock = threading.Lock()

    @classmethod
    def load(cls, path: Path) -> "Settings":
        stored: dict[str, Any] = {}
        if path.exists():
            try:
                stored = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(stored, dict):
                    raise ValueError("settings.json must contain a JSON object")
            except (OSError, ValueError) as exc:
                backup = path.with_suffix(".broken.json")
                log.warning("Unreadable settings (%s); saving a copy to %s and using defaults", exc, backup)
                try:
                    path.replace(backup)
                except OSError:
                    pass
                stored = {}
        settings = cls(path, _deep_merge(DEFAULT_SETTINGS, stored))
        settings._validate()
        settings.save()  # writes any new default keys so the user can see them
        return settings

    def _validate(self) -> None:
        d = self._data
        if d.get("ui_language") not in UI_LANGUAGES:
            d["ui_language"] = DEFAULT_SETTINGS["ui_language"]
        if d.get("call_language") not in CALL_LANGUAGES:
            d["call_language"] = DEFAULT_SETTINGS["call_language"]
        try:
            d["insight_interval_seconds"] = max(10, min(120, int(d["insight_interval_seconds"])))
        except (TypeError, ValueError):
            d["insight_interval_seconds"] = DEFAULT_SETTINGS["insight_interval_seconds"]

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return copy.deepcopy(self._data.get(key, default))

    def __getitem__(self, key: str) -> Any:
        return self.get(key)

    def update(self, **values: Any) -> None:
        with self._lock:
            self._data.update(values)
            self._validate()
        self.save()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._data)

    def save(self) -> None:
        with self._lock:
            text = json.dumps(self._data, indent=2, ensure_ascii=False)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(text + "\n", encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            log.exception("Could not save settings to %s", self.path)


def setup_logging(paths: Paths, verbose: bool = False) -> Path:
    from logging.handlers import RotatingFileHandler

    log_file = paths.logs / "app.log"
    handler = RotatingFileHandler(log_file, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(threadName)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    root.addHandler(handler)
    if sys.stderr is not None and not getattr(sys, "frozen", False):
        console = logging.StreamHandler()
        console.setLevel(logging.DEBUG if verbose else logging.WARNING)
        console.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
        root.addHandler(console)
    # Keep third-party chatter out of the log file.
    for noisy in ("httpx", "httpx2", "httpcore", "httpcore2", "anthropic", "faster_whisper", "huggingface_hub"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    return log_file
