// Cost and dependency register — shown at /portal/admin/infrastructure/ and mirrored in docs/DEPENDENCIES.md.
// Free limits are as published by each provider and can change; always check the linked page.
export interface Dependency {
  service: string
  usedFor: string
  required: boolean
  needs: string
  freeLimits: string
  paidRisk: string
  ifUnavailable: string
  link: string
}

export const CHECKED_ON = '2026-11-15'

export const dependencies: Dependency[] = [
  {
    service: 'Supabase',
    usedFor: 'Logins, database, file storage, realtime, Edge Functions, Vault (secrets)',
    required: true,
    needs: 'Free account (yours)',
    freeLimits: '≈500 MB database, ≈1 GB file storage, 2 active free projects, pauses after ≈7 days without activity, no downloadable backups',
    paidRisk: 'None unless you upgrade the organisation plan yourself',
    ifUnavailable: 'Portal and dynamic features stop; the public website keeps working',
    link: 'https://supabase.com/pricing',
  },
  {
    service: 'Netlify',
    usedFor: 'Hosting the website, form email alerts',
    required: true,
    needs: 'Free account (yours)',
    freeLimits: 'Free plan allowance for bandwidth, builds and form submissions (see pricing page)',
    paidRisk: 'None unless you upgrade',
    ifUnavailable: 'Website offline until redeployed elsewhere',
    link: 'https://www.netlify.com/pricing/',
  },
  {
    service: 'GitHub',
    usedFor: 'Code, scheduled keep-alive and backup jobs',
    required: true,
    needs: 'Free account (yours)',
    freeLimits: 'Actions minutes/storage limits on private repos; scheduled jobs can be paused on inactive repos; artifacts expire (≤90 days)',
    paidRisk: 'None unless you buy extra minutes/storage',
    ifUnavailable: 'Backups and keep-alive stop — check the dashboard warnings',
    link: 'https://github.com/pricing',
  },
  {
    service: 'OpenStreetMap (Overpass)',
    usedFor: 'Lead Finder business discovery',
    required: false,
    needs: 'Nothing (attribution required)',
    freeLimits: 'Fair-use rate limits on the public Overpass server',
    paidRisk: 'None',
    ifUnavailable: 'Use manual entry / CSV import',
    link: 'https://wiki.openstreetmap.org/wiki/Overpass_API',
  },
  {
    service: 'Google PageSpeed Insights API',
    usedFor: 'Lead Finder website audits (mobile performance/SEO scores)',
    required: false,
    needs: 'Google Cloud API key (billing not required)',
    freeLimits: 'Free daily quota',
    paidRisk: 'None',
    ifUnavailable: 'Audits still run the built-in checks without PageSpeed scores',
    link: 'https://developers.google.com/speed/docs/insights/v5/get-started',
  },
  {
    service: 'Google Places API',
    usedFor: 'Optional extra Lead Finder source',
    required: false,
    needs: 'Google Cloud project WITH BILLING ENABLED',
    freeLimits: 'Monthly free usage per SKU, then pay-per-request',
    paidRisk: 'Yes — charges beyond the free usage. Off by default; only you can enable billing.',
    ifUnavailable: 'Lead Finder works with OpenStreetMap + manual + CSV',
    link: 'https://developers.google.com/maps/documentation/places/web-service/usage-and-billing',
  },
  {
    service: 'OpenRouter',
    usedFor: 'Optional hosted AI models',
    required: false,
    needs: 'Free OpenRouter account and API key',
    freeLimits: 'Free models with daily/minute request limits that OpenRouter can change at any time',
    paidRisk: 'Only if you set a spending limit above ₹0 and add credits yourself. Default limit is ₹0: paid models are refused.',
    ifUnavailable: 'FAQ fallback answers instead',
    link: 'https://openrouter.ai/models?max_price=0',
  },
  {
    service: 'Self-hosted AI (Ollama / llama.cpp)',
    usedFor: 'AI replies without per-message API charges',
    required: false,
    needs: 'A computer or server you run',
    freeLimits: 'No API charges; you pay for hardware, electricity, hosting and upkeep',
    paidRisk: 'Hosting costs if you rent a server',
    ifUnavailable: 'FAQ fallback answers instead',
    link: 'https://ollama.com',
  },
  {
    service: 'Razorpay',
    usedFor: 'Optional online payments for client stores/POS',
    required: false,
    needs: 'Each client’s own Razorpay account (KYC)',
    freeLimits: 'No monthly fee on the standard plan; fee per transaction',
    paidRisk: 'Transaction fees charged to the client by Razorpay',
    ifUnavailable: 'Cash and manually-confirmed UPI still work',
    link: 'https://razorpay.com/pricing/',
  },
  {
    service: 'Printify',
    usedFor: 'Optional print-on-demand fulfilment for clothing brands',
    required: false,
    needs: 'Each brand’s own Printify account',
    freeLimits: 'Free plan available; production, shipping and premium plan charges apply',
    paidRisk: 'Production and shipping costs charged to the brand by Printify',
    ifUnavailable: 'Store keeps working with its own stock',
    link: 'https://printify.com/pricing/',
  },
  {
    service: 'Brevo (email)',
    usedFor: 'Optional password-reset and notification emails',
    required: false,
    needs: 'Free Brevo account + SMTP settings in Supabase',
    freeLimits: 'Free daily email allowance',
    paidRisk: 'None on the free plan',
    ifUnavailable: 'Temporary passwords are shared manually',
    link: 'https://www.brevo.com/pricing/',
  },
]
