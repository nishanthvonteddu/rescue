import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envContent = fs.readFileSync(path.join(__dirname, ".env"), "utf-8");
const apiKeyMatch = envContent.match(/LANDINGAI_API_KEY=(.+)/);
const apiKey = apiKeyMatch ? apiKeyMatch[1].trim() : "";

async function parseMarkdown(fileName) {
  const sampleImage = fs.readFileSync(path.join(__dirname, fileName));
  const url = "https://api.va.landing.ai/v1/tools/agentic-document-analysis";
  const formData = new FormData();
  formData.append("image", new Blob([sampleImage], { type: "image/jpeg" }), fileName);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Basic ${apiKey}` },
    body: formData
  });

  const json = await res.json();
  console.log(`\n=== Markdown for ${fileName} ===`);
  console.log(json.data?.markdown);
}

async function run() {
  await parseMarkdown("sample-hotel.jpg");
  await parseMarkdown("sample-meal.jpg");
}

run();
