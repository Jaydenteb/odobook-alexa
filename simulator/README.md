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

### 1. Turn on the Claude model (as your admin/root user)

The old "Model access" page is gone in commercial Regions, and models are now enabled on first use. Anthropic
models have two extra prerequisites:

1. Open the Bedrock console in Sydney: <https://ap-southeast-2.console.aws.amazon.com/bedrock/home?region=ap-southeast-2>.
2. **Submit the Anthropic first-time-use form.** Go to **Model catalog → Claude Haiku 5.5** (or the
   [Anthropic provider page](https://console.aws.amazon.com/bedrock/home#/providers/anthropic)) and fill in the use-case
   details. If you have no company website, a GitHub/project URL is fine. You only do this once per account.
3. **Make the first call from the console.** Open Claude Haiku 5.5 in the **playground** and send one message.
   That first call subscribes the account to the model through AWS Marketplace, and it needs
   `aws-marketplace:Subscribe`/`ViewSubscriptions`/`Unsubscribe`. Your admin user has those, so the app's IAM user
   below never needs them. The account needs a valid payment method.
   - If the console says the agreement is pending, wait for AWS's email. You can check with
     `aws bedrock get-foundation-model-availability --model-id anthropic.claude-haiku-5-5 --region ap-southeast-2`
     using admin credentials, and wait until `agreementAvailability.status` is `AVAILABLE`.

### 2. Create the IAM user `odobook-bedrock`

IAM console → **Users → Create user** → name `odobook-bedrock`. Do **not** give it console access and do not attach
any managed policies. Then go to **Permissions → Add permissions → Create inline policy → JSON**, paste the policy
below with `ACCOUNT_ID` replaced, and name it `odobook-bedrock-converse`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeClaudeHaikuAuProfile",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:ap-southeast-2:ACCOUNT_ID:inference-profile/au.anthropic.claude-haiku-5-5"
    },
    {
      "Sid": "InvokeClaudeHaikuOnlyThroughAuProfile",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:ap-southeast-2::foundation-model/anthropic.claude-haiku-5-5",
        "arn:aws:bedrock:ap-southeast-4::foundation-model/anthropic.claude-haiku-5-5"
      ],
      "Condition": {
        "StringLike": {
          "bedrock:InferenceProfileArn": "arn:aws:bedrock:ap-southeast-2:ACCOUNT_ID:inference-profile/au.anthropic.claude-haiku-5-5"
        }
      }
    }
  ]
}
```

Why it looks like this:

- **`Converse` is authorised as `bedrock:InvokeModel`.** `ConverseStream` would need
  `bedrock:InvokeModelWithResponseStream`, but this brain doesn't stream, so that action is left out.
- **The inference profile and the foundation models both need permission.** With a cross-Region inference profile,
  IAM checks the profile ARN in the source Region (Sydney) *and* the foundation-model ARN in every Region the profile
  can route to. The `au.` profile called from Sydney routes to `ap-southeast-2` and `ap-southeast-4` (Melbourne).
  If the Melbourne ARN is missing, some calls fail with `AccessDeniedException` and others succeed.
- **The `bedrock:InferenceProfileArn` condition** means the user can reach the model only through that one AU profile,
  not directly or through a global profile.
- There is no `bedrock:ListInferenceProfiles` and no Marketplace permission. Do discovery and the first subscription
  with your admin credentials.

To use **Claude Sonnet 5.5** instead, change every `claude-haiku-5-5` in the policy to `claude-sonnet-5-5`, or add a
second pair of statements so the user can call both.

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
  --model-id au.anthropic.claude-haiku-5-5 \
  --messages '[{"role":"user","content":[{"text":"Say hello in five words."}]}]'
```

### 4. Find or confirm the model / inference-profile ID

The default is **`au.anthropic.claude-haiku-5-5`**, taken from the AWS model card for Claude Haiku 5.5. Its "Geo: AU"
profile routes from Sydney to Sydney and Melbourne. Claude Sonnet 5.5 has the matching profile
`au.anthropic.claude-sonnet-5-5`. Haiku is the default because a voice turn wants low latency and low cost; switch to
Sonnet if tool choice needs more judgement.

