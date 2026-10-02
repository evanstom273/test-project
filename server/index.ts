import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

const API_PORT = 1456;
const WEB_URL = "http://127.0.0.1:1455";
const API_URL = `http://127.0.0.1:${API_PORT}`;
const CALLBACK_URL = `${API_URL}/auth/callback`;

const RESOURCE = "https://api.openai.com/v1";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const ISSUER = "https://auth.openai.com";
const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

const JWKS = createRemoteJWKSet(
  new URL("https://auth.openai.com/.well-known/jwks.json"),
);

const DATA_DIR = path.join(process.cwd(), ".data");
const HOST_ID_FILE = path.join(DATA_DIR, "host-id");
const CREDENTIALS_FILE = path.join(DATA_DIR, "credentials.json");

type Credentials = {
  email: string | null;
  name: string | null;
  picture: string | null;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  id_token: string;
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scopes: string[];
  saved_at: string;
};

type PendingAuth = {
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
};

type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

type ModelRecord = {
  slug?: string;
  id?: string;
  display_name?: string;
  visibility?: string;
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function getHostId() {
  if (fs.existsSync(HOST_ID_FILE)) {
    return fs.readFileSync(HOST_ID_FILE, "utf8").trim();
  }

  const id = `urn:uuid:${crypto.randomUUID()}`;
  fs.writeFileSync(HOST_ID_FILE, id, { mode: 0o600 });
  return id;
}

function readCredentials(): Credentials | null {
  if (!fs.existsSync(CREDENTIALS_FILE)) return null;

  return JSON.parse(
    fs.readFileSync(CREDENTIALS_FILE, "utf8"),
  ) as Credentials;
}

function writeCredentials(credentials: Credentials) {
  const tempPath = `${CREDENTIALS_FILE}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(tempPath, CREDENTIALS_FILE);
}

function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function parseScopes(scope = "") {
  return scope.split(/\s+/).filter(Boolean);
}

async function readJson<T>(response: globalThis.Response): Promise<T> {
  const json = (await response.json()) as T;
  return json;
}

async function exchangeCode(args: {
  code: string;
  clientId: string;
  codeVerifier: string;
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: args.clientId,
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: CALLBACK_URL,
    resource: RESOURCE,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await readJson<OAuthTokenResponse & { error?: unknown }>(
    response,
  );

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${JSON.stringify(json)}`);
  }

  return json;
}

