# Tomorrow Web

The website for **Tomorrow Web**, an independent web design and development studio.
_Today’s business. Tomorrow’s website._

Built with [Astro](https://astro.build) as a fully static site: no server, database, accounts or paid services.
It deploys to Netlify's free tier, and enquiries go through Netlify Forms.

## Pages

| Page | Path | What it does |
| --- | --- | --- |
| Home | `/` | Hero, what we do, services, an interactive before/after, selected work, standards, process, call to action |
| Work | `/work/` | Portfolio grid with category filters |
| Case studies | `/work/<project>/` | One page per project, generated from Markdown |
| Services | `/services/` | The six services in detail, plus FAQs |
| Process | `/process/` | The six steps, from first conversation to ongoing care |
| About | `/about/` | Story, vision, principles and the founder |
| Contact | `/contact/` | The enquiry form, email and WhatsApp |
| Thanks, Privacy, 404 | `/thanks/`, `/privacy/`, `/404` | Form fallback, privacy notice, not-found page |

## Run it locally

```bash
npm install
```

```bash
npm run dev
```

Opens on http://localhost:4321. Other commands:

```bash
npm run build     # type-check, then build the site into dist/
```

```bash
npm run preview   # serve the production build
```

Requires Node 20.19 or newer (Netlify uses Node 22, set in `netlify.toml`).

## Editing content

Almost all copy lives in **[`src/config/site.ts`](src/config/site.ts)**. Search it for `TODO`.

| What | Where in `site.ts` |
| --- | --- |
| Studio email, WhatsApp number, location, social links | `business` |
| Founder name and links | `business.founder` |
| The six services (summary, who it's for, what's included, example project) | `services` |
| "Every build" standards | `standards` |
| Process steps | `processSteps` |
| FAQs (also used for search-engine FAQ data) | `faqs` |
| Enquiry form options: website types, **budget ranges**, contact methods | `websiteTypes`, `budgets`, `contactMethods` |

The About story and principles are in `src/pages/about.astro`. Page titles and descriptions are set at the top of each page in `src/pages/`.

Empty values are never shown as broken links: anything that depends on a missing value is hidden.

### Things only you can fill in

- **WhatsApp:** set `business.whatsapp` to your number in international format, digits only (for India: `91` followed by the 10-digit number). This turns on the WhatsApp buttons in the header menu, contact page, call-to-action sections and footer, and a "Send on WhatsApp" button on the form that turns the filled-in form into a WhatsApp message.
- **Email:** `business.email` is currently your personal address. Swap it for a studio address when you have one.
- **Location and social profiles:** `business.location` and `business.social`.

## Adding a project to the portfolio

Projects are Markdown files in `src/content/work/`. Each one becomes a card on `/work/`, a card on the home page (if `featured`), and a case study page.

1. Add screenshots to `src/assets/work/`:
   - a desktop screenshot, **1600×1000** (required)
   - a phone screenshot, **390×844 at 2×**, so 780×1688 (optional)
   - a second desktop screenshot (optional)

   Astro resizes and converts them to AVIF/WebP automatically.
2. Copy an existing file in `src/content/work/` and edit the frontmatter. The fields are described in `src/content.config.ts`:
   - `relationship`: describe it honestly, e.g. `Client project`, `Built for a karate academy` or `Studio project`.
   - `categories`: any of `Business`, `Restaurant & café`, `Portfolio`, `Landing page`, `Redesign`. The filter buttons on `/work/` are created from these.
   - `status`: `Live`, `Preview` or `In development`, with an optional `statusNote`.
   - `order`: lower numbers appear first. `featured: false` keeps a project off the home page. `draft: true` hides it everywhere.
3. Write the case study below the frontmatter in Markdown (`## The brief`, `## What we built` and so on).
4. To show it as the example for a service, set that service's `example` in `site.ts` to the file name (without `.md`).

Only add real projects. Never invent clients, testimonials or results.

## Enquiry form (Netlify Forms)

The form on `/contact/` collects name, business name, email, phone/WhatsApp, type of website, budget range, current website, project details and preferred contact method.

Netlify finds the form automatically when it deploys the site, because the form is plain HTML in the built page (`data-netlify="true"`). The free tier allows 100 submissions a month.

1. After the first deploy, open **Forms** in your Netlify project. If form detection is off, enable it and redeploy.
2. Submissions appear under **Forms → enquiry**.
3. To get each enquiry by email: **Forms → Form notifications → Add notification → Email notification**.

How the form behaves:

- With JavaScript, it checks fields inline, sends in the background and shows a thank-you message in place.
- Without JavaScript, it posts normally and lands on `/thanks/`.
- A hidden honeypot field filters out basic spam bots.
- On `npm run dev` it doesn't send, because only the deployed Netlify site accepts submissions. It says so instead.
- Visitors can pre-select a website type with a link like `/contact/?type=restaurant`. The "Enquire about this" buttons on `/services/` use this.

## Deploy to Netlify

1. In Netlify, choose **Add new project → Import an existing project** and pick this repository.
2. Netlify reads `netlify.toml`, so the build settings fill in automatically: build command `npm run build`, publish directory `dist`. Click **Deploy**.
3. Enable form detection (see above).
4. Optional: add your domain under **Domain management**.

No environment variables are required. Netlify's built-in `URL` variable is used at build time for canonical links, the sitemap and social-preview images. To use a different address, set `SITE_URL` (for example `https://tomorrowweb.in`).

## SEO and social sharing

- Every page has a title, description, canonical link and Open Graph/Twitter tags.
- Case studies use their own screenshot as the sharing image. Other pages use `public/og.png`.
- `sitemap-index.xml` and `robots.txt` are generated at build time.
- Structured data (schema.org): the studio and its services on the home page, FAQs and services on `/services/`, the process steps on `/process/`, and each case study with breadcrumbs.

## Design and code notes

- **Look:** warm paper and ink, with a single "sunrise" orange. The logo is a sun rising over a horizon, and the motif repeats in the hero, buttons and calls to action.
- **Type:** Bricolage Grotesque (display), Inter (text) and JetBrains Mono (labels), self-hosted from `@fontsource` in `src/styles/fonts.css`. Only the Latin and Latin Extended subsets are loaded.
- **Colours and spacing** are CSS variables at the top of `src/styles/global.css`. Text colours meet WCAG AA contrast.
- **Motion:** smooth scrolling (Lenis), scroll reveals, a scroll-scrubbed statement, stacking work cards, page transitions (View Transitions) and the draggable "Today / Tomorrow" comparison. All of it is switched off for visitors who prefer reduced motion, and all content is visible without JavaScript.
- **Scripts:** `src/scripts/` contains `main.ts` (site-wide behaviour), `compare.ts`, `filter.ts` and `enquiry.ts`.
- **Accessibility:** semantic landmarks, a skip link, keyboard-operable menu (focus trap and Esc), slider, filters and FAQs, labelled form fields with inline error messages, and visible focus styles.

## Regenerating the social image and icons

Edit `scripts/og.html` or `scripts/icon.html`, then run:

```bash
node scripts/render-assets.mjs
```

This needs Playwright with Chromium installed. It writes `public/og.png`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png` and `icon-512.png`. The SVG favicon is `public/favicon.svg`.

## Project structure

```
src/
  config/site.ts         ← business details, services, process, FAQs, form options
  content/work/*.md      ← portfolio projects (one file each)
  content.config.ts      ← the project fields
  assets/work/           ← project screenshots
  components/            ← Header, Footer, ProjectCard, EnquiryForm, Compare, …
  layouts/Base.astro     ← <head>, SEO tags, page shell
  pages/                 ← one file per page
  scripts/               ← interaction code
  styles/                ← global.css (design system), fonts.css
public/                  ← favicon, icons, og.png, web manifest
scripts/                 ← social image and icon renderer
netlify.toml             ← build settings and security headers
```