To list what your account can use from Sydney, use admin credentials, since the app user can't list:

```sh
aws bedrock list-inference-profiles --region ap-southeast-2 --type-equals SYSTEM_DEFINED \
  --query "inferenceProfileSummaries[?status=='ACTIVE' && contains(inferenceProfileId, 'anthropic')].[inferenceProfileId,inferenceProfileName]" \
  --output table

# Which Regions a profile can route to (every one needs a foundation-model ARN in the policy):
aws bedrock get-inference-profile --region ap-southeast-2 \
  --inference-profile-identifier au.anthropic.claude-haiku-5-5 --query 'models[].modelArn'
```

## Install and run

Node 22 or later. From this folder:

```sh
npm install --ignore-scripts
npm test            # unit tests, mocked Bedrock, no AWS calls
```

Run it with the Bedrock brain. `MCP_URL` and `MCP_CLIENT_ID` come from the repo's `.env` as before, and the AWS
credentials come from the profile:

```powershell
# PowerShell, from D:\NON EDU\alexa-logbook\simulator
$env:AWS_PROFILE = "odobook-bedrock"; $env:SIM_BRAIN = "bedrock"
node --env-file="../.env" run.mjs
```

```sh
# bash / WSL, from the simulator folder
AWS_PROFILE=odobook-bedrock SIM_BRAIN=bedrock node --env-file=../.env run.mjs
```

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
| `BEDROCK_MODEL_ID` | `au.anthropic.claude-haiku-5-5` | Any Converse-capable model ID, inference-profile ID or ARN. |
| `AWS_REGION` | `ap-southeast-2` | Region for the `bedrock-runtime` client. It has to be a source Region of the profile. |
| `AWS_PROFILE` | AWS default chain | Named profile, e.g. `odobook-bedrock`. Env keys, SSO and the rest of the standard chain also work. |
| `SIM_PORT` | `8790` | Simulator port. MCP Apps views use the next port up. |
| `SIM_UI` | `on` | `off` turns off MCP Apps (`ui://`) views to test the text fallback. |
| `SIM_TTS` | `browser` | `elevenlabs` plus `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` for server-side voice. |
| `ANTHROPIC_API_KEY`, `SIM_MODEL` | | Only for `SIM_BRAIN=claude`. |

## Costs

Bedrock bills **per token**: input tokens and output tokens are priced separately. There is no per-request or idle
charge. Anthropic models are billed through AWS Marketplace and show on your AWS bill under the model provider. See
<https://aws.amazon.com/bedrock/pricing/> for current rates for Claude Haiku 5.5 / Sonnet 5.5, including the
cross-Region (geo) rate.

What drives the token count here:

- **Every Converse call resends the system prompt, all tool definitions and the whole conversation.** One spoken
  turn that uses a tool is two calls, so long conversations get steadily more expensive. **Reset** in the simulator
  UI clears the history.
- Claude Haiku 5.5 and Sonnet 5.5 think adaptively by default, and thinking tokens are billed as output.
- A demo session of a few dozen turns on Haiku should cost cents, but set an **AWS Budgets** alert, for example at
  US$5/month, before leaving anything running.

## Troubleshooting

| Spoken / logged error | Likely cause |
| --- | --- |
| "Access was denied" (`AccessDeniedException`) | Anthropic first-time-use form not submitted or still pending. Model never invoked once from the console, so there's no Marketplace subscription. IAM policy missing the Melbourne (`ap-southeast-4`) foundation-model ARN. `ACCOUNT_ID` not replaced. |
| "model ... wasn't found" / "rejected as invalid" | `BEDROCK_MODEL_ID` misspelled, or `AWS_REGION` isn't a source Region for that profile (the `au.` profiles must be called from `ap-southeast-2` or `ap-southeast-4`). |
| "I don't have working AWS credentials" | `AWS_PROFILE` not set or misspelled, or `~/.aws/credentials` has no `[odobook-bedrock]` section. |
| "rate limiting me" | Bedrock on-demand quota. Wait, or request an increase in Service Quotas. |
