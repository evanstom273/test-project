const signedOut = document.querySelector("#signed-out");
const signedIn = document.querySelector("#signed-in");
const modelSelect = document.querySelector("#model");
const output = document.querySelector("#output");
const status = document.querySelector("#status");
const sendButton = document.querySelector("#send");

init();

async function init() {
  try {
    const session = await fetchJson("/api/session");
    if (!session.signedIn) return;

    signedOut.hidden = true;
    signedIn.hidden = false;

    document.querySelector("#account-name").textContent = session.name || "ChatGPT connected";
    document.querySelector("#account-email").textContent = session.email || "";

    const avatar = document.querySelector("#avatar");
    if (session.picture) {
      avatar.src = session.picture;
      avatar.hidden = false;
    }

    status.textContent = "Connected. Loading models…";
    const { models } = await fetchJson("/api/models");

    modelSelect.innerHTML = "";
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.slug;
      option.textContent = model.display_name || model.slug;
      modelSelect.append(option);
    }

    status.textContent = models.length
      ? `Loaded ${models.length} model${models.length === 1 ? "" : "s"} from this ChatGPT account.`
      : "Connected, but no displayable models were returned.";
  } catch (error) {
    status.textContent = error.message;
  }
}

document.querySelector("#signout").addEventListener("click", async () => {
  await fetch("/api/signout", { method: "POST" });
  location.reload();
});

sendButton.addEventListener("click", async () => {
  const prompt = document.querySelector("#prompt").value.trim();
  const model = modelSelect.value;
  if (!prompt || !model) return;

  sendButton.disabled = true;
  output.textContent = "";
  status.textContent = `Sending to ${model}…`;

  try {
    const response = await fetch("/api/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt }),
    });

    if (!response.ok) {
      throw new Error(await response.text());
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
      buffer = events.pop() || "";

      for (const event of events) {
        const dataLine = event
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!dataLine) continue;

        const raw = dataLine.slice(6);
        if (raw === "[DONE]") continue;

        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          continue;
        }

        if (data.type === "response.output_text.delta") {
          output.textContent += data.delta || "";
        } else if (data.type === "response.completed") {
          completed = true;
        } else if (data.type === "response.failed") {
          throw new Error(data.response?.error?.message || data.response?.error?.code || "Response failed.");
        } else if (data.type === "response.incomplete") {
          throw new Error("Response was incomplete.");
        }
      }
    }

    if (!completed) {
      throw new Error("Stream ended without response.completed.");
    }

    status.textContent = `Completed with ${model} using the authorised ChatGPT-plan token.`;
  } catch (error) {
    output.textContent ||= "No response text received.";
    status.textContent = error.message;
  } finally {
    sendButton.disabled = false;
  }
});

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(text);
  }
  if (!response.ok) throw new Error(json.error || text);
  return json;
}
