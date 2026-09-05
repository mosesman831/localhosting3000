const LINES = [
  "$ npx localhosting watch",
  "localhosting watch",
  "root:      ./my-app",
  "probe:     http://127.0.0.1:3000/",
  "dashboard: http://127.0.0.1:3001",
  "waiting for a good state",
  "snapshot lh_20260904T225100_a1b2c3d4  files=84  confidence=overlay_clean",
  "$ # 27 minutes later, the agent \"just refactors\" src/",
  "$ localhosting restore lh_20260904T225100_a1b2c3d4",
  "Type RESTORE to confirm: RESTORE",
  "safety snapshot lh_20260904T231844_9c0d1e2f",
  "restore complete",
  "Restart your dev server. localhosting does not stop processes.",
];

const term = document.getElementById("term");
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function finalFrame() {
  if (term) term.textContent = LINES.join("\n");
}

async function typeLoop() {
  if (!term) return;
  if (reduce) {
    finalFrame();
    return;
  }
  while (true) {
    term.textContent = "";
    for (const line of LINES) {
      for (let i = 0; i <= line.length; i++) {
        term.textContent = LINES.slice(0, LINES.indexOf(line)).join("\n");
        if (LINES.indexOf(line) > 0) term.textContent += "\n";
        term.textContent += line.slice(0, i);
        await new Promise((r) => setTimeout(r, 12));
      }
      term.textContent += "\n";
      await new Promise((r) => setTimeout(r, 80));
    }
    await new Promise((r) => setTimeout(r, 1600));
  }
}

void typeLoop();

const btn = document.getElementById("copy-cta");
const cmd = document.getElementById("install-cmd");
if (btn && cmd) {
  btn.addEventListener("click", async () => {
    const text = cmd.textContent || "";
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(cmd);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = "Select + copy";
    }
  });
}
