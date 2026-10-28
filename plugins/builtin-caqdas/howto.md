# builtin-caqdas - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: caqdas-coding
Qualitative coding, as a **workspace tab** rather than a menu item — open the **Coding** tab once the plugin is enabled.

Pick a dataset column of documents (a text column, or a media column from an image/audio/video import), then tag passages or regions with codes. Code frequencies and segments export to Output, where they sit alongside any quantitative results in the same project.

That shared project is the point: codings live in the same file as the data and travel with it, so a mixed-methods study is one artefact rather than a spreadsheet beside a separate coding tool.

For agreement between two coders, [inter-coder agreement](howto:agreement-codings) reads the codings directly instead of asking you to flatten them into a grid first.

--- id: caqdas-transcribe
Transcription runs **on this device** — open the **Transcripts** tab once the plugin is enabled. Nothing is uploaded, which is the point for interview data you are not allowed to send to a transcription service. The first run downloads the model (73 MB or 238 MB), and after that it works offline.

The tab lists the audio and video in the active dataset. Set **Model**, **Mode** and **Language**, then transcribe one recording or all of them; they queue, and finished transcripts can be read and checked while the rest are still working. **Save transcripts to a new dataset** writes them as a dataset of their own, with the timings that make the Coding tab play the audio against the text.

**Only part of a recording.** Put times in **From** and **to** — `2:15`, `19:30`, or `1:02:03` — to transcribe just that stretch. Leave them empty for the whole thing. An end past the end of the recording simply means "to the end". The transcript keeps the **original** times, so 2:15 in the audio is still 2:15 in the transcript and the player still lines up.

**Language.** "Detect automatically" samples several 30-second windows from across the recording and uses the result for the whole file, so an interview that opens with an English introduction and continues in another language is still read correctly. If the windows disagree you are told which other language was heard and where — transcribe that stretch as a separate pass using **From** and **to**. Set the language yourself to override the guess.

Three things it will not do, each of which matters to somebody:

- **Filler words are mostly lost.** About nine in ten "um"s and "uh"s are dropped. If you are studying disfluency, transcribe elsewhere and import the transcript instead.
- **A language the model does not know** is transcribed as the nearest one it does — fluently and wrongly, with no error. Use **Identify speakers only**, which needs no language at all, and type into the speaker skeleton it gives you.
- **It is readable, not verbatim.** "gonna" becomes "going to"; overlapping speech tends to vanish rather than be mistranscribed.

To code the result against the recording, see [qualitative coding](howto:caqdas-coding).
