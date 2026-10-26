"""Personal memory: a folder of Markdown files used as context for Claude.

    memory/
      about-me.md                 who you are
      interests.md                what you like, what you are working on
      people/<Full Name>.md       one file per person you talk with
      claude-memory-export.md     what you pasted from claude.ai

Any other ``.md`` file you add is used too. Claude can only *propose*
additions after a call; nothing is written without your approval, and
existing text is never deleted (changes are appended).
"""

from __future__ import annotations

import datetime as dt
import logging
import re
import shutil
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .config import APP_DIR

log = logging.getLogger(__name__)

TEMPLATES_DIR = APP_DIR / "memory_templates"
EXPORT_FILE = "claude-memory-export.md"
# ~250k characters stays well below 100k tokens, where Haiku 5.5 gets pricier.
MAX_MEMORY_CHARS = 250_000

_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_SAFE_NAME = re.compile(r"[^\w\s.,'()&-]", re.UNICODE)


class MemoryPathError(ValueError):
    pass


@dataclass
class MemoryUpdate:
    file: str
    action: str  # "append" or "create"
    content: str
    reason: str = ""
    accepted: bool = True

    @classmethod
    def from_dict(cls, d: dict) -> "MemoryUpdate":
        return cls(
            file=str(d.get("file", "")),
            action=str(d.get("action", "append")),
            content=str(d.get("content", "")),
            reason=str(d.get("reason", "")),
        )


class Memory:
    def __init__(self, root: Path, language: str = "it"):
        self.root = root
        self.language = language if language in ("it", "en") else "it"

    def ensure(self) -> None:
        """Create the folder and copy the starter templates (never overwrites)."""
        self.root.mkdir(parents=True, exist_ok=True)
        src = TEMPLATES_DIR / self.language
        if not src.exists():
            return
        for path in src.rglob("*.md"):
            target = self.root / path.relative_to(src)
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)

    def files(self) -> list[Path]:
        if not self.root.exists():
            return []
        found = [
            p
            for p in self.root.rglob("*.md")
            if p.is_file() and not p.name.startswith(".") and p.name.lower() != "readme.md"
        ]
        # Fixed order keeps the prompt identical between requests (prompt caching).
        return sorted(found, key=lambda p: (len(p.relative_to(self.root).parts), str(p.relative_to(self.root)).lower()))

    def relative_names(self) -> list[str]:
        return [p.relative_to(self.root).as_posix() for p in self.files()]

    @staticmethod
    def _clean(text: str) -> str:
        text = _COMMENT.sub("", text)
        lines = [ln.rstrip() for ln in text.splitlines()]
        text = "\n".join(lines)
        return re.sub(r"\n{3,}", "\n\n", text).strip()

    def load_text(self, max_chars: int = MAX_MEMORY_CHARS) -> tuple[str, bool]:
        """All memory as one text block. Returns (text, truncated)."""
        parts = []
        for path in self.files():
            try:
                body = self._clean(path.read_text(encoding="utf-8-sig", errors="replace"))
            except OSError:
                log.warning("Cannot read %s", path)
                continue
            # Skip files that hold only headings (untouched templates).
            if not [ln for ln in body.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]:
                continue
            parts.append(f'<file path="{path.relative_to(self.root).as_posix()}">\n{body}\n</file>')
        text = "\n\n".join(parts)
        if not text:
            return "(The memory is empty: nothing is known about the user yet.)", False
        if len(text) > max_chars:
            return text[:max_chars] + "\n[... memory truncated ...]", True
        return text, False

    # -- writing ---------------------------------------------------------
    def resolve(self, relative: str) -> Path:
        """Validate a path proposed by Claude: inside the memory folder, ``.md`` only."""
        rel = relative.strip().replace("\\", "/")
        pure = PurePosixPath(rel)
        if not rel or pure.is_absolute() or ".." in pure.parts or ":" in rel or pure.suffix.lower() != ".md":
            raise MemoryPathError(f"Not allowed: {relative!r}")
        parts = [_SAFE_NAME.sub("", part).strip() for part in pure.parts]
        if any(not part or part.startswith(".") for part in parts):
            raise MemoryPathError(f"Not allowed: {relative!r}")
        path = self.root.joinpath(*parts)
        root = self.root.resolve()
        if root not in path.resolve().parents:
            raise MemoryPathError(f"Outside the memory folder: {relative!r}")
        return path

    def apply(self, update: MemoryUpdate, source: str = "") -> Path:
        path = self.resolve(update.file)
        content = update.content.strip()
        if not content:
            raise ValueError("empty content")
        path.parent.mkdir(parents=True, exist_ok=True)
        stamp = dt.date.today().isoformat()
        note = f"<!-- added {stamp}{' from ' + source if source else ''} -->\n"
        if path.exists():
            existing = path.read_text(encoding="utf-8-sig", errors="replace")
            sep = "" if existing.endswith("\n\n") else ("\n" if existing.endswith("\n") else "\n\n")
            path.write_text(existing + sep + note + content + "\n", encoding="utf-8")
        else:
            title = path.stem
            path.write_text(f"# {title}\n\n{note}{content}\n", encoding="utf-8")
        log.info("Memory updated: %s", path)
        return path

    def import_claude_export(self, text: str) -> Path:
        """Append text pasted from claude.ai to claude-memory-export.md."""
        text = text.strip()
        if not text:
            raise ValueError("empty text")
        path = self.root / EXPORT_FILE
        self.root.mkdir(parents=True, exist_ok=True)
        header = f"## Import {dt.datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
        if path.exists():
            existing = path.read_text(encoding="utf-8-sig", errors="replace").rstrip()
            path.write_text(f"{existing}\n\n{header}{text}\n", encoding="utf-8")
        else:
            path.write_text(f"# Claude memory export\n\n{header}{text}\n", encoding="utf-8")
        return path
