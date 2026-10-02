# ChatGPT Plan Test Project

A tiny open-source proof of concept for OpenAI's **Sign in with ChatGPT** flow for local/open-source apps.

It demonstrates:

- OAuth 2.0 Authorization Code + PKCE.
- Dynamic agent registration with `client_id=dynamic_agent_client`.
- A stable local `ext_agent_host_id`.
- Requesting `chatgpt.tokens.use.direct`.
- ID-token verification against OpenAI's JWKS.
- Loading the signed-in account's model catalog.
- Streaming a Responses API request using the OAuth access token.
- Refreshing the access token when it expires.
- No OpenAI API key and no client secret.

## Run it

Requires Node.js 20+.

```bash
npm install
npm start
```

Then open:

```
http://127.0.0.1:1455
```

Click **Continue with ChatGPT**, approve the requested permissions, choose a model, and send a prompt.

## Important

This proof of concept is deliberately a **local app** because OpenAI's open-source ChatGPT-plan flow uses an HTTP loopback callback on `127.0.0.1`.

Credentials and the host ID are stored in `.data/` and excluded from Git. Do not commit that directory.

The Responses API request follows the current preview requirements for ChatGPT-plan usage:

- `store: false`
- `stream: true`
- no `previous_response_id`
- the required conversation context is sent in `input`

For a production-quality app, add stronger session/account management, secure OS credential storage, explicit remote token revocation on sign-out, and fuller error handling.
