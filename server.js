import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

const PORT = 1455;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CALLBACK_URL = `${BASE_URL}/auth/callback`;
const RESOURCE = "https://api.openai.com/v1";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const JWKS = createRemoteJWKSet(new URL("https://auth.openai.com/.well-known/jwks.json"));
const ISSUER = "https://auth.openai.com";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

const DATA_DIR = path.join(process.cwd(), ".data");
const HOST_ID_FILE = path.join(DATA_DIR, "host-id");
const CREDENTIALS_FILE = path.join(DATA_DIR, "credentials.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

function getHostId() {
  if (fs.existsSync(HOST_ID_FILE)) {
    return fs.readFileSync(HOST_ID_FILE, "utf8").trim();
  }
  const id = `urn:uuid:${crypto.randomUUID()}`;
  fs.writeFileSync(HOST_ID_FILE, id, { mode: 0o600 });
  return id;
}

function readCredentials() {
  if (!fs.existsSync(CREDENTIALS_FILE)) return null;
  return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
}

function writeCredentials(credentials) {
  const tmp = `${CREDENTIALS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CREDENTIALS_FILE);
}

function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function parseScopes(scope = "") {
  return scope.split(/\s+/).filter(Boolean);
}

let pendingAuth = null;

async function exchangeCode({ code, clientId, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: CALLBACK_URL,
    resource: RESOURCE,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function refreshAccessToken(credentials) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: credentials.client_id,
    refresh_token: credentials.refresh_token,
    resource: RESOURCE,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${JSON.stringify(json)}`);
  }

  const updated = {
    ...credentials,
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? credentials.refresh_token,
    id_token: json.id_token ?? credentials.id_token,
    expires_in: json.expires_in,
    scopes: parseScopes(json.scope ?? credentials.scopes.join(" ")),
    saved_at: new Date().toISOString(),
  };
  writeCredentials(updated);
  return updated;
}

async function getUsableCredentials() {
  let credentials = readCredentials();
  if (!credentials) return null;

  const savedAt = Date.parse(credentials.saved_at);
  const expiresAt = savedAt + Number(credentials.expires_in || 3600) * 1000;
  if (Date.now() > expiresAt - 60_000 && credentials.refresh_token) {
    credentials = await refreshAccessToken(credentials);
  }
  return credentials;
}

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.get("/auth/start", (req, res) => {
  const existing = readCredentials();
  const state = randomBase64Url();
  const nonce = randomBase64Url();
  const codeVerifier = randomBase64Url(64);
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  pendingAuth = { state, nonce, codeVerifier, createdAt: Date.now() };

  const params = new URLSearchParams({
    client_id: existing?.client_id ?? "dynamic_agent_client",
    response_type: "code",
    redirect_uri: CALLBACK_URL,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    ext_agent_host_id: getHostId(),
  });

  if (existing?.client_id) {
    if (existing.id_token) params.set("id_token_hint", existing.id_token);
    if (existing.email) params.set("login_hint", existing.email);
  } else {
    params.set("agent_name_hint", "ChatGPT Plan Test Project");
  }

  res.redirect(`${AUTHORIZE_URL}?${params.toString()}`);
});

app.get("/auth/callback", async (req, res) => {
  try {
    if (!pendingAuth || Date.now() - pendingAuth.createdAt > 10 * 60 * 1000) {
      throw new Error("No active sign-in attempt, or the attempt expired.");
    }

    if (req.query.state !== pendingAuth.state) {
      throw new Error("OAuth state did not match.");
    }

    if (req.query.error) {
      throw new Error(`Authorization failed: ${req.query.error}`);
    }

    const existing = readCredentials();
    const issuedClientId = String(req.query.client_id || existing?.client_id || "");
    if (!issuedClientId || issuedClientId === "dynamic_agent_client") {
      throw new Error("OpenAI did not return an issued client ID.");
    }
    if (existing?.client_id && issuedClientId !== existing.client_id) {
      throw new Error("Returned client ID did not match the saved account.");
    }

    const token = await exchangeCode({
      code: String(req.query.code || ""),
      clientId: issuedClientId,
      codeVerifier: pendingAuth.codeVerifier,
    });

    const { payload } = await jwtVerify(token.id_token, JWKS, {
      issuer: ISSUER,
      audience: issuedClientId,
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 5,
    });

    if (payload.nonce !== pendingAuth.nonce) {
      throw new Error("ID token nonce did not match.");
    }

    const scopes = parseScopes(token.scope);
    if (!scopes.includes("chatgpt.tokens.use.direct")) {
      throw new Error("ChatGPT plan usage permission was not granted.");
    }

    writeCredentials({
      email: payload.email ?? null,
      name: payload.name ?? null,
      picture: payload.picture ?? null,
      issuer: ISSUER,
      subject: payload.sub,
      client_id: issuedClientId,
      ext_agent_host_id: getHostId(),
      id_token: token.id_token,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_type: token.token_type,
      expires_in: token.expires_in,
      scopes,
      saved_at: new Date().toISOString(),
    });

    pendingAuth = null;
    res.redirect("/?connected=1");
  } catch (error) {
    pendingAuth = null;
    res.status(500).send(`<h1>Sign-in failed</h1><pre>${escapeHtml(error.message)}</pre><p><a href="/">Back</a></p>`);
  }
});

app.get("/api/session", async (req, res) => {
  try {
    const credentials = await getUsableCredentials();
    if (!credentials) return res.json({ signedIn: false });
    res.json({
      signedIn: true,
      email: credentials.email,
      name: credentials.name,
      picture: credentials.picture,
      scopes: credentials.scopes,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/models", async (req, res) => {
  try {
    const credentials = await getUsableCredentials();
    if (!credentials) return res.status(401).json({ error: "Not signed in." });

    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${credentials.access_token}` },
    });
    const json = await response.json();
    if (!response.ok) return res.status(response.status).json(json);

    const models = (json.models || [])
      .filter((model) => model.visibility === "list")
      .map((model) => ({ slug: model.slug, display_name: model.display_name }));

    res.json({ models });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/respond", async (req, res) => {
  try {
    const credentials = await getUsableCredentials();
    if (!credentials) return res.status(401).json({ error: "Not signed in." });

    const { model, prompt } = req.body || {};
    if (!model || !prompt) {
      return res.status(400).json({ error: "model and prompt are required." });
    }

    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [{ role: "user", content: prompt }],
        store: false,
        stream: true,
      }),
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(upstream.status).send(body);
    }

    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
});

app.post("/api/signout", (req, res) => {
  if (fs.existsSync(CREDENTIALS_FILE)) fs.unlinkSync(CREDENTIALS_FILE);
  res.json({ ok: true });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`ChatGPT plan POC running at ${BASE_URL}`);
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
