# Call Assistant

A personal assistant for your calls and videos, in the spirit of Proactor.ai but built on **Claude**. You use it from your own Claude chat: no API key, nothing to install.

- **It listens and writes down.** A web page hears your microphone and the call's audio (the tab or screen you share), and transcribes it in your browser with Whisper, in Italian and English. It keeps up with the call, tells you apart from the others even without headphones, and drops what Whisper invents on silence. The audio never leaves your computer.
- **Claude reads the call.** The page sends the transcript to your own small bridge on Cloudflare (free). Claude reads it from there, as a **connector** on claude.ai.
- **Claude is your prompter.** Press **Let Claude follow ↗** and paste in the Claude chat where you prepared the meeting: Claude follows the call round by round and puts next to the transcript what you could say now (the answer when they ask you something, the next question for your objectives, a point to raise, a warning), ready to say out loud in the language of the call. Nothing disappears: the latest suggestions stay in view, and every earlier one stays in the call's list, which you can filter and pin. After the call, ask it for the summary. Claude answers on your Claude plan, and knows you from your Claude memory.
- **Every call starts from scratch.** A new call has no briefing and no suggestions. You choose the chat that follows it: a new chat, or one that already knows the meeting. That chat saves a briefing for this call only (goal, participants, your positions, objectives, questions to ask, names and acronyms), and its questions are ticked on the page as they get answered. Nothing of it reaches the next call.

<p align="center">
  <img src="docs/web-live.png" alt="The page during a call: at the top a dark capsule with the call's state, time and who is talking; on the left the meeting, Claude's latest suggestion, the briefing's questions and the list of everything suggested so far; on the right the transcript as a conversation" width="760">
</p>

> The screenshots come from demo mode (a made-up call) rendered by the real app.

## Contents

