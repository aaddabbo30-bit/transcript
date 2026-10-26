from call_assistant.transcript import TranscriptLine, TranscriptStore, fmt_time


def test_fmt_time():
    assert fmt_time(0) == "00:00"
    assert fmt_time(75.9) == "01:15"
    assert fmt_time(3725) == "1:02:05"


def test_lines_are_ordered_and_rendered():
    store = TranscriptStore()
    store.add(TranscriptLine(10, "them", "Seconda"))
    store.add(TranscriptLine(5, "me", "Prima"))
    assert [ln.text for ln in store.lines()] == ["Prima", "Seconda"]
    assert store.text() == "[00:05] Me: Prima\n[00:10] Them: Seconda"


def test_new_lines_are_marked():
    store = TranscriptStore()
    store.add(TranscriptLine(1, "them", "vecchia"))
    seq = store.last_seq
    store.add(TranscriptLine(2, "me", "nuova"))
    assert store.text(new_after_seq=seq) == "[00:01] Them: vecchia\n*[00:02] Me: nuova"


def test_echo_from_speakers_is_dropped():
    store = TranscriptStore()
    store.add(TranscriptLine(10.0, "them", "Domani ci vediamo alle otto in piazza"))
    # The microphone heard the same sentence through the speakers.
    assert store.add(TranscriptLine(10.4, "me", "domani ci vediamo alle 8 in piazza")) is None
    assert store.echoes_dropped == 1
    # A real answer from the user is kept.
    assert store.add(TranscriptLine(12.0, "me", "Perfetto, porto anche Marta")) is not None
    assert len(store) == 2


def test_echo_arriving_before_the_original_is_replaced():
    store = TranscriptStore()
    store.add(TranscriptLine(10.2, "me", "Hai visto la partita ieri sera?"))
    store.add(TranscriptLine(10.0, "them", "Hai visto la partita ieri sera"))
    assert [(ln.speaker, ln.text) for ln in store.lines()] == [("them", "Hai visto la partita ieri sera")]


def test_same_words_far_apart_are_not_echo():
    store = TranscriptStore()
    store.add(TranscriptLine(10, "them", "Va bene, ci sentiamo dopo allora"))
    assert store.add(TranscriptLine(60, "me", "Va bene, ci sentiamo dopo allora")) is not None


def test_window_and_word_count():
    store = TranscriptStore()
    for t in range(0, 600, 60):
        store.add(TranscriptLine(t, "them", f"riga al secondo {t}"))
    assert [ln.t for ln in store.window(120)] == [420, 480, 540]
    assert store.word_count() == 40


def test_file_is_written_live_and_rewritten_at_the_end(tmp_path):
    path = tmp_path / "transcript.md"
    store = TranscriptStore(path, {"me": "Io", "them": "Altri"}, "Trascrizione")
    store.add(TranscriptLine(3, "me", "ciao a tutti quanti voi"))
    store.add(TranscriptLine(2, "them", "Ciao a tutti quanti voi"))  # removes the echo above
    live = path.read_text(encoding="utf-8")
    assert live.startswith("# Trascrizione") and "**Io:**" in live
    store.write_file()
    final = path.read_text(encoding="utf-8")
    assert "**Io:**" not in final and "[00:02] **Altri:** Ciao a tutti quanti voi" in final


def test_file_errors_do_not_stop_the_transcript(tmp_path):
    store = TranscriptStore(tmp_path / "missing-folder" / "transcript.md")  # folder does not exist
    assert store.add(TranscriptLine(1, "them", "ciao")) is not None
    assert len(store) == 1
