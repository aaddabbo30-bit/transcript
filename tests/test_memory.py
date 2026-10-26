import pytest

from call_assistant.memory import EXPORT_FILE, Memory, MemoryPathError, MemoryUpdate


@pytest.fixture
def memory(tmp_path):
    m = Memory(tmp_path / "memory", "it")
    m.ensure()
    return m


def test_templates_are_copied_but_count_as_empty(memory):
    names = memory.relative_names()
    assert names[:3] == ["about-me.md", "claude-memory-export.md", "interests.md"]
    assert "people/README.md" not in names  # README files are ignored
    text, truncated = memory.load_text()
    assert "empty" in text and not truncated  # headings and comments only


def test_ensure_never_overwrites(memory):
    (memory.root / "about-me.md").write_text("# Chi sono\n\nMi chiamo Andrea.\n", encoding="utf-8")
    memory.ensure()
    assert "Andrea" in (memory.root / "about-me.md").read_text(encoding="utf-8")


def test_load_text_strips_comments_and_is_stable(memory):
    (memory.root / "about-me.md").write_text("# Chi sono\n<!-- nota -->\nMi chiamo Andrea.\n", encoding="utf-8")
    (memory.root / "people").mkdir(exist_ok=True)
    (memory.root / "people" / "Giulia.md").write_text("# Giulia\n\nAmica dal liceo.\n", encoding="utf-8")
    first, _ = memory.load_text()
    assert "nota" not in first
    assert first.index('path="about-me.md"') < first.index('path="people/Giulia.md"')
    assert memory.load_text()[0] == first  # identical text keeps the prompt cache warm


def test_load_text_truncates(memory):
    (memory.root / "about-me.md").write_text("x " * 5000, encoding="utf-8")
    text, truncated = memory.load_text(max_chars=1000)
    assert truncated and len(text) < 1100


@pytest.mark.parametrize(
    "bad",
    ["../evil.md", "/etc/passwd.md", "C:/Windows/x.md", "people/../../x.md", "notes.txt", ".hidden.md", "", "people/.md"],
)
def test_proposed_paths_are_validated(memory, bad):
    with pytest.raises(MemoryPathError):
        memory.resolve(bad)


def test_apply_creates_and_appends(memory):
    path = memory.apply(MemoryUpdate("people/Giulia Bianchi.md", "create", "- Architetta, vive a Bologna."), "call-1")
    assert path == memory.root / "people" / "Giulia Bianchi.md"
    text = path.read_text(encoding="utf-8")
    assert text.startswith("# Giulia Bianchi") and "Architetta" in text and "call-1" in text
    memory.apply(MemoryUpdate("people/Giulia Bianchi.md", "append", "- Festa dei 30 anni il 14/11."))
    text = path.read_text(encoding="utf-8")
    assert text.index("Architetta") < text.index("Festa")
    assert "people/Giulia Bianchi.md" in memory.relative_names()
    assert "Festa dei 30 anni" in memory.load_text()[0]


def test_apply_rejects_empty_content(memory):
    with pytest.raises(ValueError):
        memory.apply(MemoryUpdate("interests.md", "append", "   "))


def test_import_claude_export(memory):
    path = memory.import_claude_export("## Chi sei\n- Ti chiami Andrea\n- Lavori come designer")
    memory.import_claude_export("- Ti piace la montagna")
    text = path.read_text(encoding="utf-8")
    assert path.name == EXPORT_FILE
    assert text.count("## Import ") == 2
    assert "designer" in text and "montagna" in text
    assert "designer" in memory.load_text()[0]
    with pytest.raises(ValueError):
        memory.import_claude_export("  ")
