const fs = require("fs");
const text = fs.readFileSync("src/App.tsx", "utf8");
const lines = text.split("\n");
console.log("=== Select usage ===");
lines.forEach((line, i) => {
  if (line.includes("Select")) {
    console.log("Line " + (i+1) + ": " + line.trim().substring(0, 150));
  }
});
