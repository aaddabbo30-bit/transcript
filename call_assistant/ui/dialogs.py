"""Secondary windows: API key, memory import, memory review, settings."""

from __future__ import annotations

import logging
import tkinter as tk
from tkinter import ttk
from typing import Callable

from ..config import WHISPER_MODELS, Paths, Settings
from ..i18n import Translator
from ..memory import Memory, MemoryPathError, MemoryUpdate
from ..platform_utils import open_path, save_api_key
from . import theme
from .theme import Fonts

log = logging.getLogger(__name__)


class Dialog(tk.Toplevel):
    def __init__(self, parent: tk.Misc, title: str, fonts: Fonts, width: int = 520, height: int = 420):
        super().__init__(parent)
        self.fonts = fonts
        self.title(title)
        self.configure(bg=theme.BG)
        self.attributes("-topmost", True)  # the overlay is topmost: stay above it
        self.transient(parent)
        x = max(0, parent.winfo_rootx() - width - 12)
        y = max(0, parent.winfo_rooty())
        self.geometry(f"{width}x{height}+{x}+{y}")
        self.minsize(380, 260)
        self.bind("<Escape>", lambda e: self.destroy())

    def label(self, parent: tk.Misc, text: str, muted: bool = False, **kw) -> tk.Label:
        return tk.Label(
            parent,
            text=text,
            bg=parent.cget("bg"),
            fg=theme.MUTED if muted else theme.TEXT,
            font=self.fonts.small if muted else self.fonts.base,
            justify="left",
            anchor="w",
            **kw,
        )

    def text_box(self, parent: tk.Misc, height: int = 10) -> tk.Text:
        box = tk.Text(
            parent,
            height=height,
            wrap="word",
            bg=theme.CARD,
            fg=theme.TEXT,
            insertbackground=theme.TEXT,
            relief="flat",
            padx=8,
            pady=6,
            font=self.fonts.base,
            undo=True,
            highlightthickness=1,
            highlightbackground=theme.BORDER,
            highlightcolor=theme.ACCENT,
        )
        return box


class ApiKeyDialog(Dialog):
    """Ask for the Anthropic API key and store it as a user environment variable."""

    def __init__(self, parent: tk.Misc, t: Translator, fonts: Fonts):
        super().__init__(parent, t("key_title"), fonts, width=500, height=250)
        self.t = t
        self.result: str | None = None
        body = tk.Frame(self, bg=theme.BG, padx=16, pady=14)
        body.pack(fill="both", expand=True)
        self.label(body, t("key_text"), wraplength=460).pack(fill="x")
        self.var = tk.StringVar()
        entry = tk.Entry(body, textvariable=self.var, show="•", bg=theme.CARD, fg=theme.TEXT,
                         insertbackground=theme.TEXT, relief="flat", font=self.fonts.base,
                         highlightthickness=1, highlightbackground=theme.BORDER, highlightcolor=theme.ACCENT)
        entry.pack(fill="x", pady=(12, 4), ipady=5)
        entry.focus_set()
        self.error = self.label(body, "", muted=True)
        self.error.configure(fg=theme.WARN)
        self.error.pack(fill="x")
        row = tk.Frame(body, bg=theme.BG)
        row.pack(fill="x", pady=(10, 0))
        theme.button(row, t("key_save"), self._save, fonts, "primary").pack(side="right")
        theme.button(row, t("key_skip"), self.destroy, fonts).pack(side="right", padx=8)
        self.bind("<Return>", lambda e: self._save())

    def _save(self) -> None:
        key = self.var.get().strip()
        if not key.startswith("sk-ant-"):
            self.error.configure(text=self.t("key_invalid"))
            return
        save_api_key(key)
        self.result = key
        self.destroy()


