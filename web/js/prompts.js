// What «Ask Claude» copies for a chat on claude.ai, in the interface language.
// The chat runs on the user's Claude plan and knows them from their Claude
// memory. With the bridge connected Claude reads the call itself, so only a
// short request is copied; without it, the request carries the transcript.

import { ME } from "./segmenter.js";
import { fmtTime } from "./transcript.js";


const CHAT = {
  it: {
    me: "Io",
    them: "Altri",
    cut: "(inizio della chiamata omesso)",
    transcript: "Trascrizione",
    ask: `Sono in una chiamata adesso. Sotto c'è la trascrizione automatica: può contenere errori; "Io" sono io, "Altri" sono le altre persone (o il video che sto guardando). Usa anche quello che sai di me.

Rispondi brevissimo, lo leggo mentre parlo:
1. Di cosa si parla, in una riga.
2. Fino a 3 cose che potrei dire adesso (domande da fare o risposte), pronte da dire ad alta voce, nella lingua della chiamata.
3. Cose da ricordare (nomi, date, numeri, impegni), se ce ne sono.`,
    summary: `Ho appena finito una chiamata ({meta}). Sotto c'è la trascrizione automatica: può contenere errori; "Io" sono io, "Altri" sono le altre persone. Usa anche quello che sai di me.

Scrivi:
1. Un titolo breve.
2. Il riassunto, in 5-10 righe.
3. I punti chiave.
4. Le cose da fare: chi, cosa, entro quando.
5. Cosa vale la pena ricordare di me e delle persone della chiamata per le prossime volte.`,
    askConnector: `Usa il connector della mia pagina Assistente chiamate (strumento get_current_call) per leggere la chiamata in corso, poi rispondi brevissimo, lo leggo mentre parlo:
1. Di cosa si parla, in una riga.
2. Fino a 3 cose che potrei dire adesso (domande da fare o risposte), pronte da dire ad alta voce, nella lingua della chiamata.
3. Cose da ricordare (nomi, date, numeri, impegni), se ce ne sono.`,
    summaryConnector: `Usa il connector della mia pagina Assistente chiamate (strumento get_current_call con minutes = 0) per leggere tutta la chiamata appena finita. Usa anche quello che sai di me, poi scrivi:
1. Un titolo breve.
2. Il riassunto, in 5-10 righe.
3. I punti chiave.
4. Le cose da fare: chi, cosa, entro quando.
5. Cosa vale la pena ricordare di me e delle persone della chiamata per le prossime volte.`,
  },
  en: {
    me: "Me",
    them: "Them",
    cut: "(start of the call left out)",
    transcript: "Transcript",
    ask: `I'm in a call right now. Below is the automatic transcript: it can contain mistakes; "Me" is me, "Them" is the other people (or the video I'm watching). Also use what you know about me.

Answer very briefly, I'll read it while I talk:
1. What we're talking about, in one line.
2. Up to 3 things I could say now (questions to ask or answers), ready to say out loud, in the language of the call.
3. Things to remember (names, dates, numbers, commitments), if any.`,
    summary: `I just finished a call ({meta}). Below is the automatic transcript: it can contain mistakes; "Me" is me, "Them" is the other people. Also use what you know about me.

Write:
1. A short title.
2. The summary, in 5-10 lines.
3. The key points.
4. The action items: who, what, by when.
5. What is worth remembering about me and the people in the call for next time.`,
    askConnector: `Use the connector of my Call Assistant page (the get_current_call tool) to read the call in progress, then answer very briefly, I'll read it while I talk:
1. What we're talking about, in one line.
2. Up to 3 things I could say now (questions to ask or answers), ready to say out loud, in the language of the call.
3. Things to remember (names, dates, numbers, commitments), if any.`,
    summaryConnector: `Use the connector of my Call Assistant page (the get_current_call tool with minutes = 0) to read the whole call that just ended. Also use what you know about me, then write:
1. A short title.
2. The summary, in 5-10 lines.
3. The key points.
4. The action items: who, what, by when.
5. What is worth remembering about me and the people in the call for next time.`,
  },
};

/** The transcript as "[mm:ss] Me: text" lines; only the end when longer than maxChars. */
export function chatTranscript(lines, lang = "it", maxChars = Infinity) {
  const c = CHAT[lang] || CHAT.it;
  const out = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const row = `[${fmtTime(l.t)}] ${l.speaker === ME ? c.me : c.them}: ${l.text}`;
    if (out.length && size + row.length + 1 > maxChars) {
      out.unshift(c.cut);
      break;
    }
    out.unshift(row);
    size += row.length + 1;
  }
  return out.join("\n");
}

/** What to paste in a Claude chat during the call to get suggestions now. */
export function chatAskPrompt({ lang = "it", lines, maxChars = 12000 }) {
  const c = CHAT[lang] || CHAT.it;
  return `${c.ask}\n\n${c.transcript}:\n${chatTranscript(lines, lang, maxChars)}`;
}

/** What to paste in a Claude chat after the call to get the summary. */
export function chatSummaryPrompt({ lang = "it", meta, lines }) {
  const c = CHAT[lang] || CHAT.it;
  return `${c.summary.replace("{meta}", meta)}\n\n${c.transcript}:\n${chatTranscript(lines, lang)}`;
}

/** With the bridge, Claude reads the call itself: the request is all there is to paste. */
export function chatConnectorPrompt(lang = "it", kind = "ask") {
  const c = CHAT[lang] || CHAT.it;
  return kind === "summary" ? c.summaryConnector : c.askConnector;
}
