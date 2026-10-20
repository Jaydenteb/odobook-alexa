# Odobook voice simulator with an Amazon Bedrock brain

This folder runs the community [mcp-voice-simulator](https://github.com/AlSayedGamal/mcp-voice-simulator) (MIT, v0.2.2)
against the Odobook MCP server, using a **custom "brain" powered by Amazon Bedrock**.

The simulator plays the part of an Alexa-style voice host. It links an account with OAuth 2.1 + PKCE, lists the
server's MCP tools and turns each spoken utterance into tool calls plus a short spoken reply. The part that
decides which tool to call and what to say is the *brain*. Here that brain is Claude on **Amazon Bedrock**,
called through the **Bedrock Runtime Converse API** with the AWS SDK for JavaScript v3.

## Why (AWS Builder)

The AWS Builder challenge asks for AWS services used in the project, with documented integrations.
In this setup:

- **Amazon Bedrock (Converse API)** is the language model behind the voice assistant. Each utterance is one or more
  `Converse` calls with the MCP server's tools passed as a Converse `toolConfig`.
- **Bedrock cross-Region inference (AU geography)** keeps inference in Australia. Called from Sydney
  (`ap-southeast-2`), the `au.` inference profile routes only to Sydney and Melbourne (`ap-southeast-4`).
- **IAM** gives the app a least-privilege identity that can invoke one model through one inference profile and
  nothing else.

```
 you (voice/text) ──> mcp-voice-simulator (localhost:8790)
                           │  Brain interface: turn(utterance) -> { reply, trace }
                           ▼
                     bedrock-brain.mjs ── Converse(toolConfig = MCP tools) ──> Amazon Bedrock
                           │                                                  (Claude, AU profile)
                           │  toolUse -> callTool() -> toolResult
                           ▼
                Odobook MCP server (Cloudflare Worker, OAuth 2.1 + PKCE)
```

## Files

| File | What it is |
| --- | --- |
| `bedrock-brain.mjs` | `createBedrockBrain()`, which implements the simulator's `Brain` interface on the Converse API. |
| `run.mjs` | Launcher: `createServer()` + `McpSessionManager` + the brain chosen by `SIM_BRAIN`. |
| `test/bedrock-brain.test.mjs` | Unit tests that use a mocked Bedrock client and MCP session (`node --test`). No AWS calls. |
| `package.json` | This folder's own pinned dependencies. The Worker's root `package.json` is separate. |

## How the brain maps onto the simulator

The simulator's `Brain` interface is `{ name, turn(utterance): Promise<{ reply, trace }>, reset?() }`.

1. **Tools.** On each turn the brain reads `session.tools` (from MCP `tools/list`) and converts each one to a Converse
   `toolSpec`: `{ name, description, inputSchema: { json: <the MCP JSON Schema> } }`. If an MCP tool name has
   characters Converse doesn't allow, the brain renames it for Bedrock and maps it back when the tool is called.
2. **Loop.** It calls `Converse` with the system prompt, the conversation so far and the `toolConfig`. For every
   `toolUse` block it calls the MCP tool through the simulator's own `callTool()`, which also records it in the trace
   the UI shows. It then answers with a `toolResult` block (`status: "error"` when the MCP result has `isError`). This
   repeats until the model replies with text only, for at most 6 rounds.
3. **Reply.** The text blocks are joined into the spoken reply. The system prompt has the same intent as the
   simulator's built-in Claude brain: one to three short sentences, no markdown, preview before confirming anything,
   and report tool errors plainly.
4. **Errors.**
   - A Bedrock failure (access denied, throttling, a wrong model ID, missing credentials) becomes a short spoken
     sentence and the full error is logged. It is not thrown, because the simulator treats a thrown error as a dead
     MCP session and would make you re-link your account.
   - An MCP transport failure *is* rethrown, so the simulator re-links as it normally does.
   - Either way, the failed turn is removed from the history, so the next turn starts from a valid conversation.
5. **`reset()`** clears the conversation history.

## AWS setup (one time)

All steps use the **Asia Pacific (Sydney) `ap-southeast-2`** Region. Replace `ACCOUNT_ID` with your 12-digit AWS
account ID. The console shows it in the top-right menu; with admin credentials, `aws sts get-caller-identity` prints it.

### 1. Check the model works (as your admin/root user)

The default model is **Amazon Nova 2 Lite**, reached from Sydney through the **global** cross-Region inference
profile `global.amazon.nova-2-lite-v1:0` (Nova 2 Lite has no in-Region or AU route from Sydney, so requests may be
served in other Regions). Amazon models need no use-case form: open the Bedrock console in Sydney, pick **Nova 2 Lite**
in the playground and send one message.

> We first tried Claude Haiku 5.5 (`au.anthropic.claude-haiku-5-5`). After submitting Anthropic's use-case form, the
> playground still answered `AccessDeniedException: ... is not available for this account`, a restriction that is common
> on new accounts. Nova worked straight away. To use a Claude model instead once your account allows it, set
> `BEDROCK_MODEL_ID` and change the model names in the policy below.

### 2. Create the IAM user `odobook-bedrock`

IAM console → **Users → Create user** → name `odobook-bedrock`. Do **not** give it console access and do not attach
any managed policies. Then go to **Permissions → Add permissions → Create inline policy → JSON**, paste the policy
below with `ACCOUNT_ID` replaced, and name it `odobook-bedrock-converse`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeNovaGlobalProfile",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:ap-southeast-2:ACCOUNT_ID:inference-profile/global.amazon.nova-2-lite-v1:0"
    },
    {
      "Sid": "InvokeNovaOnlyThroughThatProfile",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0",
        "arn:aws:bedrock:::foundation-model/amazon.nova-2-lite-v1:0"
      ],
      "Condition": {
        "StringLike": {
          "bedrock:InferenceProfileArn": "arn:aws:bedrock:ap-southeast-2:ACCOUNT_ID:inference-profile/global.amazon.nova-2-lite-v1:0"
        }
      }
    }
  ]
}
```

Why it looks like this:

- **`Converse` is authorised as `bedrock:InvokeModel`.** `ConverseStream` would need
  `bedrock:InvokeModelWithResponseStream`, but this brain doesn't stream.
- **The inference profile and the foundation model both need permission.** A global profile can route to any
  commercial Region, so the foundation-model ARNs use a Region wildcard plus the Region-less global form.
- **The `bedrock:InferenceProfileArn` condition** means the user can reach the model only through that one profile.
- Verified live on 20 Oct 2026: with exactly this policy, a Converse call with a tool returned `stopReason: tool_use`
  in about 1.2 s.

### 3. Create an access key and a CLI profile

IAM → Users → `odobook-bedrock` → **Security credentials → Create access key → Command Line Interface (CLI)**.
Copy the key ID and secret. They are shown once and must never be committed.

```sh
aws configure --profile odobook-bedrock
# AWS Access Key ID:     <key id>
# AWS Secret Access Key: <secret>
# Default region name:   ap-southeast-2
# Default output format: json
```

The keys go into `~/.aws/credentials` under `[odobook-bedrock]`, not into this repo or `.env`.

Check that the user can call the model. Each check costs a few tokens.

```sh
aws bedrock-runtime converse --profile odobook-bedrock --region ap-southeast-2 \
  --model-id global.amazon.nova-2-lite-v1:0 \
  --messages '[{"role":"user","content":[{"text":"Say hello in five words."}]}]'
