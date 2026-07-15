# Playground CLI TypeScript v0.1

TypeScript/Node CLI for the paper2arm Playground/Harbor submission loop.

It supports:

- install-and-use defaults for the deployed Playground endpoint
- automatic dataset pulls through the Playground installer
- automatic Trisol model and dataset pulls declared by task config
- hidden dataset downloads when a challenge declares dataset refs
- Harbor task directory to Playground challenge conversion
- Harbor ATIF, OpenCode, Claude Code, and OpenClaw/ArkClaw traces to ARM v1.1 conversion
- challenge upload/download
- ARM v1.1 bundle generation from `outputs/`, logs, report, and trace
- official attempt creation plus bundle upload
- worker result/status polling and score回写

## Install From This Directory

```bash
npm install
npm run build
npm link
playground --help
```

For a one-shot local install without linking:

```bash
npm install
npm run build
node dist/index.js --help
```

The CLI requires Node 20+.

## Configure

The CLI defaults to the deployed Playground endpoint:

```text
http://nwjs1473070.bohrium.tech:50002/api
```

Most contestants do not need to configure anything. For a pinned config file:

```bash
playground config init \
  --api-base http://nwjs1473070.bohrium.tech:50002/api
```

Tokens are read from environment variables:

```bash
export PLAYGROUND_TOKEN=...
```

Advanced operators can override the endpoint with `PLAYGROUND_API_BASE` or `--api-base`.

## Convert A Harbor Task

```bash
playground harbor convert \
  --harbor-task /path/to/harbor/task \
  --out ./challenge-harbor-15931 \
  --title "Harbor Phys: KAW ion acceleration" \
  --challenge-id harbor-phys-15931-kaw-lh-filamentation \
  --dataset DATASET:VERSION \
  --expected-output ion_energy.json:"Ion energy JSON" \
  --expected-output lh_instability.json:"Lower-hybrid instability JSON"
```

This writes:

- `challenge.json`
- `task.md`
- `rubric.md`
- `playground_manifest.json`

## Convert / Validate Traces

Convert native agent traces into ARM v1.1 trace JSONL:

```bash
playground trace convert \
  --trace /path/to/agent/trajectory.json \
  --out ./trace.jsonl \
  --raw-out ./raw_messages.jsonl
```

Supported `--trace` inputs include:

- Harbor ATIF `agent/trajectory.json`
- Harbor OpenCode stdout JSONL `agent/opencode.txt`
- Claude Code session JSONL under `agent/sessions/projects/.../*.jsonl`
- OpenClaw/ArkClaw trajectory JSONL
- existing ARM trace JSONL

Validate an ARM trace before packaging:

```bash
playground trace validate --trace ./trace.jsonl
```

`trace convert` preserves the raw trajectory as `raw_messages.jsonl` with known token patterns redacted. `submit --trace <native trajectory>` also converts that trajectory into full replay steps instead of replacing it with a tiny wrapper trace.

## Upload / Download Challenges

```bash
playground task list --tag harbor --limit 20

playground task download \
  --challenge-id harbor-phys-15931-kaw-lh-filamentation \
  --out ./downloaded-challenge
```

On the public preview endpoint, `--challenge-id 1` is also accepted as a
1-based index into `playground task list`. The resolved string challenge id is
printed in the download JSON.

Use `--tag harbor` to show only Harbor tasks. Tags are also included in
`playground task list --json` for scripts.

If the challenge metadata declares datasets, `task download` also fetches those
files into `./downloaded-challenge/datasets/...` automatically. The implementation
uses the Playground data wrapper under the hood, but contestants do not need to call Trisol directly.
Use `--skip-datasets` only for metadata-only downloads.

When a challenge declares Trisol `model`/`models` and `dataset`/`datasets`
references, the same command writes `config.json` and downloads both resource kinds
under `models/` and `datasets/`. Use `--skip-models` only when weights are
intentionally unnecessary. References without versions resolve to the latest ready
Trisol version.

## Pull Dataset Files

For manual data access, keep the command in the Playground namespace:

```bash
playground data list --limit 20
playground data list --search benchmark --limit 20
playground data list --all

playground data pull \
  --dataset inria-aerial-image-labeling \
  --version v0.1 \
  --out ./data/inria-aerial/
```

The CLI uses built-in Playground data credentials for the prepared contest
datasets. It downloads the whole dataset version into the output directory; no
separate data-service login or internal data-range selection is required.
By default `data list` shows the first 20 team-visible rows to avoid dumping the
full operator catalog; `--all` fetches the complete team-visible catalog for
debugging or curation.

## Submit Outputs And Trace

Generate an ARM v1.1 zip and submit it as a Playground attempt:

```bash
playground submit \
  --challenge-id harbor-phys-15931-kaw-lh-filamentation \
  --outputs ./outputs \
  --report ./reproduction_report.md \
  --log ./logs \
  --trace ./trace_steps.json \
  --raw-messages ./raw_messages.jsonl \
  --model bohrclaw/aliyun/deepseek-v4-pro \
  --harness harbor-lbg
```

`--model` and `--harness` are the submitter's self-report and take priority.
When either is omitted, the CLI derives a best-effort value from the native
trace. The ARM manifest records the declared, detected, and finally resolved
values separately so operators can audit mismatches without silently replacing
the submitter's claim. `PLAYGROUND_MODEL` and `PLAYGROUND_HARNESS` provide the
same self-report fields for scripted environments.

If `--trace` points at a Harbor/OpenCode/Claude/OpenClaw native trace, the CLI converts it to ARM steps and also packages a redacted `raw_messages.jsonl` at the bundle root for Playground/ATIF-style replay.

When `--trace` is omitted, `playground submit` auto-detects live OpenCode,
Codex, and Claude Code traces under `/logs/agent`. If no native trace can be
found, submission fails and asks for `--trace PATH`; it never substitutes a
synthetic trace. `PLAYGROUND_TRACE` supports non-standard layouts.

Dry-run locally:

```bash
playground submit \
  --challenge-id harbor-phys-15931-kaw-lh-filamentation \
  --outputs ./outputs \
  --bundle-out ./playground-arm.zip \
  --dry-run
```

## Status

```bash
playground status --attempt-id 34 --bundle
```

Attempt traces are exposed at:

```bash
curl http://nwjs1473070.bohrium.tech:50002/api/attempts/34/trace
curl http://nwjs1473070.bohrium.tech:50002/api/attempts/34/raw_messages
```

The challenge UI links that endpoint from each attempt as
`#trace/<challenge-id>?attempt=<attempt-id>`.
