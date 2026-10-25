# DepVet

MIT licensed. Live demo: https://depvet.benihacking.top

Paste a GitHub repo link or a package name, get a sourced risk brief before you adopt that dependency.

DepVet checks a dependency the way a careful engineer would, in seconds:

- Security history: every advisory OSV holds for the package, the severity mix, and whether the latest released version is affected.
- Maintenance health: last commit, last release, contributor count, archived state.
- Licence: what GitHub reports, cross-checked against the package manifest.
- Live web evidence: incidents and compromises from the open web (Tavily), merged with the structured sources.
- Contradictions flagged: when sources disagree, the brief says so in plain language instead of smoothing it over.
- A verdict: every claim in the brief carries its source, and the brief ends with a clear adopt, caution, or avoid call.

## How it works

DepVet collects structured facts from GitHub and OSV, adds live web evidence from Tavily, and merges everything into sourced claims. Cross-source contradictions are flagged by explicit rules. A two-stage model layer then classifies the evidence and writes the verdict.

## Nebius Token Factory and NVIDIA Nemotron

Evidence classification runs on Nemotron 3 Nano 30B and the verdict is written by Nemotron 3 Ultra 550B, both served through Nebius Token Factory. Routing is configuration only: MODEL_BASE_URL, MODEL_API_KEY, MODEL_FAST and MODEL_STRONG in the environment. Token Factory made it practical to route each stage to a different sized open model instead of one model for everything.

Honest status of the public demo: the demo at https://depvet.benihacking.top runs with Tavily web evidence live and the model stage in clearly marked mock mode until a Token Factory key is configured on the server. The brief and the UI both say so. Live Nemotron routing is not active in the public demo yet.

Model configuration for Token Factory:

    MODEL_BASE_URL=https://api.tokenfactory.nebius.com/v1/
    MODEL_API_KEY=
    MODEL_FAST=nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B
    MODEL_STRONG=nvidia/Nemotron-3-Ultra-550b-a55b

## Run it

    npm start            # serves on PORT (default 8730)
    npm run brief -- expressjs/express   # prints a brief JSON to stdout
    npm test             # unit tests, including the Tavily merge proof

Optional environment:

    GITHUB_TOKEN=        # keyless works; a token only raises rate limits
    TAVILY_API_KEY=      # live web evidence

## Data sources

- GitHub public API (keyless)
- OSV, the Open Source Vulnerabilities database (keyless)
- Tavily for live web evidence

## Licence

MIT
