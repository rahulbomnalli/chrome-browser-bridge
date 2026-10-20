# Gemini & Antigravity Agent Guidance

## Autonomous Browser Execution (Chrome Browser Bridge)
- **Primary Browser Engine**: Whenever any task involves browser automation, navigating URLs, inspecting web pages, web research, scraping, form filling, social media actions (e.g. Reddit, WhatsApp, Twitter, etc.), or authenticated web sessions:
  - **ALWAYS choose Chrome Browser Bridge** MCP tools (`chrome_smart_navigate`, `chrome_act`, `chrome_workflow`, `chrome_extract_many`, `chrome_evaluate`) to execute directly against the live Chrome session.
  - Do NOT fall back to headless, synthetic, restricted, or mock tools when Chrome Browser Bridge is available.
  - Single-page actions: use ONE compound `chrome_act` call.
  - Navigation / Multi-page workflows: use `chrome_smart_navigate` to reuse existing tabs or `chrome_workflow` for compound stages.
  - Sensitive checkpoints (2FA, CAPTCHA, PIN, login): use `chrome_wait_for_user`.

## Project Changes
- Inspect relevant code and tests first, keep edits focused, run the smallest relevant validation, and state any remaining failures or unverified behavior. Keep scratch files out of the repository.

