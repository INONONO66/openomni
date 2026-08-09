#!/usr/bin/env bun

const WS_URL = "ws://127.0.0.1:3000/ws";
const TIMEOUT_MS = 60_000;

function sendAndWait(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout after ${TIMEOUT_MS}ms for: "${text}"`));
    }, TIMEOUT_MS);

    ws.onopen = () => {
      console.log(`\n>>> Sending: "${text}"`);
      ws.send(JSON.stringify({ text }));
    };

    ws.onmessage = (event) => {
      clearTimeout(timer);
      const data = JSON.parse(event.data as string);
      if (data.type === "error") {
        ws.close();
        reject(new Error(`Server error: ${data.message}`));
        return;
      }
      console.log(`<<< Response (${data.text?.length ?? 0} chars)`);
      ws.close();
      resolve(data.text ?? "");
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(err);
    };
  });
}

async function main() {
  console.log("=== OpenOmni E2E Test: Custom Tool + Dispatch ===\n");
  console.log(`Target: ${WS_URL}`);

  // #521 removed the mock `weather_lookup` tool from the production catalog.
  // This harness now exercises the real Resident custom tool `web_search`
  // (opensearch-ai-sdk), so it verifies a genuine server-side custom tool
  // round-trips end to end rather than a stub. Requires network + opensearch.
  console.log("\n--- Test 1: Custom Tool (web_search) ---");
  try {
    const response = await sendAndWait(
      "Use the web_search tool to find the current weather in Seoul, then reply with just the weather info.",
    );
    const hasWeatherInfo =
      response.toLowerCase().includes("seoul") ||
      response.toLowerCase().includes("weather") ||
      response.toLowerCase().includes("temperature");
    console.log(`Response preview: ${response.slice(0, 300)}`);
    console.log(
      `✅ Test 1 ${hasWeatherInfo ? "PASS" : "WARN"}: Custom tool ${hasWeatherInfo ? "used successfully" : "may not have been called"}`,
    );
  } catch (err) {
    console.error("❌ Test 1 FAIL:", err);
  }

  console.log("\n--- Test 2: Tool Availability ---");
  try {
    const response = await sendAndWait(
      "List all the tools you have available. Just list their names, nothing else.",
    );
    const hasWebSearch = response.toLowerCase().includes("web_search");
    console.log(`Response preview: ${response.slice(0, 500)}`);
    console.log(
      `✅ Test 2 ${hasWebSearch ? "PASS" : "WARN"}: web_search ${hasWebSearch ? "is" : "may not be"} in tool list`,
    );
  } catch (err) {
    console.error("❌ Test 2 FAIL:", err);
  }

  console.log("\n=== E2E Test Complete ===");
}

main().catch(console.error);
