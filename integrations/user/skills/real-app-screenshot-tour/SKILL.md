---
name: real-app-screenshot-tour
description: Use when a user asks for real running-app screenshots, mobile screenshot tours, product demo captures, Playwright screenshots, before/after visual evidence, or app-store/portfolio images captured from localhost or a deployed app rather than generated imagery.
---

# Real App Screenshot Tour

## Overview

Capture screenshots from a real app state, not imagined mockups. The goal is reproducible visual evidence: validated app, realistic data, stable viewport, and deliverable PNGs with concise captions.

## Workflow

1. Confirm the capture source.
   - Use the existing local or deployed app. Do not use image generation unless the user explicitly asks.
   - Read `AGENTS.md`, run scripts, env examples, and screenshot requirements.
   - If real external data or account creation is required, use only credentials/data the user has authorized.

2. Validate and run the app.
   - Run the repo's relevant build/test checks before capture when practical.
   - Start the dev server on `127.0.0.1`; choose another port if occupied.
   - Record the final URL and keep logs inspectable.

3. Prepare the demo state.
   - Prefer UI flows for user-visible setup.
   - Use direct database/API seeding only when the user authorized demo data or the UI cannot reach required hidden states.
   - Mark demo records with a date or slug so they can be found later.

4. Capture with Playwright.
   - Use the `playwright` skill or project-standard browser tooling.
   - Default mobile viewport: `390x844`; adjust only when the product requires another device.
   - Store files under `output/playwright/<slug>-YYYYMMDD-HHMM/`.
   - Capture separate scroll positions for long screens instead of one unreadable full-page image.

5. Report the tour.
   - Embed screenshots in user-requested order with one-line feature captions.
   - Include validation commands, app URL, data source notes, and any failed or skipped capture.

## Guardrails

- Do not fake UI states with generated images or static HTML unless explicitly requested.
- Do not expose secrets, tokens, email inboxes, payment data, or personal contact data in screenshots.
- Do not modify product code just to make screenshots easier unless the user asked for a UI fix.
- Clean up only temporary processes you started; do not delete demo data unless requested.