```

### 4. Find or confirm the model / inference-profile ID

The default is **`global.amazon.nova-2-lite-v1:0`**, from the AWS model card for Nova 2 Lite: from Sydney it's offered
only through the global profile. It's fast and cheap, which suits a voice turn. Any Converse-capable model your account
can use works through `BEDROCK_MODEL_ID` (with a matching policy).

To list what your account can use from Sydney, use admin credentials, since the app user can't list:

```sh
aws bedrock list-inference-profiles --region ap-southeast-2 --type-equals SYSTEM_DEFINED \
  --query "inferenceProfileSummaries[?status=='ACTIVE' && contains(inferenceProfileId, 'nova')].[inferenceProfileId,inferenceProfileName]" \
  --output table

# Which Regions a profile can route to (every one needs a foundation-model ARN in the policy):
aws bedrock get-inference-profile --region ap-southeast-2 \
  --inference-profile-identifier global.amazon.nova-2-lite-v1:0 --query 'models[].modelArn'
```

## Install and run

Node 22 or later. From this folder:

```sh
npm install --ignore-scripts
npm test            # unit tests, mocked Bedrock, no AWS calls
```

Run it with the Bedrock brain. `MCP_CLIENT_ID` is the public client registered with `POST /admin/clients`
(redirect `http://127.0.0.1/callback`, any port), and the AWS credentials come from the profile:

