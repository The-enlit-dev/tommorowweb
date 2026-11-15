// Portal navigation. Business items appear only when the module is switched on for the
// selected business AND the person has the permission. Admin items only for the administrator.
export interface NavItem {
  href: string
  label: string
  module?: string
  perm?: string
  ownerOnly?: boolean
}

export const adminNav: NavItem[] = [
  { href: '/portal/admin/', label: 'Overview' },
  { href: '/portal/admin/clients/', label: 'Clients & businesses' },
  { href: '/portal/admin/requests/', label: 'Change requests' },
  { href: '/portal/admin/leads/', label: 'Lead Finder' },
  { href: '/portal/admin/crm/', label: 'Sales CRM' },
  { href: '/portal/admin/ai/', label: 'AI infrastructure' },
  { href: '/portal/admin/audit/', label: 'Audit log' },
  { href: '/portal/admin/infrastructure/', label: 'Infrastructure & costs' },
]

export const businessNav: NavItem[] = [
  { href: '/portal/requests/', label: 'Change requests', module: 'change_requests' },
  { href: '/portal/content/', label: 'Website content', module: 'cms', perm: 'settings.manage' },
  { href: '/portal/blog/', label: 'Blog', module: 'blog', perm: 'settings.manage' },
  { href: '/portal/assistant/', label: 'AI assistant', module: 'ai_assistant', perm: 'settings.manage' },
  { href: '/portal/pos/', label: 'Point of sale', module: 'pos', perm: 'pos.sell' },
  { href: '/portal/orders/', label: 'Orders', module: 'orders', perm: 'orders.view' },
  { href: '/portal/kitchen/', label: 'Kitchen display', module: 'kitchen_display', perm: 'orders.view' },
  { href: '/portal/tables/', label: 'Tables', module: 'restaurant', perm: 'orders.view' },
  { href: '/portal/appointments/', label: 'Appointments', module: 'appointments', perm: 'orders.view' },
  { href: '/portal/products/', label: 'Products & menu', module: 'orders', perm: 'products.manage' },
  { href: '/portal/inventory/', label: 'Inventory', module: 'inventory', perm: 'inventory.manage' },
  { href: '/portal/customers/', label: 'Customers', module: 'orders', perm: 'customers.view' },
  { href: '/portal/discounts/', label: 'Discounts', module: 'orders', perm: 'discounts.manage' },
  { href: '/portal/store/', label: 'Online store', module: 'ecommerce', perm: 'settings.manage' },
  { href: '/portal/fulfilment/', label: 'Printify', module: 'printify', perm: 'settings.manage' },
  { href: '/portal/reports/', label: 'Reports', module: 'orders', perm: 'reports.view' },
  { href: '/portal/team/', label: 'Team', ownerOnly: true },
  { href: '/portal/settings/', label: 'Business settings', perm: 'settings.manage' },
]