0. [Web app with Claude](#0-web-app-with-claude) (recommended)
   - [Set it up (once)](#set-it-up-once)
   - [Use it during a call](#use-it-during-a-call)
   - [Meeting briefing](#meeting-briefing)
   - [The best transcript](#the-best-transcript)
   - [Without the bridge: Ask Claude](#without-the-bridge-ask-claude)
   - [Privacy and limits](#privacy-and-limits)
1. [Windows app: install](#1-install-step-by-step) (optional, uses an Anthropic API key)
2. [Windows app: use it during a call](#2-use-it-during-a-call)
3. [Windows app: try it without a call](#3-try-it-without-a-call-demo)
4. [Windows app: your personal memory](#4-your-personal-memory)
5. [Windows app: where your files are](#5-where-your-files-are)
6. [Windows app: costs](#6-costs)
7. [Windows app: privacy](#7-privacy)
8. [Windows app: settings](#8-settings)
9. [Windows app: troubleshooting](#9-troubleshooting)
10. [How it works (for developers)](#10-how-it-works-for-developers)
11. [Credits and licenses](#11-credits-and-licenses)

---

## 0. Web app with Claude

The app and its bridge to Claude are one Cloudflare Worker, made from this repository: the page at `/`, the bridge under `/api` and `/mcp`. Because they share the address, the page connects to its bridge by itself.

### Set it up (once)

About 10 minutes. You can do it from any computer, for example at home.

You need:
- **A Claude plan that allows custom connectors.**
  - On a personal **Pro** or **Max** plan you add it yourself.
  - The **Free** plan allows one custom connector, in beta.
  - On **Team** or **Enterprise**, only an Owner can add it.
- **Accounts:** a **GitHub** account with this repository in it (use **Fork** if it isn't yours), and a free **Cloudflare** account.

1. **Publish the app and the bridge.**
   1. On Cloudflare, go to **Workers & Pages → Create → Import a repository**.
   2. Connect GitHub, pick the repository and press **Deploy**. Nothing else to set: the `wrangler.jsonc` at the root of the repository says what to publish, and the first deploy also creates the database.
   3. Copy the address Cloudflare shows, like `https://transcript.<your-name>.workers.dev`. This is **your app's address**: every merge into `main` updates it.
2. **Open the app.** Open that address in **Chrome or Edge on a computer**. The **Call** tab shows *Last step: add the connector on claude.ai* with the **connector address**. Press **Copy address**.
3. **Add the connector in Claude.**
   1. On claude.ai, go to **Settings → Connectors → Add custom connector**.
   2. Name: *Call Assistant*. URL: the connector address. No login is needed.
   3. Back in the app, press **Done**. The Call tab now says *Claude is connected*.

The connector address contains a secret key made by the page and kept in that browser. If you open the app in another browser, or press **Change secret address**, it shows a new address: update the connector on claude.ai with it.

### Use it during a call

1. **Start.** Open your app's address (tip: pin the tab), choose the call's language and press **Start**. Chrome asks what to share:
   - for a call in the browser (Teams on the web, Google Meet…), pick **that tab**;
   - for a desktop app (Teams, Zoom, WhatsApp), pick **Entire screen**;
   - either way, turn on **"Share audio"**;
   - for a call on your phone, put it on speaker and leave only *My microphone* ticked.

   The page switches to the call view:
   - **At the top, the call's capsule** (like a Live Activity): its state, the time, and two small meters, **Io** and **Altri**, that move as you and the others speak. They show at a glance that both your microphone and the call's audio are coming in. Next to them: **Fai seguire a Claude**, **In primo piano** and **Stop**.
   - **Claude's suggestions on the left**, **the transcript on the right** as a conversation (the others on the left, you on the right, in blue).
   - New suggestions light up for a moment and say how fresh they are (*just now*, *12 s ago*). While Claude works on what was just said, the box says *Claude is thinking…*. When you are in another window, the tab's title says *New suggestions*.
   - Messages come down from the top as banners and go away by themselves; flick one up (or tap it) to dismiss it.
   - The design follows Apple's: the system font, the system colors, light and dark theme, and your settings for less motion, less transparency or more contrast.
2. **Let Claude follow the call.** Press **Fai seguire a Claude ↗ / Let Claude follow ↗**. It copies the request and, the first time, opens claude.ai. Paste it (Ctrl+V) and send in the chat you choose (with the connector on: the tools menu under the message box): **a new chat** follows the call from what is said in it, **the chat where you prepared the meeting** also brings what it knows. Or just write **«segui la chiamata»** / «follow the call» there; written before you press **Start**, Claude waits for the call (up to about 5 minutes).
   - Claude follows the call in rounds (tool `follow_call`). Each round waits for new lines, at once when the others ask you something, and tells Claude what is new, which briefing questions are still open and what it already suggested. Claude sends its suggestions with the next round itself: one tool call per round, so it reacts faster and goes further before claude.ai's limit on tool calls in one reply.
   - If the chat knows the meeting, Claude saves its briefing for this call: objectives, the questions you want to ask, your positions, the people, names and acronyms. It shows at the top of the page.
   - A chat follows only the call it was asked to follow. When you start a new call, that chat stops: let Claude follow the new one from the chat you want.
   - In the left column you get up to 3 things to say: **Answer** when they just asked you something, **Question** to move your objectives forward, **Point to raise**, **Watch out** (a risk, a commitment not to make). Big: the sentence ready to say, in the language of the call; small: why, in your language. Click one to copy it.
   - **Nothing disappears.** The latest set sits in the **Now** box, which stays in view while you scroll. Every earlier suggestion goes into **The script** below it, newest first, grouped by when it arrived and what it was about. Filter it by kind (**Answers**, **Questions**, **Points**, **Warnings**: these include the ones in *Now*), pin the ones you want to keep at hand with ☆ (they stay on top), and click any sentence to copy it.
   - Above them: whether Claude is following (*Claude is following the call: round 12, 6 s ago*), and the briefing's questions, ticked when answered.
   - The first time, claude.ai asks to allow the connector's tools: choose **Always allow**, or it asks again at every round.
   - Claude doesn't write in the chat during the call. It stops when the call ends and offers a summary, decisions and next steps. If the page says Claude stopped reading, press **Fai seguire a Claude ↗** again and paste in the same chat, or write «continua» there.
   - Silences don't stop it: the page stays in touch with the bridge even when nobody speaks. If the page loses the network for a moment, Claude waits for it (up to 5 minutes). If the bridge doesn't answer when you open the page, the call starts anyway and Claude's column appears as soon as the bridge answers, with the whole call so far.
   - The connector also has prompts (**«Segui la chiamata»**, **«Cosa dico adesso?»**, **«Cosa mi hanno chiesto?»**, **«Riassumi la chiamata»**, under the chat's **+** button), but claude.ai doesn't show a custom connector's prompts everywhere. The button and the written request always work.
   - **Tip:** in **Settings → Instructions for a Claude Project**, copy the instructions into a claude.ai Project (e.g. «Calls») and prepare each meeting in a chat of that Project: every chat then knows how to follow a call.
3. **Or ask when you need it.** Write «cosa dico adesso?», «what did they just ask me?», «what did we decide about the budget?». Claude reads the call with the connector's tools; its suggestions also go to the left column.
4. **Always on top.** **In primo piano / On top** moves the live panel into a small window that stays above the call. In a narrow window the suggestions sit above the transcript.
5. **Stop.** Press **Stop** at the end. The end-of-call view lists everything Claude suggested. Then ask Claude for a summary (**Summary with Claude ↗** copies the request). The call is also kept in the app's **History**, with Claude's suggestions, where you can download the transcript.

### Meeting briefing

Prepare the meeting in a Claude chat as you like: objectives, questions to ask, your positions, the people, background, names and acronyms. When the call is running and you let Claude follow it from that chat, Claude saves it as the call's briefing (tool `set_meeting_context`): title, goal, participants and roles, your constraints and positions, background, objectives, questions to ask, and a glossary of names and terms. Claude gets the open questions in every round, so the suggestions follow your objectives. The page shows the title, goal and questions, ticked as Claude reports them answered. The glossary also goes to Whisper, which then spells those names and acronyms right.

**A briefing belongs to one call.** Every call starts without one, and a briefing can only be saved while its call is running: nothing saved before **Start** or after the end waits for the next call. A new call never shows the last call's briefing, questions or suggestions. From a new chat, Claude simply follows the call from what is said. The briefing is deleted with its call (48 hours at most); **Delete the calls from the bridge** removes it too.

The first time, the Whisper model downloads (about 150 MB for `base`), and the browser keeps it for next time. Some company networks let downloads from Hugging Face through only after a security check in a browser tab; then the page can't download the model by itself. In that case use **Settings → Load the model by hand**:
- click the 7 links, one at a time, so each file downloads in a tab and passes the check: the two large `.onnx` files and five small `.json` files;
- press **Choose the downloaded files** and pick all 7.

They are stored in that browser's cache, so the app finds them there. The status under the button lists what is still missing. Each address (your Worker, GitHub Pages) has its own cache, so load them where you use the app.

**Try it without a call:** press *Try it with a sample call*. The made-up call goes to the bridge too, so you can ask Claude about it.

**How quickly things appear.** The live panel shows how long after the end of each sentence its text appeared (*text 2.1 s after speech*), or how far behind the transcript is when it catches up. What adds up:
- **The end of the sentence.** A sentence is transcribed when it ends: after a 0.5 s pause, or after 8 s of continuous speech, cut at a quiet point.
- **Whisper on your computer.** Whisper always works on a 30 s window, however short the sentence: one window takes about as long for "Okay" as for a long sentence. When the model loads, the page measures it and shows it (*1.4 s per block of speech*). While Whisper is busy, the sentences that arrive wait and are then transcribed together in one window (one speaker at a time, never across the other speaker), so the transcript never falls further and further behind. Served by your Worker, the page is *cross-origin isolated* (`web/_headers`), so Whisper runs on up to 4 CPU threads instead of 1; on GitHub Pages it runs on one, more slowly.
- **To Claude.** Each new line reaches the bridge at once. A round of Claude ends as soon as the others ask you a question, or after a few new lines or seconds; its suggestions reach the page within about 2.5 s. Then it depends on how long Claude takes to answer: a model without extended thinking answers sooner.

### The best transcript

- **Headphones.** Without them the microphone also hears the others from the speakers. The page recognises that echo (the microphone's loudness follows the call's a fraction of a second later) and drops it, and says so once; with headphones there is nothing to drop and you and the others are told apart perfectly.
- **Language.** *Auto* chooses between Italian and English for each sentence, leaning towards the language that speaker has been speaking. If the whole call is in one language, choose it: Whisper is a little more accurate.
- **Silence and noise.** Whisper invents short sentences on silence ("Thank you.", "Grazie."). The page asks Whisper how sure it is that there was speech at all, and how sure it is of the words: what it doubts, and sounds like "uh" or "mm", are dropped.
- **Names and acronyms.** Put them in the briefing's glossary (Claude does it from the chat): Whisper gets them as a hint.
- **Model.** `base` is fast; `small` is clearly more accurate, slower. When `base` is fast on your computer, the page suggests `small`. If you load the model by hand, `small` needs its own 7 files.

### Other ways to set it up

- **App on GitHub Pages, bridge alone.** The `web/` folder is also published with GitHub Pages: for this repository at <https://aaddabbo30-bit.github.io/transcript/>. That page isn't served by a bridge, so connect one in **Settings → Connection to Claude**: paste the bridge's address and press **Connect and test**. A bridge alone can be made with this button, which copies the [`bridge/`](bridge/) folder into a new repository of yours:

  [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aaddabbo30-bit/transcript/tree/main/bridge)

- **Bridge alone, by hand** (no GitHub), in the Cloudflare dashboard:
  1. **Storage & databases → D1**: create a database named `call-assistant-bridge`.
  2. **Workers & Pages → Create**: start from *Hello World*, name it `call-assistant-bridge` and deploy it.
  3. **Edit code**: replace everything with the content of [`bridge/src/worker.js`](bridge/src/worker.js), then deploy.
  4. In the Worker's **Settings → Bindings**, add a **D1 database** binding: variable name `DB`, database `call-assistant-bridge`.

### Without the bridge: Ask Claude

If the bridge can't be reached (for example a company network that blocks `workers.dev`), the page still works with any Claude chat:
- during the call, **Chiedi a Claude ↗ / Ask Claude ↗** copies the transcript (its last ~12,000 characters) with a ready-made request, and the first time opens claude.ai. Paste (Ctrl+V) and send;
- after **Stop**, **Riassunto con Claude ↗ / Summary with Claude ↗** copies the whole transcript with a request for the summary.

With the bridge connected, the same buttons copy only a short request, since Claude reads the call itself. In **Settings → Claude chat to open** you can put the link of one of your claude.ai Projects, so these chats end up there.

Why not run the whole thing inside Claude? A page on claude.ai can't use the microphone or capture the audio of a tab, and Claude can't switch them on from its side. So the page does the listening, and the Claude chat does the thinking.

### Privacy and limits

- **Audio:** transcribed inside your browser with Whisper (Transformers.js). It never leaves your computer.
- **Transcript:** it goes to your own bridge on Cloudflare, and Claude reads it from there. The bridge keeps calls for 48 hours at most, and only the last 10, plus the latest suggestions Claude sent and the briefing of the call. **Delete the calls from the bridge** (Settings) removes them at once. The app's **History** keeps them in that browser only.
- **The connector address is a secret:** whoever has it can read your calls. Keep it private; **Change secret address** makes a new one.
- **Company networks:** some block `workers.dev`. The live panel then shows *Bridge to Claude unreachable*; use *Ask Claude* meanwhile.
- **Claude follows the call only from a chat.** It starts when you ask (button or «segui la chiamata») and stops at the end of the call, when the page stops sending, or after 10 rounds without a call. Unless you chose *Always allow*, claude.ai asks before each use of the connector's tools. A long call means many rounds: on a Pro plan, a long meeting followed live can use a good share of the usage limit.
- **Tell the people you talk with** that you are transcribing the call.
- **Cloudflare's free limits** are far above what one person's calls use: the page sends at most one update every 6 seconds, and only when the transcript changed.

---

## Windows app (optional)

The sections below are about the Windows app. It listens to everything the PC plays without sharing a tab, and shows live suggestions in its own always-on-top window. It calls the Claude API **with your own API key** (paid per use), and needs Python, so it isn't for locked-down company PCs. The web app above needs none of this.

<p align="center">
  <img src="docs/live-overlay.png" alt="The Windows app's live window during a call" width="330">
</p>

## 1. Install (step by step)

You need **Windows 10 or 11 (64-bit)** and an internet connection. No programming knowledge is required. Installing takes about 5–10 minutes.

### Step 1: get an Anthropic API key

The live suggestions come from Claude through the Anthropic API, which is billed separately from a claude.ai subscription.

1. Go to <https://console.anthropic.com> and sign in (or create an account).
2. Open **Billing** and add some credit (a few dollars lasts a long time, see [Costs](#6-costs)).
3. Open **API Keys** → **Create Key**, give it a name (e.g. `call-assistant`) and **copy** the key. It starts with `sk-ant-`.

Keep the key private. The installer stores it as a Windows *user environment variable* (`ANTHROPIC_API_KEY`); it is never written into the program's files.

### Step 2: download the program

1. On this GitHub page click **Code** → **Download ZIP**.
2. Right-click the ZIP → **Extract All…** and pick a simple folder, for example `C:\Users\<your name>\CallAssistant`.
   Avoid folders synced by OneDrive (such as Desktop or Documents when OneDrive is on): the program creates thousands of small files there.

### Step 3: run the installer

1. In the extracted folder, **double-click `Installa.bat`**.
   If Windows shows a security warning (*"Windows protected your PC"* or *"Open File – Security Warning"*), click **More info** → **Run anyway** (or **Run**). It appears because the file comes from the internet; it is a plain script you can open with Notepad to read. The installer then removes this mark from the program's files so it won't ask again.
2. A blue/black window opens and:
   - finds a 64-bit Python 3.10–3.13, or installs **Python 3.12** for your user only (via `winget`, or from python.org). On Windows-on-ARM laptops it uses the x64 version, which Windows runs transparently;
   - creates a private environment in the `.venv` folder and installs the libraries;
   - if the **Microsoft Visual C++ runtime** is missing (rare, mostly on freshly installed PCs), installs it: Windows asks for administrator permission once;
   - asks for your **API key**: paste it with right-click (nothing is shown while you paste, that's normal) and press Enter;
   - asks which **Whisper model** to download: `1` base (older PCs), `2` small (**recommended**), `3` medium (fast PCs);
   - creates the **"Avvia assistente"** icon on your Desktop, and a **Call Assistant** folder in the Start menu with a shortcut for every tool:

     | Shortcut | What it does |
     |---|---|
     | **Avvia assistente** | opens the assistant window (the one to use for calls) |
     | **Prova demo** | replays a sample conversation, to try it without a call |
     | **Verifica installazione** | checks Whisper, the API key and the audio devices |
     | **Memoria** | opens your personal memory folder |
     | **Chiamate** | opens the folder with your call summaries and transcripts |
     | **Disinstalla** | removes the program (your data is kept) |
3. At the end it offers to start the assistant.

You can run `Installa.bat` again at any time: it repairs or updates the installation without losing anything.

### Step 4 (optional): check everything works

Double-click **`Verifica installazione.bat`**. It checks Python, the Whisper model and the API key, then records 5 seconds: say something and play a video while it records. It prints the level of the microphone and of the PC audio.

---

## 2. Use it during a call

1. **Wear headphones** if you can. Without them your microphone also hears the other people through the speakers; the app removes most of these echoes, but headphones give a cleaner transcript.
2. Double-click **"Avvia assistente"** on the Desktop (or Start menu → *Call Assistant* → *Avvia assistente*). Tip: right-click the icon → *Pin to taskbar* to have it one click away. The window opens at the top-right of the screen and stays above other windows (the ◆ button turns that off).
3. Pick the **language** of the call: *Auto (Italian + English)*, *Italiano* or *English*. You can change it during the call.
4. Press **▶ Avvia (Start)** when the call begins. Works with any app: WhatsApp, Teams, Zoom, Meet, FaceTime on the web, YouTube…
5. The window shows:
   - **DI COSA SI PARLA / WHAT'S BEING DISCUSSED**: the current topic;
   - **POTRESTI DIRE / YOU COULD SAY**: up to 3 suggestions, tagged *Answer*, *Question* or *Comment*. **Click** one to copy it;
   - **DA RICORDARE / TO REMEMBER**: the key facts so far;
   - **TRASCRIZIONE / TRANSCRIPT**: the live transcript ("Io/Me" = your microphone, "Altri/Them" = the PC audio). Click ▾ to hide it.
   - At the top: elapsed time and the **estimated cost** so far (hover it for details). The ↻ button asks for an update right away.
6. Press **■ Stop** at the end. The app finishes transcribing, writes the summary and opens a window with the **memory proposals**: tick the ones to keep, edit the text if you like, and press **Save selected**.

The first suggestions appear about 25 seconds after people start talking.

<p align="center">
  <img src="docs/end-of-call.png" alt="End of call: memory proposals and summary" width="760">
</p>

---

## 3. Try it without a call (demo)

Double-click **`Prova demo.bat`**, then press **Start**: the window replays a short made-up conversation (`samples/demo_call_it.txt`) as if it were a live call, with real Claude suggestions if your API key is set (it costs a fraction of a cent for the live part and a few cents for the final summary).

From a terminal in the program folder you can also run:

```bat
.venv\Scripts\python -m call_assistant --demo                      :: sample call, real Claude
.venv\Scripts\python -m call_assistant --demo --fake-llm           :: fully offline, scripted answers
.venv\Scripts\python -m call_assistant --demo samples\demo_call_en.txt --speed 2
.venv\Scripts\python -m call_assistant --audio-file recording.wav  :: a WAV recording through Whisper
```

You can write your own transcript to replay: one line per sentence, like `[00:05] Giulia: Ciao!` (`Io`/`Me` means you).

---

## 4. Your personal memory

Claude uses these files as background about you, so suggestions can be specific ("ask Giulia how Pepe's tests went").

```
Documents\Call Assistant\memory\
  about-me.md               who you are: work, family, projects, how you like to talk
  interests.md              hobbies, passions, what you're reading or learning
  people\Giulia Bianchi.md  one file per person you talk with
  claude-memory-export.md   what you pasted from claude.ai
```

- Click **Memoria / Memory** in the window to open the folder, and edit the files with Notepad. Text inside `<!-- ... -->` comments is ignored. Any other `.md` file you add is used too.
- Everything is plain text: you can read, change or delete anything at any time.

### Import your Claude memory

claude.ai's memory can't be read by other programs, so you copy it over once (and again whenever you like):

1. Click **Importa memoria Claude / Import Claude memory** in the window.
2. Click **Copy request** and paste it into a **new chat on claude.ai**. The request asks Claude to write out, in Markdown, everything it remembers about you.
3. Copy Claude's answer, paste it into the big box and press **Save to memory**. It is appended to `claude-memory-export.md` with the date.

<p align="center">
  <img src="docs/import-memory.png" alt="Import Claude memory dialog" width="420">
</p>

### How the memory grows

At the end of each call Claude proposes **additions** (for example a new `people/Anna Rossi.md`, or new facts in `about-me.md`). Nothing is written until you approve it, existing text is never deleted (additions are appended with a date), and file paths are checked so nothing can be written outside the memory folder.

---

## 5. Where your files are

Everything you own lives in **`Documents\Call Assistant`**:

| Path | What |
|---|---|
| `memory\` | your personal memory (see above) |
| `calls\<date-time>\summary.md` | title, summary, key points, to-dos, notes and memory proposals |
| `calls\<date-time>\transcript.md` | the full transcript (written live, so it survives a crash) |
| `calls\<date-time>\insights.jsonl` | every live update, with its cost |
| `calls\<date-time>\summary.json` | the same summary as data, plus which memory proposals you applied |
| `calls\index.md` | a list of all your calls with links |
| `settings.json` | your settings |
| `logs\app.log` | technical log, useful when something goes wrong |

The program folder only contains the app, its `.venv` and the Whisper model (`models\`). Deleting it does not touch your data.

---

## 6. Costs

Transcription runs on your computer and is free. Claude is billed per token by Anthropic:

| What | Model | When |
|---|---|---|
| Live suggestions | `claude-haiku-5-5` (fast and cheap), low effort | every ~25 s while people talk |
| Final summary + memory proposals | `claude-opus-5-5` (best quality) | once, when you press Stop |

The system prompt (instructions + your memory) is identical for every live update, so it uses **prompt caching** and costs about a tenth of the normal price after the first update.

As a rough guide, a **30-minute call costs around 10–20 US cents**, most of it for the final summary; the live suggestions are a few cents. The window shows a running **estimate** (hover the amount for the split between live and summary), and `summary.md` records the total. Your actual bill is on console.anthropic.com. To spend even less, set `"summary_model": "claude-haiku-5-5"` in `settings.json`.

The prices used for the estimate are in `settings.json` (`pricing_usd_per_million_tokens`); update them if Anthropic's prices change (<https://claude.com/pricing>).

---

## 7. Privacy

- **Audio never leaves your computer**: Whisper runs locally. Only the **text** of the transcript and your memory files are sent to the Anthropic API to produce suggestions and the summary. See Anthropic's commercial terms and privacy policy for how API data is handled.
- Your API key is stored as a Windows user environment variable, not in any file of the program.
- Memory, transcripts and summaries are plain files in your Documents folder.
- **Tell the people you're talking with** that you're transcribing the call, and follow the law where you live.
- The window is visible to others if you share your **entire screen**. Share a single window instead.

---

## 8. Settings

Click **⚙** in the window to change the interface language, the Whisper model, how often suggestions refresh, and which audio sources to use, or to enter a new API key. Everything is also in `Documents\Call Assistant\settings.json`:

| Key | Default | Meaning |
|---|---|---|
| `ui_language` | `"it"` | interface language and language of summaries (`"it"` or `"en"`) |
| `call_language` | `"auto"` | `"auto"` (Italian or English), `"it"` or `"en"` |
| `capture_microphone` / `capture_system_audio` | `true` | which sources to listen to |
| `microphone_device` / `speaker_device` | `""` | part of a device name (e.g. `"Headset"`); empty = Windows default |
| `whisper_model` | `"small"` | `tiny`, `base`, `small`, `medium`, `large-v3-turbo` |
| `whisper_device` / `whisper_compute_type` | `"cpu"` / `"int8"` | use `"cuda"` / `"float16"` with an NVIDIA GPU (needs CUDA 12 + cuDNN 9) |
| `insight_model` / `insight_effort` | `"claude-haiku-5-5"` / `"low"` | model for live suggestions |
| `insight_interval_seconds` | `25` | seconds between updates (10–120) |
| `insight_transcript_window_seconds` | `240` | how much recent transcript each update sees |
| `summary_model` / `summary_effort` | `"claude-opus-5-5"` / `"medium"` | model for the final summary |

---

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| Nothing appears under "Altri / Them" (the window warns you after ~45 s) | The app records the **default playback device**. Call apps (Teams, Zoom, WhatsApp) often play on the *default communication device* instead, and Bluetooth headsets switch to a separate "Hands-Free" device during calls. Make that device the Windows default (Sound settings), choose it in the call app, or type part of its name in ⚙ Settings → *Audio output*. `Verifica installazione.bat` and `.venv\Scripts\python -m call_assistant --list-devices` show the device names. |
| Nothing appears under "Io / Me" | Check the microphone in Windows privacy settings (*Let desktop apps access your microphone*), and that it's the default input device, or set `microphone_device`. |
| The same sentence appears twice | Use headphones. Most echoes are removed automatically. |
| "Your PC can't keep up…" | Choose the `base` model in ⚙ Settings. |
| "API key not valid" or "credit balance too low" | Check the key and the credit on console.anthropic.com; enter a new key from ⚙ → *API key…*. |
| The window doesn't open | Run `Verifica installazione.bat`, and look at `Documents\Call Assistant\logs\app.log` (or `%LOCALAPPDATA%\Call Assistant\logs` if Documents isn't writable). Running `Installa.bat` again repairs most problems. |
| "Le librerie non si avviano / libraries don't start" during install | Install the [Microsoft Visual C++ runtime](https://aka.ms/vs/17/release/vc_redist.x64.exe), restart the PC and run `Installa.bat` again. |
| A device was plugged in or out during the call | Press Stop and Start again: the app picks the devices when a call starts. |
| Wrong language in the transcript | Pick the exact language instead of *Auto*. |

To uninstall: close the assistant, double-click **`Disinstalla.bat`**, then delete the program folder. Your data in `Documents\Call Assistant` is kept.

---

## 10. How it works (for developers)

```
 microphone ─┐   WASAPI (PyAudioWPatch)                         faster-whisper (local, CPU)
             ├─► 16 kHz mono ─► per-source segmenter ─► queue ─► transcription ─► transcript store ─┐
 PC audio  ──┘   loopback        (cuts at pauses)                 IT/EN, VAD,      (echo removal)     │
                                                                  hallucination filter               │
                                                                                                      ▼
   memory/*.md ──► system prompt (cached) ──► Claude Haiku 5.5, every ~25 s ──► Tk overlay (always on top)
                                                    │
                     Stop ──► Claude Opus 5.5 ──► summary.md + memory proposals ──► you approve ──► memory/*.md
```

- **Python 3.10+**, standard **Tkinter** for the window (no extra GUI dependency).
- `call_assistant/capture_windows.py`: microphone + speaker loopback with [PyAudioWPatch](https://github.com/s0d3s/PyAudioWPatch) (no "Stereo Mix" or virtual cable needed). Same approach as [ecoute](https://github.com/SevaSk/ecoute).
- `audio.py`: conversion, resampling, an energy-based utterance segmenter with an adaptive noise floor, stale-utterance flushing (WASAPI loopback sends nothing during silence), WAV playback for tests.
- `transcriber.py`: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) with its built-in Silero VAD filter, Italian/English-only auto-detection, and filters for Whisper's typical hallucinations ("Sottotitoli creati dalla comunità Amara.org", "Thanks for watching") and repetition loops.
- `transcript.py`: ordered, thread-safe transcript; drops microphone echoes of the PC audio.
- `insights.py`, `summary.py`, `prompts.py`, `llm.py`: Claude via the official [`anthropic`](https://github.com/anthropics/anthropic-sdk-python) SDK, with **structured outputs** (JSON schema), **prompt caching** of the instructions + memory, per-request **cost estimate**, readable error messages, and server-side refusal **fallbacks** (`fallbacks: "default"`) for the summary model.
- `memory.py`: Markdown memory, Claude-export import, validated append-only updates.
- `session.py`: one call from Start to Stop; worker threads talk to the UI through an event queue.
- `ui/`: overlay window and dialogs. `simulate.py`: transcript replay for the demo.

### Web app (`web/`)

The web app needs no build step: plain ES modules, served as static files. It never calls the Claude API: Claude reads the call from the bridge, or from what *Ask Claude* copies.
- `js/segmenter.js` and `js/transcript.js` port the desktop logic: segmentation, filters, removal of repeated sentences.
- `js/echo.js`: tells the call heard by the microphone from the user's voice, by how closely the microphone's loudness follows the shared audio (Pearson correlation of 20 ms levels, over lags of -0.1 to 0.6 s).
- `js/audio.js` and `js/audio-worklet.js`: microphone and shared tab/screen audio through an AudioWorklet.
- `js/whisper-worker.js`: Whisper in a Web Worker with [Transformers.js](https://github.com/huggingface/transformers.js), WebGPU with a WASM fallback, loaded from jsDelivr. `js/model-files.js` loads the model by hand.
- `js/whisper-core.js`: the decoding, done by hand on top of the pipeline: the language token restricted to Italian and English, the no-speech probability, the average log-probability, Whisper's token filters at the right steps, and a `<|startofprev|>` prompt with the glossary. If it can't run with the loaded library, the worker falls back to the plain pipeline.
- `js/session.js`: the call, from Start to Stop, with Whisper's queue (one window at a time; a speaker's waiting sentences joined) and the transcript's lag.
- `js/bridge.js`: finds the bridge at the page's own address (asking again when it doesn't answer), or at the one given in Settings, and sends it the running call; its polls keep the call in progress through silences, and the end of the call is sent again until the bridge has it.
- `js/motion.js`: springs (Apple's response and damping ratio) and the banners' flick gesture: motion that starts from where things are, carries the pointer's speed, and can be caught mid-flight.
- `js/script.js`: the call's script: every suggestion Claude sent, without repeats, grouped by arrival, with filters and pins; saved with the call in the history.
- `js/prompts.js`: the requests that *Ask Claude* copies for a claude.ai chat.
- `js/history.js`: past calls, in the browser's local storage.

After changing anything in `js/` or `css/`, run `node web/tools/stamp.mjs`. It writes a hash of those files into `index.html` (`?v=…` links plus an import map), so browsers fetch a new version as a whole instead of mixing new and cached files. CI fails when the stamp is out of date.

Run it locally with any static server, for example `python -m http.server -d web`, then open <http://localhost:8000>; `localhost` counts as secure for the microphone. With the bridge too: `npx wrangler dev` at the root of the repository serves both, with a local database.

Tests:
- `node --test web/tests/unit.test.mjs` runs 26 unit tests: segmentation and echo detection on a real recording (echo alone, the user alone, both talking at once), the decoding steps, the filters, Whisper's queue, full simulated calls, the chat requests, the bridge client, its suggestions and Claude's follow state.
- `node web/tests/whisper-real.mjs` runs the decoding with the real `whisper-base` (Transformers.js on Node, downloaded from Hugging Face): Italian and English told apart, the same words as the plain pipeline, silence and noise dropped, the glossary prompt not echoed. CI runs it in its own job.
- `node web/tests/e2e.mjs` runs Chromium with a fake microphone playing a speech recording. It covers:
  - the app served by its bridge: it connects by itself, shows the connector step, copies the request to follow the call, Claude's side follows the call over MCP and the page shows it (and that Claude is thinking), the suggestions Claude sends (with show_suggestions, or with the next follow_call round) appear left of the transcript, the earlier ones stay in the script (filters, pins, copy, the list after the call), the briefing's questions are ticked when answered, and a new call starts without the last call's briefing or suggestions;
  - a bridge that doesn't answer when the page opens: the call starts anyway, and Claude's column appears with the whole call as soon as the bridge answers;
  - a bridge at another address, connected in Settings;
  - *Ask Claude* without a bridge, the microphone's meter moving with the voice, the end of a call, the history and the transcript download;
  - the always-on-top window, the model loaded by hand, and the version stamp of every script, including the Whisper worker.

  It needs `playwright`.

### Claude bridge (`bridge/`)

A Cloudflare Worker with no dependencies, [`bridge/src/worker.js`](bridge/src/worker.js). It has three sides:
- **For the page:** `POST /api/<key>/call` saves the current call, `GET /api/<key>/status` checks the bridge, and `POST /api/<key>/delete` clears the calls.
- **For Claude:** `POST /mcp/<key>` is an MCP server over Streamable HTTP, with JSON responses and no login.
  - `follow_call`: one round of following the call. The first picks the call in progress (or waits for the user to press Start, up to 12 rounds) and brings its briefing, if any, the last 3 minutes and the method; the next ones wait (up to 25 s; at once when the others ask a question, else after 3 lines or 8 s) and bring the new lines (by the order the page heard them, `n`), the questions to the user, the open briefing items, the suggestions already made, the languages to write in, and the cursor for the next round. The cursor (`<call tag>:<lines seen>`) names the call: the rounds stay on it, and stop when it ends or a new call starts. A page out of touch for more than 2 minutes is waited for up to 5. The page sees the rounds (`follow` in `GET /api/<key>/suggestions`).
  - `show_suggestions`: up to 3 items, each `kind` (question, answer, point, warning), `say` (in the others' language) and `why` (in the user's); `remember`; `answered` ticks briefing items. The earlier ones are kept as `previous`. While following a call, Claude passes the same fields to `follow_call` instead: they are shown at once, then the round waits.
  - `set_meeting_context`: the call's briefing, with a `glossary`. Saved only while a call is in progress, for that call; with no call in progress it is refused. The page gets its title, goal, questions (done or not) and the glossary for Whisper (`meeting` in the same answers, for that call only).
  - `show_suggestions` and `set_meeting_context` take the call's tag (`call`): when it names a call that is over, nothing is written, so a chat that followed an old call can't reach the new one.
  - A call whose page stopped sending without Stop is reported as *left open*, not as in progress.
  - Polls and waiting rounds read only the calls' metadata, and a transcript only when it changed: the Worker stays well within its CPU time per request.
  - Read-only tools to answer questions about calls: `get_current_call`, `list_calls`, `get_call`.
  - Four prompts that carry the transcript: `segui_la_chiamata`, `cosa_dico_adesso`, `cosa_mi_hanno_chiesto` and `riassunto_chiamata`. claude.ai doesn't always show them; the tools' descriptions say how to follow a call when the user asks for it.
  - When the Worker also serves the app, its answers include the app's address, so Claude can give the user the link.
- **The app itself:** with the root [`wrangler.jsonc`](wrangler.jsonc), `web/` is published as static assets of the same Worker (`/web/…` links redirect to `/…`); `bridge/wrangler.jsonc` publishes the bridge alone.
  - [`web/_headers`](web/_headers) makes the page cross-origin isolated (`COOP: same-origin`, `COEP: credentialless`). onnxruntime-web then runs Whisper on several threads.

Storage is D1, bound as `DB`. The tables are created on the first request; the database is created by the first deploy. `<key>` is a random 32-character secret made by the page; the database stores only its SHA-256.

Tests:
- `node --test bridge/test/*.test.mjs` runs the Worker against Node's built-in SQLite.
- `node bridge/test/mcp-client.mjs [url]` connects with the official MCP TypeScript SDK client: tools and prompts. Without a URL it runs the Worker in-process; with one it uses a running bridge, such as `npx wrangler dev`.
- CI runs all of these, including `wrangler dev` with a local D1 database and deploy dry runs of both configurations.

### Run from source

```bash
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt   # Windows: .venv\Scripts\...
python -m pytest                       # on Linux the window tests need a display: xvfb-run -a python -m pytest
python -m call_assistant --demo --fake-llm             # the window, fully offline
python -m call_assistant --headless --demo --fake-llm --speed 20   # no window, prints events
python -m call_assistant --check | --list-devices | --download-model small
```

### What is tested, and what isn't

This project was built in a cloud environment without a sound card, without Windows and without access to the Whisper model downloads. So:

- **Tested automatically** (81 tests): resampling (including 48 kHz stereo, like WASAPI loopback), segmentation on synthetic signals and on real synthesized Italian/English speech, the Whisper wrapper (with a stand-in model: language handling, CPU fallback, hallucination filters), transcript echo removal, the real `anthropic` SDK request/response path against a mocked HTTP server (request shape, caching, structured outputs, fallbacks, errors), cost estimates, memory (templates, import, path validation, approvals), full simulated calls from transcript and from audio, and the real Tk window under a virtual display (start, live updates, click-to-copy, stop, summary, memory approval).
- **CI on GitHub Actions** (`.github/workflows/ci.yml`) runs the tests on Linux and Windows and runs `install.ps1` non-interactively on a Windows runner.
- **Reviewed, not executed**: the Windows-only code (installer, WASAPI capture, registry and shortcut code) was checked line by line against the PyAudioWPatch source and Windows PowerShell 5.1 rules.
- **Needs a real Windows PC to verify**: live capture from your microphone and speakers, actual Whisper transcription quality/speed on your hardware, and the desktop shortcut. `Verifica installazione.bat` checks the first two quickly.
- **Web app and bridge**:
  - tested by unit tests, the official MCP client, 8 browser scenarios with a fake microphone, and the decoding with the real Whisper model (see above);
  - in CI the bridge also runs on Cloudflare's local runtime (`wrangler dev`), alone and together with the app;
  - not covered by tests: claude.ai itself (adding the connector, where its prompts appear, how long a chat keeps following a call), a real call's acoustics (speakers, rooms, headsets: the echo detection is tested on a recording with simulated speakers and reverb), and the deploy on a real Cloudflare account.

---

## 11. Credits and licenses

This project is released under the [MIT License](LICENSE). It builds on open-source work, used as libraries (no code copied):

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT), [CTranslate2](https://github.com/OpenNMT/CTranslate2) (MIT), OpenAI [Whisper](https://github.com/openai/whisper) models (MIT), [Silero VAD](https://github.com/snakers4/silero-vad) (MIT, bundled with faster-whisper)
- [PyAudioWPatch](https://github.com/s0d3s/PyAudioWPatch) (MIT, a PyAudio fork with WASAPI loopback) and [PortAudio](http://www.portaudio.com/) (MIT-style)
- [Anthropic Python SDK](https://github.com/anthropics/anthropic-sdk-python) (Apache-2.0), [NumPy](https://numpy.org) (BSD-3-Clause)
- Web app: [Transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0, loaded from jsDelivr) running the [onnx-community Whisper](https://huggingface.co/onnx-community/whisper-base) models (MIT)
- The microphone + speaker loopback design was inspired by [ecoute](https://github.com/SevaSk/ecoute) (MIT).

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Call Assistant is an independent project, not affiliated with Anthropic or Proactor.ai.
