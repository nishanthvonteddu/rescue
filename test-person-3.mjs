import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseUrl = "http://127.0.0.1:3000";

async function runTests() {
  console.log("=== Testing Person 3 Endpoints against Frozen Contracts ===\n");
  let passed = 0;
  let total = 0;

  // 1. Test /api/receipts (Hotel)
  total++;
  try {
    const hotelImagePath = path.join(__dirname, "sample-hotel.jpg");
    const imageBytes = fs.readFileSync(hotelImagePath);
    const formData = new FormData();
    formData.append("file", new Blob([imageBytes], { type: "image/jpeg" }), "sample-hotel.jpg");

    const res = await fetch(`${baseUrl}/api/receipts`, {
      method: "POST",
      body: formData
    });
    const data = await res.json();
    console.log("[1] POST /api/receipts (sample-hotel.jpg):");
    console.log(JSON.stringify(data, null, 2));

    if (data.merchant && typeof data.total === "number" && data.category && data.date) {
      console.log("✓ PASSED: Valid ReceiptExtract shape\n");
      passed++;
    } else {
      console.error("✗ FAILED: Invalid ReceiptExtract shape\n");
    }
  } catch (err) {
    console.error("✗ FAILED /api/receipts (Hotel):", err.message, "\n");
  }

  // 2. Test /api/receipts (Meal)
  total++;
  try {
    const mealImagePath = path.join(__dirname, "sample-meal.jpg");
    const imageBytes = fs.readFileSync(mealImagePath);
    const formData = new FormData();
    formData.append("file", new Blob([imageBytes], { type: "image/jpeg" }), "sample-meal.jpg");

    const res = await fetch(`${baseUrl}/api/receipts`, {
      method: "POST",
      body: formData
    });
    const data = await res.json();
    console.log("[2] POST /api/receipts (sample-meal.jpg):");
    console.log(JSON.stringify(data, null, 2));

    if (data.merchant && typeof data.total === "number" && data.category && data.date) {
      console.log("✓ PASSED: Valid ReceiptExtract shape\n");
      passed++;
    } else {
      console.error("✗ FAILED: Invalid ReceiptExtract shape\n");
    }
  } catch (err) {
    console.error("✗ FAILED /api/receipts (Meal):", err.message, "\n");
  }

  // 3. Test /api/claim
  total++;
  try {
    const claimPayload = {
      receipts: [
        { merchant: "Hilton DFW Airport", date: "2026-07-18", total: 189, category: "hotel" },
        { merchant: "Olive Garden", date: "2026-07-18", total: 58, category: "meal" }
      ],
      event: {
        flight: {
          flightNumber: "AA123",
          carrier: "American Airlines",
          date: "2026-07-18",
          origin: "DFW",
          destination: "LGA",
          scheduledDep: "2026-07-18T18:30:00Z",
          scheduledArr: "2026-07-18T22:45:00Z"
        },
        traveler: {
          name: "Alex Johnson",
          phone: "+14155550123",
          paypalId: "alex.traveler@example.com",
          homeAirport: "DFW"
        },
        reason: "controllable_cancellation",
        strandedOvernight: true
      }
    };

    const res = await fetch(`${baseUrl}/api/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(claimPayload)
    });
    const data = await res.json();
    console.log("[3] POST /api/claim:");
    console.log(JSON.stringify(data, null, 2));

    if (data.owedTotal === 247 && Array.isArray(data.commitmentsMet) && data.commitmentsMet.includes("hotel") && data.commitmentsMet.includes("meal")) {
      console.log("✓ PASSED: Valid ReceiptClaim shape (owedTotal: 247, commitments: hotel, meal)\n");
      passed++;
    } else {
      console.error("✗ FAILED: Invalid ReceiptClaim shape\n");
    }
  } catch (err) {
    console.error("✗ FAILED /api/claim:", err.message, "\n");
  }

  // 4. Test /api/payout
  total++;
  try {
    const payoutPayload = {
      claim: {
        items: [
          { merchant: "Hilton", date: "2026-07-18", total: 189, category: "hotel" },
          { merchant: "Olive Garden", date: "2026-07-18", total: 58, category: "meal" }
        ],
        owedTotal: 247,
        commitmentsMet: ["hotel", "meal"]
      },
      traveler: {
        name: "Alex Johnson",
        phone: "+14155550123",
        paypalId: "sb-buyer@example.com",
        homeAirport: "DFW"
      }
    };

    const res = await fetch(`${baseUrl}/api/payout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payoutPayload)
    });
    const data = await res.json();
    console.log("[4] POST /api/payout:");
    console.log(JSON.stringify(data, null, 2));

    if (data.status === "sent" && data.amount === 247 && typeof data.paypalTxnId === "string") {
      console.log("✓ PASSED: Valid PayoutResult shape (status: sent, amount: 247)\n");
      passed++;
    } else {
      console.error("✗ FAILED: Invalid PayoutResult shape\n");
    }
  } catch (err) {
    console.error("✗ FAILED /api/payout:", err.message, "\n");
  }

  // 5. Test /api/payment/fare-difference
  total++;
  try {
    const fareDiffPayload = {
      amount: 45,
      traveler: {
        name: "Alex Johnson",
        phone: "+14155550123",
        paypalId: "sb-buyer@example.com",
        homeAirport: "DFW"
      }
    };

    const res = await fetch(`${baseUrl}/api/payment/fare-difference`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fareDiffPayload)
    });
    const data = await res.json();
    console.log("[5] POST /api/payment/fare-difference:");
    console.log(JSON.stringify(data, null, 2));

    if (data.status === "sent" && data.amount === 45 && typeof data.paypalTxnId === "string") {
      console.log("✓ PASSED: Valid PayoutResult shape (status: sent, amount: 45)\n");
      passed++;
    } else {
      console.error("✗ FAILED: Invalid PayoutResult shape\n");
    }
  } catch (err) {
    console.error("✗ FAILED /api/payment/fare-difference:", err.message, "\n");
  }

  console.log(`Summary: ${passed}/${total} test suites passed.`);
  if (passed === total) {
    console.log("🎉 ALL PERSON 3 DELIVERABLES ARE 100% COMPLETE AND VERIFIED!");
  }
}

runTests();
