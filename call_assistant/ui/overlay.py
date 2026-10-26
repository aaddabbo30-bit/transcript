"""The small always-on-top window shown during a call."""

from __future__ import annotations

import logging
import queue
import time
import tkinter as tk
from tkinter import messagebox, ttk
from typing import Callable

from ..config import Paths, Settings
from ..i18n import Translator
from ..insights import Insight
from ..memory import Memory, MemoryUpdate
from ..platform_utils import open_path
from ..session import CallSession
from ..summary import SummaryResult, record_applied
from ..transcript import TranscriptLine, fmt_time
from . import theme
from .dialogs import ApiKeyDialog, ImportMemoryDialog, MemoryReviewDialog, SettingsDialog
from .theme import Fonts, Tooltip

log = logging.getLogger(__name__)

LANG_CODES = ["auto", "it", "en"]
MAX_TRANSCRIPT_LINES = 300


def format_cost(usd: float) -> str:
    return f"${usd:.4f}" if usd < 1 else f"${usd:.2f}"


class Overlay:
    def __init__(
        self,
        root: tk.Tk,
        *,
        settings: Settings,
        paths: Paths,
        make_session: Callable[[queue.Queue], CallSession],
        on_api_key_saved: Callable[[], None] = lambda: None,
        subtitle: str = "",
    ):
        self.root = root
        self.settings = settings
        self.paths = paths
        self.make_session = make_session
        self.on_api_key_saved = on_api_key_saved
        self.t = Translator(settings["ui_language"])
        self.events: queue.Queue = queue.Queue()
        self.session: CallSession | None = None
        self._quit_when_done = False
        self._review_open = False
        self._wrap_labels: list[tk.Label] = []
        self._insight_pending = False
        self._copied_until = 0.0
        self.last_copied = ""
        self.fonts = Fonts(root)
        theme.apply_ttk_style(root, self.fonts)
        self._build_window(subtitle)
        self._build()
        self.show_waiting()
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.after(150, self._poll)
        root.after(1000, self._tick)

    # ------------------------------------------------------------------ layout
    def _build_window(self, subtitle: str) -> None:
        w = self.settings["window"]
        root = self.root
        title = self.t("app_title") + (f" · {subtitle}" if subtitle else "")
        root.title(title)
        root.configure(bg=theme.BG)
        # Fonts scale with Windows display scaling; the window size must too.
        scale = max(1.0, root.winfo_fpixels("1i") / 96.0)
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        x, y = w.get("x"), w.get("y")
        if x is None or y is None or not (0 <= x < sw - 50) or not (0 <= y < sh - 50):
            width = int((w.get("width") or 400) * scale)
            height = int(min(sh - 120, (w.get("height") or 700) * scale))
            x, y = max(0, sw - width - 24), 48
        else:
            width, height = int(w["width"]), int(w["height"])
        root.geometry(f"{width}x{height}+{x}+{y}")
        root.minsize(int(320 * scale), int(420 * scale))
        root.attributes("-topmost", bool(w.get("topmost", True)))
        try:
            root.attributes("-alpha", float(w.get("alpha", 0.96)))
        except tk.TclError:
            pass

    def _section(self, parent: tk.Misc, text: str, hint: str = "") -> tk.Frame:
        head = tk.Frame(parent, bg=parent.cget("bg"))
        head.pack(fill="x", pady=(8, 3))
        tk.Label(head, text=text, bg=parent.cget("bg"), fg=theme.MUTED, font=self.fonts.section).pack(side="left")
        if hint:
            tk.Label(head, text=hint, bg=parent.cget("bg"), fg=theme.FAINT, font=self.fonts.small).pack(side="right")
        return head

    def _wrap_label(self, parent: tk.Misc, **kw) -> tk.Label:
        label = tk.Label(parent, bg=parent.cget("bg"), fg=theme.TEXT, justify="left", anchor="w",
                         wraplength=self._wrap_width, **kw)
        self._wrap_labels.append(label)
        return label

    def _build(self) -> None:
        t, f = self.t, self.fonts
        root = self.root
        self._wrap_width = max(200, int(root.geometry().split("x")[0]) - 56)

        # Packing order matters: header, controls, bottom bar and transcript get
        # their space first; the insights area takes the rest (and is clipped
        # rather than hiding the buttons when the window is small).

        # Header: status, timer, cost, pin, settings
        header = tk.Frame(root, bg=theme.PANEL, padx=10, pady=6)
        header.pack(fill="x")
        self.status_dot = tk.Label(header, text="●", bg=theme.PANEL, fg=theme.MUTED, font=f.status)
        self.status_dot.pack(side="left")
        self.status_label = tk.Label(header, text=t("status_ready"), bg=theme.PANEL, fg=theme.TEXT, font=f.status)
        self.status_label.pack(side="left", padx=(4, 8))
        self.timer_label = tk.Label(header, text="00:00", bg=theme.PANEL, fg=theme.MUTED, font=f.base)
        self.timer_label.pack(side="left")
        self.settings_btn = theme.button(header, "⚙", self.open_settings, f, "ghost")
        self.settings_btn.pack(side="right")
        Tooltip(self.settings_btn, t("tip_settings"), f)
        self.pin_btn = theme.button(header, "◆", self.toggle_pin, f, "ghost")
        self.pin_btn.pack(side="right")
        Tooltip(self.pin_btn, t("tip_pin"), f)
        self.cost_label = tk.Label(header, text=format_cost(0), bg=theme.PANEL, fg=theme.MUTED, font=f.small)
        self.cost_label.pack(side="right", padx=4)
        Tooltip(self.cost_label, self._cost_tooltip, f)
        self._update_pin()

        # Controls: language + start/stop
        controls = tk.Frame(root, bg=theme.BG, padx=10, pady=8)
        controls.pack(fill="x")
        self._controls = controls
        tk.Label(controls, text=t("language"), bg=theme.BG, fg=theme.MUTED, font=f.small).pack(side="left")
        self.lang_var = tk.StringVar()
        names = [t("lang_auto"), t("lang_it"), t("lang_en")]
        self.lang_box = ttk.Combobox(controls, textvariable=self.lang_var, values=names, state="readonly", width=20)
        current = self.settings["call_language"]
        self.lang_box.current(LANG_CODES.index(current) if current in LANG_CODES else 0)
        self.lang_box.bind("<<ComboboxSelected>>", self._on_language)
        self.lang_box.pack(side="left", padx=6)
        self.start_btn = theme.button(controls, t("btn_start"), self.toggle_call, f, "primary")
        self.start_btn.pack(side="right")

        # Notices (warnings / errors), shown under the controls when needed
        self.notice = tk.Label(root, text="", bg=theme.BG, fg=theme.WARN, font=f.small, justify="left",
                               anchor="w", padx=12)
        self._wrap_labels.append(self.notice)

        # Bottom bar
        bottom = tk.Frame(root, bg=theme.PANEL, padx=8, pady=6)
        bottom.pack(fill="x", side="bottom")
        theme.button(bottom, t("btn_memory"), lambda: open_path(self.paths.memory), f).pack(side="left")
        theme.button(bottom, t("btn_import"), self.open_import, f).pack(side="left", padx=6)
        theme.button(bottom, t("btn_calls"), lambda: open_path(self.paths.calls), f).pack(side="right")

        # Transcript (fixed height, can be collapsed)
        tr = tk.Frame(root, bg=theme.BG, padx=12)
        tr.pack(fill="x", side="bottom", pady=(0, 8))
        self._transcript_frame = tr
        head = self._section(tr, t("sec_transcript"))
        self.transcript_toggle = tk.Label(head, text="", bg=theme.BG, fg=theme.MUTED, font=f.small, cursor="hand2")
        self.transcript_toggle.pack(side="right")
        self.transcript_toggle.bind("<Button-1>", lambda e: self.toggle_transcript())
        self.transcript_holder = tk.Frame(tr, bg=theme.PANEL)
        self.transcript = tk.Text(self.transcript_holder, wrap="word", bg=theme.PANEL, fg=theme.TEXT, relief="flat",
                                  height=5, padx=8, pady=6, font=f.small, state="disabled", cursor="arrow",
                                  highlightthickness=0)
        scroll = ttk.Scrollbar(self.transcript_holder, orient="vertical", command=self.transcript.yview)
        self.transcript.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        self.transcript.pack(side="left", fill="both", expand=True)
        self.transcript.tag_configure("time", foreground=theme.MUTED)
        for speaker, color in theme.SPEAKER_COLORS.items():
            self.transcript.tag_configure(speaker, foreground=color, font=self.fonts.chip)
        self._apply_transcript_visibility()

        # Summary panel (shown above the transcript after Stop)
        self.summary_panel = tk.Frame(root, bg=theme.CARD, padx=12, pady=10)
        self.summary_title = tk.Label(self.summary_panel, text="", bg=theme.CARD, fg=theme.TEXT, font=f.button,
                                      justify="left", anchor="w")
        self._wrap_labels.append(self.summary_title)
        self.summary_title.pack(fill="x")
        self.summary_buttons = tk.Frame(self.summary_panel, bg=theme.CARD)
        self.summary_buttons.pack(fill="x", pady=(6, 0))

        # Insights: everything else
        body = tk.Frame(root, bg=theme.BG, padx=12)
        body.pack(fill="both", expand=True)
        head = self._section(body, t("sec_topic"))
        self.refresh_btn = tk.Label(head, text="↻", bg=theme.BG, fg=theme.MUTED, font=f.base, cursor="hand2")
        self.refresh_btn.pack(side="right", padx=(6, 0))
        self.refresh_btn.bind("<Button-1>", lambda e: self.refresh_now())
        Tooltip(self.refresh_btn, t("btn_refresh"), f)
        self.countdown = tk.Label(head, text="", bg=theme.BG, fg=theme.MUTED, font=f.small)
        self.countdown.pack(side="right")
        self.topic = self._wrap_label(body, font=f.topic)
        self.topic.pack(fill="x")
        self._section(body, t("sec_suggestions"), t("click_to_copy"))
        self.suggestions = tk.Frame(body, bg=theme.BG)
        self.suggestions.pack(fill="x")
        self._section(body, t("sec_remember"))
        self.remember = tk.Frame(body, bg=theme.BG)
        self.remember.pack(fill="x")

        self._body = body
        root.bind("<Configure>", self._on_resize, add="+")

    def toggle_transcript(self) -> None:
        w = self.settings["window"]
        w["show_transcript"] = not w.get("show_transcript", True)
        self.settings.update(window=w)
        self._apply_transcript_visibility()

    def _apply_transcript_visibility(self) -> None:
        shown = self.settings["window"].get("show_transcript", True)
        self.transcript_toggle.configure(text="▾" if shown else "▸")
        if shown:
            self.transcript_holder.pack(fill="both", expand=True)
        else:
            self.transcript_holder.pack_forget()

    def _on_resize(self, event: tk.Event) -> None:
        if event.widget is not self.root:
            return
        width = max(200, event.width - 56)
        if width == self._wrap_width:
            return
        self._wrap_width = width
        for label in self._wrap_labels:
            try:
                label.configure(wraplength=width)
            except tk.TclError:
                pass

    # ----------------------------------------------------------------- content
    def show_waiting(self) -> None:
        self.topic.configure(text=self.t("waiting_first", s=self.settings["insight_interval_seconds"]),
                             fg=theme.MUTED)
        self._set_suggestions([])
        self._set_remember([])

    def _set_suggestions(self, suggestions) -> None:
        for child in self.suggestions.winfo_children():
            child.destroy()
        self._wrap_labels = [w for w in self._wrap_labels if w.winfo_exists()]
        for s in suggestions:
            row = tk.Frame(self.suggestions, bg=theme.CARD, padx=8, pady=6, cursor="hand2")
            row.pack(fill="x", pady=2)
            color = theme.KIND_COLORS.get(s.kind, theme.TEXT)
            chip = tk.Label(row, text=self.t(f"kind_{s.kind}").upper() if s.kind in theme.KIND_COLORS else s.kind,
                            bg=theme.CARD, fg=color, font=self.fonts.chip, anchor="w")
            chip.pack(fill="x")
            text = self._wrap_label(row, text=s.text, font=self.fonts.suggestion)
            text.configure(bg=theme.CARD)
            text.pack(fill="x")
            for widget in (row, chip, text):
                widget.bind("<Button-1>", lambda e, value=s.text: self.copy(value))

    def _set_remember(self, items: list[str]) -> None:
        for child in self.remember.winfo_children():
            child.destroy()
        self._wrap_labels = [w for w in self._wrap_labels if w.winfo_exists()]
        for item in items:
            label = self._wrap_label(self.remember, text=f"•  {item}", font=self.fonts.base)
            label.pack(fill="x", pady=1)

    def show_insight(self, insight: Insight) -> None:
        self.topic.configure(text=insight.topic or "—", fg=theme.TEXT)
        self._set_suggestions(insight.suggestions)
        self._set_remember(insight.remember)

    def add_transcript_line(self, line: TranscriptLine) -> None:
        tr = self.transcript
        at_end = tr.yview()[1] > 0.98
        label = self.t("speaker_me") if line.speaker == "me" else self.t("speaker_them")
        tr.configure(state="normal")
        tr.insert("end", f"{fmt_time(line.t)} ", "time")
        tr.insert("end", f"{label}: ", line.speaker)
        tr.insert("end", line.text + "\n")
        lines = int(tr.index("end-1c").split(".")[0])
        if lines > MAX_TRANSCRIPT_LINES:
            tr.delete("1.0", f"{lines - MAX_TRANSCRIPT_LINES}.0")
        tr.configure(state="disabled")
        if at_end:
            tr.see("end")

    def set_notice(self, text: str, color: str = theme.WARN) -> None:
        if text:
            self.notice.configure(text=text, fg=color)
            if not self.notice.winfo_ismapped():
                self.notice.pack(fill="x", after=self._controls)
        else:
            self.notice.pack_forget()

    def set_status(self, state: str) -> None:
        mapping = {
            "ready": ("status_ready", theme.MUTED),
            "loading": ("status_loading_model", theme.WARN),
            "listening": ("status_listening", theme.OK),
            "stopping": ("status_stopping", theme.ACCENT),
            "summarizing": ("status_summarizing", theme.ACCENT),
            "done": ("status_done", theme.MUTED),
            "error": ("status_error", theme.DANGER),
        }
        key, color = mapping.get(state, ("status_ready", theme.MUTED))
        self.status_label.configure(text=self.t(key))
        self.status_dot.configure(fg=color)

    def copy(self, text: str, attempt: int = 0) -> None:
        try:
            self.root.clipboard_clear()
            self.root.clipboard_append(text)
        except tk.TclError:
            # On Windows another program can hold the clipboard for a moment: retry shortly.
            if attempt < 3:
                self.root.after(80, self.copy, text, attempt + 1)
            else:
                log.warning("Clipboard busy: could not copy the suggestion")
            return
        self.last_copied = text
        self._copied_until = time.monotonic() + 2.5
        self.countdown.configure(text=self.t("copied"), fg=theme.OK)

    def _cost_tooltip(self) -> str:
        by = self.session.costs.by_purpose if self.session else {}
        total = sum(by.values())
        return self.t("cost", cost=f"{total:.4f}") + "\n" + self.t(
            "cost_tip", live=f"${by.get('live', 0):.4f}", summary=f"${by.get('summary', 0):.4f}")

    # ----------------------------------------------------------------- actions
    def toggle_call(self) -> None:
        if self.session is not None and self.session.running and not self.session.done.is_set():
            self.stop_call()
        else:
            self.start_call()

    def start_call(self) -> None:
        self.summary_panel.pack_forget()
        self.set_notice("")
        self.transcript.configure(state="normal")
        self.transcript.delete("1.0", "end")
        self.transcript.configure(state="disabled")
        self.show_waiting()
        self.topic.configure(text=self.t("waiting_more"))
        self.cost_label.configure(text=format_cost(0))
        self.events = queue.Queue()
        try:
            self.session = self.make_session(self.events)
            self.session.set_language(LANG_CODES[self.lang_box.current()])
            self.session.start()
        except Exception as exc:
            log.exception("Could not start the call")
            self.set_status("error")
            self.set_notice(str(exc), theme.DANGER)
            self.session = None
            return
        self.start_btn.configure(text=self.t("btn_stop"), bg=theme.DANGER, activebackground="#ff8a8a")

    def stop_call(self) -> None:
        if self.session is None:
            return
        self.start_btn.configure(state="disabled")
        self.session.stop()

    def refresh_now(self) -> None:
        if self.session is not None and self.session.running:
            self.session.request_insight()

    def toggle_pin(self) -> None:
        w = self.settings["window"]
        w["topmost"] = not w.get("topmost", True)
        self.settings.update(window=w)
        self.root.attributes("-topmost", w["topmost"])
        self._update_pin()

    def _update_pin(self) -> None:
        on = self.settings["window"].get("topmost", True)
        self.pin_btn.configure(fg=theme.ACCENT if on else theme.MUTED)

    def _on_language(self, _event=None) -> None:
        code = LANG_CODES[self.lang_box.current()]
        self.settings.update(call_language=code)
        if self.session is not None:
            self.session.set_language(code)

    def open_settings(self) -> None:
        SettingsDialog(self.root, self.t, self.fonts, self.settings, self.paths, self.on_api_key_saved)

    def open_import(self) -> None:
        memory = Memory(self.paths.memory, self.settings["ui_language"])
        memory.ensure()
        ImportMemoryDialog(self.root, self.t, self.fonts, memory)

    def ask_api_key(self) -> None:
        dialog = ApiKeyDialog(self.root, self.t, self.fonts)
        self.root.wait_window(dialog)
        if dialog.result:
            self.on_api_key_saved()

    # ------------------------------------------------------------------ events
    def _poll(self) -> None:
        try:
            for _ in range(100):
                kind, payload = self.events.get_nowait()
                self.handle(kind, payload)
        except queue.Empty:
            pass
        except Exception:
            log.exception("UI event failed")
        self.root.after(150, self._poll)

    def handle(self, kind: str, payload) -> None:
        if kind == "status":
            self.set_status(payload)
            if payload in ("stopping", "summarizing", "done"):
                self.countdown.configure(text="")
            if payload == "done":
                self.start_btn.configure(text=self.t("btn_start"), bg=theme.ACCENT, activebackground="#eab676",
                                         state="normal")
                if self._quit_when_done and not self._review_open:
                    self._quit()
        elif kind == "transcript":
            self.add_transcript_line(payload)
        elif kind == "insight":
            self._insight_pending = False
            self.show_insight(payload)
        elif kind == "insight_pending":
            self._insight_pending = True
        elif kind == "insight_error":
            self._insight_pending = False
            self.set_notice(str(payload))
        elif kind == "cost":
            self.cost_label.configure(text=format_cost(payload))
        elif kind == "audio":
            self.set_notice(self.t("audio_opened", devices=payload), theme.MUTED)
        elif kind == "warning":
            self.set_notice(str(payload))
        elif kind == "error":
            self.set_status("error")
            self.set_notice(str(payload), theme.DANGER)
        elif kind == "summary":
            self.show_summary(payload)

    def show_summary(self, result: SummaryResult) -> None:
        for child in self.summary_buttons.winfo_children():
            child.destroy()
        title = f"{self.t('sec_summary')}: {result.title}"
        if result.error:
            title += f"\n{self.t('summary_failed', error=result.error)}"
        self.summary_title.configure(text=title)
        theme.button(self.summary_buttons, self.t("btn_open_summary"), lambda: open_path(result.summary_file),
                     self.fonts).pack(side="left")
        if result.proposals:
            theme.button(self.summary_buttons, self.t("btn_review_memory"), lambda: self.review_memory(result),
                         self.fonts).pack(side="left", padx=6)
        self.summary_panel.pack(fill="x", side="bottom", padx=12, pady=(0, 8), after=self._transcript_frame)
        if result.data.get("key_points"):
            self._set_remember(list(result.data["key_points"])[:6])
        if result.proposals:
            self.review_memory(result)

    def review_memory(self, result: SummaryResult) -> None:
        if self._review_open:
            return
        self._review_open = True
        memory = Memory(self.paths.memory, self.settings["ui_language"])

        def applied(updates: list[MemoryUpdate]) -> None:
            record_applied(result.call_dir, updates)
            if updates:
                self.set_notice(self.t("review_done", n=len(updates)), theme.OK)

        dialog = MemoryReviewDialog(self.root, self.t, self.fonts, memory, result.proposals,
                                    source=result.call_dir.name, on_applied=applied)

        def closed(_event=None) -> None:
            if _event is not None and _event.widget is not dialog:
                return
            self._review_open = False
            if self._quit_when_done:
                self._quit()

        dialog.bind("<Destroy>", closed, add="+")

    def _tick(self) -> None:
        s = self.session
        if s is not None and s.running and not s.stopping:
            self.timer_label.configure(text=fmt_time(s.elapsed()))
            remaining = s.next_insight_in()
            if remaining is None:
                text = ""
            elif self._insight_pending or remaining <= 0:
                text = self.t("updating") if s.insights and s.insights.has_news() else ""
            else:
                text = self.t("next_update", s=int(remaining))
            if time.monotonic() > self._copied_until:
                self.countdown.configure(text=text, fg=theme.MUTED)
        self.root.after(1000, self._tick)

    # ------------------------------------------------------------------- close
    def on_close(self) -> None:
        s = self.session
        if s is not None and not s.done.is_set() and (s.running or s.stopping):
            # Never close while the transcript and summary are being written.
            if not s.stopping:
                if not messagebox.askyesno(self.t("confirm_quit_title"), self.t("confirm_quit"), parent=self.root):
                    return
                self.stop_call()
            self._quit_when_done = True
            return
        self._quit()

    def _quit(self) -> None:
        try:
            w = self.settings["window"]
            w.update(x=self.root.winfo_x(), y=self.root.winfo_y(),
                     width=self.root.winfo_width(), height=self.root.winfo_height())
            self.settings.update(window=w)
        except tk.TclError:
            pass
        self.root.destroy()
