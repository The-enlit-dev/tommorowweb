/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  TOMORROW WEB — SITE CONTENT
 * ─────────────────────────────────────────────────────────────────────────────
 *  Business details, services, process steps, FAQs and form options live
 *  here so copy can change without touching the page templates.
 *  Portfolio projects live in src/content/work/ (one Markdown file each).
 *
 *  Conventions
 *  - An empty string ('') means "not set yet". Empty links are never rendered
 *    as clickable; anything that depends on them is hidden on the live site.
 *  - Search this file for TODO to find details only you can fill in.
 */

export const business = {
  name: 'Tomorrow Web',
  /** Used in <title> tags and social previews. */
  tagline: 'Today’s business. Tomorrow’s website.',
  description:
    'Tomorrow Web is an independent web design and development studio. We design and build fast, clear websites for businesses, restaurants and cafés, and independent professionals — and look after them after launch.',
  email: 'attharva.agarwal20@gmail.com', // TODO: swap for a studio address (e.g. hello@yourdomain) when you have one.
  /**
   * WhatsApp number in international format, digits only — country code first,
   * no "+", spaces or leading zero. Example for India: '919876543210'.
   * TODO: add your number to switch on every WhatsApp button and link.
   */
  whatsapp: '',
  /** Shown next to WhatsApp links. Leave '' to show the formatted number. */
  whatsappLabel: '',
  /** Optional city / region line for the footer and structured data. TODO: e.g. 'Pune, India'. */
  location: '',
  /** Studio social profiles. Leave '' to hide. */
  social: {
    instagram: '',
    linkedin: '',
    github: '',
  },
  founder: {
    name: 'Attharva Agarwal',
    role: 'Founder · design & development',
    linkedin: 'https://www.linkedin.com/in/attharva-agarwal',
    github: 'https://github.com/The-enlit-dev',
  },
  /** Netlify form name. Must match the `name` on the form in EnquiryForm.astro. */
  formName: 'enquiry',
}

/** Builds a wa.me link with an optional pre-filled message. Returns '' when no number is set. */
export function whatsappLink(message = 'Hi Tomorrow Web — I’d like to talk about a website.') {
  const n = business.whatsapp.replace(/\D/g, '')
  if (!n) return ''
  return `https://wa.me/${n}?text=${encodeURIComponent(message)}`
}

export function whatsappDisplay() {
  if (business.whatsappLabel) return business.whatsappLabel
  const n = business.whatsapp.replace(/\D/g, '')
  return n ? `+${n}` : ''
}

export const nav = [
  { label: 'Work', href: '/work/' },
  { label: 'Services', href: '/services/' },
  { label: 'Pricing', href: '/pricing/' },
  { label: 'Process', href: '/process/' },
  { label: 'About', href: '/about/' },
]

/* ── Services ─────────────────────────────────────────────────────────────── */

export interface Service {
  /** Used for anchors (/services/#slug) and to pre-select the enquiry form (?type=slug). */
  slug: string
  title: string
  short: string
  lead: string
  idealFor: string[]
  includes: string[]
  note?: string
  /** Project slug from src/content/work that shows this service, if any. */
  example?: string
}