class ImportMemoryDialog(Dialog):
    """Paste the memory exported from claude.ai."""

    def __init__(self, parent: tk.Misc, t: Translator, fonts: Fonts, memory: Memory):
        super().__init__(parent, t("import_title"), fonts, width=560, height=560)
        self.t = t
        self.memory = memory
        body = tk.Frame(self, bg=theme.BG, padx=16, pady=14)
        body.pack(fill="both", expand=True)
        self.label(body, t("import_text"), wraplength=520).pack(fill="x")

        prompt_card = tk.Frame(body, bg=theme.CARD, padx=10, pady=8)
        prompt_card.pack(fill="x", pady=(10, 4))
        tk.Label(prompt_card, text=t("import_prompt"), bg=theme.CARD, fg=theme.ACCENT, font=self.fonts.small,
                 justify="left", anchor="w", wraplength=500).pack(fill="x")
        theme.button(prompt_card, t("import_copy_prompt"), self._copy_prompt, fonts).pack(anchor="e", pady=(6, 0))

        self.box = self.text_box(body, height=12)
        self.box.pack(fill="both", expand=True, pady=(8, 6))
        self.status = self.label(body, "", muted=True)
        self.status.pack(fill="x")
        row = tk.Frame(body, bg=theme.BG)
        row.pack(fill="x", pady=(6, 0))
        theme.button(row, t("import_save"), self._save, fonts, "primary").pack(side="right")
        theme.button(row, t("btn_memory"), lambda: open_path(memory.root), fonts).pack(side="left")

    def _copy_prompt(self) -> None:
        self.clipboard_clear()
        self.clipboard_append(self.t("import_prompt"))
        self.status.configure(text=self.t("copied"), fg=theme.OK)

    def _save(self) -> None:
        text = self.box.get("1.0", "end").strip()
        if not text:
            self.status.configure(text=self.t("import_empty"), fg=theme.WARN)
            return
        path = self.memory.import_claude_export(text)
        self.box.delete("1.0", "end")
        self.status.configure(text=self.t("import_done", path=path), fg=theme.OK)


class MemoryReviewDialog(Dialog):
    """Show Claude's proposed memory additions; apply only the ticked ones."""

    def __init__(
        self,
        parent: tk.Misc,
        t: Translator,
        fonts: Fonts,
        memory: Memory,
        proposals: list[MemoryUpdate],
        source: str = "",
        on_applied: Callable[[list[MemoryUpdate]], None] | None = None,
    ):
        super().__init__(parent, t("review_title"), fonts, width=580, height=600)
        self.t = t
        self.memory = memory
        self.source = source
        self.on_applied = on_applied
        self.rows: list[tuple[MemoryUpdate, tk.BooleanVar, tk.Text]] = []

        top = tk.Frame(self, bg=theme.BG, padx=16, pady=12)
        top.pack(fill="x")
        self.label(top, t("review_text"), wraplength=540).pack(fill="x")

        # Scrollable list of proposals.
        outer = tk.Frame(self, bg=theme.BG)
        outer.pack(fill="both", expand=True, padx=16)
        canvas = tk.Canvas(outer, bg=theme.BG, highlightthickness=0)
        scroll = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        inner = tk.Frame(canvas, bg=theme.BG)
        inner.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        window = canvas.create_window((0, 0), window=inner, anchor="nw")
        canvas.bind("<Configure>", lambda e: canvas.itemconfigure(window, width=e.width))
        canvas.configure(yscrollcommand=scroll.set)
        canvas.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")

        existing = {name.lower() for name in memory.relative_names()}
        for proposal in proposals:
            card = tk.Frame(inner, bg=theme.CARD, padx=10, pady=8)
            card.pack(fill="x", pady=5)
            var = tk.BooleanVar(value=True)
            is_new = proposal.file.replace("\\", "/").lower() not in existing
            header = proposal.file + (f"   ({t('review_new_file')})" if is_new else "")
            tk.Checkbutton(card, text=header, variable=var, bg=theme.CARD, fg=theme.ACCENT,
                           selectcolor=theme.PANEL, activebackground=theme.CARD, activeforeground=theme.ACCENT,
                           font=self.fonts.button, anchor="w", highlightthickness=0, bd=0).pack(fill="x")
            if proposal.reason:
                tk.Label(card, text=proposal.reason, bg=theme.CARD, fg=theme.MUTED, font=self.fonts.small,
                         justify="left", anchor="w", wraplength=500).pack(fill="x")
            lines = proposal.content.count("\n") + 1
            box = self.text_box(card, height=min(8, max(2, lines + 1)))
            box.configure(bg=theme.PANEL)
            box.insert("1.0", proposal.content.strip())
            box.pack(fill="x", pady=(6, 0))
            self.rows.append((proposal, var, box))

        bottom = tk.Frame(self, bg=theme.BG, padx=16, pady=12)
        bottom.pack(fill="x")
        self.status = self.label(bottom, "", muted=True)
        self.status.pack(side="left")
        theme.button(bottom, t("review_apply"), self._apply, fonts, "primary").pack(side="right")
        theme.button(bottom, t("review_ignore"), self.destroy, fonts).pack(side="right", padx=8)

    def _apply(self) -> None:
        applied: list[MemoryUpdate] = []
        errors = []
        for proposal, var, box in self.rows:
            if not var.get():
                continue
            proposal.content = box.get("1.0", "end").strip()
            try:
                self.memory.apply(proposal, self.source)
                applied.append(proposal)
            except (MemoryPathError, ValueError, OSError) as exc:
                log.warning("Memory proposal rejected: %s", exc)
                errors.append(f"{proposal.file}: {exc}")
        if self.on_applied:
            self.on_applied(applied)
        if errors:
            self.status.configure(text="; ".join(errors), fg=theme.WARN)
            return
        self.destroy()