async function refreshAccessToken(credentials: Credentials) {
  if (!credentials.refresh_token) {
    throw new Error("No refresh token is available.");
  }

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

  const json = await readJson<OAuthTokenResponse & { error?: unknown }>(
    response,
  );

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${JSON.stringify(json)}`);
  }

  const updated: Credentials = {
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
  const expiresAt =
    savedAt + Number(credentials.expires_in ?? 3600) * 1000;

  if (
    Date.now() > expiresAt - 60_000 &&
    credentials.refresh_token
  ) {
    credentials = await refreshAccessToken(credentials);
  }

  return credentials;
}

let pendingAuth: PendingAuth | null = null;

const app = express();
app.use(express.json());

app.get("/auth/start", (_req: Request, res: Response) => {
  const existing = readCredentials();
  const state = randomBase64Url();
  const nonce = randomBase64Url();
  const codeVerifier = randomBase64Url(64);
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  pendingAuth = {
    state,
    nonce,
    codeVerifier,
    createdAt: Date.now(),
  };

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
    if (existing.id_token) {
      params.set("id_token_hint", existing.id_token);
    }

    if (existing.email) {
      params.set("login_hint", existing.email);
    }
  } else {
    params.set("agent_name_hint", "ChatGPT Plan Test Project");
  }

  res.redirect(`${AUTHORIZE_URL}?${params.toString()}`);
});

app.get("/auth/callback", async (req: Request, res: Response) => {
  try {
    if (
      !pendingAuth ||
      Date.now() - pendingAuth.createdAt > 10 * 60 * 1000
    ) {
      throw new Error(
        "No active sign-in attempt, or the attempt expired.",
      );
    }

    if (String(req.query.state ?? "") !== pendingAuth.state) {
      throw new Error("OAuth state did not match.");
    }

    if (req.query.error) {
      throw new Error(
        `Authorization failed: ${String(req.query.error)}`,
      );
    }

    const existing = readCredentials();
    const issuedClientId = String(
      req.query.client_id ?? existing?.client_id ?? "",
    );

    if (
      !issuedClientId ||
      issuedClientId === "dynamic_agent_client"
    ) {
      throw new Error("OpenAI did not return an issued client ID.");
    }

    if (
      existing?.client_id &&
      issuedClientId !== existing.client_id
    ) {
      throw new Error(
        "Returned client ID did not match the saved account.",
      );
    }

    const token = await exchangeCode({
      code: String(req.query.code ?? ""),
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
      throw new Error(
        "ChatGPT plan usage permission was not granted.",
      );
    }

    const subject = payload.sub;
    if (typeof subject !== "string") {
      throw new Error("ID token subject was missing or invalid.");
    }

    writeCredentials({
      email:
        typeof payload.email === "string" ? payload.email : null,
      name:
        typeof payload.name === "string" ? payload.name : null,
      picture:
        typeof payload.picture === "string" ? payload.picture : null,
      issuer: ISSUER,
      subject,
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
    res.redirect(`${WEB_URL}/?connected=1`);
  } catch (error) {
    pendingAuth = null;
    const message =
      error instanceof Error ? error.message : "Sign-in failed.";

    res.redirect(
      `${WEB_URL}/?authError=${encodeURIComponent(message)}`,
    );
  }
});

app.get("/api/session", async (_req: Request, res: Response) => {
  try {
    const credentials = await getUsableCredentials();

    if (!credentials) {
      res.json({ signedIn: false });
      return;
    }

    res.json({
      signedIn: true,
      email: credentials.email,
      name: credentials.name,
      picture: credentials.picture,
      scopes: credentials.scopes,
    });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/models", async (_req: Request, res: Response) => {
  try {
    const credentials = await getUsableCredentials();

    if (!credentials) {
      res.status(401).json({ error: "Not signed in." });
      return;
    }

    const response = await fetch("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${credentials.access_token}`,
      },
    });

    const json = await readJson<{
      models?: ModelRecord[];
      data?: ModelRecord[];
      error?: unknown;
    }>(response);

    if (!response.ok) {
      res.status(response.status).json(json);
      return;
    }

    const source = json.models ?? json.data ?? [];
    const models = source
      .filter((item) => item.visibility === undefined || item.visibility === "list")
      .map((item) => ({
        slug: item.slug ?? item.id,
        display_name: item.display_name ?? item.slug ?? item.id,
      }))
      .filter(
        (item): item is { slug: string; display_name: string } =>
          Boolean(item.slug),
      );

    res.json({ models });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/respond", async (req: Request, res: Response) => {
  try {
    const credentials = await getUsableCredentials();

    if (!credentials) {
      res.status(401).json({ error: "Not signed in." });
      return;
    }

    const model =
      typeof req.body?.model === "string" ? req.body.model : "";
    const prompt =
      typeof req.body?.prompt === "string" ? req.body.prompt : "";

    if (!model || !prompt) {
      res
        .status(400)
        .json({ error: "model and prompt are required." });
      return;
    }

    const upstream = await fetch(
      "https://api.openai.com/v1/responses",
      {
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
      },
    );

    if (!upstream.ok) {
      const body = await upstream.text();
      res.status(upstream.status).send(body);
      return;
    }

    if (!upstream.body) {
      res.status(502).json({
        error: "OpenAI returned an empty response stream.",
      });
      return;
    }

    res.status(200);
    res.setHeader(
      "content-type",
      "text/event-stream; charset=utf-8",
    );
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
      res.status(500).json({ error: getErrorMessage(error) });
    } else {
      res.end();
    }
  }
});

app.post("/api/signout", (_req: Request, res: Response) => {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    fs.unlinkSync(CREDENTIALS_FILE);
  }

  res.json({ ok: true });
});

app.listen(API_PORT, "127.0.0.1", () => {
  console.log(`OAuth/API server running at ${API_URL}`);
});

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