export const services: Service[] = [
  {
    slug: 'business',
    title: 'Business websites',
    short: 'A complete, credible home for your business online.',
    lead:
      'Who you are, what you offer and how to reach you — structured so a first-time visitor understands you in seconds and knows exactly what to do next.',
    idealFor: ['Service businesses & local shops', 'Clinics, academies & studios', 'Established firms refreshing their presence'],
    includes: [
      'Page structure and copy guidance',
      'Custom design — no off-the-shelf themes',
      'Mobile-first, responsive build',
      'Enquiry form delivered to your inbox',
      'Location, hours and map details',
      'On-page SEO and social sharing previews',
    ],
    example: 'vishwa-sports-academy',
  },
  {
    slug: 'restaurant',
    title: 'Restaurant & café websites',
    short: 'Menus, hours and directions that work on a phone.',
    lead:
      'Most people look you up standing on a street corner. We make the menu readable, the hours obvious and booking, ordering or calling one tap away.',
    idealFor: ['Restaurants & cafés', 'Bakeries, bars & cloud kitchens', 'Caterers and food brands'],
    includes: [
      'Menu pages that are easy to update',
      'Opening hours, location and directions',
      'Links to your booking and delivery platforms',
      'WhatsApp and call buttons for quick orders',
      'Photo gallery and events or specials',
      'Local search basics so you show up nearby',
    ],
  },
  {
    slug: 'portfolio',
    title: 'Portfolio & personal websites',
    short: 'Show your work with the care you put into it.',
    lead:
      'For freelancers, creators, consultants and anyone whose name is the brand. A site that presents your work clearly and makes it easy to hire you.',
    idealFor: ['Freelancers & consultants', 'Designers, photographers & creators', 'Students and job-seekers'],
    includes: [
      'Project and case-study layouts',
      'About, CV or credentials page',
      'Contact form and social links',
      'Optional blog or writing section',
      'Easy-to-extend project system',
      'Personal domain setup',
    ],
    example: 'attharva-agarwal-portfolio',
  },
  {
    slug: 'landing',
    title: 'Landing pages',
    short: 'One page, one goal, no distractions.',
    lead:
      'For a launch, a campaign, an event or a waitlist. A single, fast page built around one action — sign up, enquire, book or buy.',
    idealFor: ['Product launches & waitlists', 'Ad and social campaigns', 'Events, courses and offers'],
    includes: [
      'Message and section structure',
      'Focused design around one call to action',
      'Sign-up, waitlist or enquiry form',
      'Fast loading for paid traffic',
      'Analytics-ready setup',
      'Social sharing previews',
    ],
    example: 'vibeheal',
  },
  {
    slug: 'redesign',
    title: 'Website redesigns',
    short: 'Keep what works. Rebuild what doesn’t.',
    lead:
      'If your site looks dated, loads slowly or is stuck on an expensive builder, we review it, carry over what’s worth keeping and rebuild it properly.',
    idealFor: ['Outdated or slow websites', 'Sites stuck on page builders', 'Businesses that have changed since launch'],
    includes: [
      'Review of your current site',
      'Content carried over and tidied up',
      'Fresh design and modern build',
      'Redirects so existing links keep working',
      'Move to fast, low-cost hosting',
      'Before-and-after walkthrough',
    ],
    example: 'vishwa-sports-academy',
  },
  {
    slug: 'care',
    title: 'Maintenance & improvements',
    short: 'Your website, looked after.',
    lead:
      'A website is never really finished. We handle updates, fixes and improvements so your site stays accurate, fast and secure — without you touching code.',
    idealFor: ['Sites we’ve built', 'Existing sites that need a hand', 'Businesses without an in-house developer'],
    includes: [
      'Text, photo and menu updates',
      'New pages and sections',
      'Speed and accessibility fixes',
      'Form, link and broken-page checks',
      'Hosting and domain help',
      'Small improvements, planned with you',
    ],
    note: 'Available as one-off requests or an ongoing arrangement — whichever suits you.',
  },
]

/* ── Standards included in every build ───────────────────────────────────── */

export const standards = [
  { k: 'Mobile-first', v: 'Designed for phones first, then scaled up to tablets and desktops.' },
  { k: 'Fast', v: 'Optimised images and minimal JavaScript, so pages appear quickly — even on slow connections.' },
  { k: 'Findable', v: 'Clean page titles, descriptions, a sitemap and social sharing previews.' },
  { k: 'Accessible', v: 'Semantic HTML, keyboard-friendly navigation and readable contrast.' },
  { k: 'Converts', v: 'Clear calls to action, enquiry forms and WhatsApp where it helps.' },
  { k: 'Yours', v: 'Your domain, your content, your code. No lock-in.' },
]

/* ── Process ──────────────────────────────────────────────────────────────── */

export const processSteps = [
  {
    title: 'Conversation',
    summary: 'We learn about your business, your customers and what the website needs to do.',
    detail:
      'A relaxed call or chat — no jargon, no pressure. We ask about your goals, who you serve, what’s working today and what isn’t. If a website isn’t the right answer, we’ll say so.',
    youGet: 'A clear, written brief',
    yourPart: 'Tell us about your business',
  },
  {
    title: 'Proposal',
    summary: 'Scope, page list, timeline and price — agreed in writing before work starts.',
    detail:
      'We turn the brief into a proposal: the pages and features you need, what’s included, a timeline with dates and a fixed quote. No surprises later.',
    youGet: 'Proposal and fixed quote',
    yourPart: 'Review and approve',
  },
  {
    title: 'Structure & design',
    summary: 'Content and structure first, then a visual design you review on a real link.',
    detail:
      'We plan what goes on each page and in what order, then design it. You review the design in your browser and on your phone — not as a static image — and we refine it together.',
    youGet: 'A live design preview',
    yourPart: 'Share content and feedback',
  },
  {
    title: 'Build',
    summary: 'A fast, responsive, accessible website, built properly from the ground up.',
    detail:
      'We build the site with modern, lightweight tools: responsive layouts, optimised images, SEO basics, forms and analytics. You can follow progress on a preview link throughout.',
    youGet: 'A working preview site',
    yourPart: 'Test it and tell us what you think',
  },
  {
    title: 'Launch',
    summary: 'Testing on real devices, domain set-up and a calm, planned go-live.',
    detail:
      'We test on phones, tablets and desktops, check every form and link, connect your domain and go live. Then we walk you through how everything works.',
    youGet: 'Your live website and a handover',
    yourPart: 'Celebrate',
  },
  {
    title: 'Care',
    summary: 'Updates, fixes and improvements after launch — whenever you need them.',
    detail:
      'Businesses change, and websites should keep up. Once your site is delivered, additional changes are ₹400 each — just send us what you need.',
    youGet: 'A website that stays current',
    yourPart: 'Send us what’s changed',
  },
]

