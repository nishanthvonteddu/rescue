import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read .env
const envFile = fs.readFileSync(path.join(__dirname, ".env"), "utf-8");
for (const line of envFile.split("\n")) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith("#")) {
    const [k, ...v] = trimmed.split("=");
    if (k && v.length) {
      process.env[k.trim()] = v.join("=").trim().replace(/^["']|["']$/g, "");
    }
  }
}

const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
const receiver = process.env.PAYPAL_RECEIVER_EMAIL;

console.log("Client ID loaded:", !!clientId);
console.log("Client Secret loaded:", !!clientSecret);
console.log("Receiver email:", receiver);

async function testPayPal() {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  
  console.log("1. Requesting PayPal Sandbox OAuth token...");
  const tokenRes = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  console.log("OAuth Status:", tokenRes.status, tokenRes.statusText);
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error("OAuth Error:", errText);
    return;
  }

  const tokenData = await tokenRes.json();
  console.log("✓ OAuth Token received! Expires in:", tokenData.expires_in, "seconds");

  console.log("\n2. Testing Sandbox Payout ($247.00 to receiver)...");
  const senderBatchId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const payoutPayload = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: "You received reimbursement from Rescue Disruption Assistance",
      email_message: "Reimbursement for controllable overnight flight cancellation."
    },
    items: [
      {
        recipient_type: "EMAIL",
        amount: {
          value: "247.00",
          currency: "USD"
        },
        receiver: receiver,
        note: "Hotel $189 + Meal $58",
        sender_item_id: `item_${Date.now()}`
      }
    ]
  };

  const payoutRes = await fetch("https://api-m.sandbox.paypal.com/v1/payments/payouts", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payoutPayload)
  });

  console.log("Payout Status:", payoutRes.status, payoutRes.statusText);
  const payoutJson = await payoutRes.json();
  console.log("Payout Response:", JSON.stringify(payoutJson, null, 2));
}

testPayPal();
