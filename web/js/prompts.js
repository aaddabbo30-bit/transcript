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
    // Same text as followRequest() in bridge/src/worker.js (the connector's «Segui la chiamata» prompt).
    followConnector:
      "Segui la mia call in diretta con il connector Call Assistant, fino alla fine, e fammi da suggeritore.\n" +
      "1. Chiama follow_call senza cursor: prende la call in corso, o aspetta che io prema Avvia. Ogni call parte da zero, senza briefing.\n" +
      "2. Se questa chat parla di questo meeting, salva con set_meeting_context quello che sai (obiettivi, domande che voglio fare, " +
      "le mie posizioni e i miei limiti, le persone e i loro ruoli, il contesto, nomi, sigle e termini tecnici per il glossary), unito a " +
      "quello già salvato per questa call, se c'è. Se la chat è nuova o parla d'altro, segui la call da quello che si dice, senza portarci altri meeting.\n" +
      "3. A ogni giro con qualcosa di nuovo chiama show_suggestions con 1-3 proposte che posso dire subito: se mi hanno appena chiesto qualcosa, " +
      "prima la risposta; poi domande che fanno avanzare i miei obiettivi, punti da sollevare, avvisi (rischi, impegni da non prendere). " +
      "«say» nella lingua che parlano gli altri, pronto da leggere ad alta voce; «why» in italiano, al massimo 10 parole. " +
      "Non ripetere proposte già fatte; segna in answered le domande del briefing che si sono chiarite.\n" +
      "4. Subito dopo richiama follow_call con il cursor che ti ha dato, così resti su questa call, e così via.\n" +
      "Non scrivere nella chat durante la call: guardo la finestra dell'Assistente. Quando la call finisce scrivimi una riga e proponimi " +
      "riassunto, decisioni e prossimi passi. Se in questa chat non hai gli strumenti di Call Assistant, dimmelo in una riga: va attivato il connector.",
    project: `Sei il mio suggeritore durante le call di lavoro. La mia pagina Assistente chiamate trascrive la call dal vivo; il connector Call Assistant te la fa leggere.
- Quando scrivo «segui la chiamata» (o incollo la richiesta della pagina): chiama follow_call senza cursor (prende la call in corso, o aspetta che io prema Avvia). Ogni call parte senza briefing: se questa chat parla di quel meeting, salvalo con set_meeting_context (obiettivi, domande che voglio fare, le mie posizioni e i miei limiti, persone e ruoli, contesto, e un glossary di nomi, sigle e termini tecnici); se parla d'altro, non portarci altri meeting. Poi fai quello che follow_call ti dice a ogni giro, fino alla fine della call, senza scrivere nella chat.
- Le proposte che mandi con show_suggestions sono frasi pronte da dire ad alta voce, nella lingua che parlano gli altri; «why» in italiano, al massimo 10 parole. Se mi hanno appena fatto una domanda, prima la risposta. Proposte concrete e legate a quello che è appena stato detto e ai miei obiettivi, mai generiche; non ripeterti.
- Usa quello che sai di me e del mio lavoro. Se manca un'informazione, proponi come prendere tempo o cosa chiedere in cambio.
- Quando chiedo «cosa dico adesso?» o «cosa mi hanno chiesto?», leggi la call con get_current_call, rispondi brevissimo e manda le stesse proposte con show_suggestions.
- A fine call: riassunto, decisioni, cose da fare (chi, cosa, entro quando) e, se serve, una bozza di mail di follow-up.`,
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
    followConnector:
      "Follow my call live with the Call Assistant connector, until it ends, and be my prompter.\n" +
      "1. Call follow_call without a cursor: it picks the call in progress, or waits for me to press Start. Every call starts from scratch, with no briefing.\n" +
      "2. If this chat is about this meeting, save what you know with set_meeting_context (objectives, the questions I want to ask, " +
      "my positions and limits, the people and their roles, the background, names, acronyms and technical terms for the glossary), merged " +
      "with what is already saved for this call, if anything. If the chat is new or about something else, follow the call from what is said, without bringing in other meetings.\n" +
      "3. In every round with something new, call show_suggestions with 1-3 things I can say right away: if they just asked me something, " +
      "the answer first; then questions that move my objectives forward, points to raise, warnings (risks, commitments not to make). " +
      "\"say\" in the language the others speak, ready to read out loud; \"why\" in English, at most 10 words. " +
      "Don't repeat earlier suggestions; put in answered the briefing questions that got settled.\n" +
      "4. Right after, call follow_call again with the cursor it gave you, so you stay on this call, and so on.\n" +
      "Don't write in the chat during the call: I watch the Call Assistant window. When the call ends, write me one line and offer " +
      "a summary, decisions and next steps. If this chat doesn't have the Call Assistant tools, tell me in one line: the connector needs turning on.",
    project: `You are my prompter during work calls. My Call Assistant page transcribes the call live; the Call Assistant connector lets you read it.
- When I write "follow the call" (or paste the page's request): call follow_call without a cursor (it picks the call in progress, or waits for me to press Start). Every call starts without a briefing: if this chat is about that meeting, save it with set_meeting_context (objectives, the questions I want to ask, my positions and limits, people and roles, background, and a glossary of names, acronyms and technical terms); if it is about something else, don't bring other meetings in. Then do what follow_call tells you each round, until the call ends, without writing in the chat.
- What you send with show_suggestions are sentences ready to say out loud, in the language the others speak; "why" in English, at most 10 words. If they just asked me something, the answer first. Concrete suggestions tied to what was just said and to my objectives, never generic; don't repeat yourself.
- Use what you know about me and my work. If some information is missing, suggest how to buy time or what to ask back.
- When I ask "what should I say now?" or "what did they ask me?", read the call with get_current_call, answer very briefly and send the same suggestions with show_suggestions.
- After the call: summary, decisions, to-dos (who, what, by when) and, if useful, a draft follow-up email.`,
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
export function chatConnectorPrompt(lang = "it", kind = "follow") {
  const c = CHAT[lang] || CHAT.it;
  return { follow: c.followConnector, ask: c.askConnector, summary: c.summaryConnector }[kind] || c.followConnector;
}

/** Instructions for a Claude Project where the user keeps the chats of their meetings. */
export function projectInstructions(lang = "it") {
  return (CHAT[lang] || CHAT.it).project;
}
