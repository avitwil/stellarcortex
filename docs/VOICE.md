# Voice calls and interface language

[עברית](VOICE.he.md)

Choose **Settings → General → Language** to switch between Hebrew and English. The change is saved in the install and also sets the interface direction. Speech recognition takes its language from this setting when a voice call starts.

## A call from the app

Open a bot's chat and press the voice call button. Choose a mode and start. Only this step asks for the microphone; opening the panel records nothing. The call shows listening, working and speaking states, with mute, stop reading and end. You can minimize it, and a call indicator stays visible. Tool approvals stay reachable in the interface.

Speech is transcribed and sent to the chosen bot through the regular task engine. The bot uses its own provider, model, memory and tools. Reading aloud is based on its completed answer. The transcript and the bot's answer are saved in the chat like text messages. The app does not store audio recordings.

Ending a call releases the microphone and audio, and stops tasks still running that this voice call created. Other tasks keep running. Moving to another chat or locking the workspace ends the voice call. New speech stops earlier reading; an earlier voice task that is still running stops before the new message is sent.

## Audio modes

**Browser speech:** uses SpeechRecognition and speechSynthesis when the browser provides them. The audio layer needs no OpenAI key. It also suits a bot running through a subscription or a local model. Whether Hebrew recognition and Hebrew voices exist depends on the browser and the operating system. Speech recognition may be sent to the browser vendor's service and may need the internet. During reading, recognition pauses to limit picking up the bot's own voice; the stop reading button returns to listening.

**OpenAI Realtime:** uses WebRTC and `gpt-realtime-2.1` for the audio layer, with Hebrew and English transcription. It needs an OpenAI API key set in **Models & connections**, and is billed separately from the subscription and from running the bot's model. The voice model is set not to answer questions itself: the transcript goes to the existing bot, and only its answer is passed on to be read. You can interrupt the audio by speaking. The permanent key stays on the server; the browser receives only an SDP connection answer.

Token counters for text connections cover bot tasks. They do not include Realtime audio billing, which appears in the OpenAI account. Check the provider's data for a full billing report.

## Requirements and limits

- A browser that supports the chosen mode, a microphone and microphone permission are needed. On a remote server use HTTPS; supporting browsers treat localhost as a secure origin.
- The app does not dial phone numbers and needs no local model.
- Answer speed depends on the bot's model, the tools it runs and the audio service. Automatic transcription can be wrong; actions that need approval keep waiting for approval in the interface.
- There is no promise of voice recognition, latency or behavior identical to another app. Test results and limits are in [VALIDATION.md](VALIDATION.md).

Sources: [OpenAI WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime), [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations), [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API).
