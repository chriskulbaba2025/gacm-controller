export const PRYSM_BROWSER_POLICY = "BROWSER_TESTING = USER_ONLY" as const;
export const PRYSM_BROWSER_ACCEPTANCE = "HOLD_UNTIL_CHRIS_EXPLICIT_CONFIRMATION" as const;

const browserTerms = /\b(?:browser|visual|playwright|puppeteer|chromium|headed|screenshot)\b/i;
const prohibitedAction = /\b(?:run|perform|execute|conduct|launch|open|use|automate|test|verify|validate|accept|capture|inspect|exercise)\b/i;
const prohibition = /\b(?:do not|don't|never|must not|prohibited|forbidden|no)\b/i;
const chrisOnly = /\b(?:only\s+Chris|Chris\s+(?:performs?|owns?|will|must|explicitly))\b/i;
const holdState = /\b(?:HOLD|USER_ONLY|until\s+Chris)\b/i;

function clauses(text: string): string[] {
  return text.split(/[.!?;\n]+/).map((part) => part.trim()).filter(Boolean);
}

export function browserPlanViolation(objective: string): string | null {
  for (const clause of clauses(objective)) {
    if (!browserTerms.test(clause)) continue;
    if (prohibition.test(clause) || chrisOnly.test(clause) || holdState.test(clause)) continue;
    if (prohibitedAction.test(clause) || /\b(?:browser\s+testing|visual\s+acceptance|browser\s+acceptance)\b/i.test(clause)) {
      return `${PRYSM_BROWSER_POLICY}: Codex/GACM cannot perform PRYSM browser or visual testing. Chris must perform real browser and visual acceptance.`;
    }
  }
  return null;
}

export function assertPrysmBrowserPlanAllowed(project: string, objective: string): void {
  if (project !== "prysm") return;
  const violation = browserPlanViolation(objective);
  if (violation) throw new Error(violation);
}

export function prysmBrowserGuardPrompt(project: string): string {
  if (project !== "prysm") return "";
  return [
    `- ${PRYSM_BROWSER_POLICY}.`,
    "- Codex/GACM must never perform PRYSM browser testing, visual testing, screenshots, Playwright, Puppeteer, Chromium, or headed-browser work.",
    "- Only Chris may perform real browser and visual acceptance.",
    `- Browser acceptance state is ${PRYSM_BROWSER_ACCEPTANCE}; do not claim browser acceptance PASS or clear this HOLD.`
  ].join("\n");
}
