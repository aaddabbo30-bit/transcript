from __future__ import annotations

from pathlib import Path

import pytest

from call_assistant.config import Paths, Settings

FIXTURES = Path(__file__).parent / "fixtures"
SPEECH_WAV = FIXTURES / "speech_it_en.wav"


@pytest.fixture
def paths(tmp_path: Path) -> Paths:
    return Paths(tmp_path / "home").ensure()


@pytest.fixture
def settings(paths: Paths) -> Settings:
    s = Settings.load(paths.settings_file)
    s.update(insight_interval_seconds=10)
    return s
