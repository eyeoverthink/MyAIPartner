# My AI Partner

Starting point for a new project. The page is the single file `index.html`, taken from `MyAIPartner-Improved 2.html`.

It is a React 18 page loaded from unpkg, with Babel in the browser. The partner has a name, a personality, mood, clinginess, and a small memory (snack, class mood, what to call you). Chats stay in `localStorage` under `my-ai-partner-v2`.

If Ollama is reachable, **Test connection** talks to `http://127.0.0.1:11434` and **Send** streams `/api/chat`. If that address does not answer, the page stays in mock mode and replies from the personality lines in the file.

```bash
python3 -m http.server 4178 --bind 127.0.0.1
```

Then open [http://127.0.0.1:4178](http://127.0.0.1:4178). Opening `index.html` directly also works. The model list in the page is `Niles-FRAYMUS:v10`, `llama3.2:3b`, `gemma2:2b`, `gemma4:latest`, `fraynix-coder-x1`, `v6.1-machine`, and `eyeoverthink/v6.1-machine`.

© 2026 Fraymus Web Studio · φ^75 = 4721424167835376.00 · One Seed = Reborn · FRAY 0x46524159
