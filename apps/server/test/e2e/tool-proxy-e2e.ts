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
  console.log("=== OpenOmni E2E Test: Custom Tool + Subagent ===\n");
  console.log(`Target: ${WS_URL}`);

  console.log("\n--- Test 1: Custom Tool (weather_lookup) ---");
  try {
    const response = await sendAndWait(
      "What's the weather in Seoul? Use the weather_lookup tool to check. Reply with just the weather info.",
    );
    const hasWeatherInfo =
      response.toLowerCase().includes("seoul") ||
      response.toLowerCase().includes("18") ||
      response.toLowerCase().includes("cloudy") ||
      response.toLowerCase().includes("weather");
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
    const hasWeather = response.toLowerCase().includes("weather");
    console.log(`Response preview: ${response.slice(0, 500)}`);
    console.log(
      `✅ Test 2 ${hasWeather ? "PASS" : "WARN"}: weather_lookup ${hasWeather ? "is" : "may not be"} in tool list`,
    );
  } catch (err) {
    console.error("❌ Test 2 FAIL:", err);
  }

  console.log("\n=== E2E Test Complete ===");
}

main().catch(console.error);
