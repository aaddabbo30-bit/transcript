# Third-party notices

Call Assistant does not include third-party source code. It installs and uses
the following open-source packages and models, each under its own license.
Their license texts are installed with them (in `.venv`) or published at the
links below.

| Component | Used for | License |
|---|---|---|
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (SYSTRAN) | local speech-to-text | MIT |
| [CTranslate2](https://github.com/OpenNMT/CTranslate2) (OpenNMT) | Whisper inference engine (installed by faster-whisper) | MIT |
| [Whisper models](https://github.com/openai/whisper) (OpenAI), converted for CTranslate2 by SYSTRAN | speech recognition weights, downloaded from Hugging Face at install time | MIT |
| [Silero VAD](https://github.com/snakers4/silero-vad) | voice activity detection (bundled with faster-whisper) | MIT |
| [PyAudioWPatch](https://github.com/s0d3s/PyAudioWPatch) | microphone and WASAPI loopback capture on Windows | MIT (PyAudio fork; its PyPI metadata lists Apache-2.0) |
| [PortAudio](http://www.portaudio.com/) | audio I/O (bundled with PyAudioWPatch) | MIT-style |
| [Anthropic Python SDK](https://github.com/anthropics/anthropic-sdk-python) | Claude API client | Apache-2.0 |
| [NumPy](https://numpy.org) | audio processing | BSD-3-Clause |
| Python, Tcl/Tk | runtime and window toolkit | PSF License, Tcl/Tk license (BSD-style) |

Design inspiration (no code copied): [ecoute](https://github.com/SevaSk/ecoute)
(MIT) records the microphone and the speaker loopback in parallel and suggests
replies; Call Assistant follows the same capture approach.

The demo transcripts in `samples/` and the test audio in `tests/fixtures/`
(synthesized with SVOX Pico TTS) were created for this project.
