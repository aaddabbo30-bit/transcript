"""Small OS helpers: API key in the user environment, opening files and folders."""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

log = logging.getLogger(__name__)

API_KEY_VAR = "ANTHROPIC_API_KEY"


def _read_user_env_windows(name: str) -> str | None:  # pragma: no cover - Windows only
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _ = winreg.QueryValueEx(key, name)
            return str(value) if value else None
    except OSError:
        return None


def load_api_key_from_user_env() -> bool:
    """If the process environment lacks the key but the Windows user
    environment has it (the app was started from an old window), use it."""
    if os.environ.get(API_KEY_VAR):
        return True
    if sys.platform == "win32":
        value = _read_user_env_windows(API_KEY_VAR)
        if value:
            os.environ[API_KEY_VAR] = value
            return True
    return False


def save_api_key(value: str) -> bool:
    """Store the key as a persistent *user* environment variable (Windows) and
    for this process. Returns True if it was persisted."""
    value = value.strip()
    os.environ[API_KEY_VAR] = value
    if sys.platform != "win32":
        return False
    try:  # pragma: no cover - Windows only
        import ctypes
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, API_KEY_VAR, 0, winreg.REG_SZ, value)
        # Tell Explorer so programs started from now on see the new variable.
        HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG = 0xFFFF, 0x001A, 0x0002
        result = ctypes.c_size_t()  # DWORD_PTR
        ctypes.windll.user32.SendMessageTimeoutW(
            HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment", SMTO_ABORTIFHUNG, 3000, ctypes.byref(result)
        )
        return True
    except OSError:
        log.exception("Could not save the API key to the user environment")
        return False


def open_path(path: Path) -> None:
    """Open a file or folder with the default app (Explorer, Notepad, ...)."""
    path = Path(path)
    try:
        if sys.platform == "win32":
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        log.exception("Could not open %s", path)
