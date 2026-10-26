import json

from call_assistant.config import DEFAULT_SETTINGS, Paths, Settings
from call_assistant.i18n import STRINGS, Translator


def test_defaults_are_written(tmp_path):
    paths = Paths(tmp_path).ensure()
    s = Settings.load(paths.settings_file)
    assert s["insight_model"] == "claude-haiku-5-5"
    assert s["summary_model"] == "claude-opus-5-5"
    on_disk = json.loads(paths.settings_file.read_text(encoding="utf-8"))
    assert set(DEFAULT_SETTINGS) <= set(on_disk)


def test_user_values_survive_and_are_validated(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"whisper_model": "base", "ui_language": "fr", "insight_interval_seconds": 2,
                                "window": {"width": 500}}), encoding="utf-8")
    s = Settings.load(path)
    assert s["whisper_model"] == "base"
    assert s["ui_language"] == "it"  # invalid -> default
    assert s["insight_interval_seconds"] == 10  # clamped
    assert s["window"]["width"] == 500 and s["window"]["topmost"] is True  # deep merge


def test_broken_settings_file_is_kept_aside(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text("{not json", encoding="utf-8")
    s = Settings.load(path)
    assert s["call_language"] == "auto"
    assert (tmp_path / "settings.broken.json").exists()


def test_translations_have_the_same_keys():
    assert set(STRINGS["it"]) == set(STRINGS["en"])
    t = Translator("en")
    assert t("cost", cost="0.010") == "Estimated cost: $0.010"
    assert Translator("xx")("btn_start") == STRINGS["it"]["btn_start"]


def test_settings_saved_with_bom_by_notepad(tmp_path):
    path = tmp_path / "settings.json"
    path.write_bytes(b"\xef\xbb\xbf" + json.dumps({"whisper_model": "medium"}).encode("utf-8"))
    assert Settings.load(path)["whisper_model"] == "medium"
