"""User interface strings (Italian and English)."""

from __future__ import annotations

STRINGS: dict[str, dict[str, str]] = {
    "it": {
        "app_title": "Assistente chiamate",
        "status_ready": "Pronto",
        "status_loading_model": "Preparo la trascrizione…",
        "status_listening": "In ascolto",
        "status_stopping": "Chiudo la chiamata…",
        "status_summarizing": "Preparo il riassunto…",
        "status_done": "Riassunto salvato",
        "status_error": "Errore",
        "btn_start": "▶  Avvia",
        "btn_stop": "■  Stop",
        "btn_refresh": "↻ Aggiorna ora",
        "btn_memory": "Memoria",
        "btn_import": "Importa memoria Claude",
        "btn_calls": "Chiamate",
        "btn_open_summary": "Apri riassunto",
        "btn_review_memory": "Rivedi proposte memoria",
        "tip_settings": "Impostazioni",
        "tip_pin": "Sempre in primo piano",
        "language": "Lingua",
        "lang_auto": "Auto (italiano + inglese)",
        "lang_it": "Italiano",
        "lang_en": "English",
        "sec_topic": "DI COSA SI PARLA",
        "sec_suggestions": "POTRESTI DIRE",
        "sec_remember": "DA RICORDARE",
        "sec_transcript": "TRASCRIZIONE",
        "sec_summary": "RIASSUNTO DELLA CHIAMATA",
        "click_to_copy": "clic per copiare",
        "copied": "Copiato negli appunti",
        "kind_question": "Domanda",
        "kind_answer": "Risposta",
        "kind_comment": "Commento",
        "speaker_me": "Io",
        "speaker_them": "Altri",
        "waiting_first": "Premi Avvia all'inizio della chiamata. I suggerimenti arrivano dopo circa {s} secondi di conversazione.",
        "waiting_more": "Sto ascoltando… primi suggerimenti tra poco.",
        "next_update": "aggiorno tra {s}s",
        "updating": "aggiorno…",
        "cost": "Costo stimato: ${cost}",
        "cost_tip": "Stima basata sui token usati: live {live}, riassunto {summary}",
        "no_api_key": "Chiave API mancante: la trascrizione funziona, i suggerimenti no. Apri ⚙ per inserirla.",
        "backlog": "Il PC fatica a trascrivere in tempo reale ({n} blocchi in coda). Prova il modello 'base' nelle impostazioni.",
        "audio_opened": "Audio: {devices}",
        "audio_none": "Nessuna sorgente audio attiva: controlla microfono e impostazioni.",
        "no_system_audio": "Sento il tuo microfono ma non l'audio del PC: forse la chiamata esce da un altro dispositivo (es. cuffie Bluetooth «Vivavoce»). Rendilo il dispositivo predefinito di Windows o indicalo in ⚙ Impostazioni → Uscita audio.",
        "summary_failed": "Riassunto non riuscito: {error}. Trascrizione salvata comunque.",
        "memory_truncated": "La memoria è molto lunga: ne uso solo una parte ({chars} caratteri).",
        "insight_error": "Suggerimenti in pausa: {error}",
        "confirm_quit_title": "Chiamata in corso",
        "confirm_quit": "C'è una chiamata in corso. Fermarla, salvare il riassunto e chiudere?",
        # API key dialog
        "key_title": "Chiave API Anthropic",
        "key_text": "Incolla la tua chiave API Anthropic (inizia con sk-ant-).\nLa trovi su console.anthropic.com → API Keys.\nViene salvata come variabile d'ambiente di Windows (ANTHROPIC_API_KEY), mai nei file del programma.",
        "key_save": "Salva",
        "key_skip": "Continua senza",
        "key_invalid": "La chiave dovrebbe iniziare con sk-ant-",
        # Import dialog
        "import_title": "Importa la memoria di Claude",
        "import_text": (
            "La memoria di claude.ai non è accessibile da altri programmi, quindi la copi tu:\n"
            "1. Apri claude.ai e avvia una nuova chat.\n"
            "2. Incolla la richiesta qui sotto (pulsante «Copia richiesta»).\n"
            "3. Copia la risposta di Claude e incollala nel riquadro grande.\n"
            "Viene salvata in memory/claude-memory-export.md e usata come contesto."
        ),
        "import_prompt": (
            "Scrivi in Markdown tutto quello che ricordi di me dalla tua memoria e dalle nostre chat passate: "
            "chi sono, lavoro, progetti, persone importanti nella mia vita (con nome e ruolo), interessi, "
            "preferenze e modo di comunicare. Usa titoli e punti elenco, niente commenti extra."
        ),
        "import_copy_prompt": "Copia richiesta",
        "import_save": "Salva nella memoria",
        "import_empty": "Il testo è vuoto.",
        "import_done": "Salvato in {path}",
        # Memory review dialog
        "review_title": "Proposte per la tua memoria",
        "review_text": "Claude propone di aggiungere queste informazioni alla tua memoria. Spunta quelle da tenere, modifica il testo se vuoi, poi salva.",
        "review_new_file": "nuovo file",
        "review_apply": "Salva selezionate",
        "review_ignore": "Ignora",
        "review_done": "Memoria aggiornata: {n} file.",
        "review_none": "Nessuna proposta per la memoria in questa chiamata.",
        # Settings dialog
        "settings_title": "Impostazioni",
        "settings_ui_language": "Lingua dell'interfaccia",
        "settings_whisper": "Modello di trascrizione",
        "settings_whisper_hint": "tiny/base = PC lenti · small = consigliato · medium/large = PC potenti",
        "settings_interval": "Aggiornamento suggerimenti (secondi)",
        "settings_mic": "Ascolta il mio microfono",
        "settings_system": "Ascolta l'audio del PC",
        "settings_mic_device": "Microfono (parte del nome, vuoto = predefinito)",
        "settings_speaker_device": "Uscita audio (parte del nome, vuoto = predefinita)",
        "settings_api_key": "Chiave API…",
        "settings_open_folder": "Apri cartella dati",
        "settings_save": "Salva",
        "settings_saved_restart": "Salvato. Alcune modifiche valgono dalla prossima chiamata o al riavvio.",
    },
    "en": {
        "app_title": "Call Assistant",
        "status_ready": "Ready",
        "status_loading_model": "Loading speech model…",
        "status_listening": "Listening",
        "status_stopping": "Stopping the call…",
        "status_summarizing": "Writing the summary…",
        "status_done": "Summary saved",
        "status_error": "Error",
        "btn_start": "▶  Start",
        "btn_stop": "■  Stop",
        "btn_refresh": "↻ Refresh now",
        "btn_memory": "Memory",
        "btn_import": "Import Claude memory",
        "btn_calls": "Calls",
        "btn_open_summary": "Open summary",
        "btn_review_memory": "Review memory proposals",
        "tip_settings": "Settings",
        "tip_pin": "Always on top",
        "language": "Language",
        "lang_auto": "Auto (Italian + English)",
        "lang_it": "Italiano",
        "lang_en": "English",
        "sec_topic": "WHAT'S BEING DISCUSSED",
        "sec_suggestions": "YOU COULD SAY",
        "sec_remember": "TO REMEMBER",
        "sec_transcript": "TRANSCRIPT",
        "sec_summary": "CALL SUMMARY",
        "click_to_copy": "click to copy",
        "copied": "Copied to clipboard",
        "kind_question": "Question",
        "kind_answer": "Answer",
        "kind_comment": "Comment",
        "speaker_me": "Me",
        "speaker_them": "Them",
        "waiting_first": "Press Start when the call begins. Suggestions appear after about {s} seconds of conversation.",
        "waiting_more": "Listening… first suggestions coming soon.",
        "next_update": "update in {s}s",
        "updating": "updating…",
        "cost": "Estimated cost: ${cost}",
        "cost_tip": "Estimate from tokens used: live {live}, summary {summary}",
        "no_api_key": "No API key: transcription works, suggestions don't. Open ⚙ to add one.",
        "backlog": "Your PC can't keep up with live transcription ({n} chunks queued). Try the 'base' model in Settings.",
        "audio_opened": "Audio: {devices}",
        "audio_none": "No active audio source: check your microphone and settings.",
        "no_system_audio": "I can hear your microphone but not the PC audio: the call may be playing on another device (e.g. a Bluetooth \"Hands-Free\" headset). Make it the Windows default or set it in ⚙ Settings → Audio output.",
        "summary_failed": "Summary failed: {error}. The transcript was saved anyway.",
        "memory_truncated": "Your memory is very long: only part of it is used ({chars} characters).",
        "insight_error": "Suggestions paused: {error}",
        "confirm_quit_title": "Call in progress",
        "confirm_quit": "A call is in progress. Stop it, save the summary and quit?",
        "key_title": "Anthropic API key",
        "key_text": "Paste your Anthropic API key (it starts with sk-ant-).\nGet one at console.anthropic.com → API Keys.\nIt is stored as a Windows environment variable (ANTHROPIC_API_KEY), never in the program files.",
        "key_save": "Save",
        "key_skip": "Continue without",
        "key_invalid": "The key should start with sk-ant-",
        "import_title": "Import your Claude memory",
        "import_text": (
            "claude.ai memory can't be read by other programs, so you copy it over:\n"
            "1. Open claude.ai and start a new chat.\n"
            "2. Paste the request below (\"Copy request\" button).\n"
            "3. Copy Claude's answer and paste it into the big box.\n"
            "It is saved to memory/claude-memory-export.md and used as context."
        ),
        "import_prompt": (
            "Write out in Markdown everything you remember about me from your memory and our past chats: "
            "who I am, work, projects, important people in my life (with name and role), interests, "
            "preferences and how I like to communicate. Use headings and bullet points, no extra commentary."
        ),
        "import_copy_prompt": "Copy request",
        "import_save": "Save to memory",
        "import_empty": "The text is empty.",
        "import_done": "Saved to {path}",
        "review_title": "Proposals for your memory",
        "review_text": "Claude suggests adding this information to your memory. Tick what to keep, edit the text if you like, then save.",
        "review_new_file": "new file",
        "review_apply": "Save selected",
        "review_ignore": "Ignore",
        "review_done": "Memory updated: {n} file(s).",
        "review_none": "No memory proposals from this call.",
        "settings_title": "Settings",
        "settings_ui_language": "Interface language",
        "settings_whisper": "Transcription model",
        "settings_whisper_hint": "tiny/base = slow PCs · small = recommended · medium/large = fast PCs",
        "settings_interval": "Suggestion refresh (seconds)",
        "settings_mic": "Listen to my microphone",
        "settings_system": "Listen to computer audio",
        "settings_mic_device": "Microphone (part of the name, empty = default)",
        "settings_speaker_device": "Audio output (part of the name, empty = default)",
        "settings_api_key": "API key…",
        "settings_open_folder": "Open data folder",
        "settings_save": "Save",
        "settings_saved_restart": "Saved. Some changes apply from the next call or after a restart.",
    },
}

LANGUAGE_NAMES = {"it": "Italian", "en": "English"}


class Translator:
    def __init__(self, language: str = "it"):
        self.language = language if language in STRINGS else "it"

    def __call__(self, key: str, **kwargs: object) -> str:
        text = STRINGS[self.language].get(key) or STRINGS["en"].get(key) or key
        return text.format(**kwargs) if kwargs else text
