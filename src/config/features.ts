// What the Tomorrow Web platform can do for a client business, with honest statuses.
// Shown on /features/. Keep statuses truthful: "available" only when it works end to end.
export type FeatureStatus = 'available' | 'optional' | 'building'

export interface Feature {
  name: string
  description: string
  status: FeatureStatus
  /** Third-party account or cost involved, if any. */
  note?: string
}

export interface FeatureGroup {
  title: string
  intro: string
  items: Feature[]
}

export const featureGroups: FeatureGroup[] = [
  {
    title: 'Your website, after launch',
    intro: 'Every client gets a private, secure login to look after their site with us.',
    items: [
      { name: 'Client login', description: 'Your own account (and accounts for your staff), created by us. No public sign-up.', status: 'available' },
      { name: 'Change requests', description: 'Ask for changes, see the price, approve it, track progress and chat with us — with file attachments.', status: 'available' },
      { name: 'Edit your own content', description: 'Update marked text, images and buttons on your site, preview, then publish.', status: 'available' },
      { name: 'Blog', description: 'Write and publish posts with images, tags and search settings.', status: 'available' },
    ],
  },
  {
    title: 'AI assistant',
    intro: 'A chat assistant for your visitors that answers from your own information.',
    items: [
      { name: 'FAQ answers', description: 'Answers common questions from your FAQs instantly — works even with AI switched off.', status: 'building' },
      { name: 'AI replies', description: 'Natural answers grounded in your business facts, with a hand-off to WhatsApp or your contact page.', status: 'building', note: 'Needs an AI server we run, or OpenRouter’s free models (limits can change).' },
    ],
  },
  {
    title: 'Run your business',
    intro: 'Switch on only what you need. Each part works on phones, tablets and computers.',
    items: [
      { name: 'Point of sale', description: 'Fast counter sales with cash and UPI QR, receipts and GST-aware invoices.', status: 'building' },
      { name: 'Orders board', description: 'New orders appear live for your staff, who accept, prepare and complete them.', status: 'building' },
      { name: 'Inventory', description: 'Stock levels that update with every sale, with low-stock alerts.', status: 'building' },
      { name: 'Staff accounts', description: 'Each employee signs in with their own email and only sees what you allow.', status: 'available' },
      { name: 'Restaurant tools', description: 'Tables, takeaway, menu management and a live kitchen display.', status: 'building' },
      { name: 'Appointments', description: 'Services, bookings and staff assignments for salons, studios and academies.', status: 'building' },
    ],
  },
  {
    title: 'Sell online',
    intro: 'For clothing brands and shops that want to take orders on their own website.',
    items: [
      { name: 'Online store', description: 'Products with sizes and colours, stock, coupons, checkout and order tracking.', status: 'building' },
      { name: 'Razorpay payments', description: 'Card, UPI and net-banking payments through your own Razorpay account.', status: 'building', note: 'Razorpay charges a fee per transaction.' },
      { name: 'Printify fulfilment', description: 'Print-on-demand products made and shipped by Printify.', status: 'building', note: 'Needs your Printify account; Printify charges production and shipping.' },
    ],
  },
]

/** Third-party costs a client may pay directly to another company (never to Tomorrow Web). */
export const thirdPartyCosts = [
  { service: 'Razorpay', when: 'Only if you take online payments', cost: 'A fee on each payment, charged by Razorpay' },
  { service: 'Printify', when: 'Only for print-on-demand products', cost: 'Product, printing and shipping costs; optional Printify plan' },
  { service: 'Domain name', when: 'If you want your own .com / .in address', cost: 'Yearly fee to the domain registrar' },
]
