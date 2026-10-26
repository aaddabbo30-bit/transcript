"""Colors and fonts for the dark overlay."""

from __future__ import annotations

import sys
import tkinter as tk
import tkinter.font as tkfont
from tkinter import ttk

BG = "#15171c"
PANEL = "#1d2027"
CARD = "#242832"
BORDER = "#323743"
TEXT = "#e9eaee"
MUTED = "#9299a6"
FAINT = "#5d6371"
ACCENT = "#e0a458"
OK = "#5fd38d"
WARN = "#f2c14e"
DANGER = "#ff6b6b"
KIND_COLORS = {"question": "#7cc4ff", "answer": "#7ee0a1", "comment": "#c9a7ff"}
SPEAKER_COLORS = {"me": "#7ee0a1", "them": "#7cc4ff"}

FAMILY = "Segoe UI" if sys.platform == "win32" else "DejaVu Sans"


class Fonts:
    def __init__(self, root: tk.Misc):
        self.base = tkfont.Font(root=root, family=FAMILY, size=10)
        self.small = tkfont.Font(root=root, family=FAMILY, size=9)
        self.section = tkfont.Font(root=root, family=FAMILY, size=8, weight="bold")
        self.topic = tkfont.Font(root=root, family=FAMILY, size=11)
        self.suggestion = tkfont.Font(root=root, family=FAMILY, size=11)
        self.chip = tkfont.Font(root=root, family=FAMILY, size=8, weight="bold")
        self.button = tkfont.Font(root=root, family=FAMILY, size=10, weight="bold")
        self.status = tkfont.Font(root=root, family=FAMILY, size=10, weight="bold")
        self.mono = tkfont.Font(root=root, family="Consolas" if sys.platform == "win32" else "DejaVu Sans Mono", size=9)


def apply_ttk_style(root: tk.Misc, fonts: Fonts) -> None:
    style = ttk.Style(root)
    try:
        style.theme_use("clam")  # the only built-in theme that accepts custom colors everywhere
    except tk.TclError:
        pass
    style.configure("TCombobox", fieldbackground=CARD, background=CARD, foreground=TEXT, arrowcolor=TEXT,
                    bordercolor=BORDER, lightcolor=CARD, darkcolor=CARD, padding=3)
    style.map("TCombobox", fieldbackground=[("readonly", CARD)], foreground=[("readonly", TEXT)],
              selectbackground=[("readonly", CARD)], selectforeground=[("readonly", TEXT)])
    root.option_add("*TCombobox*Listbox.background", CARD)
    root.option_add("*TCombobox*Listbox.foreground", TEXT)
    root.option_add("*TCombobox*Listbox.selectBackground", ACCENT)
    root.option_add("*TCombobox*Listbox.font", fonts.base)
    for name in ("TScrollbar", "Vertical.TScrollbar"):
        style.configure(name, background=BORDER, troughcolor=PANEL, bordercolor=PANEL, arrowcolor=MUTED,
                        lightcolor=BORDER, darkcolor=BORDER, gripcount=0)
        style.map(name, background=[("active", MUTED)])


def button(parent: tk.Misc, text: str, command, fonts: Fonts, kind: str = "normal", **kw) -> tk.Button:
    colors = {
        "normal": (CARD, TEXT, "#2e3340"),
        "primary": (ACCENT, "#1a1a1a", "#eab676"),
        "danger": (DANGER, "#1a1a1a", "#ff8a8a"),
        "ghost": (PANEL, MUTED, CARD),
    }[kind]
    b = tk.Button(
        parent,
        text=text,
        command=command,
        bg=colors[0],
        fg=colors[1],
        activebackground=colors[2],
        activeforeground=colors[1],
        relief="flat",
        bd=0,
        highlightthickness=0,
        padx=10,
        pady=4,
        cursor="hand2",
        font=fonts.button if kind in ("primary", "danger") else fonts.small,
        **kw,
    )
    return b


class Tooltip:
    def __init__(self, widget: tk.Widget, text_fn, fonts: Fonts):
        self.widget = widget
        self.text_fn = text_fn if callable(text_fn) else (lambda: text_fn)
        self.fonts = fonts
        self.tip: tk.Toplevel | None = None
        widget.bind("<Enter>", self.show, add="+")
        widget.bind("<Leave>", self.hide, add="+")

    def show(self, _event=None) -> None:
        text = self.text_fn()
        if not text or self.tip is not None:
            return
        self.tip = tk.Toplevel(self.widget)
        self.tip.wm_overrideredirect(True)
        self.tip.attributes("-topmost", True)
        x = self.widget.winfo_rootx()
        y = self.widget.winfo_rooty() + self.widget.winfo_height() + 4
        self.tip.geometry(f"+{x}+{y}")
        tk.Label(self.tip, text=text, bg=CARD, fg=TEXT, font=self.fonts.small, padx=8, pady=4,
                 justify="left", wraplength=320).pack()

    def hide(self, _event=None) -> None:
        if self.tip is not None:
            self.tip.destroy()
            self.tip = None
