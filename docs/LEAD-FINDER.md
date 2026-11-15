# Lead Finder

Administrator-only tool to find local businesses that could use a new or better website.

## Sources

| Source | Cost | Notes |
| --- | --- | --- |
| OpenStreetMap (Overpass + Nominatim) | Free | Default. Attribution “© OpenStreetMap contributors (ODbL)” is shown. Mirrors are tried if the main Overpass server is busy. Locality coordinates are looked up once and cached. |
| Manual entry and CSV import | Free | Column-mapping step and a duplicate preview before importing. |
| Google Places (Text Search) | **Billed beyond Google’s monthly free usage** | Off by default. Needs a Google Cloud key with billing enabled, an explicit switch and a monthly request cap (default 0). Phone/website details from Google expire after 30 days unless you verify them yourself; only the place id is kept long-term. |
| Google PageSpeed Insights | Free | Used in audits; works best with an API key (no billing needed). |

## How duplicates are prevented

Each result is matched before it is saved, in this order: same OpenStreetMap / Google id → same
website domain → same normalised Indian phone number → very similar name within ~250 m. A match
updates the existing lead (adding the new source and details). Similar names nearby that aren’t a
sure match create a new lead and go to the **Possible duplicates** queue for you to merge or dismiss.

## Website states

`none_listed` (no source lists a website) · `unverified` (listed but not reachable or not checked —
timeouts, DNS failures, robots.txt) · `broken` (the site answers with an error) · `live` ·
`redirects_elsewhere`. “Couldn’t verify” is never treated as “no website”.

## Audits

Respect robots.txt and identify as `TomorrowWebAudit/1.0`. Checks: https, redirects, status, response
time, HTML weight, mobile viewport, title, description, H1, canonical, image alt text, up to 25 internal
links, tap-to-call / email / WhatsApp / forms, navigation, mixed content, copyright year; plus
PageSpeed mobile scores. Every finding records its source (`check`, `pagespeed` or `ai`) and evidence.
AI summaries are optional, labelled, and based only on verified findings.

## Score (0–100)

Transparent weighted rules (shown on each lead): no website +35, broken +30, redirects elsewhere +15,
unverified +5; for live sites: not mobile-ready +15, slow on mobile +15, no https +10, no contact path
+10, outdated copyright +6, broken links +6, missing SEO tags +4, heavy page +4; industry fit +10;
public contact available +10 (none found −10). **An estimate, not a sign the business wants a website.**

## Compliance

- Only public business information, with source and date recorded. No scraping of private data and
  no bypassing of site restrictions.
- **Do not contact** flag (audited). **Delete on request** removes the lead and stores only SHA-256
  fingerprints of its phone/website/email/map ids so future searches and imports skip it.
- Calls/SMS: follow TRAI’s commercial communication (DND/TCCCPR) rules. Email: identify yourself and
  include an opt-out. Personal data: India’s Digital Personal Data Protection Act, 2023.
