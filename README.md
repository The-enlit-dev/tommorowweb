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
| Pricing | `/pricing/` | Typical price range, UPI payment, the change fee and friends & family codes |
| Process | `/process/` | The six steps, from first conversation to ongoing care |
| About | `/about/` | Story, vision, principles and the founder |
| Contact | `/contact/` | The enquiry form, email and WhatsApp |
| Book a call | `/book/` | Request a 20-minute call on an upcoming weekend |
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
| Price range, payment method (UPI) and the fee per change after delivery | `pricing` |
| Friends & family code | `friendsCode` |
| Call booking: length, days, time windows, call methods, optional Cal.com/Calendly link | `booking` |

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

## Pricing

`pricing` in `site.ts` drives the Pricing page, the home-page teaser, the FAQs and the search-engine data: projects from ₹2,000 to ₹15,000+, payment by UPI only, and ₹400 for each change after delivery. The budget options on the enquiry form are in `budgets`.

## Friends & family code

The enquiry form has an optional **"Have a code?"** field. Share the code privately with family, friends and people you know. It isn't written down anywhere in this repository, so keep a note of it. Codes are not case-sensitive.

- Only a SHA-256 hash of the code is in the site, so it can't be read from the page source.
- Someone who types the right code sees a confirmation. Their enquiry arrives with `discount-code` and `code-valid: yes`.
- The website doesn't apply any discount itself. You decide what the code means (for example, a free website) when you reply.
- To change the code, run the command below and paste the result into `friendsCode.hash` in `site.ts`:

```bash
node scripts/hash-code.mjs YOUR-NEW-CODE
```

## Booking a 20-minute call

`/book/` is a request form, not a live calendar. Visitors pick one of the next four weekends' Saturdays or Sundays, a time window (IST) and how they'd like to be called. The request arrives in Netlify under **Forms → call-booking**, and you confirm the exact time by email or WhatsApp. Change the days, weeks, time windows and call methods in `booking` in `site.ts`. If you later set up a free Cal.com or Calendly page, put its link in `booking.externalUrl` and an "instant booking" button appears.

## Enquiry form (Netlify Forms)

The form on `/contact/` collects name, business name, email, phone/WhatsApp, type of website, budget range, current website, project details and preferred contact method.

Netlify finds the form automatically when it deploys the site, because the form is plain HTML in the built page (`data-netlify="true"`). The free tier allows 100 submissions a month.

1. After the first deploy, open **Forms** in your Netlify project. If form detection is off, enable it and redeploy.
2. Submissions appear under **Forms → enquiry** (project enquiries) and **Forms → call-booking** (call requests).
3. To get each enquiry by email: **Forms → Form notifications → Add notification → Email notification**. Add one for each form.

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

- **Look:** deep black (`#050505`) with a subtle white dot grid on every page, monochrome throughout, and a chrome gradient for accent words, the progress bar and the orb.
- **Logo:** your wordmark, traced to vector paths in `src/components/logo-paths.ts` and shown with `Logo.astro`. `variant="hor"` is the one-line version in the header; `variant="stack"` is the two-line logo in the footer. Being vector, it stays sharp at any size.
- **Headings:** a dot-matrix face. The site uses **Doto**, an open-source (SIL OFL) dot-matrix font with round dots that is close to Nothing's Ndot. Ndot itself isn't openly licensed for websites. If you have a licence, add its `@font-face` in `src/styles/fonts.css` under the family name `Ndot 57` and it's used automatically. Long reading text (statements, FAQs, forms) uses Inter, and labels use JetBrains Mono. Doto has no ₹ sign, so rupee amounts in headings wrap the ₹ in `<span class="rs">` to set it in Inter.
- **Colours and spacing** are CSS variables at the top of `src/styles/global.css`. Text colours meet WCAG AA contrast on black.
- **Motion** (desktop and mobile), all switched off for visitors who prefer reduced motion:
  - **Hero dot field** (`motion.ts`): the dots shimmer, light up and part around the cursor, and ripple out from taps. On phones they ripple on their own.
  - **Chrome orb** (`Orb.astro`), with a turning highlight and orbit rings. It rises over the horizon as you scroll.
  - **Text scramble:** small labels decode into their real text. Screen readers get the real text straight away.
  - Masked line reveals for headings, blur-in reveals for content, page transitions (View Transitions), smooth scrolling (Lenis) and a scroll progress line.
  - Stacking work cards with parallax screenshots, spotlight cards, magnetic buttons, marquees and the draggable "Today / Tomorrow" comparison.
- **Scripts:** `src/scripts/` contains `main.ts` (site-wide behaviour and scroll effects), `motion.ts`, `forms.ts` (both Netlify forms), `compare.ts` and `filter.ts`. Shared form styles are in `src/styles/forms.css`.
- **Accessibility:** semantic landmarks, a skip link, keyboard-operable menu (focus trap and Esc), slider, filters and FAQs, labelled form fields with inline error messages, and visible focus styles.

## Regenerating the social image and icons

The social image (`public/og.png`), favicon (`public/favicon.svg`) and app icons are generated from the vector logo:

```bash
node scripts/render-assets.mjs
```

This needs Playwright with Chromium installed. The favicon is a "tw" monogram, made from the logo's own letters, on the site's dot grid.

## Project structure

```
src/
  config/site.ts         ← business details, services, process, FAQs, form options
  content/work/*.md      ← portfolio projects (one file each)
  content.config.ts      ← the project fields
  assets/work/           ← project screenshots
  components/            ← Header, Footer, Logo, Orb, ProjectCard, EnquiryForm, Compare, …
  layouts/Base.astro     ← <head>, SEO tags, page shell
  pages/                 ← one file per page
  scripts/               ← interaction code
  styles/                ← global.css (design system), forms.css, fonts.css
public/                  ← favicon, icons, og.png, web manifest
scripts/                 ← social image/icon renderer, friends & family code hasher
netlify.toml             ← build settings and security headers
```