```sh
# bash, from the simulator folder
SIM_BRAIN=bedrock AWS_PROFILE=odobook-bedrock AWS_REGION=ap-southeast-2 \
MCP_URL=https://odobook-alexa.odobook-alexa.workers.dev/mcp MCP_CLIENT_ID=<client id> \
node run.mjs
```

On Windows with the AWS CLI configured inside WSL, point the SDK at the WSL files instead of installing the CLI twice:
`AWS_SHARED_CREDENTIALS_FILE=//wsl.localhost/Ubuntu-24.04/home/<user>/.aws/credentials` and
`AWS_CONFIG_FILE=//wsl.localhost/Ubuntu-24.04/home/<user>/.aws/config`.

Then open <http://127.0.0.1:8790>, link the Odobook account when prompted and talk to it. The startup banner prints
the brain, model and Region it's using.

Set `SIM_BRAIN` on the command line as shown. Node's `--env-file` doesn't override variables that are already set,
so the shell value wins over anything in `.env`.

To run the original Anthropic API brain, use `SIM_BRAIN=claude` with `ANTHROPIC_API_KEY` and an optional `SIM_MODEL`.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_URL` | (required) | The Odobook MCP endpoint, e.g. `https://odobook-alexa.odobook-alexa.workers.dev/mcp`. |
| `MCP_CLIENT_ID` | dynamic registration | Pre-registered OAuth client ID. |
| `SIM_BRAIN` | `bedrock` | `bedrock` or `claude`. |
| `BEDROCK_MODEL_ID` | `global.amazon.nova-2-lite-v1:0` | Any Converse-capable model ID, inference-profile ID or ARN. |
| `AWS_REGION` | `ap-southeast-2` | Region for the `bedrock-runtime` client. It has to be a source Region of the profile. |
| `AWS_PROFILE` | AWS default chain | Named profile, e.g. `odobook-bedrock`. Env keys, SSO and the rest of the standard chain also work. |
| `SIM_PORT` | `8790` | Simulator port. MCP Apps views use the next port up. |
| `SIM_UI` | `on` | `off` turns off MCP Apps (`ui://`) views to test the text fallback. |
| `SIM_TTS` | `browser` | `elevenlabs` plus `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` for server-side voice. |
| `ANTHROPIC_API_KEY`, `SIM_MODEL` | | Only for `SIM_BRAIN=claude`. |

## Costs

Bedrock bills **per token**: input tokens and output tokens are priced separately. There is no per-request or idle
charge. See <https://aws.amazon.com/bedrock/pricing/> for current Nova 2 Lite rates.

What drives the token count here:

- **Every Converse call resends the system prompt, all tool definitions and the whole conversation.** One spoken
  turn that uses a tool is two calls, so long conversations get steadily more expensive. **Reset** in the simulator
  UI clears the history.
- Nova 2 Lite reasons before answering by default, and reasoning tokens are billed as output.
- A demo session of a few dozen turns should cost cents, but set an **AWS Budgets** alert, for example at
  US$5/month, before leaving anything running.

## Troubleshooting

| Spoken / logged error | Likely cause |
| --- | --- |
| "Access was denied" (`AccessDeniedException`) | Anthropic first-time-use form not submitted or still pending. Model never invoked once from the console, so there's no Marketplace subscription. IAM policy missing the Melbourne (`ap-southeast-4`) foundation-model ARN. `ACCOUNT_ID` not replaced. |
| "model ... wasn't found" / "rejected as invalid" | `BEDROCK_MODEL_ID` misspelled, or `AWS_REGION` isn't a source Region for that profile (the `au.` profiles must be called from `ap-southeast-2` or `ap-southeast-4`). |
| "I don't have working AWS credentials" | `AWS_PROFILE` not set or misspelled, or `~/.aws/credentials` has no `[odobook-bedrock]` section. |
| "rate limiting me" | Bedrock on-demand quota. Wait, or request an increase in Service Quotas. |