class SettingsDialog(Dialog):
    def __init__(
        self,
        parent: tk.Misc,
        t: Translator,
        fonts: Fonts,
        settings: Settings,
        paths: Paths,
        on_saved: Callable[[], None],
    ):
        super().__init__(parent, t("settings_title"), fonts, width=470, height=520)
        self.t = t
        self.settings = settings
        self.on_saved = on_saved
        body = tk.Frame(self, bg=theme.BG, padx=16, pady=14)
        body.pack(fill="both", expand=True)

        def row(label: str) -> tk.Frame:
            self.label(body, label, muted=True).pack(fill="x", pady=(8, 2))
            frame = tk.Frame(body, bg=theme.BG)
            frame.pack(fill="x")
            return frame

        self.ui_lang = tk.StringVar(value=settings["ui_language"])
        ttk.Combobox(row(t("settings_ui_language")), textvariable=self.ui_lang, values=["it", "en"],
                     state="readonly", width=10).pack(side="left")

        self.whisper = tk.StringVar(value=settings["whisper_model"])
        frame = row(t("settings_whisper"))
        ttk.Combobox(frame, textvariable=self.whisper, values=WHISPER_MODELS, state="readonly",
                     width=16).pack(side="left")
        self.label(body, t("settings_whisper_hint"), muted=True).pack(fill="x")

        self.interval = tk.IntVar(value=settings["insight_interval_seconds"])
        tk.Spinbox(row(t("settings_interval")), from_=15, to=60, increment=5, textvariable=self.interval,
                   width=6, bg=theme.CARD, fg=theme.TEXT, buttonbackground=theme.CARD, relief="flat",
                   insertbackground=theme.TEXT, font=self.fonts.base).pack(side="left")

        self.mic = tk.BooleanVar(value=settings["capture_microphone"])
        self.system = tk.BooleanVar(value=settings["capture_system_audio"])
        for text, var in ((t("settings_mic"), self.mic), (t("settings_system"), self.system)):
            tk.Checkbutton(body, text=text, variable=var, bg=theme.BG, fg=theme.TEXT, selectcolor=theme.CARD,
                           activebackground=theme.BG, activeforeground=theme.TEXT, font=self.fonts.base,
                           anchor="w", highlightthickness=0, bd=0).pack(fill="x", pady=(8, 0))

        self.mic_device = tk.StringVar(value=settings["microphone_device"])
        self.speaker_device = tk.StringVar(value=settings["speaker_device"])
        for text, var in ((t("settings_mic_device"), self.mic_device), (t("settings_speaker_device"), self.speaker_device)):
            tk.Entry(row(text), textvariable=var, bg=theme.CARD, fg=theme.TEXT, insertbackground=theme.TEXT,
                     relief="flat", font=self.fonts.base, highlightthickness=1, highlightbackground=theme.BORDER,
                     highlightcolor=theme.ACCENT).pack(fill="x", ipady=3)

        self.status = self.label(body, "", muted=True)
        self.status.pack(fill="x", pady=(10, 0))
        buttons = tk.Frame(body, bg=theme.BG)
        buttons.pack(fill="x", side="bottom")
        theme.button(buttons, t("settings_save"), self._save, fonts, "primary").pack(side="right")
        theme.button(buttons, t("settings_api_key"), lambda: ApiKeyDialog(self, t, fonts), fonts).pack(side="left")
        theme.button(buttons, t("settings_open_folder"), lambda: open_path(paths.home), fonts).pack(side="left", padx=8)

    def _save(self) -> None:
        try:
            interval = int(self.interval.get())
        except (tk.TclError, ValueError):
            interval = 25
        self.settings.update(
            ui_language=self.ui_lang.get(),
            whisper_model=self.whisper.get(),
            insight_interval_seconds=interval,
            capture_microphone=bool(self.mic.get()),
            capture_system_audio=bool(self.system.get()),
            microphone_device=self.mic_device.get().strip(),
            speaker_device=self.speaker_device.get().strip(),
        )
        self.status.configure(text=self.t("settings_saved_restart"), fg=theme.OK)
        self.on_saved()
