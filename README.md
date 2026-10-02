# ChatGPT Plan Test Project

A small **React + Vite + TypeScript + Tailwind CSS** proof of concept for OpenAI's **Sign in with ChatGPT** flow for local/open-source apps.

## Stack

- React
- Vite
- TypeScript
- Tailwind CSS v4
- Express API/OAuth server in TypeScript
- `jose` for ID-token verification
- Lucide React icons

## What it tests

- OAuth 2.0 Authorization Code + PKCE
- Dynamic agent registration with `client_id=dynamic_agent_client`
- Stable local `ext_agent_host_id`
- `chatgpt.tokens.use.direct` permission
- ID-token verification against OpenAI's JWKS
- Loading the signed-in account's model catalog
- Streaming a Responses API request using the OAuth access token
- Refreshing the OAuth access token
- No OpenAI API key and no client secret

## Run locally

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Then open:

```
http://127.0.0.1:1455
```

The Vite frontend runs on port **1455**. The local TypeScript OAuth/API server runs on **1456**, and Vite proxies `/auth` and `/api` to it.

Click **Continue with ChatGPT**, approve the requested permissions, choose one of the models returned for your account, then send a prompt.

## Local credentials

The OAuth credentials and stable host ID are stored in `.data/`.

That directory is ignored by Git and must never be committed.

## Responses API constraints

The proof of concept currently sends:

- `store: false`
- `stream: true`
- no `previous_response_id`
- the conversation input directly in `input`

## Production note

This is deliberately a local proof of concept. A production app should additionally use secure OS credential storage, stronger multi-session handling, explicit remote token revocation on sign-out, hardened error handling, and whatever deployment/registration requirements OpenAI applies to hosted apps.