/* ── FAQs ─────────────────────────────────────────────────────────────────── */

export const faqs = [
  {
    q: 'How much does a website cost?',
    a: 'Most websites we build cost between ₹2,000 and ₹15,000, depending on the number of pages, the content and the features you need. Larger projects can cost more. Share your budget in the enquiry form and we’ll send a written quote before any work begins.',
  },
  {
    q: 'How do I pay?',
    a: 'We accept payment by UPI only.',
  },
  {
    q: 'What if I want changes after my website is finished?',
    a: 'Additional changes after your website is delivered cost ₹400 each. Send us what you’d like changed and we’ll confirm before making it.',
  },
  {
    q: 'How long does it take?',
    a: 'It depends on the scope and on how quickly content is ready. A single landing page is much quicker than a multi-page business site. Your proposal includes a timeline with dates, so you know what to expect.',
  },
  {
    q: 'Do I need my content ready before we start?',
    a: 'It helps, but no. We’ll give you a simple structure to fill in, help shape the wording and work with the photos you have — or advise on what to take.',
  },
  {
    q: 'Will I own my website?',
    a: 'Yes. Your domain is registered in your name, and the design, content and code are yours. There’s no lock-in: you can take the site anywhere.',
  },
  {
    q: 'What does hosting cost?',
    a: 'We build fast, static websites that can be hosted on modern platforms such as Netlify, which offer free and low-cost plans suitable for most small business sites. Your domain name is a separate yearly cost paid to the registrar.',
  },
  {
    q: 'Can you redesign my current website or move it off Wix?',
    a: 'Yes. We review what you have, keep what works, carry the content over and set up redirects so existing links keep working.',
  },
  {
    q: 'Do you help after launch?',
    a: 'Yes. We handle content updates, new pages, fixes and performance work after launch. Changes after delivery are ₹400 each.',
  },
  {
    q: 'Do we need to meet in person?',
    a: 'No. We work over calls, video, WhatsApp and email, and share progress on live preview links you can open anywhere. You can book a 20-minute call, usually on a weekend.',
  },
]

/* ── Enquiry form options ─────────────────────────────────────────────────── */

/** Values are what you'll see in Netlify's form submissions. */
export const websiteTypes = [
  { value: 'Business website', slug: 'business' },
  { value: 'Restaurant / café website', slug: 'restaurant' },
  { value: 'Portfolio / personal website', slug: 'portfolio' },
  { value: 'Landing page', slug: 'landing' },
  { value: 'Redesign of an existing website', slug: 'redesign' },
  { value: 'Maintenance / improvements', slug: 'care' },
  { value: 'Not sure yet', slug: 'unsure' },
]

/** Budget ranges shown on the enquiry form. Edit freely — they're just options. */
export const budgets = ['₹2,000 – ₹5,000', '₹5,000 – ₹10,000', '₹10,000 – ₹15,000', 'Above ₹15,000', 'Not sure yet']

export const contactMethods = ['Email', 'WhatsApp', 'Phone call']

/* ── Pricing ──────────────────────────────────────────────────────────────── */

/** Shown on /pricing/, the home page and in the FAQs. Amounts are in rupees. */
export const pricing = {
  from: '2,000',
  upTo: '15,000',
  /** Charge for each change requested after the website is delivered. */
  changeFee: '400',
  payment: 'UPI',
  /**
   * Your UPI ID (e.g. 'yourname@okicici'). When set, approved change-request quotes in the client
   * portal show a UPI QR code for the exact amount. Payments are still confirmed by you by hand.
   * TODO: add your UPI ID.
   */
  upiId: '',
}

/**
 * Friends & family code.
 * The code itself is never stored in the site — only its SHA-256 hash, so it
 * can't be read from the page source. Visitors who type the right code see a
 * confirmation, and the code arrives with their enquiry so you can check it.
 * To change it, run `node scripts/hash-code.mjs YOUR-NEW-CODE` and paste the result here.
 */
export const friendsCode = {
  hash: '1ddca8db80dd205257f964bfd186a748076fe79217a5419b4641b569a6146413',
  message: 'Friends & family code applied — we’ll be in touch about your website.',
}

/* ── Book a call ──────────────────────────────────────────────────────────── */

/** /book/ — a request for a 20-minute call. You confirm the exact time by reply. */
export const booking = {
  minutes: 20,
  /** Days offered: 0 = Sunday … 6 = Saturday. Weekends by default. */
  days: [6, 0],
  /** How many upcoming weeks to show. */
  weeks: 4,
  /** Preferred time windows (Indian Standard Time). */
  slots: ['Morning · 10am – 12pm', 'Afternoon · 12 – 4pm', 'Evening · 4 – 7pm'],
  methods: ['Phone call', 'WhatsApp call', 'Google Meet'],
  formName: 'call-booking',
  /** Optional: a Cal.com or Calendly link. If set, /book/ also offers instant booking there. */
  externalUrl: 'https://cal.com/attharva-agarwal/demo-for-tommorow-web-websites',
}
