import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  CircleUserRound,
  LoaderCircle,
  LogOut,
  Send,
  Sparkles,
} from "lucide-react";

type Session =
  | { signedIn: false }
  | {
      signedIn: true;
      name: string | null;
      email: string | null;
      picture: string | null;
      scopes: string[];
    };

type Model = {
  slug: string;
  display_name?: string | null;
};

type ModelsResponse = {
  models: Model[];
};

const starterPrompt = "Say exactly: Hello from my ChatGPT subscription!";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState(starterPrompt);
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState("Checking connection…");
  const [sending, setSending] = useState(false);
  const isGitHubPages =
    window.location.hostname.endsWith("github.io");

  useEffect(() => {
    void initialise();
  }, []);

  const selectedLabel = useMemo(
    () => models.find((item) => item.slug === model)?.display_name || model,
    [models, model],
  );

  async function initialise() {
    if (isGitHubPages) {
      setSession({ signedIn: false });
      setStatus(
        "GitHub Pages is a static UI preview. Run the app locally to use ChatGPT sign-in.",
      );
      return;
    }

    try {
      const nextSession = await fetchJson<Session>("/api/session");
      setSession(nextSession);

      if (!nextSession.signedIn) {
        setStatus(
          isGitHubPages
            ? "GitHub Pages is a static UI preview. Run the app locally to use ChatGPT sign-in."
            : "Not connected yet.",
        );
        return;
      }

      setStatus("Connected. Loading models…");
      const data = await fetchJson<ModelsResponse>("/api/models");
      setModels(data.models);
      setModel(data.models[0]?.slug ?? "");
      setStatus(
        data.models.length
          ? `Loaded ${data.models.length} model${data.models.length === 1 ? "" : "s"} from your ChatGPT account.`
          : "Connected, but no displayable models were returned.",
      );
    } catch (error) {
      setStatus(getErrorMessage(error));
    }
  }

  async function signOut() {
    await fetch("/api/signout", { method: "POST" });
    setSession({ signedIn: false });
    setModels([]);
    setModel("");
    setOutput("");
    setStatus("Signed out.");
  }

  async function sendPrompt() {
    if (!prompt.trim() || !model || sending) return;

    setSending(true);
    setOutput("");
    setStatus(`Sending to ${selectedLabel || model}…`);

    try {
      const response = await fetch("/api/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: prompt.trim() }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      if (!response.body) {
        throw new Error("The response stream was empty.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          const dataLine = event
            .split("\n")
            .find((line) => line.startsWith("data: "));

          if (!dataLine) continue;

          const raw = dataLine.slice(6);
          if (raw === "[DONE]") continue;

          let data: {
            type?: string;
            delta?: string;
            response?: { error?: { message?: string; code?: string } };
          };

          try {
            data = JSON.parse(raw) as typeof data;
          } catch {
            continue;
          }

          if (data.type === "response.output_text.delta") {
            setOutput((current) => current + (data.delta ?? ""));
          } else if (data.type === "response.completed") {
            completed = true;
          } else if (data.type === "response.failed") {
            throw new Error(
              data.response?.error?.message ||
                data.response?.error?.code ||
                "Response failed.",
            );
          } else if (data.type === "response.incomplete") {
            throw new Error("Response was incomplete.");
          }
        }
      }

      if (!completed) {
        throw new Error("The stream ended before response.completed.");
      }

      setStatus(
        `Completed with ${selectedLabel || model} using the authorised ChatGPT-plan token.`,
      );
    } catch (error) {
      setStatus(getErrorMessage(error));
      setOutput((current) => current || "No response text received.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,197,94,0.12),transparent_32rem),radial-gradient(circle_at_80%_10%,rgba(59,130,246,0.11),transparent_28rem)]" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-5xl items-center px-5 py-10 sm:px-8">
        <section className="w-full overflow-hidden rounded-3xl border border-white/10 bg-zinc-900/80 shadow-2xl shadow-black/40 backdrop-blur-xl">
          <div className="border-b border-white/10 px-6 py-6 sm:px-8">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400">
              <Sparkles className="h-3.5 w-3.5" />
              ChatGPT plan proof of concept
            </div>

            <div className="max-w-3xl">
              <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
                Use ChatGPT from your own app.
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-400 sm:text-lg">
                Sign in with ChatGPT, load the models available to your account,
                then send a real Responses API request without pasting an API key.
              </p>
            </div>
          </div>

          <div className="p-6 sm:p-8">
            {session === null ? (
              <LoadingState />
            ) : !session.signedIn ? (
              <SignedOut status={status} isGitHubPages={isGitHubPages} />
            ) : (
              <SignedIn
                session={session}
                models={models}
                model={model}
                setModel={setModel}
                prompt={prompt}
                setPrompt={setPrompt}
                output={output}
                status={status}
                sending={sending}
                onSend={sendPrompt}
                onSignOut={signOut}
              />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function LoadingState() {
  return (
    <div className="flex min-h-52 items-center justify-center text-zinc-400">
      <LoaderCircle className="mr-3 h-5 w-5 animate-spin" />
      Checking your ChatGPT connection…
    </div>
  );
}

function SignedOut({
  status,
  isGitHubPages,
}: {
  status: string;
  isGitHubPages: boolean;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
      <div className="rounded-2xl border border-white/10 bg-black/20 p-6 sm:p-8">
        <CircleUserRound className="h-10 w-10 text-zinc-300" />
        <h2 className="mt-5 text-2xl font-semibold">Connect your account</h2>
        <p className="mt-2 max-w-xl leading-7 text-zinc-400">
          This uses OpenAI's OAuth flow with PKCE and requests permission for
          eligible ChatGPT-plan model usage.
        </p>

        {isGitHubPages ? (
          <div className="mt-6 rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm leading-6 text-amber-100">
            GitHub Pages can host this React UI, but not the local OAuth/API
            server. Clone the repo and run <code className="font-mono">npm run dev</code>
            to test Continue with ChatGPT.
          </div>
        ) : (
          <a
            href="/auth/start"
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 font-semibold text-zinc-950 transition hover:bg-zinc-200"
          >
            Continue with ChatGPT
            <ArrowRight className="h-4 w-4" />
          </a>
        )}
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <p className="text-sm font-semibold text-zinc-300">What we're testing</p>
        <ul className="mt-4 space-y-3 text-sm leading-6 text-zinc-400">
          {[
            "No OpenAI API key in the project",
            "Models loaded from the signed-in account",
            "Streaming Responses API request",
            "Local credentials kept out of Git",
          ].map((item) => (
            <li key={item} className="flex gap-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-6 text-xs text-zinc-500">{status}</p>
      </div>
    </div>
  );
}

type SignedInProps = {
  session: Extract<Session, { signedIn: true }>;
  models: Model[];
  model: string;
  setModel: (value: string) => void;
  prompt: string;
  setPrompt: (value: string) => void;
  output: string;
  status: string;
  sending: boolean;
  onSend: () => void;
  onSignOut: () => void;
};

function SignedIn({
  session,
  models,
  model,
  setModel,
  prompt,
  setPrompt,
  output,
  status,
  sending,
  onSend,
  onSignOut,
}: SignedInProps) {
  return (
    <div className="grid gap-6 lg:grid-cols-[0.72fr_1.28fr]">
      <aside className="space-y-5">
        <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
          <div className="flex items-center gap-3">
            {session.picture ? (
              <img
                src={session.picture}
                alt=""
                className="h-11 w-11 rounded-full border border-white/10"
              />
            ) : (
              <div className="grid h-11 w-11 place-items-center rounded-full bg-white/5">
                <CircleUserRound className="h-6 w-6 text-zinc-400" />
              </div>
            )}

            <div className="min-w-0">
              <div className="truncate font-semibold">
                {session.name || "ChatGPT connected"}
              </div>
              <div className="truncate text-sm text-zinc-500">
                {session.email || "Signed in"}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onSignOut}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-white/5"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="text-sm font-medium text-zinc-300">Connection status</div>
          <p className="mt-2 text-sm leading-6 text-zinc-500">{status}</p>
        </div>
      </aside>

      <section className="rounded-2xl border border-white/10 bg-black/20 p-5 sm:p-6">
        <label htmlFor="model" className="text-sm font-medium text-zinc-300">
          Model
        </label>
        <select
          id="model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className="mt-2 w-full rounded-xl border border-white/10 bg-zinc-950 px-3 py-3 text-zinc-100 outline-none transition focus:border-white/25"
        >
          {models.length === 0 ? (
            <option value="">No models loaded</option>
          ) : (
            models.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.display_name || item.slug}
              </option>
            ))
          )}
        </select>

        <label
          htmlFor="prompt"
          className="mt-5 block text-sm font-medium text-zinc-300"
        >
          Prompt
        </label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={7}
          className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-zinc-950 px-4 py-3 leading-7 text-zinc-100 outline-none transition placeholder:text-zinc-700 focus:border-white/25"
        />

        <button
          type="button"
          onClick={onSend}
          disabled={sending || !model || !prompt.trim()}
          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {sending ? "Generating…" : "Send with my ChatGPT plan"}
        </button>

        <div className="mt-6 overflow-hidden rounded-2xl border border-white/10">
          <div className="border-b border-white/10 bg-white/[0.03] px-4 py-3 text-xs font-semibold uppercase tracking-[0.15em] text-zinc-500">
            Response
          </div>
          <pre className="min-h-36 whitespace-pre-wrap px-4 py-4 font-mono text-sm leading-7 text-zinc-300">
            {output || "Nothing sent yet."}
          </pre>
        </div>
      </section>
    </div>
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const text = await response.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(text || `Request failed with status ${response.status}.`);
  }

  if (!response.ok) {
    const maybeError = parsed as { error?: string };
    throw new Error(maybeError.error || text);
  }

  return parsed as T;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
